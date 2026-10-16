import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AccessAction } from '@bh/shared';
import type { Exec } from '../db/client.ts';
import { franchiseAgreements, franchiseDocuments, franchiseProspects, locations, territories } from '../db/schema/index.ts';
import { forbidden } from '../lib/errors.ts';
import { capabilityTerritories } from './authz.ts';

/**
 * Territory-scoped franchise legal (docs/PRODUCT_PLAN.md "Access model": a territory runs like HQ). Disclosure
 * (`legal.disclosure`) and Franchise agreements (`legal.agreements`) are HQ-private but `territoryOk`: when HQ grants
 * them on a territory assignment (a master franchisee's country), that person sends disclosure, manages agreements
 * and edits jurisdiction rules and registrations for the prospects, owner groups and locations of their territory,
 * and for the jurisdictions of their territory's country. Organisation-wide holders (HQ) keep every record.
 */

export type LegalModule = 'legal.disclosure' | 'legal.agreements';

export interface LegalScope {
  all: boolean;
  /** Access territories (sub-networks) where the person holds the action. */
  territoryIds: Set<string>;
  /** Countries of those territories (jurisdiction codes `XX` and `XX-…` are theirs). */
  countries: Set<string>;
}

export async function legalScope(req: FastifyRequest, db: Exec, orgId: string, module: LegalModule, action: AccessAction): Promise<LegalScope> {
  const t = await capabilityTerritories(req, db, orgId, module, action);
  if (t === 'all') return { all: true, territoryIds: new Set(), countries: new Set() };
  const rows = t.size ? await db.select({ id: territories.id, country: territories.country }).from(territories).where(and(eq(territories.organizationId, orgId), inArray(territories.id, [...t]))) : [];
  return { all: false, territoryIds: new Set(rows.map((r) => r.id)), countries: new Set(rows.map((r) => r.country).filter((c): c is string => !!c).map((c) => c.toUpperCase())) };
}

export const hasLegalScope = (s: LegalScope) => s.all || s.territoryIds.size > 0;

/** A jurisdiction code (`US`, `US-CA`) within the scope's countries. */
export const jurisdictionIn = (s: LegalScope, code: string | null | undefined) => s.all || (!!code && s.countries.has(code.toUpperCase().split('-')[0]!));

/** Every jurisdiction of a document within the scope (documents without jurisdictions are HQ's network-wide ones). */
export const jurisdictionsIn = (s: LegalScope, codes: readonly string[]) => s.all || (codes.length > 0 && codes.every((c) => jurisdictionIn(s, c)));

export function requireJurisdiction(s: LegalScope, code: string, what: string) {
  if (!jurisdictionIn(s, code)) throw forbidden(`You can only ${what} for the jurisdictions of your own territory`);
}

/** Owner groups of the scope's territories: groups with a location there, or signed from a prospect of the territory. */
export async function territoryOwnerGroups(db: Exec, orgId: string, s: LegalScope): Promise<Set<string>> {
  if (s.all || !s.territoryIds.size) return new Set();
  const ids = [...s.territoryIds];
  const [locs, prospects] = await Promise.all([
    db.select({ g: locations.ownerGroupId }).from(locations).where(and(eq(locations.organizationId, orgId), inArray(locations.territoryId, ids), isNotNull(locations.ownerGroupId))),
    db.select({ g: franchiseProspects.ownerGroupId }).from(franchiseProspects).where(and(eq(franchiseProspects.organizationId, orgId), inArray(franchiseProspects.scopeTerritoryId, ids), isNotNull(franchiseProspects.ownerGroupId))),
  ]);
  return new Set([...locs, ...prospects].map((r) => r.g!).filter(Boolean));
}

/** Locations of the scope's territories. */
async function territoryLocations(db: Exec, orgId: string, s: LegalScope): Promise<Set<string>> {
  if (s.all || !s.territoryIds.size) return new Set();
  const rows = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, orgId), inArray(locations.territoryId, [...s.territoryIds])));
  return new Set(rows.map((r) => r.id));
}

/** Does an agreement belong to the scope: its prospect, owner group or one of its locations is in the territory. */
export async function agreementFilter(db: Exec, orgId: string, s: LegalScope): Promise<(a: typeof franchiseAgreements.$inferSelect) => boolean> {
  if (s.all) return () => true;
  const [groups, locs] = await Promise.all([territoryOwnerGroups(db, orgId, s), territoryLocations(db, orgId, s)]);
  const prospects = s.territoryIds.size
    ? new Set((await db.select({ id: franchiseProspects.id }).from(franchiseProspects).where(and(eq(franchiseProspects.organizationId, orgId), inArray(franchiseProspects.scopeTerritoryId, [...s.territoryIds])))).map((r) => r.id))
    : new Set<string>();
  return (a) => (!!a.prospectId && prospects.has(a.prospectId)) || (!!a.ownerGroupId && groups.has(a.ownerGroupId)) || a.locationIds.some((l) => locs.has(l));
}

type Doc = typeof franchiseDocuments.$inferSelect;

/**
 * Which documents a territory-scoped person may read: disclosure documents of their country (Disclosure), agreement
 * templates of their country, and executed agreements and vault files of their territory's owner groups (Franchise
 * agreements).
 */
export async function documentFilter(req: FastifyRequest, db: Exec, orgId: string, action: AccessAction = 'view'): Promise<{ any: boolean; allows: (d: Doc) => boolean }> {
  const [disc, agr] = await Promise.all([legalScope(req, db, orgId, 'legal.disclosure', action), legalScope(req, db, orgId, 'legal.agreements', action)]);
  const groups = await territoryOwnerGroups(db, orgId, agr);
  const allows = (d: Doc) => {
    if (d.kind === 'disclosure') return hasLegalScope(disc) && jurisdictionsIn(disc, d.jurisdictions);
    if (!hasLegalScope(agr)) return false;
    if (agr.all) return true;
    if (d.kind === 'agreement_template') return jurisdictionsIn(agr, d.jurisdictions);
    return !!d.ownerGroupId && groups.has(d.ownerGroupId);
  };
  return { any: hasLegalScope(disc) || hasLegalScope(agr), allows };
}

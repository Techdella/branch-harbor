import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AccessAction } from '@bh/shared';
import type { Exec } from '../db/client.ts';
import { franchiseAgreements, franchiseDocuments, franchiseProspects, locations, territories } from '../db/schema/index.ts';
import { forbidden } from '../lib/errors.ts';
import { franchiseScope } from './authz.ts';

/**
 * Territory- and brand-scoped franchise legal (docs/PRODUCT_PLAN.md "Access model": a territory runs like HQ, and so
 * does one brand of a multi-brand HQ). Disclosure (`legal.disclosure`) and Franchise agreements (`legal.agreements`)
 * are HQ-private but `territoryOk` and `brandOk`:
 * - granted on a territory assignment (a master franchisee's country), that person sends disclosure, manages agreements
 *   and edits jurisdiction rules and registrations for the prospects, owner groups and locations of their territory,
 *   and for the jurisdictions of their territory's country;
 * - granted on a brand assignment (a brand's development team), that person works the disclosure documents, agreement
 *   templates, agreements and owner groups of their brand (records without a brand belong to the main brand; shared
 *   documents are read-only to them). Jurisdiction rules and registrations are the business's own: they read them,
 *   HQ (or a territory for its country) edits them.
 * Organisation-wide holders (HQ) keep every record.
 */

export type LegalModule = 'legal.disclosure' | 'legal.agreements';

export interface LegalScope {
  all: boolean;
  /** Access territories (sub-networks) where the person holds the action. */
  territoryIds: Set<string>;
  /** Countries of those territories (jurisdiction codes `XX` and `XX-…` are theirs). */
  countries: Set<string>;
  /** Brands (multi-brand HQ) where the person holds the action. */
  brandIds: Set<string>;
  /** The main brand: records without a brand belong to it. */
  defaultBrandId: string | null;
}

export async function legalScope(req: FastifyRequest, db: Exec, orgId: string, module: LegalModule, action: AccessAction): Promise<LegalScope> {
  const f = await franchiseScope(req, db, orgId, module, action);
  if (f.all) return { all: true, territoryIds: new Set(), countries: new Set(), brandIds: new Set(), defaultBrandId: null };
  const t = f.territoryIds;
  const rows = t.size ? await db.select({ id: territories.id, country: territories.country }).from(territories).where(and(eq(territories.organizationId, orgId), inArray(territories.id, [...t]))) : [];
  return {
    all: false, territoryIds: new Set(rows.map((r) => r.id)), countries: new Set(rows.map((r) => r.country).filter((c): c is string => !!c).map((c) => c.toUpperCase())),
    brandIds: f.brandIds, defaultBrandId: f.defaultBrandId,
  };
}

export const hasLegalScope = (s: LegalScope) => s.all || s.territoryIds.size > 0 || s.brandIds.size > 0;

/** Brand-scoped (no organisation-wide or territory grant): works one or more brands' records. */
export const brandScoped = (s: LegalScope) => !s.all && s.brandIds.size > 0;

/** A record's brand (null = the main brand) is one of the scope's brands. */
export const brandIn = (s: LegalScope, brandId: string | null | undefined) => s.all || (() => { const b = brandId ?? s.defaultBrandId; return !!b && s.brandIds.has(b); })();

/** A jurisdiction code (`US`, `US-CA`) within the scope's countries. */
export const jurisdictionIn = (s: LegalScope, code: string | null | undefined) => s.all || (!!code && s.countries.has(code.toUpperCase().split('-')[0]!));

/** Every jurisdiction of a document within the scope (documents without jurisdictions are HQ's network-wide ones). */
export const jurisdictionsIn = (s: LegalScope, codes: readonly string[]) => s.all || (codes.length > 0 && codes.every((c) => jurisdictionIn(s, c)));

export function requireJurisdiction(s: LegalScope, code: string, what: string) {
  if (!jurisdictionIn(s, code)) throw forbidden(`You can only ${what} for the jurisdictions of your own territory`);
}

/** The brand condition on a column where null means the main brand (prospects, agreements, locations). */
function brandOwnedSql(s: LegalScope, column: typeof locations.brandId | typeof franchiseProspects.brandId | typeof franchiseAgreements.brandId) {
  const ids = [...s.brandIds];
  return s.defaultBrandId && s.brandIds.has(s.defaultBrandId) ? or(inArray(column, ids), isNull(column))! : inArray(column, ids);
}

/**
 * Owner groups of the scope: groups with a location in the scope's territories or brands, or signed from a prospect of
 * the territory or brand.
 */
export async function territoryOwnerGroups(db: Exec, orgId: string, s: LegalScope): Promise<Set<string>> {
  if (s.all || (!s.territoryIds.size && !s.brandIds.size)) return new Set();
  const ids = [...s.territoryIds];
  const out = new Set<string>();
  if (ids.length) {
    const [locs, prospects] = await Promise.all([
      db.select({ g: locations.ownerGroupId }).from(locations).where(and(eq(locations.organizationId, orgId), inArray(locations.territoryId, ids), isNotNull(locations.ownerGroupId))),
      db.select({ g: franchiseProspects.ownerGroupId }).from(franchiseProspects).where(and(eq(franchiseProspects.organizationId, orgId), inArray(franchiseProspects.scopeTerritoryId, ids), isNotNull(franchiseProspects.ownerGroupId))),
    ]);
    for (const r of [...locs, ...prospects]) if (r.g) out.add(r.g);
  }
  if (s.brandIds.size) {
    const [locs, prospects] = await Promise.all([
      db.select({ g: locations.ownerGroupId }).from(locations).where(and(eq(locations.organizationId, orgId), brandOwnedSql(s, locations.brandId), isNotNull(locations.ownerGroupId))),
      db.select({ g: franchiseProspects.ownerGroupId }).from(franchiseProspects).where(and(eq(franchiseProspects.organizationId, orgId), brandOwnedSql(s, franchiseProspects.brandId), isNotNull(franchiseProspects.ownerGroupId))),
    ]);
    for (const r of [...locs, ...prospects]) if (r.g) out.add(r.g);
  }
  return out;
}

/** Locations of the scope's territories. */
async function territoryLocations(db: Exec, orgId: string, s: LegalScope): Promise<Set<string>> {
  if (s.all || !s.territoryIds.size) return new Set();
  const rows = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, orgId), inArray(locations.territoryId, [...s.territoryIds])));
  return new Set(rows.map((r) => r.id));
}

/**
 * Does an agreement belong to the scope: its prospect, owner group or one of its locations is in the territory, or the
 * agreement is for one of the scope's brands.
 */
export async function agreementFilter(db: Exec, orgId: string, s: LegalScope): Promise<(a: typeof franchiseAgreements.$inferSelect) => boolean> {
  if (s.all) return () => true;
  const [groups, locs] = await Promise.all([territoryOwnerGroups(db, orgId, s), territoryLocations(db, orgId, s)]);
  const prospects = s.territoryIds.size
    ? new Set((await db.select({ id: franchiseProspects.id }).from(franchiseProspects).where(and(eq(franchiseProspects.organizationId, orgId), inArray(franchiseProspects.scopeTerritoryId, [...s.territoryIds])))).map((r) => r.id))
    : new Set<string>();
  return (a) => (!!a.prospectId && prospects.has(a.prospectId)) || (!!a.ownerGroupId && groups.has(a.ownerGroupId)) || a.locationIds.some((l) => locs.has(l)) || (s.brandIds.size > 0 && brandIn(s, a.brandId));
}

type Doc = typeof franchiseDocuments.$inferSelect;

/**
 * Which documents a territory- or brand-scoped person may read (or, with `edit`, change): disclosure documents of
 * their country or brand (Disclosure), agreement templates of their country or brand, and executed agreements and vault
 * files of their owner groups (Franchise agreements). Documents shared by every brand (no brand) are read-only to a
 * brand-scoped person.
 */
export async function documentFilter(req: FastifyRequest, db: Exec, orgId: string, action: AccessAction = 'view'): Promise<{ any: boolean; allows: (d: Doc) => boolean }> {
  const [disc, agr] = await Promise.all([legalScope(req, db, orgId, 'legal.disclosure', action), legalScope(req, db, orgId, 'legal.agreements', action)]);
  const groups = await territoryOwnerGroups(db, orgId, agr);
  const ofBrand = (s: LegalScope, d: Doc) => s.brandIds.size > 0 && (d.brandId ? s.brandIds.has(d.brandId) : action === 'view');
  const allows = (d: Doc) => {
    if (d.kind === 'disclosure') return hasLegalScope(disc) && (jurisdictionsIn(disc, d.jurisdictions) || ofBrand(disc, d));
    if (!hasLegalScope(agr)) return false;
    if (agr.all) return true;
    if (d.kind === 'agreement_template') return jurisdictionsIn(agr, d.jurisdictions) || ofBrand(agr, d);
    return !!d.ownerGroupId && groups.has(d.ownerGroupId);
  };
  return { any: hasLegalScope(disc) || hasLegalScope(agr), allows };
}

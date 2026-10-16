/**
 * Territory map (Sales → Territories, module `sales.territories`; franchise pipeline holders keep view/edit).
 *
 * - Territories are drawn (GeoJSON polygons) and/or built from postcode lists.
 * - Status follows the pipeline and agreements: reserved (an active prospect), sold (an active agreement), under
 *   development (the onboarding project is running), open (the location opened). HQ can sync it or set it by hand.
 * - Exclusivity rules: an exclusive (or two protected) territories may not overlap a taken territory. Saving such an
 *   overlap is refused with the conflicting territories listed.
 * - Demographics come from the provider for the country (US Census ACS when configured, sandbox otherwise) and feed
 *   the score with the performance of the network's locations in or near the territory.
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  DEFAULT_SCORING_TARGETS, areaKm2, centroidOf, deriveTerritoryStatus, findOverlaps, jurisdictionCode, normalizePostcode, pointInGeometry, scoreTerritory,
  type AccessAction, type ScoringTargets, type TerritoryExclusivity, type TerritoryGeometry, type TerritoryShape,
} from '@bh/shared';
import type { Services } from '../../context.ts';
import type { Exec } from '../../db/client.ts';
import { franchiseAgreements, franchiseProjects, franchiseProspects, franchiseTerritories, locations, organizations, ownerGroups, royaltyStatements } from '../../db/schema/index.ts';
import { demographicsFor } from '../../integrations/demographics.ts';
import { conflict, forbidden, notFound } from '../../lib/errors.ts';
import { hasCapability, requireMember } from '../authz.ts';

export type Territory = typeof franchiseTerritories.$inferSelect;
export const TERRITORY_MODULE = 'sales.territories';
const orgTarget = (organizationId: string) => ({ organizationId, kind: 'organization' as const, id: organizationId });

/** Territory map capability (organisation-wide). View and edit also come with the franchise pipeline. */
export async function canTerritories(req: FastifyRequest, db: Exec, organizationId: string, action: AccessAction) {
  if (await hasCapability(req, db, TERRITORY_MODULE, action, orgTarget(organizationId))) return true;
  return (action === 'view' || action === 'edit') && hasCapability(req, db, 'sales.franchise_pipeline', action, orgTarget(organizationId));
}

export async function requireTerritories(req: FastifyRequest, db: Exec, organizationId: string, action: AccessAction) {
  await requireMember(req, db, organizationId);
  if (!(await canTerritories(req, db, organizationId, action))) throw forbidden(`You don't have ${action} access to the territory map`);
}

export interface TerritorySettings { publicMap: boolean; showTaken: boolean; targets: ScoringTargets }

export function territorySettings(org: { settings: Record<string, unknown> }): TerritorySettings {
  const t = ((org.settings.franchise ?? {}) as { territoryMap?: Partial<TerritorySettings> }).territoryMap ?? {};
  return { publicMap: t.publicMap ?? false, showTaken: t.showTaken ?? true, targets: { ...DEFAULT_SCORING_TARGETS, ...(t.targets ?? {}) } };
}

/** Basemap config for MapLibre clients (style URL or raster template) from MAP_TILES_URL. */
export function mapConfig(cfg: Services['cfg']) {
  const url = cfg.MAP_TILES_URL ?? null;
  return { tilesUrl: url, kind: !url ? ('outline' as const) : url.includes('{z}') ? ('raster' as const) : ('style' as const), attribution: cfg.MAP_ATTRIBUTION ?? (url ? '© OpenStreetMap contributors' : null) };
}

export const shapeOf = (t: Territory): TerritoryShape => ({ id: t.id, name: t.name, status: t.status, exclusivity: t.exclusivity as TerritoryExclusivity, geometry: t.geometry ?? null, postcodes: t.postcodes, brandId: t.brandId ?? null });

export async function orgTerritories(db: Exec, organizationId: string) {
  return db.select().from(franchiseTerritories).where(eq(franchiseTerritories.organizationId, organizationId));
}

export async function loadTerritory(db: Exec, organizationId: string, id: string) {
  const [t] = await db.select().from(franchiseTerritories).where(and(eq(franchiseTerritories.id, id), eq(franchiseTerritories.organizationId, organizationId)));
  if (!t) throw notFound('Territory');
  return t;
}

/** Refuses a save that breaks the exclusivity rules (409 with the conflicting territories). */
export function assertNoConflict(shape: TerritoryShape, all: Territory[]) {
  const overlaps = findOverlaps(shape, all.map(shapeOf));
  const conflicts = overlaps.filter((o) => o.conflict);
  if (conflicts.length) {
    throw conflict('territory_overlap', `This territory overlaps ${conflicts.map((c) => c.name).join(', ')}, which ${conflicts.length > 1 ? 'are' : 'is'} already taken and exclusive.`, { overlaps: conflicts });
  }
  return overlaps;
}

export interface TerritoryLinks {
  prospects: Array<{ id: string; name: string; stage: string }>;
  agreement: { id: string; ownerGroupId: string | null; ownerGroupName: string | null; startDate: string; endDate: string; status: string } | null;
  project: { id: string; status: string; targetOpenDate: string | null } | null;
  openLocations: Array<{ id: string; name: string }>;
}

/** Deals tied to each territory: active prospects, the active agreement, its onboarding project and open locations. */
export async function territoryLinks(db: Exec, organizationId: string, ids: string[]): Promise<Map<string, TerritoryLinks>> {
  const out = new Map<string, TerritoryLinks>(ids.map((id) => [id, { prospects: [], agreement: null, project: null, openLocations: [] }]));
  if (!ids.length) return out;
  const pros = await db.select({ id: franchiseProspects.id, name: franchiseProspects.name, stage: franchiseProspects.stage, territoryId: franchiseProspects.territoryId }).from(franchiseProspects)
    .where(and(eq(franchiseProspects.organizationId, organizationId), inArray(franchiseProspects.territoryId, ids), sql`${franchiseProspects.stage} not in ('lost')`));
  for (const p of pros) if (!['signed', 'onboarding', 'opened'].includes(p.stage)) out.get(p.territoryId!)?.prospects.push({ id: p.id, name: p.name, stage: p.stage });
  const ags = await db.select({ a: franchiseAgreements, g: ownerGroups.name }).from(franchiseAgreements).leftJoin(ownerGroups, eq(ownerGroups.id, franchiseAgreements.ownerGroupId))
    .where(and(eq(franchiseAgreements.organizationId, organizationId), inArray(franchiseAgreements.territoryId, ids), eq(franchiseAgreements.status, 'active')));
  const prospectIds = ags.map((x) => x.a.prospectId).filter((x): x is string => !!x);
  const projects = prospectIds.length ? await db.select().from(franchiseProjects).where(inArray(franchiseProjects.prospectId, prospectIds)) : [];
  const locIds = [...new Set([...ags.flatMap((x) => x.a.locationIds), ...projects.map((p) => p.locationId).filter((x): x is string => !!x)])];
  const locs = locIds.length ? await db.select({ id: locations.id, name: locations.name, status: locations.status }).from(locations).where(inArray(locations.id, locIds)) : [];
  for (const { a, g } of ags) {
    const l = out.get(a.territoryId!);
    if (!l) continue;
    l.agreement = { id: a.id, ownerGroupId: a.ownerGroupId, ownerGroupName: g, startDate: a.startDate, endDate: a.endDate, status: a.status };
    const proj = projects.find((p) => p.prospectId === a.prospectId);
    if (proj) l.project = { id: proj.id, status: proj.status, targetOpenDate: proj.targetOpenDate };
    const mine = new Set([...a.locationIds, ...(proj?.locationId ? [proj.locationId] : [])]);
    l.openLocations = locs.filter((x) => mine.has(x.id) && x.status === 'operating').map((x) => ({ id: x.id, name: x.name }));
  }
  return out;
}

export function derivedStatus(t: Territory, l: TerritoryLinks | undefined) {
  if (!l) return t.status;
  return deriveTerritoryStatus(t.status, {
    openLocation: l.openLocations.length > 0 || l.project?.status === 'opened',
    activeProject: !!l.project && ['active', 'go_live_requested'].includes(l.project.status),
    activeAgreement: !!l.agreement,
    activeProspect: l.prospects.length > 0 || !!t.reservedForProspectId,
  });
}

export function serializeTerritory(t: Territory, extra: { links?: TerritoryLinks; overlaps?: ReturnType<typeof findOverlaps>; ownerGroupName?: string | null } = {}) {
  return {
    id: t.id, name: t.name, country: t.country, region: t.region, jurisdiction: jurisdictionCode(t.country, t.region), description: t.description, status: t.status,
    derivedStatus: derivedStatus(t, extra.links), exclusivity: t.exclusivity, showOnSite: t.showOnSite, geometry: t.geometry ?? null, postcodes: t.postcodes,
    areaKm2: t.geometry ? areaKm2(t.geometry) : null, centroid: t.centroid ?? (t.geometry ? centroidOf(t.geometry) : null),
    demographics: t.demographics ?? null, score: t.score, scoreParts: t.scoreParts ?? null, reservedForProspectId: t.reservedForProspectId, ownerGroupId: t.ownerGroupId, ownerGroupName: extra.ownerGroupName ?? null,
    agreementId: t.agreementId, masterAgreementId: t.masterAgreementId, scopeTerritoryId: t.scopeTerritoryId, statusChangedAt: t.statusChangedAt?.toISOString() ?? null, updatedAt: t.updatedAt.toISOString(),
    links: extra.links ?? null, overlaps: extra.overlaps ?? [],
  };
}

export function geometryFields(geometry: TerritoryGeometry | null | undefined, postcodes: string[] | undefined) {
  const out: Partial<typeof franchiseTerritories.$inferInsert> = {};
  if (geometry !== undefined) { out.geometry = geometry; out.centroid = geometry ? centroidOf(geometry) : null; }
  if (postcodes !== undefined) out.postcodes = [...new Set(postcodes.map(normalizePostcode).filter(Boolean))].slice(0, 2000);
  return out;
}

/**
 * Network performance near a territory: 12-month gross sales of the locations inside it (by drawn area or postcode),
 * or else within 25 km of its centre, against the network median per location in the same currency.
 */
export async function nearbyPerformance(db: Exec, organizationId: string, t: Territory, now = new Date()) {
  const since = new Date(now.getTime() - 365 * 86_400_000);
  const locs = await db.select({ id: locations.id, geo: locations.geo, address: locations.address, currency: locations.currency, country: locations.country }).from(locations).where(and(eq(locations.organizationId, organizationId), eq(locations.status, 'operating')));
  const sales = await db.select({ locationId: royaltyStatements.locationId, gross: sql<number>`sum(${royaltyStatements.grossSalesMinor})::bigint` }).from(royaltyStatements)
    .where(and(eq(royaltyStatements.organizationId, organizationId), gte(royaltyStatements.periodStartAt, since), sql`${royaltyStatements.status} <> 'void'`)).groupBy(royaltyStatements.locationId);
  const gross = new Map(sales.map((x) => [x.locationId, Number(x.gross)]));
  const centre = t.centroid ?? (t.geometry ? centroidOf(t.geometry) : null);
  const pcs = new Set(t.postcodes);
  const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.hypot((a.lat - b.lat) * 111.32, (a.lng - b.lng) * 111.32 * Math.cos((a.lat * Math.PI) / 180));
  let nearby = locs.filter((l) => (l.geo && t.geometry && pointInGeometry([l.geo.lng, l.geo.lat], t.geometry)) || (l.address.postalCode && pcs.has(normalizePostcode(l.address.postalCode))));
  if (!nearby.length && centre) nearby = locs.filter((l) => l.geo && km(l.geo, centre) <= 25);
  const currency = nearby[0]?.currency ?? locs.find((l) => l.country === t.country)?.currency ?? null;
  const sameCurrency = locs.filter((l) => l.currency === currency && gross.has(l.id)).map((l) => gross.get(l.id)!).sort((a, b) => a - b);
  const median = sameCurrency.length ? sameCurrency[Math.floor(sameCurrency.length / 2)]! : null;
  const vals = nearby.filter((l) => l.currency === currency && gross.has(l.id)).map((l) => gross.get(l.id)!);
  return { currency, nearbyLocations: nearby.length, nearbyRevenueMinor: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null, networkMedianRevenueMinor: median };
}

/** Fetches demographics for a territory, scores it and stores both. */
export async function refreshDemographics(s: Services, t: Territory) {
  const provider = demographicsFor(s.cfg, s.partnerFetch, t.country, t.postcodes.length > 0);
  const demographics = await provider.lookup({ country: t.country, postcodes: t.postcodes, areaKm2: t.geometry ? areaKm2(t.geometry) : null });
  const [org] = await s.db.select().from(organizations).where(eq(organizations.id, t.organizationId));
  const perf = await nearbyPerformance(s.db, t.organizationId, t);
  const scored = scoreTerritory(demographics, perf, territorySettings(org!).targets);
  const [row] = await s.db.update(franchiseTerritories).set({ demographics, score: scored.score, scoreParts: scored.parts, updatedAt: new Date() }).where(eq(franchiseTerritories.id, t.id)).returning();
  return { territory: row!, performance: perf };
}

/** Item 12–style territory description lines (the FDD's "Territory" item lists the area and its protections). */
export function item12Lines(t: Territory) {
  const g = t.geometry;
  const bounds = g ? (() => { const pts = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flatMap((p) => p[0]!); return { minLat: Math.min(...pts.map((p) => p[1])), maxLat: Math.max(...pts.map((p) => p[1])), minLng: Math.min(...pts.map((p) => p[0])), maxLng: Math.max(...pts.map((p) => p[0])) }; })() : null;
  const exclusivity = t.exclusivity === 'exclusive'
    ? 'Exclusive territory: we will not operate, or license others to operate, a unit of the brand within the territory while the franchise agreement is in effect and you are not in default.'
    : t.exclusivity === 'protected'
      ? 'Protected territory: we will not open another unit within the territory, but we and other franchisees may sell through other channels (online, events, delivery) to customers in it.'
      : 'Non-exclusive: you will not receive an exclusive territory. You may face competition from other franchisees, from outlets we own, or from other channels.';
  return {
    name: t.name, jurisdiction: jurisdictionCode(t.country, t.region), exclusivity,
    area: g ? `${areaKm2(g).toLocaleString('en-US')} km² drawn area` : null,
    bounds: bounds ? `Bounded by latitude ${bounds.minLat.toFixed(4)} to ${bounds.maxLat.toFixed(4)} and longitude ${bounds.minLng.toFixed(4)} to ${bounds.maxLng.toFixed(4)} (GeoJSON attached to the agreement).` : null,
    postcodes: t.postcodes.length ? `Postal / ZIP codes: ${t.postcodes.join(', ')}.` : null,
    population: t.demographics?.population != null ? `Population about ${t.demographics.population.toLocaleString('en-US')} (${t.demographics.sandbox ? 'sample figures, not for disclosure' : `${t.demographics.source}${t.demographics.year ? ` ${t.demographics.year}` : ''}`}).` : null,
    description: t.description,
  };
}

export const ITEM12_DISCLAIMER = 'Prepared from BranchHarbor territory data as a drafting aid for Item 12 of the disclosure document. Franchise counsel must review the final wording; it is not legal advice.';

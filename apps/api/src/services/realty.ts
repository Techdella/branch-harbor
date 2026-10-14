/**
 * Real Estate business logic: access rules, lead routing, viewing slots/booking, listing lifecycle and
 * serializers. Routes stay thin; every rule here is enforced server-side.
 */
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  areaIn, areaUnitLabel, defaultAreaUnit, findProtectedTargeting, formatAddressLines, listingTransition, PUBLIC_LISTING_STATUSES, PUBLISHING_STATUSES,
  tierRequiresApproval, VIEWING_BLOCKING_STATUSES, type AreaUnit, type ListingStatus, type ListingTransaction, type OfficeTier,
} from '@bh/shared';
import type { Exec } from '../db/client.ts';
import {
  locations, realtyAgents, realtyListingAgents, realtyListingHistory, realtyListings, realtyOffers, realtyOffices, realtyOpenHouses, realtyViewings,
  type WeeklyWindow,
} from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, validationError } from '../lib/errors.ts';
import { localDateParts, weekdayOf, zonedToUtc } from '../lib/tz.ts';
import { audit } from './audit.ts';
import { authorisedLocations, locationAllowed, requireMember } from './authz.ts';

export type Listing = typeof realtyListings.$inferSelect;
export type Office = typeof realtyOffices.$inferSelect;
export type Agent = typeof realtyAgents.$inferSelect;
export type Viewing = typeof realtyViewings.$inferSelect;
export type Offer = typeof realtyOffers.$inferSelect;
type Loc = typeof locations.$inferSelect;

// ───────── Offices ─────────

/** Office settings for a location, created with country defaults on first use. */
export async function officeFor(db: Exec, loc: Pick<Loc, 'id' | 'organizationId' | 'country'>): Promise<Office> {
  const [o] = await db.select().from(realtyOffices).where(eq(realtyOffices.locationId, loc.id));
  if (o) return o;
  const [created] = await db.insert(realtyOffices).values({ organizationId: loc.organizationId, locationId: loc.id, areaUnit: defaultAreaUnit(loc.country) })
    .onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db.select().from(realtyOffices).where(eq(realtyOffices.locationId, loc.id));
  return again!;
}

// ───────── Access ─────────

export interface RealtyAccess {
  userId: string;
  /** Locations where the user may read operations (listings, schedules). */
  ops: 'all' | Set<string>;
  opsWrite: 'all' | Set<string>;
  /** Locations where the user may see client personal data (managers, franchise owners, org owners). */
  clients: 'all' | Set<string>;
  clientsWrite: 'all' | Set<string>;
  /** Locations where the user can approve listings (HQ advertising checks). */
  approve: 'all' | Set<string>;
  reports: 'all' | Set<string>;
  /** Agent profiles linked to the signed-in user. */
  agents: Agent[];
  agentIds: Set<string>;
}

export async function realtyAccess(req: FastifyRequest, db: Exec, orgId: string): Promise<RealtyAccess> {
  await requireMember(req, db, orgId);
  const [ops, opsWrite, clients, clientsWrite, approve, reports] = await Promise.all([
    authorisedLocations(req, db, orgId, 'operations.read'), authorisedLocations(req, db, orgId, 'operations.write'),
    authorisedLocations(req, db, orgId, 'customers.read'), authorisedLocations(req, db, orgId, 'customers.write'),
    authorisedLocations(req, db, orgId, 'website.approve'), authorisedLocations(req, db, orgId, 'reports.read'),
  ]);
  const agents = await db.select().from(realtyAgents).where(and(eq(realtyAgents.organizationId, orgId), eq(realtyAgents.userId, req.user!.id), eq(realtyAgents.active, true)));
  return { userId: req.user!.id, ops, opsWrite, clients, clientsWrite, approve, reports, agents, agentIds: new Set(agents.map((a) => a.id)) };
}

export const isManagerAt = (a: RealtyAccess, locationId: string) => locationAllowed(a.clients, locationId);

export async function listingAgentRows(db: Exec, listingIds: string[]) {
  if (!listingIds.length) return [];
  return db.select({ la: realtyListingAgents, agent: realtyAgents }).from(realtyListingAgents)
    .innerJoin(realtyAgents, eq(realtyAgents.id, realtyListingAgents.agentId))
    .where(inArray(realtyListingAgents.listingId, listingIds));
}

/** May the user edit this listing? Managers at the office, or an agent on the listing. */
export function canEditListing(a: RealtyAccess, listing: Listing, listingAgentIds: string[]) {
  if (locationAllowed(a.clientsWrite, listing.locationId) && locationAllowed(a.opsWrite, listing.locationId)) return true;
  return locationAllowed(a.opsWrite, listing.locationId) && listingAgentIds.some((id) => a.agentIds.has(id));
}

/**
 * Offer visibility: office managers (client access at the office), agents on the listing (lead/co-listing),
 * and the agent who recorded that specific offer for their buyer. HQ report access never implies offer access.
 */
export function canSeeOffer(a: RealtyAccess, listing: Pick<Listing, 'locationId'>, listingAgentIds: string[], offer?: Pick<Offer, 'submittedByAgentId'>) {
  if (isManagerAt(a, listing.locationId)) return true;
  if (listingAgentIds.some((id) => a.agentIds.has(id))) return true;
  return !!offer?.submittedByAgentId && a.agentIds.has(offer.submittedByAgentId);
}

// ───────── Lead routing ─────────

export interface RoutingResult {
  agentId: string | null;
  routedBy: 'listing_agent' | 'co_listing_agent' | 'round_robin' | 'office_pool';
}

/**
 * Route a new enquiry: listing agent → co-listing agent → office round-robin → office pool.
 * The office row is locked so concurrent enquiries advance the round-robin cursor one at a time.
 */
export async function routeEnquiry(tx: Exec, input: { locationId: string; listingId?: string | null }): Promise<RoutingResult> {
  const [office] = await tx.select().from(realtyOffices).where(eq(realtyOffices.locationId, input.locationId)).for('update');
  const mode = office?.leadRouting ?? 'listing_agent';
  if (mode === 'office_pool') return { agentId: null, routedBy: 'office_pool' };
  const eligible = (a: Agent) => a.active && a.acceptsLeads;
  if (input.listingId && mode === 'listing_agent') {
    const rows = await listingAgentRows(tx, [input.listingId]);
    const lead = rows.find((r) => r.la.role === 'lead' && eligible(r.agent));
    if (lead) return { agentId: lead.agent.id, routedBy: 'listing_agent' };
    const co = rows.filter((r) => r.la.role !== 'lead' && eligible(r.agent)).sort((x, y) => x.la.createdAt.getTime() - y.la.createdAt.getTime())[0];
    if (co) return { agentId: co.agent.id, routedBy: 'co_listing_agent' };
  }
  const pool = (await tx.select().from(realtyAgents).where(and(eq(realtyAgents.locationId, input.locationId), eq(realtyAgents.active, true), eq(realtyAgents.acceptsLeads, true)))
    .orderBy(asc(realtyAgents.createdAt), asc(realtyAgents.id)));
  if (!pool.length || !office) return { agentId: null, routedBy: 'office_pool' };
  const pick = pool[office.roundRobinCursor % pool.length]!;
  await tx.update(realtyOffices).set({ roundRobinCursor: (office.roundRobinCursor + 1) % pool.length, updatedAt: new Date() }).where(eq(realtyOffices.id, office.id));
  return { agentId: pick.id, routedBy: 'round_robin' };
}

// ───────── Viewings ─────────

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export interface Slot { startsAt: string; endsAt: string; agentId: string; agentName: string }

function windowsFor(availability: WeeklyWindow[], weekday: number) {
  return availability.filter((w) => w.weekday === weekday).map((w) => [toMin(w.start), w.end === '24:00' ? 1440 : toMin(w.end)] as const);
}

function insideAvailability(agent: Agent, startsAt: Date, endsAt: Date, timeZone: string) {
  const s = localDateParts(startsAt, timeZone);
  const e = localDateParts(new Date(endsAt.getTime() - 1), timeZone);
  if (s.date !== e.date) return false;
  const sm = toMin(s.time), em = sm + Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
  return windowsFor(agent.availability, s.weekday).some(([a, b]) => sm >= a && em <= b);
}

/** Busy intervals for agents between two instants: blocking viewings and scheduled open houses (with buffer). */
async function busyFor(db: Exec, agentIds: string[], from: Date, to: Date, bufferMin: number, excludeViewingId?: string) {
  if (!agentIds.length) return new Map<string, Array<[number, number]>>();
  const pad = bufferMin * 60_000;
  const vs = await db.select({ agentId: realtyViewings.agentId, s: realtyViewings.startsAt, e: realtyViewings.endsAt, id: realtyViewings.id }).from(realtyViewings)
    .where(and(inArray(realtyViewings.agentId, agentIds), inArray(realtyViewings.status, [...VIEWING_BLOCKING_STATUSES]), lt(realtyViewings.startsAt, new Date(to.getTime() + pad)), gt(realtyViewings.endsAt, new Date(from.getTime() - pad))));
  const oh = await db.select({ agentId: realtyOpenHouses.agentId, s: realtyOpenHouses.startsAt, e: realtyOpenHouses.endsAt }).from(realtyOpenHouses)
    .where(and(inArray(realtyOpenHouses.agentId, agentIds), eq(realtyOpenHouses.status, 'scheduled'), lt(realtyOpenHouses.startsAt, new Date(to.getTime() + pad)), gt(realtyOpenHouses.endsAt, new Date(from.getTime() - pad))));
  const map = new Map<string, Array<[number, number]>>();
  for (const v of vs) if (v.id !== excludeViewingId) map.set(v.agentId, [...(map.get(v.agentId) ?? []), [v.s.getTime() - pad, v.e.getTime() + pad]]);
  for (const v of oh) if (v.agentId) map.set(v.agentId, [...(map.get(v.agentId) ?? []), [v.s.getTime() - pad, v.e.getTime() + pad]]);
  return map;
}

const overlaps = (busy: Array<[number, number]> | undefined, s: number, e: number) => !!busy?.some(([a, b]) => s < b && e > a);

/** Listing agents in booking order: lead first, then co-listing agents (active only). */
export async function bookingAgents(db: Exec, listingId: string): Promise<Agent[]> {
  const rows = await listingAgentRows(db, [listingId]);
  return rows.filter((r) => r.agent.active).sort((a, b) => (a.la.role === 'lead' ? -1 : b.la.role === 'lead' ? 1 : a.la.createdAt.getTime() - b.la.createdAt.getTime())).map((r) => r.agent);
}

/** Free viewing slots on a local date (office time zone) across the listing's agents. */
export async function viewingSlots(db: Exec, input: { listing: Listing; office: Office; timeZone: string; date: string; now?: Date; leadMinutes?: number }): Promise<Slot[]> {
  const { listing, office, timeZone, date } = input;
  const now = input.now ?? new Date();
  const earliest = now.getTime() + (input.leadMinutes ?? 60) * 60_000;
  const agents = await bookingAgents(db, listing.id);
  const weekday = weekdayOf(date);
  const dayStart = zonedToUtc(date, '00:00', timeZone), dayEnd = new Date(dayStart.getTime() + 26 * 3600_000);
  const busy = await busyFor(db, agents.map((a) => a.id), dayStart, dayEnd, office.viewingBufferMinutes);
  const len = office.viewingMinutes;
  const seen = new Map<string, Slot>();
  for (const agent of agents) {
    for (const [a, b] of windowsFor(agent.availability, weekday)) {
      for (let m = a; m + len <= b; m += len) {
        const s = zonedToUtc(date, fmt(m), timeZone);
        const e = new Date(s.getTime() + len * 60_000);
        if (s.getTime() < earliest || localDateParts(s, timeZone).date !== date) continue;
        if (overlaps(busy.get(agent.id), s.getTime(), e.getTime())) continue;
        const key = s.toISOString();
        if (!seen.has(key)) seen.set(key, { startsAt: key, endsAt: e.toISOString(), agentId: agent.id, agentName: agent.name });
      }
    }
  }
  return [...seen.values()].sort((x, y) => x.startsAt.localeCompare(y.startsAt));
}

export interface BookViewingInput {
  organizationId: string;
  listing: Listing;
  office: Office;
  timeZone: string;
  startsAt: Date;
  /** Preferred agent; otherwise the first free listing agent. */
  agentId?: string | null;
  contact: { name: string; email?: string | null; phone?: string | null };
  enquiryId?: string | null;
  customerId?: string | null;
  userId?: string | null;
  kind?: 'in_person' | 'virtual';
  source?: string;
  status?: 'requested' | 'confirmed';
  enforceAvailability?: boolean;
  /** Staff may book any agent of the office, not only listing agents. */
  allowAnyAgent?: boolean;
}

/**
 * Book a viewing. Candidate agent rows are locked (`FOR UPDATE`, ordered by id) so two concurrent bookings for the
 * same agent are serialised and the second sees the first: an agent can never hold overlapping viewings.
 */
export async function bookViewing(tx: Exec, i: BookViewingInput): Promise<{ viewing: Viewing; manageToken: string }> {
  if (!(PUBLIC_LISTING_STATUSES as readonly string[]).includes(i.listing.status) && i.listing.status !== 'draft') throw conflict('listing_not_viewable', `Viewings are not available for a listing that is ${i.listing.status.replace('_', ' ')}`);
  let candidates = await bookingAgents(tx, i.listing.id);
  if (i.agentId) {
    const preferred = candidates.find((a) => a.id === i.agentId);
    if (preferred) candidates = [preferred];
    else if (i.allowAnyAgent) {
      const [a] = await tx.select().from(realtyAgents).where(and(eq(realtyAgents.id, i.agentId), eq(realtyAgents.organizationId, i.organizationId), eq(realtyAgents.active, true)));
      if (!a) throw validationError('Unknown agent', { agentId: 'Not an active agent' });
      candidates = [a];
    } else throw validationError('That agent does not show this property', { agentId: 'Not a listing agent' });
  }
  if (!candidates.length) throw conflict('no_listing_agent', 'This listing has no agent to show it yet');
  const ids = candidates.map((a) => a.id).sort();
  await tx.select({ id: realtyAgents.id }).from(realtyAgents).where(inArray(realtyAgents.id, ids)).orderBy(asc(realtyAgents.id)).for('update');
  const endsAt = new Date(i.startsAt.getTime() + i.office.viewingMinutes * 60_000);
  const busy = await busyFor(tx, ids, i.startsAt, endsAt, i.office.viewingBufferMinutes);
  const agent = candidates.find((a) => (i.enforceAvailability === false || insideAvailability(a, i.startsAt, endsAt, i.timeZone)) && !overlaps(busy.get(a.id), i.startsAt.getTime(), endsAt.getTime()));
  if (!agent) throw conflict('slot_unavailable', 'That viewing time is no longer available. Please choose another time.');
  const manageToken = randomToken();
  const [viewing] = await tx.insert(realtyViewings).values({
    organizationId: i.organizationId, locationId: i.listing.locationId, listingId: i.listing.id, agentId: agent.id, enquiryId: i.enquiryId ?? null,
    customerId: i.customerId ?? null, userId: i.userId ?? null, contactName: i.contact.name, contactEmail: i.contact.email ?? null, contactPhone: i.contact.phone ?? null,
    startsAt: i.startsAt, endsAt, kind: i.kind ?? 'in_person', status: i.status ?? 'requested', confirmedAt: i.status === 'confirmed' ? new Date() : null,
    source: i.source ?? 'website', manageTokenHash: sha256(manageToken),
  }).returning();
  return { viewing: viewing!, manageToken };
}

/** Is another blocking viewing overlapping for this agent (used when confirming / moving)? */
export async function agentHasConflict(tx: Exec, agentId: string, startsAt: Date, endsAt: Date, bufferMin: number, excludeViewingId?: string) {
  const busy = await busyFor(tx, [agentId], startsAt, endsAt, bufferMin, excludeViewingId);
  return overlaps(busy.get(agentId), startsAt.getTime(), endsAt.getTime());
}

// ───────── Listing lifecycle ─────────

export interface TransitionResult {
  result: 'applied' | 'pending_approval';
  listing: Listing;
  cancelledViewings?: Viewing[];
}

export const isPublic = (status: string) => (PUBLIC_LISTING_STATUSES as readonly string[]).includes(status);

/**
 * Move a listing to a new status. Publishing a non-public listing in a managed/standard office needs HQ approval
 * unless the actor can approve at this office (HQ themselves). Withdrawing cancels upcoming viewings and open houses.
 */
export async function transitionListing(tx: Exec, input: {
  listing: Listing; office: Office; to: ListingStatus; actorUserId: string | null; canApprove: boolean; closedPriceMinor?: number | null; note?: string | null; viaApproval?: boolean;
}): Promise<TransitionResult> {
  const { listing, office, to } = input;
  const from = listing.status as ListingStatus;
  const t = listingTransition(from, to, listing.transaction as ListingTransaction);
  if (!t.ok) throw conflict('invalid_transition', `A ${listing.transaction} listing cannot move from ${from.replace('_', ' ')} to ${to.replace('_', ' ')}`, { reason: t.reason, from, to });
  const publishing = !isPublic(from) && (PUBLISHING_STATUSES as readonly string[]).includes(to);
  if (publishing) {
    const leads = await tx.select().from(realtyListingAgents).where(and(eq(realtyListingAgents.listingId, listing.id), eq(realtyListingAgents.role, 'lead')));
    if (!leads.length) throw validationError('Assign a listing agent before publishing', { agents: 'A listing agent is required' });
    if (listing.priceMinor <= 0) throw validationError('Set a price before publishing', { priceMinor: 'Required' });
    if (tierRequiresApproval(office.tier as OfficeTier) && !input.canApprove && !input.viaApproval) {
      if (listing.approvalStatus === 'pending' && listing.requestedStatus) throw conflict('approval_pending', 'This listing is already waiting for HQ approval');
      const [u] = await tx.update(realtyListings).set({ approvalStatus: 'pending', requestedStatus: to, approvalRequestedBy: input.actorUserId, approvalComment: input.note ?? null, approvalDecidedBy: null, approvalDecidedAt: null, updatedAt: new Date() })
        .where(eq(realtyListings.id, listing.id)).returning();
      await audit(tx, { organizationId: listing.organizationId, actorUserId: input.actorUserId, action: 'realty.listing.approval_requested', scopeKind: 'location', scopeId: listing.locationId, targetType: 'realty_listing', targetId: listing.id, metadata: { requestedStatus: to } });
      return { result: 'pending_approval', listing: u! };
    }
  }
  const now = new Date();
  const patch: Partial<Listing> = { status: to, updatedAt: now };
  if (to === 'active' && !listing.firstActiveAt) patch.firstActiveAt = now;
  if (isPublic(to) && !isPublic(from)) patch.publishedAt = now;
  if (publishing) {
    patch.approvalStatus = tierRequiresApproval(office.tier as OfficeTier) ? 'approved' : 'not_required';
    patch.requestedStatus = null;
  }
  if (to === 'sold' || to === 'let') {
    patch.closedAt = now;
    const [accepted] = await tx.select().from(realtyOffers).where(and(eq(realtyOffers.listingId, listing.id), eq(realtyOffers.status, 'accepted')));
    patch.closedPriceMinor = input.closedPriceMinor ?? accepted?.amountMinor ?? listing.priceMinor;
  }
  if (to === 'withdrawn') patch.withdrawnAt = now;
  if (to === 'draft') { patch.approvalStatus = 'not_required'; patch.requestedStatus = null; patch.pendingChanges = null; }
  const [updated] = await tx.update(realtyListings).set(patch).where(and(eq(realtyListings.id, listing.id), eq(realtyListings.status, from))).returning();
  if (!updated) throw conflict('listing_changed', 'The listing changed while you were editing it. Reload and try again.');
  await tx.insert(realtyListingHistory).values({ organizationId: listing.organizationId, listingId: listing.id, fromStatus: from, toStatus: to, actorUserId: input.actorUserId, note: input.note ?? null });
  await audit(tx, { organizationId: listing.organizationId, actorUserId: input.actorUserId, action: 'realty.listing.status', scopeKind: 'location', scopeId: listing.locationId, targetType: 'realty_listing', targetId: listing.id, metadata: { from, to } });
  let cancelledViewings: Viewing[] = [];
  if (to === 'withdrawn' || to === 'sold' || to === 'let') {
    cancelledViewings = await tx.update(realtyViewings).set({ status: 'cancelled', cancelledAt: now, cancelReason: `Listing ${to}` })
      .where(and(eq(realtyViewings.listingId, listing.id), inArray(realtyViewings.status, [...VIEWING_BLOCKING_STATUSES]), gt(realtyViewings.startsAt, now))).returning();
    await tx.update(realtyOpenHouses).set({ status: 'cancelled' }).where(and(eq(realtyOpenHouses.listingId, listing.id), eq(realtyOpenHouses.status, 'scheduled'), gt(realtyOpenHouses.startsAt, now)));
  }
  return { result: 'applied', listing: updated, cancelledViewings };
}

// ───────── Search ─────────

export interface SearchCriteria {
  transaction?: 'sale' | 'rent';
  propertyTypes?: string[];
  minPrice?: number;
  maxPrice?: number;
  currency?: string;
  minBedrooms?: number;
  minBathrooms?: number;
  minArea?: number;
  areaUnit?: AreaUnit;
  city?: string;
  locationId?: string;
}

/** Price filters never convert currencies: a price range applies to listings in that currency only. */
export function matchesCriteria(l: Listing, c: SearchCriteria): boolean {
  if (c.transaction && l.transaction !== c.transaction) return false;
  if (c.propertyTypes?.length && !c.propertyTypes.includes(l.propertyType)) return false;
  if ((c.minPrice != null || c.maxPrice != null) && c.currency && l.currency !== c.currency) return false;
  if (c.minPrice != null && l.priceMinor < c.minPrice) return false;
  if (c.maxPrice != null && l.priceMinor > c.maxPrice) return false;
  if (c.minBedrooms != null && (l.bedrooms ?? -1) < c.minBedrooms) return false;
  if (c.minBathrooms != null && (l.bathrooms ?? -1) < c.minBathrooms) return false;
  if (c.minArea != null) {
    const unit = c.areaUnit ?? 'sqm';
    const v = areaIn(l.areaSqm, unit);
    if (v == null || v < c.minArea) return false;
  }
  if (c.city && l.city.toLowerCase() !== c.city.toLowerCase()) return false;
  if (c.locationId && l.locationId !== c.locationId) return false;
  return true;
}

// ───────── Serializers ─────────

export function areaView(sqm: number | null, unit: AreaUnit) {
  const value = areaIn(sqm, unit);
  return value == null ? null : { value, unit, label: areaUnitLabel(unit), sqm: Math.round((sqm ?? 0) * 10) / 10 };
}

export function publicListing(l: Listing, office: Office, extra: { photo?: boolean; areaUnit?: AreaUnit } = {}) {
  const unit = extra.areaUnit ?? (office.areaUnit as AreaUnit);
  return {
    id: l.id, reference: l.reference, title: l.title, transaction: l.transaction, propertyType: l.propertyType, status: l.status,
    price: { amount: l.priceMinor, currency: l.currency }, rentPeriod: l.rentPeriod,
    bedrooms: l.bedrooms, bathrooms: l.bathrooms, area: areaView(l.areaSqm, unit), officeAreaUnit: office.areaUnit,
    city: l.city, region: l.region, country: l.country,
    addressLines: formatAddressLines({ line1: l.addressLine1, line2: l.addressLine2, city: l.city, region: l.region, postalCode: l.postalCode, country: l.country }, { hideStreet: l.hideStreet }),
    photo: l.photos[0] ?? null, photoCount: l.photos.length, publishedAt: l.publishedAt?.toISOString() ?? null,
  };
}

export function staffListing(l: Listing, office: Office | undefined, agents: Array<{ id: string; name: string; role: string }>) {
  const unit = (office?.areaUnit ?? 'sqm') as AreaUnit;
  const dom = l.firstActiveAt ? Math.floor(((l.closedAt ?? l.withdrawnAt ?? new Date()).getTime() - l.firstActiveAt.getTime()) / 86400_000) : null;
  return {
    id: l.id, locationId: l.locationId, reference: l.reference, title: l.title, description: l.description, transaction: l.transaction, propertyType: l.propertyType, status: l.status,
    price: { amount: l.priceMinor, currency: l.currency }, rentPeriod: l.rentPeriod, bedrooms: l.bedrooms, bathrooms: l.bathrooms,
    area: areaView(l.areaSqm, unit), lot: areaView(l.lotSqm, unit), areaUnit: unit, yearBuilt: l.yearBuilt, features: l.features,
    address: { line1: l.addressLine1, line2: l.addressLine2, city: l.city, region: l.region, postalCode: l.postalCode, country: l.country },
    addressLines: formatAddressLines({ line1: l.addressLine1, line2: l.addressLine2, city: l.city, region: l.region, postalCode: l.postalCode, country: l.country }),
    hideStreet: l.hideStreet, geo: l.geo, photos: l.photos, floorPlans: l.floorPlans, virtualTourUrl: l.virtualTourUrl, disclosures: l.disclosures,
    approval: { status: l.approvalStatus, requestedStatus: l.requestedStatus, pendingChanges: l.pendingChanges, requestedBy: l.approvalRequestedBy, comment: l.approvalComment, decidedAt: l.approvalDecidedAt?.toISOString() ?? null },
    tier: office?.tier ?? null, agents, daysOnMarket: dom,
    closedPrice: l.closedPriceMinor != null ? { amount: l.closedPriceMinor, currency: l.currency } : null,
    firstActiveAt: l.firstActiveAt?.toISOString() ?? null, publishedAt: l.publishedAt?.toISOString() ?? null, closedAt: l.closedAt?.toISOString() ?? null,
    fairHousingWarnings: findProtectedTargeting(`${l.title}\n${l.description ?? ''}`),
    createdAt: l.createdAt.toISOString(), updatedAt: l.updatedAt.toISOString(),
  };
}

export function viewingView(v: Viewing, opts: { includeContact: boolean; listing?: Pick<Listing, 'title' | 'reference'> | null; agentName?: string | null; timeZone?: string | null }) {
  return {
    id: v.id, listingId: v.listingId, locationId: v.locationId, agentId: v.agentId, agentName: opts.agentName ?? null, enquiryId: v.enquiryId,
    listing: opts.listing ? { title: opts.listing.title, reference: opts.listing.reference } : null,
    startsAt: v.startsAt.toISOString(), endsAt: v.endsAt.toISOString(), timeZone: opts.timeZone ?? null, kind: v.kind, status: v.status, source: v.source,
    contact: opts.includeContact ? { name: v.contactName, email: v.contactEmail, phone: v.contactPhone } : { name: v.contactName.split(' ')[0] ?? 'Buyer', email: null, phone: null },
    feedback: v.feedbackAt ? { interestLevel: v.interestLevel, rating: v.feedbackRating, notes: opts.includeContact ? v.feedbackNotes : null, at: v.feedbackAt.toISOString() } : null,
    confirmedAt: v.confirmedAt?.toISOString() ?? null, cancelledAt: v.cancelledAt?.toISOString() ?? null, reminderSentAt: v.reminderSentAt?.toISOString() ?? null,
  };
}

/** Next reference like KR-TOR-0012 (unique per organisation). */
export async function nextReference(db: Exec, organizationId: string, loc: Pick<Loc, 'code'>) {
  const prefix = loc.code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'L';
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(realtyListings).where(eq(realtyListings.organizationId, organizationId));
  for (let i = (row?.n ?? 0) + 1; ; i++) {
    const ref = `${prefix}-${String(i).padStart(4, '0')}`;
    const [exists] = await db.select({ id: realtyListings.id }).from(realtyListings).where(and(eq(realtyListings.organizationId, organizationId), eq(realtyListings.reference, ref)));
    if (!exists) return ref;
  }
}

export function assertNoProtectedTargeting(text: string | null | undefined, field = 'instructions') {
  const f = findProtectedTargeting(text ?? '');
  if (f.length) {
    throw new AppError(422, 'fair_housing_refused', 'Requests that target, steer or exclude people by a protected characteristic are not allowed (fair housing).', { [field]: `Remove: “${f[0]!.phrase}”` }, { findings: f });
  }
}


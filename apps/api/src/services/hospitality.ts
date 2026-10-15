/**
 * Hospitality core: access, property settings, inventory counters, rate context and quotes, availability search,
 * reservations (hold → deposit → confirm), modification (new nights secured before old ones are released),
 * cancellation and no-show per policy, room assignment, check-in/out and the folio. See docs/verticals/hospitality.md.
 */
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  cancellationFee, hkTransition, INVENTORY_STATUSES, noShowFee, quoteStay, reservationTransitionAllowed, roomReadyForArrival, stayNights,
  type CancellationPolicy, type DailyRow, type HkStatus, type NightPrice, type ReservationStatus, type StayQuote, type TaxLine,
} from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import {
  hospAssignments, hospBeds, hospHkTasks, hospCancellationPolicies, hospDailyRates, hospFolioLines, hospInventory, hospProperties, hospRatePlans, hospRatePrices,
  hospReservationRooms, hospReservations, hospRoomBlocks, hospRooms, hospRoomTypes, hospSeasons, hospTaxes, locations, consentRecords,
} from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { isUniqueViolation, pgCode } from '../lib/pg.ts';
import { localDateParts, zonedToUtc } from '../lib/tz.ts';
import { audit } from './audit.ts';
import { authorisedLocations } from './authz.ts';
import { findOrCreateCustomer } from './customers.ts';
import { createPaymentForTarget, paymentTargetExtensions, refundPayment, reverseTargetPayment, type PaymentRow } from './payments.ts';

export type Location = typeof locations.$inferSelect;
export type Property = typeof hospProperties.$inferSelect;
export type RoomType = typeof hospRoomTypes.$inferSelect;
export type Room = typeof hospRooms.$inferSelect;
export type RatePlan = typeof hospRatePlans.$inferSelect;
export type Reservation = typeof hospReservations.$inferSelect;
export type ReservationRoom = typeof hospReservationRooms.$inferSelect;

export const STAY_CONSENT = { email: 'stay_messages_email', sms: 'stay_messages_sms', version: '2026-10' } as const;

// ───────────────────────── access ─────────────────────────

export async function hospAccess(req: FastifyRequest, db: Exec, orgId: string) {
  const [ops, opsWrite, guests, config, refunds, reports] = await Promise.all([
    authorisedLocations(req, db, orgId, 'operations.read'), authorisedLocations(req, db, orgId, 'operations.write'), authorisedLocations(req, db, orgId, 'customers.read'),
    authorisedLocations(req, db, orgId, 'locations.write'), authorisedLocations(req, db, orgId, 'payments.refund'), authorisedLocations(req, db, orgId, 'reports.read'),
  ]);
  return { ops, opsWrite, guests, config, refunds, reports };
}
export type HospAccess = Awaited<ReturnType<typeof hospAccess>>;

// ───────────────────────── property ─────────────────────────

export async function propertyFor(db: Exec, loc: Pick<Location, 'id' | 'organizationId'>): Promise<Property> {
  const [p] = await db.select().from(hospProperties).where(eq(hospProperties.locationId, loc.id));
  if (p) return p;
  await db.insert(hospProperties).values({ organizationId: loc.organizationId, locationId: loc.id }).onConflictDoNothing();
  const [created] = await db.select().from(hospProperties).where(eq(hospProperties.locationId, loc.id));
  return created!;
}

/** Today's date at the property. */
export const localToday = (loc: Pick<Location, 'timeZone'>, now = new Date()) => localDateParts(now, loc.timeZone).date;
export const arrivalInstant = (res: Pick<Reservation, 'arrival'>, prop: Pick<Property, 'checkInTime'>, loc: Pick<Location, 'timeZone'>) => zonedToUtc(res.arrival, prop.checkInTime, loc.timeZone);

// ───────────────────────── inventory ─────────────────────────

/** Sellable units per room type and night = active units (rooms, or beds for dorms) minus units blocked that night. */
export async function sellableUnits(db: Exec, roomTypeIds: string[], dates: string[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (!roomTypeIds.length || !dates.length) return out;
  const types = await db.select().from(hospRoomTypes).where(inArray(hospRoomTypes.id, roomTypeIds));
  const rooms = await db.select().from(hospRooms).where(and(inArray(hospRooms.roomTypeId, roomTypeIds), eq(hospRooms.active, true)));
  const roomIds = rooms.map((r) => r.id);
  const beds = roomIds.length ? await db.select({ roomId: hospBeds.roomId, n: sql<number>`count(*)::int` }).from(hospBeds).where(and(inArray(hospBeds.roomId, roomIds), eq(hospBeds.active, true))).groupBy(hospBeds.roomId) : [];
  const bedCount = new Map(beds.map((b) => [b.roomId, b.n]));
  const sorted = [...dates].sort();
  const blocks = roomIds.length
    ? await db.select().from(hospRoomBlocks).where(and(inArray(hospRoomBlocks.roomId, roomIds), eq(hospRoomBlocks.active, true), sql`${hospRoomBlocks.startDate} <= ${sorted[sorted.length - 1]!}`, sql`${hospRoomBlocks.endDate} > ${sorted[0]!}`))
    : [];
  for (const t of types) {
    const unitsOf = (r: Room) => (t.kind === 'dorm' ? bedCount.get(r.id) ?? 0 : 1);
    const mine = rooms.filter((r) => r.roomTypeId === t.id);
    const all = mine.reduce((a, r) => a + unitsOf(r), 0);
    const m = new Map<string, number>();
    for (const d of dates) {
      const blocked = mine.filter((r) => blocks.some((b) => b.roomId === r.id && b.startDate <= d && d < b.endDate)).reduce((a, r) => a + unitsOf(r), 0);
      m.set(d, Math.max(0, all - blocked));
    }
    out.set(t.id, m);
  }
  return out;
}

async function ensureInventory(tx: Exec, orgId: string, locationId: string, roomTypeIds: string[], dates: string[]) {
  const units = await sellableUnits(tx, roomTypeIds, dates);
  const values = roomTypeIds.flatMap((rt) => dates.map((d) => ({ organizationId: orgId, locationId, roomTypeId: rt, date: d, total: units.get(rt)?.get(d) ?? 0 })));
  if (values.length) await tx.insert(hospInventory).values(values).onConflictDoNothing();
}

export interface InventoryDelta { roomTypeId: string; date: string; delta: number }

/**
 * Applies inventory changes atomically. Rows are locked in a fixed order (room type, date) so concurrent bookings
 * never deadlock; increments are checked against `total` before any release is applied, and the CHECK constraint is
 * the final guard. Throws 409 sold_out (nothing changed) when any night is full.
 */
export async function adjustInventory(tx: Tx, orgId: string, locationId: string, deltas: InventoryDelta[]) {
  const net = new Map<string, InventoryDelta>();
  for (const d of deltas) {
    const k = `${d.roomTypeId}|${d.date}`;
    const cur = net.get(k);
    net.set(k, { ...d, delta: (cur?.delta ?? 0) + d.delta });
  }
  const items = [...net.values()].filter((d) => d.delta !== 0);
  if (!items.length) return;
  const typeIds = [...new Set(items.map((i) => i.roomTypeId))];
  const dates = [...new Set(items.map((i) => i.date))];
  await ensureInventory(tx, orgId, locationId, typeIds, dates);
  const rows = await tx.select().from(hospInventory).where(and(inArray(hospInventory.roomTypeId, typeIds), inArray(hospInventory.date, dates)))
    .orderBy(asc(hospInventory.roomTypeId), asc(hospInventory.date)).for('update');
  const byKey = new Map(rows.map((r) => [`${r.roomTypeId}|${r.date}`, r]));
  const full = items.filter((i) => i.delta > 0).filter((i) => { const r = byKey.get(`${i.roomTypeId}|${i.date}`)!; return r.sold + i.delta > r.total; });
  if (full.length) throw conflict('sold_out', 'Sorry — those dates just sold out for this room type. Please choose other dates or rooms.', { nights: full.map((f) => ({ roomTypeId: f.roomTypeId, date: f.date })) });
  // Secure new nights first, then release old ones.
  for (const i of [...items.filter((x) => x.delta > 0), ...items.filter((x) => x.delta < 0)]) {
    await tx.update(hospInventory).set({ sold: sql`greatest(${hospInventory.sold} + ${i.delta}, 0)`, updatedAt: new Date() })
      .where(and(eq(hospInventory.roomTypeId, i.roomTypeId), eq(hospInventory.date, i.date)));
  }
}

/** Re-derives `total` for existing future inventory rows of a room type (after rooms/beds/blocks change). */
export async function recomputeInventory(tx: Tx, roomTypeId: string, fromDate: string) {
  const rows = await tx.select().from(hospInventory).where(and(eq(hospInventory.roomTypeId, roomTypeId), gte(hospInventory.date, fromDate))).orderBy(asc(hospInventory.date)).for('update');
  if (!rows.length) return;
  const units = (await sellableUnits(tx, [roomTypeId], rows.map((r) => r.date))).get(roomTypeId)!;
  const short = rows.filter((r) => (units.get(r.date) ?? 0) < r.sold);
  if (short.length) throw conflict('would_overbook', 'This change would leave more stays than rooms on some nights. Move or cancel those stays first.', { nights: short.map((r) => r.date) });
  for (const r of rows) {
    const total = units.get(r.date) ?? 0;
    if (total !== r.total) await tx.update(hospInventory).set({ total, updatedAt: new Date() }).where(eq(hospInventory.id, r.id));
  }
}

/** Units available per room type and night (total − sold), computing totals for nights without a row yet. */
export async function availabilityMatrix(db: Exec, roomTypeIds: string[], dates: string[]) {
  const out = new Map<string, Map<string, { total: number; sold: number; available: number }>>();
  if (!roomTypeIds.length || !dates.length) return out;
  const rows = await db.select().from(hospInventory).where(and(inArray(hospInventory.roomTypeId, roomTypeIds), inArray(hospInventory.date, dates)));
  const missing = roomTypeIds.some((rt) => dates.some((d) => !rows.find((r) => r.roomTypeId === rt && r.date === d)));
  const units = missing ? await sellableUnits(db, roomTypeIds, dates) : new Map();
  for (const rt of roomTypeIds) {
    const m = new Map<string, { total: number; sold: number; available: number }>();
    for (const d of dates) {
      const r = rows.find((x) => x.roomTypeId === rt && x.date === d);
      const total = r ? r.total : units.get(rt)?.get(d) ?? 0;
      const sold = r?.sold ?? 0;
      m.set(d, { total, sold, available: Math.max(0, total - sold) });
    }
    out.set(rt, m);
  }
  return out;
}

// ───────────────────────── rates ─────────────────────────

export async function rateContext(db: Exec, locationId: string) {
  const [roomTypes, plans, seasons, taxes, policies] = await Promise.all([
    db.select().from(hospRoomTypes).where(eq(hospRoomTypes.locationId, locationId)).orderBy(asc(hospRoomTypes.sortOrder), asc(hospRoomTypes.name)),
    db.select().from(hospRatePlans).where(eq(hospRatePlans.locationId, locationId)).orderBy(asc(hospRatePlans.sortOrder), asc(hospRatePlans.name)),
    db.select().from(hospSeasons).where(eq(hospSeasons.locationId, locationId)).orderBy(asc(hospSeasons.startDate)),
    db.select().from(hospTaxes).where(and(eq(hospTaxes.locationId, locationId), eq(hospTaxes.active, true))),
    db.select().from(hospCancellationPolicies).where(eq(hospCancellationPolicies.locationId, locationId)),
  ]);
  const prices = plans.length ? await db.select().from(hospRatePrices).where(inArray(hospRatePrices.ratePlanId, plans.map((p) => p.id))) : [];
  return { roomTypes, plans, seasons, taxes, policies, prices };
}
export type RateContext = Awaited<ReturnType<typeof rateContext>>;

export async function dailyRowsFor(db: Exec, planIds: string[], fromDate: string, toDate: string) {
  if (!planIds.length) return [];
  return db.select().from(hospDailyRates).where(and(inArray(hospDailyRates.ratePlanId, planIds), gte(hospDailyRates.date, fromDate), sql`${hospDailyRates.date} <= ${toDate}`));
}

export function policyOf(ctx: RateContext, plan: RatePlan): CancellationPolicy {
  const p = ctx.policies.find((x) => x.id === plan.cancellationPolicyId);
  if (p) return { name: p.name, nonRefundable: p.nonRefundable, freeUntilHours: p.freeUntilHours, lateFee: p.lateFee, noShowFee: p.noShowFee };
  // A plan without a policy row: non-refundable plans keep everything; otherwise the full stay is due once cancelled.
  return { name: plan.kind === 'non_refundable' ? 'Non-refundable' : 'Property terms', nonRefundable: plan.kind === 'non_refundable', freeUntilHours: null, lateFee: { type: 'full' }, noShowFee: { type: 'full' } };
}

export interface RoomRequest { roomTypeId: string; ratePlanId: string; adults: number; children: number }

export function quoteRoom(ctx: RateContext, daily: Array<typeof hospDailyRates.$inferSelect>, r: RoomRequest & { arrival: string; departure: string }): StayQuote & { plan?: RatePlan; roomType?: RoomType } {
  const roomType = ctx.roomTypes.find((t) => t.id === r.roomTypeId);
  const plan = ctx.plans.find((p) => p.id === r.ratePlanId);
  if (!roomType || !plan) return { ok: false, reason: 'no_price' };
  const pricingPlanId = plan.derivedFromId ?? plan.id;
  const toDaily = (x: typeof hospDailyRates.$inferSelect): DailyRow => ({ date: x.date, amountMinor: x.amountMinor, minStay: x.minStay, maxStay: x.maxStay, closed: x.closed, closedToArrival: x.closedToArrival, closedToDeparture: x.closedToDeparture });
  const dorm = roomType.kind === 'dorm';
  const q = quoteStay({
    arrival: r.arrival, departure: r.departure, adults: r.adults, children: r.children,
    baseOccupancy: dorm ? 1 : roomType.baseOccupancy, maxOccupancy: dorm ? 1 : roomType.maxOccupancy, maxAdults: dorm ? 1 : roomType.maxAdults,
    plan: { minStay: plan.minStay, maxStay: plan.maxStay, adjustmentBps: plan.derivedFromId ? plan.adjustmentBps : null, deposit: { rule: plan.depositRule as 'none', percentBps: plan.depositPercentBps } },
    prices: ctx.prices.filter((p) => p.ratePlanId === pricingPlanId && p.roomTypeId === roomType.id).map((p) => ({ seasonId: p.seasonId, amountMinor: p.amountMinor, weekdayAmounts: p.weekdayAmounts, extraAdultMinor: p.extraAdultMinor, extraChildMinor: p.extraChildMinor })),
    seasons: ctx.seasons.map((s) => ({ id: s.id, name: s.name, startDate: s.startDate, endDate: s.endDate, minStay: s.minStay, maxStay: s.maxStay, priority: s.priority })),
    dailyPrices: daily.filter((d) => d.ratePlanId === pricingPlanId && d.roomTypeId === roomType.id).map(toDaily),
    restrictions: daily.filter((d) => d.ratePlanId === plan.id && d.roomTypeId === roomType.id).map(toDaily),
    taxes: ctx.taxes.map((t) => ({ id: t.id, name: t.name, kind: t.kind as 'percent', rateBps: t.rateBps, amountMinor: t.amountMinor, inclusive: t.inclusive, maxNights: t.maxNights, appliesToChildren: t.appliesToChildren })),
  });
  return { ...q, plan, roomType };
}

const QUOTE_MESSAGES: Record<string, string> = {
  invalid_dates: 'Choose a check-out date after the check-in date',
  too_many_guests: 'Too many guests for this room',
  no_price: 'This room is not available on this rate for those dates',
  closed: 'This rate is closed on one of those nights',
  closed_to_arrival: 'Arrivals are not possible on this date for this rate',
  closed_to_departure: 'Departures are not possible on this date for this rate',
  min_stay: 'This rate needs a longer stay',
  max_stay: 'This rate allows a shorter stay only',
};
export const quoteMessage = (reason: string) => QUOTE_MESSAGES[reason] ?? 'Not available';

/** Availability for a stay: per room type the free units and each rate plan's quote (or why it is not available). */
export async function searchAvailability(db: Exec, loc: Location, q: { arrival: string; departure: string; adults: number; children: number; rooms: number; online: boolean }) {
  const nights = stayNights(q.arrival, q.departure);
  if (!nights.length) throw validationError('Choose a check-out date after the check-in date', { departure: 'After check-in' });
  if (nights.length > 60) throw validationError('Stays are limited to 60 nights online', { departure: 'Too long' });
  const ctx = await rateContext(db, loc.id);
  const types = ctx.roomTypes.filter((t) => t.active && (!q.online || t.bookableOnline));
  const plans = ctx.plans.filter((p) => p.active && (!q.online || p.bookableOnline));
  const daily = await dailyRowsFor(db, ctx.plans.map((p) => p.id), q.arrival, q.departure);
  const avail = await availabilityMatrix(db, types.map((t) => t.id), nights);
  const perRoomAdults = Math.ceil(q.adults / q.rooms);
  const perRoomChildren = Math.ceil(q.children / q.rooms);
  return types.map((t) => {
    const m = avail.get(t.id)!;
    const available = Math.min(...nights.map((d) => m.get(d)!.available));
    const dorm = t.kind === 'dorm';
    const unitsNeeded = dorm ? q.adults + q.children : q.rooms;
    const rates = plans.map((p) => {
      const quote = quoteRoom(ctx, daily, { roomTypeId: t.id, ratePlanId: p.id, arrival: q.arrival, departure: q.departure, adults: dorm ? 1 : perRoomAdults, children: dorm ? 0 : perRoomChildren });
      const policy = policyOf(ctx, p);
      const base = { ratePlanId: p.id, code: p.code, name: p.name, kind: p.kind, includesBreakfast: p.includesBreakfast, inclusions: p.inclusions, description: p.description, policy, depositRule: p.depositRule };
      if (!quote.ok) return { ...base, ok: false as const, reason: quote.reason, message: quoteMessage(quote.reason), detail: quote.detail ?? null };
      return {
        ...base, ok: true as const, nights: quote.nights, perUnit: { room: quote.roomTotalMinor, taxAdded: quote.taxAddedMinor, total: quote.totalMinor, deposit: quote.depositMinor }, taxes: quote.taxes,
        total: { amount: quote.totalMinor * unitsNeeded, currency: loc.currency }, deposit: { amount: quote.depositMinor * unitsNeeded, currency: loc.currency },
      };
    });
    return {
      roomTypeId: t.id, code: t.code, name: t.name, kind: t.kind, description: t.description, beds: t.beds, baseOccupancy: t.baseOccupancy, maxOccupancy: t.maxOccupancy, sizeSqm: t.sizeSqm,
      amenities: t.amenities, photos: t.photos, available, unitsNeeded, bookable: available >= unitsNeeded && rates.some((r) => r.ok), rates,
    };
  });
}

// ───────────────────────── reservations ─────────────────────────

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = (loc: Pick<Location, 'code'>) => `${loc.code}-${Array.from({ length: 5 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('')}`;
const event = (action: string, by: string | null, note?: string) => ({ at: new Date().toISOString(), by, action, ...(note ? { note } : {}) });

export interface CreateReservationInput {
  arrival: string;
  departure: string;
  rooms: RoomRequest[];
  guest: { name: string; email: string; phone?: string | null };
  groupName?: string | null;
  arrivalTime?: string | null;
  specialRequests?: string | null;
  consent?: { email?: boolean; sms?: boolean };
  source: string;
  expectedTotalMinor?: number;
}

export async function loadPricedRooms(db: Exec, loc: Location, input: { arrival: string; departure: string; rooms: RoomRequest[] }, opts: { online: boolean }) {
  if (!input.rooms.length) throw validationError('Choose at least one room', { rooms: 'Required' });
  const ctx = await rateContext(db, loc.id);
  const daily = await dailyRowsFor(db, ctx.plans.map((p) => p.id), input.arrival, input.departure);
  const priced = input.rooms.map((r, idx) => {
    const q = quoteRoom(ctx, daily, { ...r, arrival: input.arrival, departure: input.departure });
    if (!q.plan || !q.roomType || !q.plan.active || !q.roomType.active || (opts.online && (!q.plan.bookableOnline || !q.roomType.bookableOnline))) throw validationError('That room or rate is not available', { [`rooms.${idx}`]: 'Not available' });
    if (!q.ok) throw new AppError(409, `rate_${q.reason}`, quoteMessage(q.reason), { [`rooms.${idx}`]: quoteMessage(q.reason) }, q.detail ?? undefined);
    return { req: r, quote: q, plan: q.plan, roomType: q.roomType, policy: policyOf(ctx, q.plan) };
  });
  return { ctx, priced };
}

/** Strictest policy across rooms (non-refundable wins, then the longest free window). */
function combinedPolicy(policies: CancellationPolicy[]): CancellationPolicy {
  const nr = policies.find((p) => p.nonRefundable);
  if (nr) return nr;
  return [...policies].sort((a, b) => (b.freeUntilHours ?? 1e9) - (a.freeUntilHours ?? 1e9))[0]!;
}

export async function createReservation(s: Services, loc: Location, input: CreateReservationInput, opts: { actorUserId: string | null; staff: boolean; ip?: string }) {
  if (loc.status !== 'operating' && !opts.staff) throw conflict('property_not_accepting_bookings', 'This property is not taking bookings right now');
  const prop = await propertyFor(s.db, loc);
  if (!opts.staff && input.arrival < localToday(loc)) throw validationError('Check-in cannot be in the past', { arrival: 'In the past' });
  const { priced } = await loadPricedRooms(s.db, loc, input, { online: !opts.staff });
  const roomTotal = priced.reduce((a, p) => a + (p.quote.ok ? p.quote.roomTotalMinor : 0), 0);
  const taxAdded = priced.reduce((a, p) => a + (p.quote.ok ? p.quote.taxAddedMinor : 0), 0);
  const total = roomTotal + taxAdded;
  const deposit = priced.reduce((a, p) => a + (p.quote.ok ? p.quote.depositMinor : 0), 0);
  if (input.expectedTotalMinor !== undefined && input.expectedTotalMinor !== total) throw new AppError(409, 'price_changed', 'Prices changed since you started. Please review your stay.', undefined, { totalMinor: total, currency: loc.currency });
  const needsPayment = !opts.staff && deposit > 0;
  if (needsPayment && !loc.paymentsEnabled) throw new AppError(409, 'payments_not_enabled', 'Online booking is not available at this property yet');
  const nights = stayNights(input.arrival, input.departure);
  const manageToken = randomToken();
  const adults = input.rooms.reduce((a, r) => a + r.adults, 0);
  const children = input.rooms.reduce((a, r) => a + r.children, 0);

  const res = await s.db.transaction(async (tx) => {
    await adjustInventory(tx, loc.organizationId, loc.id, priced.flatMap((p) => nights.map((d) => ({ roomTypeId: p.roomType.id, date: d, delta: 1 }))));
    const customer = await findOrCreateCustomer(tx, loc.organizationId, loc.id, { name: input.guest.name, email: input.guest.email, phone: input.guest.phone ?? undefined }, 'hospitality_booking');
    const consent = { email: !!input.consent?.email, sms: !!input.consent?.sms && !!input.guest.phone };
    if (input.consent) {
      const channels = (['email', 'sms'] as const).filter((c) => c === 'email' || !!input.guest.phone);
      await tx.insert(consentRecords).values(channels.map((c) => ({ organizationId: loc.organizationId, customerId: customer.id, email: input.guest.email, purpose: STAY_CONSENT[c], version: STAY_CONSENT.version, granted: consent[c], source: opts.staff ? 'front_desk' : 'booking', ip: opts.ip ?? null })));
    }
    let code = newCode(loc);
    for (let i = 0; i < 3; i += 1) {
      const [dup] = await tx.select({ id: hospReservations.id }).from(hospReservations).where(and(eq(hospReservations.organizationId, loc.organizationId), eq(hospReservations.code, code)));
      if (!dup) break;
      code = newCode(loc);
    }
    const status: ReservationStatus = needsPayment ? 'hold' : 'confirmed';
    const [r] = await tx.insert(hospReservations).values({
      organizationId: loc.organizationId, locationId: loc.id, code, status, source: input.source, arrival: input.arrival, departure: input.departure, adults, children,
      groupName: input.groupName ?? null, customerId: customer.id, guestName: input.guest.name, guestEmail: input.guest.email, guestPhone: input.guest.phone ?? null,
      arrivalTime: input.arrivalTime ?? null, specialRequests: input.specialRequests ?? null, currency: loc.currency, roomTotalMinor: roomTotal, taxAddedMinor: taxAdded, totalMinor: total,
      depositRequiredMinor: deposit, holdExpiresAt: needsPayment ? new Date(Date.now() + prop.holdMinutes * 60_000) : null, cancellationPolicy: combinedPolicy(priced.map((p) => p.policy)),
      messageConsent: consent, manageTokenHash: sha256(manageToken), createdBy: opts.actorUserId,
      timeline: [event(status === 'hold' ? 'held' : 'confirmed', opts.actorUserId, `${priced.length} room(s), ${nights.length} night(s)`)],
    }).returning();
    await tx.insert(hospReservationRooms).values(priced.map((p) => ({
      organizationId: loc.organizationId, reservationId: r!.id, roomTypeId: p.roomType.id, ratePlanId: p.plan.id, adults: p.req.adults, children: p.req.children,
      nights: p.quote.ok ? p.quote.nights : [], taxes: p.quote.ok ? p.quote.taxes : [], roomTotalMinor: p.quote.ok ? p.quote.roomTotalMinor : 0, taxAddedMinor: p.quote.ok ? p.quote.taxAddedMinor : 0, totalMinor: p.quote.ok ? p.quote.totalMinor : 0,
    })));
    await audit(tx, { organizationId: loc.organizationId, actorUserId: opts.actorUserId, action: 'hospitality.reservation.created', scopeKind: 'location', scopeId: loc.id, targetType: 'hosp_reservation', targetId: r!.id, metadata: { status, totalMinor: total, currency: loc.currency, rooms: priced.length, source: input.source } });
    return r!;
  });

  let payment: { id: string; clientSecret: string | null; sandbox: boolean } | null = null;
  if (needsPayment) {
    try {
      const p = await createPaymentForTarget(s, {
        organizationId: loc.organizationId, locationId: loc.id, amountMinor: deposit, currency: loc.currency, targetType: 'hosp_deposit', targetId: res.id,
        description: `Deposit ${res.code}`, recordSnapshot: { code: res.code, arrival: res.arrival, departure: res.departure, totalMinor: total },
      });
      await s.db.update(hospReservations).set({ paymentId: p.payment.id }).where(eq(hospReservations.id, res.id));
      payment = { id: p.payment.id, clientSecret: p.clientSecret, sandbox: p.sandbox };
    } catch (err) {
      await releaseReservation(s, res.id, 'cancelled', null, 'Deposit payment could not be started');
      throw err;
    }
  }
  return { reservation: { ...res, paymentId: payment?.id ?? null }, manageToken, payment };
}

export async function reservationRooms(db: Exec, reservationId: string) {
  return db.select().from(hospReservationRooms).where(eq(hospReservationRooms.reservationId, reservationId)).orderBy(asc(hospReservationRooms.createdAt), asc(hospReservationRooms.id));
}

const inventoryDeltas = (rooms: Array<Pick<ReservationRoom, 'roomTypeId' | 'nights'>>, sign: 1 | -1): InventoryDelta[] => rooms.flatMap((r) => r.nights.map((n) => ({ roomTypeId: r.roomTypeId, date: n.date, delta: sign })));

/** Moves a hold/confirmed reservation to a non-inventory status, releasing its nights and room assignments. */
async function releaseReservation(s: Services, reservationId: string, to: 'cancelled' | 'expired' | 'no_show', actorUserId: string | null, note?: string) {
  return s.db.transaction(async (tx) => {
    const [r] = await tx.select().from(hospReservations).where(eq(hospReservations.id, reservationId)).for('update');
    if (!r || !INVENTORY_STATUSES.includes(r.status as ReservationStatus)) return r ?? null;
    const rooms = await reservationRooms(tx, r.id);
    await adjustInventory(tx, r.organizationId, r.locationId, inventoryDeltas(rooms, -1));
    await deleteAssignments(tx, rooms.map((x) => x.id));
    const [u] = await tx.update(hospReservations).set({ status: to, updatedAt: new Date(), timeline: [...r.timeline, event(to, actorUserId, note)] }).where(eq(hospReservations.id, r.id)).returning();
    return u!;
  });
}

async function deleteAssignments(tx: Tx, reservationRoomIds: string[], keepDates?: Set<string>) {
  if (!reservationRoomIds.length) return;
  const rows = await tx.select().from(hospAssignments).where(inArray(hospAssignments.reservationRoomId, reservationRoomIds));
  const drop = rows.filter((a) => !keepDates || !keepDates.has(a.date)).map((a) => a.id);
  if (drop.length) await tx.delete(hospAssignments).where(inArray(hospAssignments.id, drop));
  if (!keepDates) await tx.update(hospReservationRooms).set({ roomId: null, bedId: null }).where(inArray(hospReservationRooms.id, reservationRoomIds));
}

/** Expire unpaid holds whose time ran out (inventory returns to sale). */
export async function expireHolds(s: Services, locationId?: string) {
  const rows = await s.db.select({ id: hospReservations.id }).from(hospReservations)
    .where(and(eq(hospReservations.status, 'hold'), lt(hospReservations.holdExpiresAt, new Date()), ...(locationId ? [eq(hospReservations.locationId, locationId)] : [])));
  for (const r of rows) await releaseReservation(s, r.id, 'expired', null, 'Deposit not paid in time');
  return rows.length;
}

// Deposit payments: confirm the hold (or re-secure inventory when the payment arrives after the hold expired).
paymentTargetExtensions.hosp_deposit = {
  async fulfil(tx: Tx, p: PaymentRow) {
    const [r] = await tx.select().from(hospReservations).where(eq(hospReservations.id, p.targetId!)).for('update');
    if (!r) return { fulfilled: false, note: 'Reservation missing' };
    if (r.paymentId && r.paymentId !== p.id && r.depositPaidMinor > 0) return { fulfilled: true, note: 'Deposit already paid by another payment — duplicate flagged for refund' };
    if (r.status === 'cancelled' || r.status === 'no_show') return { fulfilled: false, note: `Reservation is ${r.status}` };
    if (r.status === 'expired') {
      const rooms = await reservationRooms(tx, r.id);
      try {
        await tx.transaction(async (sp) => adjustInventory(sp, r.organizationId, r.locationId, inventoryDeltas(rooms, 1)));
      } catch {
        return { fulfilled: false, note: 'Deposit paid after the hold expired and the room sold out — needs recovery' };
      }
    }
    const confirmed = r.status === 'hold' || r.status === 'expired';
    await tx.update(hospReservations).set({
      status: confirmed ? 'confirmed' : r.status, depositPaidMinor: p.amountMinor, paymentId: p.id, holdExpiresAt: null, updatedAt: new Date(),
      timeline: [...r.timeline, event('deposit_paid', null, `${p.amountMinor} ${p.currency}`), ...(confirmed ? [event('confirmed', null)] : [])],
    }).where(eq(hospReservations.id, r.id));
    await tx.insert(hospFolioLines).values({ organizationId: r.organizationId, locationId: r.locationId, reservationId: r.id, kind: 'payment', description: 'Deposit (card, online)', amountMinor: -p.amountMinor, currency: p.currency, method: 'card_online', sourceType: 'payment', sourceId: p.id }).onConflictDoNothing();
    return { fulfilled: true, note: confirmed ? 'Reservation confirmed' : 'Deposit recorded' };
  },
  async isRecorded(db: Exec, p: PaymentRow) {
    const [r] = await db.select().from(hospReservations).where(eq(hospReservations.id, p.targetId!));
    if (!r) return { ok: false, expected: null };
    return { ok: ['confirmed', 'checked_in', 'checked_out'].includes(r.status) && r.depositPaidMinor >= r.depositRequiredMinor && r.paymentId === p.id, expected: { amount: r.depositRequiredMinor, currency: r.currency } };
  },
};

// ───────────────────────── modify ─────────────────────────

export async function modifyReservation(s: Services, loc: Location, reservationId: string, input: { arrival: string; departure: string; expectedTotalMinor?: number; rooms?: Array<{ id: string; adults?: number; children?: number; roomTypeId?: string; ratePlanId?: string }> }, opts: { actorUserId: string | null; staff: boolean }) {
  const [current] = await s.db.select().from(hospReservations).where(eq(hospReservations.id, reservationId));
  if (!current) throw notFound('Reservation');
  if (!['hold', 'confirmed'].includes(current.status)) throw conflict('not_modifiable', `A ${current.status.replace('_', ' ')} reservation cannot be changed`);
  if (!opts.staff && input.arrival < localToday(loc)) throw validationError('Check-in cannot be in the past', { arrival: 'In the past' });
  const oldRooms = await reservationRooms(s.db, current.id);
  const requests = oldRooms.map((r) => {
    const ch = input.rooms?.find((x) => x.id === r.id);
    if (ch && !opts.staff && (ch.roomTypeId || ch.ratePlanId)) throw validationError('Contact the property to change the room or rate', { rooms: 'Not allowed online' });
    return { id: r.id, roomTypeId: ch?.roomTypeId ?? r.roomTypeId, ratePlanId: ch?.ratePlanId ?? r.ratePlanId, adults: ch?.adults ?? r.adults, children: ch?.children ?? r.children };
  });
  const { priced } = await loadPricedRooms(s.db, loc, { arrival: input.arrival, departure: input.departure, rooms: requests }, { online: !opts.staff });
  const roomTotal = priced.reduce((a, p) => a + (p.quote.ok ? p.quote.roomTotalMinor : 0), 0);
  const taxAdded = priced.reduce((a, p) => a + (p.quote.ok ? p.quote.taxAddedMinor : 0), 0);
  const total = roomTotal + taxAdded;
  if (input.expectedTotalMinor !== undefined && input.expectedTotalMinor !== total) throw new AppError(409, 'price_changed', 'The price for the new dates changed. Please review.', undefined, { totalMinor: total, currency: loc.currency });
  const nights = stayNights(input.arrival, input.departure);
  const warnings: string[] = [];

  const updated = await s.db.transaction(async (tx) => {
    const [r] = await tx.select().from(hospReservations).where(eq(hospReservations.id, reservationId)).for('update');
    if (!r || !['hold', 'confirmed'].includes(r.status)) throw conflict('not_modifiable', 'This reservation can no longer be changed');
    const locked = await reservationRooms(tx, r.id);
    // New nights first (+1), old nights released (−1) only after every new night is secured; overlap nets to zero.
    const newDeltas = priced.flatMap((p) => nights.map((d) => ({ roomTypeId: p.roomType.id, date: d, delta: 1 })));
    await adjustInventory(tx, r.organizationId, r.locationId, [...newDeltas, ...inventoryDeltas(locked, -1)]);
    for (const [i, p] of priced.entries()) {
      const rr = locked.find((x) => x.id === requests[i]!.id)!;
      const typeChanged = rr.roomTypeId !== p.roomType.id;
      if (typeChanged) await deleteAssignments(tx, [rr.id]);
      else if (rr.roomId) {
        await deleteAssignments(tx, [rr.id], new Set(nights));
        const have = new Set((await tx.select({ d: hospAssignments.date }).from(hospAssignments).where(eq(hospAssignments.reservationRoomId, rr.id))).map((a) => a.d));
        const add = nights.filter((d) => !have.has(d));
        try {
          if (add.length) await tx.transaction(async (sp) => { await sp.insert(hospAssignments).values(add.map((d) => ({ organizationId: r.organizationId, locationId: r.locationId, reservationRoomId: rr.id, roomId: rr.roomId!, bedId: rr.bedId, date: d }))); });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          await deleteAssignments(tx, [rr.id]);
          warnings.push(`room_unassigned:${rr.id}`);
        }
      }
      await tx.update(hospReservationRooms).set({
        roomTypeId: p.roomType.id, ratePlanId: p.plan.id, adults: p.req.adults, children: p.req.children,
        nights: p.quote.ok ? p.quote.nights : [], taxes: p.quote.ok ? p.quote.taxes : [], roomTotalMinor: p.quote.ok ? p.quote.roomTotalMinor : 0, taxAddedMinor: p.quote.ok ? p.quote.taxAddedMinor : 0, totalMinor: p.quote.ok ? p.quote.totalMinor : 0,
      }).where(eq(hospReservationRooms.id, rr.id));
    }
    const [u] = await tx.update(hospReservations).set({
      arrival: input.arrival, departure: input.departure, roomTotalMinor: roomTotal, taxAddedMinor: taxAdded, totalMinor: total,
      adults: requests.reduce((a, x) => a + x.adults, 0), children: requests.reduce((a, x) => a + x.children, 0), updatedAt: new Date(),
      timeline: [...r.timeline, event('modified', opts.actorUserId, `${r.arrival}→${r.departure} became ${input.arrival}→${input.departure}`)],
    }).where(eq(hospReservations.id, r.id)).returning();
    await audit(tx, { organizationId: r.organizationId, actorUserId: opts.actorUserId, action: 'hospitality.reservation.modified', scopeKind: 'location', scopeId: r.locationId, targetType: 'hosp_reservation', targetId: r.id, metadata: { from: { arrival: r.arrival, departure: r.departure, totalMinor: r.totalMinor }, to: { arrival: input.arrival, departure: input.departure, totalMinor: total } } });
    return u!;
  });
  return { reservation: updated, priceDifference: { amount: total - current.totalMinor, currency: current.currency }, warnings };
}

// ───────────────────────── cancel / no-show ─────────────────────────

export async function cancellationQuote(db: Exec, loc: Location, r: Reservation, now = new Date()) {
  const prop = await propertyFor(db, loc);
  const rooms = await reservationRooms(db, r.id);
  const firstNight = rooms.reduce((a, x) => a + (x.nights[0]?.amountMinor ?? 0), 0);
  const fee = r.status === 'hold' ? { feeMinor: 0, free: true, freeUntil: null, reason: 'free_window' as const } : cancellationFee(r.cancellationPolicy, { now, arrivalAt: arrivalInstant(r, prop, loc), firstNightMinor: firstNight, totalMinor: r.totalMinor });
  const refund = Math.max(0, r.depositPaidMinor - fee.feeMinor);
  const outstanding = Math.max(0, fee.feeMinor - r.depositPaidMinor);
  const m = (amount: number) => ({ amount, currency: r.currency });
  return { fee: m(fee.feeMinor), free: fee.free, freeUntil: fee.freeUntil, reason: fee.reason, depositPaid: m(r.depositPaidMinor), refund: m(refund), outstanding: m(outstanding), policy: r.cancellationPolicy };
}

async function settleFee(s: Services, r: Reservation, kind: 'cancellation' | 'no_show', feeMinor: number, actorUserId: string | null) {
  if (feeMinor > 0) {
    await s.db.insert(hospFolioLines).values({ organizationId: r.organizationId, locationId: r.locationId, reservationId: r.id, kind: 'fee', description: kind === 'no_show' ? 'No-show fee' : 'Cancellation fee', amountMinor: feeMinor, currency: r.currency, sourceType: kind, sourceId: r.id, createdBy: actorUserId }).onConflictDoNothing();
  }
  const refund = Math.max(0, r.depositPaidMinor - feeMinor);
  let refundState: string | null = null;
  if (refund > 0 && r.paymentId) {
    const out = await refundPayment(s, r.paymentId, refund, { actorUserId, reason: `${kind === 'no_show' ? 'No-show' : 'Cancellation'} ${r.code}` });
    refundState = out.refund.state;
    if (out.refund.state !== 'failed') {
      await s.db.insert(hospFolioLines).values({ organizationId: r.organizationId, locationId: r.locationId, reservationId: r.id, kind: 'refund', description: 'Deposit refund (card)', amountMinor: refund, currency: r.currency, method: 'card_online', sourceType: 'refund', sourceId: out.refund.id, createdBy: actorUserId }).onConflictDoNothing();
    }
  }
  return { refund: { amount: refund, currency: r.currency }, refundState };
}

export async function cancelReservation(s: Services, loc: Location, reservationId: string, opts: { actorUserId: string | null; reason?: string | null; waiveFee?: boolean }) {
  const [r] = await s.db.select().from(hospReservations).where(eq(hospReservations.id, reservationId));
  if (!r) throw notFound('Reservation');
  if (!['hold', 'confirmed'].includes(r.status)) throw conflict('not_cancellable', `A ${r.status.replace('_', ' ')} reservation cannot be cancelled`);
  const quote = await cancellationQuote(s.db, loc, r);
  const fee = opts.waiveFee ? 0 : quote.fee.amount;
  const released = await releaseReservation(s, r.id, 'cancelled', opts.actorUserId, opts.reason ?? undefined);
  if (!released || released.status !== 'cancelled') throw conflict('not_cancellable', 'This reservation can no longer be cancelled');
  const [u] = await s.db.update(hospReservations).set({ cancelledAt: new Date(), cancellationFeeMinor: fee, cancelReason: opts.reason ?? null }).where(eq(hospReservations.id, r.id)).returning();
  await audit(s.db, { organizationId: r.organizationId, actorUserId: opts.actorUserId, action: 'hospitality.reservation.cancelled', scopeKind: 'location', scopeId: r.locationId, targetType: 'hosp_reservation', targetId: r.id, metadata: { feeMinor: fee, waived: !!opts.waiveFee, currency: r.currency } });
  if (r.status === 'hold') {
    await reverseTargetPayment(s, r.paymentId, opts.actorUserId, 'Hold cancelled');
    return { reservation: u!, fee: { amount: 0, currency: r.currency }, refund: { amount: 0, currency: r.currency }, refundState: null };
  }
  const settled = await settleFee(s, u!, 'cancellation', fee, opts.actorUserId);
  return { reservation: u!, fee: { amount: fee, currency: r.currency }, ...settled };
}

export async function markNoShow(s: Services, loc: Location, reservationId: string, opts: { actorUserId: string | null; waiveFee?: boolean }) {
  const [r] = await s.db.select().from(hospReservations).where(eq(hospReservations.id, reservationId));
  if (!r) throw notFound('Reservation');
  if (!reservationTransitionAllowed(r.status as ReservationStatus, 'no_show')) throw conflict('invalid_transition', `A ${r.status.replace('_', ' ')} reservation cannot be marked as a no-show`);
  if (localToday(loc) < r.arrival) throw conflict('not_yet_arrival', 'A no-show can only be recorded from the arrival date');
  const rooms = await reservationRooms(s.db, r.id);
  const fee = opts.waiveFee ? 0 : noShowFee(r.cancellationPolicy, { firstNightMinor: rooms.reduce((a, x) => a + (x.nights[0]?.amountMinor ?? 0), 0), totalMinor: r.totalMinor });
  await releaseReservation(s, r.id, 'no_show', opts.actorUserId);
  const [u] = await s.db.update(hospReservations).set({ noShowAt: new Date(), cancellationFeeMinor: fee }).where(eq(hospReservations.id, r.id)).returning();
  await audit(s.db, { organizationId: r.organizationId, actorUserId: opts.actorUserId, action: 'hospitality.reservation.no_show', scopeKind: 'location', scopeId: r.locationId, targetType: 'hosp_reservation', targetId: r.id, metadata: { feeMinor: fee } });
  const settled = await settleFee(s, u!, 'no_show', fee, opts.actorUserId);
  return { reservation: u!, fee: { amount: fee, currency: r.currency }, ...settled };
}

// ───────────────────────── assignment ─────────────────────────

export async function assignRoom(s: Services, orgId: string, reservationRoomId: string, input: { roomId: string; bedId?: string | null }, actorUserId: string | null) {
  return s.db.transaction(async (tx) => {
    const [rr] = await tx.select().from(hospReservationRooms).where(and(eq(hospReservationRooms.id, reservationRoomId), eq(hospReservationRooms.organizationId, orgId))).for('update');
    if (!rr) throw notFound('Reservation room');
    const [r] = await tx.select().from(hospReservations).where(eq(hospReservations.id, rr.reservationId)).for('update');
    if (!r || !['confirmed', 'checked_in'].includes(r.status)) throw conflict('not_assignable', 'Only confirmed or in-house stays can be given a room');
    const [room] = await tx.select().from(hospRooms).where(and(eq(hospRooms.id, input.roomId), eq(hospRooms.locationId, r.locationId), eq(hospRooms.active, true)));
    if (!room) throw validationError('Unknown room', { roomId: 'Not a room at this property' });
    if (room.roomTypeId !== rr.roomTypeId) throw conflict('room_type_mismatch', 'Choose a room of the booked room type (change the room type on the reservation first)');
    const [type] = await tx.select().from(hospRoomTypes).where(eq(hospRoomTypes.id, room.roomTypeId));
    let bedId: string | null = null;
    if (type!.kind === 'dorm') {
      if (!input.bedId) throw validationError('Choose a bed', { bedId: 'Required for dorms' });
      const [bed] = await tx.select().from(hospBeds).where(and(eq(hospBeds.id, input.bedId), eq(hospBeds.roomId, room.id), eq(hospBeds.active, true)));
      if (!bed) throw validationError('Unknown bed', { bedId: 'Not a bed in this room' });
      bedId = bed.id;
    }
    const nights = rr.nights.map((n) => n.date);
    const today = localToday((await tx.select().from(locations).where(eq(locations.id, r.locationId)))[0]!);
    const futureNights = r.status === 'checked_in' ? nights.filter((d) => d >= today) : nights;
    const blocks = await tx.select().from(hospRoomBlocks).where(and(eq(hospRoomBlocks.roomId, room.id), eq(hospRoomBlocks.active, true)));
    const blocked = futureNights.find((d) => blocks.some((b) => b.startDate <= d && d < b.endDate));
    if (blocked) throw conflict('room_out_of_order', `Room ${room.number} is out of order on ${blocked}`);
    const existing = await tx.select().from(hospAssignments).where(eq(hospAssignments.reservationRoomId, rr.id));
    const keep = r.status === 'checked_in' ? new Set(existing.filter((a) => a.date < today).map((a) => a.date)) : new Set<string>();
    const drop = existing.filter((a) => !keep.has(a.date)).map((a) => a.id);
    if (drop.length) await tx.delete(hospAssignments).where(inArray(hospAssignments.id, drop));
    try {
      await tx.transaction(async (sp) => {
        const add = futureNights.filter((d) => !keep.has(d));
        if (add.length) await sp.insert(hospAssignments).values(add.map((d) => ({ organizationId: orgId, locationId: r.locationId, reservationRoomId: rr.id, roomId: room.id, bedId, date: d })));
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('room_taken', `${type!.kind === 'dorm' ? 'That bed' : `Room ${room.number}`} is already given to another stay on some of these nights`);
      throw err;
    }
    await tx.update(hospReservationRooms).set({ roomId: room.id, bedId }).where(eq(hospReservationRooms.id, rr.id));
    await tx.update(hospReservations).set({ timeline: [...r.timeline, event('room_assigned', actorUserId, room.number)], updatedAt: new Date() }).where(eq(hospReservations.id, r.id));
    await audit(tx, { organizationId: orgId, actorUserId, action: 'hospitality.room.assigned', scopeKind: 'location', scopeId: r.locationId, targetType: 'hosp_reservation_room', targetId: rr.id, metadata: { roomId: room.id, bedId } });
    return { reservationRoomId: rr.id, roomId: room.id, roomNumber: room.number, bedId };
  });
}

// ───────────────────────── registration ─────────────────────────

/** Accepts only the fields the property configured; required fields must be present. */
export function cleanRegistration(prop: Property, input: Record<string, string>, opts: { requireAll: boolean }) {
  const allowed = new Map(prop.registrationFields.map((f) => [f.key, f]));
  const fields: Record<string, string> = {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!allowed.has(k)) fields[k] = 'Not requested by this property';
    else if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 200);
  }
  if (opts.requireAll) for (const f of prop.registrationFields) if (f.required && !out[f.key]) fields[f.key] = 'Required';
  if (Object.keys(fields).length) throw validationError('Check the registration details', fields);
  return out;
}

// ───────────────────────── check-in / check-out ─────────────────────────

export async function checkIn(s: Services, loc: Location, reservationId: string, input: { registration?: Record<string, string> }, opts: { actorUserId: string | null }) {
  const prop = await propertyFor(s.db, loc);
  return s.db.transaction(async (tx) => {
    const [r] = await tx.select().from(hospReservations).where(eq(hospReservations.id, reservationId)).for('update');
    if (!r) throw notFound('Reservation');
    if (!reservationTransitionAllowed(r.status as ReservationStatus, 'checked_in')) throw conflict('invalid_transition', `A ${r.status.replace('_', ' ')} reservation cannot be checked in`);
    const today = localToday(loc);
    if (today < r.arrival || today >= r.departure) throw conflict('not_arrival_day', `Check-in is possible from ${r.arrival} (today is ${today} at the property)`);
    const registration = cleanRegistration(prop, { ...(r.registration ?? {}), ...(input.registration ?? {}) }, { requireAll: true });
    const rooms = await reservationRooms(tx, r.id);
    const unassigned = rooms.filter((x) => !x.roomId);
    if (unassigned.length) throw conflict('room_not_assigned', 'Assign a room to every guest room before check-in', { reservationRoomIds: unassigned.map((x) => x.id) });
    const roomRows = await tx.select().from(hospRooms).where(inArray(hospRooms.id, rooms.map((x) => x.roomId!)));
    const notReady = roomRows.filter((x) => !roomReadyForArrival(x.hkStatus as HkStatus, prop.requireInspected));
    if (notReady.length) throw conflict('room_not_ready', `Room ${notReady.map((x) => x.number).join(', ')} is not ${prop.requireInspected ? 'inspected' : 'clean'} yet`, { rooms: notReady.map((x) => ({ id: x.id, number: x.number, status: x.hkStatus })) });
    const lines = rooms.flatMap((rr) => {
      const number = roomRows.find((x) => x.id === rr.roomId)?.number ?? '';
      return [
        ...rr.nights.map((n) => ({ organizationId: r.organizationId, locationId: r.locationId, reservationId: r.id, kind: 'room', description: `Room ${number} — night of ${n.date}`, serviceDate: n.date, amountMinor: n.amountMinor, currency: r.currency, sourceType: 'room_night', sourceId: `${rr.id}:${n.date}`, createdBy: opts.actorUserId })),
        ...rr.taxes.filter((t) => !t.inclusive && t.amountMinor > 0).map((t, i) => ({ organizationId: r.organizationId, locationId: r.locationId, reservationId: r.id, kind: 'tax', description: `${t.name} — room ${number}`, serviceDate: r.arrival, amountMinor: t.amountMinor, currency: r.currency, sourceType: 'room_tax', sourceId: `${rr.id}:${i}`, createdBy: opts.actorUserId })),
      ];
    });
    if (lines.length) await tx.insert(hospFolioLines).values(lines).onConflictDoNothing();
    const [u] = await tx.update(hospReservations).set({ status: 'checked_in', checkedInAt: new Date(), registration: Object.keys(registration).length ? registration : r.registration, updatedAt: new Date(), timeline: [...r.timeline, event('checked_in', opts.actorUserId)] }).where(eq(hospReservations.id, r.id)).returning();
    await audit(tx, { organizationId: r.organizationId, actorUserId: opts.actorUserId, action: 'hospitality.reservation.checked_in', scopeKind: 'location', scopeId: r.locationId, targetType: 'hosp_reservation', targetId: r.id });
    return u!;
  });
}

export async function folioBalance(db: Exec, reservationId: string) {
  const [row] = await db.select({ b: sql<string>`coalesce(sum(${hospFolioLines.amountMinor}), 0)` }).from(hospFolioLines).where(eq(hospFolioLines.reservationId, reservationId));
  return Number(row?.b ?? 0);
}

export async function checkOut(s: Services, loc: Location, reservationId: string, opts: { actorUserId: string | null }) {
  return s.db.transaction(async (tx) => {
    const [r] = await tx.select().from(hospReservations).where(eq(hospReservations.id, reservationId)).for('update');
    if (!r) throw notFound('Reservation');
    if (r.status !== 'checked_in') throw conflict('invalid_transition', `A ${r.status.replace('_', ' ')} reservation cannot be checked out`);
    const balance = await folioBalance(tx, r.id);
    if (balance !== 0) throw conflict('balance_due', balance > 0 ? 'Settle the folio before check-out' : 'The folio is in credit — refund the guest before check-out', { balanceMinor: balance, currency: r.currency });
    const rooms = await reservationRooms(tx, r.id);
    const today = localToday(loc);
    // Early departure: release the nights not stayed.
    const unused = rooms.flatMap((rr) => rr.nights.filter((n) => n.date >= today).map((n) => ({ roomTypeId: rr.roomTypeId, date: n.date, delta: -1 })));
    if (unused.length && today < r.departure) {
      await adjustInventory(tx, r.organizationId, r.locationId, unused);
      const ids = rooms.map((x) => x.id);
      const rows = await tx.select().from(hospAssignments).where(and(inArray(hospAssignments.reservationRoomId, ids), gte(hospAssignments.date, today)));
      if (rows.length) await tx.delete(hospAssignments).where(inArray(hospAssignments.id, rows.map((a) => a.id)));
    }
    const roomIds = [...new Set(rooms.map((x) => x.roomId).filter((x): x is string => !!x))];
    if (roomIds.length) {
      await tx.update(hospRooms).set({ hkStatus: 'dirty', updatedAt: new Date() }).where(and(inArray(hospRooms.id, roomIds), sql`${hospRooms.hkStatus} <> 'out_of_order'`));
      await tx.insert(hospHkTasks).values(roomIds.map((roomId) => ({ organizationId: r.organizationId, locationId: r.locationId, roomId, date: today, kind: 'departure_clean', reservationId: r.id, priority: 1 }))).onConflictDoNothing();
    }
    const [u] = await tx.update(hospReservations).set({ status: 'checked_out', checkedOutAt: new Date(), updatedAt: new Date(), timeline: [...r.timeline, event('checked_out', opts.actorUserId)] }).where(eq(hospReservations.id, r.id)).returning();
    await audit(tx, { organizationId: r.organizationId, actorUserId: opts.actorUserId, action: 'hospitality.reservation.checked_out', scopeKind: 'location', scopeId: r.locationId, targetType: 'hosp_reservation', targetId: r.id });
    return u!;
  });
}

// ───────────────────────── folio ─────────────────────────

export async function folioView(db: Exec, r: Reservation) {
  const lines = await db.select().from(hospFolioLines).where(eq(hospFolioLines.reservationId, r.id)).orderBy(asc(hospFolioLines.createdAt), asc(hospFolioLines.id));
  const m = (amount: number) => ({ amount, currency: r.currency });
  const sumKinds = (kinds: string[]) => lines.filter((l) => kinds.includes(l.kind)).reduce((a, l) => a + l.amountMinor, 0);
  const balance = lines.reduce((a, l) => a + l.amountMinor, 0);
  const posted = lines.some((l) => l.kind === 'room');
  return {
    currency: r.currency,
    lines: lines.map((l) => ({ id: l.id, kind: l.kind, description: l.description, serviceDate: l.serviceDate, amount: m(l.amountMinor), method: l.method, sourceType: l.sourceType, sourceId: l.sourceId, reversesId: l.reversesId, createdAt: l.createdAt.toISOString() })),
    charges: m(sumKinds(['room', 'tax', 'extra', 'outlet', 'fee', 'adjustment'])), payments: m(-sumKinds(['payment'])), refunds: m(sumKinds(['refund'])), balance: m(balance),
    /** Before check-in the stay is not yet posted: expected balance = stay total + posted lines. */
    stayPosted: posted,
    expectedBalance: posted || !INVENTORY_STATUSES.includes(r.status as ReservationStatus) ? m(balance) : m(balance + r.totalMinor),
  };
}

export async function postFolioLine(s: Services, r: Reservation, input: { kind: 'extra' | 'adjustment' | 'payment' | 'refund'; description: string; amountMinor: number; method?: string | null; serviceDate?: string | null }, actorUserId: string | null) {
  if (!['confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'].includes(r.status)) throw conflict('folio_closed', 'This reservation has no open folio');
  if (r.status === 'checked_out' && input.kind === 'extra') throw conflict('folio_closed', 'The guest has checked out');
  const signed = input.kind === 'payment' ? -Math.abs(input.amountMinor) : input.kind === 'refund' || input.kind === 'extra' ? Math.abs(input.amountMinor) : input.amountMinor;
  const [line] = await s.db.insert(hospFolioLines).values({ organizationId: r.organizationId, locationId: r.locationId, reservationId: r.id, kind: input.kind, description: input.description, serviceDate: input.serviceDate ?? null, amountMinor: signed, currency: r.currency, method: input.method ?? null, createdBy: actorUserId }).returning();
  await audit(s.db, { organizationId: r.organizationId, actorUserId, action: `hospitality.folio.${input.kind}`, scopeKind: 'location', scopeId: r.locationId, targetType: 'hosp_reservation', targetId: r.id, metadata: { amountMinor: signed, currency: r.currency, method: input.method } });
  return line!;
}

// ───────────────────────── housekeeping status ─────────────────────────

export async function setRoomStatus(s: Services, loc: Location, roomId: string, to: HkStatus, input: { reason?: string | null; until?: string | null }, actorUserId: string | null) {
  return s.db.transaction(async (tx) => {
    const [room] = await tx.select().from(hospRooms).where(and(eq(hospRooms.id, roomId), eq(hospRooms.locationId, loc.id))).for('update');
    if (!room) throw notFound('Room');
    const t = hkTransition(room.hkStatus as HkStatus, to);
    if (!t.ok) throw conflict('invalid_transition', `A room cannot go from ${room.hkStatus.replace('_', ' ')} to ${to.replace('_', ' ')}`);
    const today = localToday(loc);
    if (to === 'out_of_order') {
      if (!input.reason) throw validationError('Say why the room is out of order', { reason: 'Required' });
      if (!input.until || input.until <= today) throw validationError('Choose the date the room is back in service', { until: 'After today' });
      const taken = await tx.select({ d: hospAssignments.date }).from(hospAssignments).where(and(eq(hospAssignments.roomId, room.id), gte(hospAssignments.date, today), lt(hospAssignments.date, input.until))).limit(1);
      if (taken.length) throw conflict('room_assigned', `Room ${room.number} is assigned to a stay on ${taken[0]!.d}. Move that stay first.`);
      await tx.insert(hospRoomBlocks).values({ organizationId: loc.organizationId, locationId: loc.id, roomId: room.id, startDate: today, endDate: input.until, reason: input.reason, createdBy: actorUserId });
    }
    if (room.hkStatus === 'out_of_order') {
      const blocks = await tx.select().from(hospRoomBlocks).where(and(eq(hospRoomBlocks.roomId, room.id), eq(hospRoomBlocks.active, true), gte(hospRoomBlocks.endDate, today)));
      for (const b of blocks) {
        if (b.startDate >= today) await tx.update(hospRoomBlocks).set({ active: false }).where(eq(hospRoomBlocks.id, b.id));
        else await tx.update(hospRoomBlocks).set({ endDate: today }).where(eq(hospRoomBlocks.id, b.id));
      }
    }
    if (to === 'out_of_order' || room.hkStatus === 'out_of_order') {
      try {
        await recomputeInventory(tx, room.roomTypeId, today);
      } catch (err) {
        if (pgCode(err) === '23514') throw conflict('would_overbook', 'Taking this room out of order would oversell some nights');
        throw err;
      }
    }
    const [u] = await tx.update(hospRooms).set({ hkStatus: to, updatedAt: new Date() }).where(eq(hospRooms.id, room.id)).returning();
    await audit(tx, { organizationId: loc.organizationId, actorUserId, action: 'hospitality.room.status', scopeKind: 'location', scopeId: loc.id, targetType: 'hosp_room', targetId: room.id, metadata: { from: room.hkStatus, to, reason: input.reason, until: input.until } });
    return u!;
  });
}

export const nightsOf = (rr: { nights: NightPrice[] }) => rr.nights.map((n) => n.date);
export type { TaxLine };

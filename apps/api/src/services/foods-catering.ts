/**
 * Preorders & catering: catering enquiries are reviewed by the business, quoted (lines, service charge,
 * configured tax, deposit), accepted by the customer through a private link, secured with a deposit
 * payment and then confirmed. Production summaries combine everything due on a local date per station.
 */
import { and, eq, gte, inArray, lt, notInArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { cateringEnquirySchema } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import {
  foodCateringEnquiries, foodCateringPackages, foodMealPlanBoxes, foodOrders, foodStations, locations, menuItems, paymentReferences, type CateringQuote,
} from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { addDays, localDateParts, zonedToUtc } from '../lib/tz.ts';
import { audit } from './audit.ts';
import { findOrCreateCustomer } from './customers.ts';
import { loadFoodConfig } from './foods-menu.ts';
import { createPaymentForTarget, paymentTargetExtensions, type PaymentRow } from './payments.ts';

type Location = typeof locations.$inferSelect;
type Enquiry = typeof foodCateringEnquiries.$inferSelect;
export type CateringEnquiryInput = z.infer<typeof cateringEnquirySchema>;

const OPEN_STATES = ['new', 'quoted', 'accepted', 'deposit_paid', 'confirmed'];
export const PRODUCTION_STATES = ['accepted', 'deposit_paid', 'confirmed'];

function push(e: Enquiry, to: string, by: string | null, note?: string) {
  return [...e.statusHistory, { at: new Date().toISOString(), from: e.status, to, by, note }];
}

export function serializeEnquiry(e: Enquiry, opts: { includeContact?: boolean; packageName?: string | null } = {}) {
  const expired = e.status === 'quoted' && !!e.quote && new Date(e.quote.validUntil) < new Date();
  const m = (amount: number) => ({ amount, currency: e.currency });
  return {
    id: e.id, reference: e.reference, locationId: e.locationId, status: expired ? 'expired' : e.status, eventDate: e.eventDate, eventTime: e.eventTime, guests: e.guests,
    packageId: e.packageId, packageName: opts.packageName ?? null, fulfilment: e.fulfilment, notes: e.notes, dietaryNotes: e.dietaryNotes,
    contact: opts.includeContact ? e.contact : { name: e.contact.name.split(' ')[0] ?? '' }, address: opts.includeContact ? e.address : null,
    quote: e.quote ? {
      version: e.quote.version, lines: e.quote.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: m(l.unitPriceMinor), total: m(l.totalMinor) })),
      subtotal: m(e.quote.subtotalMinor), serviceCharge: e.quote.serviceChargeMinor ? m(e.quote.serviceChargeMinor) : null, deliveryFee: e.quote.deliveryFeeMinor ? m(e.quote.deliveryFeeMinor) : null,
      tax: e.quote.taxRateBps ? m(e.quote.taxMinor) : null, taxRateBps: e.quote.taxRateBps || null, total: m(e.quote.totalMinor), deposit: m(e.quote.depositMinor),
      validUntil: e.quote.validUntil, terms: e.quote.terms, sentAt: e.quote.sentAt,
    } : null,
    depositPaymentId: e.depositPaymentId, acceptedAt: e.acceptedAt?.toISOString() ?? null, depositPaidAt: e.depositPaidAt?.toISOString() ?? null, confirmedAt: e.confirmedAt?.toISOString() ?? null,
    declinedReason: e.declinedReason, statusHistory: e.statusHistory, createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString(),
  };
}

/** Public enquiry. Nothing is promised: the business reviews price and capacity before quoting. */
export async function createEnquiry(s: Services, loc: Location, input: CateringEnquiryInput) {
  const cfg = await loadFoodConfig(s.db, loc.id);
  if (!cfg.channels.catering) throw conflict('channel_unavailable', 'Catering enquiries are not available at this location');
  const today = localDateParts(new Date(), loc.timeZone).date;
  if (input.eventDate < addDays(today, 1)) throw validationError('Choose a date from tomorrow onwards', { eventDate: 'Too soon' });
  let pkg: typeof foodCateringPackages.$inferSelect | undefined;
  if (input.packageId) {
    [pkg] = await s.db.select().from(foodCateringPackages).where(and(eq(foodCateringPackages.id, input.packageId), eq(foodCateringPackages.organizationId, loc.organizationId), eq(foodCateringPackages.active, true)));
    if (!pkg || (pkg.locationIds.length && !pkg.locationIds.includes(loc.id))) throw validationError('Unknown package', { packageId: 'Not offered at this location' });
    if (input.guests < pkg.minGuests) throw validationError(`This package is for at least ${pkg.minGuests} guests`, { guests: `Minimum ${pkg.minGuests}` });
    if (pkg.maxGuests && input.guests > pkg.maxGuests) throw validationError(`This package is for up to ${pkg.maxGuests} guests`, { guests: `Maximum ${pkg.maxGuests}` });
    if (input.eventDate < addDays(today, pkg.leadDays)) throw validationError(`This package needs ${pkg.leadDays} days’ notice`, { eventDate: `At least ${pkg.leadDays} days ahead` });
  }
  if (input.fulfilment !== 'pickup' && !input.address) throw validationError('Enter the event address', { address: 'Required for delivery or on-site service' });
  const token = randomToken();
  const e = await s.db.transaction(async (tx) => {
    const customer = await findOrCreateCustomer(tx, loc.organizationId, loc.id, input.contact, 'catering_enquiry');
    const [row] = await tx.insert(foodCateringEnquiries).values({
      organizationId: loc.organizationId, locationId: loc.id, customerId: customer.id, reference: `CAT-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 5)}`,
      contact: { name: input.contact.name, email: input.contact.email, phone: input.contact.phone }, eventDate: input.eventDate, eventTime: input.eventTime ?? null, guests: input.guests,
      packageId: pkg?.id ?? null, fulfilment: input.fulfilment, address: (input.address as Record<string, unknown> | undefined) ?? null, notes: input.notes ?? null, dietaryNotes: input.dietaryNotes ?? null,
      currency: loc.currency, tokenHash: sha256(token), statusHistory: [{ at: new Date().toISOString(), from: null, to: 'new', by: null }],
    }).returning();
    await audit(tx, { organizationId: loc.organizationId, actorUserId: null, actorType: 'system', action: 'catering.enquiry_created', scopeKind: 'location', scopeId: loc.id, targetType: 'catering_enquiry', targetId: row!.id, metadata: { guests: input.guests, eventDate: input.eventDate } });
    return row!;
  });
  await s.jobs.enqueue('email.send', { to: input.contact.email, subject: `Catering enquiry ${e.reference} received`, text: `Thanks — ${loc.name} will review your enquiry for ${input.guests} guests on ${input.eventDate} and send a quote. Nothing is booked until you accept the quote${'.'}`, tag: 'catering' });
  return { enquiry: e, token };
}

export interface QuoteInput {
  lines?: Array<{ description: string; menuItemId?: string | null; quantity: number; unitPriceMinor: number }>;
  /** Build the lines from the selected package (price per guest × guests). */
  fromPackage?: boolean;
  deliveryFeeMinor?: number;
  depositBps?: number;
  depositMinor?: number;
  validDays?: number;
  terms?: string | null;
}

/** Staff quote (or re-quote). Tax only with a configured rate; service charge only when configured for catering. */
export async function quoteEnquiry(s: Services, organizationId: string, enquiryId: string, input: QuoteInput, actorUserId: string) {
  return s.db.transaction(async (tx) => {
    const [e] = await tx.select().from(foodCateringEnquiries).where(and(eq(foodCateringEnquiries.id, enquiryId), eq(foodCateringEnquiries.organizationId, organizationId))).for('update');
    if (!e) throw notFound('Enquiry');
    if (!['new', 'quoted', 'expired'].includes(e.status)) throw conflict('invalid_state', `A ${e.status.replace('_', ' ')} enquiry cannot be re-quoted`);
    const [loc] = await tx.select().from(locations).where(eq(locations.id, e.locationId));
    let lines = input.lines ?? [];
    if (input.fromPackage) {
      if (!e.packageId) throw validationError('This enquiry has no package', { fromPackage: 'No package selected' });
      const [pkg] = await tx.select().from(foodCateringPackages).where(eq(foodCateringPackages.id, e.packageId));
      const per = pkg?.pricesPerGuest[e.currency];
      if (per === undefined) throw validationError(`The package has no price in ${e.currency}`, { fromPackage: 'No price in this currency' });
      lines = [{ description: `${pkg!.name} — per guest`, menuItemId: null, quantity: e.guests, unitPriceMinor: per }, ...lines];
    }
    if (!lines.length) throw validationError('Add at least one quote line', { lines: 'Required' });
    const cfg = await loadFoodConfig(tx, e.locationId);
    const quoteLines = lines.map((l) => ({ description: l.description, menuItemId: l.menuItemId ?? null, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, totalMinor: l.quantity * l.unitPriceMinor }));
    const subtotal = quoteLines.reduce((a, l) => a + l.totalMinor, 0);
    const serviceCharge = cfg.serviceCharge.bps > 0 && cfg.serviceCharge.channels.includes('catering') ? Math.round((subtotal * cfg.serviceCharge.bps) / 10_000) : 0;
    const taxRateBps = typeof loc!.settings.taxRateBps === 'number' ? (loc!.settings.taxRateBps as number) : 0;
    const tax = Math.round((subtotal * taxRateBps) / 10_000);
    const deliveryFee = input.deliveryFeeMinor ?? 0;
    const total = subtotal + serviceCharge + deliveryFee + tax;
    const deposit = input.depositMinor ?? Math.round((total * (input.depositBps ?? 2500)) / 10_000);
    if (deposit > total) throw validationError('The deposit cannot exceed the total', { depositMinor: 'Too large' });
    const quote: CateringQuote = {
      version: (e.quote?.version ?? 0) + 1, lines: quoteLines, subtotalMinor: subtotal, serviceChargeMinor: serviceCharge, deliveryFeeMinor: deliveryFee, taxMinor: tax, taxRateBps,
      totalMinor: total, depositMinor: deposit, currency: e.currency, validUntil: new Date(Date.now() + (input.validDays ?? 7) * 86400_000).toISOString(), terms: input.terms ?? null,
      sentAt: new Date().toISOString(), sentBy: actorUserId,
    };
    const [u] = await tx.update(foodCateringEnquiries).set({ quote, status: 'quoted', statusHistory: push(e, 'quoted', actorUserId, `Quote v${quote.version}`), updatedAt: new Date() }).where(eq(foodCateringEnquiries.id, e.id)).returning();
    await audit(tx, { organizationId, actorUserId, action: 'catering.quoted', scopeKind: 'location', scopeId: e.locationId, targetType: 'catering_enquiry', targetId: e.id, metadata: { totalMinor: total, depositMinor: deposit, currency: e.currency, version: quote.version } });
    await s.jobs.enqueue('email.send', { to: e.contact.email, subject: `Your catering quote ${e.reference}`, text: `${loc!.name} sent a quote for your event on ${e.eventDate}. Review and accept it from your enquiry link. The quote is valid until ${quote.validUntil.slice(0, 10)}.`, tag: 'catering' });
    return u!;
  });
}

export async function enquiryByToken(db: Exec, id: string, token: string) {
  const [e] = await db.select().from(foodCateringEnquiries).where(eq(foodCateringEnquiries.id, id));
  if (!e || e.tokenHash !== sha256(token)) throw notFound('Enquiry');
  return e;
}

/** Customer accepts the current quote; a deposit payment is created when the quote asks for one. */
export async function acceptQuote(s: Services, id: string, token: string, quoteVersion?: number) {
  const e = await enquiryByToken(s.db, id, token);
  if (e.status !== 'quoted' || !e.quote) throw conflict('invalid_state', e.status === 'new' ? 'The business has not sent a quote yet' : `This enquiry is ${e.status.replace('_', ' ')}`);
  if (new Date(e.quote.validUntil) < new Date()) throw conflict('quote_expired', 'This quote has expired. Ask the business for a new one.');
  if (quoteVersion !== undefined && quoteVersion !== e.quote.version) throw conflict('quote_changed', 'The quote was updated. Review the latest version before accepting.');
  const noDeposit = e.quote.depositMinor === 0;
  const [u] = await s.db.update(foodCateringEnquiries).set({ status: noDeposit ? 'confirmed' : 'accepted', acceptedAt: new Date(), confirmedAt: noDeposit ? new Date() : null, statusHistory: push(e, noDeposit ? 'confirmed' : 'accepted', null, 'Accepted by customer'), updatedAt: new Date() })
    .where(and(eq(foodCateringEnquiries.id, e.id), eq(foodCateringEnquiries.status, 'quoted'))).returning();
  if (!u) throw conflict('invalid_state', 'This quote was already answered');
  await audit(s.db, { organizationId: e.organizationId, actorUserId: null, actorType: 'system', action: 'catering.accepted', scopeKind: 'location', scopeId: e.locationId, targetType: 'catering_enquiry', targetId: e.id, metadata: { version: e.quote.version } });
  if (noDeposit) return { enquiry: u, payment: null };
  const p = await createPaymentForTarget(s, { organizationId: e.organizationId, locationId: e.locationId, amountMinor: e.quote.depositMinor, currency: e.currency, targetType: 'catering_deposit', targetId: e.id, description: `Catering deposit ${e.reference}` });
  const [v] = await s.db.update(foodCateringEnquiries).set({ depositPaymentId: p.payment.id }).where(eq(foodCateringEnquiries.id, e.id)).returning();
  return { enquiry: v!, payment: { id: p.payment.id, clientSecret: p.clientSecret, sandbox: p.sandbox } };
}

/** Staff status changes: confirm, complete, decline, cancel. */
export async function setEnquiryStatus(s: Services, organizationId: string, id: string, to: 'confirmed' | 'completed' | 'declined' | 'cancelled', actorUserId: string, note?: string) {
  const allowed: Record<string, string[]> = { confirmed: ['deposit_paid', 'accepted'], completed: ['confirmed', 'deposit_paid'], declined: ['new', 'quoted'], cancelled: OPEN_STATES };
  return s.db.transaction(async (tx) => {
    const [e] = await tx.select().from(foodCateringEnquiries).where(and(eq(foodCateringEnquiries.id, id), eq(foodCateringEnquiries.organizationId, organizationId))).for('update');
    if (!e) throw notFound('Enquiry');
    if (!allowed[to]!.includes(e.status)) throw new AppError(409, 'invalid_transition', `Cannot move a ${e.status.replace('_', ' ')} enquiry to ${to}`);
    if (to === 'confirmed' && e.status === 'accepted' && (e.quote?.depositMinor ?? 0) > 0) throw conflict('deposit_pending', 'The deposit has not been paid yet');
    if ((to === 'declined' || to === 'cancelled') && !note) throw validationError('A reason is required', { note: 'Required' });
    const [u] = await tx.update(foodCateringEnquiries).set({ status: to, confirmedAt: to === 'confirmed' ? new Date() : e.confirmedAt, declinedReason: to === 'declined' || to === 'cancelled' ? note ?? null : e.declinedReason, statusHistory: push(e, to, actorUserId, note), updatedAt: new Date() }).where(eq(foodCateringEnquiries.id, id)).returning();
    await audit(tx, { organizationId, actorUserId, action: `catering.${to}`, scopeKind: 'location', scopeId: e.locationId, targetType: 'catering_enquiry', targetId: id, metadata: { note } });
    return u!;
  });
}

// ── deposit payments (registered with the payments module) ──
paymentTargetExtensions.catering_deposit = {
  async fulfil(tx: Tx, p: PaymentRow) {
    const [e] = await tx.select().from(foodCateringEnquiries).where(eq(foodCateringEnquiries.id, p.targetId!)).for('update');
    if (!e) return { fulfilled: false, note: 'Catering enquiry missing' };
    if (e.status === 'deposit_paid' || e.status === 'confirmed' || e.status === 'completed') return { fulfilled: true, note: 'Deposit already recorded' };
    if (e.status !== 'accepted') return { fulfilled: false, note: `Enquiry is ${e.status} — deposit needs review` };
    await tx.update(foodCateringEnquiries).set({ status: 'deposit_paid', depositPaidAt: new Date(), depositPaymentId: p.id, statusHistory: push(e, 'deposit_paid', null, 'Deposit paid'), updatedAt: new Date() }).where(eq(foodCateringEnquiries.id, e.id));
    return { fulfilled: true, note: 'Catering deposit paid — awaiting confirmation' };
  },
  async isRecorded(db: Exec, p: PaymentRow) {
    const [e] = await db.select().from(foodCateringEnquiries).where(eq(foodCateringEnquiries.id, p.targetId!));
    return { ok: !!e && ['deposit_paid', 'confirmed', 'completed'].includes(e.status), expected: e?.quote ? { amount: e.quote.depositMinor, currency: e.currency } : null };
  },
};

// ───────── Production summary ─────────

type Agg = Map<string, { name: string; quantity: number; modifiers: Map<string, number> }>;
function addTo(agg: Agg, key: string, name: string, qty: number, mods: string[]) {
  const cur = agg.get(key) ?? { name, quantity: 0, modifiers: new Map<string, number>() };
  cur.quantity += qty;
  for (const m of mods) cur.modifiers.set(m, (cur.modifiers.get(m) ?? 0) + qty);
  agg.set(key, cur);
}

/**
 * Everything to produce on a local date at a location, grouped by kitchen station: preorders and other
 * orders promised that day, accepted/confirmed catering quotes and meal-plan boxes.
 */
export async function productionSummary(db: Exec, organizationId: string, loc: Location, date: string) {
  const start = zonedToUtc(date, '00:00', loc.timeZone);
  const end = zonedToUtc(addDays(date, 1), '00:00', loc.timeZone);
  const [orders, enquiries, boxes, stations] = await Promise.all([
    db.select().from(foodOrders).where(and(eq(foodOrders.locationId, loc.id), gte(foodOrders.promisedAt, start), lt(foodOrders.promisedAt, end), notInArray(foodOrders.status, ['cancelled', 'rejected']), notInArray(foodOrders.paymentStatus, ['pending', 'voided']))),
    db.select().from(foodCateringEnquiries).where(and(eq(foodCateringEnquiries.locationId, loc.id), eq(foodCateringEnquiries.eventDate, date), inArray(foodCateringEnquiries.status, PRODUCTION_STATES))),
    db.select().from(foodMealPlanBoxes).where(and(eq(foodMealPlanBoxes.locationId, loc.id), eq(foodMealPlanBoxes.fulfilmentDate, date), inArray(foodMealPlanBoxes.status, ['scheduled', 'in_production']))),
    db.select().from(foodStations).where(eq(foodStations.locationId, loc.id)),
  ]);
  const boxOrderIds = new Set(boxes.map((b) => b.foodOrderId).filter(Boolean));
  const itemIds = new Set<string>();
  orders.forEach((o) => o.lines.forEach((l) => itemIds.add(l.menuItemId)));
  boxes.forEach((b) => b.items.forEach((i) => itemIds.add(i.menuItemId)));
  enquiries.forEach((e) => e.quote?.lines.forEach((l) => l.menuItemId && itemIds.add(l.menuItemId)));
  const itemRows = itemIds.size ? await db.select({ id: menuItems.id, name: menuItems.name, stationKey: menuItems.stationKey }).from(menuItems).where(inArray(menuItems.id, [...itemIds])) : [];
  const stationOf = new Map(itemRows.map((r) => [r.id, r.stationKey]));
  const itemName = new Map(itemRows.map((r) => [r.id, r.name]));
  const byStation = new Map<string, Agg>();
  const bucket = (menuItemId: string | null | undefined) => {
    const key = (menuItemId && stationOf.get(menuItemId)) || 'unassigned';
    if (!byStation.has(key)) byStation.set(key, new Map());
    return byStation.get(key)!;
  };
  const channels: Record<string, number> = {};
  for (const o of orders) {
    if (boxOrderIds.has(o.id)) continue;
    channels[o.channel] = (channels[o.channel] ?? 0) + 1;
    for (const l of o.lines) addTo(bucket(l.menuItemId), l.menuItemId, l.name, l.quantity, l.modifiers.map((m) => m.name));
  }
  for (const b of boxes) {
    channels.meal_plan = (channels.meal_plan ?? 0) + 1;
    for (const i of b.items) addTo(bucket(i.menuItemId), i.menuItemId, i.name, i.quantity, []);
  }
  const catering = enquiries.map((e) => {
    for (const l of e.quote?.lines ?? []) addTo(bucket(l.menuItemId), l.menuItemId ?? `catering:${l.description}`, (l.menuItemId && itemName.get(l.menuItemId)) || l.description, l.quantity, []);
    return { id: e.id, reference: e.reference, guests: e.guests, eventTime: e.eventTime, status: e.status, fulfilment: e.fulfilment, dietaryNotes: e.dietaryNotes };
  });
  const stationName = new Map(stations.map((x) => [x.key, x.name]));
  return {
    location: { id: loc.id, name: loc.name, timeZone: loc.timeZone }, date, generatedAt: new Date().toISOString(),
    counts: { orders: orders.filter((o) => !boxOrderIds.has(o.id)).length, byChannel: channels, cateringEvents: catering.length, guests: catering.reduce((a, c) => a + c.guests, 0), mealPlanBoxes: boxes.length },
    stations: [...byStation.entries()].map(([key, agg]) => ({
      key, name: key === 'unassigned' ? 'Unassigned' : stationName.get(key) ?? key,
      items: [...agg.values()].sort((a, b) => b.quantity - a.quantity).map((v) => ({ name: v.name, quantity: v.quantity, modifiers: [...v.modifiers.entries()].map(([name, quantity]) => ({ name, quantity })) })),
    })).sort((a, b) => (a.key === 'unassigned' ? 1 : b.key === 'unassigned' ? -1 : a.name.localeCompare(b.name))),
    catering,
  };
}

export async function depositPaymentState(db: Exec, e: Enquiry) {
  if (!e.depositPaymentId) return null;
  const [p] = await db.select({ state: paymentReferences.state }).from(paymentReferences).where(eq(paymentReferences.id, e.depositPaymentId));
  return p?.state ?? null;
}

/**
 * Recurring meal plans (weekly meal-prep boxes) billed with Stripe subscriptions (sandbox without keys).
 * Weeks start on Monday (local dates); each plan fulfils on one weekday and closes changes/skips
 * `cutoffDaysBefore` days earlier at `cutoffTime` in the location's time zone.
 */
import { and, eq, inArray, lte } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import { foodMealPlanBoxes, foodMealPlans, foodMealPlanSubscriptions, foodOrders, locations, menuItems } from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { addDays, localDateParts, weekdayOf, zonedToUtc } from '../lib/tz.ts';
import { subscriptionProvider } from '../integrations/foods-subscriptions.ts';
import { audit } from './audit.ts';
import { findOrCreateCustomer } from './customers.ts';
import { resolveDeliveryZone } from './foods-delivery.ts';
import { createKdsTickets } from './foods-kitchen.ts';
import { loadFoodConfig } from './foods-menu.ts';
import { connectedAccountFor, processStripeEvent, stripeEventExtensions } from './payments.ts';

type Location = typeof locations.$inferSelect;
type Plan = typeof foodMealPlans.$inferSelect;
type Sub = typeof foodMealPlanSubscriptions.$inferSelect;

export const mondayOf = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7));
export const fulfilmentDateOf = (plan: Pick<Plan, 'fulfilmentWeekday'>, weekStart: string) => addDays(weekStart, (plan.fulfilmentWeekday + 6) % 7);
export const cutoffOf = (plan: Pick<Plan, 'fulfilmentWeekday' | 'cutoffDaysBefore' | 'cutoffTime'>, weekStart: string, timeZone: string) =>
  zonedToUtc(addDays(fulfilmentDateOf(plan, weekStart), -plan.cutoffDaysBefore), plan.cutoffTime, timeZone);

/** The first week whose cut-off has not passed. */
export function firstOpenWeek(plan: Plan, timeZone: string, now = new Date()) {
  let week = mondayOf(localDateParts(now, timeZone).date);
  for (let i = 0; i < 4 && cutoffOf(plan, week, timeZone) <= now; i++) week = addDays(week, 7);
  return week;
}

export function upcomingWeeks(plan: Plan, sub: Sub, timeZone: string, n = 4, now = new Date()) {
  const base = mondayOf(localDateParts(now, timeZone).date);
  const out = [];
  for (let i = 0; out.length < n && i < n + 2; i++) {
    const week = addDays(base, i * 7);
    if (week < sub.startWeek) continue;
    const cutoff = cutoffOf(plan, week, timeZone);
    if (cutoff <= now && week < base) continue;
    out.push({ weekStart: week, fulfilmentDate: fulfilmentDateOf(plan, week), cutoffAt: cutoff.toISOString(), skipped: sub.skippedWeeks.includes(week), canChange: cutoff > now && sub.status === 'active' });
  }
  return out;
}

export function serializePlan(p: Plan, currency?: string) {
  return {
    id: p.id, name: p.name, description: p.description, translations: p.translations, mealsPerBox: p.mealsPerBox, pricesPerWeek: p.pricesPerWeek,
    price: currency ? (p.pricesPerWeek[currency] === undefined ? null : { amount: p.pricesPerWeek[currency]!, currency }) : null,
    fulfilment: p.fulfilment, fulfilmentWeekday: p.fulfilmentWeekday, cutoffDaysBefore: p.cutoffDaysBefore, cutoffTime: p.cutoffTime, menuItemIds: p.menuItemIds, locationIds: p.locationIds, active: p.active,
  };
}

export function serializeSubscription(sub: Sub, plan: Plan, loc: Pick<Location, 'timeZone' | 'name'>, opts: { includeContact?: boolean } = {}) {
  return {
    id: sub.id, planId: plan.id, planName: plan.name, locationId: sub.locationId, locationName: loc.name, status: sub.status, price: { amount: sub.priceMinor, currency: sub.currency }, interval: 'week',
    startWeek: sub.startWeek, skippedWeeks: sub.skippedWeeks, sandbox: sub.sandbox, fulfilment: plan.fulfilment,
    contact: opts.includeContact ? sub.contact : { name: sub.contact.name.split(' ')[0] ?? '' },
    upcoming: upcomingWeeks(plan, sub, loc.timeZone), createdAt: sub.createdAt.toISOString(), cancelledAt: sub.cancelledAt?.toISOString() ?? null,
  };
}

export async function subscribe(s: Services, loc: Location, input: { planId: string; contact: { name: string; email: string; phone?: string; marketingConsent?: boolean }; address?: { line1: string; city: string; postalCode: string; lat?: number; lng?: number } & Record<string, unknown>; startWeek?: string; renewalConsent?: { text?: string; locale?: string } | null; ip?: string }) {
  const cfg = await loadFoodConfig(s.db, loc.id);
  if (!cfg.channels.mealPlans) throw conflict('channel_unavailable', 'Meal plans are not available at this location');
  const [plan] = await s.db.select().from(foodMealPlans).where(and(eq(foodMealPlans.id, input.planId), eq(foodMealPlans.organizationId, loc.organizationId), eq(foodMealPlans.active, true)));
  if (!plan || (plan.locationIds.length && !plan.locationIds.includes(loc.id))) throw notFound('Meal plan');
  const price = plan.pricesPerWeek[loc.currency];
  if (price === undefined) throw conflict('no_price', `This plan has no price in ${loc.currency}`);
  if (!loc.paymentsEnabled) throw conflict('payments_not_enabled', 'Online payments are not available at this location yet');
  // Weekly renewals charge the saved card: explicit consent is required with real payments.
  if (s.payments.mode === 'live' && !input.renewalConsent) throw validationError('Please agree to weekly charges to your saved card', { renewalConsent: 'Required' });
  let zoneId: string | null = null;
  if (plan.fulfilment === 'delivery') {
    if (!input.address) throw validationError('Enter a delivery address', { address: 'Required' });
    const z = await resolveDeliveryZone(s, loc, input.address);
    if (!z) throw conflict('outside_delivery_area', 'We don’t deliver meal plans to this address yet.');
    zoneId = z.zone.id;
  }
  const first = firstOpenWeek(plan, loc.timeZone);
  let startWeek = first;
  if (input.startWeek) {
    if (mondayOf(input.startWeek) !== input.startWeek) throw validationError('Weeks start on a Monday', { startWeek: 'Must be a Monday' });
    if (input.startWeek < first) throw validationError('Changes for that week have closed', { startWeek: `Earliest ${first}` });
    startWeek = input.startWeek;
  }
  const token = randomToken();
  const sub = await s.db.transaction(async (tx) => {
    const customer = await findOrCreateCustomer(tx, loc.organizationId, loc.id, input.contact, 'meal_plan');
    const [row] = await tx.insert(foodMealPlanSubscriptions).values({
      organizationId: loc.organizationId, locationId: loc.id, planId: plan.id, customerId: customer.id, contact: { name: input.contact.name, email: input.contact.email, phone: input.contact.phone },
      priceMinor: price, currency: loc.currency, startWeek, address: (input.address as Record<string, unknown> | undefined) ?? null, zoneId, tokenHash: sha256(token),
    }).returning();
    await audit(tx, { organizationId: loc.organizationId, actorUserId: null, actorType: 'system', action: 'meal_plan.subscribed', scopeKind: 'location', scopeId: loc.id, targetType: 'meal_plan_subscription', targetId: row!.id, metadata: { planId: plan.id, priceMinor: price, currency: loc.currency } });
    return row!;
  });
  const acct = await connectedAccountFor(s.db, loc.organizationId, loc.id);
  const { CONSENT_TEXT, clientConfigFor, ensurePaymentCustomer, ensureRecurringPrice, savedCardFor } = await import('./payments-saved.ts');
  const { paymentConsents } = await import('../db/schema/index.ts');
  const pc = await ensurePaymentCustomer(s, { organizationId: loc.organizationId, customerId: sub.customerId!, connectedAccountId: acct.accountId });
  if (input.renewalConsent) {
    await s.db.insert(paymentConsents).values({
      organizationId: loc.organizationId, customerId: sub.customerId!, connectedAccountId: acct.accountId ?? '', purpose: 'renewals', targetType: 'meal_plan_subscription', targetId: sub.id,
      text: (input.renewalConsent.text?.trim() || CONSENT_TEXT.renewals(acct.org.name)).slice(0, 2000), locale: input.renewalConsent.locale ?? null, source: 'web', ip: input.ip ?? null,
    });
  }
  const recurring = await ensureRecurringPrice(s, { connectedAccountId: acct.accountId, planKey: `meal_plan:${plan.id}`, productName: plan.name, amountMinor: price, currency: loc.currency, interval: 'week' });
  const card = await savedCardFor(s.db, sub.customerId!, acct.accountId);
  // The first week is paid now (Payment Element / PaymentSheet confirms the first invoice); Stripe keeps the card as the subscription default.
  const created = await s.payments.createSubscription({
    connectedAccountId: acct.accountId, customerId: pc.stripeCustomerId, priceId: recurring.priceId, defaultPaymentMethodId: card?.defaultPaymentMethodId ?? null, trialEnd: null,
    applicationFeePercent: (acct.feeBps ?? 0) / 100, metadata: { bh_org: loc.organizationId, bh_location: loc.id, bh_meal_plan_subscription: sub.id }, idempotencyKey: `meal_plan:${sub.id}`, collectFirstPayment: true,
  });
  const sandbox = s.payments.mode === 'sandbox';
  const [u] = await s.db.update(foodMealPlanSubscriptions).set({ externalId: created.id, sandbox, updatedAt: new Date() }).where(eq(foodMealPlanSubscriptions.id, sub.id)).returning();
  const pay = await clientConfigFor(s, loc.organizationId, loc.id);
  return { subscription: u!, plan, manageToken: token, payment: { clientSecret: created.clientSecret, sandbox, publishableKey: pay.publishableKey, stripeAccount: pay.stripeAccount, merchantDisplayName: pay.merchantDisplayName, merchantCountry: pay.merchantCountry, mode: pay.mode } };
}

export async function subscriptionByToken(db: Exec, id: string, token: string) {
  const [sub] = await db.select().from(foodMealPlanSubscriptions).where(eq(foodMealPlanSubscriptions.id, id));
  if (!sub || sub.tokenHash !== sha256(token)) throw notFound('Subscription');
  return sub;
}

export async function loadSubContext(db: Exec, sub: Sub) {
  const [plan] = await db.select().from(foodMealPlans).where(eq(foodMealPlans.id, sub.planId));
  const [loc] = await db.select().from(locations).where(eq(locations.id, sub.locationId));
  return { plan: plan!, loc: loc! };
}

/** Skip (or un-skip) a week before its cut-off. A skipped week is credited on the next invoice. */
export async function setWeekSkipped(s: Services, sub: Sub, weekStart: string, skip: boolean, actorUserId: string | null) {
  const { plan, loc } = await loadSubContext(s.db, sub);
  if (sub.status !== 'active') throw conflict('invalid_state', `This subscription is ${sub.status.replace('_', ' ')}`);
  if (mondayOf(weekStart) !== weekStart) throw validationError('Weeks start on a Monday', { weekStart: 'Must be a Monday' });
  if (weekStart < sub.startWeek) throw validationError('That week is before the subscription starts', { weekStart: 'Before start' });
  const cutoff = cutoffOf(plan, weekStart, loc.timeZone);
  if (cutoff <= new Date()) throw new AppError(409, 'skip_cutoff_passed', `Changes for the week of ${weekStart} closed at the cut-off`, undefined, { cutoffAt: cutoff.toISOString() });
  const already = sub.skippedWeeks.includes(weekStart);
  if (already === skip) return { subscription: sub, changed: false, creditId: null as string | null };
  const provider = subscriptionProvider(s);
  const acct = await connectedAccountFor(s.db, sub.organizationId, sub.locationId);
  const credit = sub.externalId ? await provider.creditWeek(sub.externalId, skip ? sub.priceMinor : -sub.priceMinor, sub.currency, acct.accountId, `${skip ? 'skip' : 'unskip'}:${sub.id}:${weekStart}`) : null;
  const updated = await s.db.transaction(async (tx) => {
    const [row] = await tx.select().from(foodMealPlanSubscriptions).where(eq(foodMealPlanSubscriptions.id, sub.id)).for('update');
    const weeks = skip ? [...new Set([...row!.skippedWeeks, weekStart])].sort() : row!.skippedWeeks.filter((w) => w !== weekStart);
    const [u] = await tx.update(foodMealPlanSubscriptions).set({ skippedWeeks: weeks, updatedAt: new Date() }).where(eq(foodMealPlanSubscriptions.id, sub.id)).returning();
    await tx.update(foodMealPlanBoxes).set({ status: skip ? 'skipped' : 'scheduled' }).where(and(eq(foodMealPlanBoxes.subscriptionId, sub.id), eq(foodMealPlanBoxes.weekStart, weekStart), inArray(foodMealPlanBoxes.status, ['scheduled', 'skipped'])));
    await audit(tx, { organizationId: sub.organizationId, actorUserId, actorType: actorUserId ? 'user' : 'system', action: skip ? 'meal_plan.week_skipped' : 'meal_plan.week_unskipped', scopeKind: 'location', scopeId: sub.locationId, targetType: 'meal_plan_subscription', targetId: sub.id, metadata: { weekStart, creditId: credit?.creditId ?? null } });
    return u!;
  });
  return { subscription: updated, changed: true, creditId: credit?.creditId ?? null };
}

export async function setSubscriptionStatus(s: Services, sub: Sub, to: 'paused' | 'active' | 'cancelled', actorUserId: string | null) {
  const allowed: Record<string, string[]> = { paused: ['active'], active: ['paused'], cancelled: ['active', 'paused', 'past_due', 'pending_payment'] };
  if (!allowed[to]!.includes(sub.status)) throw new AppError(409, 'invalid_transition', `Cannot change a ${sub.status.replace('_', ' ')} subscription to ${to}`);
  const provider = subscriptionProvider(s);
  const acct = await connectedAccountFor(s.db, sub.organizationId, sub.locationId);
  if (sub.externalId) {
    if (to === 'paused') await provider.pause(sub.externalId, acct.accountId);
    else if (to === 'active') await provider.resume(sub.externalId, acct.accountId);
    else await provider.cancel(sub.externalId, acct.accountId);
  }
  const [u] = await s.db.update(foodMealPlanSubscriptions).set({ status: to, cancelledAt: to === 'cancelled' ? new Date() : sub.cancelledAt, updatedAt: new Date() }).where(eq(foodMealPlanSubscriptions.id, sub.id)).returning();
  if (to !== 'active') {
    await s.db.update(foodMealPlanBoxes).set({ status: 'cancelled' }).where(and(eq(foodMealPlanBoxes.subscriptionId, sub.id), eq(foodMealPlanBoxes.status, 'scheduled')));
  }
  await audit(s.db, { organizationId: sub.organizationId, actorUserId, actorType: actorUserId ? 'user' : 'system', action: `meal_plan.${to}`, scopeKind: 'location', scopeId: sub.locationId, targetType: 'meal_plan_subscription', targetId: sub.id });
  return u!;
}

/** Create (or refresh) the box for each active subscription in a week. Skipped weeks get a skipped box. */
export async function generateBoxes(db: Exec, organizationId: string, weekStart: string, locationId?: string) {
  const subs = await db.select().from(foodMealPlanSubscriptions).where(and(eq(foodMealPlanSubscriptions.organizationId, organizationId), eq(foodMealPlanSubscriptions.status, 'active'), lte(foodMealPlanSubscriptions.startWeek, weekStart), ...(locationId ? [eq(foodMealPlanSubscriptions.locationId, locationId)] : [])));
  if (!subs.length) return { created: 0, skipped: 0 };
  const plans = await db.select().from(foodMealPlans).where(inArray(foodMealPlans.id, [...new Set(subs.map((x) => x.planId))]));
  const allItemIds = [...new Set(plans.flatMap((p) => p.menuItemIds))];
  const names = new Map((allItemIds.length ? await db.select({ id: menuItems.id, name: menuItems.name }).from(menuItems).where(inArray(menuItems.id, allItemIds)) : []).map((r) => [r.id, r.name]));
  let created = 0;
  let skipped = 0;
  for (const sub of subs) {
    const plan = plans.find((p) => p.id === sub.planId)!;
    const counts = new Map<string, number>();
    for (let i = 0; i < plan.mealsPerBox && plan.menuItemIds.length; i++) {
      const id = plan.menuItemIds[i % plan.menuItemIds.length]!;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const isSkipped = sub.skippedWeeks.includes(weekStart);
    const rows = await db.insert(foodMealPlanBoxes).values({
      organizationId, locationId: sub.locationId, subscriptionId: sub.id, weekStart, fulfilmentDate: fulfilmentDateOf(plan, weekStart), status: isSkipped ? 'skipped' : 'scheduled',
      items: [...counts.entries()].map(([menuItemId, quantity]) => ({ menuItemId, name: names.get(menuItemId) ?? 'Meal', quantity })),
    }).onConflictDoNothing().returning({ id: foodMealPlanBoxes.id });
    if (rows.length) created++;
    if (isSkipped) skipped++;
  }
  return { created, skipped };
}

/** Send a date's boxes to the kitchen: one accepted meal-plan order per box (already paid by the subscription). */
export async function releaseBoxes(db: Exec, organizationId: string, loc: Location, date: string, actorUserId: string | null) {
  const boxes = await db.select().from(foodMealPlanBoxes).where(and(eq(foodMealPlanBoxes.locationId, loc.id), eq(foodMealPlanBoxes.fulfilmentDate, date), eq(foodMealPlanBoxes.status, 'scheduled')));
  const subs = boxes.length ? await db.select().from(foodMealPlanSubscriptions).where(inArray(foodMealPlanSubscriptions.id, boxes.map((b) => b.subscriptionId))) : [];
  const stations = boxes.length ? new Map((await db.select({ id: menuItems.id, stationKey: menuItems.stationKey }).from(menuItems).where(inArray(menuItems.id, [...new Set(boxes.flatMap((b) => b.items.map((i) => i.menuItemId)))]))).map((r) => [r.id, r.stationKey])) : new Map();
  let released = 0;
  for (const b of boxes) {
    const sub = subs.find((x) => x.id === b.subscriptionId)!;
    const now = new Date().toISOString();
    const [o] = await db.insert(foodOrders).values({
      organizationId, locationId: loc.id, customerId: sub.customerId, orderNumber: `${loc.code}-MP${randomToken(3).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 4)}`,
      status: 'accepted', paymentStatus: 'not_required', channel: 'meal_plan',
      fulfilment: { mealPlanBoxId: b.id, mealPlanSubscriptionId: sub.id, ...(sub.address ? { address: sub.address as never } : {}) },
      lines: b.items.map((i) => ({ menuItemId: i.menuItemId, name: i.name, quantity: i.quantity, unitPriceMinor: 0, modifiers: [], lineTotalMinor: 0, stationKey: stations.get(i.menuItemId) ?? null })),
      subtotalMinor: 0, totalMinor: 0, currency: sub.currency, contact: sub.contact, notes: 'Meal plan box (paid by subscription)',
      promisedAt: zonedToUtc(date, '12:00', loc.timeZone), statusHistory: [{ at: now, from: null, to: 'accepted', by: actorUserId, note: 'Meal plan box released to the kitchen' }],
    }).returning();
    await db.update(foodMealPlanBoxes).set({ status: 'in_production', foodOrderId: o!.id }).where(eq(foodMealPlanBoxes.id, b.id));
    await createKdsTickets(db, o!);
    released++;
  }
  return { released };
}

// ── Stripe subscription events (registered with the payments webhook processor) ──
stripeEventExtensions.push(async (tx: Tx, event: Stripe.Event) => {
  if (!event.type.startsWith('invoice.') && !event.type.startsWith('customer.subscription.')) return null;
  const obj = event.data.object as unknown as Record<string, any>;
  const subId: string | undefined = event.type.startsWith('invoice.')
    ? (typeof obj.subscription === 'string' ? obj.subscription : obj.parent?.subscription_details?.subscription ?? undefined)
    : obj.id;
  if (!subId) return null;
  const [sub] = await tx.select().from(foodMealPlanSubscriptions).where(eq(foodMealPlanSubscriptions.externalId, subId)).for('update');
  if (!sub) return null;
  let to: string | null = null;
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') to = sub.status === 'pending_payment' || sub.status === 'past_due' ? 'active' : null;
  else if (event.type === 'invoice.payment_failed') to = sub.status === 'cancelled' ? null : 'past_due';
  else if (event.type === 'customer.subscription.deleted') to = 'cancelled';
  else if (event.type === 'customer.subscription.updated') to = (obj.status === 'past_due' || obj.status === 'unpaid') && sub.status === 'active' ? 'past_due' : obj.status === 'canceled' && sub.status !== 'cancelled' ? 'cancelled' : null;
  if (to) {
    await tx.update(foodMealPlanSubscriptions).set({ status: to, cancelledAt: to === 'cancelled' ? new Date() : sub.cancelledAt, updatedAt: new Date() }).where(eq(foodMealPlanSubscriptions.id, sub.id));
    await audit(tx, { organizationId: sub.organizationId, actorUserId: null, actorType: 'webhook', action: `meal_plan.${to}`, scopeKind: 'location', scopeId: sub.locationId, targetType: 'meal_plan_subscription', targetId: sub.id, metadata: { eventId: event.id, type: event.type } });
    if (to === 'active') {
      const [plan] = await tx.select().from(foodMealPlans).where(eq(foodMealPlans.id, sub.planId));
      const [loc] = await tx.select().from(locations).where(eq(locations.id, sub.locationId));
      if (plan && loc) for (const w of [sub.startWeek, addDays(sub.startWeek, 7)]) await generateBoxes(tx, sub.organizationId, w, loc.id);
    }
  }
  return { note: to ? `Meal plan subscription ${to}` : 'Meal plan event recorded (no change)', organizationId: sub.organizationId };
});

/** Sandbox: simulate the provider confirming the first invoice, through the normal webhook processor. */
export async function sandboxActivate(s: Services, sub: Sub, outcome: 'paid' | 'failed' = 'paid') {
  if (!sub.sandbox || !sub.externalId) throw conflict('not_sandbox', 'Only sandbox subscriptions can be simulated');
  const event = {
    id: `evt_sandbox_${randomToken(10)}`, object: 'event', type: outcome === 'paid' ? 'invoice.paid' : 'invoice.payment_failed', created: Math.floor(Date.now() / 1000), livemode: false,
    api_version: null, pending_webhooks: 0, request: { id: null, idempotency_key: null },
    data: { object: { id: `in_sandbox_${randomToken(8)}`, object: 'invoice', subscription: sub.externalId, amount_paid: outcome === 'paid' ? sub.priceMinor : 0, currency: sub.currency.toLowerCase() } },
  } as unknown as Stripe.Event;
  return processStripeEvent(s, event);
}

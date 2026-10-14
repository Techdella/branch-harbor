import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import {
  customers, locations, memberships, membershipInvoices, onlineContent, packs, paymentReferences, studioFees, studioMembershipPlans, studioOffers, studioPackProducts, studioPurchases,
} from '../db/schema/index.ts';
import { studioBilling } from '../integrations/studio-billing.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { checkOfferEligibility } from '../routes/offers.ts';
import { audit } from './audit.ts';
import { connectedAccountFor, createPaymentForTarget } from './payments.ts';
import { expirePacks, membershipState } from './studios-entitlements.ts';
import { fulfilPurchase, recordRenewal } from './studios-fulfil.ts';
import { dispatchCustomerNotifications, enqueueCustomerNotifications } from './studios-notify.ts';

type Loc = typeof locations.$inferSelect;
type Membership = typeof memberships.$inferSelect;
type Pack = typeof packs.$inferSelect;
const DAY = 86400_000;

export type PurchaseKind = 'pack' | 'membership' | 'offer' | 'online' | 'fee';

export function serializePack(p: Pack, now = new Date()) {
  const expired = !!p.expiresAt && p.expiresAt <= now;
  return {
    id: p.id, name: p.name, locationId: p.locationId, creditsTotal: p.creditsTotal, creditsRemaining: p.creditsRemaining, expiresAt: p.expiresAt?.toISOString() ?? null,
    status: expired && p.status === 'active' ? 'expired' : p.status, transferPolicy: p.transferPolicy, allowedLocationIds: p.allowedLocationIds, source: p.source,
    price: p.priceMinor !== null && p.currency ? { amount: p.priceMinor, currency: p.currency } : null, createdAt: p.createdAt.toISOString(),
  };
}

export function serializeMembership(m: Membership, now = new Date()) {
  return {
    id: m.id, name: m.plan, planId: m.planId, locationId: m.locationId, status: m.status, state: membershipState(m, now), recurring: m.recurring, classesPerPeriod: m.classesPerPeriod,
    accessPolicy: m.accessPolicy, allowedLocationIds: m.allowedLocationIds, price: m.priceMinor !== null && m.currency ? { amount: m.priceMinor, currency: m.currency, interval: m.recurring ? 'month' : null } : null,
    startsAt: m.startsAt.toISOString(), endsAt: m.endsAt?.toISOString() ?? null, currentPeriodStart: m.currentPeriodStart?.toISOString() ?? null, currentPeriodEnd: m.currentPeriodEnd?.toISOString() ?? null,
    pausedFrom: m.pausedFrom?.toISOString() ?? null, pausedUntil: m.pausedUntil?.toISOString() ?? null, cancelAt: m.cancelAt?.toISOString() ?? null, graceUntil: m.graceUntil?.toISOString() ?? null,
    failedAttempts: m.failedAttempts, billing: m.stripeSubscriptionId ? (m.stripeSubscriptionId.startsWith('sub_sandbox_') ? 'sandbox' : 'stripe') : m.recurring ? 'pending_setup' : 'none',
  };
}

const priceIn = (prices: Record<string, number>, currency: string) => prices[currency];

/** Products and plans a location sells (its own + network-wide), priced in its currency. */
export async function pricingFor(db: Exec, loc: Loc) {
  const [pp, mp, offers] = await Promise.all([
    db.select().from(studioPackProducts).where(and(eq(studioPackProducts.organizationId, loc.organizationId), eq(studioPackProducts.status, 'active'), or(isNull(studioPackProducts.locationId), eq(studioPackProducts.locationId, loc.id)))),
    db.select().from(studioMembershipPlans).where(and(eq(studioMembershipPlans.organizationId, loc.organizationId), eq(studioMembershipPlans.status, 'active'), or(isNull(studioMembershipPlans.locationId), eq(studioMembershipPlans.locationId, loc.id)))),
    db.select().from(studioOffers).where(and(eq(studioOffers.organizationId, loc.organizationId), eq(studioOffers.status, 'active'), or(isNull(studioOffers.locationId), eq(studioOffers.locationId, loc.id)))),
  ]);
  const accessText = (policy: string, n: number) => policy === 'any_location' ? 'Valid at every location' : policy === 'same_currency' ? `Valid at every ${loc.currency} location` : policy === 'listed' ? `Valid at ${n} selected location${n === 1 ? '' : 's'}` : `Valid at ${loc.name} only`;
  return {
    packs: pp.filter((p) => priceIn(p.prices, loc.currency) !== undefined).map((p) => ({
      id: p.id, name: p.name, description: p.description, credits: p.credits, validityDays: p.validityDays, price: { amount: priceIn(p.prices, loc.currency)!, currency: loc.currency },
      perClass: { amount: Math.round(priceIn(p.prices, loc.currency)! / p.credits), currency: loc.currency }, transferPolicy: p.transferPolicy, access: accessText(p.transferPolicy, p.allowedLocationIds.length), scope: p.locationId ? 'location' : 'network',
    })).sort((a, b) => a.credits - b.credits),
    memberships: mp.filter((p) => priceIn(p.prices, loc.currency) !== undefined).map((p) => ({
      id: p.id, name: p.name, description: p.description, classesPerPeriod: p.classesPerPeriod, price: { amount: priceIn(p.prices, loc.currency)!, currency: loc.currency, interval: 'month' as const },
      accessPolicy: p.accessPolicy, access: accessText(p.accessPolicy, p.allowedLocationIds.length), noticeDays: p.noticeDays, maxPauseDays: p.maxPauseDays, graceDays: p.graceDays, scope: p.locationId ? 'location' : 'network',
      terms: [`Billed monthly in ${loc.currency} until cancelled.`, `Cancel with ${p.noticeDays} days' notice.`, p.maxPauseDays ? `Pause for up to ${p.maxPauseDays} days at a time.` : 'Pausing is not available.', p.classesPerPeriod ? `${p.classesPerPeriod} classes per month; unused classes do not roll over.` : 'Unlimited classes.'],
    })).sort((a, b) => a.price.amount - b.price.amount),
    offers: offers.filter((o) => priceIn(o.prices, loc.currency) !== undefined && (!o.startsAt || o.startsAt <= new Date()) && (!o.endsAt || o.endsAt > new Date()) && (!o.locationId || o.locationId === loc.id) && (!o.eligibility.locationIds?.length || o.eligibility.locationIds.includes(loc.id))).map((o) => ({
      id: o.id, name: o.name, description: o.description, kind: o.kind, credits: o.credits, validDays: o.validDays, price: { amount: priceIn(o.prices, loc.currency)!, currency: loc.currency }, newCustomersOnly: !!o.eligibility.newCustomersOnly,
    })),
  };
}

export interface PurchaseInput { organizationId: string; loc: Loc; customerId: string; kind: PurchaseKind; productId?: string; offerId?: string; source: string; actorUserId: string | null }

/**
 * Start a checkout. Prices come from the server (never the client), in the location currency. Free items are
 * fulfilled immediately; paid ones return a PaymentIntent (sandbox without Stripe keys) and are fulfilled by the
 * signed payment webhook.
 */
export async function createPurchase(s: Services, i: PurchaseInput) {
  const { loc } = i;
  const [cust] = await s.db.select().from(customers).where(and(eq(customers.id, i.customerId), eq(customers.organizationId, i.organizationId)));
  if (!cust || cust.erasedAt) throw notFound('Customer');
  let name = '';
  let list = 0;
  let productId: string | null = null;
  let offerId: string | null = null;
  switch (i.kind) {
    case 'pack': {
      const [p] = await s.db.select().from(studioPackProducts).where(and(eq(studioPackProducts.id, i.productId ?? ''), eq(studioPackProducts.organizationId, i.organizationId)));
      if (!p || p.status !== 'active' || (p.locationId && p.locationId !== loc.id)) throw notFound('Class pack');
      const price = priceIn(p.prices, loc.currency);
      if (price === undefined) throw conflict('no_price_in_currency', `${p.name} is not sold in ${loc.currency} at ${loc.name}`);
      name = `${p.name} (${p.credits} credits)`; list = price; productId = p.id;
      break;
    }
    case 'membership': {
      const [p] = await s.db.select().from(studioMembershipPlans).where(and(eq(studioMembershipPlans.id, i.productId ?? ''), eq(studioMembershipPlans.organizationId, i.organizationId)));
      if (!p || p.status !== 'active' || (p.locationId && p.locationId !== loc.id)) throw notFound('Membership plan');
      const price = priceIn(p.prices, loc.currency);
      if (price === undefined) throw conflict('no_price_in_currency', `${p.name} is not sold in ${loc.currency} at ${loc.name}`);
      const [dupe] = await s.db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.customerId, cust.id), eq(memberships.planId, p.id), inArray(memberships.status, ['active', 'grace', 'paused', 'pending', 'suspended'])));
      if (dupe) throw conflict('already_member', 'You already have this membership', { membershipId: dupe.id });
      name = `${p.name} (monthly)`; list = price; productId = p.id;
      break;
    }
    case 'offer': {
      const [o] = await s.db.select().from(studioOffers).where(and(eq(studioOffers.id, i.offerId ?? ''), eq(studioOffers.organizationId, i.organizationId)));
      if (!o) throw notFound('Offer');
      const r = await checkOfferEligibility(s.db, o, loc, cust.id);
      if (!r.eligible) throw new AppError(409, 'not_eligible', r.reasons.map((x) => x.message).join('; '), undefined, { reasons: r.reasons });
      name = o.name; list = r.price!.amount; offerId = o.id;
      // Only one unpaid checkout per offer and customer at a time (prevents double redemption).
      const [pending] = await s.db.select({ id: studioPurchases.id }).from(studioPurchases).where(and(eq(studioPurchases.offerId, o.id), eq(studioPurchases.customerId, cust.id), eq(studioPurchases.status, 'pending')));
      if (pending) await s.db.update(studioPurchases).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(studioPurchases.id, pending.id));
      break;
    }
    case 'online': {
      const [c] = await s.db.select().from(onlineContent).where(and(eq(onlineContent.id, i.productId ?? ''), eq(onlineContent.organizationId, i.organizationId), eq(onlineContent.status, 'published')));
      if (!c || (c.locationId && c.locationId !== loc.id)) throw notFound('Online class');
      const price = priceIn(c.prices, loc.currency);
      if (price === undefined) throw conflict('not_for_sale', 'This online class is not sold individually');
      name = c.title; list = price; productId = c.id;
      break;
    }
    case 'fee': {
      const [f] = await s.db.select().from(studioFees).where(and(eq(studioFees.id, i.productId ?? ''), eq(studioFees.customerId, cust.id)));
      if (!f) throw notFound('Fee');
      if (f.status !== 'due') throw conflict('fee_not_due', `This fee is ${f.status}`);
      if (f.locationId !== loc.id) throw validationError('Pay the fee at the location that charged it');
      name = f.kind === 'no_show' ? 'No-show fee' : 'Late cancellation fee'; list = f.amountMinor; productId = f.id;
      break;
    }
  }
  const [pu] = await s.db.insert(studioPurchases).values({
    organizationId: i.organizationId, locationId: loc.id, customerId: cust.id, kind: i.kind, productId, offerId, name, listPriceMinor: list, discountMinor: 0, amountMinor: list,
    currency: loc.currency, status: 'pending', source: i.source, createdBy: i.actorUserId,
  }).returning();
  await audit(s.db, { organizationId: i.organizationId, actorUserId: i.actorUserId, action: 'studio_purchase.created', scopeKind: 'location', scopeId: loc.id, targetType: 'studio_purchase', targetId: pu!.id, metadata: { kind: i.kind, amount: list, currency: loc.currency } });
  if (list === 0) {
    const r = await s.db.transaction((tx) => fulfilPurchase(tx, pu!.id, null));
    return { purchase: { ...pu!, status: 'paid', resultId: r.resultId ?? null }, payment: null };
  }
  try {
    const pay = await createPaymentForTarget(s, { organizationId: i.organizationId, locationId: loc.id, amountMinor: list, currency: loc.currency, targetType: 'studio_purchase', targetId: pu!.id, description: name, recordSnapshot: { purchaseId: pu!.id, kind: i.kind } });
    await s.db.update(studioPurchases).set({ paymentId: pay.payment.id }).where(eq(studioPurchases.id, pu!.id));
    return { purchase: { ...pu!, paymentId: pay.payment.id }, payment: { id: pay.payment.id, clientSecret: pay.clientSecret, amount: list, currency: loc.currency, sandbox: pay.sandbox } };
  } catch (err) {
    await s.db.update(studioPurchases).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(studioPurchases.id, pu!.id));
    throw err;
  }
}

export function serializePurchase(p: typeof studioPurchases.$inferSelect) {
  return { id: p.id, kind: p.kind, name: p.name, status: p.status, amount: { amount: p.amountMinor, currency: p.currency }, listPrice: { amount: p.listPriceMinor, currency: p.currency }, paymentId: p.paymentId, resultId: p.resultId, locationId: p.locationId, createdAt: p.createdAt.toISOString(), paidAt: p.paidAt?.toISOString() ?? null };
}

// ───────────── Membership actions ─────────────

async function planOf(db: Exec, m: Membership) {
  if (!m.planId) return null;
  const [p] = await db.select().from(studioMembershipPlans).where(eq(studioMembershipPlans.id, m.planId));
  return p ?? null;
}

export async function pauseMembership(s: Services, m: Membership, input: { from: Date; until: Date; reason?: string; actorUserId: string | null }) {
  const plan = await planOf(s.db, m);
  const days = Math.ceil((input.until.getTime() - input.from.getTime()) / DAY);
  if (!m.recurring) throw conflict('pause_not_allowed', 'Trial memberships cannot be paused');
  if (!['active', 'grace'].includes(m.status) || (m.cancelAt && m.cancelAt <= input.from)) throw conflict('membership_not_active', `Membership is ${membershipState(m)}`);
  if (input.until <= input.from) throw validationError('The pause must end after it starts', { until: 'Invalid' });
  if (input.from.getTime() < Date.now() - 60_000) throw validationError('A pause cannot start in the past', { from: 'Invalid' });
  const max = plan?.maxPauseDays ?? 60;
  if (!max) throw conflict('pause_not_allowed', 'This membership cannot be paused');
  if (days > max) throw validationError(`Pauses can last up to ${max} days`, { until: `Max ${max} days` });
  // Billing is deferred by the pause length (the paid period is extended).
  const periodEnd = m.currentPeriodEnd && m.currentPeriodEnd > input.from ? new Date(m.currentPeriodEnd.getTime() + days * DAY) : m.currentPeriodEnd;
  const [u] = await s.db.update(memberships).set({ pausedFrom: input.from, pausedUntil: input.until, pauseReason: input.reason ?? null, currentPeriodEnd: periodEnd, updatedAt: new Date() }).where(eq(memberships.id, m.id)).returning();
  if (m.stripeSubscriptionId) await studioBilling(s.cfg).pauseCollection({ subscriptionId: m.stripeSubscriptionId, connectedAccountId: (await connectedAccountFor(s.db, m.organizationId, m.locationId!)).accountId, resumesAt: input.until });
  await audit(s.db, { organizationId: m.organizationId, actorUserId: input.actorUserId, action: 'membership.paused', scopeKind: 'location', scopeId: m.locationId, targetType: 'membership', targetId: m.id, metadata: { from: input.from.toISOString(), until: input.until.toISOString(), days } });
  return u!;
}

export async function resumeMembership(s: Services, m: Membership, actorUserId: string | null) {
  if (!m.pausedUntil || m.pausedUntil <= new Date()) throw conflict('not_paused', 'Membership is not paused');
  const now = new Date();
  const unused = Math.max(0, m.pausedUntil.getTime() - Math.max(now.getTime(), m.pausedFrom?.getTime() ?? now.getTime()));
  const [u] = await s.db.update(memberships).set({ pausedUntil: m.pausedFrom && m.pausedFrom > now ? null : now, pausedFrom: m.pausedFrom && m.pausedFrom > now ? null : m.pausedFrom, currentPeriodEnd: m.currentPeriodEnd ? new Date(m.currentPeriodEnd.getTime() - unused) : null, updatedAt: now }).where(eq(memberships.id, m.id)).returning();
  if (m.stripeSubscriptionId) await studioBilling(s.cfg).pauseCollection({ subscriptionId: m.stripeSubscriptionId, connectedAccountId: (await connectedAccountFor(s.db, m.organizationId, m.locationId!)).accountId, resumesAt: null });
  await audit(s.db, { organizationId: m.organizationId, actorUserId, action: 'membership.resumed', scopeKind: 'location', scopeId: m.locationId, targetType: 'membership', targetId: m.id });
  return u!;
}

/** Cancel with the plan's notice period (access and billing continue until then). Staff may end immediately. */
export async function cancelMembership(s: Services, m: Membership, input: { actorUserId: string | null; immediate?: boolean; reason?: string }) {
  if (['cancelled'].includes(m.status)) throw conflict('membership_cancelled', 'Membership is already cancelled');
  if (m.cancelAt && !input.immediate) throw conflict('cancellation_pending', `Membership already ends on ${m.cancelAt.toISOString().slice(0, 10)}`);
  const plan = await planOf(s.db, m);
  const now = new Date();
  const cancelAt = input.immediate || !m.recurring ? now : new Date(now.getTime() + (plan?.noticeDays ?? 30) * DAY);
  const [u] = await s.db.update(memberships).set(input.immediate ? { status: 'cancelled', cancelAt, cancelRequestedAt: now, endsAt: now, updatedAt: now } : { cancelAt, cancelRequestedAt: now, updatedAt: now }).where(eq(memberships.id, m.id)).returning();
  if (m.stripeSubscriptionId) await studioBilling(s.cfg).cancelSubscription({ subscriptionId: m.stripeSubscriptionId, connectedAccountId: (await connectedAccountFor(s.db, m.organizationId, m.locationId!)).accountId, at: input.immediate ? 'now' : cancelAt });
  await audit(s.db, { organizationId: m.organizationId, actorUserId: input.actorUserId, action: input.immediate ? 'membership.cancelled' : 'membership.cancellation_requested', scopeKind: 'location', scopeId: m.locationId, targetType: 'membership', targetId: m.id, metadata: { cancelAt: cancelAt.toISOString(), reason: input.reason } });
  return u!;
}

/** Charge the next renewal now. Sandbox only: `outcome` simulates the provider's answer. */
export async function chargeRenewalSandbox(s: Services, membershipId: string, outcome: 'succeeded' | 'failed') {
  const out = await s.db.transaction(async (tx) => {
    const [m] = await tx.select().from(memberships).where(eq(memberships.id, membershipId)).for('update');
    if (!m) throw notFound('Membership');
    if (!m.recurring) throw conflict('not_recurring', 'This membership does not renew');
    if (['cancelled', 'pending'].includes(m.status)) throw conflict('membership_not_active', `Membership is ${m.status}`);
    let paymentId: string | null = null;
    if (outcome === 'succeeded') {
      const [ref] = await tx.insert(paymentReferences).values({
        organizationId: m.organizationId, locationId: m.locationId, provider: 'stripe', externalId: `in_sandbox_${randomBytes(8).toString('hex')}`, amountMinor: m.priceMinor ?? 0, currency: m.currency ?? 'USD',
        state: 'succeeded', succeededAt: new Date(), targetType: 'membership_invoice', sandbox: 1,
      }).returning();
      paymentId = ref!.id;
    }
    const r = await recordRenewal(tx, m, { outcome: outcome === 'succeeded' ? 'paid' : 'failed', paymentId, failureReason: outcome === 'failed' ? 'Card declined (sandbox)' : null });
    if (paymentId) await tx.update(paymentReferences).set({ targetId: r.invoice.id }).where(eq(paymentReferences.id, paymentId));
    return r;
  });
  await dispatchCustomerNotifications(s);
  return out;
}

/**
 * Membership lifecycle sweep (runs every minute with the hold-expiry job):
 * pauses ending, notice periods reaching their date, grace periods elapsing (→ suspended), fixed-term
 * trials ending, sandbox renewals and live subscription setup; also expires packs and dispatches queued notifications.
 */
export async function runStudioLifecycle(s: Services, now = new Date()) {
  const stats = { cancelled: 0, suspended: 0, ended: 0, renewed: 0, subscriptions: 0, packsExpired: 0 };
  await s.db.update(memberships).set({ pausedFrom: null, pausedUntil: null, updatedAt: now }).where(and(sql`${memberships.pausedUntil} is not null`, lte(memberships.pausedUntil, now)));
  stats.cancelled = (await s.db.update(memberships).set({ status: 'cancelled', endsAt: sql`${memberships.cancelAt}`, updatedAt: now }).where(and(inArray(memberships.status, ['active', 'grace', 'suspended']), lte(memberships.cancelAt, now))).returning({ id: memberships.id })).length;
  stats.ended = (await s.db.update(memberships).set({ status: 'cancelled', updatedAt: now }).where(and(eq(memberships.status, 'active'), eq(memberships.recurring, false), lte(memberships.endsAt, now))).returning({ id: memberships.id })).length;
  const lapsed = await s.db.update(memberships).set({ status: 'suspended', updatedAt: now }).where(and(eq(memberships.status, 'grace'), lte(memberships.graceUntil, now))).returning();
  stats.suspended = lapsed.length;
  for (const m of lapsed) {
    await enqueueCustomerNotifications(s.db, { organizationId: m.organizationId, locationId: m.locationId!, customerIds: [m.customerId], kind: 'membership_changed', subject: `Membership on hold: ${m.plan}`, body: `Your ${m.plan} membership is on hold because the renewal payment could not be taken. Update your payment details to book again.` });
    await audit(s.db, { organizationId: m.organizationId, actorUserId: null, actorType: 'system', action: 'membership.suspended', scopeKind: 'location', scopeId: m.locationId, targetType: 'membership', targetId: m.id });
  }
  const billing = studioBilling(s.cfg);
  if (billing.mode === 'sandbox') {
    const due = await s.db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.recurring, true), eq(memberships.status, 'active'), lte(memberships.currentPeriodEnd, now),
      or(isNull(memberships.cancelAt), sql`${memberships.cancelAt} > ${memberships.currentPeriodEnd}`), or(isNull(memberships.pausedFrom), sql`not (${memberships.pausedFrom} <= now() and ${memberships.pausedUntil} > now())`))).limit(200);
    for (const d of due) {
      await chargeRenewalSandbox(s, d.id, 'succeeded').catch((err) => s.log.warn({ err, id: d.id }, '[studios] sandbox renewal failed'));
      stats.renewed++;
    }
  } else {
    // Live: create the provider subscription for memberships whose first period was paid at checkout.
    const pending = await s.db.select().from(memberships).where(and(eq(memberships.recurring, true), eq(memberships.status, 'active'), isNull(memberships.stripeSubscriptionId), isNull(memberships.cancelAt))).limit(50);
    for (const m of pending) {
      try {
        const acct = await connectedAccountFor(s.db, m.organizationId, m.locationId!);
        const [c] = await s.db.select().from(customers).where(eq(customers.id, m.customerId));
        const sub = await billing.createSubscription({ connectedAccountId: acct.accountId, email: c?.email ?? null, name: c?.name ?? 'Member', amountMinor: m.priceMinor ?? 0, currency: m.currency ?? acct.location.currency, productName: m.plan, firstBillingAt: m.currentPeriodEnd ?? new Date(now.getTime() + 30 * DAY), applicationFeePercent: (acct.feeBps ?? 0) / 100, metadata: { bh_org: m.organizationId, bh_location: m.locationId ?? '', bh_membership: m.id }, idempotencyKey: `membership:${m.id}` });
        await s.db.update(memberships).set({ stripeCustomerId: sub.customerId, stripeSubscriptionId: sub.subscriptionId, updatedAt: new Date() }).where(eq(memberships.id, m.id));
        stats.subscriptions++;
      } catch (err) {
        s.log.error({ err, membershipId: m.id }, '[studios] subscription setup failed');
      }
    }
  }
  // Sandbox subscriptions get a fake id at first renewal time so the UI shows where billing runs.
  if (billing.mode === 'sandbox') await s.db.update(memberships).set({ stripeSubscriptionId: sql`'sub_sandbox_' || substr(md5(${memberships.id}::text), 1, 12)` }).where(and(eq(memberships.recurring, true), isNull(memberships.stripeSubscriptionId), inArray(memberships.status, ['active', 'grace'])));
  stats.packsExpired = await expirePacks(s.db, now);
  await dispatchCustomerNotifications(s);
  return stats;
}

/** Staff: add (comp) credits to a customer. */
export async function grantCredits(s: Services, input: { organizationId: string; locationId: string; customerId: string; credits: number; validityDays: number; reason: string; actorUserId: string }) {
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, input.locationId));
  const [p] = await s.db.insert(packs).values({
    organizationId: input.organizationId, locationId: input.locationId, customerId: input.customerId, name: `Complimentary credits (${input.reason})`.slice(0, 120), creditsTotal: input.credits, creditsRemaining: input.credits,
    expiresAt: new Date(Date.now() + input.validityDays * DAY), priceMinor: 0, currency: loc?.currency ?? null, transferPolicy: 'home_only', source: 'comp', status: 'active',
  }).returning();
  await audit(s.db, { organizationId: input.organizationId, actorUserId: input.actorUserId, action: 'pack.comp_granted', scopeKind: 'location', scopeId: input.locationId, targetType: 'pack', targetId: p!.id, metadata: { credits: input.credits, reason: input.reason } });
  return p!;
}

export async function invoicesFor(db: Exec, membershipId: string) {
  return db.select().from(membershipInvoices).where(eq(membershipInvoices.membershipId, membershipId)).orderBy(membershipInvoices.periodStart);
}

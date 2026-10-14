/**
 * Fulfilment of studio purchases and membership billing outcomes. Runs inside the payment / webhook
 * transaction (called from services/payments.ts), so it must not import that module.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { Exec, Tx } from '../db/client.ts';
import {
  memberships, membershipInvoices, offerRedemptions, onlineAccessGrants, packs, paymentReferences, studioFees, studioMembershipPlans, studioOffers, studioPackProducts, studioPurchases,
} from '../db/schema/index.ts';
import { audit } from './audit.ts';
import { addMonthsUtc } from './studios-entitlements.ts';
import { enqueueCustomerNotifications } from './studios-notify.ts';

type Purchase = typeof studioPurchases.$inferSelect;
type Membership = typeof memberships.$inferSelect;
type PaymentRow = typeof paymentReferences.$inferSelect;

const DAY = 86400_000;

/** Create the record a paid (or free) purchase stands for. Idempotent: a paid purchase is fulfilled once. */
export async function fulfilPurchase(tx: Exec, purchaseId: string, paymentId: string | null, now = new Date()): Promise<{ fulfilled: boolean; note: string; resultId?: string }> {
  const [pu] = await tx.select().from(studioPurchases).where(eq(studioPurchases.id, purchaseId)).for('update');
  if (!pu) return { fulfilled: false, note: 'Purchase record missing' };
  if (pu.status === 'paid' && pu.resultId) return { fulfilled: true, note: 'Already fulfilled', resultId: pu.resultId };
  if (pu.status === 'cancelled' || pu.status === 'refunded') return { fulfilled: false, note: `Purchase is ${pu.status}` };
  let resultId: string | null = null;
  let note = '';
  switch (pu.kind) {
    case 'pack': {
      const [prod] = await tx.select().from(studioPackProducts).where(eq(studioPackProducts.id, pu.productId!));
      if (!prod) return { fulfilled: false, note: 'Pack product missing' };
      const [p] = await tx.insert(packs).values({
        organizationId: pu.organizationId, locationId: pu.locationId, customerId: pu.customerId, name: prod.name, creditsTotal: prod.credits, creditsRemaining: prod.credits,
        expiresAt: new Date(now.getTime() + prod.validityDays * DAY), crossLocation: prod.transferPolicy !== 'home_only', priceMinor: pu.amountMinor, currency: pu.currency,
        productId: prod.id, transferPolicy: prod.transferPolicy, allowedLocationIds: prod.allowedLocationIds, purchaseId: pu.id, source: 'purchase', status: 'active',
      }).returning();
      resultId = p!.id;
      note = `Pack of ${prod.credits} credits issued`;
      break;
    }
    case 'membership': {
      const [plan] = await tx.select().from(studioMembershipPlans).where(eq(studioMembershipPlans.id, pu.productId!));
      if (!plan) return { fulfilled: false, note: 'Membership plan missing' };
      const end = addMonthsUtc(now, 1);
      const [m] = await tx.insert(memberships).values({
        organizationId: pu.organizationId, locationId: pu.locationId, customerId: pu.customerId, plan: plan.name, status: 'active', crossLocation: plan.accessPolicy !== 'home_only',
        priceMinor: pu.listPriceMinor, currency: pu.currency, startsAt: now, planId: plan.id, classesPerPeriod: plan.classesPerPeriod, accessPolicy: plan.accessPolicy, allowedLocationIds: plan.allowedLocationIds,
        recurring: true, currentPeriodStart: now, currentPeriodEnd: end, purchaseId: pu.id,
      }).returning();
      await tx.insert(membershipInvoices).values({ organizationId: pu.organizationId, membershipId: m!.id, periodStart: now, periodEnd: end, amountMinor: pu.amountMinor, currency: pu.currency, status: 'paid', attempts: 1, paymentId, paidAt: now });
      resultId = m!.id;
      note = 'Membership active';
      break;
    }
    case 'offer': {
      const [offer] = await tx.select().from(studioOffers).where(eq(studioOffers.id, pu.offerId!));
      if (!offer) return { fulfilled: false, note: 'Offer missing' };
      await tx.insert(offerRedemptions).values({ organizationId: pu.organizationId, offerId: offer.id, customerId: pu.customerId, locationId: pu.locationId });
      if (offer.kind === 'trial_membership') {
        const [m] = await tx.insert(memberships).values({
          organizationId: pu.organizationId, locationId: pu.locationId, customerId: pu.customerId, plan: offer.name, status: 'active', priceMinor: pu.amountMinor, currency: pu.currency,
          startsAt: now, endsAt: new Date(now.getTime() + offer.validDays * DAY), offerId: offer.id, classesPerPeriod: null, accessPolicy: 'home_only', recurring: false,
          currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + offer.validDays * DAY), purchaseId: pu.id,
        }).returning();
        resultId = m!.id;
        note = 'Trial membership active';
      } else {
        const credits = offer.credits ?? 1;
        const [p] = await tx.insert(packs).values({
          organizationId: pu.organizationId, locationId: pu.locationId, customerId: pu.customerId, name: offer.name, creditsTotal: credits, creditsRemaining: credits,
          expiresAt: new Date(now.getTime() + offer.validDays * DAY), priceMinor: pu.amountMinor, currency: pu.currency, offerId: offer.id, transferPolicy: 'home_only', purchaseId: pu.id, source: 'offer', status: 'active',
        }).returning();
        resultId = p!.id;
        note = `Intro offer: ${credits} credit${credits === 1 ? '' : 's'} issued`;
      }
      break;
    }
    case 'online': {
      const [g] = await tx.insert(onlineAccessGrants).values({ organizationId: pu.organizationId, contentId: pu.productId!, customerId: pu.customerId, kind: 'purchase', basis: 'purchase', purchaseId: pu.id }).onConflictDoNothing().returning();
      if (g) resultId = g.id;
      else {
        const [existing] = await tx.select({ id: onlineAccessGrants.id }).from(onlineAccessGrants).where(and(eq(onlineAccessGrants.contentId, pu.productId!), eq(onlineAccessGrants.customerId, pu.customerId), sql`${onlineAccessGrants.revokedAt} is null`));
        resultId = existing?.id ?? null;
      }
      note = 'Online class unlocked';
      break;
    }
    case 'fee': {
      const [f] = await tx.update(studioFees).set({ status: 'paid', purchaseId: pu.id, updatedAt: now }).where(eq(studioFees.id, pu.productId!)).returning();
      resultId = f?.id ?? null;
      note = 'Fee paid';
      break;
    }
    default:
      return { fulfilled: false, note: `Unknown purchase kind ${pu.kind}` };
  }
  await tx.update(studioPurchases).set({ status: 'paid', paymentId, paidAt: now, resultId, updatedAt: now }).where(eq(studioPurchases.id, pu.id));
  await audit(tx, { organizationId: pu.organizationId, actorUserId: null, actorType: paymentId ? 'webhook' : 'system', action: `studio_purchase.fulfilled`, scopeKind: 'location', scopeId: pu.locationId, targetType: 'studio_purchase', targetId: pu.id, metadata: { kind: pu.kind, resultId, note } });
  return { fulfilled: true, note, resultId: resultId ?? undefined };
}

export async function fulfilStudioPayment(tx: Tx, p: PaymentRow) {
  if (p.targetType === 'studio_purchase' && p.targetId) return fulfilPurchase(tx, p.targetId, p.id);
  if (p.targetType === 'membership_invoice') return { fulfilled: true, note: 'Membership renewal recorded' };
  return { fulfilled: false, note: `Unknown target ${p.targetType}` };
}

export async function failStudioPayment(tx: Exec, p: PaymentRow) {
  if (p.targetType === 'studio_purchase' && p.targetId) await tx.update(studioPurchases).set({ status: 'failed', updatedAt: new Date() }).where(and(eq(studioPurchases.id, p.targetId), eq(studioPurchases.status, 'pending')));
}

/** Payment ids whose studio record is in order (for the reconciliation queue). */
export async function studioTargetsInOrder(db: Exec, pays: PaymentRow[]): Promise<Set<string>> {
  const ok = new Set<string>();
  const pIds = pays.filter((p) => p.targetType === 'studio_purchase' && p.targetId).map((p) => p.targetId!);
  const iIds = pays.filter((p) => p.targetType === 'membership_invoice' && p.targetId).map((p) => p.targetId!);
  const purchases = pIds.length ? await db.select({ id: studioPurchases.id, status: studioPurchases.status, resultId: studioPurchases.resultId }).from(studioPurchases).where(inArray(studioPurchases.id, pIds)) : [];
  const invoices = iIds.length ? await db.select({ id: membershipInvoices.id, status: membershipInvoices.status }).from(membershipInvoices).where(inArray(membershipInvoices.id, iIds)) : [];
  for (const p of pays) {
    if (p.targetType === 'studio_purchase' && purchases.some((x) => x.id === p.targetId && (x.status === 'paid' || x.status === 'refunded') && x.resultId)) ok.add(p.id);
    if (p.targetType === 'membership_invoice' && invoices.some((x) => x.id === p.targetId && x.status === 'paid')) ok.add(p.id);
  }
  return ok;
}

// ───────────── Membership renewal outcomes ─────────────

export interface RenewalOutcome { outcome: 'paid' | 'failed'; externalId?: string | null; paymentId?: string | null; failureReason?: string | null; amountMinor?: number }

/**
 * Record the result of a renewal charge for the period starting at the membership's current period end.
 * Paid → next period, back to active (also from grace/suspended). Failed → grace (still usable) until
 * graceUntil; the lifecycle sweep suspends after that.
 */
export async function recordRenewal(tx: Exec, m: Membership, r: RenewalOutcome, now = new Date()) {
  const periodStart = m.currentPeriodEnd ?? now;
  const periodEnd = addMonthsUtc(periodStart, 1);
  const [plan] = m.planId ? await tx.select().from(studioMembershipPlans).where(eq(studioMembershipPlans.id, m.planId)) : [];
  const amount = r.amountMinor ?? m.priceMinor ?? 0;
  const currency = m.currency ?? 'USD';
  const [existing] = await tx.select().from(membershipInvoices).where(and(eq(membershipInvoices.membershipId, m.id), eq(membershipInvoices.periodStart, periodStart))).for('update');
  if (existing?.status === 'paid') return { invoice: existing, membership: m, duplicate: true };
  const values = { status: r.outcome === 'paid' ? 'paid' : 'failed', attempts: (existing?.attempts ?? 0) + 1, paymentId: r.paymentId ?? existing?.paymentId ?? null, externalId: r.externalId ?? existing?.externalId ?? null, failureReason: r.outcome === 'failed' ? r.failureReason ?? 'Card declined' : null, paidAt: r.outcome === 'paid' ? now : null, updatedAt: now };
  const [inv] = existing
    ? await tx.update(membershipInvoices).set(values).where(eq(membershipInvoices.id, existing.id)).returning()
    : await tx.insert(membershipInvoices).values({ organizationId: m.organizationId, membershipId: m.id, periodStart, periodEnd, amountMinor: amount, currency, ...values }).returning();
  let updated: Membership;
  if (r.outcome === 'paid') {
    [updated] = (await tx.update(memberships).set({ status: 'active', currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, graceUntil: null, failedPaymentAt: null, failedAttempts: 0, updatedAt: now }).where(eq(memberships.id, m.id)).returning()) as [Membership];
  } else {
    const graceDays = plan?.graceDays ?? 7;
    const inGrace = m.status === 'grace' && m.graceUntil && m.graceUntil > now;
    [updated] = (await tx.update(memberships).set({
      status: m.status === 'suspended' ? 'suspended' : 'grace', graceUntil: inGrace ? m.graceUntil : m.status === 'suspended' ? m.graceUntil : new Date(now.getTime() + graceDays * DAY),
      failedPaymentAt: now, failedAttempts: m.failedAttempts + 1, updatedAt: now,
    }).where(eq(memberships.id, m.id)).returning()) as [Membership];
    if (m.status !== 'grace' && m.status !== 'suspended') {
      await enqueueCustomerNotifications(tx, {
        organizationId: m.organizationId, locationId: m.locationId!, customerIds: [m.customerId], kind: 'membership_payment_failed',
        subject: `Payment failed: ${m.plan}`,
        body: `We couldn't take the renewal payment for your ${m.plan} membership. You can keep booking until ${updated.graceUntil!.toISOString().slice(0, 10)} while you update your payment details.`,
      });
    }
  }
  await audit(tx, { organizationId: m.organizationId, actorUserId: null, actorType: 'system', action: r.outcome === 'paid' ? 'membership.renewed' : 'membership.renewal_failed', scopeKind: 'location', scopeId: m.locationId, targetType: 'membership', targetId: m.id, metadata: { invoiceId: inv!.id, periodStart: periodStart.toISOString(), graceUntil: updated.graceUntil?.toISOString() ?? null } });
  return { invoice: inv!, membership: updated, duplicate: false };
}

/** Stripe Billing webhooks for memberships (subscription on the connected account). */
export async function processStudioBillingEvent(tx: Tx, event: Stripe.Event): Promise<{ handled: boolean; note: string; organizationId: string | null }> {
  const obj = event.data.object as unknown as Record<string, any>;
  const subId: string | null = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id ?? (event.type.startsWith('customer.subscription.') ? obj.id : null) ?? obj.parent?.subscription_details?.subscription ?? null;
  if (!subId) return { handled: false, note: 'No subscription on event', organizationId: null };
  const [m] = await tx.select().from(memberships).where(eq(memberships.stripeSubscriptionId, subId)).for('update');
  if (!m) return { handled: false, note: 'Subscription not created by BranchHarbor studios', organizationId: null };
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
    if ((obj.amount_paid ?? 0) === 0 && obj.billing_reason === 'subscription_create') return { handled: true, note: 'Trial invoice ignored', organizationId: m.organizationId };
    const [ref] = await tx.insert(paymentReferences).values({
      organizationId: m.organizationId, locationId: m.locationId, provider: 'stripe', externalId: String(obj.payment_intent ?? obj.id), connectedAccountId: (event as { account?: string }).account ?? null,
      amountMinor: obj.amount_paid ?? m.priceMinor ?? 0, currency: String(obj.currency ?? m.currency ?? 'usd').toUpperCase(), state: 'succeeded', succeededAt: new Date(), targetType: 'membership_invoice', targetId: null,
    }).onConflictDoNothing().returning();
    const r = await recordRenewal(tx, m, { outcome: 'paid', externalId: String(obj.id), paymentId: ref?.id ?? null, amountMinor: obj.amount_paid });
    if (ref) await tx.update(paymentReferences).set({ targetId: r.invoice.id }).where(eq(paymentReferences.id, ref.id));
    return { handled: true, note: 'Membership renewed', organizationId: m.organizationId };
  }
  if (event.type === 'invoice.payment_failed') {
    await recordRenewal(tx, m, { outcome: 'failed', externalId: String(obj.id), failureReason: obj.last_finalization_error?.message ?? 'Payment failed' });
    return { handled: true, note: 'Membership in grace period', organizationId: m.organizationId };
  }
  if (event.type === 'customer.subscription.updated') {
    // Dunning state from Stripe Billing: past_due → grace (still usable), unpaid → suspended. Recovery comes with invoice.paid.
    const now = new Date();
    if (obj.status === 'past_due' && m.status === 'active') {
      const [plan] = m.planId ? await tx.select().from(studioMembershipPlans).where(eq(studioMembershipPlans.id, m.planId)) : [];
      await tx.update(memberships).set({ status: 'grace', graceUntil: m.graceUntil ?? new Date(now.getTime() + (plan?.graceDays ?? 7) * DAY), failedPaymentAt: m.failedPaymentAt ?? now, updatedAt: now }).where(eq(memberships.id, m.id));
      return { handled: true, note: 'Membership in grace period (subscription past due)', organizationId: m.organizationId };
    }
    if (obj.status === 'unpaid' && ['active', 'grace'].includes(m.status)) {
      await tx.update(memberships).set({ status: 'suspended', updatedAt: now }).where(eq(memberships.id, m.id));
      await enqueueCustomerNotifications(tx, { organizationId: m.organizationId, locationId: m.locationId!, customerIds: [m.customerId], kind: 'membership_changed', subject: `Membership on hold: ${m.plan}`, body: `Your ${m.plan} membership is on hold because the renewal payment could not be taken. Update your card to book again.` });
      await audit(tx, { organizationId: m.organizationId, actorUserId: null, actorType: 'webhook', action: 'membership.suspended', scopeKind: 'location', scopeId: m.locationId, targetType: 'membership', targetId: m.id });
      return { handled: true, note: 'Membership suspended (subscription unpaid)', organizationId: m.organizationId };
    }
    if (obj.status === 'canceled' && m.status !== 'cancelled') {
      await tx.update(memberships).set({ status: 'cancelled', endsAt: now, updatedAt: now }).where(eq(memberships.id, m.id));
      return { handled: true, note: 'Membership cancelled at the provider', organizationId: m.organizationId };
    }
    return { handled: true, note: `Subscription ${obj.status ?? 'updated'} (no change)`, organizationId: m.organizationId };
  }
  if (event.type === 'customer.subscription.deleted') {
    await tx.update(memberships).set({ status: 'cancelled', endsAt: new Date(), updatedAt: new Date() }).where(eq(memberships.id, m.id));
    return { handled: true, note: 'Membership cancelled at the provider', organizationId: m.organizationId };
  }
  return { handled: false, note: `Ignored ${event.type}`, organizationId: m.organizationId };
}

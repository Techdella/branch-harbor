import { and, eq, inArray, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import {
  classBookings, classOccurrences, foodOrders, locations, orders, organizations, paymentReferences, programmes, refunds, registrations, webhookEvents, appointments,
} from '../db/schema/index.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { convertReservationToSale } from './inventory.ts';

export type PaymentRow = typeof paymentReferences.$inferSelect;
export type TargetType = 'class_booking' | 'food_order' | 'order' | 'appointment' | 'registration';

export async function connectedAccountFor(db: Exec, organizationId: string, locationId: string) {
  const [row] = await db
    .select({ org: organizations, loc: locations })
    .from(locations).innerJoin(organizations, eq(organizations.id, locations.organizationId))
    .where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!row) throw notFound('Location');
  const accountId = row.org.paymentAccountMode === 'shared' ? row.org.stripeAccountId : row.loc.stripeAccountId;
  return { accountId, enabled: row.loc.paymentsEnabled && !!accountId, feeBps: row.org.applicationFeeBps ?? 0, org: row.org, location: row.loc };
}

/** Throws when the location cannot take payments: a paid workflow must not be purchasable until the account is enabled. */
export async function assertPaymentsEnabled(db: Exec, organizationId: string, locationId: string) {
  const acct = await connectedAccountFor(db, organizationId, locationId);
  if (!acct.enabled) throw new AppError(409, 'payments_not_enabled', 'This location cannot accept online payments yet');
  return acct;
}

export interface CreatePaymentInput {
  organizationId: string;
  locationId: string;
  amountMinor: number;
  currency: string;
  targetType: TargetType;
  targetId: string;
  recordSnapshot?: Record<string, unknown>;
  description?: string;
}

/** Creates a PaymentIntent (direct charge on the connected account, with application fee) and its local reference. */
export async function createPaymentForTarget(s: Services, input: CreatePaymentInput) {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw validationError('Amount must be a positive integer in minor units');
  const acct = await assertPaymentsEnabled(s.db, input.organizationId, input.locationId);
  if (acct.location.currency !== input.currency) throw validationError(`Currency ${input.currency} does not match the location currency ${acct.location.currency}`);
  const applicationFeeMinor = Math.floor((input.amountMinor * acct.feeBps) / 10_000);
  const intent = await s.payments.createPaymentIntent({
    amountMinor: input.amountMinor,
    currency: input.currency,
    connectedAccountId: acct.accountId,
    applicationFeeMinor,
    idempotencyKey: `${input.targetType}:${input.targetId}`,
    description: input.description,
    metadata: { bh_org: input.organizationId, bh_location: input.locationId, bh_target_type: input.targetType, bh_target_id: input.targetId },
  });
  const [ref] = await s.db.insert(paymentReferences).values({
    organizationId: input.organizationId, locationId: input.locationId, provider: 'stripe', externalId: intent.id, connectedAccountId: acct.accountId,
    amountMinor: input.amountMinor, currency: input.currency, applicationFeeMinor, state: 'created', targetType: input.targetType, targetId: input.targetId,
    recordSnapshot: input.recordSnapshot ?? null, clientSecret: intent.clientSecret, sandbox: s.payments.mode === 'sandbox' ? 1 : 0,
  }).onConflictDoUpdate({ target: [paymentReferences.provider, paymentReferences.externalId], set: { updatedAt: new Date() } }).returning();
  return { payment: ref!, clientSecret: intent.clientSecret, sandbox: s.payments.mode === 'sandbox' };
}

export function serializePayment(p: PaymentRow) {
  return {
    id: p.id, organizationId: p.organizationId, locationId: p.locationId, provider: p.provider, externalId: p.externalId,
    amount: { amount: p.amountMinor, currency: p.currency }, applicationFee: { amount: p.applicationFeeMinor, currency: p.currency },
    providerAmountMinor: p.providerAmountMinor, state: p.state, refundState: p.refundState, refunded: { amount: p.refundedMinor, currency: p.currency },
    targetType: p.targetType, targetId: p.targetId, sandbox: p.sandbox === 1,
    succeededAt: p.succeededAt?.toISOString() ?? null, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
  };
}

/**
 * Confirms the record a payment pays for. Returns a description of what happened. Never throws for
 * business-rule failures: those leave the payment succeeded and surface in the reconciliation queue.
 */
export async function fulfilTarget(tx: Tx, p: PaymentRow): Promise<{ fulfilled: boolean; note: string }> {
  if (!p.targetType || !p.targetId) return { fulfilled: false, note: 'Payment has no linked record' };
  switch (p.targetType) {
    case 'class_booking': {
      const [b] = await tx.select().from(classBookings).where(eq(classBookings.id, p.targetId)).for('update');
      if (!b) return { fulfilled: false, note: 'Booking record missing' };
      if (b.status === 'confirmed') return { fulfilled: true, note: 'Already confirmed' };
      if (b.status !== 'held' && b.status !== 'expired') return { fulfilled: false, note: `Booking is ${b.status}` };
      const [occ] = await tx.select().from(classOccurrences).where(eq(classOccurrences.id, b.occurrenceId)).for('update');
      if (!occ || occ.status !== 'scheduled') return { fulfilled: false, note: 'Class is no longer scheduled' };
      if (b.status === 'expired' || (b.holdExpiresAt && b.holdExpiresAt < new Date())) {
        // Payment arrived after the hold expired: confirm only if a seat is still free.
        const [{ used } = { used: 0 }] = await tx.select({ used: sql<number>`count(*)::int` }).from(classBookings)
          .where(and(eq(classBookings.occurrenceId, occ.id), sql`(${classBookings.status} = 'confirmed' or (${classBookings.status} = 'held' and ${classBookings.holdExpiresAt} > now() and ${classBookings.id} <> ${b.id}))`));
        if (used >= occ.capacity) {
          await tx.update(classBookings).set({ status: 'expired' }).where(eq(classBookings.id, b.id));
          return { fulfilled: false, note: 'Paid after hold expired and the class is now full — needs recovery' };
        }
      }
      await tx.update(classBookings).set({ status: 'confirmed', confirmedAt: new Date(), holdExpiresAt: null, paymentId: p.id }).where(eq(classBookings.id, b.id));
      return { fulfilled: true, note: 'Booking confirmed' };
    }
    case 'food_order': {
      const [o] = await tx.select().from(foodOrders).where(eq(foodOrders.id, p.targetId)).for('update');
      if (!o) return { fulfilled: false, note: 'Food order record missing' };
      if (o.status === 'rejected' || o.status === 'cancelled') return { fulfilled: false, note: `Order already ${o.status}` };
      await tx.update(foodOrders).set({ paymentStatus: 'paid', paymentId: p.id, updatedAt: new Date() }).where(eq(foodOrders.id, o.id));
      return { fulfilled: true, note: 'Order paid — awaiting restaurant acceptance' };
    }
    case 'order': {
      const [o] = await tx.select().from(orders).where(eq(orders.id, p.targetId)).for('update');
      if (!o) return { fulfilled: false, note: 'Order record missing' };
      if (o.status === 'pending_payment') {
        await tx.update(orders).set({ status: 'paid', paymentId: p.id, updatedAt: new Date() }).where(eq(orders.id, o.id));
        await convertReservationToSale(tx, o);
      }
      return { fulfilled: true, note: 'Order paid' };
    }
    case 'appointment': {
      const [a] = await tx.select().from(appointments).where(eq(appointments.id, p.targetId));
      if (!a) return { fulfilled: false, note: 'Appointment record missing' };
      await tx.update(appointments).set({ paymentId: p.id, updatedAt: new Date() }).where(eq(appointments.id, a.id));
      return { fulfilled: a.status === 'confirmed', note: a.status === 'confirmed' ? 'Appointment paid' : `Appointment is ${a.status}` };
    }
    case 'registration': {
      const [r] = await tx.select({ reg: registrations, prog: programmes }).from(registrations).innerJoin(programmes, eq(programmes.id, registrations.programmeId)).where(eq(registrations.id, p.targetId));
      if (!r) return { fulfilled: false, note: 'Registration record missing' };
      // Payment never equals selection: approval-required programmes go to review.
      if (r.reg.status === 'submitted') {
        await tx.update(registrations).set({ status: r.prog.requiresApproval ? 'awaiting_review' : 'accepted', paymentId: p.id, updatedAt: new Date() }).where(eq(registrations.id, r.reg.id));
      }
      return { fulfilled: true, note: r.prog.requiresApproval ? 'Registration paid — awaiting review' : 'Registration accepted' };
    }
    default:
      return { fulfilled: false, note: `Unknown target ${p.targetType}` };
  }
}

const PI_STATE: Record<string, string> = {
  requires_payment_method: 'created', requires_confirmation: 'created', requires_action: 'requires_action',
  processing: 'processing', requires_capture: 'processing', succeeded: 'succeeded', canceled: 'cancelled',
};

/** Find the payment reference for an intent, or create one from its metadata (missed creation / external origin). */
async function referenceForIntent(tx: Tx, pi: Stripe.PaymentIntent, connectedAccount: string | null): Promise<PaymentRow | null> {
  const [existing] = await tx.select().from(paymentReferences).where(and(eq(paymentReferences.provider, 'stripe'), eq(paymentReferences.externalId, pi.id))).for('update');
  if (existing) return existing;
  const orgId = pi.metadata?.bh_org;
  if (!orgId) return null;
  const [created] = await tx.insert(paymentReferences).values({
    organizationId: orgId, locationId: pi.metadata?.bh_location ?? null, provider: 'stripe', externalId: pi.id, connectedAccountId: connectedAccount,
    amountMinor: pi.amount, currency: pi.currency.toUpperCase(), applicationFeeMinor: pi.application_fee_amount ?? 0, state: 'created',
    targetType: pi.metadata?.bh_target_type ?? null, targetId: pi.metadata?.bh_target_id ?? null,
  }).returning();
  return created ?? null;
}

export interface WebhookOutcome { duplicate: boolean; status: 'processed' | 'ignored'; note?: string }

/**
 * Idempotent Stripe event processing. The webhook_events unique (provider, event_id) row is
 * inserted in the same transaction as the side effects: a duplicate delivery is a no-op, and a
 * failure rolls back both so Stripe's retry processes it again.
 */
export async function processStripeEvent(s: Services, event: Stripe.Event): Promise<WebhookOutcome> {
  return s.db.transaction(async (tx) => {
    const inserted = await tx.insert(webhookEvents)
      .values({ provider: 'stripe', eventId: event.id, type: event.type, payload: event as unknown as Record<string, unknown> })
      .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.eventId] })
      .returning({ id: webhookEvents.id });
    if (!inserted.length) return { duplicate: true, status: 'ignored' as const, note: 'Event already processed' };
    const eventRowId = inserted[0]!.id;
    const connected = (event as { account?: string }).account ?? null;
    let note = 'No handler for this event type';
    let paymentId: string | null = null;
    let orgId: string | null = null;

    if (event.type.startsWith('payment_intent.')) {
      const pi = event.data.object as Stripe.PaymentIntent;
      const ref = await referenceForIntent(tx, pi, connected);
      if (!ref) {
        note = 'Payment intent not created by BranchHarbor';
      } else {
        paymentId = ref.id;
        orgId = ref.organizationId;
        const newState = event.type === 'payment_intent.payment_failed' ? 'failed' : PI_STATE[pi.status] ?? ref.state;
        // Never move a succeeded payment backwards because of an out-of-order event.
        const finalState = ref.state === 'succeeded' && newState !== 'succeeded' ? 'succeeded' : newState;
        const amountReceived = pi.amount_received || pi.amount;
        await tx.update(paymentReferences).set({
          state: finalState,
          providerAmountMinor: amountReceived !== ref.amountMinor || pi.currency.toUpperCase() !== ref.currency ? amountReceived : null,
          succeededAt: finalState === 'succeeded' ? ref.succeededAt ?? new Date() : ref.succeededAt,
          updatedAt: new Date(),
        }).where(eq(paymentReferences.id, ref.id));
        note = `Payment ${finalState}`;
        if (finalState === 'succeeded' && ref.state !== 'succeeded') {
          const fresh = { ...ref, state: 'succeeded' };
          try {
            const r = await tx.transaction(async (sp) => fulfilTarget(sp, fresh));
            note = r.note;
          } catch (err) {
            note = `Fulfilment failed: ${(err as Error).message}`;
          }
        }
        if (finalState === 'failed' || finalState === 'cancelled') {
          // Release capacity held for unpaid class bookings.
          if (ref.targetType === 'class_booking' && ref.targetId) {
            await tx.update(classBookings).set({ status: 'expired' }).where(and(eq(classBookings.id, ref.targetId), eq(classBookings.status, 'held')));
          }
          if (ref.targetType === 'food_order' && ref.targetId) {
            await tx.update(foodOrders).set({ paymentStatus: 'voided', status: 'cancelled', updatedAt: new Date() }).where(and(eq(foodOrders.id, ref.targetId), eq(foodOrders.status, 'awaiting_acceptance'), eq(foodOrders.paymentStatus, 'pending')));
          }
        }
        await audit(tx, { organizationId: ref.organizationId, actorUserId: null, actorType: 'webhook', action: `payment.${event.type}`, scopeKind: 'location', scopeId: ref.locationId, targetType: 'payment', targetId: ref.id, metadata: { eventId: event.id, note } });
      }
    } else if (event.type === 'charge.refunded') {
      const ch = event.data.object as Stripe.Charge;
      const piId = typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id;
      if (piId) {
        const [ref] = await tx.select().from(paymentReferences).where(eq(paymentReferences.externalId, piId)).for('update');
        if (ref) {
          paymentId = ref.id;
          orgId = ref.organizationId;
          const refunded = Math.min(ch.amount_refunded, ref.amountMinor);
          await tx.update(paymentReferences).set({ refundedMinor: Math.max(ref.refundedMinor, refunded), refundState: refunded >= ref.amountMinor ? 'complete' : 'partial', updatedAt: new Date() }).where(eq(paymentReferences.id, ref.id));
          note = 'Refund recorded';
        }
      }
    } else if (event.type === 'account.updated') {
      const acct = event.data.object as Stripe.Account;
      const enabled = !!acct.charges_enabled;
      await tx.update(locations).set({ paymentsEnabled: enabled, updatedAt: new Date() }).where(eq(locations.stripeAccountId, acct.id));
      const orgRows = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.stripeAccountId, acct.id));
      if (orgRows.length) await tx.update(locations).set({ paymentsEnabled: enabled, updatedAt: new Date() }).where(inArray(locations.organizationId, orgRows.map((o) => o.id)));
      note = `Account charges ${enabled ? 'enabled' : 'disabled'}`;
    }

    await tx.update(webhookEvents).set({ status: 'processed', processedAt: new Date(), error: null, paymentId, organizationId: orgId }).where(eq(webhookEvents.id, eventRowId));
    return { duplicate: false, status: 'processed' as const, note };
  });
}

/** Build a synthetic Stripe event for sandbox mode so the exact same processing path runs. */
export function sandboxEvent(p: PaymentRow, type: 'payment_intent.succeeded' | 'payment_intent.payment_failed', amountOverride?: number): Stripe.Event {
  return {
    id: `evt_sandbox_${crypto.randomUUID()}`,
    object: 'event',
    type,
    account: p.connectedAccountId ?? undefined,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    api_version: null,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: p.externalId, object: 'payment_intent', amount: amountOverride ?? p.amountMinor, amount_received: type === 'payment_intent.succeeded' ? amountOverride ?? p.amountMinor : 0,
        currency: p.currency.toLowerCase(), status: type === 'payment_intent.succeeded' ? 'succeeded' : 'requires_payment_method', metadata: {},
        application_fee_amount: p.applicationFeeMinor,
      },
    },
  } as unknown as Stripe.Event;
}

/** Partial or full refund. Amount is in the payment's own currency; it can never exceed what remains. */
export async function refundPayment(s: Services, paymentId: string, amountMinor: number, opts: { actorUserId: string | null; reason?: string; ip?: string }) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw validationError('Refund amount must be a positive integer in minor units', { amountMinor: 'Must be > 0' });
  const reserved = await s.db.transaction(async (tx) => {
    const [p] = await tx.select().from(paymentReferences).where(eq(paymentReferences.id, paymentId)).for('update');
    if (!p) throw notFound('Payment');
    if (p.state !== 'succeeded') throw conflict('payment_not_refundable', `Only succeeded payments can be refunded (payment is ${p.state})`);
    const pendingRows = await tx.select({ amt: refunds.amountMinor }).from(refunds).where(and(eq(refunds.paymentId, p.id), eq(refunds.state, 'pending')));
    const pendingTotal = pendingRows.reduce((a, r) => a + r.amt, 0);
    const remaining = p.amountMinor - p.refundedMinor - pendingTotal;
    if (amountMinor > remaining) throw conflict('refund_exceeds_remaining', `Refund exceeds the refundable amount (${remaining} ${p.currency} minor units remain)`, { remainingMinor: remaining, currency: p.currency });
    const [r] = await tx.insert(refunds).values({ organizationId: p.organizationId, paymentId: p.id, amountMinor, currency: p.currency, state: 'pending', reason: opts.reason ?? null, requestedBy: opts.actorUserId }).returning();
    await tx.update(paymentReferences).set({ refundState: 'pending', updatedAt: new Date() }).where(eq(paymentReferences.id, p.id));
    await audit(tx, { organizationId: p.organizationId, actorUserId: opts.actorUserId, action: 'payment.refund_requested', scopeKind: 'location', scopeId: p.locationId, targetType: 'payment', targetId: p.id, metadata: { amountMinor, currency: p.currency, reason: opts.reason }, ip: opts.ip });
    return { p, r: r! };
  });

  let result: { id: string; status: 'pending' | 'complete' | 'failed' };
  try {
    result = await s.payments.createRefund({ paymentIntentId: reserved.p.externalId, amountMinor, connectedAccountId: reserved.p.connectedAccountId, idempotencyKey: `refund:${reserved.r.id}`, reason: opts.reason });
  } catch (err) {
    result = { id: '', status: 'failed' };
    s.log.error({ err, paymentId }, 'refund failed at provider');
  }

  return s.db.transaction(async (tx) => {
    const [p] = await tx.select().from(paymentReferences).where(eq(paymentReferences.id, paymentId)).for('update');
    await tx.update(refunds).set({ state: result.status, externalId: result.id || null, updatedAt: new Date() }).where(eq(refunds.id, reserved.r.id));
    const refunded = p!.refundedMinor + (result.status === 'complete' ? amountMinor : 0);
    const refundState = result.status === 'failed' ? (p!.refundedMinor > 0 ? 'partial' : 'failed') : result.status === 'pending' ? 'pending' : refunded >= p!.amountMinor ? 'complete' : 'partial';
    const [updated] = await tx.update(paymentReferences).set({ refundedMinor: refunded, refundState, updatedAt: new Date() }).where(eq(paymentReferences.id, paymentId)).returning();
    await audit(tx, { organizationId: p!.organizationId, actorUserId: opts.actorUserId, action: `payment.refund_${result.status}`, scopeKind: 'location', scopeId: p!.locationId, targetType: 'payment', targetId: paymentId, metadata: { amountMinor, refundId: reserved.r.id } });
    const [r] = await tx.select().from(refunds).where(eq(refunds.id, reserved.r.id));
    return { payment: updated!, refund: r! };
  });
}

/** Void or refund the payment linked to a record (e.g. rejected food order). */
export async function reverseTargetPayment(s: Services, paymentId: string | null, actorUserId: string | null, reason: string) {
  if (!paymentId) return { action: 'none' as const };
  const [p] = await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, paymentId));
  if (!p) return { action: 'none' as const };
  if (p.state === 'succeeded') {
    const remaining = p.amountMinor - p.refundedMinor;
    if (remaining <= 0) return { action: 'already_refunded' as const };
    const r = await refundPayment(s, p.id, remaining, { actorUserId, reason });
    return { action: 'refunded' as const, refundState: r.refund.state };
  }
  if (['created', 'requires_action', 'processing'].includes(p.state)) {
    await s.payments.cancelPaymentIntent(p.externalId, p.connectedAccountId).catch((err) => s.log.warn({ err }, 'cancel intent failed'));
    await s.db.update(paymentReferences).set({ state: 'cancelled', updatedAt: new Date() }).where(eq(paymentReferences.id, p.id));
    return { action: 'voided' as const };
  }
  return { action: 'none' as const };
}

export interface ReconciliationItem {
  kind: 'paid_without_record' | 'unpaid_confirmed_record' | 'amount_mismatch';
  paymentId: string | null;
  targetType: string | null;
  targetId: string | null;
  locationId: string | null;
  expected: { amount: number; currency: string } | null;
  actual: { amount: number; currency: string } | null;
  detail: string;
  recoverable: boolean;
}

/** The recovery queue (spec §14): mismatches between payments and the records they pay for. */
export async function reconciliationQueue(db: Exec, organizationId: string, allowed: 'all' | Set<string>): Promise<ReconciliationItem[]> {
  const inScope = (loc: string | null) => allowed === 'all' || (!!loc && allowed.has(loc));
  const items: ReconciliationItem[] = [];
  const pays = await db.select().from(paymentReferences).where(eq(paymentReferences.organizationId, organizationId));
  const byTarget = new Map<string, PaymentRow[]>();
  for (const p of pays) if (p.targetId) byTarget.set(p.targetId, [...(byTarget.get(p.targetId) ?? []), p]);

  const ids = (t: string) => pays.filter((p) => p.targetType === t && p.targetId).map((p) => p.targetId!);
  const bookingIds = ids('class_booking');
  const foodIds = ids('food_order');
  const orderIds = ids('order');
  const apptIds = ids('appointment');
  const regIds = ids('registration');
  const bookingsMap = new Map((bookingIds.length ? await db.select().from(classBookings).where(inArray(classBookings.id, bookingIds)) : []).map((b) => [b.id, b]));
  const foodMap = new Map((foodIds.length ? await db.select().from(foodOrders).where(inArray(foodOrders.id, foodIds)) : []).map((o) => [o.id, o]));
  const orderMap = new Map((orderIds.length ? await db.select().from(orders).where(inArray(orders.id, orderIds)) : []).map((o) => [o.id, o]));
  const apptMap = new Map((apptIds.length ? await db.select().from(appointments).where(inArray(appointments.id, apptIds)) : []).map((o) => [o.id, o]));
  const regMap = new Map((regIds.length ? await db.select().from(registrations).where(inArray(registrations.id, regIds)) : []).map((o) => [o.id, o]));

  for (const p of pays) {
    if (!inScope(p.locationId)) continue;
    const actual = { amount: p.providerAmountMinor ?? p.amountMinor, currency: p.currency };
    if (p.state === 'succeeded') {
      let ok = false;
      let expected: { amount: number; currency: string } | null = null;
      switch (p.targetType) {
        case 'class_booking': { const b = p.targetId ? bookingsMap.get(p.targetId) : undefined; ok = !!b && ['confirmed', 'attended', 'no_show'].includes(b.status); break; }
        case 'food_order': { const o = p.targetId ? foodMap.get(p.targetId) : undefined; ok = !!o && o.status !== 'rejected' && o.status !== 'cancelled' ? true : !!o && p.refundedMinor >= p.amountMinor; if (o) expected = { amount: o.totalMinor, currency: o.currency }; break; }
        case 'order': { const o = p.targetId ? orderMap.get(p.targetId) : undefined; ok = !!o && o.status !== 'pending_payment'; if (o) expected = { amount: o.totalMinor, currency: o.currency }; break; }
        case 'appointment': { const a = p.targetId ? apptMap.get(p.targetId) : undefined; ok = !!a && a.status !== 'cancelled' ? true : !!a && p.refundedMinor >= p.amountMinor; if (a) expected = { amount: a.priceMinor, currency: a.currency }; break; }
        case 'registration': { const r = p.targetId ? regMap.get(p.targetId) : undefined; ok = !!r && r.status !== 'submitted'; break; }
        default: ok = false;
      }
      if (!ok && p.refundedMinor < p.amountMinor) {
        items.push({ kind: 'paid_without_record', paymentId: p.id, targetType: p.targetType, targetId: p.targetId, locationId: p.locationId, expected, actual, detail: 'Payment succeeded but the linked record is missing or not confirmed', recoverable: !!(p.targetType && (p.recordSnapshot || p.targetId)) });
      }
      const mismatch = (expected && (expected.amount !== actual.amount || expected.currency !== actual.currency)) || (p.providerAmountMinor !== null && p.providerAmountMinor !== p.amountMinor);
      if (mismatch) {
        items.push({ kind: 'amount_mismatch', paymentId: p.id, targetType: p.targetType, targetId: p.targetId, locationId: p.locationId, expected: expected ?? { amount: p.amountMinor, currency: p.currency }, actual, detail: 'Amount or currency charged differs from the record total', recoverable: false });
      }
    }
  }

  // Confirmed/accepted records whose payment has not succeeded.
  const unpaid = async <T extends { id: string; locationId: string; paymentId: string | null }>(rows: T[], type: string, amount: (r: T) => { amount: number; currency: string } | null) => {
    for (const r of rows) {
      if (!inScope(r.locationId) || !r.paymentId) continue;
      const p = pays.find((x) => x.id === r.paymentId);
      if (!p || p.state !== 'succeeded') items.push({ kind: 'unpaid_confirmed_record', paymentId: r.paymentId, targetType: type, targetId: r.id, locationId: r.locationId, expected: amount(r), actual: p ? { amount: 0, currency: p.currency } : null, detail: `Record is confirmed but payment is ${p?.state ?? 'missing'}`, recoverable: false });
    }
  };
  await unpaid(await db.select().from(classBookings).where(and(eq(classBookings.organizationId, organizationId), eq(classBookings.status, 'confirmed'))), 'class_booking', () => null);
  await unpaid(
    await db.select().from(foodOrders).where(and(eq(foodOrders.organizationId, organizationId), inArray(foodOrders.status, ['accepted', 'preparing', 'ready', 'collected']), sql`${foodOrders.paymentStatus} <> 'not_required'`)),
    'food_order', (o) => ({ amount: o.totalMinor, currency: o.currency }),
  );
  await unpaid(await db.select().from(orders).where(and(eq(orders.organizationId, organizationId), inArray(orders.status, ['paid', 'fulfilled']), eq(orders.source, 'native'))), 'order', (o) => ({ amount: o.totalMinor, currency: o.currency }));
  return items;
}

/** "Recreate record from payment": re-run fulfilment, or rebuild the record from its snapshot. */
export async function recreateRecordFromPayment(s: Services, paymentId: string, actorUserId: string, opts: { allowOverCapacity: boolean }) {
  return s.db.transaction(async (tx) => {
    const [p] = await tx.select().from(paymentReferences).where(eq(paymentReferences.id, paymentId)).for('update');
    if (!p) throw notFound('Payment');
    if (p.state !== 'succeeded') throw conflict('payment_not_succeeded', 'Only succeeded payments can be used to recreate a record');
    let result = await fulfilTarget(tx, p);
    if (!result.fulfilled && p.targetType === 'food_order' && p.targetId && p.recordSnapshot) {
      const [exists] = await tx.select({ id: foodOrders.id }).from(foodOrders).where(eq(foodOrders.id, p.targetId));
      if (!exists) {
        const snap = p.recordSnapshot as Record<string, any>;
        await tx.insert(foodOrders).values({ ...snap, id: p.targetId, paymentId: p.id, paymentStatus: 'paid', status: 'awaiting_acceptance', promisedAt: snap.promisedAt ? new Date(snap.promisedAt) : null, statusHistory: [{ at: new Date().toISOString(), from: null, to: 'awaiting_acceptance', by: actorUserId, note: 'Recreated from payment' }] } as typeof foodOrders.$inferInsert);
        result = { fulfilled: true, note: 'Food order recreated from payment snapshot' };
      }
    }
    if (!result.fulfilled && p.targetType === 'class_booking' && p.targetId && opts.allowOverCapacity) {
      const [b] = await tx.select().from(classBookings).where(eq(classBookings.id, p.targetId));
      if (b && (b.status === 'expired' || b.status === 'held')) {
        await tx.update(classBookings).set({ status: 'confirmed', confirmedAt: new Date(), paymentId: p.id, holdExpiresAt: null }).where(eq(classBookings.id, b.id));
        result = { fulfilled: true, note: 'Booking confirmed over capacity by an authorised user' };
      }
    }
    await audit(tx, { organizationId: p.organizationId, actorUserId, action: 'payment.record_recreated', scopeKind: 'location', scopeId: p.locationId, targetType: p.targetType, targetId: p.targetId, metadata: { paymentId, ...result, allowOverCapacity: opts.allowOverCapacity } });
    return result;
  });
}

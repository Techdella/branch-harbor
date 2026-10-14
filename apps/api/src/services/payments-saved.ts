/**
 * Card entry configuration, saved cards (Stripe Customers on connected accounts), consents, card updates
 * (SetupIntents), membership subscriptions with the saved card, and merchant-initiated (off-session) charges
 * for automatic fees and instalments.
 *
 * Every charge is a direct charge on the location's connected account. Nothing here marks a record paid:
 * fulfilment always runs through `processStripeEvent` (signed webhook, or the synthetic sandbox event).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import {
  appointments, classBookings, customers, foodMealPlanSubscriptions, foodOrders, locations, memberships, offSessionCharges, orders, organizations, paymentConsents,
  paymentCustomers, paymentReferences, registrations, services as servicesTable, sportsInstalments, stripeRecurringPrices, studioFees, studioMembershipPlans, studioPurchases,
  wellnessAppointmentCharges, wellnessClientPackages, wellnessGiftVouchers,
} from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { localDateParts } from '../lib/tz.ts';
import { audit } from './audit.ts';
import {
  connectedAccountFor, paymentFailureHooks, paymentIntentCustomizers, paymentSucceededHooks, paymentTargetExtensions, processStripeEvent, sandboxEvent, stripeEventExtensions,
  type PaymentRow,
} from './payments.ts';
import { describePolicy, effectivePolicy } from './studios-entitlements.ts';
import { recordRenewal } from './studios-fulfil.ts';
import { policyOf } from './wellness.ts';

export type SavePurpose = 'save_card' | 'renewals' | 'instalments' | 'fees';
export const SAVE_PURPOSES: SavePurpose[] = ['save_card', 'renewals', 'instalments', 'fees'];

/** Default (English) consent wording. Clients show their localized version and send the exact text agreed to. */
export const CONSENT_TEXT: Record<SavePurpose, (business: string) => string> = {
  save_card: (b) => `Save this card with ${b} for future payments. You can remove it at any time.`,
  renewals: (b) => `I authorise ${b} to save this card and charge it automatically for each renewal of this plan until I cancel.`,
  instalments: (b) => `I authorise ${b} to save this card and charge the remaining instalments automatically on their due dates.`,
  fees: (b) => `I authorise ${b} to charge my saved card for a late-cancellation or no-show fee under the policy shown.`,
};

const acctKey = (acct: string | null | undefined) => acct ?? '';
const DAY = 86400_000;

// ───────────────────────── Settings ─────────────────────────

export interface PaymentAutomationSettings {
  /** Charge late-cancel / no-show fees automatically when the customer consented and has a saved card. */
  autoChargeFees: boolean;
  /** Hours after a fee is recorded before it is charged (staff can waive it meanwhile). */
  feeChargeDelayHours: number;
  /** Charge sports instalments off-session on their due date. */
  autoChargeInstalments: boolean;
}
export const DEFAULT_AUTOMATION: PaymentAutomationSettings = { autoChargeFees: true, feeChargeDelayHours: 24, autoChargeInstalments: true };

export function automationSettings(org: Pick<typeof organizations.$inferSelect, 'settings'>): PaymentAutomationSettings {
  const raw = ((org.settings ?? {}) as Record<string, unknown>).paymentAutomation as Partial<PaymentAutomationSettings> | undefined;
  return {
    autoChargeFees: typeof raw?.autoChargeFees === 'boolean' ? raw.autoChargeFees : DEFAULT_AUTOMATION.autoChargeFees,
    feeChargeDelayHours: Number.isInteger(raw?.feeChargeDelayHours) && raw!.feeChargeDelayHours! >= 0 ? raw!.feeChargeDelayHours! : DEFAULT_AUTOMATION.feeChargeDelayHours,
    autoChargeInstalments: typeof raw?.autoChargeInstalments === 'boolean' ? raw.autoChargeInstalments : DEFAULT_AUTOMATION.autoChargeInstalments,
  };
}

// ───────────────────────── Signed action links ─────────────────────────

/** Token for the "complete your payment" link (SCA on an off-session charge). Lets the holder see that one client secret. */
export function paymentActionToken(cfg: Services['cfg'], paymentId: string) {
  return createHmac('sha256', cfg.JWT_SECRET).update(`payment-action:${paymentId}`).digest('base64url');
}
export function verifyPaymentActionToken(cfg: Services['cfg'], paymentId: string, token: string) {
  const a = Buffer.from(paymentActionToken(cfg, paymentId));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
const setupToken = (cfg: Services['cfg'], setupId: string) => createHmac('sha256', cfg.JWT_SECRET).update(`setup:${setupId}`).digest('base64url');

// ───────────────────────── Client configuration ─────────────────────────

export interface ClientPaymentConfig {
  /** live: card entry with Stripe.js / PaymentSheet · sandbox: simulated payments (no keys on the server). */
  mode: 'live' | 'sandbox';
  publishableKey: string | null;
  /** Connected account for direct charges: `loadStripe(pk, { stripeAccount })` / PaymentSheet `stripeAccountId`. */
  stripeAccount: string | null;
  merchantDisplayName: string;
  merchantCountry: string;
  currency: string;
  /** False when live mode lacks a publishable key or the location has no connected account: show "card payments unavailable". */
  cardEntryAvailable: boolean;
}

export async function clientConfigFor(s: Services, organizationId: string, locationId: string): Promise<ClientPaymentConfig> {
  const acct = await connectedAccountFor(s.db, organizationId, locationId);
  const live = s.payments.mode === 'live';
  return {
    mode: s.payments.mode,
    publishableKey: live ? s.payments.publishableKey : null,
    stripeAccount: live ? acct.accountId ?? null : null,
    merchantDisplayName: acct.org.name,
    merchantCountry: acct.location.country ?? acct.org.country,
    currency: acct.location.currency,
    cardEntryAvailable: live ? !!s.payments.publishableKey && !!acct.accountId && acct.enabled : acct.enabled,
  };
}

/** The customer a payment belongs to (for saved cards and consents). Null when the record has no customer. */
export async function customerForPayment(db: Exec, p: Pick<PaymentRow, 'targetType' | 'targetId'>): Promise<string | null> {
  if (!p.targetId) return null;
  const one = async <T>(q: Promise<T[]>) => (await q)[0] ?? null;
  switch (p.targetType) {
    case 'class_booking': return (await one(db.select({ c: classBookings.customerId }).from(classBookings).where(eq(classBookings.id, p.targetId))))?.c ?? null;
    case 'appointment': return (await one(db.select({ c: appointments.customerId }).from(appointments).where(eq(appointments.id, p.targetId))))?.c ?? null;
    case 'registration': return (await one(db.select({ c: registrations.guardianCustomerId }).from(registrations).where(eq(registrations.id, p.targetId))))?.c ?? null;
    case 'studio_purchase': return (await one(db.select({ c: studioPurchases.customerId }).from(studioPurchases).where(eq(studioPurchases.id, p.targetId))))?.c ?? null;
    case 'food_order': return (await one(db.select({ c: foodOrders.customerId }).from(foodOrders).where(eq(foodOrders.id, p.targetId))))?.c ?? null;
    case 'order': return (await one(db.select({ c: orders.customerId }).from(orders).where(eq(orders.id, p.targetId))))?.c ?? null;
    case 'wellness_package': return (await one(db.select({ c: wellnessClientPackages.customerId }).from(wellnessClientPackages).where(eq(wellnessClientPackages.id, p.targetId))))?.c ?? null;
    case 'wellness_voucher': return (await one(db.select({ c: wellnessGiftVouchers.purchaserCustomerId }).from(wellnessGiftVouchers).where(eq(wellnessGiftVouchers.id, p.targetId))))?.c ?? null;
    default: return null;
  }
}

export interface FeePolicySummary { kind: 'studio' | 'wellness'; lateCancel: { amount: number; currency: string } | null; lateCancelPercent: number | null; noShow: { amount: number; currency: string } | null; noShowPercent: number | null; windowHours: number; lines: string[] }

/** Late-cancel / no-show fee policy of a booking (shown next to the fee-charging consent). Null when no fee applies. */
export async function feePolicyFor(db: Exec, targetType: string | null, targetId: string | null): Promise<FeePolicySummary | null> {
  if (!targetId) return null;
  if (targetType === 'class_booking') {
    const [b] = await db.select().from(classBookings).where(eq(classBookings.id, targetId));
    if (!b) return null;
    const [loc] = await db.select().from(locations).where(eq(locations.id, b.locationId));
    const pol = await effectivePolicy(db, b.organizationId, b.locationId);
    const currency = loc?.currency ?? 'USD';
    const d = describePolicy(pol, currency);
    if (!d.lateCancelFee && !d.noShowFee) return null;
    return { kind: 'studio', lateCancel: d.lateCancelFee, lateCancelPercent: null, noShow: d.noShowFee, noShowPercent: null, windowHours: Math.round((pol.lateCancelMinutes / 60) * 10) / 10, lines: d.lines };
  }
  if (targetType === 'appointment') {
    const [a] = await db.select().from(appointments).where(eq(appointments.id, targetId));
    if (!a) return null;
    const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, a.serviceId));
    if (!svc) return null;
    const pol = policyOf(svc);
    if (!pol.lateCancelFeePercent && !pol.noShowFeePercent) return null;
    return {
      kind: 'wellness', lateCancel: null, lateCancelPercent: pol.lateCancelFeePercent, noShow: null, noShowPercent: pol.noShowFeePercent, windowHours: pol.freeCancelHours,
      lines: [`Cancel at least ${pol.freeCancelHours} hours before the start to avoid a fee.`, `Late cancellation: ${pol.lateCancelFeePercent}% of the price. No-show: ${pol.noShowFeePercent}%.`, ...(svc.cancellationPolicy ? [svc.cancellationPolicy] : [])],
    };
  }
  return null;
}

export interface SaveCardRequirement { mode: 'required' | 'optional' | 'none'; purposes: SavePurpose[]; feePolicy: FeePolicySummary | null }

/** Whether checkout must (memberships, instalment plans) or may keep the card, and for what. */
export async function saveCardRequirement(db: Exec, p: Pick<PaymentRow, 'targetType' | 'targetId'>): Promise<SaveCardRequirement> {
  if (!p.targetId) return { mode: 'none', purposes: [], feePolicy: null };
  if (p.targetType === 'studio_purchase') {
    const [pu] = await db.select({ kind: studioPurchases.kind }).from(studioPurchases).where(eq(studioPurchases.id, p.targetId));
    if (pu?.kind === 'membership') return { mode: 'required', purposes: ['renewals'], feePolicy: null };
  }
  if (p.targetType === 'registration') {
    const [r] = await db.select({ plan: registrations.paymentPlan }).from(registrations).where(eq(registrations.id, p.targetId));
    if (r?.plan === 'instalments') return { mode: 'required', purposes: ['instalments'], feePolicy: null };
  }
  const customerId = await customerForPayment(db, p);
  if (!customerId) return { mode: 'none', purposes: [], feePolicy: null };
  const feePolicy = await feePolicyFor(db, p.targetType, p.targetId);
  return { mode: 'optional', purposes: feePolicy ? ['save_card', 'fees'] : ['save_card'], feePolicy };
}

/** What a browser/app needs to collect a card for a payment. Never includes the client secret or any secret key. */
export async function paymentClientView(s: Services, p: PaymentRow) {
  const cfg = p.locationId ? await clientConfigFor(s, p.organizationId, p.locationId) : null;
  const requirement = await saveCardRequirement(s.db, p);
  const consents = await s.db.select({ purpose: paymentConsents.purpose }).from(paymentConsents).where(and(eq(paymentConsents.paymentId, p.id), isNull(paymentConsents.revokedAt)));
  return {
    id: p.id, state: p.state, amount: { amount: p.amountMinor, currency: p.currency }, sandbox: p.sandbox === 1,
    mode: p.sandbox === 1 ? 'sandbox' as const : 'live' as const,
    publishableKey: p.sandbox === 1 ? null : cfg?.publishableKey ?? null,
    stripeAccount: p.sandbox === 1 ? null : p.connectedAccountId,
    merchantDisplayName: cfg?.merchantDisplayName ?? '', merchantCountry: cfg?.merchantCountry ?? null,
    cardEntryAvailable: p.sandbox === 1 ? true : !!cfg?.publishableKey && !!p.connectedAccountId,
    saveCard: { ...requirement, consented: consents.map((c) => c.purpose) },
    targetType: p.targetType,
  };
}

// ───────────────────────── Stripe Customers and saved cards ─────────────────────────

export async function ensurePaymentCustomer(s: Services, input: { organizationId: string; customerId: string; connectedAccountId: string | null }) {
  const key = acctKey(input.connectedAccountId);
  const [existing] = await s.db.select().from(paymentCustomers).where(and(eq(paymentCustomers.customerId, input.customerId), eq(paymentCustomers.connectedAccountId, key)));
  if (existing) return existing;
  const [c] = await s.db.select().from(customers).where(eq(customers.id, input.customerId));
  if (!c || c.erasedAt) throw notFound('Customer');
  const created = await s.payments.createCustomer({
    connectedAccountId: input.connectedAccountId, email: c.email ?? null, name: c.name ?? null,
    metadata: { bh_org: input.organizationId, bh_customer: c.id }, idempotencyKey: `bh_customer:${c.id}:${key}`,
  });
  await s.db.insert(paymentCustomers).values({ organizationId: input.organizationId, customerId: c.id, connectedAccountId: key, stripeCustomerId: created.id, sandbox: s.payments.mode === 'sandbox' }).onConflictDoNothing();
  const [row] = await s.db.select().from(paymentCustomers).where(and(eq(paymentCustomers.customerId, c.id), eq(paymentCustomers.connectedAccountId, key)));
  return row!;
}

export async function savedCardFor(db: Exec, customerId: string, connectedAccountId: string | null) {
  const [row] = await db.select().from(paymentCustomers).where(and(eq(paymentCustomers.customerId, customerId), eq(paymentCustomers.connectedAccountId, acctKey(connectedAccountId))));
  return row?.defaultPaymentMethodId ? row : null;
}

export function serializeCard(row: typeof paymentCustomers.$inferSelect | null) {
  if (!row?.defaultPaymentMethodId) return null;
  return { brand: row.cardBrand, last4: row.cardLast4, expMonth: row.cardExpMonth, expYear: row.cardExpYear, sandbox: row.sandbox, updatedAt: row.updatedAt.toISOString() };
}

/** Card on file at a location (fills in brand/last4 from Stripe the first time). */
export async function cardOnFile(s: Services, organizationId: string, locationId: string, customerId: string) {
  const acct = await connectedAccountFor(s.db, organizationId, locationId);
  let row = await savedCardFor(s.db, customerId, acct.accountId);
  if (row && !row.cardLast4) {
    const card = await s.payments.retrievePaymentMethod(row.defaultPaymentMethodId!, acct.accountId).catch(() => null);
    if (card) [row = row] = await s.db.update(paymentCustomers).set({ cardBrand: card.brand, cardLast4: card.last4, cardExpMonth: card.expMonth, cardExpYear: card.expYear, updatedAt: new Date() }).where(eq(paymentCustomers.id, row.id)).returning();
  }
  const consents = await s.db.select({ purpose: paymentConsents.purpose, createdAt: paymentConsents.createdAt }).from(paymentConsents)
    .where(and(eq(paymentConsents.customerId, customerId), eq(paymentConsents.connectedAccountId, acctKey(acct.accountId)), isNull(paymentConsents.revokedAt))).orderBy(desc(paymentConsents.createdAt)).limit(50);
  return { card: serializeCard(row ?? null), purposes: [...new Set(consents.map((c) => c.purpose))] };
}

async function recordConsents(db: Exec, rows: Array<typeof paymentConsents.$inferInsert>) {
  if (rows.length) await db.insert(paymentConsents).values(rows);
}

/**
 * The customer ticked "save this card" (and/or agreed to renewals / instalments / fee charging) before confirming:
 * attach the Stripe Customer + `setup_future_usage` to the unconfirmed intent and record the consent.
 */
export async function consentToSaveCard(s: Services, p: PaymentRow, input: { purposes: SavePurpose[]; text?: string; locale?: string; ip?: string; source?: string }) {
  if (!['created', 'requires_action'].includes(p.state)) throw conflict('payment_not_open', `This payment is ${p.state}`);
  const req = await saveCardRequirement(s.db, p);
  if (req.mode === 'none') throw conflict('save_card_unavailable', 'Cards cannot be saved for this payment');
  const purposes = [...new Set(input.purposes)].filter((x) => req.purposes.includes(x) || x === 'save_card');
  if (!purposes.length) throw validationError('Choose what the card may be used for', { purposes: `One of ${req.purposes.join(', ')}` });
  const customerId = (await customerForPayment(s.db, p))!;
  const pc = await ensurePaymentCustomer(s, { organizationId: p.organizationId, customerId, connectedAccountId: p.connectedAccountId });
  await s.payments.enableCardSaving({ paymentIntentId: p.externalId, connectedAccountId: p.connectedAccountId, customerId: pc.stripeCustomerId });
  const [org] = await s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, p.organizationId));
  const already = await s.db.select({ purpose: paymentConsents.purpose }).from(paymentConsents).where(and(eq(paymentConsents.paymentId, p.id), isNull(paymentConsents.revokedAt)));
  await recordConsents(s.db, purposes.filter((x) => !already.some((a) => a.purpose === x)).map((purpose) => ({
    organizationId: p.organizationId, customerId, connectedAccountId: acctKey(p.connectedAccountId), purpose,
    // Fee consent is tied to the booking; the others to the paid record.
    targetType: p.targetType, targetId: p.targetId, paymentId: p.id,
    text: (input.text?.trim() || CONSENT_TEXT[purpose](org?.name ?? 'the business')).slice(0, 2000), locale: input.locale ?? null, source: input.source ?? 'web', ip: input.ip ?? null,
  })));
  await audit(s.db, { organizationId: p.organizationId, actorUserId: null, actorType: 'system', action: 'payment.card_saving_consented', scopeKind: 'location', scopeId: p.locationId, targetType: 'payment', targetId: p.id, metadata: { purposes } });
  return { purposes };
}

/** Fee-charging consent for a booking that needed no payment (paid with credits or a membership). */
export async function recordFeeConsent(s: Services, input: { organizationId: string; locationId: string; customerId: string; targetType: 'class_booking' | 'appointment'; targetId: string; text?: string; locale?: string; ip?: string; source?: string }) {
  const policy = await feePolicyFor(s.db, input.targetType, input.targetId);
  if (!policy) throw conflict('no_fee_policy', 'This booking has no late-cancellation or no-show fee');
  const acct = await connectedAccountFor(s.db, input.organizationId, input.locationId);
  const [existing] = await s.db.select({ id: paymentConsents.id }).from(paymentConsents).where(and(eq(paymentConsents.targetType, input.targetType), eq(paymentConsents.targetId, input.targetId), eq(paymentConsents.purpose, 'fees'), isNull(paymentConsents.revokedAt)));
  if (!existing) {
    await recordConsents(s.db, [{
      organizationId: input.organizationId, customerId: input.customerId, connectedAccountId: acctKey(acct.accountId), purpose: 'fees', targetType: input.targetType, targetId: input.targetId,
      text: (input.text?.trim() || CONSENT_TEXT.fees(acct.org.name)).slice(0, 2000), locale: input.locale ?? null, source: input.source ?? 'web', ip: input.ip ?? null,
    }]);
  }
  const card = await savedCardFor(s.db, input.customerId, acct.accountId);
  return { consented: true, hasSavedCard: !!card, policy };
}

async function hasConsent(db: Exec, where: { customerId: string; connectedAccountId: string | null; purpose: SavePurpose; targetType?: string; targetId?: string }) {
  const conds = [eq(paymentConsents.customerId, where.customerId), eq(paymentConsents.connectedAccountId, acctKey(where.connectedAccountId)), eq(paymentConsents.purpose, where.purpose), isNull(paymentConsents.revokedAt)];
  if (where.targetType) conds.push(eq(paymentConsents.targetType, where.targetType));
  if (where.targetId) conds.push(eq(paymentConsents.targetId, where.targetId));
  const [row] = await db.select({ id: paymentConsents.id }).from(paymentConsents).where(and(...conds)).limit(1);
  return !!row;
}

/** Withdraw saved-card consents (customer removed the card). Existing charges are unaffected. */
export async function removeSavedCard(s: Services, organizationId: string, locationId: string, customerId: string) {
  const acct = await connectedAccountFor(s.db, organizationId, locationId);
  await s.db.update(paymentConsents).set({ revokedAt: new Date() }).where(and(eq(paymentConsents.customerId, customerId), eq(paymentConsents.connectedAccountId, acctKey(acct.accountId)), isNull(paymentConsents.revokedAt)));
  await s.db.update(paymentCustomers).set({ defaultPaymentMethodId: null, cardBrand: null, cardLast4: null, cardExpMonth: null, cardExpYear: null, updatedAt: new Date() }).where(and(eq(paymentCustomers.customerId, customerId), eq(paymentCustomers.connectedAccountId, acctKey(acct.accountId))));
  return { removed: true };
}

// Required saving (memberships, instalment plans): the intent is created with the Customer and setup_future_usage.
paymentIntentCustomizers.push(async (s, input) => {
  if (!input.targetId) return null;
  const req = await saveCardRequirement(s.db, { targetType: input.targetType, targetId: input.targetId });
  if (req.mode !== 'required') return null;
  const customerId = await customerForPayment(s.db, { targetType: input.targetType, targetId: input.targetId });
  if (!customerId) return null;
  const pc = await ensurePaymentCustomer(s, { organizationId: input.organizationId, customerId, connectedAccountId: input.connectedAccountId });
  return { customerId: pc.stripeCustomerId, setupFutureUsage: 'off_session' as const };
});

/** After a payment succeeds with a card the customer agreed to save: remember it as the default for that account. */
paymentSucceededHooks.push(async (tx, ref, pi) => {
  const consents = await tx.select().from(paymentConsents).where(and(eq(paymentConsents.paymentId, ref.id), isNull(paymentConsents.revokedAt)));
  const piCustomer = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id ?? null;
  const pm = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id ?? null;
  if (!consents.length && !(piCustomer && pm && pi.setup_future_usage)) return;
  const customerId = consents[0]?.customerId ?? null;
  const conds = piCustomer ? eq(paymentCustomers.stripeCustomerId, piCustomer) : customerId ? and(eq(paymentCustomers.customerId, customerId), eq(paymentCustomers.connectedAccountId, acctKey(ref.connectedAccountId))) : null;
  if (!conds) return;
  const [row] = await tx.select().from(paymentCustomers).where(conds).for('update');
  if (!row) return;
  // Sandbox payments carry no real method: keep a stable fake id so off-session flows can be exercised end to end.
  const method = pm ?? (ref.sandbox === 1 ? `pm_sandbox_${sha256(row.id).slice(0, 12)}` : null);
  if (!method) return;
  await tx.update(paymentCustomers).set({ defaultPaymentMethodId: method, ...(method !== row.defaultPaymentMethodId ? { cardBrand: null, cardLast4: null, cardExpMonth: null, cardExpYear: null } : {}), updatedAt: new Date() }).where(eq(paymentCustomers.id, row.id));
});

// ───────────────────────── Card updates (SetupIntent) ─────────────────────────

/** Start a card update / save for (customer, location account). The client confirms with Stripe.js `confirmSetup` or PaymentSheet. */
export async function startCardSetup(s: Services, input: { organizationId: string; locationId: string; customerId: string; purposes?: SavePurpose[]; text?: string; locale?: string; ip?: string; source?: string }) {
  const cfg = await clientConfigFor(s, input.organizationId, input.locationId);
  const acct = await connectedAccountFor(s.db, input.organizationId, input.locationId);
  if (!acct.enabled) throw new AppError(409, 'payments_not_enabled', 'This location cannot accept online payments yet');
  const pc = await ensurePaymentCustomer(s, { organizationId: input.organizationId, customerId: input.customerId, connectedAccountId: acct.accountId });
  const si = await s.payments.createSetupIntent({ connectedAccountId: acct.accountId, customerId: pc.stripeCustomerId, metadata: { bh_org: input.organizationId, bh_location: input.locationId, bh_customer: input.customerId, bh_payment_customer: pc.id }, idempotencyKey: `setup:${pc.id}:${Date.now()}` });
  const purposes = (input.purposes?.length ? input.purposes : ['save_card']) as SavePurpose[];
  await recordConsents(s.db, purposes.map((purpose) => ({
    organizationId: input.organizationId, customerId: input.customerId, connectedAccountId: acctKey(acct.accountId), purpose, targetType: 'setup_intent', targetId: null,
    text: (input.text?.trim() || CONSENT_TEXT[purpose](acct.org.name)).slice(0, 2000), locale: input.locale ?? null, source: input.source ?? 'web', ip: input.ip ?? null,
  })));
  const sandbox = s.payments.mode === 'sandbox' || si.id.includes('_sandbox_');
  return {
    setupIntentId: si.id, clientSecret: si.clientSecret, ...cfg, mode: sandbox ? 'sandbox' as const : 'live' as const, sandbox,
    // Sandbox only: a signed handle for POST /v1/public/payments/setup/:id/sandbox-complete.
    sandboxToken: sandbox ? setupToken(s.cfg, `${si.id}:${pc.id}`) : null, paymentCustomerId: pc.id,
  };
}

/** Sandbox: simulate the customer completing the SetupIntent, through the normal event processor. */
export async function sandboxCompleteSetup(s: Services, setupIntentId: string, paymentCustomerId: string, token: string, card: 'ok' | 'decline' | 'sca' = 'ok') {
  if (s.payments.mode !== 'sandbox' || s.cfg.NODE_ENV === 'production') throw notFound('Route');
  if (token !== setupToken(s.cfg, `${setupIntentId}:${paymentCustomerId}`)) throw notFound('Setup');
  const [pc] = await s.db.select().from(paymentCustomers).where(eq(paymentCustomers.id, paymentCustomerId));
  if (!pc) throw notFound('Setup');
  const pm = card === 'ok' ? `pm_sandbox_${sha256(`${setupIntentId}`).slice(0, 12)}` : `pm_sandbox_${card}_${sha256(setupIntentId).slice(0, 8)}`;
  const event = {
    id: `evt_sandbox_${crypto.randomUUID()}`, object: 'event', type: 'setup_intent.succeeded', account: pc.connectedAccountId || undefined, created: Math.floor(Date.now() / 1000), livemode: false,
    api_version: null, pending_webhooks: 0, request: { id: null, idempotency_key: null },
    data: { object: { id: setupIntentId, object: 'setup_intent', status: 'succeeded', customer: pc.stripeCustomerId, payment_method: pm, metadata: { bh_payment_customer: pc.id } } },
  } as unknown as Stripe.Event;
  return processStripeEvent(s, event);
}

/** setup_intent.succeeded (Connect): new default card → customer default, subscriptions, and retry of failed renewals. */
stripeEventExtensions.push(async (tx, event, s) => {
    if (event.type !== 'setup_intent.succeeded') return null;
    const si = event.data.object as Stripe.SetupIntent;
    const stripeCustomer = typeof si.customer === 'string' ? si.customer : si.customer?.id ?? null;
    const pm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id ?? null;
    if (!stripeCustomer || !pm) return { note: 'Setup intent without customer or payment method' };
    const account = (event as { account?: string }).account ?? '';
    const [pc] = await tx.select().from(paymentCustomers).where(and(eq(paymentCustomers.stripeCustomerId, stripeCustomer), eq(paymentCustomers.connectedAccountId, account))).for('update');
    if (!pc) return { note: 'Setup intent for a customer not created by BranchHarbor' };
    const card = s ? await s.payments.retrievePaymentMethod(pm, account || null).catch(() => null) : null;
    await tx.update(paymentCustomers).set({ defaultPaymentMethodId: pm, cardBrand: card?.brand ?? null, cardLast4: card?.last4 ?? null, cardExpMonth: card?.expMonth ?? null, cardExpYear: card?.expYear ?? null, updatedAt: new Date() }).where(eq(paymentCustomers.id, pc.id));
    let retried = 0;
    if (s) {
      await s.payments.setDefaultPaymentMethod({ connectedAccountId: account || null, customerId: stripeCustomer, paymentMethodId: pm });
      const ms = await tx.select().from(memberships).where(and(eq(memberships.customerId, pc.customerId), inArray(memberships.status, ['active', 'grace', 'suspended']), eq(memberships.recurring, true)));
      for (const m of ms) {
        if (!m.locationId) continue;
        const acct = await connectedAccountFor(tx, m.organizationId, m.locationId);
        if (acctKey(acct.accountId) !== account) continue;
        if (m.stripeSubscriptionId && !m.stripeSubscriptionId.startsWith('sub_sandbox_')) {
          await s.payments.updateSubscriptionPaymentMethod({ connectedAccountId: account || null, subscriptionId: m.stripeSubscriptionId, paymentMethodId: pm });
          if (m.status !== 'active') retried += await s.payments.payOpenInvoices({ connectedAccountId: account || null, subscriptionId: m.stripeSubscriptionId });
        } else if (s.payments.mode === 'sandbox' && m.status !== 'active' && !pm.includes('decline')) {
          // Sandbox: the renewal is retried with the new card right away.
          await sandboxRenewal(tx, m);
          retried++;
        }
      }
      const subs = await tx.select().from(foodMealPlanSubscriptions).where(and(eq(foodMealPlanSubscriptions.customerId, pc.customerId), inArray(foodMealPlanSubscriptions.status, ['active', 'paused', 'past_due'])));
      for (const sub of subs) {
        const acct = await connectedAccountFor(tx, sub.organizationId, sub.locationId);
        if (acctKey(acct.accountId) !== account || !sub.externalId) continue;
        if (!sub.sandbox) {
          await s.payments.updateSubscriptionPaymentMethod({ connectedAccountId: account || null, subscriptionId: sub.externalId, paymentMethodId: pm });
          if (sub.status === 'past_due') retried += await s.payments.payOpenInvoices({ connectedAccountId: account || null, subscriptionId: sub.externalId });
        } else if (sub.status === 'past_due' && !pm.includes('decline')) {
          await tx.update(foodMealPlanSubscriptions).set({ status: 'active', updatedAt: new Date() }).where(eq(foodMealPlanSubscriptions.id, sub.id));
          retried++;
        }
      }
    }
    await audit(tx, { organizationId: pc.organizationId, actorUserId: null, actorType: 'webhook', action: 'payment.card_updated', scopeKind: 'organization', scopeId: pc.organizationId, targetType: 'customer', targetId: pc.customerId, metadata: { eventId: event.id, retried } });
    return { note: `Saved card updated${retried ? `; ${retried} renewal(s) retried` : ''}`, organizationId: pc.organizationId };
});

async function sandboxRenewal(tx: Tx, m: typeof memberships.$inferSelect) {
  const [ref] = await tx.insert(paymentReferences).values({
    organizationId: m.organizationId, locationId: m.locationId, provider: 'stripe', externalId: `in_sandbox_${sha256(`${m.id}:${Date.now()}`).slice(0, 16)}`, amountMinor: m.priceMinor ?? 0, currency: m.currency ?? 'USD',
    state: 'succeeded', succeededAt: new Date(), targetType: 'membership_invoice', sandbox: 1,
  }).returning();
  const r = await recordRenewal(tx, m, { outcome: 'paid', paymentId: ref!.id });
  await tx.update(paymentReferences).set({ targetId: r.invoice.id }).where(eq(paymentReferences.id, ref!.id));
}

// ───────────────────────── Recurring prices and membership subscriptions ─────────────────────────

/** One recurring price per (account, plan key, currency, amount, interval), created once on the connected account. */
export async function ensureRecurringPrice(s: Services, input: { connectedAccountId: string | null; planKey: string; productName: string; amountMinor: number; currency: string; interval: 'week' | 'month' }) {
  const key = acctKey(input.connectedAccountId);
  const where = and(eq(stripeRecurringPrices.connectedAccountId, key), eq(stripeRecurringPrices.planKey, input.planKey), eq(stripeRecurringPrices.currency, input.currency), eq(stripeRecurringPrices.amountMinor, input.amountMinor), eq(stripeRecurringPrices.interval, input.interval));
  const [hit] = await s.db.select().from(stripeRecurringPrices).where(where);
  if (hit) return { productId: hit.stripeProductId, priceId: hit.stripePriceId };
  const lookupKey = `bh_${input.planKey}_${input.currency.toLowerCase()}_${input.amountMinor}_${input.interval}`.replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 200);
  const created = await s.payments.ensureRecurringPrice({ connectedAccountId: input.connectedAccountId, lookupKey, productName: input.productName, amountMinor: input.amountMinor, currency: input.currency, interval: input.interval, metadata: { bh_plan: input.planKey } });
  await s.db.insert(stripeRecurringPrices).values({ connectedAccountId: key, planKey: input.planKey, currency: input.currency, amountMinor: input.amountMinor, interval: input.interval, stripeProductId: created.productId, stripePriceId: created.priceId }).onConflictDoNothing();
  const [row] = await s.db.select().from(stripeRecurringPrices).where(where);
  return { productId: row!.stripeProductId, priceId: row!.stripePriceId };
}

export type SubscriptionSetupResult = { status: 'created' | 'exists'; subscriptionId: string } | { status: 'needs_card' | 'needs_consent' | 'not_eligible'; subscriptionId: null };

/**
 * Create the Stripe subscription for a membership whose first period was paid at checkout: saved card as default,
 * price from the plan (created once per plan/currency), billing from the end of the paid period. Idempotent: the
 * row lock + Stripe idempotency key mean a second call never creates a second subscription.
 */
export async function ensureMembershipSubscription(s: Services, membershipId: string): Promise<SubscriptionSetupResult> {
  const [m] = await s.db.select().from(memberships).where(eq(memberships.id, membershipId));
  if (!m || !m.recurring || !m.locationId || !['active', 'grace'].includes(m.status) || m.cancelAt) return { status: 'not_eligible', subscriptionId: null };
  if (m.stripeSubscriptionId) return { status: 'exists', subscriptionId: m.stripeSubscriptionId };
  const acct = await connectedAccountFor(s.db, m.organizationId, m.locationId);
  if (!(await hasConsent(s.db, { customerId: m.customerId, connectedAccountId: acct.accountId, purpose: 'renewals' }))) return { status: 'needs_consent', subscriptionId: null };
  const card = await savedCardFor(s.db, m.customerId, acct.accountId);
  if (!card) return { status: 'needs_card', subscriptionId: null };
  const [plan] = m.planId ? await s.db.select().from(studioMembershipPlans).where(eq(studioMembershipPlans.id, m.planId)) : [];
  const currency = m.currency ?? acct.location.currency;
  const price = await ensureRecurringPrice(s, { connectedAccountId: acct.accountId, planKey: `studio_plan:${m.planId ?? m.id}`, productName: plan?.name ?? m.plan, amountMinor: m.priceMinor ?? 0, currency, interval: 'month' });
  return s.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(memberships).where(eq(memberships.id, m.id)).for('update');
    if (locked?.stripeSubscriptionId) return { status: 'exists' as const, subscriptionId: locked.stripeSubscriptionId };
    const sub = await s.payments.createSubscription({
      connectedAccountId: acct.accountId, customerId: card.stripeCustomerId, priceId: price.priceId, defaultPaymentMethodId: card.defaultPaymentMethodId, trialEnd: m.currentPeriodEnd,
      applicationFeePercent: (acct.feeBps ?? 0) / 100, metadata: { bh_org: m.organizationId, bh_location: m.locationId!, bh_membership: m.id }, idempotencyKey: `membership:${m.id}:subscription`, collectFirstPayment: false,
    });
    await tx.update(memberships).set({ stripeCustomerId: card.stripeCustomerId, stripeSubscriptionId: sub.id, updatedAt: new Date() }).where(eq(memberships.id, m.id));
    await audit(tx, { organizationId: m.organizationId, actorUserId: null, actorType: 'system', action: 'membership.subscription_created', scopeKind: 'location', scopeId: m.locationId, targetType: 'membership', targetId: m.id, metadata: { subscriptionId: sub.id, priceId: price.priceId } });
    return { status: 'created' as const, subscriptionId: sub.id };
  });
}

// ───────────────────────── Off-session charges ─────────────────────────

export type OffSessionKind = 'studio_fee' | 'wellness_fee' | 'sports_instalment';

export interface OffSessionInput {
  kind: OffSessionKind;
  refId: string;
  organizationId: string;
  locationId: string;
  customerId: string;
  amountMinor: number;
  currency: string;
  /** Payment target the webhook fulfils (studio_fee / wellness_fee / registration). */
  targetType: string;
  targetId: string;
  description: string;
  attempt?: number;
  metadata?: Record<string, string>;
}

export type OffSessionOutcome = { state: 'skipped'; reason: string; chargeId: null } | { state: 'duplicate' | 'succeeded' | 'processing' | 'failed' | 'requires_action'; chargeId: string; paymentId: string | null; reason?: string };

/**
 * Merchant-initiated charge of the customer's saved card. Idempotent per (kind, ref, attempt): the row's unique key is
 * also Stripe's idempotency key. Fulfilment (fee paid / instalment paid) happens only through the payment event.
 */
export async function chargeOffSession(s: Services, i: OffSessionInput): Promise<OffSessionOutcome> {
  const acct = await connectedAccountFor(s.db, i.organizationId, i.locationId);
  if (!acct.enabled) return { state: 'skipped', reason: 'payments_not_enabled', chargeId: null };
  if (acct.location.currency !== i.currency) return { state: 'skipped', reason: 'currency_mismatch', chargeId: null };
  const card = await savedCardFor(s.db, i.customerId, acct.accountId);
  if (!card) return { state: 'skipped', reason: 'no_saved_card', chargeId: null };
  const attempt = i.attempt ?? 1;
  const idempotencyKey = `${i.kind}:${i.refId}:${attempt}`;
  const [row] = await s.db.insert(offSessionCharges).values({
    organizationId: i.organizationId, locationId: i.locationId, kind: i.kind, refId: i.refId, attempt, idempotencyKey, customerId: i.customerId, amountMinor: i.amountMinor, currency: i.currency, state: 'pending',
  }).onConflictDoNothing({ target: offSessionCharges.idempotencyKey }).returning();
  if (!row) {
    const [existing] = await s.db.select().from(offSessionCharges).where(eq(offSessionCharges.idempotencyKey, idempotencyKey));
    return { state: 'duplicate', chargeId: existing!.id, paymentId: existing!.paymentId };
  }
  const applicationFeeMinor = Math.floor((i.amountMinor * acct.feeBps) / 10_000);
  let res;
  try {
    res = await s.payments.chargeOffSession({
      amountMinor: i.amountMinor, currency: i.currency, connectedAccountId: acct.accountId, applicationFeeMinor, customerId: card.stripeCustomerId, paymentMethodId: card.defaultPaymentMethodId!,
      idempotencyKey, description: i.description,
      metadata: { bh_org: i.organizationId, bh_location: i.locationId, bh_target_type: i.targetType, bh_target_id: i.targetId, bh_off_session: row.id, ...(i.metadata ?? {}) },
    });
  } catch (err) {
    // Network/API failure: leave the attempt open for staff (never charge twice: the same key is reused on retry by Stripe).
    await s.db.update(offSessionCharges).set({ state: 'failed', failureCode: 'provider_error', failureMessage: (err as Error).message.slice(0, 300), updatedAt: new Date() }).where(eq(offSessionCharges.id, row.id));
    s.log.error({ err, chargeId: row.id }, '[payments] off-session charge failed at provider');
    await notifyChargeProblem(s, row.id, 'failed');
    return { state: 'failed', chargeId: row.id, paymentId: null, reason: 'provider_error' };
  }
  const sandbox = s.payments.mode === 'sandbox' || (res.id ?? '').includes('_sandbox_');
  let paymentId: string | null = null;
  if (res.id) {
    const [ref] = await s.db.insert(paymentReferences).values({
      organizationId: i.organizationId, locationId: i.locationId, provider: 'stripe', externalId: res.id, connectedAccountId: acct.accountId, amountMinor: i.amountMinor, currency: i.currency,
      applicationFeeMinor, state: sandbox ? 'created' : res.status === 'succeeded' ? 'processing' : res.status === 'failed' ? 'failed' : res.status === 'requires_action' ? 'requires_action' : 'processing',
      targetType: i.targetType, targetId: i.targetId, clientSecret: res.clientSecret, sandbox: sandbox ? 1 : 0,
    }).onConflictDoUpdate({ target: [paymentReferences.provider, paymentReferences.externalId], set: { updatedAt: new Date() } }).returning();
    paymentId = ref!.id;
  }
  const state = res.status === 'succeeded' ? 'processing' : res.status;
  await s.db.update(offSessionCharges).set({ paymentId, state, failureCode: res.failureCode ?? null, failureMessage: res.failureMessage ?? null, updatedAt: new Date() }).where(eq(offSessionCharges.id, row.id));
  if (i.kind === 'sports_instalment' && paymentId) await s.db.update(sportsInstalments).set({ paymentId, paymentAttempts: sql`${sportsInstalments.paymentAttempts} + 1`, updatedAt: new Date() }).where(eq(sportsInstalments.id, i.refId));
  if (sandbox && paymentId && (res.status === 'succeeded' || res.status === 'failed')) {
    // Same processing path a real webhook takes.
    const [p] = await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, paymentId));
    await processStripeEvent(s, sandboxEvent(p!, res.status === 'succeeded' ? 'payment_intent.succeeded' : 'payment_intent.payment_failed'));
  } else if (!sandbox && res.status === 'failed') {
    await markChargeFailed(s.db, row.id, res.failureCode ?? 'card_declined', res.failureMessage ?? 'Card declined');
  }
  if (res.status === 'failed' || res.status === 'requires_action') await notifyChargeProblem(s, row.id, res.status);
  const [after] = await s.db.select().from(offSessionCharges).where(eq(offSessionCharges.id, row.id));
  return { state: after!.state as 'succeeded', chargeId: row.id, paymentId, reason: res.failureCode ?? undefined };
}

async function markChargeFailed(db: Exec, chargeId: string, code: string, message: string) {
  await db.update(offSessionCharges).set({ state: 'failed', failureCode: code, failureMessage: message.slice(0, 300), updatedAt: new Date() }).where(and(eq(offSessionCharges.id, chargeId), inArray(offSessionCharges.state, ['pending', 'processing', 'requires_action'])));
}

/** Email (and push when the customer has the app) about a failed off-session charge or one that needs the customer's confirmation (SCA). */
export async function notifyChargeProblem(s: Services, chargeId: string, kind: 'failed' | 'requires_action') {
  const [ch] = await s.db.select().from(offSessionCharges).where(eq(offSessionCharges.id, chargeId));
  if (!ch || ch.notifiedAt) return;
  const [c] = await s.db.select().from(customers).where(eq(customers.id, ch.customerId));
  const [row] = await s.db.select({ org: organizations, loc: locations }).from(locations).innerJoin(organizations, eq(organizations.id, locations.organizationId)).where(eq(locations.id, ch.locationId));
  if (!row) return;
  const what = ch.kind === 'sports_instalment' ? 'registration instalment' : 'cancellation fee';
  const money = new Intl.NumberFormat('en', { style: 'currency', currency: ch.currency }).format(ch.amountMinor / 10 ** (new Intl.NumberFormat('en', { style: 'currency', currency: ch.currency }).resolvedOptions().maximumFractionDigits ?? 2));
  const base = `${s.cfg.SITES_BASE_URL.replace(/\/$/, '')}/${row.org.slug}/${row.loc.slug}`;
  const link = ch.paymentId ? `${base}/pay/${ch.paymentId}?token=${paymentActionToken(s.cfg, ch.paymentId)}` : null;
  const portal = ch.kind === 'sports_instalment' ? `${base}/programmes/portal` : ch.kind === 'studio_fee' ? `${base}/account` : `${base}/book`;
  const text = kind === 'requires_action'
    ? `Your bank asked you to confirm the ${what} of ${money} to ${row.org.name}. Complete the payment here: ${link ?? portal}`
    : `We couldn't charge your saved card for the ${what} of ${money} to ${row.org.name}${ch.failureMessage ? ` (${ch.failureMessage})` : ''}. You can pay it here: ${portal}`;
  if (c?.email) await s.jobs.enqueue('email.send', { to: c.email, subject: kind === 'requires_action' ? `Confirm your payment to ${row.org.name}` : `Payment failed: ${row.org.name}`, text, tag: 'payment-action' });
  if (c?.userId) {
    const { notify } = await import('./notifications.ts');
    await notify(s, { userIds: [c.userId], organizationId: ch.organizationId, category: 'order_status', title: kind === 'requires_action' ? 'Confirm your payment' : 'Payment failed', body: text.slice(0, 180), data: { paymentId: ch.paymentId, url: link ?? portal } });
  }
  await s.db.update(offSessionCharges).set({ notifiedAt: new Date() }).where(eq(offSessionCharges.id, ch.id));
}

// Payment targets for automatic fees (fulfilled by the payment event, like every other target).
paymentTargetExtensions.studio_fee = {
  async fulfil(tx, p) {
    const [f] = await tx.select().from(studioFees).where(eq(studioFees.id, p.targetId!)).for('update');
    if (!f) return { fulfilled: false, note: 'Fee record missing' };
    await tx.update(offSessionCharges).set({ state: 'succeeded', updatedAt: new Date() }).where(eq(offSessionCharges.paymentId, p.id));
    if (f.status === 'paid') return { fulfilled: true, note: 'Fee already paid — duplicate flagged for refund' };
    if (f.status === 'waived') return { fulfilled: false, note: 'Fee was waived before the charge completed — refund this payment' };
    await tx.update(studioFees).set({ status: 'paid', updatedAt: new Date() }).where(eq(studioFees.id, f.id));
    await audit(tx, { organizationId: f.organizationId, actorUserId: null, actorType: 'webhook', action: 'fee.auto_charged', scopeKind: 'location', scopeId: f.locationId, targetType: 'studio_fee', targetId: f.id, metadata: { paymentId: p.id } });
    return { fulfilled: true, note: 'Fee charged to the saved card' };
  },
  async isRecorded(db, p) {
    const [f] = await db.select().from(studioFees).where(eq(studioFees.id, p.targetId!));
    return { ok: !!f && f.status === 'paid', expected: f ? { amount: f.amountMinor, currency: f.currency } : null };
  },
};

paymentTargetExtensions.wellness_fee = {
  async fulfil(tx, p) {
    const [c] = await tx.select().from(wellnessAppointmentCharges).where(eq(wellnessAppointmentCharges.id, p.targetId!)).for('update');
    if (!c) return { fulfilled: false, note: 'Fee record missing' };
    await tx.update(offSessionCharges).set({ state: 'succeeded', updatedAt: new Date() }).where(eq(offSessionCharges.paymentId, p.id));
    if (c.status === 'waived') return { fulfilled: false, note: 'Fee was waived before the charge completed — refund this payment' };
    if (c.status === 'settled') return { fulfilled: true, note: 'Fee already settled' };
    await tx.update(wellnessAppointmentCharges).set({ status: 'settled', outstandingMinor: 0 }).where(eq(wellnessAppointmentCharges.id, c.id));
    await audit(tx, { organizationId: c.organizationId, actorUserId: null, actorType: 'webhook', action: 'fee.auto_charged', scopeKind: 'location', scopeId: c.locationId, targetType: 'wellness_charge', targetId: c.id, metadata: { paymentId: p.id } });
    return { fulfilled: true, note: 'Fee charged to the saved card' };
  },
  async isRecorded(db, p) {
    const [c] = await db.select().from(wellnessAppointmentCharges).where(eq(wellnessAppointmentCharges.id, p.targetId!));
    return { ok: !!c && c.status === 'settled', expected: c ? { amount: c.feeMinor - c.retainedFromDepositMinor - c.retainedFromVoucherMinor, currency: c.currency } : null };
  },
};

paymentFailureHooks.push(async (tx, p) => {
  await tx.update(offSessionCharges).set({ state: 'failed', failureCode: sql`coalesce(${offSessionCharges.failureCode}, 'payment_failed')`, updatedAt: new Date() })
    .where(and(eq(offSessionCharges.paymentId, p.id), inArray(offSessionCharges.state, ['pending', 'processing', 'requires_action'])));
});

// ───────────────────────── Scheduled automation ─────────────────────────

async function orgAutomation(db: Exec, organizationId: string, cache: Map<string, PaymentAutomationSettings>) {
  let a = cache.get(organizationId);
  if (!a) {
    const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, organizationId));
    a = o ? automationSettings(o) : DEFAULT_AUTOMATION;
    cache.set(organizationId, a);
  }
  return a;
}

/**
 * Charge due late-cancel / no-show fees to the saved card when the customer consented at booking, the organisation
 * allows it, and the staff waive window has passed. Each fee is charged at most once (idempotency key per fee).
 */
export async function runAutoFeeCharges(s: Services, now = new Date(), opts: { organizationId?: string } = {}) {
  const stats = { charged: 0, failed: 0, requiresAction: 0, skipped: 0 };
  const cache = new Map<string, PaymentAutomationSettings>();
  const tally = (o: OffSessionOutcome) => {
    if (o.state === 'succeeded' || o.state === 'processing') stats.charged++;
    else if (o.state === 'failed') stats.failed++;
    else if (o.state === 'requires_action') stats.requiresAction++;
    else stats.skipped++;
  };
  const tried = async (kind: OffSessionKind, ids: string[]) => new Set(ids.length ? (await s.db.select({ refId: offSessionCharges.refId }).from(offSessionCharges).where(and(eq(offSessionCharges.kind, kind), inArray(offSessionCharges.refId, ids)))).map((r) => r.refId) : []);

  const fees = await s.db.select().from(studioFees).where(and(eq(studioFees.status, 'due'), ...(opts.organizationId ? [eq(studioFees.organizationId, opts.organizationId)] : []))).orderBy(asc(studioFees.createdAt)).limit(200);
  const doneFees = await tried('studio_fee', fees.map((f) => f.id));
  for (const f of fees) {
    if (doneFees.has(f.id)) continue;
    const a = await orgAutomation(s.db, f.organizationId, cache);
    if (!a.autoChargeFees || f.createdAt.getTime() > now.getTime() - a.feeChargeDelayHours * 3600_000) continue;
    const acct = await connectedAccountFor(s.db, f.organizationId, f.locationId);
    if (!(await hasConsent(s.db, { customerId: f.customerId, connectedAccountId: acct.accountId, purpose: 'fees', targetType: 'class_booking', targetId: f.bookingId }))) continue;
    tally(await chargeOffSession(s, { kind: 'studio_fee', refId: f.id, organizationId: f.organizationId, locationId: f.locationId, customerId: f.customerId, amountMinor: f.amountMinor, currency: f.currency, targetType: 'studio_fee', targetId: f.id, description: f.kind === 'no_show' ? 'No-show fee' : 'Late cancellation fee' }));
  }

  const charges = await s.db.select({ c: wellnessAppointmentCharges, customerId: appointments.customerId }).from(wellnessAppointmentCharges).innerJoin(appointments, eq(appointments.id, wellnessAppointmentCharges.appointmentId))
    .where(and(eq(wellnessAppointmentCharges.status, 'outstanding'), sql`${wellnessAppointmentCharges.outstandingMinor} > 0`, ...(opts.organizationId ? [eq(wellnessAppointmentCharges.organizationId, opts.organizationId)] : []))).orderBy(asc(wellnessAppointmentCharges.createdAt)).limit(200);
  const doneCharges = await tried('wellness_fee', charges.map((x) => x.c.id));
  for (const { c, customerId } of charges) {
    if (doneCharges.has(c.id)) continue;
    const a = await orgAutomation(s.db, c.organizationId, cache);
    if (!a.autoChargeFees || c.createdAt.getTime() > now.getTime() - a.feeChargeDelayHours * 3600_000) continue;
    const acct = await connectedAccountFor(s.db, c.organizationId, c.locationId);
    if (!(await hasConsent(s.db, { customerId, connectedAccountId: acct.accountId, purpose: 'fees', targetType: 'appointment', targetId: c.appointmentId }))) continue;
    tally(await chargeOffSession(s, { kind: 'wellness_fee', refId: c.id, organizationId: c.organizationId, locationId: c.locationId, customerId, amountMinor: c.outstandingMinor, currency: c.currency, targetType: 'wellness_fee', targetId: c.id, description: c.kind === 'no_show' ? 'No-show fee' : 'Late cancellation fee' }));
  }
  return stats;
}

/**
 * Charge sports instalments (after the first) on their due date in the location's time zone, with the card saved at
 * registration. One automatic attempt per instalment; a failure leaves it unpaid (overdue), notifies the guardian and
 * the portal "pay now" path stays available.
 */
export async function runInstalmentAutoCharges(s: Services, now = new Date(), opts: { organizationId?: string } = {}) {
  const stats = { charged: 0, failed: 0, requiresAction: 0, skipped: 0 };
  const cache = new Map<string, PaymentAutomationSettings>();
  const maxDue = new Date(now.getTime() + DAY).toISOString().slice(0, 10);
  const rows = await s.db.select({ i: sportsInstalments, r: registrations, tz: locations.timeZone }).from(sportsInstalments)
    .innerJoin(registrations, eq(registrations.id, sportsInstalments.registrationId)).innerJoin(locations, eq(locations.id, sportsInstalments.locationId))
    .where(and(eq(sportsInstalments.status, 'scheduled'), lte(sportsInstalments.dueOn, maxDue), sql`${sportsInstalments.seq} > 1`, eq(registrations.paymentPlan, 'instalments'), inArray(registrations.status, ['accepted', 'awaiting_review']),
      ...(opts.organizationId ? [eq(sportsInstalments.organizationId, opts.organizationId)] : []))).orderBy(asc(sportsInstalments.dueOn)).limit(200);
  const ids = rows.map((x) => x.i.id);
  const done = new Set(ids.length ? (await s.db.select({ refId: offSessionCharges.refId }).from(offSessionCharges).where(and(eq(offSessionCharges.kind, 'sports_instalment'), inArray(offSessionCharges.refId, ids)))).map((r) => r.refId) : []);
  for (const { i, r, tz } of rows) {
    if (done.has(i.id) || i.dueOn > localDateParts(now, tz).date || i.amountMinor <= 0 || !r.guardianCustomerId) continue;
    const guardianId = r.guardianCustomerId;
    const a = await orgAutomation(s.db, i.organizationId, cache);
    if (!a.autoChargeInstalments) continue;
    // An instalment already being paid by the guardian is left alone.
    if (i.paymentId) {
      const [p] = await s.db.select({ state: paymentReferences.state }).from(paymentReferences).where(eq(paymentReferences.id, i.paymentId));
      if (p && ['processing', 'succeeded', 'requires_action'].includes(p.state)) continue;
    }
    const acct = await connectedAccountFor(s.db, i.organizationId, i.locationId);
    if (!(await hasConsent(s.db, { customerId: guardianId, connectedAccountId: acct.accountId, purpose: 'instalments' }))) { stats.skipped++; continue; }
    const out = await chargeOffSession(s, {
      kind: 'sports_instalment', refId: i.id, organizationId: i.organizationId, locationId: i.locationId, customerId: guardianId, amountMinor: i.amountMinor, currency: i.currency,
      targetType: 'registration', targetId: r.id, description: `Registration instalment ${i.seq}`, metadata: { bh_instalment: i.id },
    });
    if (out.state === 'succeeded' || out.state === 'processing') stats.charged++;
    else if (out.state === 'failed') {
      stats.failed++;
      await s.db.update(sportsInstalments).set({ lastReminderStage: 'overdue', lastReminderAt: now, remindersSent: sql`${sportsInstalments.remindersSent} + 1`, updatedAt: now }).where(eq(sportsInstalments.id, i.id));
    } else if (out.state === 'requires_action') stats.requiresAction++;
    else stats.skipped++;
  }
  return stats;
}

/** Staff view: automatic charges with their outcome (failures stay visible until the fee is paid or waived). */
export async function listOffSessionCharges(db: Exec, organizationId: string, locationIds: 'all' | string[], filter: { state?: string; kind?: string }) {
  const conds = [eq(offSessionCharges.organizationId, organizationId)];
  if (locationIds !== 'all') {
    if (!locationIds.length) return [];
    conds.push(inArray(offSessionCharges.locationId, locationIds));
  }
  if (filter.state) conds.push(eq(offSessionCharges.state, filter.state));
  if (filter.kind) conds.push(eq(offSessionCharges.kind, filter.kind));
  const rows = await db.select({ ch: offSessionCharges, name: customers.name }).from(offSessionCharges).leftJoin(customers, eq(customers.id, offSessionCharges.customerId)).where(and(...conds)).orderBy(desc(offSessionCharges.createdAt)).limit(200);
  return rows.map(({ ch, name }) => ({
    id: ch.id, kind: ch.kind, refId: ch.refId, attempt: ch.attempt, locationId: ch.locationId, customer: { id: ch.customerId, name }, amount: { amount: ch.amountMinor, currency: ch.currency },
    state: ch.state, failureCode: ch.failureCode, failureMessage: ch.failureMessage, paymentId: ch.paymentId, notifiedAt: ch.notifiedAt?.toISOString() ?? null, createdAt: ch.createdAt.toISOString(),
  }));
}

/** Latest automatic-charge state for a set of fees/instalments (for staff screens). */
export async function autoChargeStates(db: Exec, kind: OffSessionKind, refIds: string[]) {
  if (!refIds.length) return new Map<string, { state: string; failureMessage: string | null; at: string }>();
  const rows = await db.select().from(offSessionCharges).where(and(eq(offSessionCharges.kind, kind), inArray(offSessionCharges.refId, refIds))).orderBy(asc(offSessionCharges.createdAt));
  return new Map(rows.map((r) => [r.refId, { state: r.state, failureMessage: r.failureMessage, at: r.updatedAt.toISOString() }]));
}

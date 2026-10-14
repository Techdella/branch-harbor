import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';

/**
 * Saved payment methods, consents, off-session charges and recurring prices for Stripe Connect
 * (direct charges on the location's connected account).
 */

/** One Stripe Customer per (BranchHarbor customer, connected account). Card details are never stored, only the provider's ids and display hints. */
export const paymentCustomers = pgTable('payment_customers', {
  id: pk(),
  organizationId: orgId(),
  customerId: uuid('customer_id').notNull(),
  /** Connected account the Customer lives on ('' when the platform account is used). */
  connectedAccountId: text('connected_account_id').notNull().default(''),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  defaultPaymentMethodId: text('default_payment_method_id'),
  cardBrand: text('card_brand'),
  cardLast4: text('card_last4'),
  cardExpMonth: integer('card_exp_month'),
  cardExpYear: integer('card_exp_year'),
  sandbox: boolean('sandbox').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('payment_customers_customer_acct_uq').on(t.customerId, t.connectedAccountId),
  index('payment_customers_stripe_idx').on(t.stripeCustomerId),
]);

/**
 * Explicit consents to keep a card on file and charge it later. purpose: save_card | renewals | instalments | fees.
 * `fees` consents are per booking (targetType class_booking / appointment); the others per paid record.
 */
export const paymentConsents = pgTable('payment_consents', {
  id: pk(),
  organizationId: orgId(),
  customerId: uuid('customer_id').notNull(),
  connectedAccountId: text('connected_account_id').notNull().default(''),
  purpose: text('purpose').notNull(),
  targetType: text('target_type'),
  targetId: uuid('target_id'),
  paymentId: uuid('payment_id'),
  /** The exact text the customer agreed to, and its language. */
  text: text('text').notNull(),
  locale: text('locale'),
  source: text('source').notNull().default('web'),
  ip: text('ip'),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
}, (t) => [
  index('payment_consents_target_idx').on(t.targetType, t.targetId, t.purpose),
  index('payment_consents_customer_idx').on(t.customerId, t.purpose),
  index('payment_consents_payment_idx').on(t.paymentId),
]);

/** Merchant-initiated (off-session) charges: automatic fees and instalments. One row per attempt; the idempotency key is also sent to Stripe. */
export const offSessionCharges = pgTable('off_session_charges', {
  id: pk(),
  organizationId: orgId(),
  locationId: uuid('location_id').notNull(),
  /** studio_fee | wellness_fee | sports_instalment */
  kind: text('kind').notNull(),
  refId: uuid('ref_id').notNull(),
  attempt: integer('attempt').notNull().default(1),
  idempotencyKey: text('idempotency_key').notNull(),
  customerId: uuid('customer_id').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  paymentId: uuid('payment_id'),
  /** pending | processing | succeeded | failed | requires_action | cancelled */
  state: text('state').notNull().default('pending'),
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),
  notifiedAt: ts('notified_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('off_session_charges_idem_uq').on(t.idempotencyKey),
  index('off_session_charges_ref_idx').on(t.kind, t.refId),
  index('off_session_charges_payment_idx').on(t.paymentId),
]);

/** Recurring prices created on a connected account, one per (plan key, currency, amount, interval) — created once and reused. */
export const stripeRecurringPrices = pgTable('stripe_recurring_prices', {
  id: pk(),
  connectedAccountId: text('connected_account_id').notNull().default(''),
  planKey: text('plan_key').notNull(),
  currency: currencyCol().notNull(),
  amountMinor: minor('amount_minor').notNull(),
  interval: text('interval').notNull(),
  stripeProductId: text('stripe_product_id').notNull(),
  stripePriceId: text('stripe_price_id').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('stripe_recurring_prices_uq').on(t.connectedAccountId, t.planKey, t.currency, t.amountMinor, t.interval)]);

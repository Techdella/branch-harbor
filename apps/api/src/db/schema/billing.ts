import { check, char, customType, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { organizations } from './core.ts';

/**
 * BranchHarbor's own billing (the platform subscription, separate from customer payments): paid-trial claims,
 * platform invoices, who pays each location's fee in a network, franchisees' own billing accounts and data exports.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * One paid trial per business, per card (Stripe card fingerprint) and per business email domain. A claim made by
 * another organisation means the next checkout starts the plan straight away (no second trial).
 */
export const billingTrialClaims = pgTable('billing_trial_claims', {
  id: pk(),
  /** org | card | email_domain */
  kind: text('kind').notNull(),
  /** Hashed value (sha256) — never the raw card fingerprint or email. */
  valueHash: text('value_hash').notNull(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('billing_trial_claims_kind_value_uq').on(t.kind, t.valueHash), index('billing_trial_claims_org_idx').on(t.organizationId)]);

/** Platform invoices (trial fee, plan renewals, franchisee location fees). Mirrors Stripe invoices in live mode. */
export const billingInvoices = pgTable('billing_invoices', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** hq | franchisee */
  payer: text('payer').notNull().default('hq'),
  franchiseeAccountId: uuid('franchisee_account_id'),
  /** trial_fee | subscription | franchisee_fee */
  kind: text('kind').notNull(),
  number: text('number').notNull(),
  currency: currencyCol().notNull(),
  subtotalMinor: minor('subtotal_minor').notNull(),
  taxMinor: minor('tax_minor').notNull().default(0),
  totalMinor: minor('total_minor').notNull(),
  /** paid | open | void | uncollectible */
  status: text('status').notNull(),
  description: text('description'),
  lines: jsonb('lines').$type<{ description: string; quantity: number; amountMinor: number }[]>().notNull().default([]),
  periodStart: ts('period_start'),
  periodEnd: ts('period_end'),
  stripeInvoiceId: text('stripe_invoice_id'),
  hostedUrl: text('hosted_url'),
  createdAt: createdAt(),
}, (t) => [index('billing_invoices_org_idx').on(t.organizationId, t.createdAt), uniqueIndex('billing_invoices_stripe_uq').on(t.stripeInvoiceId)]);

/**
 * Who pays a network location's per-location fee: HQ, the franchisee or a split. Set per location or per owner group;
 * a location setting wins over its owner group's; neither → HQ pays.
 */
export const locationFeePayers = pgTable('location_fee_payers', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** location | owner_group */
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id').notNull(),
  /** hq | franchisee | split */
  payer: text('payer').notNull(),
  /** Franchisee share for `split` (0–100). */
  franchiseePercent: integer('franchisee_percent').notNull().default(0),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('location_fee_payers_scope_uq').on(t.organizationId, t.scopeKind, t.scopeId),
  check('location_fee_payers_pct', sql`${t.franchiseePercent} between 0 and 100`),
]);

/**
 * A franchisee's own billing account (per owner group or location) for the location fees HQ passes on. Billed in the
 * franchisee's billing country currency, at that country's price list; the card country is checked like HQ's.
 */
export const franchiseeBillingAccounts = pgTable('franchisee_billing_accounts', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id').notNull(),
  billingCountry: char('billing_country', { length: 2 }).notNull(),
  currency: currencyCol().notNull(),
  priceList: text('price_list').notNull(),
  stripeCustomerId: text('stripe_customer_id'),
  stripePaymentMethodId: text('stripe_payment_method_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  card: jsonb('card').$type<{ brand: string | null; last4: string | null; country: string | null } | null>(),
  taxId: text('tax_id'),
  /** needs_payment_method | active */
  status: text('status').notNull().default('needs_payment_method'),
  /** Open card setup (setup intent) for the live card form. */
  setup: jsonb('setup').$type<Record<string, unknown> | null>(),
  /**
   * The franchisee's own Stripe subscription for the location fees HQ passes on (live franchisee charging): its
   * status (trialing until HQ's plan starts, then active / past_due / canceled), the lines last synced and the period.
   */
  subscriptionStatus: text('subscription_status'),
  subscriptionLines: jsonb('subscription_lines').$type<{ lookupKey: string; productName: string; unitAmountMinor: number; quantity: number }[]>().notNull().default([]),
  currentPeriodEnd: ts('current_period_end'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('franchisee_billing_accounts_scope_uq').on(t.organizationId, t.scopeKind, t.scopeId)]);

/** Free data export: a ZIP of CSVs of the organisation's core tables, downloadable for 7 days. */
export const dataExports = pgTable('data_exports', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  requestedBy: uuid('requested_by').notNull(),
  /** queued | running | ready | failed */
  status: text('status').notNull().default('queued'),
  fileName: text('file_name'),
  sizeBytes: integer('size_bytes'),
  /** Row count per CSV file. */
  files: jsonb('files').$type<{ name: string; rows: number }[]>().notNull().default([]),
  /** sha256 of the download token emailed to the owner. */
  tokenHash: text('token_hash'),
  /** Object storage key when S3/R2 is configured; otherwise the bytes live in `content`. */
  storageKey: text('storage_key'),
  content: bytea('content'),
  error: text('error'),
  expiresAt: ts('expires_at'),
  completedAt: ts('completed_at'),
  createdAt: createdAt(),
}, (t) => [index('data_exports_org_idx').on(t.organizationId, t.createdAt)]);

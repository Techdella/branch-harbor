import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations, ownerGroups } from './core.ts';

/**
 * Finance workspace: royalties and marketing fund, invoices and collection, the fund ledger, payouts and
 * reconciliation. Money is always integer minor units with its currency on the same row — nothing here ever holds
 * an amount summed across currencies.
 */

/** Revenue streams a royalty basis can include (payment target types map onto these, see domain/royalty.ts). */
export type RevenueStream = 'bookings' | 'memberships' | 'retail' | 'food' | 'gift_vouchers' | 'other';

export interface RevenueBasis {
  streams: RevenueStream[];
  netOfRefunds: boolean;
  excludeTax: boolean;
  excludeTips: boolean;
  /** Include manually reported sales of locations on an external POS (accepted reports only). */
  includeExternalSales: boolean;
}

export interface RoyaltyTier {
  /** Lower bound of the tier, in minor units of the terms' currency (first tier starts at 0). */
  fromMinor: number;
  bps: number;
}

export interface LateFeeTerms {
  kind: 'none' | 'flat' | 'percent';
  flatMinor?: number;
  bps?: number;
  /** Days after the due date before the fee applies. */
  graceDays: number;
}

export interface FinanceTaxLine {
  name: string;
  rateBps: number;
  /** Applies to invoices for locations in this country only (ISO 3166-1 alpha-2); null = every location. */
  country: string | null;
  appliesTo: Array<'royalty' | 'marketing_fund' | 'technology_fee' | 'late_fee'>;
}

export interface DunningPolicy {
  /** Days after the due date on which collection is retried automatically. */
  retryDays: number[];
  /** Reminder this many days before the due date (0 = none). */
  reminderDaysBefore: number;
  /** Final notice this many days after the due date. */
  finalNoticeAfterDays: number;
}

/** Organisation finance settings (one row per franchisor). */
export const financeSettings = pgTable('finance_settings', {
  organizationId: uuid('organization_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
  /** weekly | monthly */
  periodFrequency: text('period_frequency').notNull().default('monthly'),
  /** 1 = Monday … 7 = Sunday (weekly periods). */
  weekStartsOn: integer('week_starts_on').notNull().default(1),
  invoicePrefix: text('invoice_prefix').notNull().default('INV'),
  /** Next invoice sequence number (gapless per organisation, taken under a row lock). */
  nextInvoiceSeq: integer('next_invoice_seq').notNull().default(1),
  paymentTermsDays: integer('payment_terms_days').notNull().default(10),
  /** Tax lines HQ configured for its invoices. Empty = no tax is added (BranchHarbor never invents tax). */
  taxLines: jsonb('tax_lines').$type<FinanceTaxLine[]>().notNull().default([]),
  dunning: jsonb('dunning').$type<DunningPolicy>().notNull().default({ retryDays: [3, 7], reminderDaysBefore: 3, finalNoticeAfterDays: 14 }),
  /** Collect automatically (off-session debit) when an invoice is issued and a mandate is active. */
  autoCollect: boolean('auto_collect').notNull().default(true),
  /** The franchisor's Stripe connected account that receives royalty payments. */
  collectionAccountId: text('collection_account_id'),
  /** Legal details printed on invoices. */
  issuerDetails: jsonb('issuer_details').$type<{ legalName?: string; address?: string; taxNumber?: string; email?: string }>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Royalty terms per owner group (franchisee) or organisation default (ownerGroupId null), per currency, with
 * effective dates. Franchise agreements (when present) override the rates through the agreement-terms providers.
 */
export const royaltyTerms = pgTable('royalty_terms', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  ownerGroupId: uuid('owner_group_id').references(() => ownerGroups.id, { onDelete: 'cascade' }),
  currency: currencyCol().notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  royaltyBps: integer('royalty_bps').notNull(),
  tiers: jsonb('tiers').$type<RoyaltyTier[]>().notNull().default([]),
  /** marginal: each slice at its tier's rate; whole: the whole basis at the rate of the highest tier reached. */
  tierMode: text('tier_mode').notNull().default('marginal'),
  /** Minimum royalty per location per period (0 = none). */
  minimumRoyaltyMinor: minor('minimum_royalty_minor').notNull().default(0),
  marketingFundBps: integer('marketing_fund_bps').notNull().default(0),
  /** Flat technology fee per location per period. */
  technologyFeeMinor: minor('technology_fee_minor').notNull().default(0),
  basis: jsonb('basis').$type<RevenueBasis>().notNull(),
  lateFee: jsonb('late_fee').$type<LateFeeTerms>().notNull().default({ kind: 'none', graceDays: 0 }),
  notes: text('notes'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('royalty_terms_lookup_idx').on(t.organizationId, t.ownerGroupId, t.currency, t.effectiveFrom),
  check('royalty_terms_bps_ck', sql`${t.royaltyBps} >= 0 and ${t.royaltyBps} <= 10000 and ${t.marketingFundBps} >= 0 and ${t.marketingFundBps} <= 10000`),
]);

/** A reporting period (weekly or monthly local dates; each location's statement uses its own time zone). */
export const royaltyPeriods = pgTable('royalty_periods', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  frequency: text('frequency').notNull(),
  /** Local start date (inclusive) and end date (exclusive), YYYY-MM-DD. */
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  /** open | closed */
  status: text('status').notNull().default('closed'),
  closedAt: ts('closed_at'),
  closedBy: uuid('closed_by'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('royalty_periods_uq').on(t.organizationId, t.frequency, t.startDate)]);

/** One royalty statement per location and period, in the location's currency. */
export const royaltyStatements = pgTable('royalty_statements', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  periodId: uuid('period_id').notNull().references(() => royaltyPeriods.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  ownerGroupId: uuid('owner_group_id'),
  currency: currencyCol().notNull(),
  timeZone: text('time_zone').notNull(),
  periodStartAt: ts('period_start_at').notNull(),
  periodEndAt: ts('period_end_at').notNull(),
  /** draft | disputed | approved | invoiced | void */
  status: text('status').notNull().default('draft'),
  grossSalesMinor: minor('gross_sales_minor').notNull().default(0),
  refundsMinor: minor('refunds_minor').notNull().default(0),
  taxMinor: minor('tax_minor').notNull().default(0),
  tipsMinor: minor('tips_minor').notNull().default(0),
  externalSalesMinor: minor('external_sales_minor').notNull().default(0),
  basisMinor: minor('basis_minor').notNull().default(0),
  royaltyMinor: minor('royalty_minor').notNull().default(0),
  marketingFundMinor: minor('marketing_fund_minor').notNull().default(0),
  technologyFeeMinor: minor('technology_fee_minor').notNull().default(0),
  adjustmentsMinor: minor('adjustments_minor').notNull().default(0),
  totalMinor: minor('total_minor').notNull().default(0),
  /** The terms used (snapshot), and where they came from (agreement | owner_group | organization). */
  terms: jsonb('terms').$type<Record<string, unknown>>().notNull().default({}),
  termsSource: text('terms_source'),
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  computedAt: ts('computed_at').notNull().defaultNow(),
  approvedAt: ts('approved_at'),
  approvedBy: uuid('approved_by'),
  invoiceId: uuid('invoice_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('royalty_statements_period_loc_uq').on(t.periodId, t.locationId),
  index('royalty_statements_org_status_idx').on(t.organizationId, t.status),
]);

/** Statement line items. Computed lines are rebuilt on recalculation; manual adjustments are kept. */
export const royaltyStatementLines = pgTable('royalty_statement_lines', {
  id: pk(),
  organizationId: orgId(),
  statementId: uuid('statement_id').notNull().references(() => royaltyStatements.id, { onDelete: 'cascade' }),
  /** sales | refunds | tax | tips | external_sales | basis | royalty | royalty_minimum | marketing_fund | technology_fee | adjustment */
  kind: text('kind').notNull(),
  stream: text('stream'),
  description: text('description').notNull(),
  basisMinor: minor('basis_minor'),
  rateBps: integer('rate_bps'),
  amountMinor: minor('amount_minor').notNull(),
  /** true: counts toward the amount due (royalty, fund, fees, adjustments); false: informational (sales, refunds…). */
  charge: boolean('charge').notNull().default(false),
  manual: boolean('manual').notNull().default(false),
  disputeId: uuid('dispute_id'),
  createdBy: uuid('created_by'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('royalty_statement_lines_stmt_idx').on(t.statementId)]);

/** Disputes: the franchisee raises one on a statement (optionally a line); HQ finance resolves it. */
export const royaltyDisputes = pgTable('royalty_disputes', {
  id: pk(),
  organizationId: orgId(),
  statementId: uuid('statement_id').notNull().references(() => royaltyStatements.id, { onDelete: 'cascade' }),
  lineId: uuid('line_id'),
  raisedBy: uuid('raised_by').notNull(),
  reason: text('reason').notNull(),
  /** open | accepted | rejected */
  status: text('status').notNull().default('open'),
  resolution: text('resolution'),
  adjustmentMinor: minor('adjustment_minor'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: ts('resolved_at'),
  createdAt: createdAt(),
}, (t) => [index('royalty_disputes_stmt_idx').on(t.statementId)]);

/** Files kept by the finance workspace: sales evidence, fund receipts. Stored in the database (no object storage needed). */
export const financeDocuments = pgTable('finance_documents', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** evidence | receipt */
  kind: text('kind').notNull(),
  locationId: uuid('location_id'),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  dataBase64: text('data_base64').notNull(),
  sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by'),
  createdAt: createdAt(),
});

/** Sales reported by locations that use an external POS, with evidence. Only accepted reports count. */
export const externalSalesReports = pgTable('external_sales_reports', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  frequency: text('frequency').notNull(),
  periodStart: date('period_start').notNull(),
  currency: currencyCol().notNull(),
  grossMinor: minor('gross_minor').notNull(),
  refundsMinor: minor('refunds_minor').notNull().default(0),
  taxMinor: minor('tax_minor').notNull().default(0),
  note: text('note'),
  evidenceDocumentId: uuid('evidence_document_id').notNull(),
  /** submitted | accepted | rejected */
  status: text('status').notNull().default('submitted'),
  submittedBy: uuid('submitted_by').notNull(),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: ts('reviewed_at'),
  reviewNote: text('review_note'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('external_sales_loc_period_uq').on(t.locationId, t.frequency, t.periodStart)]);

export interface InvoiceLine { kind: string; description: string; amountMinor: number }
export interface InvoiceTax { name: string; rateBps: number; baseMinor: number; amountMinor: number }

/** Invoices to franchisees, one per approved statement, numbered per organisation. */
export const financeInvoices = pgTable('finance_invoices', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  statementId: uuid('statement_id').notNull().references(() => royaltyStatements.id),
  locationId: uuid('location_id').notNull(),
  ownerGroupId: uuid('owner_group_id'),
  number: text('number').notNull(),
  seq: integer('seq').notNull(),
  currency: currencyCol().notNull(),
  issueDate: date('issue_date').notNull(),
  dueDate: date('due_date').notNull(),
  lines: jsonb('lines').$type<InvoiceLine[]>().notNull().default([]),
  taxes: jsonb('taxes').$type<InvoiceTax[]>().notNull().default([]),
  subtotalMinor: minor('subtotal_minor').notNull(),
  taxMinor: minor('tax_minor').notNull().default(0),
  lateFeeMinor: minor('late_fee_minor').notNull().default(0),
  totalMinor: minor('total_minor').notNull(),
  paidMinor: minor('paid_minor').notNull().default(0),
  /** The marketing-fund part of the subtotal (credited to the fund ledger when paid). */
  marketingFundMinor: minor('marketing_fund_minor').notNull().default(0),
  /** open | processing | paid | void */
  status: text('status').notNull().default('open'),
  /** none | reminded | retrying | final_notice */
  dunningStage: text('dunning_stage').notNull().default('none'),
  paidAt: ts('paid_at'),
  lateFeeAppliedAt: ts('late_fee_applied_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('finance_invoices_org_number_uq').on(t.organizationId, t.number),
  uniqueIndex('finance_invoices_statement_uq').on(t.statementId),
  index('finance_invoices_org_status_idx').on(t.organizationId, t.status),
]);

/**
 * Debit mandates: the franchisee (owner group) is a Customer on the franchisor's collection account; a SetupIntent
 * saves a card or bank-debit method with the mandate the franchisee accepted. One active method per owner group and
 * currency.
 */
export const financePaymentMethods = pgTable('finance_payment_methods', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  ownerGroupId: uuid('owner_group_id').notNull().references(() => ownerGroups.id, { onDelete: 'cascade' }),
  currency: currencyCol().notNull(),
  collectionAccountId: text('collection_account_id'),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  setupIntentId: text('setup_intent_id'),
  paymentMethodId: text('payment_method_id'),
  /** card | us_bank_account | acss_debit | bacs_debit | sepa_debit | au_becs_debit */
  methodType: text('method_type').notNull(),
  display: jsonb('display').$type<{ brand?: string | null; last4?: string | null; bankName?: string | null }>().notNull().default({}),
  mandateText: text('mandate_text').notNull(),
  mandateAcceptedAt: ts('mandate_accepted_at').notNull(),
  mandateAcceptedBy: uuid('mandate_accepted_by').notNull(),
  mandateIp: text('mandate_ip'),
  /** pending | active | failed | revoked */
  status: text('status').notNull().default('pending'),
  sandbox: boolean('sandbox').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('finance_payment_methods_group_idx').on(t.ownerGroupId, t.currency, t.status)]);

/** Collection attempts per invoice (idempotency key also sent to Stripe). */
export const financeCollectionAttempts = pgTable('finance_collection_attempts', {
  id: pk(),
  organizationId: orgId(),
  invoiceId: uuid('invoice_id').notNull().references(() => financeInvoices.id, { onDelete: 'cascade' }),
  attempt: integer('attempt').notNull(),
  /** debit | manual */
  method: text('method').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  paymentId: uuid('payment_id'),
  paymentIntentId: text('payment_intent_id'),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  /** processing | succeeded | failed | requires_action */
  status: text('status').notNull(),
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),
  reference: text('reference'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('finance_collection_attempts_idem_uq').on(t.idempotencyKey), index('finance_collection_attempts_invoice_idx').on(t.invoiceId)]);

/** Dunning history: reminders, retries, late fees and final notices. */
export const financeDunningEvents = pgTable('finance_dunning_events', {
  id: pk(),
  organizationId: orgId(),
  invoiceId: uuid('invoice_id').notNull().references(() => financeInvoices.id, { onDelete: 'cascade' }),
  /** reminder | retry | late_fee | final_notice */
  action: text('action').notNull(),
  /** Day offset from the due date this step belongs to (idempotency: one event per action and day). */
  dayOffset: integer('day_offset').notNull(),
  note: text('note'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('finance_dunning_events_uq').on(t.invoiceId, t.action, t.dayOffset)]);

/** Network campaigns the marketing fund pays for. */
export const marketingFundCampaigns = pgTable('marketing_fund_campaigns', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  /** active | closed */
  status: text('status').notNull().default('active'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

/** The marketing fund ledger: contributions in, spend out, adjustments. Balances are per currency. */
export const marketingFundEntries = pgTable('marketing_fund_entries', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** contribution | spend | adjustment */
  kind: text('kind').notNull(),
  currency: currencyCol().notNull(),
  /** Signed: contributions positive, spend negative, adjustments either. */
  amountMinor: minor('amount_minor').notNull(),
  occurredOn: date('occurred_on').notNull(),
  description: text('description').notNull(),
  locationId: uuid('location_id'),
  ownerGroupId: uuid('owner_group_id'),
  invoiceId: uuid('invoice_id'),
  campaignId: uuid('campaign_id'),
  receiptDocumentId: uuid('receipt_document_id'),
  vendor: text('vendor'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [
  index('marketing_fund_entries_org_idx').on(t.organizationId, t.currency, t.occurredOn),
  uniqueIndex('marketing_fund_entries_invoice_uq').on(t.invoiceId).where(sql`${t.kind} = 'contribution'`),
]);

/** Payouts from Stripe to a location's bank account (synced from Stripe, or generated in sandbox mode). */
export const financePayouts = pgTable('finance_payouts', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull(),
  connectedAccountId: text('connected_account_id').notNull(),
  externalId: text('external_id').notNull(),
  currency: currencyCol().notNull(),
  amountMinor: minor('amount_minor').notNull(),
  grossMinor: minor('gross_minor').notNull().default(0),
  feesMinor: minor('fees_minor').notNull().default(0),
  refundsMinor: minor('refunds_minor').notNull().default(0),
  chargebacksMinor: minor('chargebacks_minor').notNull().default(0),
  otherMinor: minor('other_minor').notNull().default(0),
  /** pending | in_transit | paid | failed | canceled */
  status: text('status').notNull(),
  arrivalDate: date('arrival_date'),
  sandbox: boolean('sandbox').notNull().default(false),
  syncedAt: ts('synced_at').notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('finance_payouts_ext_uq').on(t.connectedAccountId, t.externalId), index('finance_payouts_loc_idx').on(t.organizationId, t.locationId)]);

/** Balance transactions inside a payout (charges, refunds, fees, disputes), linked to BranchHarbor payments where possible. */
export const financeBalanceTransactions = pgTable('finance_balance_transactions', {
  id: pk(),
  organizationId: orgId(),
  payoutId: uuid('payout_id').notNull().references(() => financePayouts.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull(),
  externalId: text('external_id').notNull(),
  /** charge | refund | dispute | fee | adjustment | other */
  type: text('type').notNull(),
  sourceId: text('source_id'),
  paymentId: uuid('payment_id'),
  currency: currencyCol().notNull(),
  amountMinor: minor('amount_minor').notNull(),
  feeMinor: minor('fee_minor').notNull().default(0),
  netMinor: minor('net_minor').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('finance_balance_txn_uq').on(t.payoutId, t.externalId), index('finance_balance_txn_payment_idx').on(t.paymentId)]);

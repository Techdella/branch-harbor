/**
 * Network data platform: POS / booking sales connectors and normalised daily sales, the gross-sales source of each
 * location, import batches with an undo log, bulk location launches, and opt-in network benchmarks.
 */
import { boolean, date, index, integer, jsonb, pgTable, real, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';

/** One POS / booking connection per location and provider (Square, Toast, Mindbody, Shopify, Lightspeed, Clover). */
export const salesConnections = pgTable('sales_connections', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  /** pending_authorisation | connected | error | authorization_expired | disconnected */
  status: text('status').notNull().default('pending_authorisation'),
  /** sandbox (sample data, nothing sent) until the platform credentials and the merchant's authorisation exist. */
  mode: text('mode').notNull().default('sandbox'),
  /** Non-secret settings: external location / outlet / merchant ids, shop domain, series, site id. */
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  /** AES-256-GCM encrypted tokens; never returned. */
  credentialsEncrypted: text('credentials_encrypted'),
  /** SHA-256 of the OAuth state for the pending authorisation. */
  oauthStateHash: text('oauth_state_hash'),
  oauthStateExpiresAt: ts('oauth_state_expires_at'),
  externalAccountName: text('external_account_name'),
  lastSyncAt: ts('last_sync_at'),
  lastSyncStatus: text('last_sync_status'),
  lastError: text('last_error'),
  lastErrorAt: ts('last_error_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('sales_connections_loc_provider_uq').on(t.locationId, t.provider), index('sales_connections_org_idx').on(t.organizationId)]);

export const salesSyncRuns = pgTable('sales_sync_runs', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').notNull().references(() => salesConnections.id, { onDelete: 'cascade' }),
  /** nightly | manual | initial */
  trigger: text('trigger').notNull(),
  /** queued | running | succeeded | failed */
  status: text('status').notNull().default('queued'),
  fromDate: date('from_date').notNull(),
  toDate: date('to_date').notNull(),
  daysWritten: integer('days_written').notNull().default(0),
  daysUnchanged: integer('days_unchanged').notNull().default(0),
  ordersSeen: integer('orders_seen').notNull().default(0),
  sandbox: boolean('sandbox').notNull().default(false),
  error: text('error'),
  requestedBy: uuid('requested_by'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  createdAt: createdAt(),
}, (t) => [index('sales_sync_runs_conn_idx').on(t.connectionId, t.createdAt)]);

/**
 * Normalised daily sales per location, business date (location time zone), channel, currency and source. Upserts are
 * idempotent on that key; `contentHash` tells a real change from a re-sync of the same figures.
 */
export const dailySales = pgTable('daily_sales', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => salesConnections.id, { onDelete: 'set null' }),
  /** Provider key (square, toast, …). */
  source: text('source').notNull(),
  businessDate: date('business_date').notNull(),
  /** in_store | online | delivery | other */
  channel: text('channel').notNull().default('in_store'),
  currency: currencyCol().notNull(),
  grossMinor: minor('gross_minor').notNull().default(0),
  netMinor: minor('net_minor').notNull().default(0),
  taxMinor: minor('tax_minor').notNull().default(0),
  refundsMinor: minor('refunds_minor').notNull().default(0),
  tipsMinor: minor('tips_minor').notNull().default(0),
  discountsMinor: minor('discounts_minor').notNull().default(0),
  orderCount: integer('order_count').notNull().default(0),
  sandbox: boolean('sandbox').notNull().default(false),
  contentHash: text('content_hash').notNull(),
  syncedAt: ts('synced_at').notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('daily_sales_key_uq').on(t.locationId, t.source, t.businessDate, t.channel, t.currency),
  index('daily_sales_org_date_idx').on(t.organizationId, t.businessDate),
]);

/** The gross-sales source of a location (one per location). No row = BranchHarbor payments plus accepted external reports. */
export const locationSalesSources = pgTable('location_sales_sources', {
  locationId: uuid('location_id').primaryKey().references(() => locations.id, { onDelete: 'cascade' }),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** branchharbor | connector | self_reported */
  source: text('source').notNull(),
  connectionId: uuid('connection_id').references(() => salesConnections.id, { onDelete: 'set null' }),
  /** Variance threshold (basis points) for self-reported vs connector sales. */
  varianceThresholdBps: integer('variance_threshold_bps').notNull().default(500),
  note: text('note'),
  setBy: uuid('set_by'),
  updatedAt: updatedAt(),
});

/** One import (file, mapping, validation, run, undo). Parsed rows are kept until the undo window closes. */
export const importBatches = pgTable('import_batches', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  entity: text('entity').notNull(),
  templateKey: text('template_key'),
  filename: text('filename').notNull(),
  /** csv | xlsx */
  format: text('format').notNull(),
  /** uploaded | validated | queued | running | completed | failed | rolled_back */
  status: text('status').notNull().default('uploaded'),
  headers: jsonb('headers').$type<string[]>().notNull().default([]),
  rows: jsonb('rows').$type<string[][]>().notNull().default([]),
  mapping: jsonb('mapping').$type<Record<string, number | null>>().notNull().default({}),
  options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
  dryRun: boolean('dry_run').notNull().default(false),
  totalRows: integer('total_rows').notNull().default(0),
  validRows: integer('valid_rows').notNull().default(0),
  errorRows: integer('error_rows').notNull().default(0),
  processedRows: integer('processed_rows').notNull().default(0),
  createdCount: integer('created_count').notNull().default(0),
  updatedCount: integer('updated_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  errors: jsonb('errors').$type<Array<{ row: number; field: string; code: string; message: string }>>().notNull().default([]),
  error: text('error'),
  createdBy: uuid('created_by').notNull(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  undoUntil: ts('undo_until'),
  rolledBackAt: ts('rolled_back_at'),
  rolledBackBy: uuid('rolled_back_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('import_batches_org_idx').on(t.organizationId, t.createdAt)]);

/** What a batch wrote, for the undo: created records are removed, updated ones restored from `previous`. */
export const importBatchRecords = pgTable('import_batch_records', {
  id: pk(),
  organizationId: orgId(),
  batchId: uuid('batch_id').notNull().references(() => importBatches.id, { onDelete: 'cascade' }),
  rowNumber: integer('row_number').notNull(),
  /** Table written: locations | invitations | customers | consent_records | memberships | packs | products | variants | menu_items | menus | hosp_rooms | hosp_room_types | realty_listings | leads */
  recordType: text('record_type').notNull(),
  recordId: uuid('record_id').notNull(),
  /** created | updated */
  action: text('action').notNull(),
  previous: jsonb('previous').$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => [index('import_batch_records_batch_idx').on(t.batchId)]);

/** A bulk launch: many locations from the brand template, each with a site, listings data and staff invitations. */
export const bulkLaunches = pgTable('bulk_launches', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  templateId: uuid('template_id'),
  /** publish | draft */
  siteMode: text('site_mode').notNull().default('draft'),
  /** Location status after launch: onboarding | opening_soon | operating */
  locationStatus: text('location_status').notNull().default('opening_soon'),
  inviteStaff: boolean('invite_staff').notNull().default(true),
  importBatchId: uuid('import_batch_id'),
  /** queued | running | completed | completed_with_errors */
  status: text('status').notNull().default('queued'),
  total: integer('total').notNull().default(0),
  done: integer('done').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  createdBy: uuid('created_by').notNull(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('bulk_launches_org_idx').on(t.organizationId, t.createdAt)]);

export interface LaunchStepState { status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'; detail?: string | null; at?: string | null }

export const bulkLaunchItems = pgTable('bulk_launch_items', {
  id: pk(),
  organizationId: orgId(),
  launchId: uuid('launch_id').notNull().references(() => bulkLaunches.id, { onDelete: 'cascade' }),
  rowNumber: integer('row_number').notNull(),
  name: text('name').notNull(),
  code: text('code').notNull(),
  input: jsonb('input').$type<Record<string, unknown>>().notNull(),
  /** queued | running | done | failed */
  status: text('status').notNull().default('queued'),
  steps: jsonb('steps').$type<Record<string, LaunchStepState>>().notNull().default({}),
  locationId: uuid('location_id'),
  websiteId: uuid('website_id'),
  pageId: uuid('page_id'),
  invitations: integer('invitations').notNull().default(0),
  error: text('error'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  updatedAt: updatedAt(),
}, (t) => [index('bulk_launch_items_launch_idx').on(t.launchId, t.rowNumber)]);

/**
 * One organisation's contribution to a benchmark period (only for opted-in organisations). Never returned to anyone
 * else; removed when the organisation opts out.
 */
export const benchmarkContributions = pgTable('benchmark_contributions', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  period: text('period').notNull(),
  industry: text('industry').notNull(),
  region: text('region').notNull(),
  metric: text('metric').notNull(),
  /** Money metrics only; '' for the others. */
  currency: text('currency').notNull().default(''),
  value: real('value').notNull(),
  locations: integer('locations').notNull(),
  computedAt: ts('computed_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('benchmark_contrib_uq').on(t.organizationId, t.period, t.metric, t.currency)]);

/**
 * Published cohort percentiles (k ≥ 10 organisations, noised). `region` is a region key or `all` when the regional
 * cohort was too small and the cohort widened to the whole industry.
 */
export const benchmarkCohorts = pgTable('benchmark_cohorts', {
  id: pk(),
  period: text('period').notNull(),
  industry: text('industry').notNull(),
  region: text('region').notNull(),
  metric: text('metric').notNull(),
  currency: text('currency').notNull().default(''),
  cohortSize: integer('cohort_size').notNull(),
  p10: real('p10').notNull(),
  p25: real('p25').notNull(),
  p50: real('p50').notNull(),
  p75: real('p75').notNull(),
  p90: real('p90').notNull(),
  computedAt: ts('computed_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('benchmark_cohorts_uq').on(t.period, t.industry, t.region, t.metric, t.currency)]);

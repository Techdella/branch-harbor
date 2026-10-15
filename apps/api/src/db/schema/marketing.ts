/**
 * Marketing workspace: website builder (page revisions, redirects), email (templates, sends; segments and tags in comms.ts),
 * automations (flows, runs, steps, events, tasks), forms (definitions, submissions) and the brand asset library.
 * Page documents themselves live on `pages.document` / `page_versions.document` / `templates.document`.
 */
import { boolean, customType, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AutomationGraph, EmailDocument, FormField, FormSettings, PageDocument } from '@bh/shared';
import { createdAt, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';
import { customers } from './crm.ts';
import { pages, websites } from './websites.ts';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** Draft history for the builder (autosave checkpoints and named restore points). Published snapshots are page_versions. */
export const pageRevisions = pgTable('page_revisions', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  document: jsonb('document').$type<PageDocument>().notNull(),
  /** autosave | restore | migration | template */
  reason: text('reason').notNull().default('autosave'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('page_revisions_page_idx').on(t.pageId, t.revision)]);

/** Old slug → new slug on a website; the sites app answers with a permanent redirect. */
export const siteRedirects = pgTable('site_redirects', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  websiteId: uuid('website_id').notNull().references(() => websites.id, { onDelete: 'cascade' }),
  fromSlug: text('from_slug').notNull(),
  toSlug: text('to_slug').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('site_redirects_uq').on(t.websiteId, t.fromSlug)]);

export const emailTemplates = pgTable('email_templates', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** null = HQ template shared with every location. */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  subject: text('subject').notNull().default(''),
  preheader: text('preheader').notNull().default(''),
  document: jsonb('document').$type<EmailDocument>().notNull(),
  category: text('category').notNull().default('campaign'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: ts('archived_at'),
}, (t) => [index('email_templates_org_idx').on(t.organizationId)]);

// Segments and contact tags are shared with the inbox (comms.ts: contact_segments, contact_tags): one segments model
// for broadcasts, email campaigns and automations.

/** One row per recipient per campaign (or automation step): idempotent sending, unsubscribe and tracking token. */
export const emailSends = pgTable('email_sends', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id'),
  automationStepId: uuid('automation_step_id'),
  customerId: uuid('customer_id'),
  locationId: uuid('location_id'),
  email: text('email').notNull(),
  subject: text('subject').notNull().default(''),
  /** queued | sending | sent | sandbox | skipped | failed */
  status: text('status').notNull().default('queued'),
  skipReason: text('skip_reason'),
  error: text('error'),
  token: text('token').notNull().unique(),
  links: jsonb('links').$type<string[]>().notNull().default([]),
  test: boolean('test').notNull().default(false),
  sentAt: ts('sent_at'),
  openedAt: ts('opened_at'),
  clickedAt: ts('clicked_at'),
  unsubscribedAt: ts('unsubscribed_at'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('email_sends_campaign_customer_uq').on(t.campaignId, t.customerId),
  index('email_sends_org_idx').on(t.organizationId, t.createdAt),
]);

export const automations = pgTable('automations', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  scopeKind: text('scope_kind').notNull().default('organization'),
  scopeId: uuid('scope_id').notNull(),
  name: text('name').notNull(),
  /** draft | active | paused | archived */
  status: text('status').notNull().default('draft'),
  triggerEvent: text('trigger_event').notNull(),
  graph: jsonb('graph').$type<AutomationGraph>().notNull(),
  version: integer('version').notNull().default(1),
  /** Last activation: time-based triggers only consider business events after this (no historical back-fill). */
  activatedAt: ts('activated_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('automations_org_trigger_idx').on(t.organizationId, t.triggerEvent, t.status)]);

/** Durable trigger inbox. `key` makes the same business event fire automations once. */
export const marketingEvents = pgTable('marketing_events', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  key: text('key').notNull(),
  customerId: uuid('customer_id'),
  locationId: uuid('location_id'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  processedAt: ts('processed_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('marketing_events_uq').on(t.organizationId, t.type, t.key), index('marketing_events_pending_idx').on(t.processedAt)]);

export const automationRuns = pgTable('automation_runs', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  automationId: uuid('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  automationVersion: integer('automation_version').notNull().default(1),
  /** Test runs use the person running the test as the contact (no customer). */
  customerId: uuid('customer_id'),
  locationId: uuid('location_id'),
  eventId: uuid('event_id'),
  triggerKey: text('trigger_key').notNull(),
  /** active | waiting | completed | stopped | failed */
  status: text('status').notNull().default('active'),
  currentNodeId: text('current_node_id'),
  nextRunAt: ts('next_run_at'),
  context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
  test: boolean('test').notNull().default(false),
  error: text('error'),
  startedAt: createdAt(),
  finishedAt: ts('finished_at'),
}, (t) => [
  uniqueIndex('automation_runs_uq').on(t.automationId, t.customerId, t.triggerKey),
  index('automation_runs_due_idx').on(t.status, t.nextRunAt),
  index('automation_runs_customer_idx').on(t.customerId),
]);

/** One row per node per run: claimed before the side effect, so a step never runs twice. */
export const automationSteps = pgTable('automation_steps', {
  id: pk(),
  organizationId: orgId(),
  runId: uuid('run_id').notNull().references(() => automationRuns.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  nodeType: text('node_type').notNull(),
  /** running | waiting | done | skipped | failed */
  status: text('status').notNull().default('running'),
  result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  finishedAt: ts('finished_at'),
}, (t) => [uniqueIndex('automation_steps_uq').on(t.runId, t.nodeId)]);

/** Follow-up tasks created by automations (and later by people). */
export const marketingTasks = pgTable('marketing_tasks', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id'),
  customerId: uuid('customer_id'),
  title: text('title').notNull(),
  status: text('status').notNull().default('open'),
  dueAt: ts('due_at'),
  source: text('source').notNull().default('automation'),
  sourceId: uuid('source_id'),
  createdAt: createdAt(),
  completedAt: ts('completed_at'),
}, (t) => [index('marketing_tasks_org_idx').on(t.organizationId, t.status)]);

export const forms = pgTable('forms', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** null = HQ form (routing decides the location). */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  fields: jsonb('fields').$type<FormField[]>().notNull(),
  settings: jsonb('settings').$type<FormSettings>().notNull(),
  /** draft | published | archived */
  status: text('status').notNull().default('draft'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('forms_org_idx').on(t.organizationId)]);

export const formSubmissions = pgTable('form_submissions', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  formId: uuid('form_id').notNull().references(() => forms.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id'),
  leadId: uuid('lead_id'),
  customerId: uuid('customer_id'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  consents: jsonb('consents').$type<Record<string, boolean>>().notNull().default({}),
  ipHash: text('ip_hash'),
  userAgent: text('user_agent'),
  pageUrl: text('page_url'),
  createdAt: createdAt(),
}, (t) => [index('form_submissions_form_idx').on(t.formId, t.createdAt)]);

export const brandAssets = pgTable('brand_assets', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** null = HQ asset. */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  folder: text('folder').notNull().default(''),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  /** s3 | db (sandbox / no object storage configured) */
  storage: text('storage').notNull(),
  storageKey: text('storage_key').notNull(),
  url: text('url').notNull(),
  alt: text('alt').notNull().default(''),
  usageRights: text('usage_rights').notNull().default(''),
  rightsExpireAt: ts('rights_expire_at'),
  /** private (owner only) | all_locations | selected */
  shareMode: text('share_mode').notNull().default('private'),
  sharedLocationIds: jsonb('shared_location_ids').$type<string[]>().notNull().default([]),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: ts('archived_at'),
}, (t) => [index('brand_assets_org_idx').on(t.organizationId, t.folder)]);

export const assetBlobs = pgTable('asset_blobs', {
  assetId: uuid('asset_id').primaryKey().references(() => brandAssets.id, { onDelete: 'cascade' }),
  data: bytea('data').notNull(),
});

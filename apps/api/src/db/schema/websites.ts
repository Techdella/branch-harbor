import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid, boolean } from 'drizzle-orm/pg-core';
import { createdAt, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';

/** Field origin: hq = HQ default, editable locally; local = local override; locked = brand-locked; approval = change needs approval. */
export type FieldOrigin = 'hq' | 'local' | 'locked' | 'approval';
export type TemplateField = { key: string; label: string; type: 'text' | 'richtext' | 'image' | 'url' | 'json'; policy: 'locked' | 'editable' | 'approval'; defaultValue: unknown };

export const templates = pgTable('templates', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  industry: text('industry'),
  fields: jsonb('fields').$type<TemplateField[]>().notNull().default([]),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const websites = pgTable('websites', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** null = network/HQ site */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('hosted'), // hosted | wordpress
  templateId: uuid('template_id').references(() => templates.id, { onDelete: 'set null' }),
  includedAddress: text('included_address').notNull(),
  primaryDomainId: uuid('primary_domain_id'),
  connectionId: uuid('connection_id'),
  status: text('status').notNull().default('draft'), // draft | live | paused
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('websites_org_idx').on(t.organizationId)]);

export const pages = pgTable('pages', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  websiteId: uuid('website_id').notNull().references(() => websites.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  templateId: uuid('template_id').references(() => templates.id, { onDelete: 'set null' }),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  /** draft | pending_approval | approved | published | archived */
  status: text('status').notNull().default('draft'),
  seo: jsonb('seo').$type<{ title?: string; description?: string; canonicalOwner?: 'branchharbor' | 'external' }>().notNull().default({}),
  publishedVersionId: uuid('published_version_id'),
  publishedAt: ts('published_at'),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('pages_website_slug_uq').on(t.websiteId, t.slug)]);

export const pageVersions = pgTable('page_versions', {
  id: pk(),
  organizationId: orgId(),
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  content: jsonb('content').$type<Record<string, unknown>>().notNull(),
  createdBy: uuid('created_by'),
  publishJobId: uuid('publish_job_id'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('page_versions_uq').on(t.pageId, t.version)]);

export const fieldOverrides = pgTable('field_overrides', {
  id: pk(),
  organizationId: orgId(),
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  fieldKey: text('field_key').notNull(),
  origin: text('origin').$type<FieldOrigin>().notNull(),
  value: jsonb('value'),
  /** Value HQ supplied; used for reset-to-default. */
  hqValue: jsonb('hq_value'),
  pendingValue: jsonb('pending_value'),
  pendingApprovalId: uuid('pending_approval_id'),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('field_overrides_uq').on(t.pageId, t.fieldKey)]);

export const approvals = pgTable('approvals', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id'),
  targetType: text('target_type').notNull(), // page | field | campaign | ai_action
  targetId: uuid('target_id').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('pending'), // pending | approved | rejected | cancelled
  requestedBy: uuid('requested_by').notNull(),
  requestComment: text('request_comment'),
  decidedBy: uuid('decided_by'),
  decisionComment: text('decision_comment'),
  decidedAt: ts('decided_at'),
  createdAt: createdAt(),
}, (t) => [index('approvals_org_status_idx').on(t.organizationId, t.status)]);

export const publishJobs = pgTable('publish_jobs', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  requestedBy: uuid('requested_by').notNull(),
  pageSlug: text('page_slug').notNull(),
  templateId: uuid('template_id'),
  /** pending | running | completed | partial | failed */
  status: text('status').notNull().default('pending'),
  note: text('note'),
  createdAt: createdAt(),
  finishedAt: ts('finished_at'),
});

export const publishJobResults = pgTable('publish_job_results', {
  id: pk(),
  organizationId: orgId(),
  jobId: uuid('job_id').notNull().references(() => publishJobs.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull(),
  pageId: uuid('page_id'),
  status: text('status').notNull().default('pending'), // pending | succeeded | failed | skipped
  error: text('error'),
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  attempts: integer('attempts').notNull().default(0),
  versionId: uuid('version_id'),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('publish_job_results_uq').on(t.jobId, t.locationId)]);

export type DnsRecord = { type: 'CNAME' | 'TXT' | 'A'; name: string; value: string; purpose: string; ttl?: number };

export const domains = pgTable('domains', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  websiteId: uuid('website_id').references(() => websites.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id'),
  hostname: text('hostname').notNull().unique(),
  /** awaiting_dns → verifying → certificate_pending → ready | failed */
  state: text('state').notNull().default('awaiting_dns'),
  verificationToken: text('verification_token').notNull(),
  dnsRecords: jsonb('dns_records').$type<DnsRecord[]>().notNull().default([]),
  provider: text('provider').notNull().default('cloudflare'),
  providerHostnameId: text('provider_hostname_id'),
  isPrimary: boolean('is_primary').notNull().default(false),
  checks: jsonb('checks').$type<Record<string, unknown>>().notNull().default({}),
  failureReason: text('failure_reason'),
  attempts: integer('attempts').notNull().default(0),
  lastCheckedAt: ts('last_checked_at'),
  readyAt: ts('ready_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

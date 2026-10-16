import { sql } from 'drizzle-orm';
import { bigint, boolean, customType, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations, users } from './core.ts';
import type { Audience } from './network.ts';

/**
 * The AI assistant (docs/AI.md): organisation controls, per-person preferences, metering, the tool-call audit log,
 * briefings, insights, personal tasks and the knowledge base. Conversations, messages and proposed actions live in
 * integrations.ts (ai_conversations, ai_messages, ai_proposed_actions).
 */

const org = () => orgId().references(() => organizations.id, { onDelete: 'cascade' });
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** Organisation AI controls (shape: `AiOrgSettings` in @bh/shared). */
export const aiOrgSettings = pgTable('ai_org_settings', {
  id: pk(),
  organizationId: org().unique(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
});

/** Per-person preferences: briefing schedule and channels. */
export const aiUserPrefs = pgTable('ai_user_prefs', {
  id: pk(),
  organizationId: org(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** off | daily | weekly */
  briefingFrequency: text('briefing_frequency').notNull().default('daily'),
  /** Local hour (0–23, organisation time zone) the briefing is prepared. */
  briefingHour: integer('briefing_hour').notNull().default(7),
  /** Weekly briefings: ISO weekday 1 (Monday) – 7. */
  briefingWeekday: integer('briefing_weekday').notNull().default(1),
  briefingEmail: boolean('briefing_email').notNull().default(true),
  briefingInApp: boolean('briefing_in_app').notNull().default(true),
  /** Sections the person wants (empty = all). */
  sections: text('sections').array().notNull().default([]),
  lastBriefingAt: ts('last_briefing_at'),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('ai_user_prefs_uq').on(t.organizationId, t.userId)]);

/** Monthly metering per organisation and feature (tokens → credits). */
export const aiUsage = pgTable('ai_usage', {
  id: pk(),
  organizationId: org(),
  /** YYYY-MM (UTC). */
  month: text('month').notNull(),
  /** chat | briefing | insights | content | vision | helpdesk | setup | course_builder | scoring | knowledge */
  feature: text('feature').notNull(),
  requests: integer('requests').notNull().default(0),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
  cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
  credits: doublePrecision('credits').notNull().default(0),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('ai_usage_uq').on(t.organizationId, t.month, t.feature)]);

/**
 * Audit log of every tool call and action (who, what, when, result). Inputs are stored with personal data masked;
 * results are summarised (counts, ids), never copied.
 */
export const aiToolCalls = pgTable('ai_tool_calls', {
  id: pk(),
  organizationId: org(),
  userId: uuid('user_id'),
  conversationId: uuid('conversation_id'),
  actionId: uuid('action_id'),
  tool: text('tool').notNull(),
  /** read | write */
  kind: text('kind').notNull(),
  /** ok | error | denied | proposed | confirmed | pending_approval | executed | rejected | cancelled | failed */
  status: text('status').notNull(),
  input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
  summary: text('summary'),
  /** The call followed untrusted content in the same turn. */
  untrusted: boolean('untrusted').notNull().default(false),
  durationMs: integer('duration_ms'),
  createdAt: createdAt(),
}, (t) => [index('ai_tool_calls_org_idx').on(t.organizationId, t.createdAt)]);

/** Prepared briefings (one per person per day). */
export const aiBriefings = pgTable('ai_briefings', {
  id: pk(),
  organizationId: org(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Local date (YYYY-MM-DD). */
  date: text('date').notNull(),
  /** daily | weekly | on_demand */
  kind: text('kind').notNull().default('daily'),
  items: jsonb('items').$type<unknown[]>().notNull().default([]),
  summary: text('summary'),
  emailedAt: ts('emailed_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('ai_briefings_uq').on(t.organizationId, t.userId, t.date)]);

/** Proactive insights: anomalies on KPIs with explanation, evidence and suggested actions. */
export const aiInsights = pgTable('ai_insights', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  /** revenue_drop | activity_drop | royalty_overdue | rating_drop | audit_decline | churn_risk | compliance_gap */
  kind: text('kind').notNull(),
  /** info | warning | critical */
  severity: text('severity').notNull().default('warning'),
  title: text('title').notNull(),
  explanation: text('explanation').notNull(),
  evidence: jsonb('evidence').$type<unknown[]>().notNull().default([]),
  suggestedActions: jsonb('suggested_actions').$type<unknown[]>().notNull().default([]),
  /** The module whose view access is needed to see the insight. */
  module: text('module').notNull(),
  /** Stable key so a repeated detection updates instead of duplicating. */
  fingerprint: text('fingerprint').notNull(),
  /** open | dismissed | acted */
  status: text('status').notNull().default('open'),
  /** Money insights: the currency of every amount (never mixed). */
  currency: text('currency'),
  periodLabel: text('period_label'),
  detectedAt: ts('detected_at').notNull().defaultNow(),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
}, (t) => [uniqueIndex('ai_insights_uq').on(t.organizationId, t.fingerprint), index('ai_insights_org_idx').on(t.organizationId, t.status, t.detectedAt)]);

/** Personal tasks and reminders created with the assistant (`create_task`, `remind_me`). */
export const aiTasks = pgTable('ai_tasks', {
  id: pk(),
  organizationId: org(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  note: text('note'),
  link: text('link'),
  dueAt: ts('due_at'),
  remindAt: ts('remind_at'),
  remindedAt: ts('reminded_at'),
  /** open | done */
  status: text('status').notNull().default('open'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('ai_tasks_user_idx').on(t.organizationId, t.userId, t.status), index('ai_tasks_remind_idx').on(t.remindAt)]);

/**
 * Knowledge base sources: the operations manual and library documents, training courses, help-desk answers, brand
 * guidelines and uploads (PDF, DOCX, Markdown). `audience` follows the library's rules, so franchisees only find
 * what is shared with them.
 */
export const aiKnowledgeSources = pgTable('ai_knowledge_sources', {
  id: pk(),
  organizationId: org(),
  /** library | course | helpdesk | brand | upload */
  sourceType: text('source_type').notNull(),
  /** Id of the library resource, course, ticket or brand asset (null for uploads). */
  sourceRef: text('source_ref'),
  title: text('title').notNull(),
  /** App path that opens the source (citations link here). */
  url: text('url'),
  /** Every audience must include the person (a library file inside folders carries the folder chain's audiences). */
  audiences: jsonb('audiences').$type<Audience[]>().notNull().default([]),
  /** Module whose view access is needed (community.library, training.academy, community.help_desk, ai.assistant). */
  module: text('module').notNull().default('ai.assistant'),
  /** Only people with an organisation-wide assignment (e.g. internal help-desk notes). */
  hqOnly: boolean('hq_only').notNull().default(false),
  fileName: text('file_name'),
  mimeType: text('mime_type'),
  contentHash: text('content_hash'),
  chunkCount: integer('chunk_count').notNull().default(0),
  /** ready | failed */
  status: text('status').notNull().default('ready'),
  error: text('error'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('ai_knowledge_sources_ref_uq').on(t.organizationId, t.sourceType, t.sourceRef)]);

/** Chunks indexed with Postgres full-text search ('simple' configuration, every language) and trigram similarity. */
export const aiKnowledgeChunks = pgTable('ai_knowledge_chunks', {
  id: pk(),
  organizationId: org(),
  sourceId: uuid('source_id').notNull().references(() => aiKnowledgeSources.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  heading: text('heading'),
  content: text('content').notNull(),
  tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('simple', coalesce(heading, '') || ' ' || content)`),
  createdAt: createdAt(),
}, (t) => [
  index('ai_knowledge_chunks_source_idx').on(t.sourceId, t.position),
  index('ai_knowledge_chunks_tsv_idx').using('gin', t.tsv),
  index('ai_knowledge_chunks_trgm_idx').using('gin', sql`${t.content} gin_trgm_ops`),
]);

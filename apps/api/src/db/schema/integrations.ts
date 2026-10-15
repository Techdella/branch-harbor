import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { organizations } from './core.ts';

export const connections = pgTable('connections', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id'),
  /** wordpress | woocommerce | shopify | square | mindbody | stripe | google_business | meta */
  provider: text('provider').notNull(),
  kind: text('kind').notNull(), // website | commerce | booking | payments | pos | marketing
  direction: text('direction').notNull().default('import'), // import | export | bidirectional
  /** Which system is authoritative for the data this connection exchanges. */
  authoritative: text('authoritative').notNull().default('external'), // external | branchharbor
  /** connected | initial_sync | degraded | disconnected | authorization_expired */
  state: text('state').notNull().default('disconnected'),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  /** AES-256-GCM encrypted credentials blob; never returned by the API. */
  credentialsEncrypted: text('credentials_encrypted'),
  syncCursor: jsonb('sync_cursor').$type<Record<string, unknown>>(),
  lastSuccessAt: ts('last_success_at'),
  lastErrorAt: ts('last_error_at'),
  lastError: text('last_error'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('connections_org_idx').on(t.organizationId)]);

export const externalMappings = pgTable('external_mappings', {
  id: pk(),
  organizationId: orgId(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').notNull(), // location | product | variant | order | class_type | customer
  externalId: text('external_id').notNull(),
  internalId: uuid('internal_id'),
  status: text('status').notNull().default('mapped'), // mapped | error | ignored | pending_review
  error: text('error'),
  externalData: jsonb('external_data').$type<Record<string, unknown>>(),
  resolvedBy: uuid('resolved_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('external_mappings_uq').on(t.connectionId, t.entityType, t.externalId)]);

export const syncRuns = pgTable('sync_runs', {
  id: pk(),
  organizationId: orgId(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('queued'), // queued | running | succeeded | partial | failed
  recordsProcessed: integer('records_processed').notNull().default(0),
  recordsFailed: integer('records_failed').notNull().default(0),
  error: text('error'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  createdAt: createdAt(),
});

export const paymentReferences = pgTable('payment_references', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id'),
  provider: text('provider').notNull().default('stripe'),
  externalId: text('external_id').notNull(),
  connectedAccountId: text('connected_account_id'),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  applicationFeeMinor: minor('application_fee_minor').notNull().default(0),
  /** Amount reported by the provider when it differs from what we requested. */
  providerAmountMinor: minor('provider_amount_minor'),
  /** created | requires_action | processing | succeeded | failed | cancelled */
  state: text('state').notNull().default('created'),
  /** null | requested | pending | partial | complete | failed */
  refundState: text('refund_state'),
  refundedMinor: minor('refunded_minor').notNull().default(0),
  targetType: text('target_type'), // class_booking | food_order | order | appointment | registration
  targetId: uuid('target_id'),
  /** Snapshot of the record to create, allowing "recreate record from payment" recovery. */
  recordSnapshot: jsonb('record_snapshot').$type<Record<string, unknown>>(),
  clientSecret: text('client_secret'),
  sandbox: integer('sandbox').notNull().default(0),
  succeededAt: ts('succeeded_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('payment_refs_provider_ext_uq').on(t.provider, t.externalId),
  index('payment_refs_org_idx').on(t.organizationId, t.createdAt),
  index('payment_refs_target_idx').on(t.targetType, t.targetId),
]);

export const refunds = pgTable('refunds', {
  id: pk(),
  organizationId: orgId(),
  paymentId: uuid('payment_id').notNull().references(() => paymentReferences.id, { onDelete: 'cascade' }),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  state: text('state').notNull().default('pending'), // requested | pending | complete | failed
  reason: text('reason'),
  externalId: text('external_id'),
  requestedBy: uuid('requested_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('refunds_payment_idx').on(t.paymentId)]);

export const webhookEvents = pgTable('webhook_events', {
  id: pk(),
  provider: text('provider').notNull(),
  eventId: text('event_id').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull().default('received'), // received | processed | ignored | failed
  error: text('error'),
  organizationId: uuid('organization_id'),
  paymentId: uuid('payment_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
}, (t) => [uniqueIndex('webhook_events_provider_event_uq').on(t.provider, t.eventId)]);

export const aiConversations = pgTable('ai_conversations', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id').notNull(),
  title: text('title'),
  /** web | mobile | api | seed */
  channel: text('channel').notNull().default('web'),
  /** The screen the conversation started on (path and record), for suggested prompts and history. */
  context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('ai_conversations_user_idx').on(t.organizationId, t.userId, t.updatedAt)]);

export const aiMessages = pgTable('ai_messages', {
  id: pk(),
  organizationId: orgId(),
  conversationId: uuid('conversation_id').notNull().references(() => aiConversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // user | assistant
  /** Anthropic content blocks (text, tool_use, tool_result). */
  content: jsonb('content').$type<unknown>().notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  model: text('model'),
  /** Tables and charts built from tool results during the turn (never generated numbers). */
  blocks: jsonb('blocks').$type<unknown[]>().notNull().default([]),
  citations: jsonb('citations').$type<unknown[]>().notNull().default([]),
  /** Notices (not legal advice, sandbox), action ids and navigation of the turn. */
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index('ai_messages_conv_idx').on(t.conversationId, t.createdAt)]);

export const aiProposedActions = pgTable('ai_proposed_actions', {
  id: pk(),
  organizationId: orgId(),
  /** Null for actions proposed outside a conversation (insights, setup assistant, course builder). */
  conversationId: uuid('conversation_id').references(() => aiConversations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  /** The tool (or legacy action kind) that executes the action once confirmed. */
  kind: text('kind').notNull(),
  title: text('title'),
  summary: text('summary').notNull(),
  details: jsonb('details').$type<Array<{ label: string; value: string }>>().notNull().default([]),
  /** Inputs the person may change on the card before confirming. */
  editable: jsonb('editable').$type<Array<{ key: string; label: string; kind: string }>>().notNull().default([]),
  /** change | bulk | outbound | publish | money | delete */
  risk: text('risk').notNull().default('change'),
  /** Proposed after the conversation read untrusted content (reviews, messages, documents). */
  fromUntrusted: boolean('from_untrusted').notNull().default(false),
  /** chat | insight | setup | course_builder | content | helpdesk | document */
  source: text('source').notNull().default('chat'),
  link: text('link'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id').notNull(),
  status: text('status').notNull().default('proposed'), // proposed | pending_approval | executed | rejected | failed | cancelled
  result: jsonb('result').$type<Record<string, unknown>>(),
  /** The person confirmed the card (then it executes, or waits for an HQ approver). */
  confirmedAt: ts('confirmed_at'),
  approvedBy: uuid('approved_by'),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
  createdAt: createdAt(),
}, (t) => [index('ai_proposed_actions_org_idx').on(t.organizationId, t.status)]);

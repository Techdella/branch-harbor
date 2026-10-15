import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { ReviewSettings } from '@bh/shared';
import { createdAt, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';

/**
 * Marketing → Reviews: review-request settings, review requests sent after completed visits / orders, reviews
 * (private feedback from the hosted review page and Google Business Profile reviews), replies with HQ approval, and
 * the Google Business Profile connections that reviews are fetched through.
 */

/** Organisation default (location_id null) and per-location overrides (only the keys set there override). */
export const reviewSettings = pgTable('review_settings', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<Partial<ReviewSettings>>().notNull().default({}),
  /** First time requests were switched on here: completed visits before it never get a request. */
  enabledAt: ts('enabled_at'),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('review_settings_org_uq').on(t.organizationId).where(sql`${t.locationId} is null`),
  uniqueIndex('review_settings_loc_uq').on(t.locationId).where(sql`${t.locationId} is not null`),
]);

export interface ReviewContact { name: string | null; email: string | null; phone: string | null; locale: string | null }

/** One review request to one customer (scheduled → sent / skipped / failed → opened → completed). */
export const reviewRequests = pgTable('review_requests', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id'),
  contact: jsonb('contact').$type<ReviewContact>().notNull(),
  /** email | sms | whatsapp */
  channel: text('channel').notNull(),
  /** class_visit | booking | order | hotel_checkout | property_viewing | manual | automation */
  source: text('source').notNull(),
  sourceId: uuid('source_id'),
  /** Idempotency: one request per completed interaction (`<source>:<id>`), automation step or manual send. */
  triggerKey: text('trigger_key').notNull(),
  /** scheduled | sending (claimed) | sent | sandboxed (no provider credentials) | skipped | failed | opened | completed */
  status: text('status').notNull().default('scheduled'),
  skipReason: text('skip_reason'),
  error: text('error'),
  /** sha256 of the link token (the token itself is only in the message). */
  tokenHash: text('token_hash').notNull(),
  locale: text('locale'),
  sendAt: ts('send_at').notNull(),
  sentAt: ts('sent_at'),
  openedAt: ts('opened_at'),
  completedAt: ts('completed_at'),
  automationRunId: uuid('automation_run_id'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('review_requests_trigger_uq').on(t.organizationId, t.triggerKey),
  uniqueIndex('review_requests_token_uq').on(t.tokenHash),
  index('review_requests_due_idx').on(t.status, t.sendAt),
  index('review_requests_customer_idx').on(t.organizationId, t.customerId, t.sentAt),
  index('review_requests_loc_idx').on(t.organizationId, t.locationId, t.createdAt),
]);

/**
 * Reviews. `source = branchharbor`: rating and comment left on the hosted review page (private feedback, also
 * delivered to the location's inbox as a conversation). `source = google`: fetched from Google Business Profile
 * (never invented: sandbox connections fetch nothing; demo rows exist only in the demo seed).
 */
export const reviews = pgTable('reviews', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  /** Provider id (Google: `accounts/…/locations/…/reviews/…`). */
  externalId: text('external_id'),
  requestId: uuid('request_id'),
  customerId: uuid('customer_id'),
  authorName: text('author_name'),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  language: text('language'),
  reviewedAt: ts('reviewed_at').notNull(),
  /** Inbox conversation the private feedback was delivered to. */
  conversationId: uuid('conversation_id'),
  /** Public review links the customer opened from the hosted page (kinds). */
  linksOpened: jsonb('links_opened').$type<string[]>().notNull().default([]),
  /** Reply: none | draft | pending_approval | published | rejected | failed (private feedback is answered in the inbox). */
  replyStatus: text('reply_status').notNull().default('none'),
  replyText: text('reply_text'),
  /** The reply text started from an AI suggestion. */
  replyAiSuggested: boolean('reply_ai_suggested').notNull().default(false),
  replyBy: uuid('reply_by'),
  replySubmittedAt: ts('reply_submitted_at'),
  replyDecidedBy: uuid('reply_decided_by'),
  replyDecisionNote: text('reply_decision_note'),
  repliedAt: ts('replied_at'),
  replyError: text('reply_error'),
  /** Reply already on Google when fetched (replied outside BranchHarbor). */
  replyExternal: boolean('reply_external').notNull().default(false),
  alertedAt: ts('alerted_at'),
  sandbox: boolean('sandbox').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('reviews_external_uq').on(t.organizationId, t.source, t.externalId).where(sql`${t.externalId} is not null`),
  uniqueIndex('reviews_request_uq').on(t.requestId).where(sql`${t.requestId} is not null`),
  index('reviews_loc_time_idx').on(t.organizationId, t.locationId, t.reviewedAt),
  check('reviews_rating_ck', sql`${t.rating} between 1 and 5`),
]);

/** A Google Business Profile account connected through OAuth: by HQ for many locations, or by one location. */
export const reviewConnections = pgTable('review_connections', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('google'),
  /** hq | location */
  ownerKind: text('owner_kind').notNull(),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  /** Google account resource (`accounts/123`) and the signed-in Google user's email, for display. */
  accountName: text('account_name'),
  accountEmail: text('account_email'),
  /** live = OAuth refresh token stored; sandbox = no Google credentials (nothing is fetched or posted). */
  mode: text('mode').notNull().default('sandbox'),
  /** connected | error | disconnected */
  status: text('status').notNull().default('connected'),
  /** AES-256-GCM encrypted refresh token. Never returned by the API. */
  credentialsEncrypted: text('credentials_encrypted'),
  lastSyncAt: ts('last_sync_at'),
  lastError: text('last_error'),
  connectedBy: uuid('connected_by'),
  createdAt: createdAt(),
}, (t) => [index('review_connections_org_idx').on(t.organizationId)]);

/** Which Google location feeds which BranchHarbor location (one per location and provider). */
export const reviewListings = pgTable('review_listings', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').notNull().references(() => reviewConnections.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('google'),
  /** Google location resource (`locations/456`). */
  externalLocationName: text('external_location_name').notNull(),
  title: text('title'),
  /** Public "write a review" link (https://search.google.com/local/writereview?placeid=…). */
  reviewUrl: text('review_url'),
  lastFetchedAt: ts('last_fetched_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('review_listings_loc_uq').on(t.locationId, t.provider)]);

import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { ListingField, ListingPatch, ListingPhoto, ListingSnapshot, LocalAssetField, SpecialHour } from '@bh/shared';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';

/**
 * Local marketing (packages/shared/src/local-marketing.ts): listings, review reply templates, the co-op / local
 * marketing fund, call tracking, the local social content calendar and local asset templates.
 *
 * Listings never duplicate the location: name, address, phone, weekly hours and special hours stay on `locations`
 * (`hours.weekly`, `hours.special`), so the hosted sites and the directories always show the same data. The profile
 * holds only what the location row has no place for.
 */

/** Organisation settings for local marketing (listing field policy, review SLA, co-op checklist, call recording). */
export const localMarketingSettings = pgTable('local_marketing_settings', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('local_marketing_settings_org_uq').on(t.organizationId)]);

/* ── Listings ── */

/** Listing fields the location row has no place for. One per location. */
export const listingProfiles = pgTable('listing_profiles', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  primaryCategory: text('primary_category'),
  additionalCategories: jsonb('additional_categories').$type<string[]>().notNull().default([]),
  description: text('description'),
  photos: jsonb('photos').$type<ListingPhoto[]>().notNull().default([]),
  websiteUrl: text('website_url'),
  bookingUrl: text('booking_url'),
  attributes: jsonb('attributes').$type<Record<string, boolean | string>>().notNull().default({}),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('listing_profiles_loc_uq').on(t.locationId)]);

/**
 * A directory connection for Apple Business Connect or Bing Places (Google reuses the Reviews Google Business Profile
 * connection, `review_connections`, whose `business.manage` scope also covers listing edits).
 */
export const listingConnections = pgTable('listing_connections', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** apple | bing */
  provider: text('provider').notNull(),
  /** live = credentials stored and the platform adapter configured; sandbox = nothing leaves BranchHarbor. */
  mode: text('mode').notNull().default('sandbox'),
  status: text('status').notNull().default('connected'),
  accountName: text('account_name'),
  credentialsEncrypted: text('credentials_encrypted'),
  lastError: text('last_error'),
  connectedBy: uuid('connected_by'),
  createdAt: createdAt(),
}, (t) => [index('listing_connections_org_idx').on(t.organizationId)]);

/** Sync state of one location on one directory, with the last copy BranchHarbor pushed and the directory's copy. */
export const listingSyncs = pgTable('listing_syncs', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  /** google | apple | bing */
  provider: text('provider').notNull(),
  /** review_connections.id (google) or listing_connections.id (apple, bing). */
  connectionId: uuid('connection_id'),
  /** Directory id of the location (Google `locations/123`, Apple location id, Bing store id). */
  externalId: text('external_id'),
  mode: text('mode').notNull().default('sandbox'),
  /** synced | pending | drift | error | not_connected */
  status: text('status').notNull().default('pending'),
  lastPushedAt: ts('last_pushed_at'),
  /** What BranchHarbor last pushed (the drift baseline). */
  pushedSnapshot: jsonb('pushed_snapshot').$type<ListingSnapshot>(),
  lastCheckedAt: ts('last_checked_at'),
  /** The directory's copy at the last check (sandbox: the simulated directory). */
  remoteSnapshot: jsonb('remote_snapshot').$type<ListingSnapshot>(),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('listing_syncs_loc_provider_uq').on(t.locationId, t.provider), index('listing_syncs_org_idx').on(t.organizationId, t.status)]);

/** A field a directory shows differently from BranchHarbor (edited outside BranchHarbor). */
export const listingDrifts = pgTable('listing_drifts', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  field: text('field').$type<ListingField>().notNull(),
  ourValue: jsonb('our_value').$type<unknown>(),
  theirValue: jsonb('their_value').$type<unknown>(),
  /** open | accepted (their value became ours) | overwritten (ours pushed back) | dismissed */
  status: text('status').notNull().default('open'),
  detectedAt: ts('detected_at').notNull().defaultNow(),
  alertedAt: ts('alerted_at'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: ts('resolved_at'),
}, (t) => [
  uniqueIndex('listing_drifts_open_uq').on(t.locationId, t.provider, t.field).where(sql`${t.status} = 'open'`),
  index('listing_drifts_org_idx').on(t.organizationId, t.status),
]);

/** A location's change to fields that need HQ approval (applied on approval). */
export const listingChangeRequests = pgTable('listing_change_requests', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  changes: jsonb('changes').$type<ListingPatch>().notNull(),
  /** pending | approved | rejected | cancelled */
  status: text('status').notNull().default('pending'),
  note: text('note'),
  requestedBy: uuid('requested_by').notNull(),
  decidedBy: uuid('decided_by'),
  decisionNote: text('decision_note'),
  decidedAt: ts('decided_at'),
  createdAt: createdAt(),
}, (t) => [index('listing_change_requests_org_idx').on(t.organizationId, t.status)]);

/** Holiday hours set across the network in one go (kept so new holidays show as missing in the health score). */
export const holidayHourSets = pgTable('holiday_hour_sets', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  entries: jsonb('entries').$type<SpecialHour[]>().notNull(),
  locationIds: jsonb('location_ids').$type<string[]>().notNull(),
  /** Locations whose own special hours for these dates were kept (not overwritten). */
  skippedLocationIds: jsonb('skipped_location_ids').$type<string[]>().notNull().default([]),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('holiday_hour_sets_org_idx').on(t.organizationId, t.createdAt)]);

/* ── Review reply templates (inbox) ── */

export const reviewReplyTemplates = pgTable('review_reply_templates', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** null = HQ template for every location. */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  minRating: integer('min_rating').notNull().default(1),
  maxRating: integer('max_rating').notNull().default(5),
  locale: text('locale'),
  body: text('body').notNull(),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('review_reply_templates_org_idx').on(t.organizationId)]);

/* ── Co-op / local marketing fund ── */

/** Allowance rule: organisation default (location_id null) and per-location overrides. */
export const coopAllowances = pgTable('coop_allowances', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  /** month | quarter | year */
  period: text('period').notNull().default('quarter'),
  /** fund_percent | fixed */
  basis: text('basis').notNull().default('fund_percent'),
  percentBps: integer('percent_bps').notNull().default(0),
  /** Fixed amount per period, in the location's currency. */
  fixedMinor: minor('fixed_minor').notNull().default(0),
  /** Share of eligible spend HQ reimburses (10000 = 100%). */
  matchRatioBps: integer('match_ratio_bps').notNull().default(5000),
  active: boolean('active').notNull().default(true),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('coop_allowances_org_uq').on(t.organizationId).where(sql`${t.locationId} is null`),
  uniqueIndex('coop_allowances_loc_uq').on(t.locationId).where(sql`${t.locationId} is not null`),
]);

export interface CoopCreative { kind: 'asset' | 'local_asset' | 'document' | 'link'; id?: string | null; url?: string | null; name: string }
export interface CoopChecklistItem { key: string; label?: string | null; passed: boolean; note?: string | null }

/** Pre-approval request for local marketing spend. */
export const coopRequests = pgTable('coop_requests', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  vendor: text('vendor'),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on'),
  budgetMinor: minor('budget_minor').notNull(),
  currency: currencyCol().notNull(),
  /** Period the spend counts against (key from coopPeriodBounds, e.g. 2026-Q4). */
  periodKey: text('period_key').notNull(),
  creative: jsonb('creative').$type<CoopCreative[]>().notNull().default([]),
  /** submitted | changes_requested | approved | rejected | claimed | cancelled */
  status: text('status').notNull().default('submitted'),
  checklist: jsonb('checklist').$type<CoopChecklistItem[]>().notNull().default([]),
  approvedMinor: minor('approved_minor'),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
  decisionNote: text('decision_note'),
  requestedBy: uuid('requested_by').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('coop_requests_org_idx').on(t.organizationId, t.status), index('coop_requests_loc_idx').on(t.locationId, t.periodKey)]);

/** Claim after the spend: invoice, proof of performance, reimbursement. */
export const coopClaims = pgTable('coop_claims', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  requestId: uuid('request_id').notNull().references(() => coopRequests.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  spentMinor: minor('spent_minor').notNull(),
  currency: currencyCol().notNull(),
  /** Invoice and proof files (finance_documents). */
  invoiceDocumentId: uuid('invoice_document_id').notNull(),
  proofDocumentIds: jsonb('proof_document_ids').$type<string[]>().notNull().default([]),
  proofNotes: text('proof_notes').notNull().default(''),
  /** Results the owner reports (impressions, leads, attendees, calls). */
  performance: jsonb('performance').$type<Record<string, number>>().notNull().default({}),
  /** What HQ reimburses (computed at approval: eligible spend × match, capped at the allowance left). */
  reimbursableMinor: minor('reimbursable_minor'),
  /** submitted | approved | rejected | paid */
  status: text('status').notNull().default('submitted'),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
  decisionNote: text('decision_note'),
  /** Marketing fund ledger entry booked for the reimbursement. */
  fundEntryId: uuid('fund_entry_id'),
  /** bank_transfer | manual */
  payoutMethod: text('payout_method'),
  payoutReference: text('payout_reference'),
  paidAt: ts('paid_at'),
  paidBy: uuid('paid_by'),
  submittedBy: uuid('submitted_by').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('coop_claims_request_uq').on(t.requestId).where(sql`${t.status} <> 'rejected'`), index('coop_claims_org_idx').on(t.organizationId, t.status)]);

/** HQ brand templates that locations customise within locked areas (print, social, ads). */
export const localAssetTemplates = pgTable('local_asset_templates', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  /** Background artwork from the brand asset library. */
  baseAssetId: uuid('base_asset_id'),
  baseUrl: text('base_url'),
  width: integer('width').notNull().default(1080),
  height: integer('height').notNull().default(1080),
  fields: jsonb('fields').$type<LocalAssetField[]>().notNull().default([]),
  /** draft | published | archived */
  status: text('status').notNull().default('draft'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('local_asset_templates_org_idx').on(t.organizationId, t.status)]);

export const localAssetVersions = pgTable('local_asset_versions', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  templateId: uuid('template_id').notNull().references(() => localAssetTemplates.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  values: jsonb('values').$type<Record<string, string>>().notNull(),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('local_asset_versions_loc_idx').on(t.locationId, t.templateId)]);

/* ── Call tracking ── */

export const trackingNumbers = pgTable('tracking_numbers', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  /** Ad campaign the number is used in (ad_campaigns), when any. */
  campaignId: uuid('campaign_id'),
  label: text('label').notNull(),
  /** Where the number is published: website, google_ads, meta_ads, print, radio, directory, other. */
  source: text('source').notNull().default('website'),
  /** E.164. */
  number: text('number').notNull(),
  provider: text('provider').notNull().default('twilio'),
  /** live = bought through Twilio; sandbox = simulated (never rings). */
  mode: text('mode').notNull().default('sandbox'),
  externalSid: text('external_sid'),
  /** Defaults to the location's phone; E.164. */
  forwardTo: text('forward_to').notNull(),
  /** Record calls (only where HQ allowed it for the location's jurisdiction, with the disclosure played first). */
  recordCalls: boolean('record_calls').notNull().default(false),
  /** Dynamic number insertion on hosted sites: rule matched against the visitor's UTM / referrer. */
  dniMatch: jsonb('dni_match').$type<{ utmSource?: string | null; utmMedium?: string | null; utmCampaign?: string | null; referrerHost?: string | null }>().notNull().default({}),
  /** The location's default website number (shown when no rule matches). */
  isDefault: boolean('is_default').notNull().default(false),
  /** active | released */
  status: text('status').notNull().default('active'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  releasedAt: ts('released_at'),
}, (t) => [
  uniqueIndex('tracking_numbers_number_uq').on(t.number).where(sql`${t.status} = 'active'`),
  index('tracking_numbers_org_idx').on(t.organizationId, t.locationId),
]);

export const trackedCalls = pgTable('tracked_calls', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  trackingNumberId: uuid('tracking_number_id').notNull().references(() => trackingNumbers.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id'),
  /** Copied from the number when the call came in (attribution survives later edits). */
  source: text('source').notNull(),
  callerNumber: text('caller_number').notNull(),
  callerName: text('caller_name'),
  callerCity: text('caller_city'),
  /** Provider call id (Twilio CallSid), idempotency key. */
  externalSid: text('external_sid').notNull(),
  /** ringing | answered | missed | voicemail | busy | failed */
  status: text('status').notNull().default('ringing'),
  startedAt: ts('started_at').notNull(),
  durationSeconds: integer('duration_seconds').notNull().default(0),
  recorded: boolean('recorded').notNull().default(false),
  recordingUrl: text('recording_url'),
  sandbox: boolean('sandbox').notNull().default(false),
  leadId: uuid('lead_id'),
  customerId: uuid('customer_id'),
  firstTimeCaller: boolean('first_time_caller').notNull().default(true),
  notes: text('notes'),
  followedUpAt: ts('followed_up_at'),
  followedUpBy: uuid('followed_up_by'),
  missedAlertedAt: ts('missed_alerted_at'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('tracked_calls_sid_uq').on(t.externalSid),
  index('tracked_calls_org_time_idx').on(t.organizationId, t.locationId, t.startedAt),
  index('tracked_calls_campaign_idx').on(t.campaignId),
]);

/* ── Local social content calendar ── */

/** A post HQ publishes to the network calendar; locations localise it and schedule it on their own accounts. */
export const socialCalendarItems = pgTable('social_calendar_items', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** Text with {location}, {city}, {phone}, {booking_link}, {website}, {brand}. */
  body: text('body').notNull(),
  media: jsonb('media').$type<Array<{ url: string; alt?: string }>>().notNull().default([]),
  link: text('link'),
  /** Networks the post is written for (facebook, instagram, linkedin, google_business). */
  networks: jsonb('networks').$type<string[]>().notNull().default([]),
  /** Suggested publish time (locations may move it within the window). */
  suggestedAt: ts('suggested_at').notNull(),
  /** Locations may edit the text after localising (otherwise only the tokens change). */
  allowEdits: boolean('allow_edits').notNull().default(false),
  /** all | selected */
  audience: text('audience').notNull().default('all'),
  locationIds: jsonb('location_ids').$type<string[]>().notNull().default([]),
  /** draft | published | archived */
  status: text('status').notNull().default('draft'),
  publishedAt: ts('published_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('social_calendar_items_org_idx').on(t.organizationId, t.suggestedAt)]);

/** A location's localised copy of a calendar item (one per location), pointing at its scheduled social post. */
export const socialCalendarAdoptions = pgTable('social_calendar_adoptions', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  itemId: uuid('item_id').notNull().references(() => socialCalendarItems.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  postId: uuid('post_id'),
  /** scheduled | skipped */
  status: text('status').notNull().default('scheduled'),
  adoptedBy: uuid('adopted_by'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('social_calendar_adoptions_uq').on(t.itemId, t.locationId)]);

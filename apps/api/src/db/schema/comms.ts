import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { SegmentRules } from '@bh/shared';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations, users } from './core.ts';
import { customers } from './crm.ts';

/**
 * Marketing & sales communications: unified inbox (email, SMS, WhatsApp, Instagram, Messenger), contact tags and
 * segments, lead routing, the customer sales pipeline, social publishing with HQ-owned accounts, and network /
 * coming-soon ad campaigns. `location_id` null means the HQ (organisation) inbox or an HQ-owned record.
 */

export type InboxChannel = 'email' | 'sms' | 'whatsapp' | 'instagram' | 'messenger';

/** An inbound endpoint of an inbox: a phone number, WhatsApp number id, Meta page / IG account or inbound email address. */
export const commsChannelAccounts = pgTable('comms_channel_accounts', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  channel: text('channel').$type<InboxChannel>().notNull(),
  /** Provider address that inbound webhooks are matched on (E.164 number, phone_number_id, page id, IG id, email). */
  address: text('address').notNull(),
  displayName: text('display_name').notNull(),
  /** live = provider credentials configured; sandbox = simulated (never claims delivery). */
  mode: text('mode').notNull().default('sandbox'),
  /** AES-256-GCM encrypted provider token (Meta page token…). Never returned by the API. */
  credentialsEncrypted: text('credentials_encrypted'),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('comms_channel_accounts_addr_uq').on(t.channel, t.address), index('comms_channel_accounts_org_idx').on(t.organizationId)]);

export const commsConversations = pgTable('comms_conversations', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  channelAccountId: uuid('channel_account_id').notNull().references(() => commsChannelAccounts.id, { onDelete: 'cascade' }),
  channel: text('channel').$type<InboxChannel>().notNull(),
  /** The contact's handle on the channel (phone, email, PSID, IG-scoped id). */
  handle: text('handle').notNull(),
  contactName: text('contact_name'),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  leadId: uuid('lead_id'),
  subject: text('subject'),
  status: text('status').notNull().default('open'), // open | pending | closed
  assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
  /** Last message from the contact: opens the WhatsApp / Meta 24-hour customer-service window. */
  lastInboundAt: ts('last_inbound_at'),
  lastMessageAt: ts('last_message_at').notNull().defaultNow(),
  lastMessagePreview: text('last_message_preview'),
  unread: integer('unread').notNull().default(0),
  /** SLA: first reply due by; cleared once a teammate replies. */
  replyDueAt: ts('reply_due_at'),
  firstReplyAt: ts('first_reply_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('comms_conversations_thread_uq').on(t.channelAccountId, t.handle),
  index('comms_conversations_org_loc_idx').on(t.organizationId, t.locationId, t.lastMessageAt),
]);

export const commsMessages = pgTable('comms_messages', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').notNull().references(() => commsConversations.id, { onDelete: 'cascade' }),
  /** inbound (contact) | outbound (teammate) | note (internal, never sent) */
  direction: text('direction').notNull(),
  body: text('body').notNull(),
  /** WhatsApp approved template used outside the 24-hour window. */
  templateId: uuid('template_id'),
  authorUserId: uuid('author_user_id'),
  externalId: text('external_id'),
  /** received | sent | sandboxed (simulated, not delivered) | failed | blocked */
  status: text('status').notNull(),
  error: text('error'),
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index('comms_messages_conv_idx').on(t.conversationId, t.createdAt)]);

/** WhatsApp message templates (approved by Meta before they can be sent outside the 24-hour window). */
export const commsWhatsappTemplates = pgTable('comms_whatsapp_templates', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  language: text('language').notNull().default('en'),
  category: text('category').notNull().default('utility'), // utility | marketing | authentication
  body: text('body').notNull(),
  /** pending | approved | rejected (Meta review; sandbox approves on submit) */
  status: text('status').notNull().default('pending'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('comms_wa_templates_uq').on(t.organizationId, t.name, t.language)]);

export const commsCannedReplies = pgTable('comms_canned_replies', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

/** Suppression list: a contact replied STOP (or unsubscribed) on a channel. Outbound to the handle is blocked. */
export const commsOptOuts = pgTable('comms_opt_outs', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  handle: text('handle').notNull(),
  source: text('source').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('comms_opt_outs_uq').on(t.organizationId, t.channel, t.handle)]);

export const contactTags = pgTable('contact_tags', {
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  tag: text('tag').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('contact_tags_uq').on(t.customerId, t.tag), index('contact_tags_org_tag_idx').on(t.organizationId, t.tag)]);

/** Segment rules: one model shared with email campaigns and automations (@bh/shared segmentRulesSchema). */
export type { SegmentRules };

export const contactSegments = pgTable('contact_segments', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** null = network segment (HQ); otherwise owned by a location. */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  rules: jsonb('rules').$type<SegmentRules>().notNull().default({}),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export interface RoutingConditions {
  sources?: string[];
  locationIds?: string[];
  /** Territory: ISO countries and/or postal-code prefixes ("M5", "V6K"). */
  countries?: string[];
  postalPrefixes?: string[];
  campaignIds?: string[];
}
export interface RoutingAction {
  /** location: assign to a location's inbox · users: round robin over named people · location_team: round robin over the location's people with access */
  type: 'location' | 'users' | 'location_team';
  locationId?: string;
  userIds?: string[];
}

/** Lead routing rules, checked in order; the first match wins. `kind` separates customer leads from course leads. */
export const leadRoutingRules = pgTable('lead_routing_rules', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('customer'), // customer | course
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  conditions: jsonb('conditions').$type<RoutingConditions>().notNull().default({}),
  action: jsonb('action').$type<RoutingAction>().notNull(),
  /** Round-robin cursor. */
  cursor: integer('cursor').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('lead_routing_rules_org_idx').on(t.organizationId, t.kind, t.position)]);

/* ── Customer sales pipeline (separate from the franchise pipeline) ── */

export const salesStages = pgTable('sales_stages', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  /** open | won | lost */
  outcome: text('outcome').notNull().default('open'),
  probability: integer('probability').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('sales_stages_org_idx').on(t.organizationId, t.position)]);

export const salesDeals = pgTable('sales_deals', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  stageId: uuid('stage_id').notNull().references(() => salesStages.id),
  title: text('title').notNull(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  leadId: uuid('lead_id'),
  valueMinor: minor('value_minor').notNull().default(0),
  currency: currencyCol().notNull(),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  expectedCloseOn: date('expected_close_on'),
  closedAt: ts('closed_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('sales_deals_org_stage_idx').on(t.organizationId, t.stageId)]);

/** Notes, calls, emails, meetings and tasks on a deal or lead. Tasks have a due date and can be completed. */
export const salesActivities = pgTable('sales_activities', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  dealId: uuid('deal_id').references(() => salesDeals.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id'),
  type: text('type').notNull(), // note | call | email | meeting | task | stage_change
  body: text('body').notNull(),
  dueAt: ts('due_at'),
  doneAt: ts('done_at'),
  assignedUserId: uuid('assigned_user_id'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('sales_activities_deal_idx').on(t.dealId), index('sales_activities_lead_idx').on(t.leadId)]);

/* ── Social ── */

export type SocialNetwork = 'facebook' | 'instagram' | 'linkedin' | 'google_business';

/** A social account. HQ-owned accounts (`owner_kind = hq`) stay HQ's; locations get posting rights through grants. */
export const socialAccounts = pgTable('social_accounts', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  ownerKind: text('owner_kind').notNull().default('hq'), // hq | location
  /** The location the account represents (a location page) — or the owning location for location-owned accounts. */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  network: text('network').$type<SocialNetwork>().notNull(),
  handle: text('handle').notNull(),
  externalId: text('external_id'),
  /** live (OAuth connected) | sandbox (posts are simulated, never claimed as published) */
  mode: text('mode').notNull().default('sandbox'),
  status: text('status').notNull().default('connected'), // connected | needs_reauth | disconnected
  credentialsEncrypted: text('credentials_encrypted'),
  connectedBy: uuid('connected_by'),
  createdAt: createdAt(),
}, (t) => [index('social_accounts_org_idx').on(t.organizationId)]);

/** Access handover: HQ grants a location posting rights on an HQ-owned account; revoked on termination. */
export const socialAccountGrants = pgTable('social_account_grants', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  access: text('access').notNull().default('post'), // post | post_insights | view
  grantedBy: uuid('granted_by'),
  grantedAt: ts('granted_at').notNull().defaultNow(),
  revokedAt: ts('revoked_at'),
  revokedBy: uuid('revoked_by'),
  revokeReason: text('revoke_reason'),
}, (t) => [uniqueIndex('social_grants_active_uq').on(t.accountId, t.locationId).where(sql`revoked_at is null`)]);

export interface SocialPublishResult { accountId: string; network: string; status: 'published' | 'sandboxed' | 'failed' | 'cancelled'; externalId?: string | null; error?: string | null; at: string }

export const socialPosts = pgTable('social_posts', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** null = HQ post; otherwise a local post written for this location. */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  media: jsonb('media').$type<Array<{ url: string; alt?: string }>>().notNull().default([]),
  link: text('link'),
  accountIds: jsonb('account_ids').$type<string[]>().notNull().default([]),
  scheduledAt: ts('scheduled_at'),
  /** draft | pending_approval | scheduled | publishing | published | partially_published | failed | rejected | cancelled */
  status: text('status').notNull().default('draft'),
  needsApproval: boolean('needs_approval').notNull().default(false),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
  decisionComment: text('decision_comment'),
  results: jsonb('results').$type<SocialPublishResult[]>().notNull().default([]),
  publishedAt: ts('published_at'),
  authorUserId: uuid('author_user_id').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('social_posts_org_sched_idx').on(t.organizationId, t.scheduledAt), index('social_posts_status_idx').on(t.status, t.scheduledAt)]);

/* ── Ad campaigns ── */

export interface AdCreative { headline: string; body: string; imageUrl?: string | null; assetId?: string | null; cta?: string | null; landingUrl?: string | null }
export interface ComingSoon { openingDate: string; presaleOffer: string; formFields: Array<'name' | 'email' | 'phone'>; consentText: string }

/**
 * Paid campaigns. `network` = HQ for all/some locations, `coming_soon` = locations in onboarding (opening date,
 * pre-sale offer, lead form), `local` = one location's own campaign (budget approval via the approvals inbox),
 * `course` = teacher-training leads (routed to instructors).
 */
export const adCampaigns = pgTable('ad_campaigns', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // network | coming_soon | local | course
  name: text('name').notNull(),
  objective: text('objective').notNull().default('leads'), // leads | awareness | traffic | bookings
  platforms: jsonb('platforms').$type<string[]>().notNull().default([]), // meta | google | linkedin
  /** draft | pending_approval | scheduled | active | paused | completed | rejected | archived */
  status: text('status').notNull().default('draft'),
  startsOn: date('starts_on'),
  endsOn: date('ends_on'),
  creative: jsonb('creative').$type<AdCreative>().notNull(),
  comingSoon: jsonb('coming_soon').$type<ComingSoon>(),
  /** Budget totals requested per currency (minor units), split across locations. */
  budgetTotals: jsonb('budget_totals').$type<Record<string, number>>().notNull().default({}),
  /** Local campaigns: the legacy campaigns row the ad_spend approval points at. */
  approvalCampaignId: uuid('approval_campaign_id'),
  approvalId: uuid('approval_id'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('ad_campaigns_org_idx').on(t.organizationId, t.kind)]);

export const adCampaignLocations = pgTable('ad_campaign_locations', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').notNull().references(() => adCampaigns.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  budgetMinor: minor('budget_minor').notNull(),
  currency: currencyCol().notNull(),
  radiusKm: integer('radius_km').notNull().default(8),
  geo: jsonb('geo').$type<{ lat: number; lng: number } | null>(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('ad_campaign_locations_uq').on(t.campaignId, t.locationId)]);

/** Daily results per campaign and location: entered manually or pulled by an ads adapter. */
export const adCampaignResults = pgTable('ad_campaign_results', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').notNull().references(() => adCampaigns.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  spendMinor: minor('spend_minor').notNull().default(0),
  currency: currencyCol().notNull(),
  impressions: integer('impressions').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  platformLeads: integer('platform_leads').notNull().default(0),
  source: text('source').notNull().default('manual'), // manual | meta | google | linkedin
  enteredBy: uuid('entered_by'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('ad_campaign_results_uq').on(t.campaignId, t.locationId, t.day, t.source)]);

/**
 * Outbox for the marketing fund ledger (built separately): every recorded campaign spend is an event the ledger
 * consumes (`consumed_at`). Corrections to a day's spend are recorded as a delta event (negative when spend went down).
 */
export const marketingFundSpendEvents = pgTable('marketing_fund_spend_events', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').notNull(),
  locationId: uuid('location_id').notNull(),
  resultId: uuid('result_id').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  occurredOn: date('occurred_on').notNull(),
  source: text('source').notNull(),
  consumedAt: ts('consumed_at'),
  createdAt: createdAt(),
}, (t) => [index('mf_spend_events_org_idx').on(t.organizationId, t.consumedAt)]);

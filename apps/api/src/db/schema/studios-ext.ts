/**
 * Studios — full product (subsequent scope): rooms, recurring series, packs & membership products,
 * purchases, membership billing periods, booking policies & fees, online classes, instructor
 * availability, the customer-notification outbox and the customer self-service portal.
 */
import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';
import { customers } from './crm.ts';
import { classOccurrences, classTypes } from './verticals.ts';

const org = () => orgId().references(() => organizations.id, { onDelete: 'cascade' });
const loc = () => uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' });
const optLoc = () => uuid('location_id').references(() => locations.id, { onDelete: 'cascade' });

/** Where a pack / membership can be used. */
export type LocationAccessPolicy = 'home_only' | 'any_location' | 'same_currency' | 'listed';

export const studioRooms = pgTable('studio_rooms', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  name: text('name').notNull(),
  capacity: integer('capacity').notNull(),
  /** Free-text features shown to staff (e.g. "heated", "reformers ×12"). */
  features: jsonb('features').$type<string[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('studio_rooms_loc_name_uq').on(t.locationId, sql`lower(${t.name})`)]);

/** RRULE-like weekly recurrence. Times are local wall-clock times in the location time zone. */
export type SeriesRecurrence = {
  freq: 'WEEKLY';
  /** Every N weeks. */
  interval: number;
  /** 0 = Sunday … 6 = Saturday */
  byWeekday: number[];
  /** HH:MM local time */
  time: string;
  /** YYYY-MM-DD first possible date (local) */
  startDate: string;
  /** YYYY-MM-DD last possible date (local), inclusive */
  untilDate: string | null;
  /** Maximum number of occurrences (alternative to untilDate) */
  count: number | null;
  /** Local dates to skip (holidays). */
  skipDates: string[];
};

export const classSeries = pgTable('class_series', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  classTypeId: uuid('class_type_id').notNull().references(() => classTypes.id, { onDelete: 'cascade' }),
  /** draft | published | ended */
  status: text('status').notNull().default('draft'),
  recurrence: jsonb('recurrence').$type<SeriesRecurrence>().notNull(),
  timeZone: text('time_zone').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  instructorUserId: uuid('instructor_user_id'),
  instructorName: text('instructor_name'),
  roomId: uuid('room_id'),
  roomName: text('room_name'),
  capacity: integer('capacity').notNull(),
  priceMinor: minor('price_minor').notNull().default(0),
  currency: currencyCol().notNull(),
  creditCost: integer('credit_cost').notNull().default(1),
  /** Allow booking with pack credits / memberships. Pay-per-class uses priceMinor. */
  allowCredits: boolean('allow_credits').notNull().default(true),
  allowMembership: boolean('allow_membership').notNull().default(true),
  online: boolean('online').notNull().default(false),
  /** Previous series when this one was split by a "this and following" edit. */
  splitFromId: uuid('split_from_id'),
  createdBy: uuid('created_by'),
  publishedAt: ts('published_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('class_series_loc_idx').on(t.locationId)]);

/** Sellable class pack (N credits). Prices per currency; a location sells it in its own currency only. */
export const studioPackProducts = pgTable('studio_pack_products', {
  id: pk(),
  organizationId: org(),
  /** null = network-wide product */
  locationId: optLoc(),
  name: text('name').notNull(),
  description: text('description'),
  credits: integer('credits').notNull(),
  validityDays: integer('validity_days').notNull(),
  prices: jsonb('prices').$type<Record<string, number>>().notNull().default({}),
  transferPolicy: text('transfer_policy').$type<LocationAccessPolicy>().notNull().default('home_only'),
  allowedLocationIds: jsonb('allowed_location_ids').$type<string[]>().notNull().default([]),
  /** Restrict to these class types; empty = all. */
  classTypeIds: jsonb('class_type_ids').$type<string[]>().notNull().default([]),
  /** draft | active | archived */
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const studioMembershipPlans = pgTable('studio_membership_plans', {
  id: pk(),
  organizationId: org(),
  locationId: optLoc(),
  name: text('name').notNull(),
  description: text('description'),
  /** null = unlimited */
  classesPerPeriod: integer('classes_per_period'),
  /** Monthly price per currency (minor units). */
  prices: jsonb('prices').$type<Record<string, number>>().notNull().default({}),
  accessPolicy: text('access_policy').$type<LocationAccessPolicy>().notNull().default('home_only'),
  allowedLocationIds: jsonb('allowed_location_ids').$type<string[]>().notNull().default([]),
  /** Days between a cancellation request and the end of access/billing. */
  noticeDays: integer('notice_days').notNull().default(30),
  /** Longest single pause (freeze). 0 = pausing not allowed. */
  maxPauseDays: integer('max_pause_days').notNull().default(60),
  /** After a failed renewal the membership stays usable for this many days. */
  graceDays: integer('grace_days').notNull().default(7),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A checkout: pack, membership, offer, on-demand video or a fee. Paid through a PaymentIntent (target `studio_purchase`). */
export const studioPurchases = pgTable('studio_purchases', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  /** pack | membership | offer | online | fee */
  kind: text('kind').notNull(),
  productId: uuid('product_id'),
  offerId: uuid('offer_id'),
  name: text('name').notNull(),
  listPriceMinor: minor('list_price_minor').notNull(),
  discountMinor: minor('discount_minor').notNull().default(0),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  /** pending | paid | failed | cancelled | refunded */
  status: text('status').notNull().default('pending'),
  paymentId: uuid('payment_id'),
  /** Created record (pack id / membership id / grant id / fee id). */
  resultId: uuid('result_id'),
  source: text('source').notNull().default('web'),
  createdBy: uuid('created_by'),
  paidAt: ts('paid_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('studio_purchases_customer_idx').on(t.customerId)]);

/** One billing period of a membership (first payment or renewal). */
export const membershipInvoices = pgTable('membership_invoices', {
  id: pk(),
  organizationId: org(),
  membershipId: uuid('membership_id').notNull(),
  periodStart: ts('period_start').notNull(),
  periodEnd: ts('period_end').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  /** open | paid | failed | void */
  status: text('status').notNull().default('open'),
  attempts: integer('attempts').notNull().default(0),
  paymentId: uuid('payment_id'),
  externalId: text('external_id'),
  failureReason: text('failure_reason'),
  paidAt: ts('paid_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('membership_invoices_period_uq').on(t.membershipId, t.periodStart), uniqueIndex('membership_invoices_ext_uq').on(t.externalId)]);

/** Booking policies per location (row with location_id null = organisation default). */
export const studioPolicies = pgTable('studio_policies', {
  id: pk(),
  organizationId: org(),
  locationId: optLoc(),
  /** Cancelling within this many minutes of the start is a late cancellation. */
  lateCancelMinutes: integer('late_cancel_minutes').notNull().default(720),
  /** Fee per currency, minor units. Missing currency = no fee. */
  lateCancelFee: jsonb('late_cancel_fee').$type<Record<string, number>>().notNull().default({}),
  noShowFee: jsonb('no_show_fee').$type<Record<string, number>>().notNull().default({}),
  /** Late cancellation keeps the credit (it is not returned to the pack). */
  forfeitCreditOnLateCancel: boolean('forfeit_credit_on_late_cancel').notNull().default(true),
  /** Pay-per-class bookings are refunded on late cancellation. */
  refundPaidOnLateCancel: boolean('refund_paid_on_late_cancel').notNull().default(false),
  /** Fees apply to members/pack holders too (default) */
  feesApplyToMembers: boolean('fees_apply_to_members').notNull().default(true),
  bookingWindowDays: integer('booking_window_days').notNull().default(30),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('studio_policies_scope_uq').on(t.organizationId, sql`coalesce(${t.locationId}, '00000000-0000-0000-0000-000000000000'::uuid)`)]);

/** Late-cancel / no-show fees. Collected through a purchase (kind fee) or waived by staff. */
export const studioFees = pgTable('studio_fees', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  bookingId: uuid('booking_id').notNull(),
  /** late_cancel | no_show */
  kind: text('kind').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  /** due | paid | waived */
  status: text('status').notNull().default('due'),
  purchaseId: uuid('purchase_id'),
  waivedBy: uuid('waived_by'),
  waiveReason: text('waive_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('studio_fees_booking_kind_uq').on(t.bookingId, t.kind)]);

/** Online classes: livestreams (linked to an occurrence) and on-demand recordings. */
export const onlineContent = pgTable('online_content', {
  id: pk(),
  organizationId: org(),
  /** null = network library */
  locationId: optLoc(),
  /** livestream | on_demand */
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  classTypeId: uuid('class_type_id'),
  occurrenceId: uuid('occurrence_id').references(() => classOccurrences.id, { onDelete: 'set null' }),
  instructorName: text('instructor_name'),
  /** zoom | youtube | vimeo | other — URL stored, no provider integration. */
  provider: text('provider').notNull(),
  /** Join / watch link: only returned to customers with access (and registration for livestreams). */
  providerUrl: text('provider_url').notNull(),
  startsAt: ts('starts_at'),
  durationMinutes: integer('duration_minutes'),
  /** Who may access: any combination. */
  allowMembers: boolean('allow_members').notNull().default(true),
  allowPackHolders: boolean('allow_pack_holders').notNull().default(false),
  /** Purchase price per currency (minor units); empty = not sold individually. */
  prices: jsonb('prices').$type<Record<string, number>>().notNull().default({}),
  /** Anyone who registers (free). */
  allowFree: boolean('allow_free').notNull().default(false),
  /** draft | published | archived */
  status: text('status').notNull().default('draft'),
  publishedAt: ts('published_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('online_content_org_idx').on(t.organizationId)]);

/** Registration (livestream) or purchase (on-demand) giving a customer access to online content. */
export const onlineAccessGrants = pgTable('online_access_grants', {
  id: pk(),
  organizationId: org(),
  contentId: uuid('content_id').notNull().references(() => onlineContent.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  /** registration | purchase */
  kind: text('kind').notNull(),
  /** Entitlement that allowed it: member | pack_holder | purchase | free */
  basis: text('basis').notNull(),
  purchaseId: uuid('purchase_id'),
  joinedAt: ts('joined_at'),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('online_grants_active_uq').on(t.contentId, t.customerId).where(sql`revoked_at is null`)]);

/** Weekly availability (or unavailability) of an instructor; date-specific blocks via onDate. */
export const instructorAvailability = pgTable('instructor_availability', {
  id: pk(),
  organizationId: org(),
  /** null = any location */
  locationId: optLoc(),
  userId: uuid('user_id').notNull(),
  /** available | unavailable */
  kind: text('kind').notNull().default('available'),
  /** 0–6 for weekly rules; null when onDate is set */
  weekday: integer('weekday'),
  onDate: date('on_date'),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  timeZone: text('time_zone').notNull(),
  note: text('note'),
  createdAt: createdAt(),
}, (t) => [index('instructor_availability_user_idx').on(t.userId)]);

/**
 * Customer-notification outbox: rows are written in the same transaction as the schedule change, then
 * dispatched (consent-aware per channel). Also the class "communication history".
 */
export const studioCustomerNotifications = pgTable('studio_customer_notifications', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  occurrenceId: uuid('occurrence_id'),
  seriesId: uuid('series_id'),
  /** class_changed | class_cancelled | instructor_changed | membership_payment_failed | membership_changed | fee_charged */
  kind: text('kind').notNull(),
  /** email | sms | push */
  channel: text('channel').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  /** queued | sent | skipped_no_consent | skipped_no_contact | failed */
  status: text('status').notNull().default('queued'),
  batchId: uuid('batch_id'),
  sentAt: ts('sent_at'),
  createdAt: createdAt(),
}, (t) => [index('studio_notifications_occ_idx').on(t.occurrenceId), index('studio_notifications_status_idx').on(t.status)]);

/** Customer self-service on hosted sites: magic link → session (both stored hashed). */
export const studioPortalTokens = pgTable('studio_portal_tokens', {
  id: pk(),
  organizationId: org(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  /** link | session */
  kind: text('kind').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

/** AI proposals for studios (drafts, audiences). Proposals only — nothing is sent or changed from here. */
export const studioAiProposals = pgTable('studio_ai_proposals', {
  id: pk(),
  organizationId: org(),
  locationId: optLoc(),
  /** class_description | attendance_summary | follow_up_audience */
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  /** model | template (AI unavailable — deterministic draft from data) */
  source: text('source').notNull(),
  /** proposed | dismissed | used */
  status: text('status').notNull().default('proposed'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

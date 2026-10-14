/**
 * Wellness — full product (administrative scope only: no diagnosis, clinical records or treatment advice).
 * Service variants and per-location prices, multi-location availability templates, exceptions, resource
 * reservations (room + equipment), recurring series, waitlist, packages, gift vouchers, policy fees,
 * client preferences/notes, reminder log and AI drafts.
 *
 * Custom SQL (exclusion constraint + triggers keeping resource reservations in step with appointments) lives in
 * drizzle/*_wellness_reservations.sql.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';
import { customers } from './crm.ts';
import { appointments, practitioners, resources, services, type WeeklyAvailability } from './verticals.ts';

const org = () => orgId().references(() => organizations.id, { onDelete: 'cascade' });

export const wellnessServiceVariants = pgTable('wellness_service_variants', {
  id: pk(),
  organizationId: org(),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  /** null = inherit from the service */
  bufferBeforeMinutes: integer('buffer_before_minutes'),
  bufferAfterMinutes: integer('buffer_after_minutes'),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index('wellness_variants_service_idx').on(t.serviceId)]);

/** Price of a variant at one location, in that location's currency. */
export const wellnessVariantPrices = pgTable('wellness_variant_prices', {
  id: pk(),
  organizationId: org(),
  variantId: uuid('variant_id').notNull().references(() => wellnessServiceVariants.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  priceMinor: minor('price_minor').notNull(),
  /** null = derive from the service deposit rule */
  depositMinor: minor('deposit_minor'),
  currency: currencyCol().notNull(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('wellness_variant_prices_uq').on(t.variantId, t.locationId), check('wellness_variant_prices_amount_chk', sql`${t.priceMinor} >= 0 AND (${t.depositMinor} IS NULL OR (${t.depositMinor} >= 0 AND ${t.depositMinor} <= ${t.priceMinor}))`)]);

/** Weekly template of a practitioner at a location other than their home location. */
export const wellnessPractitionerLocations = pgTable('wellness_practitioner_locations', {
  id: pk(),
  organizationId: org(),
  practitionerId: uuid('practitioner_id').notNull().references(() => practitioners.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  availability: jsonb('availability').$type<WeeklyAvailability>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('wellness_prac_loc_uq').on(t.practitionerId, t.locationId)]);

/** Leave/absence: removes availability; affected appointments are listed for rebooking. */
export const wellnessAvailabilityExceptions = pgTable('wellness_availability_exceptions', {
  id: pk(),
  organizationId: org(),
  practitionerId: uuid('practitioner_id').notNull().references(() => practitioners.id, { onDelete: 'cascade' }),
  /** null = every location the practitioner works at */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  /** leave | absence | training | other */
  kind: text('kind').notNull().default('leave'),
  reason: text('reason'),
  /** active | withdrawn */
  status: text('status').notNull().default('active'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('wellness_exceptions_prac_idx').on(t.practitionerId, t.startsAt), check('wellness_exceptions_range_chk', sql`${t.endsAt} > ${t.startsAt}`)]);

/**
 * Every resource hold (room, equipment). Rows are created by the booking engine (equipment) and by a trigger from
 * appointments.resource_id (room); `active` follows the appointment status (trigger). An exclusion constraint makes
 * overlapping active holds on one resource impossible.
 */
export const wellnessResourceReservations = pgTable('wellness_resource_reservations', {
  id: pk(),
  organizationId: uuid('organization_id').notNull(),
  locationId: uuid('location_id').notNull(),
  resourceId: uuid('resource_id').notNull().references(() => resources.id, { onDelete: 'cascade' }),
  appointmentId: uuid('appointment_id').notNull().references(() => appointments.id, { onDelete: 'cascade' }),
  blockedFrom: ts('blocked_from').notNull(),
  blockedUntil: ts('blocked_until').notNull(),
  /** room | equipment */
  role: text('role').notNull().default('room'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index('wellness_res_resv_appt_idx').on(t.appointmentId), index('wellness_res_resv_res_idx').on(t.resourceId, t.blockedFrom)]);

export const wellnessSeries = pgTable('wellness_series', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  serviceId: uuid('service_id').notNull().references(() => services.id),
  variantId: uuid('variant_id'),
  practitionerId: uuid('practitioner_id'),
  /** weekly */
  frequency: text('frequency').notNull().default('weekly'),
  intervalWeeks: integer('interval_weeks').notNull().default(1),
  occurrences: integer('occurrences').notNull(),
  /** Wall-clock time and first date in the location's time zone (recurrence respects DST). */
  firstDate: text('first_date').notNull(),
  localTime: text('local_time').notNull(),
  /** active | cancelled */
  status: text('status').notNull().default('active'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

export const wellnessWaitlist = pgTable('wellness_waitlist', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id'),
  practitionerId: uuid('practitioner_id'),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  windowStart: ts('window_start').notNull(),
  windowEnd: ts('window_end').notNull(),
  /** waiting | offered | booked | left | expired */
  status: text('status').notNull().default('waiting'),
  offeredAt: ts('offered_at'),
  offeredStartsAt: ts('offered_starts_at'),
  offeredPractitionerId: uuid('offered_practitioner_id'),
  appointmentId: uuid('appointment_id'),
  manageTokenHash: text('manage_token_hash'),
  note: text('note'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('wellness_waitlist_loc_idx').on(t.locationId, t.status, t.windowStart), check('wellness_waitlist_window_chk', sql`${t.windowEnd} > ${t.windowStart}`)]);

export const wellnessPackagePlans = pgTable('wellness_package_plans', {
  id: pk(),
  organizationId: org(),
  /** null = sold at every location using this currency */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  /** null = any variant of the service */
  variantId: uuid('variant_id'),
  sessions: integer('sessions').notNull(),
  priceMinor: minor('price_minor').notNull(),
  currency: currencyCol().notNull(),
  validityDays: integer('validity_days').notNull().default(365),
  /** personal | shareable (with up to maxSharedWith named clients) */
  sharing: text('sharing').notNull().default('personal'),
  maxSharedWith: integer('max_shared_with').notNull().default(0),
  onlinePurchasable: boolean('online_purchasable').notNull().default(true),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [check('wellness_plans_chk', sql`${t.sessions} > 0 AND ${t.priceMinor} >= 0 AND ${t.validityDays} > 0`)]);

export const wellnessClientPackages = pgTable('wellness_client_packages', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  planId: uuid('plan_id').notNull().references(() => wellnessPackagePlans.id),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  sessionsTotal: integer('sessions_total').notNull(),
  sessionsUsed: integer('sessions_used').notNull().default(0),
  priceMinor: minor('price_minor').notNull(),
  currency: currencyCol().notNull(),
  purchasedAt: ts('purchased_at'),
  expiresAt: ts('expires_at'),
  /** pending_payment | active | exhausted | expired | cancelled */
  status: text('status').notNull().default('pending_payment'),
  sharedWithCustomerIds: jsonb('shared_with_customer_ids').$type<string[]>().notNull().default([]),
  paymentId: uuid('payment_id'),
  /** in_person | online */
  paidVia: text('paid_via'),
  manageTokenHash: text('manage_token_hash'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('wellness_client_packages_customer_idx').on(t.customerId), check('wellness_client_packages_sessions_chk', sql`${t.sessionsUsed} >= 0 AND ${t.sessionsUsed} <= ${t.sessionsTotal}`)]);

export const wellnessPackageRedemptions = pgTable('wellness_package_redemptions', {
  id: pk(),
  organizationId: org(),
  clientPackageId: uuid('client_package_id').notNull().references(() => wellnessClientPackages.id, { onDelete: 'cascade' }),
  appointmentId: uuid('appointment_id').notNull().references(() => appointments.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  redeemedAt: ts('redeemed_at').notNull().defaultNow(),
  reversedAt: ts('reversed_at'),
  reversalReason: text('reversal_reason'),
}, (t) => [uniqueIndex('wellness_redemptions_appt_uq').on(t.appointmentId), index('wellness_redemptions_pkg_idx').on(t.clientPackageId)]);

export const wellnessGiftVouchers = pgTable('wellness_gift_vouchers', {
  id: pk(),
  organizationId: org(),
  code: text('code').notNull(),
  /** Location that sold it; vouchers are redeemable at any location using the same currency. */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  initialMinor: minor('initial_minor').notNull(),
  balanceMinor: minor('balance_minor').notNull(),
  currency: currencyCol().notNull(),
  expiresAt: ts('expires_at').notNull(),
  /** pending_payment | active | redeemed | expired | cancelled */
  status: text('status').notNull().default('pending_payment'),
  purchaserCustomerId: uuid('purchaser_customer_id'),
  recipientName: text('recipient_name'),
  recipientEmail: text('recipient_email'),
  message: text('message'),
  paymentId: uuid('payment_id'),
  manageTokenHash: text('manage_token_hash'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('wellness_vouchers_code_uq').on(t.organizationId, t.code), check('wellness_vouchers_balance_chk', sql`${t.balanceMinor} >= 0 AND ${t.balanceMinor} <= ${t.initialMinor} AND ${t.initialMinor} > 0`)]);

export const wellnessVoucherTransactions = pgTable('wellness_voucher_transactions', {
  id: pk(),
  organizationId: org(),
  voucherId: uuid('voucher_id').notNull().references(() => wellnessGiftVouchers.id, { onDelete: 'cascade' }),
  /** issue | redeem | reversal | adjust | expire */
  kind: text('kind').notNull(),
  /** signed: redeem negative, reversal/issue positive */
  amountMinor: minor('amount_minor').notNull(),
  balanceAfterMinor: minor('balance_after_minor').notNull(),
  appointmentId: uuid('appointment_id'),
  actorUserId: uuid('actor_user_id'),
  note: text('note'),
  createdAt: createdAt(),
}, (t) => [index('wellness_voucher_tx_voucher_idx').on(t.voucherId)]);

/** Late-cancellation and no-show fees, and how they were settled. */
export const wellnessAppointmentCharges = pgTable('wellness_appointment_charges', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id').notNull(),
  appointmentId: uuid('appointment_id').notNull().references(() => appointments.id, { onDelete: 'cascade' }),
  /** late_cancel | no_show */
  kind: text('kind').notNull(),
  feeMinor: minor('fee_minor').notNull(),
  currency: currencyCol().notNull(),
  retainedFromDepositMinor: minor('retained_from_deposit_minor').notNull().default(0),
  retainedFromVoucherMinor: minor('retained_from_voucher_minor').notNull().default(0),
  outstandingMinor: minor('outstanding_minor').notNull().default(0),
  refundedMinor: minor('refunded_minor').notNull().default(0),
  /** settled | outstanding | waived */
  status: text('status').notNull(),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('wellness_charges_appt_uq').on(t.appointmentId)]);

export const wellnessClientPreferences = pgTable('wellness_client_preferences', {
  id: pk(),
  organizationId: org(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  preferredPractitionerIds: jsonb('preferred_practitioner_ids').$type<string[]>().notNull().default([]),
  preferredLocationId: uuid('preferred_location_id'),
  /** email | sms */
  preferredChannel: text('preferred_channel').notNull().default('email'),
  /** Administrative comfort preferences only (e.g. "quiet room", "prefers mornings"). Never clinical. */
  comfort: jsonb('comfort').$type<string[]>().notNull().default([]),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('wellness_prefs_customer_uq').on(t.customerId)]);

/**
 * Scoped administrative notes. Confidential notes are visible only to their author and to managers
 * (customers.write at the note's location). Never clinical; never sent to AI.
 */
export const wellnessClientNotes = pgTable('wellness_client_notes', {
  id: pk(),
  organizationId: org(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  appointmentId: uuid('appointment_id'),
  authorUserId: uuid('author_user_id').notNull(),
  body: text('body').notNull(),
  confidential: boolean('confidential').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('wellness_notes_customer_idx').on(t.customerId)]);

/** Reminder / retention / waitlist / rebook messages: one row per attempt with the consent outcome. */
export const wellnessMessageLog = pgTable('wellness_message_log', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id'),
  appointmentId: uuid('appointment_id'),
  customerId: uuid('customer_id'),
  /** reminder | rebook_prompt | waitlist_offer | schedule_change | voucher_issued */
  kind: text('kind').notNull(),
  /** email | sms */
  channel: text('channel').notNull(),
  /** sent | logged (sandbox adapter) | skipped_no_consent | skipped_no_contact | failed */
  status: text('status').notNull(),
  /** Idempotency key, e.g. reminder:<appointmentId>:email */
  dedupeKey: text('dedupe_key'),
  detail: text('detail'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('wellness_message_dedupe_uq').on(t.organizationId, t.dedupeKey), index('wellness_message_customer_idx').on(t.customerId)]);

/** Per-location reminder and retention settings. */
export const wellnessLocationSettings = pgTable('wellness_location_settings', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  reminderHoursBefore: integer('reminder_hours_before').notNull().default(24),
  smsReminders: boolean('sms_reminders').notNull().default(true),
  emailReminders: boolean('email_reminders').notNull().default(true),
  rebookPrompts: boolean('rebook_prompts').notNull().default(true),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('wellness_location_settings_uq').on(t.locationId)]);

/** AI drafts are proposals: nothing is published or sent until a person applies them. */
export const wellnessAiDrafts = pgTable('wellness_ai_drafts', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id'),
  /** service_copy | policy_reply | appointment_summary */
  kind: text('kind').notNull(),
  targetId: uuid('target_id'),
  input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
  output: text('output').notNull(),
  /** Health-claim phrases removed from the model output. */
  removedClaims: jsonb('removed_claims').$type<string[]>().notNull().default([]),
  sources: jsonb('sources').$type<string[]>().notNull().default([]),
  /** proposed | applied | discarded */
  status: text('status').notNull().default('proposed'),
  model: text('model'),
  createdBy: uuid('created_by').notNull(),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
  createdAt: createdAt(),
});

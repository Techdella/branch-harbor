import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations, users } from './core.ts';
import { customers } from './crm.ts';
import { appointments } from './verticals.ts';

const org = () => orgId().references(() => organizations.id, { onDelete: 'cascade' });
const loc = () => uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' });

// ───────────── Staff shifts & time clock ─────────────

/** A scheduled shift for one staff member at one location. Times are UTC; display uses the location's time zone. */
export const shifts = pgTable('shifts', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Position worked, e.g. "Front desk", "Kitchen lead". */
  role: text('role').notNull(),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  breakMinutes: integer('break_minutes').notNull().default(0),
  /** scheduled | cancelled */
  status: text('status').notNull().default('scheduled'),
  notes: text('notes'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('shifts_loc_start_idx').on(t.locationId, t.startsAt), index('shifts_user_start_idx').on(t.userId, t.startsAt)]);

/** A request to hand a shift to a colleague (optionally swapping for one of theirs). Needs manager approval. */
export const shiftSwapRequests = pgTable('shift_swap_requests', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  shiftId: uuid('shift_id').notNull().references(() => shifts.id, { onDelete: 'cascade' }),
  requestedBy: uuid('requested_by').notNull(),
  toUserId: uuid('to_user_id').notNull(),
  /** When set, the colleague's shift moves to the requester (a true swap); otherwise it is a giveaway. */
  toShiftId: uuid('to_shift_id'),
  reason: text('reason'),
  /** pending | approved | rejected | cancelled */
  status: text('status').notNull().default('pending'),
  approvalId: uuid('approval_id'),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('shift_swap_pending_uq').on(t.shiftId).where(sql`status = 'pending'`)]);

/** Append-only clock-in / clock-out events. */
export const timeClockEvents = pgTable('time_clock_events', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  shiftId: uuid('shift_id').references(() => shifts.id, { onDelete: 'set null' }),
  /** clock_in | clock_out */
  kind: text('kind').notNull(),
  at: ts('at').notNull().defaultNow(),
  source: text('source').notNull().default('web'),
  note: text('note'),
  createdAt: createdAt(),
}, (t) => [index('time_clock_user_at_idx').on(t.userId, t.at), index('time_clock_loc_at_idx').on(t.locationId, t.at)]);

// ───────────── Studios offers ─────────────

export type OfferEligibility = {
  /** Only customers with no previous bookings or offer redemptions in this organisation. */
  newCustomersOnly?: boolean;
  /** How many times one customer may redeem the offer. */
  maxPerCustomer?: number;
  /** Minimum age on the day of purchase (requires a date of birth on record). */
  minAge?: number;
  /** Restrict to these locations; empty/absent = wherever the offer is scoped. */
  locationIds?: string[];
};

export const studioOffers = pgTable('studio_offers', {
  id: pk(),
  organizationId: org(),
  /** null = network-wide offer defined by HQ */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  /** intro_pass | class_pack | trial_membership */
  kind: text('kind').notNull().default('intro_pass'),
  /** Price per currency in minor units, e.g. { "CAD": 2500, "GBP": 1500 }. A location without its currency cannot sell the offer. */
  prices: jsonb('prices').$type<Record<string, number>>().notNull().default({}),
  credits: integer('credits'),
  validDays: integer('valid_days').notNull().default(30),
  eligibility: jsonb('eligibility').$type<OfferEligibility>().notNull().default({}),
  /** draft | active | paused | ended */
  status: text('status').notNull().default('draft'),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const offerRedemptions = pgTable('offer_redemptions', {
  id: pk(),
  organizationId: org(),
  offerId: uuid('offer_id').notNull().references(() => studioOffers.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id'),
  createdAt: createdAt(),
}, (t) => [index('offer_redemptions_offer_customer_idx').on(t.offerId, t.customerId)]);

// ───────────── Wellness intake forms (administrative only) ─────────────

export type IntakeQuestion = { id: string; label: string; type: 'text' | 'longtext' | 'yes_no' | 'choice' | 'date'; required: boolean; options?: string[]; help?: string };

export const intakeForms = pgTable('intake_forms', {
  id: pk(),
  organizationId: org(),
  /** null = all locations */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  /** Services this form is requested for; empty = all services. */
  serviceIds: jsonb('service_ids').$type<string[]>().notNull().default([]),
  questions: jsonb('questions').$type<IntakeQuestion[]>().notNull().default([]),
  /** Version of the consent statement customers agree to when submitting. */
  consentVersion: text('consent_version').notNull(),
  consentText: text('consent_text').notNull(),
  /** Bumped whenever questions or consent change; responses record the version they answered. */
  version: integer('version').notNull().default(1),
  /** draft | active | archived */
  status: text('status').notNull().default('draft'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const intakeResponses = pgTable('intake_responses', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  formId: uuid('form_id').notNull().references(() => intakeForms.id, { onDelete: 'cascade' }),
  formVersion: integer('form_version').notNull(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
  answers: jsonb('answers').$type<Record<string, unknown>>().notNull().default({}),
  consentVersion: text('consent_version').notNull(),
  consentGivenAt: ts('consent_given_at').notNull(),
  /** Responses are never passed to BranchHarbor AI unless a business explicitly changes this per response. */
  aiContextExcluded: boolean('ai_context_excluded').notNull().default(true),
  submittedAt: ts('submitted_at').notNull().defaultNow(),
}, (t) => [index('intake_responses_form_idx').on(t.formId), index('intake_responses_customer_idx').on(t.customerId)]);

// ───────────── Foods pickup settings ─────────────

export type PickupHours = Array<{ weekday: number; open: string; close: string }>;

/** Per-location pickup configuration that drives pickup slot generation. */
export const pickupSettings = pgTable('pickup_settings', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id').notNull().unique().references(() => locations.id, { onDelete: 'cascade' }),
  /** Weekly pickup windows in local wall time (weekday 0=Sunday). */
  hours: jsonb('hours').$type<PickupHours>().notNull().default([]),
  slotMinutes: integer('slot_minutes').notNull().default(15),
  slotCapacity: integer('slot_capacity').notNull().default(6),
  /** Earliest pickup is at least this long after "now" (kitchen preparation time). */
  prepBufferMinutes: integer('prep_buffer_minutes').notNull().default(20),
  /** Orders for a slot close this many minutes before the slot starts. */
  cutoffMinutes: integer('cutoff_minutes').notNull().default(20),
  /** How many days ahead slots are generated. */
  horizonDays: integer('horizon_days').notNull().default(2),
  /** Local dates (YYYY-MM-DD) with no pickup. */
  closedDates: jsonb('closed_dates').$type<string[]>().notNull().default([]),
  acceptingOrders: boolean('accepting_orders').notNull().default(true),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ───────────── Push notification log ─────────────

/** One row per notification attempt (sandbox, sent, failed or skipped) — the delivery audit for push. */
export const pushNotifications = pgTable('push_notifications', {
  id: pk(),
  organizationId: uuid('organization_id'),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** order_status | approval_request | cover_request | waitlist_promotion */
  category: text('category').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  /** sent | sandbox | failed | skipped_no_token | skipped_preference */
  status: text('status').notNull(),
  tokenCount: integer('token_count').notNull().default(0),
  error: text('error'),
  createdAt: createdAt(),
}, (t) => [index('push_notifications_user_idx').on(t.userId, t.createdAt)]);

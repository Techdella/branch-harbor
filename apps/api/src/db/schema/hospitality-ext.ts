/**
 * Hospitality (`hospitality`) — properties (= locations), room types, rooms, dorm beds, out-of-order blocks, per-night
 * inventory counters, rate plans / seasons / prices / daily restrictions, taxes, cancellation policies, reservations
 * with rooms and room-night assignments, folios, housekeeping tasks, guest message log and sandbox channel exports.
 * See docs/verticals/hospitality.md. Money: minor units in the property currency. Dates: `date` (property-local nights).
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, pgTable, real, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { CancellationPolicy, FeeRule, NightPrice, TaxLine } from '@bh/shared';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';
import { customers } from './crm.ts';

const org = () => orgId().references(() => organizations.id, { onDelete: 'cascade' });
const loc = () => uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' });

export type HospMedia = { url: string; alt?: string | null };
export type RegistrationField = { key: string; label: string; kind: 'text' | 'date' | 'country' | 'document_number'; required: boolean };
export type ReservationEvent = { at: string; by: string | null; action: string; note?: string };

/** Per-property settings. One row per location. */
export const hospProperties = pgTable('hosp_properties', {
  id: pk(),
  organizationId: org(),
  locationId: loc().unique(),
  /** hotel | guesthouse | serviced_apartments | hostel */
  kind: text('kind').notNull().default('hotel'),
  description: text('description'),
  amenities: text('amenities').array().notNull().default(sql`'{}'::text[]`),
  photos: jsonb('photos').$type<HospMedia[]>().notNull().default([]),
  checkInTime: text('check_in_time').notNull().default('15:00'),
  checkOutTime: text('check_out_time').notNull().default('11:00'),
  /** Minutes an unpaid online hold keeps inventory. */
  holdMinutes: integer('hold_minutes').notNull().default(15),
  requireInspected: boolean('require_inspected').notNull().default(false),
  /** Guest registration fields required by local law, configured by the business. Nothing else is accepted. */
  registrationFields: jsonb('registration_fields').$type<RegistrationField[]>().notNull().default([]),
  registrationRetentionDays: integer('registration_retention_days').notNull().default(365),
  preArrivalDays: integer('pre_arrival_days').notNull().default(2),
  /** House rules / arrival instructions written by the business (shown to guests, used in check-in info). */
  houseRules: text('house_rules'),
  arrivalInstructions: text('arrival_instructions'),
  outletEnabled: boolean('outlet_enabled').notNull().default(false),
  outletName: text('outlet_name'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const hospRoomTypes = pgTable('hosp_room_types', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** room | apartment | dorm (dorms sell beds) */
  kind: text('kind').notNull().default('room'),
  description: text('description'),
  beds: jsonb('beds').$type<Array<{ type: string; count: number }>>().notNull().default([]),
  baseOccupancy: integer('base_occupancy').notNull().default(2),
  maxOccupancy: integer('max_occupancy').notNull().default(2),
  maxAdults: integer('max_adults'),
  sizeSqm: real('size_sqm'),
  amenities: text('amenities').array().notNull().default(sql`'{}'::text[]`),
  photos: jsonb('photos').$type<HospMedia[]>().notNull().default([]),
  bookableOnline: boolean('bookable_online').notNull().default(true),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('hosp_room_types_loc_code_uq').on(t.locationId, t.code)]);

export const hospRooms = pgTable('hosp_rooms', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  roomTypeId: uuid('room_type_id').notNull().references(() => hospRoomTypes.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  floor: text('floor'),
  /** clean | dirty | inspected | out_of_order */
  hkStatus: text('hk_status').notNull().default('clean'),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('hosp_rooms_loc_number_uq').on(t.locationId, t.number), index('hosp_rooms_type_idx').on(t.roomTypeId)]);

/** Dorm beds: the sellable unit of a dorm room type. */
export const hospBeds = pgTable('hosp_beds', {
  id: pk(),
  organizationId: org(),
  roomId: uuid('room_id').notNull().references(() => hospRooms.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  active: boolean('active').notNull().default(true),
}, (t) => [uniqueIndex('hosp_beds_room_label_uq').on(t.roomId, t.label)]);

/** Out-of-order periods (maintenance). Nights [startDate, endDate). Reduce sellable inventory. */
export const hospRoomBlocks = pgTable('hosp_room_blocks', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  roomId: uuid('room_id').notNull().references(() => hospRooms.id, { onDelete: 'cascade' }),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  reason: text('reason').notNull(),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('hosp_room_blocks_room_idx').on(t.roomId), check('hosp_room_blocks_range_ck', sql`${t.endDate} > ${t.startDate}`)]);

/**
 * Per room type and night: sellable units (`total`) and units held/sold (`sold`). The CHECK makes overbooking
 * impossible: concurrent increments serialise on the row and the one that would exceed `total` fails.
 */
export const hospInventory = pgTable('hosp_inventory', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  roomTypeId: uuid('room_type_id').notNull().references(() => hospRoomTypes.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  total: integer('total').notNull(),
  sold: integer('sold').notNull().default(0),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('hosp_inventory_type_date_uq').on(t.roomTypeId, t.date),
  index('hosp_inventory_loc_date_idx').on(t.locationId, t.date),
  check('hosp_inventory_sold_ck', sql`${t.sold} >= 0 and ${t.sold} <= ${t.total}`),
  check('hosp_inventory_total_ck', sql`${t.total} >= 0`),
]);

export const hospCancellationPolicies = pgTable('hosp_cancellation_policies', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  name: text('name').notNull(),
  nonRefundable: boolean('non_refundable').notNull().default(false),
  freeUntilHours: integer('free_until_hours'),
  lateFee: jsonb('late_fee').$type<FeeRule>().notNull().default({ type: 'first_night' }),
  noShowFee: jsonb('no_show_fee').$type<FeeRule>().notNull().default({ type: 'first_night' }),
  createdAt: createdAt(),
});

export const hospRatePlans = pgTable('hosp_rate_plans', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** bar | non_refundable | package */
  kind: text('kind').notNull().default('bar'),
  description: text('description'),
  currency: currencyCol().notNull(),
  includesBreakfast: boolean('includes_breakfast').notNull().default(false),
  inclusions: text('inclusions').array().notNull().default(sql`'{}'::text[]`),
  /** Derived plans take prices from this plan and apply adjustmentBps (e.g. −1000 = 10% off). */
  derivedFromId: uuid('derived_from_id'),
  adjustmentBps: integer('adjustment_bps'),
  minStay: integer('min_stay'),
  maxStay: integer('max_stay'),
  /** none | first_night | percent | full */
  depositRule: text('deposit_rule').notNull().default('first_night'),
  depositPercentBps: integer('deposit_percent_bps'),
  cancellationPolicyId: uuid('cancellation_policy_id').references(() => hospCancellationPolicies.id, { onDelete: 'set null' }),
  bookableOnline: boolean('bookable_online').notNull().default(true),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('hosp_rate_plans_loc_code_uq').on(t.locationId, t.code)]);

export const hospSeasons = pgTable('hosp_seasons', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  /** Inclusive last night. */
  endDate: date('end_date').notNull(),
  minStay: integer('min_stay'),
  maxStay: integer('max_stay'),
  priority: integer('priority').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [check('hosp_seasons_range_ck', sql`${t.endDate} >= ${t.startDate}`)]);

/** Nightly price per rate plan × room type, base (season null) or per season. weekdayAmounts keys "0".."6" (Sun..Sat). */
export const hospRatePrices = pgTable('hosp_rate_prices', {
  id: pk(),
  organizationId: org(),
  ratePlanId: uuid('rate_plan_id').notNull().references(() => hospRatePlans.id, { onDelete: 'cascade' }),
  roomTypeId: uuid('room_type_id').notNull().references(() => hospRoomTypes.id, { onDelete: 'cascade' }),
  seasonId: uuid('season_id').references(() => hospSeasons.id, { onDelete: 'cascade' }),
  currency: currencyCol().notNull(),
  amountMinor: minor('amount_minor').notNull(),
  weekdayAmounts: jsonb('weekday_amounts').$type<Partial<Record<string, number>>>().notNull().default({}),
  extraAdultMinor: minor('extra_adult_minor'),
  extraChildMinor: minor('extra_child_minor'),
}, (t) => [unique('hosp_rate_prices_uq').on(t.ratePlanId, t.roomTypeId, t.seasonId).nullsNotDistinct(), check('hosp_rate_prices_amount_ck', sql`${t.amountMinor} >= 0`)]);

/** Daily overrides and restrictions per rate plan × room type × night. */
export const hospDailyRates = pgTable('hosp_daily_rates', {
  id: pk(),
  organizationId: org(),
  ratePlanId: uuid('rate_plan_id').notNull().references(() => hospRatePlans.id, { onDelete: 'cascade' }),
  roomTypeId: uuid('room_type_id').notNull().references(() => hospRoomTypes.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  amountMinor: minor('amount_minor'),
  minStay: integer('min_stay'),
  maxStay: integer('max_stay'),
  closed: boolean('closed').notNull().default(false),
  closedToArrival: boolean('closed_to_arrival').notNull().default(false),
  closedToDeparture: boolean('closed_to_departure').notNull().default(false),
}, (t) => [uniqueIndex('hosp_daily_rates_uq').on(t.ratePlanId, t.roomTypeId, t.date)]);

/** Taxes configured by the business (city/occupancy tax, VAT). BranchHarbor never supplies amounts. */
export const hospTaxes = pgTable('hosp_taxes', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  name: text('name').notNull(),
  /** percent | per_night | per_person_per_night | per_stay */
  kind: text('kind').notNull(),
  rateBps: integer('rate_bps'),
  amountMinor: minor('amount_minor'),
  currency: currencyCol().notNull(),
  inclusive: boolean('inclusive').notNull().default(false),
  maxNights: integer('max_nights'),
  appliesToChildren: boolean('applies_to_children').notNull().default(false),
  note: text('note'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const hospReservations = pgTable('hosp_reservations', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  code: text('code').notNull(),
  /** hold | confirmed | checked_in | checked_out | cancelled | no_show | expired */
  status: text('status').notNull().default('hold'),
  source: text('source').notNull().default('website'),
  arrival: date('arrival').notNull(),
  departure: date('departure').notNull(),
  adults: integer('adults').notNull(),
  children: integer('children').notNull().default(0),
  groupName: text('group_name'),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  guestName: text('guest_name').notNull(),
  guestEmail: text('guest_email'),
  guestPhone: text('guest_phone'),
  arrivalTime: text('arrival_time'),
  specialRequests: text('special_requests'),
  currency: currencyCol().notNull(),
  roomTotalMinor: minor('room_total_minor').notNull(),
  taxAddedMinor: minor('tax_added_minor').notNull().default(0),
  totalMinor: minor('total_minor').notNull(),
  depositRequiredMinor: minor('deposit_required_minor').notNull().default(0),
  depositPaidMinor: minor('deposit_paid_minor').notNull().default(0),
  paymentId: uuid('payment_id'),
  holdExpiresAt: ts('hold_expires_at'),
  cancellationPolicy: jsonb('cancellation_policy').$type<CancellationPolicy>().notNull(),
  cancelledAt: ts('cancelled_at'),
  cancellationFeeMinor: minor('cancellation_fee_minor'),
  cancelReason: text('cancel_reason'),
  noShowAt: ts('no_show_at'),
  checkedInAt: ts('checked_in_at'),
  checkedOutAt: ts('checked_out_at'),
  registration: jsonb('registration').$type<Record<string, string>>(),
  registrationErasedAt: ts('registration_erased_at'),
  /** Consent captured at booking for pre-arrival / check-in messages. */
  messageConsent: jsonb('message_consent').$type<{ email: boolean; sms: boolean }>().notNull().default({ email: false, sms: false }),
  manageTokenHash: text('manage_token_hash'),
  timeline: jsonb('timeline').$type<ReservationEvent[]>().notNull().default([]),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('hosp_reservations_org_code_uq').on(t.organizationId, t.code),
  index('hosp_reservations_loc_arrival_idx').on(t.locationId, t.arrival),
  index('hosp_reservations_loc_status_idx').on(t.locationId, t.status),
  check('hosp_reservations_dates_ck', sql`${t.departure} > ${t.arrival}`),
]);

export const hospReservationRooms = pgTable('hosp_reservation_rooms', {
  id: pk(),
  organizationId: org(),
  reservationId: uuid('reservation_id').notNull().references(() => hospReservations.id, { onDelete: 'cascade' }),
  roomTypeId: uuid('room_type_id').notNull().references(() => hospRoomTypes.id),
  ratePlanId: uuid('rate_plan_id').notNull().references(() => hospRatePlans.id),
  adults: integer('adults').notNull(),
  children: integer('children').notNull().default(0),
  nights: jsonb('nights').$type<NightPrice[]>().notNull(),
  taxes: jsonb('taxes').$type<TaxLine[]>().notNull().default([]),
  roomTotalMinor: minor('room_total_minor').notNull(),
  taxAddedMinor: minor('tax_added_minor').notNull().default(0),
  totalMinor: minor('total_minor').notNull(),
  /** Current room (and bed for dorms) assignment; per-night rows live in hosp_assignments. */
  roomId: uuid('room_id').references(() => hospRooms.id, { onDelete: 'set null' }),
  bedId: uuid('bed_id').references(() => hospBeds.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [index('hosp_reservation_rooms_res_idx').on(t.reservationId)]);

/** One row per assigned room (or bed) per night; partial unique indexes stop double assignment. */
export const hospAssignments = pgTable('hosp_assignments', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  reservationRoomId: uuid('reservation_room_id').notNull().references(() => hospReservationRooms.id, { onDelete: 'cascade' }),
  roomId: uuid('room_id').notNull().references(() => hospRooms.id, { onDelete: 'cascade' }),
  bedId: uuid('bed_id').references(() => hospBeds.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
}, (t) => [
  uniqueIndex('hosp_assignments_room_night_uq').on(t.roomId, t.date).where(sql`${t.bedId} is null`),
  uniqueIndex('hosp_assignments_bed_night_uq').on(t.bedId, t.date).where(sql`${t.bedId} is not null`),
  index('hosp_assignments_loc_date_idx').on(t.locationId, t.date),
]);

/** Append-only folio. Charges are positive; payments negative; refunds positive. Balance = sum. */
export const hospFolioLines = pgTable('hosp_folio_lines', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  reservationId: uuid('reservation_id').notNull().references(() => hospReservations.id, { onDelete: 'cascade' }),
  /** room | tax | extra | outlet | fee | payment | refund | adjustment */
  kind: text('kind').notNull(),
  description: text('description').notNull(),
  serviceDate: date('service_date'),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  /** card_online | card_terminal | cash | bank_transfer (payments) */
  method: text('method'),
  sourceType: text('source_type'),
  sourceId: text('source_id'),
  reversesId: uuid('reverses_id'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [
  index('hosp_folio_res_idx').on(t.reservationId),
  uniqueIndex('hosp_folio_source_uq').on(t.kind, t.sourceType, t.sourceId).where(sql`${t.sourceId} is not null`),
]);

export const hospHkTasks = pgTable('hosp_hk_tasks', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  roomId: uuid('room_id').notNull().references(() => hospRooms.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  /** departure_clean | stayover | inspection | maintenance | turndown */
  kind: text('kind').notNull(),
  /** todo | in_progress | done | cancelled */
  status: text('status').notNull().default('todo'),
  priority: integer('priority').notNull().default(0),
  assigneeUserId: uuid('assignee_user_id'),
  reservationId: uuid('reservation_id'),
  notes: text('notes'),
  createdBy: uuid('created_by'),
  completedBy: uuid('completed_by'),
  completedAt: ts('completed_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('hosp_hk_tasks_loc_date_idx').on(t.locationId, t.date),
  uniqueIndex('hosp_hk_tasks_generated_uq').on(t.roomId, t.date, t.kind).where(sql`${t.kind} <> 'maintenance'`),
]);

export const hospMessageLog = pgTable('hosp_message_log', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id'),
  reservationId: uuid('reservation_id'),
  kind: text('kind').notNull(),
  channel: text('channel').notNull(),
  status: text('status').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('hosp_message_dedupe_uq').on(t.organizationId, t.dedupeKey)]);

/** Sandbox channel-manager exports (nothing is sent). */
export const hospChannelExports = pgTable('hosp_channel_exports', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  provider: text('provider').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<unknown>().notNull(),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

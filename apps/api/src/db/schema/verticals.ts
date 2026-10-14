import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid, date } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';
import { customers } from './crm.ts';

const loc = () => uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' });
const org = () => orgId().references(() => organizations.id, { onDelete: 'cascade' });

// ───────────── Studios ─────────────
export const classTypes = pgTable('class_types', {
  id: pk(),
  organizationId: org(),
  /** null = network-wide class type defined by HQ */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  durationMinutes: integer('duration_minutes').notNull(),
  defaultCapacity: integer('default_capacity').notNull(),
  creditCost: integer('credit_cost').notNull().default(1),
  createdAt: createdAt(),
});

export const classOccurrences = pgTable('class_occurrences', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  classTypeId: uuid('class_type_id').notNull().references(() => classTypes.id, { onDelete: 'cascade' }),
  seriesId: uuid('series_id'),
  instructorUserId: uuid('instructor_user_id'),
  instructorName: text('instructor_name'),
  room: text('room'),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  capacity: integer('capacity').notNull(),
  priceMinor: minor('price_minor').notNull().default(0),
  currency: currencyCol().notNull(),
  status: text('status').notNull().default('scheduled'), // scheduled | cancelled
  online: boolean('online').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [index('class_occ_loc_start_idx').on(t.locationId, t.startsAt)]);

export const classBookings = pgTable('class_bookings', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  occurrenceId: uuid('occurrence_id').notNull().references(() => classOccurrences.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  /** held | confirmed | cancelled | expired | attended | no_show */
  status: text('status').notNull(),
  holdExpiresAt: ts('hold_expires_at'),
  source: text('source').notNull().default('web'),
  packId: uuid('pack_id'),
  paymentId: uuid('payment_id'),
  manageTokenHash: text('manage_token_hash'),
  confirmedAt: ts('confirmed_at'),
  cancelledAt: ts('cancelled_at'),
  createdAt: createdAt(),
}, (t) => [
  index('class_bookings_occ_idx').on(t.occurrenceId),
  // Prevents duplicate active bookings for the same customer on the same occurrence.
  uniqueIndex('class_bookings_active_uq').on(t.occurrenceId, t.customerId).where(sql`status in ('held','confirmed')`),
]);

export const waitlistEntries = pgTable('waitlist_entries', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  occurrenceId: uuid('occurrence_id').notNull().references(() => classOccurrences.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('waiting'), // waiting | offered | promoted | removed | expired | left
  offeredBookingId: uuid('offered_booking_id'),
  /** Lets a guest leave the waitlist from the confirmation link without an account. */
  manageTokenHash: text('manage_token_hash'),
  leftAt: ts('left_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('waitlist_active_uq').on(t.occurrenceId, t.customerId).where(sql`status in ('waiting','offered')`)]);

export const packs = pgTable('packs', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id'),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  creditsTotal: integer('credits_total').notNull(),
  creditsRemaining: integer('credits_remaining').notNull(),
  expiresAt: ts('expires_at'),
  crossLocation: boolean('cross_location').notNull().default(false),
  priceMinor: minor('price_minor'),
  currency: currencyCol(),
  createdAt: createdAt(),
});

export const memberships = pgTable('memberships', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id'),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  plan: text('plan').notNull(),
  status: text('status').notNull().default('active'), // active | paused | past_due | cancelled
  crossLocation: boolean('cross_location').notNull().default(false),
  priceMinor: minor('price_minor'),
  currency: currencyCol(),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at'),
  createdAt: createdAt(),
});

export const coverRequests = pgTable('cover_requests', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  occurrenceId: uuid('occurrence_id').notNull().references(() => classOccurrences.id, { onDelete: 'cascade' }),
  requestedBy: uuid('requested_by').notNull(),
  reason: text('reason'),
  /** open | accepted | approved | declined | cancelled */
  status: text('status').notNull().default('open'),
  substituteUserId: uuid('substitute_user_id'),
  substituteName: text('substitute_name'),
  requiresApproval: boolean('requires_approval').notNull().default(true),
  approvedBy: uuid('approved_by'),
  history: jsonb('history').$type<Array<{ at: string; by: string | null; action: string; note?: string }>>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ───────────── Sports ─────────────
export const programmes = pgTable('programmes', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  name: text('name').notNull(),
  description: text('description'),
  ageMin: integer('age_min'),
  ageMax: integer('age_max'),
  /** Date at which age eligibility is evaluated. */
  ageCutoffDate: date('age_cutoff_date'),
  capacity: integer('capacity'),
  feeMinor: minor('fee_minor').notNull().default(0),
  currency: currencyCol().notNull(),
  requiresApproval: boolean('requires_approval').notNull().default(true),
  refundPolicy: text('refund_policy'),
  registrationOpensAt: ts('registration_opens_at'),
  registrationClosesAt: ts('registration_closes_at'),
  status: text('status').notNull().default('draft'), // draft | published | closed | archived
  /** Season this programme belongs to (season → programmes). Legacy programmes may have none. */
  seasonId: uuid('season_id'),
  kind: text('kind').notNull().default('programme'), // programme | camp | academy | league
  /** age_on_date: age measured on ageCutoffDate. birth_year: U-age = year(ageCutoffDate) − birth year. */
  ageRule: text('age_rule').notNull().default('age_on_date'),
  /** Free-text eligibility criteria shown before registration (never inferred ability). */
  eligibilityNotes: text('eligibility_notes'),
  venueIds: jsonb('venue_ids').$type<string[]>().notNull().default([]),
  /** Discount for the 2nd+ child of the same guardian in the same season, basis points. */
  siblingDiscountBps: integer('sibling_discount_bps').notNull().default(0),
  registrationFormId: uuid('registration_form_id'),
  refundPolicyVersion: text('refund_policy_version'),
  /** Minutes a place is held while the first payment completes. */
  holdMinutes: integer('hold_minutes').notNull().default(30),
  createdAt: createdAt(),
});

export const seasons = pgTable('seasons', {
  id: pk(),
  organizationId: org(),
  /** Legacy per-programme season. New seasons are location-level parents of programmes. */
  programmeId: uuid('programme_id').references(() => programmes.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  /** Default age rule + cutoff for the season's programmes (country convention, configurable). */
  ageRule: text('age_rule'),
  ageCutoffDate: date('age_cutoff_date'),
  status: text('status').notNull().default('draft'), // draft | published | archived
  createdAt: createdAt(),
});

export const teams = pgTable('teams', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  programmeId: uuid('programme_id').notNull().references(() => programmes.id, { onDelete: 'cascade' }),
  seasonId: uuid('season_id'),
  name: text('name').notNull(),
  coachUserId: uuid('coach_user_id'),
  capacity: integer('capacity'),
  kind: text('kind').notNull().default('team'), // team | group | squad
  homeVenueId: uuid('home_venue_id'),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
});

export const registrations = pgTable('registrations', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  programmeId: uuid('programme_id').notNull().references(() => programmes.id, { onDelete: 'cascade' }),
  participantCustomerId: uuid('participant_customer_id').notNull().references(() => customers.id),
  guardianCustomerId: uuid('guardian_customer_id').references(() => customers.id),
  /** submitted | awaiting_review | accepted | waitlisted | withdrawn | rejected */
  status: text('status').notNull().default('submitted'),
  teamId: uuid('team_id'),
  paymentId: uuid('payment_id'),
  forms: jsonb('forms').$type<Record<string, unknown>>().notNull().default({}),
  reviewedBy: uuid('reviewed_by'),
  reviewNote: text('review_note'),
  /** full | instalments */
  paymentPlan: text('payment_plan').notNull().default('full'),
  feePlanId: uuid('fee_plan_id'),
  /** Programme fee at registration, discounts/aid/waivers (sports_fee_adjustments) and the resulting total. */
  listFeeMinor: minor('list_fee_minor').notNull().default(0),
  totalFeeMinor: minor('total_fee_minor').notNull().default(0),
  currency: currencyCol(),
  /** While `submitted`, the place is held until this time for the first payment. */
  holdExpiresAt: ts('hold_expires_at'),
  refundPolicyAcceptedAt: ts('refund_policy_accepted_at'),
  refundPolicyVersion: text('refund_policy_version'),
  /** Guardian manage token (hash) for retrying payment from the confirmation page. */
  manageTokenHash: text('manage_token_hash'),
  withdrawnAt: ts('withdrawn_at'),
  withdrawalReason: text('withdrawal_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('registrations_active_uq').on(t.programmeId, t.participantCustomerId).where(sql`status not in ('withdrawn','rejected')`)]);

export const trainingSessions = pgTable('training_sessions', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  venue: text('venue'),
  kind: text('kind').notNull().default('training'), // training | fixture
  status: text('status').notNull().default('scheduled'), // scheduled | cancelled
  /** Venue resource (pitch/court). `venue` keeps the display name (away grounds have no resource). */
  venueId: uuid('venue_id'),
  /** Recurring series this session was generated from. */
  seriesId: uuid('series_id'),
  opponent: text('opponent'),
  homeAway: text('home_away'), // home | away | neutral
  competition: text('competition'),
  notes: text('notes'),
  cancelledAt: ts('cancelled_at'),
  cancelReason: text('cancel_reason'),
  createdAt: createdAt(),
});

export const attendance = pgTable('attendance', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  sessionId: uuid('session_id').notNull().references(() => trainingSessions.id, { onDelete: 'cascade' }),
  participantCustomerId: uuid('participant_customer_id').notNull().references(() => customers.id),
  status: text('status').notNull(), // present | absent | late | excused
  note: text('note'),
  /** illness | injury | family | school | travel | other */
  absenceReason: text('absence_reason'),
  /** coach | guardian */
  reportedBy: text('reported_by').notNull().default('coach'),
  guardianNotifiedAt: ts('guardian_notified_at'),
  recordedBy: uuid('recorded_by'),
  recordedAt: ts('recorded_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('attendance_uq').on(t.sessionId, t.participantCustomerId)]);

// ───────────── Wellness ─────────────
export const services = pgTable('services', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  durationMinutes: integer('duration_minutes').notNull(),
  bufferBeforeMinutes: integer('buffer_before_minutes').notNull().default(0),
  bufferAfterMinutes: integer('buffer_after_minutes').notNull().default(0),
  priceMinor: minor('price_minor').notNull().default(0),
  depositMinor: minor('deposit_minor').notNull().default(0),
  currency: currencyCol().notNull(),
  /** If set, a resource of this type (e.g. 'room') must be reserved. */
  requiredResourceType: text('required_resource_type'),
  cancellationPolicy: text('cancellation_policy'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export type WeeklyAvailability = Array<{ weekday: number; start: string; end: string }>;

export const practitioners = pgTable('practitioners', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  userId: uuid('user_id'),
  name: text('name').notNull(),
  serviceIds: jsonb('service_ids').$type<string[]>().notNull().default([]),
  /** Weekly windows in the location's local time (weekday 0=Sunday). */
  availability: jsonb('availability').$type<WeeklyAvailability>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const resources = pgTable('resources', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  name: text('name').notNull(),
  type: text('type').notNull().default('room'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

/**
 * Appointment reservations. Exclusion constraints (added in a custom migration) guarantee that a
 * practitioner and a resource can never hold two overlapping confirmed reservations.
 */
export const appointments = pgTable('appointments', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  serviceId: uuid('service_id').notNull().references(() => services.id),
  practitionerId: uuid('practitioner_id').notNull().references(() => practitioners.id),
  resourceId: uuid('resource_id').references(() => resources.id),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  /** Reservation window including buffers. */
  blockedFrom: ts('blocked_from').notNull(),
  blockedUntil: ts('blocked_until').notNull(),
  /** confirmed | cancelled | rescheduled | completed | no_show */
  status: text('status').notNull().default('confirmed'),
  rescheduledFromId: uuid('rescheduled_from_id'),
  rescheduledToId: uuid('rescheduled_to_id'),
  priceMinor: minor('price_minor').notNull().default(0),
  currency: currencyCol().notNull(),
  paymentId: uuid('payment_id'),
  manageTokenHash: text('manage_token_hash'),
  adminNotes: text('admin_notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('appointments_loc_start_idx').on(t.locationId, t.startsAt)]);

// ───────────── Commerce ─────────────
export const products = pgTable('products', {
  id: pk(),
  organizationId: org(),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('draft'), // draft | active | archived
  /** Fields locations may not change. */
  lockedFields: jsonb('locked_fields').$type<string[]>().notNull().default(['name', 'description', 'sku']),
  images: jsonb('images').$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('products_org_sku_uq').on(t.organizationId, t.sku)]);

export const variants = pgTable('variants', {
  id: pk(),
  organizationId: org(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  options: jsonb('options').$type<Record<string, string>>().notNull().default({}),
  /** HQ list price per currency, minor units: { "USD": 2500, "CAD": 3300 } */
  prices: jsonb('prices').$type<Record<string, number>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('variants_org_sku_uq').on(t.organizationId, t.sku)]);

export const locationVariants = pgTable('location_variants', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  variantId: uuid('variant_id').notNull().references(() => variants.id, { onDelete: 'cascade' }),
  priceMinor: minor('price_minor'),
  currency: currencyCol(),
  available: boolean('available').notNull().default(true),
  /** Cached; authoritative history lives in stock_movements. */
  stockOnHand: integer('stock_on_hand').notNull().default(0),
  /** Units held for unpaid orders. Reservations never change on-hand stock. */
  reserved: integer('reserved').notNull().default(0),
  reorderPoint: integer('reorder_point'),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('location_variants_uq').on(t.locationId, t.variantId)]);

export const stockMovements = pgTable('stock_movements', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  variantId: uuid('variant_id').notNull().references(() => variants.id, { onDelete: 'cascade' }),
  quantity: integer('quantity').notNull(),
  /** adjustment | count | sale | return | reservation | release | transfer_in | transfer_out | damage */
  reason: text('reason').notNull(),
  reference: text('reference'),
  note: text('note'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('stock_movements_loc_variant_idx').on(t.locationId, t.variantId)]);

export const orders = pgTable('orders', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  customerId: uuid('customer_id'),
  source: text('source').notNull().default('native'), // native | woocommerce | shopify | square
  externalId: text('external_id'),
  /** pending_payment | paid | fulfilled | cancelled | refunded | partially_refunded */
  status: text('status').notNull().default('pending_payment'),
  fulfilmentStatus: text('fulfilment_status').notNull().default('unfulfilled'),
  fulfilmentMethod: text('fulfilment_method').notNull().default('pickup'),
  currency: currencyCol().notNull(),
  subtotalMinor: minor('subtotal_minor').notNull(),
  taxMinor: minor('tax_minor').notNull().default(0),
  discountMinor: minor('discount_minor').notNull().default(0),
  totalMinor: minor('total_minor').notNull(),
  refundedMinor: minor('refunded_minor').notNull().default(0),
  paymentId: uuid('payment_id'),
  lines: jsonb('lines').$type<Array<{ variantId: string; sku: string; name: string; quantity: number; unitPriceMinor: number }>>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('orders_source_ext_uq').on(t.organizationId, t.source, t.externalId)]);

export const returns = pgTable('returns', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  /** requested | reviewed | authorised | received | resolved | rejected */
  status: text('status').notNull().default('requested'),
  lines: jsonb('lines').$type<Array<{ variantId: string; quantity: number }>>().notNull().default([]),
  reason: text('reason'),
  refundId: uuid('refund_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ───────────── Foods ─────────────
export const menus = pgTable('menus', {
  id: pk(),
  organizationId: org(),
  name: text('name').notNull(),
  status: text('status').notNull().default('draft'), // draft | published | archived
  publishedAt: ts('published_at'),
  createdAt: createdAt(),
});

export const menuItems = pgTable('menu_items', {
  id: pk(),
  organizationId: org(),
  menuId: uuid('menu_id').notNull().references(() => menus.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  /** HQ prices per currency, minor units. A location without a price in its currency cannot sell the item. */
  prices: jsonb('prices').$type<Record<string, number>>().notNull().default({}),
  /** Business-supplied dietary/allergen details. Never inferred by AI. */
  dietary: jsonb('dietary').$type<string[]>().notNull().default([]),
  allergens: jsonb('allergens').$type<string[]>().notNull().default([]),
  imageUrl: text('image_url'),
  /** Which fields locations may override: subset of ['price','available','description']. */
  localOverridable: jsonb('local_overridable').$type<string[]>().notNull().default(['price', 'available']),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const modifierGroups = pgTable('modifier_groups', {
  id: pk(),
  organizationId: org(),
  menuItemId: uuid('menu_item_id').notNull().references(() => menuItems.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  minSelect: integer('min_select').notNull().default(0),
  maxSelect: integer('max_select').notNull().default(1),
  createdAt: createdAt(),
});

export const modifiers = pgTable('modifiers', {
  id: pk(),
  organizationId: org(),
  groupId: uuid('group_id').notNull().references(() => modifierGroups.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prices: jsonb('prices').$type<Record<string, number>>().notNull().default({}),
  available: boolean('available').notNull().default(true),
  createdAt: createdAt(),
});

export const locationMenuOverrides = pgTable('location_menu_overrides', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  menuItemId: uuid('menu_item_id').notNull().references(() => menuItems.id, { onDelete: 'cascade' }),
  modifierId: uuid('modifier_id'),
  priceMinor: minor('price_minor'),
  available: boolean('available'),
  soldOut: boolean('sold_out').notNull().default(false),
  soldOutUntil: ts('sold_out_until'),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
}, (t) => [unique('location_menu_overrides_uq').on(t.locationId, t.menuItemId, t.modifierId).nullsNotDistinct()]);

export const pickupSlots = pgTable('pickup_slots', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  capacity: integer('capacity').notNull(),
  booked: integer('booked').notNull().default(0),
  /** Orders for this slot must be placed before this time. */
  cutoffAt: ts('cutoff_at').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('pickup_slots_uq').on(t.locationId, t.startsAt)]);

export type FoodOrderLine = { menuItemId: string; name: string; quantity: number; unitPriceMinor: number; modifiers: Array<{ id: string; name: string; priceMinor: number }>; lineTotalMinor: number; notes?: string };

export const foodOrders = pgTable('food_orders', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  customerId: uuid('customer_id'),
  pickupSlotId: uuid('pickup_slot_id').references(() => pickupSlots.id),
  orderNumber: text('order_number').notNull(),
  /** awaiting_acceptance | accepted | preparing | ready | collected | cancelled | rejected */
  status: text('status').notNull().default('awaiting_acceptance'),
  /** not_required | pending | paid | refund_pending | refunded | voided */
  paymentStatus: text('payment_status').notNull().default('pending'),
  lines: jsonb('lines').$type<FoodOrderLine[]>().notNull(),
  subtotalMinor: minor('subtotal_minor').notNull(),
  taxMinor: minor('tax_minor').notNull().default(0),
  serviceChargeMinor: minor('service_charge_minor').notNull().default(0),
  totalMinor: minor('total_minor').notNull(),
  currency: currencyCol().notNull(),
  paymentId: uuid('payment_id'),
  contact: jsonb('contact').$type<{ name: string; email?: string; phone?: string }>().notNull(),
  notes: text('notes'),
  promisedAt: ts('promised_at'),
  rejectionReason: text('rejection_reason'),
  statusHistory: jsonb('status_history').$type<Array<{ at: string; from: string | null; to: string; by: string | null; note?: string }>>().notNull().default([]),
  manageTokenHash: text('manage_token_hash'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('food_orders_loc_status_idx').on(t.locationId, t.status)]);

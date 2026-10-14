/**
 * Foods — full product (subsequent scope): menu structure, day-parts, publish results, delivery, dine-in,
 * preorders & catering, meal plans, kitchen stations, delivery handoff and ingredient inventory.
 * Core foods tables (menus, items, modifiers, overrides, pickup slots, orders) live in verticals.ts.
 */
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';
import { foodOrders, menuItems, menus, modifiers } from './verticals.ts';

const loc = () => uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' });
const org = () => orgId().references(() => organizations.id, { onDelete: 'cascade' });
type Translations = Record<string, { name?: string; description?: string }>;
export type DayPartWindow = { weekday: number; start: string; end: string };

// ───────────── Menu structure ─────────────

export const foodMenuCategories = pgTable('food_menu_categories', {
  id: pk(),
  organizationId: org(),
  menuId: uuid('menu_id').notNull().references(() => menus.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  translations: jsonb('translations').$type<Translations>().notNull().default({}),
  dayPartIds: jsonb('day_part_ids').$type<string[]>().notNull().default([]),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [unique('food_menu_categories_uq').on(t.menuId, t.name)]);

/** Breakfast / lunch / dinner windows in each location's local wall time (weekday 0 = Sunday). */
export const foodDayParts = pgTable('food_day_parts', {
  id: pk(),
  organizationId: org(),
  name: text('name').notNull(),
  translations: jsonb('translations').$type<Translations>().notNull().default({}),
  windows: jsonb('windows').$type<DayPartWindow[]>().notNull().default([]),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [unique('food_day_parts_uq').on(t.organizationId, t.name)]);

/** Per-location result of an HQ menu publish (succeeded | partial | failed | skipped). */
export const foodMenuPublications = pgTable('food_menu_publications', {
  id: pk(),
  organizationId: org(),
  menuId: uuid('menu_id').notNull().references(() => menus.id, { onDelete: 'cascade' }),
  locationId: loc(),
  status: text('status').notNull(),
  detail: jsonb('detail').$type<{ available: number; unavailable: Array<{ id: string; name: string; reason: string | null }>; reason?: string }>().notNull(),
  publishedBy: uuid('published_by'),
  publishedAt: ts('published_at').notNull().defaultNow(),
}, (t) => [index('food_menu_publications_idx').on(t.menuId, t.locationId, t.publishedAt)]);

/** History of sold-out periods (manual, ingredient-driven) for the sold-out frequency report. */
export const foodSoldOutEvents = pgTable('food_sold_out_events', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  menuItemId: uuid('menu_item_id').references(() => menuItems.id, { onDelete: 'cascade' }),
  modifierId: uuid('modifier_id').references(() => modifiers.id, { onDelete: 'cascade' }),
  /** manual | ingredient */
  source: text('source').notNull(),
  startedAt: ts('started_at').notNull().defaultNow(),
  endedAt: ts('ended_at'),
  createdBy: uuid('created_by'),
}, (t) => [index('food_sold_out_events_idx').on(t.locationId, t.startedAt)]);

// ───────────── Location ordering settings ─────────────

export interface FoodLocationConfig {
  channels: { pickup: boolean; delivery: boolean; dineIn: boolean; preorder: boolean; catering: boolean; mealPlans: boolean };
  tips: { enabled: boolean; presetsBps: number[]; allowCustom: boolean; channels: string[] };
  serviceCharge: { bps: number; label: string; channels: string[] };
  /** null = default for the location's country (see defaultAllergenRegime). */
  allergenRegime: string | null;
  delivery: { provider: 'own' | 'uber_direct' | 'deliverect'; hours: Array<{ weekday: number; open: string; close: string }>; slotMinutes: number; slotCapacity: number; leadMinutes: number; cutoffMinutes: number; horizonDays: number };
  kds: { audibleDefault: boolean; defaultPrepMinutes: number };
  autoSoldOutOnIngredients: boolean;
}

export const foodLocationSettings = pgTable('food_location_settings', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id').notNull().unique().references(() => locations.id, { onDelete: 'cascade' }),
  config: jsonb('config').$type<FoodLocationConfig>().notNull(),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ───────────── Delivery ─────────────

export const foodDeliveryZones = pgTable('food_delivery_zones', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  name: text('name').notNull(),
  /** radius (metres from the location) | postcode (prefix match, normalised) */
  kind: text('kind').notNull(),
  radiusMeters: integer('radius_meters'),
  postcodes: jsonb('postcodes').$type<string[]>().notNull().default([]),
  feeMinor: minor('fee_minor').notNull().default(0),
  minimumOrderMinor: minor('minimum_order_minor').notNull().default(0),
  freeDeliveryAboveMinor: minor('free_delivery_above_minor'),
  currency: currencyCol().notNull(),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('food_delivery_zones_loc_idx').on(t.locationId)]);

export const foodDeliverySlots = pgTable('food_delivery_slots', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  capacity: integer('capacity').notNull(),
  booked: integer('booked').notNull().default(0),
  cutoffAt: ts('cutoff_at').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('food_delivery_slots_uq').on(t.locationId, t.startsAt)]);

export const foodDrivers = pgTable('food_drivers', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  userId: uuid('user_id'),
  name: text('name').notNull(),
  phone: text('phone'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

/** Delivery handoff: own drivers or a provider (Uber Direct / Deliverect adapters). */
export const foodDeliveries = pgTable('food_deliveries', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  orderId: uuid('order_id').notNull().unique().references(() => foodOrders.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('own'),
  driverId: uuid('driver_id').references(() => foodDrivers.id, { onDelete: 'set null' }),
  externalId: text('external_id'),
  /** pending | assigned | picked_up | delivered | failed | cancelled */
  status: text('status').notNull().default('pending'),
  trackingUrl: text('tracking_url'),
  feeQuoteMinor: minor('fee_quote_minor'),
  currency: currencyCol().notNull(),
  sandbox: boolean('sandbox').notNull().default(false),
  events: jsonb('events').$type<Array<{ at: string; status: string; by: string | null; note?: string }>>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ───────────── Dine-in ─────────────

export const foodTables = pgTable('food_tables', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  label: text('label').notNull(),
  /** Short code printed in the table's QR link. */
  code: text('code').notNull().unique(),
  seats: integer('seats').notNull().default(2),
  area: text('area'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [unique('food_tables_label_uq').on(t.locationId, t.label)]);

export const foodTabs = pgTable('food_tabs', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  tableId: uuid('table_id').notNull().references(() => foodTables.id, { onDelete: 'cascade' }),
  /** open | paid | closed_unpaid | void */
  status: text('status').notNull().default('open'),
  guestName: text('guest_name'),
  tokenHash: text('token_hash').notNull(),
  currency: currencyCol().notNull(),
  tipMinor: minor('tip_minor').notNull().default(0),
  paymentId: uuid('payment_id'),
  /** online | counter */
  paidVia: text('paid_via'),
  openedAt: ts('opened_at').notNull().defaultNow(),
  closedAt: ts('closed_at'),
}, (t) => [uniqueIndex('food_tabs_one_open').on(t.tableId).where(sql`${t.status} = 'open'`)]);

// ───────────── Kitchen ─────────────

export const foodStations = pgTable('food_stations', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  prepTargetMinutes: integer('prep_target_minutes').notNull().default(12),
  /** The expo/pass station sees every order and marks it ready once all stations are done. */
  isExpo: boolean('is_expo').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [unique('food_stations_uq').on(t.locationId, t.key)]);

export const foodKdsTickets = pgTable('food_kds_tickets', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  orderId: uuid('order_id').notNull().references(() => foodOrders.id, { onDelete: 'cascade' }),
  stationId: uuid('station_id').notNull().references(() => foodStations.id, { onDelete: 'cascade' }),
  /** Snapshot of the order lines routed to this station. */
  lines: jsonb('lines').$type<Array<{ index: number; name: string; quantity: number; modifiers: string[]; notes?: string }>>().notNull(),
  /** queued | in_progress | done */
  status: text('status').notNull().default('queued'),
  targetAt: ts('target_at').notNull(),
  startedAt: ts('started_at'),
  bumpedAt: ts('bumped_at'),
  recalledCount: integer('recalled_count').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [unique('food_kds_tickets_uq').on(t.orderId, t.stationId), index('food_kds_tickets_station_idx').on(t.stationId, t.status)]);

// ───────────── Preorders & catering ─────────────

/** A cooking/collection date customers can preorder for, with its cut-off and capacity. */
export const foodProductionDates = pgTable('food_production_dates', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  /** Local date YYYY-MM-DD in the location's time zone. */
  date: text('date').notNull(),
  menuId: uuid('menu_id').references(() => menus.id, { onDelete: 'set null' }),
  cutoffAt: ts('cutoff_at').notNull(),
  /** Local collection windows, e.g. ["09:00-12:00", "14:00-17:00"]. */
  collectionWindows: jsonb('collection_windows').$type<string[]>().notNull().default([]),
  capacity: integer('capacity').notNull(),
  booked: integer('booked').notNull().default(0),
  /** open | closed */
  status: text('status').notNull().default('open'),
  note: text('note'),
  createdAt: createdAt(),
}, (t) => [unique('food_production_dates_uq').on(t.locationId, t.date)]);

export const foodCateringPackages = pgTable('food_catering_packages', {
  id: pk(),
  organizationId: org(),
  name: text('name').notNull(),
  description: text('description'),
  translations: jsonb('translations').$type<Translations>().notNull().default({}),
  /** Price per guest per currency (minor units). */
  pricesPerGuest: jsonb('prices_per_guest').$type<Record<string, number>>().notNull().default({}),
  minGuests: integer('min_guests').notNull().default(10),
  maxGuests: integer('max_guests'),
  leadDays: integer('lead_days').notNull().default(3),
  includes: jsonb('includes').$type<string[]>().notNull().default([]),
  dietary: jsonb('dietary').$type<string[]>().notNull().default([]),
  allergens: jsonb('allergens').$type<string[]>().notNull().default([]),
  allergensDeclared: boolean('allergens_declared').notNull().default(false),
  /** Empty = every location. */
  locationIds: jsonb('location_ids').$type<string[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
});

export type CateringQuote = {
  version: number;
  lines: Array<{ description: string; menuItemId?: string | null; quantity: number; unitPriceMinor: number; totalMinor: number }>;
  subtotalMinor: number; serviceChargeMinor: number; deliveryFeeMinor: number; taxMinor: number; taxRateBps: number; totalMinor: number;
  depositMinor: number; currency: string; validUntil: string; terms: string | null; sentAt: string; sentBy: string | null;
};

export const foodCateringEnquiries = pgTable('food_catering_enquiries', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  customerId: uuid('customer_id'),
  reference: text('reference').notNull(),
  contact: jsonb('contact').$type<{ name: string; email: string; phone?: string }>().notNull(),
  eventDate: text('event_date').notNull(),
  eventTime: text('event_time'),
  guests: integer('guests').notNull(),
  packageId: uuid('package_id').references(() => foodCateringPackages.id, { onDelete: 'set null' }),
  fulfilment: text('fulfilment').notNull().default('pickup'),
  address: jsonb('address').$type<Record<string, unknown> | null>(),
  notes: text('notes'),
  dietaryNotes: text('dietary_notes'),
  /** new | quoted | accepted | deposit_paid | confirmed | completed | declined | cancelled | expired */
  status: text('status').notNull().default('new'),
  quote: jsonb('quote').$type<CateringQuote | null>(),
  currency: currencyCol().notNull(),
  depositPaymentId: uuid('deposit_payment_id'),
  acceptedAt: ts('accepted_at'),
  depositPaidAt: ts('deposit_paid_at'),
  confirmedAt: ts('confirmed_at'),
  declinedReason: text('declined_reason'),
  tokenHash: text('token_hash').notNull(),
  statusHistory: jsonb('status_history').$type<Array<{ at: string; from: string | null; to: string; by: string | null; note?: string }>>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('food_catering_enquiries_idx').on(t.organizationId, t.status, t.eventDate)]);

// ───────────── Meal plans ─────────────

export const foodMealPlans = pgTable('food_meal_plans', {
  id: pk(),
  organizationId: org(),
  name: text('name').notNull(),
  description: text('description'),
  translations: jsonb('translations').$type<Translations>().notNull().default({}),
  mealsPerBox: integer('meals_per_box').notNull().default(5),
  pricesPerWeek: jsonb('prices_per_week').$type<Record<string, number>>().notNull().default({}),
  /** pickup | delivery */
  fulfilment: text('fulfilment').notNull().default('pickup'),
  /** Local weekday the box is collected/delivered (0 = Sunday). */
  fulfilmentWeekday: integer('fulfilment_weekday').notNull().default(1),
  /** Changes and skips close this many days before fulfilment, at cutoffTime (local). */
  cutoffDaysBefore: integer('cutoff_days_before').notNull().default(3),
  cutoffTime: text('cutoff_time').notNull().default('18:00'),
  menuItemIds: jsonb('menu_item_ids').$type<string[]>().notNull().default([]),
  locationIds: jsonb('location_ids').$type<string[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const foodMealPlanSubscriptions = pgTable('food_meal_plan_subscriptions', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  planId: uuid('plan_id').notNull().references(() => foodMealPlans.id, { onDelete: 'restrict' }),
  customerId: uuid('customer_id'),
  contact: jsonb('contact').$type<{ name: string; email: string; phone?: string }>().notNull(),
  /** pending_payment | active | paused | past_due | cancelled */
  status: text('status').notNull().default('pending_payment'),
  provider: text('provider').notNull().default('stripe'),
  externalId: text('external_id'),
  sandbox: boolean('sandbox').notNull().default(false),
  priceMinor: minor('price_minor').notNull(),
  currency: currencyCol().notNull(),
  /** Monday (YYYY-MM-DD) of the first box week. */
  startWeek: text('start_week').notNull(),
  skippedWeeks: jsonb('skipped_weeks').$type<string[]>().notNull().default([]),
  address: jsonb('address').$type<Record<string, unknown> | null>(),
  zoneId: uuid('zone_id'),
  tokenHash: text('token_hash').notNull(),
  cancelledAt: ts('cancelled_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('food_meal_plan_subs_idx').on(t.organizationId, t.status)]);

export const foodMealPlanBoxes = pgTable('food_meal_plan_boxes', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  subscriptionId: uuid('subscription_id').notNull().references(() => foodMealPlanSubscriptions.id, { onDelete: 'cascade' }),
  weekStart: text('week_start').notNull(),
  fulfilmentDate: text('fulfilment_date').notNull(),
  /** scheduled | skipped | in_production | fulfilled | cancelled */
  status: text('status').notNull().default('scheduled'),
  foodOrderId: uuid('food_order_id'),
  items: jsonb('items').$type<Array<{ menuItemId: string; name: string; quantity: number }>>().notNull().default([]),
  createdAt: createdAt(),
}, (t) => [unique('food_meal_plan_boxes_uq').on(t.subscriptionId, t.weekStart)]);

// ───────────── Ingredient inventory ─────────────

export const foodIngredients = pgTable('food_ingredients', {
  id: pk(),
  organizationId: org(),
  name: text('name').notNull(),
  /** g | ml | each — quantities are integers in this unit. */
  unit: text('unit').notNull(),
  sku: text('sku'),
  createdAt: createdAt(),
}, (t) => [unique('food_ingredients_uq').on(t.organizationId, t.name)]);

export const foodIngredientStock = pgTable('food_ingredient_stock', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  ingredientId: uuid('ingredient_id').notNull().references(() => foodIngredients.id, { onDelete: 'cascade' }),
  onHand: integer('on_hand').notNull().default(0),
  lowStockThreshold: integer('low_stock_threshold').notNull().default(0),
  /** When on hand cannot cover one portion, items using it show as sold out at this location. */
  autoSoldOut: boolean('auto_sold_out').notNull().default(false),
  updatedAt: updatedAt(),
}, (t) => [unique('food_ingredient_stock_uq').on(t.locationId, t.ingredientId)]);

/** Recipe: ingredient quantity per portion of a menu item (or added by a modifier). */
export const foodRecipeLines = pgTable('food_recipe_lines', {
  id: pk(),
  organizationId: org(),
  menuItemId: uuid('menu_item_id').notNull().references(() => menuItems.id, { onDelete: 'cascade' }),
  modifierId: uuid('modifier_id').references(() => modifiers.id, { onDelete: 'cascade' }),
  ingredientId: uuid('ingredient_id').notNull().references(() => foodIngredients.id, { onDelete: 'cascade' }),
  quantity: integer('quantity').notNull(),
}, (t) => [unique('food_recipe_lines_uq').on(t.menuItemId, t.modifierId, t.ingredientId).nullsNotDistinct()]);

export const foodIngredientMovements = pgTable('food_ingredient_movements', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  ingredientId: uuid('ingredient_id').notNull().references(() => foodIngredients.id, { onDelete: 'cascade' }),
  delta: integer('delta').notNull(),
  /** order | order_reversal | receive | waste | count */
  reason: text('reason').notNull(),
  orderId: uuid('order_id'),
  balanceAfter: integer('balance_after').notNull(),
  note: text('note'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('food_ingredient_movements_idx').on(t.locationId, t.ingredientId, t.createdAt)]);

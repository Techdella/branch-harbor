/**
 * Commerce — full product (catalogue distribution, storefront ordering, fulfilment, transfers, counts,
 * purchasing, gift cards / store credit). The base tables (products, variants, location_variants,
 * stock_movements, orders, returns) live in verticals.ts.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';
import { orders, products, variants } from './verticals.ts';

const org = () => orgId().references(() => organizations.id, { onDelete: 'cascade' });
const loc = (name = 'location_id') => uuid(name).notNull().references(() => locations.id, { onDelete: 'cascade' });

// ───────── Master catalogue ─────────

export const productImages = pgTable('product_images', {
  id: pk(),
  organizationId: org(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id').references(() => variants.id, { onDelete: 'set null' }),
  url: text('url').notNull(),
  alt: text('alt').notNull().default(''),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('product_images_product_idx').on(t.productId)]);

/** Per-locale content for products, variants and collections (HQ-owned; locations cannot edit). */
export const commerceTranslations = pgTable('commerce_translations', {
  id: pk(),
  organizationId: org(),
  /** product | variant | collection */
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  locale: text('locale').notNull(),
  fields: jsonb('fields').$type<{ name?: string; description?: string; title?: string }>().notNull().default({}),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('commerce_translations_uq').on(t.entityType, t.entityId, t.locale)]);

export const collections = pgTable('collections', {
  id: pk(),
  organizationId: org(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  imageUrl: text('image_url'),
  /** draft | active */
  status: text('status').notNull().default('active'),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('collections_org_slug_uq').on(t.organizationId, t.slug)]);

export const collectionProducts = pgTable('collection_products', {
  collectionId: uuid('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.collectionId, t.productId] })]);

export interface ListingSnapshot {
  name: string; description: string | null; slug: string | null; vendor: string | null; productType: string | null;
  options: Array<{ name: string; values: string[] }>; specs: Record<string, string>; tags: string[];
  images: Array<{ url: string; alt: string; variantId: string | null }>;
  variants: Array<{ id: string; sku: string; name: string; options: Record<string, string>; imageUrl: string | null }>;
  translations: Record<string, { name?: string; description?: string }>;
  variantTranslations: Record<string, Record<string, { name?: string }>>;
}

/** What a location actually lists, and which master content version it was distributed with. */
export const locationListings = pgTable('location_listings', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  /** listed | delisted */
  status: text('status').notNull().default('listed'),
  contentVersion: integer('content_version').notNull(),
  /** Master content as distributed to this store. The storefront shows this snapshot, never undistributed edits. */
  snapshot: jsonb('snapshot').$type<ListingSnapshot>().notNull(),
  distributionId: uuid('distribution_id'),
  listedAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('location_listings_uq').on(t.locationId, t.productId)]);

export const catalogueDistributions = pgTable('catalogue_distributions', {
  id: pk(),
  organizationId: org(),
  /** completed | partial | failed */
  status: text('status').notNull().default('completed'),
  productIds: jsonb('product_ids').$type<string[]>().notNull(),
  locationIds: jsonb('location_ids').$type<string[]>().notNull(),
  summary: jsonb('summary').$type<{ synced: number; skipped: number; failed: number }>().notNull().default({ synced: 0, skipped: 0, failed: 0 }),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  completedAt: ts('completed_at'),
});

export const distributionResults = pgTable('distribution_results', {
  id: pk(),
  organizationId: org(),
  distributionId: uuid('distribution_id').notNull().references(() => catalogueDistributions.id, { onDelete: 'cascade' }),
  locationId: loc(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  /** synced | skipped | failed */
  status: text('status').notNull(),
  /** list | update | delist | none */
  action: text('action').notNull(),
  message: text('message'),
  changes: jsonb('changes').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index('distribution_results_dist_idx').on(t.distributionId)]);

// ───────── Storefront configuration ─────────

export const fulfilmentSettings = pgTable('commerce_fulfilment_settings', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  /** Customers can order on the hosted storefront (when BranchHarbor is the order system of record). */
  storefrontEnabled: boolean('storefront_enabled').notNull().default(true),
  pickupEnabled: boolean('pickup_enabled').notNull().default(true),
  pickupInstructions: text('pickup_instructions'),
  /** Typical time to have a pickup order ready. */
  pickupReadyMinutes: integer('pickup_ready_minutes').notNull().default(120),
  localDeliveryEnabled: boolean('local_delivery_enabled').notNull().default(false),
  deliveryFeeMinor: minor('delivery_fee_minor').notNull().default(0),
  freeDeliveryOverMinor: minor('free_delivery_over_minor'),
  /** Postcode prefixes served by local delivery (empty = any address in the location's city). */
  deliveryPostcodes: jsonb('delivery_postcodes').$type<string[]>().notNull().default([]),
  shippingEnabled: boolean('shipping_enabled').notNull().default(false),
  shippingFeeMinor: minor('shipping_fee_minor').notNull().default(0),
  shippingCountries: jsonb('shipping_countries').$type<string[]>().notNull().default([]),
  /** Accept "collect here" orders served from other stores' stock (same currency) via transfer. */
  crossLocationPickup: boolean('cross_location_pickup').notNull().default(false),
  /** How long unpaid checkout holds stock; the payment intent is cancelled when it lapses. */
  reservationMinutes: integer('reservation_minutes').notNull().default(15),
  returnWindowDays: integer('return_window_days').notNull().default(30),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('commerce_fulfilment_settings_loc_uq').on(t.locationId)]);

/** Tax rates configured by the business per location. Nothing is assumed when none are configured. */
export const taxRates = pgTable('commerce_tax_rates', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  name: text('name').notNull(),
  rateBps: integer('rate_bps').notNull(),
  /** true: prices already include this tax (shown as "includes"); false: added at checkout. */
  inclusive: boolean('inclusive').notNull().default(false),
  appliesToFulfilment: boolean('applies_to_fulfilment').notNull().default(true),
  active: boolean('active').notNull().default(true),
  position: integer('position').notNull().default(0),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
}, (t) => [check('commerce_tax_rates_bps_ck', sql`${t.rateBps} >= 0 and ${t.rateBps} <= 10000`)]);

// ───────── Fulfilment ─────────

export const orderFulfilments = pgTable('order_fulfilments', {
  id: pk(),
  organizationId: org(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  locationId: loc(),
  /** pickup | local_delivery | shipping */
  method: text('method').notNull(),
  /** picking | packed | ready | shipped | out_for_delivery | delivered | collected | cancelled */
  status: text('status').notNull().default('picking'),
  lines: jsonb('lines').$type<Array<{ variantId: string; sku: string; name: string; quantity: number; picked: number }>>().notNull(),
  carrier: text('carrier'),
  trackingNumber: text('tracking_number'),
  pickedBy: uuid('picked_by'),
  packedBy: uuid('packed_by'),
  completedBy: uuid('completed_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  completedAt: ts('completed_at'),
}, (t) => [index('order_fulfilments_order_idx').on(t.orderId), index('order_fulfilments_loc_status_idx').on(t.locationId, t.status)]);

// ───────── Inventory: transfers, counts, purchasing ─────────

export interface TransferLine { variantId: string; sku: string; name: string; quantity: number; shipped: number; received: number }

export const stockTransfers = pgTable('stock_transfers', {
  id: pk(),
  organizationId: org(),
  number: text('number').notNull(),
  fromLocationId: loc('from_location_id'),
  toLocationId: loc('to_location_id'),
  /** requested | approved | rejected | in_transit | received | cancelled */
  status: text('status').notNull().default('requested'),
  lines: jsonb('lines').$type<TransferLine[]>().notNull(),
  reason: text('reason'),
  /** Set when the transfer serves a customer order collected at the destination. */
  orderId: uuid('order_id'),
  requestedBy: uuid('requested_by'),
  approvedBy: uuid('approved_by'),
  shippedBy: uuid('shipped_by'),
  receivedBy: uuid('received_by'),
  carrier: text('carrier'),
  trackingNumber: text('tracking_number'),
  decisionNote: text('decision_note'),
  receiveNote: text('receive_note'),
  history: jsonb('history').$type<Array<{ at: string; event: string; by?: string | null; note?: string }>>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  shippedAt: ts('shipped_at'),
  receivedAt: ts('received_at'),
}, (t) => [uniqueIndex('stock_transfers_number_uq').on(t.organizationId, t.number), index('stock_transfers_status_idx').on(t.organizationId, t.status)]);

export const stockCounts = pgTable('stock_counts', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  name: text('name').notNull(),
  /** in_progress | submitted | applied | cancelled */
  status: text('status').notNull().default('in_progress'),
  createdBy: uuid('created_by'),
  submittedBy: uuid('submitted_by'),
  appliedBy: uuid('applied_by'),
  createdAt: createdAt(),
  submittedAt: ts('submitted_at'),
  appliedAt: ts('applied_at'),
});

export const stockCountLines = pgTable('stock_count_lines', {
  id: pk(),
  countId: uuid('count_id').notNull().references(() => stockCounts.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id').notNull().references(() => variants.id, { onDelete: 'cascade' }),
  /** On-hand per the ledger when the line was counted (variance = counted − expected). */
  expectedQty: integer('expected_qty'),
  countedQty: integer('counted_qty'),
  countedBy: uuid('counted_by'),
  countedAt: ts('counted_at'),
}, (t) => [uniqueIndex('stock_count_lines_uq').on(t.countId, t.variantId)]);

export const suppliers = pgTable('suppliers', {
  id: pk(),
  organizationId: org(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  currency: currencyCol().notNull(),
  leadTimeDays: integer('lead_time_days'),
  notes: text('notes'),
  createdAt: createdAt(),
});

export interface PurchaseOrderLine { variantId: string; sku: string; name: string; quantity: number; received: number; unitCostMinor: number }

export const purchaseOrders = pgTable('purchase_orders', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'restrict' }),
  number: text('number').notNull(),
  /** draft | sent | partially_received | received | cancelled */
  status: text('status').notNull().default('draft'),
  currency: currencyCol().notNull(),
  lines: jsonb('lines').$type<PurchaseOrderLine[]>().notNull(),
  expectedAt: ts('expected_at'),
  notes: text('notes'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  sentAt: ts('sent_at'),
  receivedAt: ts('received_at'),
}, (t) => [uniqueIndex('purchase_orders_number_uq').on(t.organizationId, t.number)]);

// ───────── Gift cards & store credit ─────────

export const giftCards = pgTable('gift_cards', {
  id: pk(),
  organizationId: org(),
  /** gift_card | store_credit */
  kind: text('kind').notNull(),
  codeHash: text('code_hash').notNull(),
  codeLast4: text('code_last4').notNull(),
  currency: currencyCol().notNull(),
  initialMinor: minor('initial_minor').notNull(),
  balanceMinor: minor('balance_minor').notNull(),
  /** active | disabled */
  status: text('status').notNull().default('active'),
  customerEmail: text('customer_email'),
  issuedAtLocationId: uuid('issued_at_location_id'),
  issuedReason: text('issued_reason'),
  issuedBy: uuid('issued_by'),
  expiresAt: ts('expires_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('gift_cards_code_uq').on(t.codeHash),
  index('gift_cards_email_idx').on(t.organizationId, t.customerEmail),
  check('gift_cards_balance_ck', sql`${t.balanceMinor} >= 0`),
]);

export const giftCardLedger = pgTable('gift_card_ledger', {
  id: pk(),
  organizationId: org(),
  giftCardId: uuid('gift_card_id').notNull().references(() => giftCards.id, { onDelete: 'cascade' }),
  /** issue | redeem | reversal | adjust */
  kind: text('kind').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  balanceAfterMinor: minor('balance_after_minor').notNull(),
  orderId: uuid('order_id'),
  returnId: uuid('return_id'),
  note: text('note'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('gift_card_ledger_card_idx').on(t.giftCardId)]);

/** Human-friendly sequence numbers (order numbers, RMA, transfers, POs) per organisation and scope. */
export const commerceCounters = pgTable('commerce_counters', {
  organizationId: org(),
  scope: text('scope').notNull(),
  value: integer('value').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.organizationId, t.scope] })]);

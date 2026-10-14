/**
 * Partner integrations (delivery partners, POS/marketplace via Deliverect, property portals).
 * Credentials and per-location/office configuration live in the shared `connections` table (encrypted
 * credentials); these tables hold the inbound webhook log (idempotency + audit), the outbound sync log
 * (last push/test result per connection) and portal-only listing fields supplied by the business.
 */
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, orgId, pk, ts, updatedAt } from './_shared.ts';
import { organizations } from './core.ts';
import { connections } from './integrations.ts';
import { realtyListings } from './realty-ext.ts';

/** Every inbound partner webhook we accepted (signature verified). Unique per provider + event key → idempotent. */
export const partnerWebhookEvents = pgTable('partner_webhook_events', {
  id: pk(),
  /** uber_direct | deliverect */
  provider: text('provider').notNull(),
  /** Provider event id, or a derived key (e.g. Deliverect order id + status) when the provider sends none. */
  eventKey: text('event_key').notNull(),
  organizationId: uuid('organization_id'),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  /** processed | ignored | failed */
  outcome: text('outcome').notNull().default('processed'),
  detail: text('detail'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('partner_webhook_events_uq').on(t.provider, t.eventKey)]);

/** Outbound calls to partners (test, quote, create, POS push, menu push, portal send/remove, feed fetches). */
export const partnerSyncLog = pgTable('partner_sync_log', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  locationId: uuid('location_id'),
  /** test | quote | create_delivery | cancel_delivery | pos_push | order_status | menu_push | busy_mode | send_property | remove_property | feed_fetch | feed_build */
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  /** ok | sandbox | error | skipped */
  status: text('status').notNull(),
  httpStatus: integer('http_status'),
  message: text('message'),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index('partner_sync_log_conn_idx').on(t.connectionId, t.createdAt), index('partner_sync_log_org_idx').on(t.organizationId, t.provider, t.createdAt)]);

/**
 * Portal-specific listing facts supplied by the business (never inferred): price qualifier, tenure,
 * council tax band, energy rating, availability date. Feed validation reads these first, then falls back
 * to matching business-supplied disclosures.
 */
export const realtyListingPortalFields = pgTable('realty_listing_portal_fields', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  listingId: uuid('listing_id').notNull().unique().references(() => realtyListings.id, { onDelete: 'cascade' }),
  /** default | poa | guide_price | fixed_price | offers_in_excess_of | oiro | offers_over | from | coming_soon | sale_by_tender */
  priceQualifier: text('price_qualifier'),
  /** freehold | leasehold | share_of_freehold | commonhold | feudal | strata | none */
  tenure: text('tenure'),
  /** UK council tax band A–I, or "exempt" */
  councilTaxBand: text('council_tax_band'),
  /** Energy rating as certified (EPC A–G, ES A–G / inProcess / exempt) */
  energyRating: text('energy_rating'),
  /** YYYY-MM-DD (lettings) */
  availableFrom: text('available_from'),
  /** Remote ids returned by push portals, e.g. { rightmove: "123456" } */
  remoteIds: jsonb('remote_ids').$type<Record<string, string>>().notNull().default({}),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
});

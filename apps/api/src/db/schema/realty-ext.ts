/**
 * Real Estate (`realty`) — offices (= locations), agents, listings, open houses, enquiries, viewings, offers,
 * vendor/landlord contacts, saved searches, portal syndication and AI proposals. See docs/verticals/real-estate.md.
 * Money: minor units + currency (office currency). Area: canonical m² (`area_sqm`), shown in the office unit.
 */
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, real, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations, users } from './core.ts';
import { customers } from './crm.ts';

const org = () => orgId().references(() => organizations.id, { onDelete: 'cascade' });
const loc = () => uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' });

export type WeeklyWindow = { weekday: number; start: string; end: string };
export type Disclosure = { key: string; label: string; text: string };
export type MediaItem = { url: string; caption?: string | null; alt?: string | null };

/** Per-office real-estate settings. One row per location. */
export const realtyOffices = pgTable('realty_offices', {
  id: pk(),
  organizationId: org(),
  locationId: loc().unique(),
  /** managed | standard | flexible — managed/standard need HQ approval to publish. */
  tier: text('tier').notNull().default('standard'),
  /** sqft | sqm — display unit for areas. */
  areaUnit: text('area_unit').notNull(),
  /** listing_agent | round_robin | office_pool */
  leadRouting: text('lead_routing').notNull().default('listing_agent'),
  /** Index into the ordered list of eligible agents for round-robin routing. */
  roundRobinCursor: integer('round_robin_cursor').notNull().default(0),
  viewingMinutes: integer('viewing_minutes').notNull().default(30),
  viewingBufferMinutes: integer('viewing_buffer_minutes').notNull().default(15),
  /** Regulated disclosure texts supplied by the business (never written by BranchHarbor). */
  disclosures: jsonb('disclosures').$type<Disclosure[]>().notNull().default([]),
  brokerageLicence: text('brokerage_licence'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const realtyAgents = pgTable('realty_agents', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  /** BranchHarbor account (role `staff` or manager at the office). Null for agents without an account yet. */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  title: text('title'),
  licenceNumber: text('licence_number'),
  bio: text('bio'),
  photoUrl: text('photo_url'),
  languages: text('languages').array().notNull().default(sql`'{}'::text[]`),
  availability: jsonb('availability').$type<WeeklyWindow[]>().notNull().default([]),
  acceptsLeads: boolean('accepts_leads').notNull().default(true),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index('realty_agents_loc_idx').on(t.locationId), uniqueIndex('realty_agents_user_loc_uq').on(t.userId, t.locationId)]);

/** Vendors (sellers), landlords and buyer/tenant contacts held by an office. Minimal personal data. */
export const realtyContacts = pgTable('realty_contacts', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  /** vendor | landlord | buyer | tenant */
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  notes: text('notes'),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  ownerAgentId: uuid('owner_agent_id').references(() => realtyAgents.id, { onDelete: 'set null' }),
  erasedAt: ts('erased_at'),
  createdAt: createdAt(),
}, (t) => [index('realty_contacts_loc_idx').on(t.locationId)]);

export const realtyListings = pgTable('realty_listings', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  reference: text('reference').notNull(),
  /** sale | rent */
  transaction: text('transaction').notNull(),
  propertyType: text('property_type').notNull(),
  /** draft | coming_soon | active | under_offer | sold | let | withdrawn */
  status: text('status').notNull().default('draft'),
  title: text('title').notNull(),
  description: text('description'),
  addressLine1: text('address_line1').notNull(),
  addressLine2: text('address_line2'),
  city: text('city').notNull(),
  region: text('region'),
  postalCode: text('postal_code'),
  country: text('country').notNull(),
  /** Hide the street address on public pages (shows the area only). */
  hideStreet: boolean('hide_street').notNull().default(false),
  geo: jsonb('geo').$type<{ lat: number; lng: number }>(),
  priceMinor: minor('price_minor').notNull(),
  currency: currencyCol().notNull(),
  /** Rentals: month | week. */
  rentPeriod: text('rent_period'),
  bedrooms: integer('bedrooms'),
  bathrooms: real('bathrooms'),
  areaSqm: real('area_sqm'),
  lotSqm: real('lot_sqm'),
  yearBuilt: integer('year_built'),
  features: text('features').array().notNull().default(sql`'{}'::text[]`),
  photos: jsonb('photos').$type<MediaItem[]>().notNull().default([]),
  floorPlans: jsonb('floor_plans').$type<MediaItem[]>().notNull().default([]),
  virtualTourUrl: text('virtual_tour_url'),
  /** Listing-specific disclosure texts supplied by the business (energy rating, permit number …). */
  disclosures: jsonb('disclosures').$type<Disclosure[]>().notNull().default([]),
  vendorContactId: uuid('vendor_contact_id').references(() => realtyContacts.id, { onDelete: 'set null' }),
  /** not_required | pending | approved | rejected */
  approvalStatus: text('approval_status').notNull().default('not_required'),
  /** Status to apply once HQ approves a publish request. */
  requestedStatus: text('requested_status'),
  /** Marketing edits to a published listing awaiting HQ approval (managed/standard offices). */
  pendingChanges: jsonb('pending_changes').$type<Record<string, unknown>>(),
  approvalRequestedBy: uuid('approval_requested_by'),
  approvalComment: text('approval_comment'),
  approvalDecidedBy: uuid('approval_decided_by'),
  approvalDecidedAt: ts('approval_decided_at'),
  firstActiveAt: ts('first_active_at'),
  publishedAt: ts('published_at'),
  closedAt: ts('closed_at'),
  /** Final price when sold/let (minor units, listing currency). */
  closedPriceMinor: minor('closed_price_minor'),
  withdrawnAt: ts('withdrawn_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('realty_listings_loc_status_idx').on(t.locationId, t.status),
  uniqueIndex('realty_listings_org_ref_uq').on(t.organizationId, t.reference),
]);

/** Listing agent (role `lead`) and co-listing agents (`co`). */
export const realtyListingAgents = pgTable('realty_listing_agents', {
  id: pk(),
  organizationId: org(),
  listingId: uuid('listing_id').notNull().references(() => realtyListings.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => realtyAgents.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('co'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('realty_listing_agents_uq').on(t.listingId, t.agentId),
  uniqueIndex('realty_listing_lead_uq').on(t.listingId).where(sql`role = 'lead'`),
]);

export const realtyListingHistory = pgTable('realty_listing_history', {
  id: pk(),
  organizationId: org(),
  listingId: uuid('listing_id').notNull().references(() => realtyListings.id, { onDelete: 'cascade' }),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  actorUserId: uuid('actor_user_id'),
  note: text('note'),
  at: ts('at').notNull().defaultNow(),
}, (t) => [index('realty_listing_history_listing_idx').on(t.listingId, t.at)]);

export const realtyOpenHouses = pgTable('realty_open_houses', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  listingId: uuid('listing_id').notNull().references(() => realtyListings.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').references(() => realtyAgents.id, { onDelete: 'set null' }),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  /** scheduled | cancelled | completed */
  status: text('status').notNull().default('scheduled'),
  rsvps: integer('rsvps').notNull().default(0),
  attendees: integer('attendees'),
  createdAt: createdAt(),
}, (t) => [index('realty_open_houses_listing_idx').on(t.listingId, t.startsAt)]);

export const realtyEnquiries = pgTable('realty_enquiries', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  listingId: uuid('listing_id').references(() => realtyListings.id, { onDelete: 'set null' }),
  source: text('source').notNull().default('website'),
  /** buyer | tenant | valuation | landlord | general */
  kind: text('kind').notNull().default('buyer'),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  message: text('message'),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  assignedAgentId: uuid('assigned_agent_id').references(() => realtyAgents.id, { onDelete: 'set null' }),
  /** listing_agent | co_listing_agent | round_robin | office_pool | manual */
  routedBy: text('routed_by').notNull(),
  /** new | contacted | viewing_booked | offer_made | closed | lost */
  status: text('status').notNull().default('new'),
  firstResponseAt: ts('first_response_at'),
  /** Idempotency for portal imports. */
  externalRef: text('external_ref'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('realty_enquiries_loc_created_idx').on(t.locationId, t.createdAt),
  uniqueIndex('realty_enquiries_ext_uq').on(t.organizationId, t.source, t.externalRef).where(sql`external_ref is not null`),
]);

export const realtyViewings = pgTable('realty_viewings', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  listingId: uuid('listing_id').notNull().references(() => realtyListings.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => realtyAgents.id, { onDelete: 'cascade' }),
  enquiryId: uuid('enquiry_id').references(() => realtyEnquiries.id, { onDelete: 'set null' }),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  /** Signed-in buyer, when booked from the app. */
  userId: uuid('user_id'),
  contactName: text('contact_name').notNull(),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  /** in_person | virtual */
  kind: text('kind').notNull().default('in_person'),
  /** requested | confirmed | completed | no_show | cancelled */
  status: text('status').notNull().default('requested'),
  source: text('source').notNull().default('website'),
  manageTokenHash: text('manage_token_hash'),
  confirmedAt: ts('confirmed_at'),
  cancelledAt: ts('cancelled_at'),
  cancelReason: text('cancel_reason'),
  reminderSentAt: ts('reminder_sent_at'),
  /** none | low | medium | high */
  interestLevel: text('interest_level'),
  feedbackRating: integer('feedback_rating'),
  feedbackNotes: text('feedback_notes'),
  feedbackAt: ts('feedback_at'),
  feedbackBy: uuid('feedback_by'),
  createdAt: createdAt(),
}, (t) => [
  index('realty_viewings_agent_start_idx').on(t.agentId, t.startsAt),
  index('realty_viewings_listing_idx').on(t.listingId),
]);

export const realtyOffers = pgTable('realty_offers', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  listingId: uuid('listing_id').notNull().references(() => realtyListings.id, { onDelete: 'cascade' }),
  /** Buyer/tenant contact (personal data — visible only to authorised users). */
  buyerContactId: uuid('buyer_contact_id').references(() => realtyContacts.id, { onDelete: 'set null' }),
  buyerName: text('buyer_name').notNull(),
  enquiryId: uuid('enquiry_id').references(() => realtyEnquiries.id, { onDelete: 'set null' }),
  /** Agent who recorded the offer for the buyer. */
  submittedByAgentId: uuid('submitted_by_agent_id').references(() => realtyAgents.id, { onDelete: 'set null' }),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  depositMinor: minor('deposit_minor'),
  conditions: text('conditions').array().notNull().default(sql`'{}'::text[]`),
  expiresAt: ts('expires_at'),
  /** submitted | countered | accepted | rejected | withdrawn */
  status: text('status').notNull().default('submitted'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('realty_offers_listing_idx').on(t.listingId),
  // Only one accepted offer per listing.
  uniqueIndex('realty_offers_accepted_uq').on(t.listingId).where(sql`status = 'accepted'`),
]);

/** Append-only negotiation trail. */
export const realtyOfferEvents = pgTable('realty_offer_events', {
  id: pk(),
  organizationId: org(),
  offerId: uuid('offer_id').notNull().references(() => realtyOffers.id, { onDelete: 'cascade' }),
  /** submitted | countered | revised | accepted | rejected | withdrawn | note */
  action: text('action').notNull(),
  /** buyer | vendor | agent */
  party: text('party').notNull(),
  amountMinor: minor('amount_minor'),
  currency: currencyCol(),
  conditions: text('conditions').array(),
  note: text('note'),
  actorUserId: uuid('actor_user_id'),
  at: ts('at').notNull().defaultNow(),
}, (t) => [index('realty_offer_events_offer_idx').on(t.offerId, t.at)]);

export type SavedSearchCriteria = {
  transaction?: 'sale' | 'rent';
  propertyTypes?: string[];
  minPrice?: number;
  maxPrice?: number;
  currency?: string;
  minBedrooms?: number;
  minBathrooms?: number;
  minArea?: number;
  areaUnit?: 'sqft' | 'sqm';
  city?: string;
  locationId?: string;
};

export const realtySavedSearches = pgTable('realty_saved_searches', {
  id: pk(),
  organizationId: org(),
  email: text('email').notNull(),
  userId: uuid('user_id'),
  name: text('name'),
  criteria: jsonb('criteria').$type<SavedSearchCriteria>().notNull(),
  /** instant | daily | weekly | off */
  frequency: text('frequency').notNull().default('weekly'),
  /** Email alerts only with explicit consent (recorded in consent_records). */
  alertsConsent: boolean('alerts_consent').notNull().default(false),
  locale: text('locale').notNull().default('en'),
  manageTokenHash: text('manage_token_hash').notNull(),
  lastAlertedAt: ts('last_alerted_at'),
  unsubscribedAt: ts('unsubscribed_at'),
  createdAt: createdAt(),
}, (t) => [index('realty_saved_searches_org_idx').on(t.organizationId), index('realty_saved_searches_email_idx').on(t.email)]);

/** One alert per (saved search, listing): re-running the alert job never emails the same match twice. */
export const realtyAlertDeliveries = pgTable('realty_alert_deliveries', {
  id: pk(),
  organizationId: org(),
  savedSearchId: uuid('saved_search_id').notNull().references(() => realtySavedSearches.id, { onDelete: 'cascade' }),
  listingId: uuid('listing_id').notNull().references(() => realtyListings.id, { onDelete: 'cascade' }),
  sentAt: ts('sent_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('realty_alert_deliveries_uq').on(t.savedSearchId, t.listingId)]);

/** Buyer's saved (favourite) listings, signed-in only. */
export const realtyFavourites = pgTable('realty_favourites', {
  id: pk(),
  organizationId: org(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  listingId: uuid('listing_id').notNull().references(() => realtyListings.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('realty_favourites_uq').on(t.userId, t.listingId)]);

/** Per-listing, per-portal syndication opt-in and the last (sandbox) export result. */
export const realtySyndication = pgTable('realty_syndication', {
  id: pk(),
  organizationId: org(),
  listingId: uuid('listing_id').notNull().references(() => realtyListings.id, { onDelete: 'cascade' }),
  portal: text('portal').notNull(),
  optedIn: boolean('opted_in').notNull().default(false),
  /** not_exported | sandbox_exported | invalid */
  lastStatus: text('last_status').notNull().default('not_exported'),
  lastIssues: jsonb('last_issues').$type<string[]>().notNull().default([]),
  lastExportedAt: ts('last_exported_at'),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('realty_syndication_uq').on(t.listingId, t.portal)]);

/** Realty AI output. Always a proposal; applying it goes through the normal editor/approval path. */
export const realtyAiProposals = pgTable('realty_ai_proposals', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id'),
  listingId: uuid('listing_id'),
  userId: uuid('user_id').notNull(),
  /** listing_description | feedback_summary | follow_up */
  kind: text('kind').notNull(),
  output: jsonb('output').$type<Record<string, unknown>>().notNull(),
  /** proposed | applied | dismissed */
  status: text('status').notNull().default('proposed'),
  model: text('model'),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
  createdAt: createdAt(),
}, (t) => [index('realty_ai_proposals_org_idx').on(t.organizationId, t.createdAt)]);

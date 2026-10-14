/**
 * Real Estate — public (customer website / buyer app) and signed-in buyer (`/me/realty`) routes.
 * Only customer-visible offices and listings in coming soon / active / under offer are exposed.
 */
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AREA_UNITS, ENQUIRY_KINDS, formatAddressLines, PROPERTY_TYPES, PUBLIC_LISTING_STATUSES, SUPPORTED_CURRENCIES, type AreaUnit } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  consentRecords, locations, organizations, realtyAgents, realtyEnquiries, realtyFavourites, realtyListings, realtyOffices, realtyOpenHouses, realtySavedSearches, realtyViewings, users,
} from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { requireUser } from '../plugins/auth.ts';
import { localDateParts } from '../lib/tz.ts';
import { audit } from '../services/audit.ts';
import { findOrCreateCustomer } from '../services/customers.ts';
import { ALERT_CONSENT_PURPOSE, ALERT_CONSENT_VERSION } from '../services/realty-jobs.ts';
import { areaView, bookViewing, bookingAgents, matchesCriteria, officeFor, publicListing, routeEnquiry, viewingSlots, viewingView, type SearchCriteria } from '../services/realty.ts';
import { isoDateTime } from './_common.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const contact = z.object({ name: z.string().min(1).max(120), email: z.email(), phone: z.string().max(40).optional() });
const csv = (vals: readonly string[]) => z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.enum(vals as [string, ...string[]])));

/** Saved-search criteria: strict — unknown keys (e.g. any protected characteristic) are rejected. */
export const savedSearchCriteria = z.strictObject({
  transaction: z.enum(['sale', 'rent']).optional(),
  propertyTypes: z.array(z.enum(PROPERTY_TYPES)).max(7).optional(),
  minPrice: z.number().int().min(0).optional(),
  maxPrice: z.number().int().min(0).optional(),
  currency: z.enum(SUPPORTED_CURRENCIES).optional(),
  minBedrooms: z.number().int().min(0).max(20).optional(),
  minBathrooms: z.number().min(0).max(20).optional(),
  minArea: z.number().min(0).optional(),
  areaUnit: z.enum(AREA_UNITS).optional(),
  city: z.string().max(80).optional(),
  locationId: z.uuid().optional(),
}).refine((c) => (c.minPrice == null && c.maxPrice == null) || !!c.currency, { message: 'Choose a currency for a price range (prices are never converted)', path: ['currency'] })
  .refine((c) => c.minArea == null || !!c.areaUnit, { message: 'Choose m² or sq ft for a minimum area', path: ['areaUnit'] });

export const realtyPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  async function brand(slug: string) {
    const [org] = await s.db.select().from(organizations).where(and(eq(organizations.slug, slug), isNull(organizations.deletedAt)));
    if (!org || org.industry !== 'realty') throw notFound('Agency');
    return org;
  }
  async function visibleLocations(orgId: string) {
    return s.db.select().from(locations).where(and(eq(locations.organizationId, orgId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt))).orderBy(asc(locations.name));
  }
  async function publicListingRow(id: string) {
    const [row] = await s.db.select({ l: realtyListings, loc: locations, org: organizations }).from(realtyListings)
      .innerJoin(locations, eq(locations.id, realtyListings.locationId)).innerJoin(organizations, eq(organizations.id, realtyListings.organizationId))
      .where(and(eq(realtyListings.id, id), inArray(realtyListings.status, [...PUBLIC_LISTING_STATUSES]), eq(locations.publiclyVisible, true), isNull(locations.archivedAt), isNull(organizations.deletedAt)));
    if (!row) throw notFound('Listing');
    return row;
  }
  const offices = async (locIds: string[]) => (locIds.length ? s.db.select().from(realtyOffices).where(inArray(realtyOffices.locationId, locIds)) : []);
  const agentPublic = (a: typeof realtyAgents.$inferSelect) => ({ id: a.id, name: a.name, title: a.title, photoUrl: a.photoUrl, phone: a.phone, email: a.email, licenceNumber: a.licenceNumber, languages: a.languages, bio: a.bio });

  // ───────── Search ─────────
  app.get('/public/realty/:brandSlug/listings', {
    schema: {
      tags: ['realty'], summary: 'Property search across the agency’s public offices. Price ranges apply to one currency (never converted); area filters use m² or sq ft.',
      params: z.object({ brandSlug: z.string().min(1).max(80) }),
      querystring: z.object({
        transaction: z.enum(['sale', 'rent']).optional(), type: csv(PROPERTY_TYPES).optional(),
        minPrice: z.coerce.number().int().min(0).optional(), maxPrice: z.coerce.number().int().min(0).optional(), currency: z.enum(SUPPORTED_CURRENCIES).optional(),
        minBeds: z.coerce.number().int().min(0).optional(), minBaths: z.coerce.number().min(0).optional(),
        minArea: z.coerce.number().min(0).optional(), areaUnit: z.enum(AREA_UNITS).optional(),
        city: z.string().max(80).optional(), office: z.string().max(80).optional(),
        sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'), limit: z.coerce.number().int().min(1).max(60).default(24), offset: z.coerce.number().int().min(0).default(0),
      }),
    },
  }, async (req) => {
    const q = req.query;
    if ((q.minPrice != null || q.maxPrice != null) && !q.currency) throw validationError('Choose a currency for a price range — prices are never converted between currencies', { currency: 'Required with a price range' });
    if (q.minArea != null && !q.areaUnit) throw validationError('Choose m² or sq ft for a minimum area', { areaUnit: 'Required with a minimum area' });
    const org = await brand(req.params.brandSlug);
    const locs = await visibleLocations(org.id);
    const office = q.office ? locs.find((l) => l.slug === q.office) : null;
    if (q.office && !office) throw notFound('Office');
    const rows = locs.length ? await s.db.select().from(realtyListings).where(and(eq(realtyListings.organizationId, org.id), inArray(realtyListings.status, [...PUBLIC_LISTING_STATUSES]), inArray(realtyListings.locationId, locs.map((l) => l.id)))) : [];
    const crit: SearchCriteria = { transaction: q.transaction, propertyTypes: q.type, minPrice: q.minPrice, maxPrice: q.maxPrice, currency: q.currency, minBedrooms: q.minBeds, minBathrooms: q.minBaths, minArea: q.minArea, areaUnit: q.areaUnit, city: q.city, locationId: office?.id };
    const matched = rows.filter((l) => matchesCriteria(l, crit));
    const otherCurrency = q.currency && (q.minPrice != null || q.maxPrice != null) ? rows.filter((l) => l.currency !== q.currency && matchesCriteria(l, { ...crit, minPrice: undefined, maxPrice: undefined, currency: undefined })).length : 0;
    matched.sort((a, b) => q.sort === 'newest' ? (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0) : a.currency !== b.currency ? a.currency.localeCompare(b.currency) : q.sort === 'price_asc' ? a.priceMinor - b.priceMinor : b.priceMinor - a.priceMinor);
    const offs = await offices(locs.map((l) => l.id));
    const page = matched.slice(q.offset, q.offset + q.limit);
    return {
      total: matched.length,
      items: page.map((l) => {
        const loc = locs.find((x) => x.id === l.locationId)!;
        return { ...publicListing(l, offs.find((o) => o.locationId === l.locationId)!, { areaUnit: q.areaUnit }), office: { id: loc.id, slug: loc.slug, name: loc.name, timeZone: loc.timeZone } };
      }),
      facets: {
        currencies: [...new Set(rows.map((l) => l.currency))].sort(), cities: [...new Set(rows.map((l) => l.city))].sort(),
        offices: locs.map((l) => ({ slug: l.slug, name: l.name, city: l.address.city, country: l.country, currency: l.currency, areaUnit: offs.find((o) => o.locationId === l.id)?.areaUnit ?? null })),
      },
      excluded: { otherCurrency, note: otherCurrency ? `${otherCurrency} listing(s) priced in other currencies are not shown because prices are never converted.` : null },
    };
  });

  // ───────── Listing detail ─────────
  app.get('/public/realty/listings/:id', {
    schema: { tags: ['realty'], summary: 'Public listing page data: gallery, floor plans, tour, features, business-supplied disclosures, agents and open houses', params: z.object({ id: z.uuid() }), querystring: z.object({ areaUnit: z.enum(AREA_UNITS).optional() }) },
  }, async (req) => {
    const { l, loc, org } = await publicListingRow(req.params.id);
    const office = await officeFor(s.db, loc);
    const agents = await bookingAgents(s.db, l.id);
    const now = new Date();
    const oh = await s.db.select().from(realtyOpenHouses).where(and(eq(realtyOpenHouses.listingId, l.id), eq(realtyOpenHouses.status, 'scheduled'), gte(realtyOpenHouses.endsAt, now))).orderBy(asc(realtyOpenHouses.startsAt));
    const unit = (req.query.areaUnit ?? office.areaUnit) as AreaUnit;
    const other: AreaUnit = unit === 'sqm' ? 'sqft' : 'sqm';
    return {
      listing: {
        ...publicListing(l, office, { areaUnit: unit }), description: l.description, features: l.features, photos: l.photos, floorPlans: l.floorPlans, virtualTourUrl: l.virtualTourUrl,
        areaAlt: areaView(l.areaSqm, other), lot: areaView(l.lotSqm, unit), yearBuilt: l.yearBuilt, geo: l.hideStreet ? null : l.geo, hideStreet: l.hideStreet,
        disclosures: [...office.disclosures, ...l.disclosures], brokerageLicence: office.brokerageLicence,
      },
      agents: agents.map(agentPublic),
      openHouses: oh.map((o) => ({ id: o.id, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString() })),
      office: { id: loc.id, slug: loc.slug, name: loc.name, phone: loc.phone, email: loc.email, timeZone: loc.timeZone, currency: loc.currency, locale: loc.locale, addressLines: formatAddressLines(loc.address), areaUnit: office.areaUnit, viewingMinutes: office.viewingMinutes },
      brand: { name: org.name, slug: org.slug },
    };
  });

  // ───────── Offices ─────────
  app.get('/public/realty/:brandSlug/offices/:officeSlug', {
    schema: { tags: ['realty'], summary: 'Office page: contact, agents and current listings', params: z.object({ brandSlug: z.string().min(1), officeSlug: z.string().min(1) }) },
  }, async (req) => {
    const org = await brand(req.params.brandSlug);
    const locs = await visibleLocations(org.id);
    const loc = locs.find((l) => l.slug === req.params.officeSlug);
    if (!loc) throw notFound('Office');
    const office = await officeFor(s.db, loc);
    const agents = await s.db.select().from(realtyAgents).where(and(eq(realtyAgents.locationId, loc.id), eq(realtyAgents.active, true))).orderBy(asc(realtyAgents.name));
    const listings = await s.db.select().from(realtyListings).where(and(eq(realtyListings.locationId, loc.id), inArray(realtyListings.status, [...PUBLIC_LISTING_STATUSES]))).orderBy(desc(realtyListings.publishedAt));
    return {
      office: { id: loc.id, slug: loc.slug, name: loc.name, phone: loc.phone, email: loc.email, timeZone: loc.timeZone, currency: loc.currency, addressLines: formatAddressLines(loc.address), areaUnit: office.areaUnit, brokerageLicence: office.brokerageLicence, disclosures: office.disclosures },
      agents: agents.map(agentPublic),
      listings: listings.map((l) => publicListing(l, office)),
    };
  });

  // ───────── Viewings ─────────
  app.get('/public/realty/listings/:id/viewing-slots', {
    schema: { tags: ['realty'], summary: 'Free viewing slots on a local date (office time zone) from the listing agents’ availability', params: z.object({ id: z.uuid() }), querystring: z.object({ date }) },
  }, async (req) => {
    const { l, loc } = await publicListingRow(req.params.id);
    const office = await officeFor(s.db, loc);
    const slots = await viewingSlots(s.db, { listing: l, office, timeZone: loc.timeZone, date: req.query.date });
    return { date: req.query.date, timeZone: loc.timeZone, viewingMinutes: office.viewingMinutes, slots: slots.map((x) => ({ startsAt: x.startsAt, endsAt: x.endsAt, agentId: x.agentId, agentName: x.agentName })) };
  });

  app.post('/public/realty/listings/:id/viewings', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['realty'], summary: 'Request a viewing: the slot is held for the agent, who confirms by email. Creates an enquiry routed to that agent.',
      params: z.object({ id: z.uuid() }),
      body: z.object({ startsAt: isoDateTime, agentId: z.uuid().optional(), kind: z.enum(['in_person', 'virtual']).default('in_person'), contact, message: z.string().max(1000).optional(), marketingConsent: z.boolean().default(false), source: z.enum(['website', 'mobile']).default('website') }),
    },
  }, async (req, reply) => {
    const { l, loc } = await publicListingRow(req.params.id);
    if (l.status === 'coming_soon') throw conflict('listing_not_viewable', 'Viewings open when this property is active. You can make an enquiry now.');
    const office = await officeFor(s.db, loc);
    const startsAt = new Date(req.body.startsAt);
    if (startsAt.getTime() < Date.now() + 30 * 60_000) throw validationError('Choose a time at least 30 minutes from now', { startsAt: 'Too soon' });
    const customer = await findOrCreateCustomer(s.db, l.organizationId, loc.id, { ...req.body.contact, marketingConsent: req.body.marketingConsent }, 'realty_viewing');
    const out = await s.db.transaction(async (tx) => {
      const booked = await bookViewing(tx, { organizationId: l.organizationId, listing: l, office, timeZone: loc.timeZone, startsAt, agentId: req.body.agentId, contact: req.body.contact, customerId: customer.id, userId: req.user?.id ?? null, kind: req.body.kind, source: req.body.source });
      const [enq] = await tx.insert(realtyEnquiries).values({
        organizationId: l.organizationId, locationId: loc.id, listingId: l.id, source: req.body.source, kind: l.transaction === 'rent' ? 'tenant' : 'buyer', name: req.body.contact.name, email: req.body.contact.email,
        phone: req.body.contact.phone ?? null, message: req.body.message ?? null, customerId: customer.id, assignedAgentId: booked.viewing.agentId, routedBy: 'listing_agent', status: 'viewing_booked',
      }).returning();
      await tx.update(realtyViewings).set({ enquiryId: enq!.id }).where(eq(realtyViewings.id, booked.viewing.id));
      await audit(tx, { organizationId: l.organizationId, actorUserId: null, actorType: 'system', action: 'realty.viewing.requested', scopeKind: 'location', scopeId: loc.id, targetType: 'realty_viewing', targetId: booked.viewing.id });
      return { ...booked, enquiryId: enq!.id };
    });
    const [agent] = await s.db.select().from(realtyAgents).where(eq(realtyAgents.id, out.viewing.agentId));
    const when = new Intl.DateTimeFormat(loc.locale, { timeZone: loc.timeZone, dateStyle: 'full', timeStyle: 'short' }).format(startsAt);
    void s.mailer.send({ to: req.body.contact.email, subject: `Viewing requested: ${l.title}`, text: `Thanks ${req.body.contact.name.split(' ')[0]}. You asked to view ${l.title} on ${when} (${loc.timeZone}).\n${agent?.name ?? 'An agent'} will confirm by email. Viewings may be shared with other buyers.\n\n${loc.name}`, tag: 'realty-viewing-requested' }).catch(() => {});
    if (agent?.email) void s.mailer.send({ to: agent.email, subject: `New viewing request: ${l.reference}`, text: `${req.body.contact.name} requested a viewing of ${l.title} on ${when}. Confirm it in BranchHarbor.`, tag: 'realty-agent-viewing' }).catch(() => {});
    return reply.code(201).send({ viewing: viewingView({ ...out.viewing, enquiryId: out.enquiryId }, { includeContact: true, listing: l, agentName: agent?.name ?? null, timeZone: loc.timeZone }), manageToken: out.manageToken, office: { name: loc.name, timeZone: loc.timeZone } });
  });

  const viewingByToken = async (id: string, token: string) => {
    const [row] = await s.db.select({ v: realtyViewings, l: realtyListings, loc: locations }).from(realtyViewings)
      .innerJoin(realtyListings, eq(realtyListings.id, realtyViewings.listingId)).innerJoin(locations, eq(locations.id, realtyViewings.locationId)).where(eq(realtyViewings.id, id));
    if (!row || row.v.manageTokenHash !== sha256(token)) throw notFound('Viewing');
    return row;
  };

  app.get('/public/realty/viewings/:id', { schema: { tags: ['realty'], params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) } }, async (req) => {
    const { v, l, loc } = await viewingByToken(req.params.id, req.query.token);
    const [agent] = await s.db.select({ name: realtyAgents.name }).from(realtyAgents).where(eq(realtyAgents.id, v.agentId));
    return { viewing: viewingView(v, { includeContact: true, listing: l, agentName: agent?.name, timeZone: loc.timeZone }), office: { name: loc.name, phone: loc.phone } };
  });

  app.post('/public/realty/viewings/:id/cancel', { schema: { tags: ['realty'], params: z.object({ id: z.uuid() }), body: z.object({ manageToken: z.string().min(10) }) } }, async (req) => {
    const { v } = await viewingByToken(req.params.id, req.body.manageToken);
    if (!['requested', 'confirmed'].includes(v.status)) throw conflict('viewing_not_active', `This viewing is ${v.status}`);
    await s.db.update(realtyViewings).set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: 'Cancelled by the buyer' }).where(eq(realtyViewings.id, v.id));
    return { id: v.id, status: 'cancelled' };
  });

  // ───────── Enquiries ─────────
  app.post('/public/realty/:brandSlug/enquiries', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['realty'], summary: 'Make an enquiry about a listing, a valuation or an office. Routed to the listing agent, round-robin, or the office pool.',
      params: z.object({ brandSlug: z.string().min(1) }),
      body: z.object({ listingId: z.uuid().optional(), officeSlug: z.string().optional(), kind: z.enum(ENQUIRY_KINDS).default('buyer'), contact, message: z.string().max(2000).optional(), marketingConsent: z.boolean().default(false), source: z.enum(['website', 'mobile']).default('website') }),
    },
  }, async (req, reply) => {
    const org = await brand(req.params.brandSlug);
    let locationId: string;
    let listingId: string | null = null;
    if (req.body.listingId) {
      const { l } = await publicListingRow(req.body.listingId);
      if (l.organizationId !== org.id) throw notFound('Listing');
      locationId = l.locationId;
      listingId = l.id;
    } else {
      const locs = await visibleLocations(org.id);
      const loc = req.body.officeSlug ? locs.find((l) => l.slug === req.body.officeSlug) : locs.length === 1 ? locs[0] : null;
      if (!loc) throw validationError('Choose an office', { officeSlug: 'Required' });
      locationId = loc.id;
    }
    const [loc] = await s.db.select().from(locations).where(eq(locations.id, locationId));
    await officeFor(s.db, loc!);
    const customer = await findOrCreateCustomer(s.db, org.id, locationId, { ...req.body.contact, marketingConsent: req.body.marketingConsent }, 'realty_enquiry');
    const enq = await s.db.transaction(async (tx) => {
      const r = await routeEnquiry(tx, { locationId, listingId });
      const [e] = await tx.insert(realtyEnquiries).values({
        organizationId: org.id, locationId, listingId, source: req.body.source, kind: req.body.kind, name: req.body.contact.name, email: req.body.contact.email, phone: req.body.contact.phone ?? null,
        message: req.body.message ?? null, customerId: customer.id, assignedAgentId: r.agentId, routedBy: r.routedBy,
      }).returning();
      await audit(tx, { organizationId: org.id, actorUserId: null, actorType: 'system', action: 'realty.enquiry.received', scopeKind: 'location', scopeId: locationId, targetType: 'realty_enquiry', targetId: e!.id, metadata: { routedBy: r.routedBy } });
      return e!;
    });
    if (enq.assignedAgentId) {
      const [agent] = await s.db.select().from(realtyAgents).where(eq(realtyAgents.id, enq.assignedAgentId));
      if (agent?.email) void s.mailer.send({ to: agent.email, subject: 'New enquiry assigned to you', text: `${enq.name} sent a ${enq.kind} enquiry. Open BranchHarbor to respond.`, tag: 'realty-enquiry' }).catch(() => {});
    }
    return reply.code(201).send({ id: enq.id, status: enq.status, routedTo: enq.assignedAgentId ? 'agent' : 'office' });
  });

  // ───────── Saved searches & alerts ─────────
  app.post('/public/realty/:brandSlug/saved-searches', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['realty'], summary: 'Save a search. Email alerts are sent only with explicit consent (recorded with purpose and version); every alert has an unsubscribe link.',
      params: z.object({ brandSlug: z.string().min(1) }),
      body: z.object({ email: z.email(), name: z.string().max(80).optional(), criteria: savedSearchCriteria, frequency: z.enum(['instant', 'daily', 'weekly', 'off']).default('weekly'), alertsConsent: z.boolean(), locale: z.string().max(10).default('en') }),
    },
  }, async (req, reply) => {
    const org = await brand(req.params.brandSlug);
    if (req.body.criteria.locationId) {
      const locs = await visibleLocations(org.id);
      if (!locs.some((l) => l.id === req.body.criteria.locationId)) throw validationError('Unknown office', { 'criteria.locationId': 'Not found' });
    }
    const token = randomToken();
    const consent = req.body.alertsConsent && req.body.frequency !== 'off';
    const [row] = await s.db.insert(realtySavedSearches).values({
      organizationId: org.id, email: req.body.email.trim(), userId: req.user?.id ?? null, name: req.body.name ?? null, criteria: req.body.criteria, frequency: consent ? req.body.frequency : 'off',
      alertsConsent: consent, locale: req.body.locale, manageTokenHash: sha256(token),
    }).returning();
    if (consent) await s.db.insert(consentRecords).values({ organizationId: org.id, email: req.body.email.trim(), userId: req.user?.id ?? null, purpose: ALERT_CONSENT_PURPOSE, version: ALERT_CONSENT_VERSION, granted: true, source: 'realty_saved_search', ip: req.ip });
    return reply.code(201).send({ id: row!.id, manageToken: token, alerts: consent ? row!.frequency : 'off' });
  });

  app.get('/public/realty/saved-searches/:id', { schema: { tags: ['realty'], params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) } }, async (req) => {
    const [ss] = await s.db.select().from(realtySavedSearches).where(eq(realtySavedSearches.id, req.params.id));
    if (!ss || ss.manageTokenHash !== sha256(req.query.token)) throw notFound('Saved search');
    return { id: ss.id, name: ss.name, criteria: ss.criteria, frequency: ss.frequency, alerts: ss.alertsConsent && !ss.unsubscribedAt, unsubscribedAt: ss.unsubscribedAt?.toISOString() ?? null };
  });

  app.post('/public/realty/saved-searches/:id/unsubscribe', { schema: { tags: ['realty'], summary: 'Stop alerts (withdraws consent)', params: z.object({ id: z.uuid() }), body: z.object({ manageToken: z.string().min(10) }) } }, async (req) => {
    const [ss] = await s.db.select().from(realtySavedSearches).where(eq(realtySavedSearches.id, req.params.id));
    if (!ss || ss.manageTokenHash !== sha256(req.body.manageToken)) throw notFound('Saved search');
    await s.db.update(realtySavedSearches).set({ unsubscribedAt: new Date(), alertsConsent: false, frequency: 'off' }).where(eq(realtySavedSearches.id, ss.id));
    await s.db.insert(consentRecords).values({ organizationId: ss.organizationId, email: ss.email, purpose: ALERT_CONSENT_PURPOSE, version: ALERT_CONSENT_VERSION, granted: false, source: 'realty_unsubscribe', ip: req.ip });
    return { id: ss.id, alerts: 'off' };
  });

  // ───────── Signed-in buyer ─────────
  const requireMe = (req: Parameters<typeof requireUser>[0]) => requireUser(req);
  const accountEmail = async (userId: string) => (await s.db.select({ email: users.email }).from(users).where(eq(users.id, userId)))[0]?.email?.toLowerCase() ?? '';

  app.get('/me/realty/favourites', { schema: { tags: ['realty'], security: [{ bearerAuth: [] }] } }, async (req) => {
    const u = requireMe(req);
    const rows = await s.db.select({ f: realtyFavourites, l: realtyListings, loc: locations }).from(realtyFavourites)
      .innerJoin(realtyListings, eq(realtyListings.id, realtyFavourites.listingId)).innerJoin(locations, eq(locations.id, realtyListings.locationId))
      .where(eq(realtyFavourites.userId, u.id)).orderBy(desc(realtyFavourites.createdAt));
    const offs = await offices([...new Set(rows.map((r) => r.loc.id))]);
    return {
      items: rows.map(({ f, l, loc }) => ({
        savedAt: f.createdAt.toISOString(),
        // Listings that are no longer public stay in the list but say so — no stale price/details are shown.
        available: (PUBLIC_LISTING_STATUSES as readonly string[]).includes(l.status) && loc.publiclyVisible,
        listing: (PUBLIC_LISTING_STATUSES as readonly string[]).includes(l.status) && loc.publiclyVisible ? { ...publicListing(l, offs.find((o) => o.locationId === loc.id)!), office: { name: loc.name, timeZone: loc.timeZone } } : { id: l.id, title: l.title, status: 'unavailable' },
      })),
    };
  });

  app.post('/me/realty/favourites', { schema: { tags: ['realty'], security: [{ bearerAuth: [] }], body: z.object({ listingId: z.uuid() }) } }, async (req, reply) => {
    const u = requireMe(req);
    const { l } = await publicListingRow(req.body.listingId);
    await s.db.insert(realtyFavourites).values({ organizationId: l.organizationId, userId: u.id, listingId: l.id }).onConflictDoNothing();
    return reply.code(201).send({ listingId: l.id, saved: true });
  });

  app.delete('/me/realty/favourites/:listingId', { schema: { tags: ['realty'], security: [{ bearerAuth: [] }], params: z.object({ listingId: z.uuid() }) } }, async (req) => {
    const u = requireMe(req);
    await s.db.delete(realtyFavourites).where(and(eq(realtyFavourites.userId, u.id), eq(realtyFavourites.listingId, req.params.listingId)));
    return { listingId: req.params.listingId, saved: false };
  });

  app.get('/me/realty/viewings', { schema: { tags: ['realty'], security: [{ bearerAuth: [] }] } }, async (req) => {
    const u = requireMe(req);
    const email = await accountEmail(u.id);
    const rows = await s.db.select({ v: realtyViewings, l: realtyListings, loc: locations }).from(realtyViewings)
      .innerJoin(realtyListings, eq(realtyListings.id, realtyViewings.listingId)).innerJoin(locations, eq(locations.id, realtyViewings.locationId))
      .where(sql`${realtyViewings.userId} = ${u.id} or lower(${realtyViewings.contactEmail}) = ${email}`).orderBy(desc(realtyViewings.startsAt)).limit(100);
    const agentIds = [...new Set(rows.map((r) => r.v.agentId))];
    const agents = agentIds.length ? await s.db.select({ id: realtyAgents.id, name: realtyAgents.name }).from(realtyAgents).where(inArray(realtyAgents.id, agentIds)) : [];
    return { items: rows.map(({ v, l, loc }) => ({ ...viewingView(v, { includeContact: true, listing: l, agentName: agents.find((a) => a.id === v.agentId)?.name, timeZone: loc.timeZone }), office: { name: loc.name, phone: loc.phone } })) };
  });

  app.post('/me/realty/viewings/:id/cancel', { schema: { tags: ['realty'], security: [{ bearerAuth: [] }], params: z.object({ id: z.uuid() }) } }, async (req) => {
    const u = requireMe(req);
    const email = await accountEmail(u.id);
    const [v] = await s.db.select().from(realtyViewings).where(eq(realtyViewings.id, req.params.id));
    if (!v || (v.userId !== u.id && v.contactEmail?.toLowerCase() !== email)) throw notFound('Viewing');
    if (!['requested', 'confirmed'].includes(v.status)) throw conflict('viewing_not_active', `This viewing is ${v.status}`);
    await s.db.update(realtyViewings).set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: 'Cancelled by the buyer' }).where(eq(realtyViewings.id, v.id));
    return { id: v.id, status: 'cancelled' };
  });

  app.get('/me/realty/saved-searches', { schema: { tags: ['realty'], security: [{ bearerAuth: [] }] } }, async (req) => {
    const u = requireMe(req);
    const rows = await s.db.select().from(realtySavedSearches).where(eq(realtySavedSearches.userId, u.id)).orderBy(desc(realtySavedSearches.createdAt));
    return { items: rows.map((ss) => ({ id: ss.id, name: ss.name, criteria: ss.criteria, frequency: ss.frequency, alerts: ss.alertsConsent && !ss.unsubscribedAt, createdAt: ss.createdAt.toISOString() })) };
  });

  app.post('/me/realty/saved-searches/:id/unsubscribe', { schema: { tags: ['realty'], security: [{ bearerAuth: [] }], params: z.object({ id: z.uuid() }) } }, async (req) => {
    const u = requireMe(req);
    const [ss] = await s.db.select().from(realtySavedSearches).where(and(eq(realtySavedSearches.id, req.params.id), eq(realtySavedSearches.userId, u.id)));
    if (!ss) throw notFound('Saved search');
    await s.db.update(realtySavedSearches).set({ unsubscribedAt: new Date(), alertsConsent: false, frequency: 'off' }).where(eq(realtySavedSearches.id, ss.id));
    await s.db.insert(consentRecords).values({ organizationId: ss.organizationId, email: ss.email, userId: u.id, purpose: ALERT_CONSENT_PURPOSE, version: ALERT_CONSENT_VERSION, granted: false, source: 'realty_app' });
    return { id: ss.id, alerts: 'off' };
  });

  /** Agencies (realty organisations) with public offices — used by the buyer app to choose a brand. */
  app.get('/public/realty/agencies/:brandSlug', { schema: { tags: ['realty'], params: z.object({ brandSlug: z.string().min(1) }) } }, async (req) => {
    const org = await brand(req.params.brandSlug);
    const locs = await visibleLocations(org.id);
    const offs = await offices(locs.map((l) => l.id));
    return {
      brand: { id: org.id, name: org.name, slug: org.slug, country: org.country, defaultLocale: org.defaultLocale },
      offices: locs.map((l) => ({ id: l.id, slug: l.slug, name: l.name, city: l.address.city, country: l.country, currency: l.currency, timeZone: l.timeZone, areaUnit: offs.find((o) => o.locationId === l.id)?.areaUnit ?? null, today: localDateParts(new Date(), l.timeZone).date })),
    };
  });
};

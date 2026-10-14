/**
 * Real Estate — staff routes: offices, agents, listings (editor + HQ approval), contacts, enquiries, viewings and
 * open houses. Offers/reports/my-day live in realty-deals.ts; syndication/AI/jobs in realty-extras.ts; public and
 * buyer routes in realty-public.ts. All are registered by `realtyRoutes` (one line in routes/index.ts).
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AREA_UNITS, ENQUIRY_KINDS, ENQUIRY_SOURCES, ENQUIRY_STATUSES, INTEREST_LEVELS, LEAD_ROUTING_MODES, LISTING_STATUSES, OFFICE_TIERS, PROPERTY_TYPES, toSqm,
  allowedListingTransitions, type ListingStatus, type ListingTransaction,
} from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  locations, realtyAgents, realtyContacts, realtyEnquiries, realtyListingAgents, realtyListingHistory, realtyListings, realtyOffers, realtyOffices, realtyOpenHouses,
  realtySyndication, realtyViewings,
} from '../db/schema/index.ts';
import { AppError, conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { hasPerm, locationAllowed, requirePerm } from '../services/authz.ts';
import {
  agentHasConflict, bookViewing, canEditListing, canSeeOffer, isManagerAt, isPublic, listingAgentRows, nextReference, officeFor, realtyAccess, routeEnquiry,
  staffListing, transitionListing, viewingSlots, viewingView, type Listing, type RealtyAccess,
} from '../services/realty.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';
import { realtyDealRoutes } from './realty-deals.ts';
import { realtyExtraRoutes } from './realty-extras.ts';
import { realtyPublicRoutes } from './realty-public.ts';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const weekly = z.array(z.object({ weekday: z.number().int().min(0).max(6), start: hhmm, end: z.string().regex(/^(\d{2}:\d{2}|24:00)$/) })).max(28);
const media = z.object({ url: z.url().max(2000), caption: z.string().max(200).nullish(), alt: z.string().max(200).nullish() });
const disclosure = z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(80), text: z.string().min(1).max(2000) });
const area = z.object({ value: z.number().min(0).max(10_000_000), unit: z.enum(AREA_UNITS) });
const address = z.object({ line1: z.string().min(1).max(200), line2: z.string().max(200).nullish(), city: z.string().min(1).max(120), region: z.string().max(120).nullish(), postalCode: z.string().max(20).nullish() });

const listingFields = z.object({
  title: z.string().min(1).max(160),
  description: z.string().max(8000).nullable(),
  propertyType: z.enum(PROPERTY_TYPES),
  priceMinor: z.number().int().min(0),
  rentPeriod: z.enum(['month', 'week']).nullable(),
  bedrooms: z.number().int().min(0).max(100).nullable(),
  bathrooms: z.number().min(0).max(100).nullable(),
  area: area.nullable(),
  lot: area.nullable(),
  yearBuilt: z.number().int().min(1000).max(2100).nullable(),
  features: z.array(z.string().min(1).max(80)).max(40),
  photos: z.array(media).max(60),
  floorPlans: z.array(media).max(20),
  virtualTourUrl: z.url().max(2000).nullable(),
  disclosures: z.array(disclosure).max(20),
  hideStreet: z.boolean(),
  geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable(),
  address,
  vendorContactId: z.uuid().nullable(),
}).partial();

/** Fields customers see. Changing them on a published listing in a managed/standard office needs HQ approval. */
const MARKETING_COLUMNS = new Set(['title', 'description', 'propertyType', 'priceMinor', 'rentPeriod', 'bedrooms', 'bathrooms', 'areaSqm', 'lotSqm', 'yearBuilt', 'features', 'photos', 'floorPlans', 'virtualTourUrl', 'disclosures', 'hideStreet', 'geo', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode']);

function toColumns(b: z.infer<typeof listingFields>): Partial<Listing> {
  const out: Record<string, unknown> = {};
  for (const k of ['title', 'description', 'propertyType', 'priceMinor', 'rentPeriod', 'bedrooms', 'bathrooms', 'yearBuilt', 'features', 'photos', 'floorPlans', 'virtualTourUrl', 'disclosures', 'hideStreet', 'geo', 'vendorContactId'] as const) if (b[k] !== undefined) out[k] = b[k];
  if (b.area !== undefined) out.areaSqm = b.area ? Math.round(toSqm(b.area.value, b.area.unit) * 100) / 100 : null;
  if (b.lot !== undefined) out.lotSqm = b.lot ? Math.round(toSqm(b.lot.value, b.lot.unit) * 100) / 100 : null;
  if (b.address) Object.assign(out, { addressLine1: b.address.line1, addressLine2: b.address.line2 ?? null, city: b.address.city, region: b.address.region ?? null, postalCode: b.address.postalCode ?? null });
  return out as Partial<Listing>;
}

export const realtyRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  await app.register(realtyPublicRoutes);

  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);
    await priv.register(realtyDealRoutes);
    await priv.register(realtyExtraRoutes);

    const loadListing = async (orgId: string, id: string) => {
      const [row] = await s.db.select({ l: realtyListings, loc: locations }).from(realtyListings).innerJoin(locations, eq(locations.id, realtyListings.locationId))
        .where(and(eq(realtyListings.id, id), eq(realtyListings.organizationId, orgId)));
      if (!row) throw notFound('Listing');
      return { listing: row.l, loc: row.loc, office: await officeFor(s.db, row.loc) };
    };
    const loadLocation = async (orgId: string, id: string) => {
      const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, id), eq(locations.organizationId, orgId)));
      if (!loc) throw notFound('Office');
      return loc;
    };
    const agentsFor = async (ids: string[]) => {
      const rows = await listingAgentRows(s.db, ids);
      const map = new Map<string, Array<{ id: string; name: string; role: string; userId: string | null; locationId: string }>>();
      for (const r of rows) map.set(r.la.listingId, [...(map.get(r.la.listingId) ?? []), { id: r.agent.id, name: r.agent.name, role: r.la.role, userId: r.agent.userId, locationId: r.agent.locationId }]);
      for (const v of map.values()) v.sort((a, b) => (a.role === 'lead' ? -1 : b.role === 'lead' ? 1 : a.name.localeCompare(b.name)));
      return map;
    };
    const requireOps = (a: RealtyAccess, locationId: string) => {
      if (!locationAllowed(a.ops, locationId)) throw forbidden('Missing permission operations.read for this office');
    };

    // ───────── Me ─────────
    priv.get('/orgs/:orgId/realty/me', { schema: { tags: ['realty'], security: secured, params: orgParams, summary: 'Agent profiles and realty capabilities of the signed-in user' } }, async (req) => {
      const a = await realtyAccess(req, s.db, req.params.orgId);
      const list = (x: 'all' | Set<string>) => (x === 'all' ? 'all' : [...x]);
      return { agents: a.agents.map((g) => ({ id: g.id, name: g.name, locationId: g.locationId })), operations: list(a.ops), operationsWrite: list(a.opsWrite), clients: list(a.clients), approve: list(a.approve), reports: list(a.reports) };
    });

    // ───────── Offices ─────────
    priv.get('/orgs/:orgId/realty/offices', { schema: { tags: ['realty'], security: secured, params: orgParams } }, async (req) => {
      const a = await realtyAccess(req, s.db, req.params.orgId);
      const locs = await s.db.select().from(locations).where(and(eq(locations.organizationId, req.params.orgId), isNull(locations.archivedAt))).orderBy(asc(locations.name));
      const visible = locs.filter((l) => locationAllowed(a.ops, l.id) || locationAllowed(a.reports, l.id));
      const out = [];
      for (const l of visible) {
        const o = await officeFor(s.db, l);
        const agents = await s.db.select({ n: sql<number>`count(*)::int` }).from(realtyAgents).where(and(eq(realtyAgents.locationId, l.id), eq(realtyAgents.active, true)));
        out.push({ locationId: l.id, name: l.name, city: l.address.city, country: l.country, currency: l.currency, timeZone: l.timeZone, tier: o.tier, areaUnit: o.areaUnit, leadRouting: o.leadRouting, viewingMinutes: o.viewingMinutes, viewingBufferMinutes: o.viewingBufferMinutes, disclosures: o.disclosures, brokerageLicence: o.brokerageLicence, agentCount: agents[0]?.n ?? 0, publiclyVisible: l.publiclyVisible });
      }
      return { items: out };
    });

    priv.put('/orgs/:orgId/realty/offices/:locationId', {
      schema: {
        tags: ['realty'], security: secured, params: z.object({ orgId: z.uuid(), locationId: z.uuid() }),
        summary: 'Office settings. Governance tier needs policies.write (HQ); other settings need office management rights.',
        body: z.object({ tier: z.enum(OFFICE_TIERS), areaUnit: z.enum(AREA_UNITS), leadRouting: z.enum(LEAD_ROUTING_MODES), viewingMinutes: z.number().int().min(15).max(180), viewingBufferMinutes: z.number().int().min(0).max(120), disclosures: z.array(disclosure).max(20), brokerageLicence: z.string().max(200).nullable() }).partial(),
      },
    }, async (req) => {
      const { orgId, locationId } = req.params;
      const loc = await loadLocation(orgId, locationId);
      const office = await officeFor(s.db, loc);
      const target = { organizationId: orgId, kind: 'location' as const, id: locationId };
      if (req.body.tier !== undefined && req.body.tier !== office.tier) await requirePerm(req, s.db, 'policies.write', target);
      const others = Object.keys(req.body).filter((k) => k !== 'tier');
      if (others.length && !(await hasPerm(req, s.db, 'locations.write', target)) && !(await hasPerm(req, s.db, 'customers.write', target))) throw forbidden('Only office managers or HQ can change office settings');
      const [u] = await s.db.update(realtyOffices).set({ ...req.body, updatedAt: new Date() }).where(eq(realtyOffices.id, office.id)).returning();
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'realty.office.updated', scopeKind: 'location', scopeId: locationId, targetType: 'realty_office', targetId: office.id, metadata: { fields: Object.keys(req.body) } });
      return u!;
    });

    // ───────── Agents ─────────
    priv.get('/orgs/:orgId/realty/agents', { schema: { tags: ['realty'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }) } }, async (req) => {
      const a = await realtyAccess(req, s.db, req.params.orgId);
      const conds = [eq(realtyAgents.organizationId, req.params.orgId)];
      if (req.query.locationId) conds.push(eq(realtyAgents.locationId, req.query.locationId));
      const rows = (await s.db.select().from(realtyAgents).where(and(...conds)).orderBy(asc(realtyAgents.name))).filter((g) => locationAllowed(a.ops, g.locationId) || a.agentIds.has(g.id));
      const now = new Date();
      const ids = rows.map((r) => r.id);
      const load = ids.length ? await s.db.select({ agentId: realtyViewings.agentId, n: sql<number>`count(*)::int` }).from(realtyViewings).where(and(inArray(realtyViewings.agentId, ids), inArray(realtyViewings.status, ['requested', 'confirmed']), gte(realtyViewings.startsAt, now))).groupBy(realtyViewings.agentId) : [];
      const leads = ids.length ? await s.db.select({ agentId: realtyEnquiries.assignedAgentId, n: sql<number>`count(*)::int` }).from(realtyEnquiries).where(and(inArray(realtyEnquiries.assignedAgentId, ids), inArray(realtyEnquiries.status, ['new', 'contacted']))).groupBy(realtyEnquiries.assignedAgentId) : [];
      const listings = ids.length ? await s.db.select({ agentId: realtyListingAgents.agentId, n: sql<number>`count(*)::int` }).from(realtyListingAgents).innerJoin(realtyListings, eq(realtyListings.id, realtyListingAgents.listingId)).where(and(inArray(realtyListingAgents.agentId, ids), inArray(realtyListings.status, ['coming_soon', 'active', 'under_offer']))).groupBy(realtyListingAgents.agentId) : [];
      return {
        items: rows.map((g) => ({
          ...g, createdAt: g.createdAt.toISOString(), isMe: a.agentIds.has(g.id),
          workload: { upcomingViewings: load.find((x) => x.agentId === g.id)?.n ?? 0, openEnquiries: leads.find((x) => x.agentId === g.id)?.n ?? 0, liveListings: listings.find((x) => x.agentId === g.id)?.n ?? 0 },
        })),
      };
    });

    const agentBody = z.object({ name: z.string().min(1).max(120), email: z.email().nullable(), phone: z.string().max(40).nullable(), title: z.string().max(80).nullable(), licenceNumber: z.string().max(80).nullable(), bio: z.string().max(2000).nullable(), photoUrl: z.url().nullable(), languages: z.array(z.string().max(20)).max(10), availability: weekly, acceptsLeads: z.boolean(), active: z.boolean(), userId: z.uuid().nullable() }).partial();

    const canManageOffice = async (req: Parameters<typeof hasPerm>[0], orgId: string, locationId: string) => {
      const t = { organizationId: orgId, kind: 'location' as const, id: locationId };
      return (await hasPerm(req, s.db, 'customers.write', t)) || (await hasPerm(req, s.db, 'locations.write', t));
    };

    priv.post('/orgs/:orgId/realty/agents', { schema: { tags: ['realty'], security: secured, params: orgParams, body: agentBody.extend({ locationId: z.uuid(), name: z.string().min(1).max(120) }) } }, async (req, reply) => {
      const { orgId } = req.params;
      await loadLocation(orgId, req.body.locationId);
      if (!(await canManageOffice(req, orgId, req.body.locationId))) throw forbidden('Only office managers or HQ can add agents');
      const [row] = await s.db.insert(realtyAgents).values({ organizationId: orgId, ...req.body, languages: req.body.languages ?? [], availability: req.body.availability ?? [] }).returning();
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'realty.agent.created', scopeKind: 'location', scopeId: req.body.locationId, targetType: 'realty_agent', targetId: row!.id });
      return reply.code(201).send(row);
    });

    priv.patch('/orgs/:orgId/realty/agents/:id', { schema: { tags: ['realty'], security: secured, params: idParams, body: agentBody } }, async (req) => {
      const { orgId, id } = req.params;
      const [g] = await s.db.select().from(realtyAgents).where(and(eq(realtyAgents.id, id), eq(realtyAgents.organizationId, orgId)));
      if (!g) throw notFound('Agent');
      const manager = await canManageOffice(req, orgId, g.locationId);
      const self = g.userId === req.user!.id;
      const selfKeys = new Set(['availability', 'acceptsLeads', 'bio', 'photoUrl', 'phone', 'languages']);
      if (!manager && !(self && Object.keys(req.body).every((k) => selfKeys.has(k)))) throw forbidden('Agents can update their own availability and profile; other changes need an office manager');
      const [u] = await s.db.update(realtyAgents).set(req.body).where(eq(realtyAgents.id, id)).returning();
      return u!;
    });

    // ───────── Listings ─────────
    priv.get('/orgs/:orgId/realty/listings', {
      schema: { tags: ['realty'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), status: z.enum(LISTING_STATUSES).optional(), mine: z.coerce.boolean().optional(), approval: z.enum(['pending']).optional(), q: z.string().max(80).optional() }) },
    }, async (req) => {
      const { orgId } = req.params;
      const a = await realtyAccess(req, s.db, orgId);
      const conds = [eq(realtyListings.organizationId, orgId)];
      if (req.query.locationId) conds.push(eq(realtyListings.locationId, req.query.locationId));
      if (req.query.status) conds.push(eq(realtyListings.status, req.query.status));
      if (req.query.approval) conds.push(eq(realtyListings.approvalStatus, 'pending'));
      if (req.query.q) conds.push(or(sql`${realtyListings.title} ilike ${`%${req.query.q}%`}`, sql`${realtyListings.reference} ilike ${`%${req.query.q}%`}`, sql`${realtyListings.city} ilike ${`%${req.query.q}%`}`)!);
      let rows = (await s.db.select().from(realtyListings).where(and(...conds)).orderBy(desc(realtyListings.updatedAt))).filter((l) => locationAllowed(a.ops, l.locationId) || locationAllowed(a.approve, l.locationId));
      const agents = await agentsFor(rows.map((l) => l.id));
      if (req.query.mine) rows = rows.filter((l) => (agents.get(l.id) ?? []).some((g) => a.agentIds.has(g.id)));
      const offices = rows.length ? await s.db.select().from(realtyOffices).where(inArray(realtyOffices.locationId, [...new Set(rows.map((l) => l.locationId))])) : [];
      const ids = rows.map((l) => l.id);
      const now = new Date();
      const enq = ids.length ? await s.db.select({ id: realtyEnquiries.listingId, n: sql<number>`count(*)::int` }).from(realtyEnquiries).where(inArray(realtyEnquiries.listingId, ids)).groupBy(realtyEnquiries.listingId) : [];
      const vw = ids.length ? await s.db.select({ id: realtyViewings.listingId, n: sql<number>`count(*)::int` }).from(realtyViewings).where(and(inArray(realtyViewings.listingId, ids), inArray(realtyViewings.status, ['requested', 'confirmed']), gte(realtyViewings.startsAt, now))).groupBy(realtyViewings.listingId) : [];
      const of = ids.length ? await s.db.select({ id: realtyOffers.listingId, n: sql<number>`count(*)::int` }).from(realtyOffers).where(and(inArray(realtyOffers.listingId, ids), inArray(realtyOffers.status, ['submitted', 'countered', 'accepted']))).groupBy(realtyOffers.listingId) : [];
      return {
        items: rows.map((l) => {
          const ag = agents.get(l.id) ?? [];
          const agentIds = ag.map((g) => g.id);
          return {
            ...staffListing(l, offices.find((o) => o.locationId === l.locationId), ag.map(({ id, name, role }) => ({ id, name, role }))),
            counts: { enquiries: enq.find((x) => x.id === l.id)?.n ?? 0, upcomingViewings: vw.find((x) => x.id === l.id)?.n ?? 0, openOffers: canSeeOffer(a, l, agentIds) ? of.find((x) => x.id === l.id)?.n ?? 0 : null },
            permissions: { canEdit: canEditListing(a, l, agentIds), canApprove: locationAllowed(a.approve, l.locationId), canSeeOffers: canSeeOffer(a, l, agentIds) },
          };
        }),
      };
    });

    priv.post('/orgs/:orgId/realty/listings', {
      schema: { tags: ['realty'], security: secured, params: orgParams, body: listingFields.extend({ locationId: z.uuid(), transaction: z.enum(['sale', 'rent']), propertyType: z.enum(PROPERTY_TYPES), title: z.string().min(1).max(160), priceMinor: z.number().int().min(0), address, leadAgentId: z.uuid().optional(), coAgentIds: z.array(z.uuid()).max(5).default([]) }) },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const loc = await loadLocation(orgId, req.body.locationId);
      const a = await realtyAccess(req, s.db, orgId);
      if (!locationAllowed(a.opsWrite, loc.id)) throw forbidden('Missing permission operations.write for this office');
      await officeFor(s.db, loc);
      const myAgentHere = a.agents.find((g) => g.locationId === loc.id);
      const leadAgentId = req.body.leadAgentId ?? myAgentHere?.id ?? null;
      if (leadAgentId && !isManagerAt(a, loc.id) && leadAgentId !== myAgentHere?.id) throw forbidden('Agents create listings for themselves; a manager can assign another agent');
      const { locationId: _l, transaction, leadAgentId: _a, coAgentIds, ...fields } = req.body;
      if (transaction === 'rent' && !fields.rentPeriod) fields.rentPeriod = 'month';
      if (transaction === 'sale') fields.rentPeriod = null;
      const listing = await s.db.transaction(async (tx) => {
        const [l] = await tx.insert(realtyListings).values({
          organizationId: orgId, locationId: loc.id, reference: await nextReference(tx, orgId, loc), transaction, currency: loc.currency, country: loc.country, createdBy: req.user!.id,
          ...(toColumns(fields) as Required<Pick<Listing, 'title' | 'propertyType' | 'priceMinor' | 'addressLine1' | 'city'>>),
        }).returning();
        if (leadAgentId) await setAgents(tx, orgId, l!, leadAgentId, coAgentIds);
        await tx.insert(realtyListingHistory).values({ organizationId: orgId, listingId: l!.id, fromStatus: null, toStatus: 'draft', actorUserId: req.user!.id });
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'realty.listing.created', scopeKind: 'location', scopeId: loc.id, targetType: 'realty_listing', targetId: l!.id });
        return l!;
      });
      return reply.code(201).send(await detail(req, orgId, listing.id));
    });

    async function setAgents(tx: Parameters<Parameters<typeof s.db.transaction>[0]>[0], orgId: string, l: Listing, leadId: string, coIds: string[]) {
      const all = [...new Set([leadId, ...coIds])];
      const agents = await tx.select().from(realtyAgents).where(and(eq(realtyAgents.organizationId, orgId), inArray(realtyAgents.id, all), eq(realtyAgents.active, true)));
      if (agents.length !== all.length) throw validationError('Unknown or inactive agent', { agents: 'Some agents were not found' });
      if (agents.find((g) => g.id === leadId)!.locationId !== l.locationId) throw validationError('The listing agent must work at the listing’s office', { leadAgentId: 'Different office' });
      await tx.delete(realtyListingAgents).where(eq(realtyListingAgents.listingId, l.id));
      await tx.insert(realtyListingAgents).values(all.map((id) => ({ organizationId: orgId, listingId: l.id, agentId: id, role: id === leadId ? 'lead' : 'co' })));
    }

    async function detail(req: Parameters<typeof realtyAccess>[0], orgId: string, id: string) {
      const { listing, office, loc } = await loadListing(orgId, id);
      const a = await realtyAccess(req, s.db, orgId);
      if (!locationAllowed(a.ops, listing.locationId) && !locationAllowed(a.approve, listing.locationId)) throw forbidden('Missing permission operations.read for this office');
      const ag = (await agentsFor([listing.id])).get(listing.id) ?? [];
      const agentIds = ag.map((g) => g.id);
      const history = await s.db.select().from(realtyListingHistory).where(eq(realtyListingHistory.listingId, listing.id)).orderBy(asc(realtyListingHistory.at));
      const openHouses = await s.db.select().from(realtyOpenHouses).where(eq(realtyOpenHouses.listingId, listing.id)).orderBy(asc(realtyOpenHouses.startsAt));
      const synd = await s.db.select().from(realtySyndication).where(eq(realtySyndication.listingId, listing.id));
      const seeClients = isManagerAt(a, listing.locationId) || agentIds.some((x) => a.agentIds.has(x));
      const [vendor] = seeClients && listing.vendorContactId ? await s.db.select().from(realtyContacts).where(eq(realtyContacts.id, listing.vendorContactId)) : [];
      const canApprove = locationAllowed(a.approve, listing.locationId);
      return {
        ...staffListing(listing, office, ag.map(({ id: aid, name, role }) => ({ id: aid, name, role }))),
        office: { id: loc.id, name: loc.name, timeZone: loc.timeZone, currency: loc.currency, country: loc.country, tier: office.tier, areaUnit: office.areaUnit, disclosures: office.disclosures },
        history: history.map((h) => ({ from: h.fromStatus, to: h.toStatus, at: h.at.toISOString(), note: h.note })),
        openHouses: openHouses.map((o) => ({ id: o.id, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(), status: o.status, agentId: o.agentId, rsvps: o.rsvps })),
        syndication: synd.map((x) => ({ portal: x.portal, optedIn: x.optedIn, lastStatus: x.lastStatus, lastIssues: x.lastIssues, lastExportedAt: x.lastExportedAt?.toISOString() ?? null })),
        vendor: vendor ? { id: vendor.id, kind: vendor.kind, name: vendor.name, email: vendor.email, phone: vendor.phone } : listing.vendorContactId ? { id: listing.vendorContactId, restricted: true } : null,
        allowedTransitions: allowedListingTransitions(listing.status as ListingStatus, listing.transaction as ListingTransaction),
        permissions: { canEdit: canEditListing(a, listing, agentIds), canApprove, canSeeOffers: canSeeOffer(a, listing, agentIds), canSeeClients: seeClients, isRequester: listing.approvalRequestedBy === a.userId },
      };
    }

    priv.get('/orgs/:orgId/realty/listings/:id', { schema: { tags: ['realty'], security: secured, params: idParams } }, async (req) => detail(req, req.params.orgId, req.params.id));

    priv.patch('/orgs/:orgId/realty/listings/:id', {
      schema: { tags: ['realty'], security: secured, params: idParams, body: listingFields, summary: 'Edit a listing. Published listings in managed/standard offices keep their live content until HQ approves the change.' },
    }, async (req) => {
      const { orgId, id } = req.params;
      const { listing, office } = await loadListing(orgId, id);
      const a = await realtyAccess(req, s.db, orgId);
      const agentIds = ((await agentsFor([id])).get(id) ?? []).map((g) => g.id);
      if (!canEditListing(a, listing, agentIds)) throw forbidden('Only the listing agents or an office manager can edit this listing');
      if (['sold', 'let'].includes(listing.status)) throw conflict('listing_closed', 'Closed listings cannot be edited');
      if (req.body.vendorContactId) {
        const [c] = await s.db.select().from(realtyContacts).where(and(eq(realtyContacts.id, req.body.vendorContactId), eq(realtyContacts.organizationId, orgId)));
        if (!c || !['vendor', 'landlord'].includes(c.kind)) throw validationError('Choose a vendor or landlord contact', { vendorContactId: 'Not a vendor/landlord' });
      }
      const cols = toColumns(req.body);
      const governed = isPublic(listing.status) && office.tier !== 'flexible' && !locationAllowed(a.approve, listing.locationId);
      const marketing = Object.fromEntries(Object.entries(cols).filter(([k]) => MARKETING_COLUMNS.has(k)));
      const internal = Object.fromEntries(Object.entries(cols).filter(([k]) => !MARKETING_COLUMNS.has(k)));
      let result: 'applied' | 'pending_approval' = 'applied';
      await s.db.transaction(async (tx) => {
        if (governed && Object.keys(marketing).length) {
          await tx.update(realtyListings).set({ ...internal, pendingChanges: { ...(listing.pendingChanges ?? {}), ...marketing }, approvalStatus: 'pending', approvalRequestedBy: req.user!.id, approvalDecidedBy: null, approvalDecidedAt: null, updatedAt: new Date() }).where(eq(realtyListings.id, id));
          result = 'pending_approval';
          await audit(tx, { organizationId: orgId, ...actor(req), action: 'realty.listing.change_requested', scopeKind: 'location', scopeId: listing.locationId, targetType: 'realty_listing', targetId: id, metadata: { fields: Object.keys(marketing) } });
        } else {
          await tx.update(realtyListings).set({ ...cols, updatedAt: new Date() }).where(eq(realtyListings.id, id));
          await audit(tx, { organizationId: orgId, ...actor(req), action: 'realty.listing.updated', scopeKind: 'location', scopeId: listing.locationId, targetType: 'realty_listing', targetId: id, metadata: { fields: Object.keys(cols) } });
        }
      });
      return { result, listing: await detail(req, orgId, id) };
    });

    priv.put('/orgs/:orgId/realty/listings/:id/agents', { schema: { tags: ['realty'], security: secured, params: idParams, body: z.object({ leadAgentId: z.uuid(), coAgentIds: z.array(z.uuid()).max(5).default([]) }) } }, async (req) => {
      const { orgId, id } = req.params;
      const { listing } = await loadListing(orgId, id);
      const a = await realtyAccess(req, s.db, orgId);
      if (!isManagerAt(a, listing.locationId)) {
        const current = ((await agentsFor([id])).get(id) ?? []);
        const lead = current.find((g) => g.role === 'lead');
        // The listing agent may add/remove co-listing agents but not hand the listing to someone else.
        if (!lead || !a.agentIds.has(lead.id) || req.body.leadAgentId !== lead.id) throw forbidden('Only an office manager can change the listing agent');
      }
      await s.db.transaction(async (tx) => {
        await setAgents(tx, orgId, listing, req.body.leadAgentId, req.body.coAgentIds);
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'realty.listing.agents', scopeKind: 'location', scopeId: listing.locationId, targetType: 'realty_listing', targetId: id, metadata: req.body });
      });
      return detail(req, orgId, id);
    });

    priv.post('/orgs/:orgId/realty/listings/:id/status', {
      schema: { tags: ['realty'], security: secured, params: idParams, summary: 'Change status (draft → coming soon → active → under offer → sold/let; withdrawn). Publishing may need HQ approval.', body: z.object({ to: z.enum(LISTING_STATUSES), closedPriceMinor: z.number().int().min(0).optional(), note: z.string().max(500).optional() }) },
    }, async (req, reply) => {
      const { orgId, id } = req.params;
      const { listing, office } = await loadListing(orgId, id);
      const a = await realtyAccess(req, s.db, orgId);
      const agentIds = ((await agentsFor([id])).get(id) ?? []).map((g) => g.id);
      if (!canEditListing(a, listing, agentIds)) throw forbidden('Only the listing agents or an office manager can change the status');
      const r = await s.db.transaction((tx) => transitionListing(tx, { listing, office, to: req.body.to, actorUserId: req.user!.id, canApprove: locationAllowed(a.approve, listing.locationId), closedPriceMinor: req.body.closedPriceMinor, note: req.body.note }));
      for (const v of r.cancelledViewings ?? []) if (v.contactEmail) void s.mailer.send({ to: v.contactEmail, subject: `Viewing cancelled: ${listing.title}`, text: `Your viewing of ${listing.title} has been cancelled because the property is no longer available. We are sorry for the inconvenience.`, tag: 'realty-viewing-cancelled' }).catch(() => {});
      // Portal syndication follows the status (re-send while public, remove when withdrawn / sold / let).
      if (r.result !== 'pending_approval') await s.jobs.enqueue('realty.portal_sync', { listingId: id });
      return reply.code(r.result === 'pending_approval' ? 202 : 200).send({ result: r.result, cancelledViewings: r.cancelledViewings?.length ?? 0, listing: await detail(req, orgId, id) });
    });

    priv.post('/orgs/:orgId/realty/listings/:id/approval', {
      schema: { tags: ['realty'], security: secured, params: idParams, summary: 'HQ advertising check: approve or reject a publish request or changes to a published listing (no self-approval).', body: z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(1000).optional() }) },
    }, async (req) => {
      const { orgId, id } = req.params;
      const { listing, office } = await loadListing(orgId, id);
      await requirePerm(req, s.db, 'website.approve', { organizationId: orgId, kind: 'location', id: listing.locationId });
      if (listing.approvalStatus !== 'pending') throw conflict('nothing_pending', 'This listing has no pending approval');
      if (listing.approvalRequestedBy === req.user!.id) throw forbidden('You cannot approve your own request');
      if (req.body.decision === 'reject' && !req.body.comment?.trim()) throw validationError('Explain what needs to change', { comment: 'A comment is required when rejecting' });
      await s.db.transaction(async (tx) => {
        const now = new Date();
        if (req.body.decision === 'reject') {
          await tx.update(realtyListings).set({ approvalStatus: 'rejected', requestedStatus: null, pendingChanges: null, approvalComment: req.body.comment ?? null, approvalDecidedBy: req.user!.id, approvalDecidedAt: now, updatedAt: now }).where(eq(realtyListings.id, id));
        } else {
          if (listing.pendingChanges) await tx.update(realtyListings).set({ ...(listing.pendingChanges as Partial<Listing>), pendingChanges: null, updatedAt: now }).where(eq(realtyListings.id, id));
          if (listing.requestedStatus) {
            const [fresh] = await tx.select().from(realtyListings).where(eq(realtyListings.id, id));
            await transitionListing(tx, { listing: fresh!, office, to: listing.requestedStatus as ListingStatus, actorUserId: req.user!.id, canApprove: true, viaApproval: true, note: req.body.comment ?? 'Approved by HQ' });
          }
          await tx.update(realtyListings).set({ approvalStatus: 'approved', requestedStatus: null, approvalComment: req.body.comment ?? null, approvalDecidedBy: req.user!.id, approvalDecidedAt: now }).where(eq(realtyListings.id, id));
        }
        await audit(tx, { organizationId: orgId, ...actor(req), action: `realty.listing.${req.body.decision === 'approve' ? 'approved' : 'rejected'}`, scopeKind: 'location', scopeId: listing.locationId, targetType: 'realty_listing', targetId: id, metadata: { comment: req.body.comment, requestedStatus: listing.requestedStatus, changes: listing.pendingChanges ? Object.keys(listing.pendingChanges) : [] } });
      });
      if (req.body.decision === 'approve') await s.jobs.enqueue('realty.portal_sync', { listingId: id });
      return detail(req, orgId, id);
    });

    // ───────── Open houses ─────────
    priv.post('/orgs/:orgId/realty/listings/:id/open-houses', { schema: { tags: ['realty'], security: secured, params: idParams, body: z.object({ startsAt: isoDateTime, endsAt: isoDateTime, agentId: z.uuid().optional() }) } }, async (req, reply) => {
      const { orgId, id } = req.params;
      const { listing, office } = await loadListing(orgId, id);
      const a = await realtyAccess(req, s.db, orgId);
      const ag = (await agentsFor([id])).get(id) ?? [];
      if (!canEditListing(a, listing, ag.map((g) => g.id))) throw forbidden('Only the listing agents or an office manager can schedule open houses');
      if (!['coming_soon', 'active'].includes(listing.status)) throw conflict('listing_not_viewable', 'Open houses need a coming-soon or active listing');
      const startsAt = new Date(req.body.startsAt), endsAt = new Date(req.body.endsAt);
      if (endsAt <= startsAt) throw validationError('End must be after start', { endsAt: 'Before start' });
      const agentId = req.body.agentId ?? ag.find((g) => g.role === 'lead')?.id ?? null;
      const row = await s.db.transaction(async (tx) => {
        if (agentId) {
          await tx.select({ id: realtyAgents.id }).from(realtyAgents).where(eq(realtyAgents.id, agentId)).for('update');
          if (await agentHasConflict(tx, agentId, startsAt, endsAt, office.viewingBufferMinutes)) throw conflict('slot_unavailable', 'The agent has a viewing or open house at that time');
        }
        const [o] = await tx.insert(realtyOpenHouses).values({ organizationId: orgId, locationId: listing.locationId, listingId: id, agentId, startsAt, endsAt }).returning();
        return o!;
      });
      return reply.code(201).send({ ...row, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() });
    });

    priv.post('/orgs/:orgId/realty/open-houses/:id/cancel', { schema: { tags: ['realty'], security: secured, params: idParams } }, async (req) => {
      const [o] = await s.db.select().from(realtyOpenHouses).where(and(eq(realtyOpenHouses.id, req.params.id), eq(realtyOpenHouses.organizationId, req.params.orgId)));
      if (!o) throw notFound('Open house');
      const { listing } = await loadListing(req.params.orgId, o.listingId);
      const a = await realtyAccess(req, s.db, req.params.orgId);
      if (!canEditListing(a, listing, ((await agentsFor([listing.id])).get(listing.id) ?? []).map((g) => g.id))) throw forbidden();
      await s.db.update(realtyOpenHouses).set({ status: 'cancelled' }).where(eq(realtyOpenHouses.id, o.id));
      return { id: o.id, status: 'cancelled' };
    });

    // ───────── Contacts (vendors / landlords / buyers) ─────────
    priv.get('/orgs/:orgId/realty/contacts', { schema: { tags: ['realty'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), kind: z.enum(['vendor', 'landlord', 'buyer', 'tenant']).optional() }) } }, async (req) => {
      const a = await realtyAccess(req, s.db, req.params.orgId);
      const conds = [eq(realtyContacts.organizationId, req.params.orgId), isNull(realtyContacts.erasedAt)];
      if (req.query.locationId) conds.push(eq(realtyContacts.locationId, req.query.locationId));
      if (req.query.kind) conds.push(eq(realtyContacts.kind, req.query.kind));
      const rows = (await s.db.select().from(realtyContacts).where(and(...conds)).orderBy(asc(realtyContacts.name)))
        .filter((c) => isManagerAt(a, c.locationId) || (!!c.ownerAgentId && a.agentIds.has(c.ownerAgentId)));
      return { items: rows.map((c) => ({ id: c.id, locationId: c.locationId, kind: c.kind, name: c.name, email: c.email, phone: c.phone, notes: c.notes, ownerAgentId: c.ownerAgentId, createdAt: c.createdAt.toISOString() })) };
    });

    priv.post('/orgs/:orgId/realty/contacts', { schema: { tags: ['realty'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), kind: z.enum(['vendor', 'landlord', 'buyer', 'tenant']), name: z.string().min(1).max(120), email: z.email().optional(), phone: z.string().max(40).optional(), notes: z.string().max(2000).optional(), ownerAgentId: z.uuid().optional() }) } }, async (req, reply) => {
      const { orgId } = req.params;
      await loadLocation(orgId, req.body.locationId);
      const a = await realtyAccess(req, s.db, orgId);
      if (!locationAllowed(a.opsWrite, req.body.locationId)) throw forbidden('Missing permission operations.write for this office');
      const mine = a.agents.find((g) => g.locationId === req.body.locationId);
      if (!isManagerAt(a, req.body.locationId) && !mine) throw forbidden('Only agents and managers at this office can add contacts');
      const owner = isManagerAt(a, req.body.locationId) ? req.body.ownerAgentId ?? mine?.id ?? null : mine!.id;
      const [c] = await s.db.insert(realtyContacts).values({ organizationId: orgId, locationId: req.body.locationId, kind: req.body.kind, name: req.body.name, email: req.body.email ?? null, phone: req.body.phone ?? null, notes: req.body.notes ?? null, ownerAgentId: owner }).returning();
      return reply.code(201).send(c);
    });

    // ───────── Enquiries ─────────
    const enquiryView = (e: typeof realtyEnquiries.$inferSelect, extra: { listing?: { title: string; reference: string } | null; agentName?: string | null }) => ({
      id: e.id, locationId: e.locationId, listingId: e.listingId, listing: extra.listing ?? null, source: e.source, kind: e.kind, name: e.name, email: e.email, phone: e.phone, message: e.message,
      assignedAgentId: e.assignedAgentId, agentName: extra.agentName ?? null, routedBy: e.routedBy, status: e.status, firstResponseAt: e.firstResponseAt?.toISOString() ?? null, createdAt: e.createdAt.toISOString(),
    });

    /** Managers see every enquiry at their offices; agents see theirs plus the unassigned office pool. */
    const canSeeEnquiry = (a: RealtyAccess, e: typeof realtyEnquiries.$inferSelect) =>
      isManagerAt(a, e.locationId) || (!!e.assignedAgentId && a.agentIds.has(e.assignedAgentId)) || (!e.assignedAgentId && a.agents.some((g) => g.locationId === e.locationId));

    priv.get('/orgs/:orgId/realty/enquiries', {
      schema: { tags: ['realty'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), status: z.enum(ENQUIRY_STATUSES).optional(), view: z.enum(['all', 'mine', 'pool']).default('all'), listingId: z.uuid().optional() }) },
    }, async (req) => {
      const a = await realtyAccess(req, s.db, req.params.orgId);
      if (a.clients !== 'all' && a.clients.size === 0 && a.agents.length === 0) throw forbidden('Enquiries contain client details. Only agents and office managers can see them.');
      const conds = [eq(realtyEnquiries.organizationId, req.params.orgId)];
      if (req.query.locationId) conds.push(eq(realtyEnquiries.locationId, req.query.locationId));
      if (req.query.status) conds.push(eq(realtyEnquiries.status, req.query.status));
      if (req.query.listingId) conds.push(eq(realtyEnquiries.listingId, req.query.listingId));
      let rows = (await s.db.select().from(realtyEnquiries).where(and(...conds)).orderBy(desc(realtyEnquiries.createdAt)).limit(500)).filter((e) => canSeeEnquiry(a, e));
      if (req.query.view === 'mine') rows = rows.filter((e) => !!e.assignedAgentId && a.agentIds.has(e.assignedAgentId));
      if (req.query.view === 'pool') rows = rows.filter((e) => !e.assignedAgentId);
      const lids = [...new Set(rows.map((e) => e.listingId).filter((x): x is string => !!x))];
      const ls = lids.length ? await s.db.select({ id: realtyListings.id, title: realtyListings.title, reference: realtyListings.reference }).from(realtyListings).where(inArray(realtyListings.id, lids)) : [];
      const aids = [...new Set(rows.map((e) => e.assignedAgentId).filter((x): x is string => !!x))];
      const ags = aids.length ? await s.db.select({ id: realtyAgents.id, name: realtyAgents.name }).from(realtyAgents).where(inArray(realtyAgents.id, aids)) : [];
      return { items: rows.map((e) => enquiryView(e, { listing: ls.find((l) => l.id === e.listingId) ?? null, agentName: ags.find((g) => g.id === e.assignedAgentId)?.name ?? null })) };
    });

    priv.post('/orgs/:orgId/realty/enquiries', {
      schema: { tags: ['realty'], security: secured, params: orgParams, summary: 'Log an enquiry (phone, walk-in, portal). Portal leads are idempotent on externalRef.', body: z.object({ locationId: z.uuid(), listingId: z.uuid().optional(), source: z.enum(ENQUIRY_SOURCES), kind: z.enum(ENQUIRY_KINDS).default('buyer'), name: z.string().min(1).max(120), email: z.email().optional(), phone: z.string().max(40).optional(), message: z.string().max(2000).optional(), externalRef: z.string().max(120).optional(), assignTo: z.union([z.literal('auto'), z.uuid()]).default('auto') }) },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const loc = await loadLocation(orgId, req.body.locationId);
      const a = await realtyAccess(req, s.db, orgId);
      if (!locationAllowed(a.opsWrite, loc.id)) throw forbidden('Missing permission operations.write for this office');
      await officeFor(s.db, loc);
      if (req.body.listingId) {
        const { listing } = await loadListing(orgId, req.body.listingId);
        if (listing.locationId !== loc.id) throw validationError('Listing belongs to another office', { listingId: 'Different office' });
      }
      if (req.body.externalRef) {
        const [dup] = await s.db.select().from(realtyEnquiries).where(and(eq(realtyEnquiries.organizationId, orgId), eq(realtyEnquiries.source, req.body.source), eq(realtyEnquiries.externalRef, req.body.externalRef)));
        if (dup) return reply.code(200).send({ ...enquiryView(dup, {}), duplicate: true });
      }
      const e = await s.db.transaction(async (tx) => {
        let routing: { agentId: string | null; routedBy: string };
        if (req.body.assignTo === 'auto') routing = await routeEnquiry(tx, { locationId: loc.id, listingId: req.body.listingId ?? null });
        else {
          const [g] = await tx.select().from(realtyAgents).where(and(eq(realtyAgents.id, req.body.assignTo), eq(realtyAgents.locationId, loc.id), eq(realtyAgents.active, true)));
          if (!g) throw validationError('Unknown agent at this office', { assignTo: 'Not found' });
          routing = { agentId: g.id, routedBy: 'manual' };
        }
        const [row] = await tx.insert(realtyEnquiries).values({ organizationId: orgId, locationId: loc.id, listingId: req.body.listingId ?? null, source: req.body.source, kind: req.body.kind, name: req.body.name, email: req.body.email ?? null, phone: req.body.phone ?? null, message: req.body.message ?? null, externalRef: req.body.externalRef ?? null, assignedAgentId: routing.agentId, routedBy: routing.routedBy }).returning();
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'realty.enquiry.logged', scopeKind: 'location', scopeId: loc.id, targetType: 'realty_enquiry', targetId: row!.id, metadata: { routedBy: routing.routedBy, source: req.body.source } });
        return row!;
      });
      return reply.code(201).send(enquiryView(e, {}));
    });

    priv.post('/orgs/:orgId/realty/enquiries/:id/assign', { schema: { tags: ['realty'], security: secured, params: idParams, body: z.object({ agentId: z.uuid().nullable() }) } }, async (req) => {
      const { orgId, id } = req.params;
      const [e] = await s.db.select().from(realtyEnquiries).where(and(eq(realtyEnquiries.id, id), eq(realtyEnquiries.organizationId, orgId)));
      if (!e) throw notFound('Enquiry');
      const a = await realtyAccess(req, s.db, orgId);
      const claimingFromPool = !e.assignedAgentId && !!req.body.agentId && a.agentIds.has(req.body.agentId);
      if (!isManagerAt(a, e.locationId) && !claimingFromPool) throw forbidden('Agents can claim pool enquiries for themselves; reassigning needs an office manager');
      if (req.body.agentId) {
        const [g] = await s.db.select().from(realtyAgents).where(and(eq(realtyAgents.id, req.body.agentId), eq(realtyAgents.organizationId, orgId), eq(realtyAgents.active, true)));
        if (!g || g.locationId !== e.locationId) throw validationError('Choose an active agent at this office', { agentId: 'Not at this office' });
      }
      const [u] = await s.db.update(realtyEnquiries).set({ assignedAgentId: req.body.agentId, routedBy: req.body.agentId ? 'manual' : 'office_pool', updatedAt: new Date() }).where(and(eq(realtyEnquiries.id, id), claimingFromPool ? isNull(realtyEnquiries.assignedAgentId) : sql`true`)).returning();
      if (!u) throw conflict('already_claimed', 'Another agent claimed this enquiry first');
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'realty.enquiry.assigned', scopeKind: 'location', scopeId: e.locationId, targetType: 'realty_enquiry', targetId: id, metadata: { agentId: req.body.agentId } });
      return enquiryView(u, {});
    });

    priv.post('/orgs/:orgId/realty/enquiries/:id/status', { schema: { tags: ['realty'], security: secured, params: idParams, body: z.object({ status: z.enum(ENQUIRY_STATUSES) }) } }, async (req) => {
      const { orgId, id } = req.params;
      const [e] = await s.db.select().from(realtyEnquiries).where(and(eq(realtyEnquiries.id, id), eq(realtyEnquiries.organizationId, orgId)));
      if (!e) throw notFound('Enquiry');
      const a = await realtyAccess(req, s.db, orgId);
      if (!isManagerAt(a, e.locationId) && !(e.assignedAgentId && a.agentIds.has(e.assignedAgentId))) throw forbidden('Only the assigned agent or an office manager can update this enquiry');
      const now = new Date();
      const [u] = await s.db.update(realtyEnquiries).set({ status: req.body.status, firstResponseAt: e.firstResponseAt ?? (req.body.status !== 'new' ? now : null), updatedAt: now }).where(eq(realtyEnquiries.id, id)).returning();
      return enquiryView(u!, {});
    });

    // ───────── Viewings ─────────
    const viewingAccess = (a: RealtyAccess, v: { locationId: string; agentId: string }) => isManagerAt(a, v.locationId) || a.agentIds.has(v.agentId);

    priv.get('/orgs/:orgId/realty/viewings', {
      schema: { tags: ['realty'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), agentId: z.uuid().optional(), listingId: z.uuid().optional(), from: isoDateTime.optional(), to: isoDateTime.optional(), status: z.string().optional() }) },
    }, async (req) => {
      const a = await realtyAccess(req, s.db, req.params.orgId);
      const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 86400_000);
      const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 15 * 86400_000);
      const conds = [eq(realtyViewings.organizationId, req.params.orgId), gte(realtyViewings.startsAt, from), lt(realtyViewings.startsAt, to)];
      if (req.query.locationId) conds.push(eq(realtyViewings.locationId, req.query.locationId));
      if (req.query.agentId) conds.push(eq(realtyViewings.agentId, req.query.agentId));
      if (req.query.listingId) conds.push(eq(realtyViewings.listingId, req.query.listingId));
      if (req.query.status) conds.push(inArray(realtyViewings.status, req.query.status.split(',')));
      const rows = await s.db.select({ v: realtyViewings, l: realtyListings, loc: locations, agent: realtyAgents.name }).from(realtyViewings)
        .innerJoin(realtyListings, eq(realtyListings.id, realtyViewings.listingId)).innerJoin(locations, eq(locations.id, realtyViewings.locationId)).innerJoin(realtyAgents, eq(realtyAgents.id, realtyViewings.agentId))
        .where(and(...conds)).orderBy(asc(realtyViewings.startsAt));
      // Others' viewings at an agent's own office show as busy time without client details; HQ sees no client details.
      return {
        items: rows.filter(({ v }) => locationAllowed(a.ops, v.locationId) || a.agentIds.has(v.agentId))
          .map(({ v, l, loc, agent }) => ({ ...viewingView(v, { includeContact: viewingAccess(a, v), listing: l, agentName: agent, timeZone: loc.timeZone }), mine: a.agentIds.has(v.agentId), officeName: loc.name })),
      };
    });

    priv.get('/orgs/:orgId/realty/viewing-slots', { schema: { tags: ['realty'], security: secured, params: orgParams, querystring: z.object({ listingId: z.uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) } }, async (req) => {
      const { listing, office, loc } = await loadListing(req.params.orgId, req.query.listingId);
      const a = await realtyAccess(req, s.db, req.params.orgId);
      requireOps(a, listing.locationId);
      return { timeZone: loc.timeZone, slots: await viewingSlots(s.db, { listing, office, timeZone: loc.timeZone, date: req.query.date, leadMinutes: 0 }) };
    });

    priv.post('/orgs/:orgId/realty/viewings', {
      schema: { tags: ['realty'], security: secured, params: orgParams, body: z.object({ listingId: z.uuid(), startsAt: isoDateTime, agentId: z.uuid().optional(), contact: z.object({ name: z.string().min(1).max(120), email: z.email().optional(), phone: z.string().max(40).optional() }), enquiryId: z.uuid().optional(), kind: z.enum(['in_person', 'virtual']).default('in_person'), confirm: z.boolean().default(true), outsideAvailability: z.boolean().default(false) }) },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const { listing, office, loc } = await loadListing(orgId, req.body.listingId);
      const a = await realtyAccess(req, s.db, orgId);
      if (!locationAllowed(a.opsWrite, listing.locationId) && !a.agents.length) throw forbidden('Missing permission operations.write for this office');
      const agentIds = ((await agentsFor([listing.id])).get(listing.id) ?? []).map((g) => g.id);
      const manager = isManagerAt(a, listing.locationId);
      if (!manager && !agentIds.some((x) => a.agentIds.has(x)) && !(req.body.agentId && a.agentIds.has(req.body.agentId))) throw forbidden('Only the listing agents or an office manager can book viewings for this listing');
      if (req.body.agentId && !manager && !a.agentIds.has(req.body.agentId) && !agentIds.includes(req.body.agentId)) throw forbidden('You can only book your own or the listing agents’ time');
      const r = await s.db.transaction(async (tx) => {
        const out = await bookViewing(tx, { organizationId: orgId, listing, office, timeZone: loc.timeZone, startsAt: new Date(req.body.startsAt), agentId: req.body.agentId, contact: req.body.contact, enquiryId: req.body.enquiryId ?? null, kind: req.body.kind, source: 'staff', status: req.body.confirm ? 'confirmed' : 'requested', enforceAvailability: !req.body.outsideAvailability, allowAnyAgent: manager || (!!req.body.agentId && a.agentIds.has(req.body.agentId)) });
        if (req.body.enquiryId) await tx.update(realtyEnquiries).set({ status: 'viewing_booked', updatedAt: new Date() }).where(and(eq(realtyEnquiries.id, req.body.enquiryId), eq(realtyEnquiries.organizationId, orgId)));
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'realty.viewing.booked', scopeKind: 'location', scopeId: listing.locationId, targetType: 'realty_viewing', targetId: out.viewing.id });
        return out;
      });
      return reply.code(201).send(viewingView(r.viewing, { includeContact: true, listing, timeZone: loc.timeZone }));
    });

    const loadViewing = async (orgId: string, id: string) => {
      const [row] = await s.db.select({ v: realtyViewings, l: realtyListings, loc: locations }).from(realtyViewings)
        .innerJoin(realtyListings, eq(realtyListings.id, realtyViewings.listingId)).innerJoin(locations, eq(locations.id, realtyViewings.locationId))
        .where(and(eq(realtyViewings.id, id), eq(realtyViewings.organizationId, orgId)));
      if (!row) throw notFound('Viewing');
      return row;
    };

    priv.post('/orgs/:orgId/realty/viewings/:id/confirm', { schema: { tags: ['realty'], security: secured, params: idParams } }, async (req) => {
      const { v, l, loc } = await loadViewing(req.params.orgId, req.params.id);
      const a = await realtyAccess(req, s.db, req.params.orgId);
      if (!viewingAccess(a, v)) throw forbidden('Only the agent or an office manager can confirm this viewing');
      if (v.status !== 'requested') throw conflict('viewing_not_requested', `This viewing is ${v.status}`);
      const office = await officeFor(s.db, loc);
      const [u] = await s.db.transaction(async (tx) => {
        await tx.select({ id: realtyAgents.id }).from(realtyAgents).where(eq(realtyAgents.id, v.agentId)).for('update');
        if (await agentHasConflict(tx, v.agentId, v.startsAt, v.endsAt, office.viewingBufferMinutes, v.id)) throw conflict('slot_unavailable', 'The agent is no longer free at that time');
        return tx.update(realtyViewings).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(realtyViewings.id, v.id)).returning();
      });
      if (v.contactEmail) {
        const when = new Intl.DateTimeFormat(loc.locale, { timeZone: loc.timeZone, dateStyle: 'full', timeStyle: 'short' }).format(v.startsAt);
        void s.mailer.send({ to: v.contactEmail, subject: `Viewing confirmed: ${l.title}`, text: `Your viewing of ${l.title} is confirmed for ${when} (${loc.timeZone}). We will send a reminder the day before.\n\n${loc.name}`, tag: 'realty-viewing-confirmed' }).catch(() => {});
      }
      return viewingView(u!, { includeContact: true, listing: l, timeZone: loc.timeZone });
    });

    priv.post('/orgs/:orgId/realty/viewings/:id/cancel', { schema: { tags: ['realty'], security: secured, params: idParams, body: z.object({ reason: z.string().max(300).optional() }) } }, async (req) => {
      const { v, l, loc } = await loadViewing(req.params.orgId, req.params.id);
      const a = await realtyAccess(req, s.db, req.params.orgId);
      if (!viewingAccess(a, v)) throw forbidden();
      if (!['requested', 'confirmed'].includes(v.status)) throw conflict('viewing_not_active', `This viewing is ${v.status}`);
      const [u] = await s.db.update(realtyViewings).set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: req.body.reason ?? null }).where(eq(realtyViewings.id, v.id)).returning();
      if (v.contactEmail) void s.mailer.send({ to: v.contactEmail, subject: `Viewing cancelled: ${l.title}`, text: `Your viewing of ${l.title} has been cancelled${req.body.reason ? `: ${req.body.reason}` : ''}. Contact ${loc.name} to arrange another time.`, tag: 'realty-viewing-cancelled' }).catch(() => {});
      return viewingView(u!, { includeContact: true, listing: l, timeZone: loc.timeZone });
    });

    priv.post('/orgs/:orgId/realty/viewings/:id/feedback', {
      schema: { tags: ['realty'], security: secured, params: idParams, summary: 'Log the outcome and buyer feedback after the viewing', body: z.object({ outcome: z.enum(['completed', 'no_show']).default('completed'), interestLevel: z.enum(INTEREST_LEVELS).optional(), rating: z.number().int().min(1).max(5).optional(), notes: z.string().max(2000).optional() }) },
    }, async (req) => {
      const { v, l, loc } = await loadViewing(req.params.orgId, req.params.id);
      const a = await realtyAccess(req, s.db, req.params.orgId);
      if (!viewingAccess(a, v)) throw forbidden('Only the agent or an office manager can log feedback');
      if (!['confirmed', 'completed', 'requested'].includes(v.status)) throw conflict('viewing_not_active', `This viewing is ${v.status}`);
      if (v.startsAt.getTime() > Date.now()) throw conflict('viewing_in_future', 'Feedback can be logged once the viewing has started');
      const [u] = await s.db.update(realtyViewings).set({ status: req.body.outcome, interestLevel: req.body.outcome === 'completed' ? req.body.interestLevel ?? null : null, feedbackRating: req.body.rating ?? null, feedbackNotes: req.body.notes ?? null, feedbackAt: new Date(), feedbackBy: req.user!.id }).where(eq(realtyViewings.id, v.id)).returning();
      await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: 'realty.viewing.feedback', scopeKind: 'location', scopeId: v.locationId, targetType: 'realty_viewing', targetId: v.id, metadata: { outcome: req.body.outcome } });
      return viewingView(u!, { includeContact: true, listing: l, timeZone: loc.timeZone });
    });
  });
};


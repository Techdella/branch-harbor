/**
 * Real Estate — offers (negotiation with an append-only trail), reports (no client personal data, money per currency)
 * and the agent's day. Registered inside the authenticated scope by routes/realty.ts.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { OFFER_STATUSES, offerTransitionAllowed, OPEN_OFFER_STATUSES, type OfferStatus } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { locations, realtyAgents, realtyEnquiries, realtyListingAgents, realtyListings, realtyOfferEvents, realtyOffers, realtyOpenHouses, realtyViewings } from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { localDateParts, zonedToUtc } from '../lib/tz.ts';
import { actor, audit } from '../services/audit.ts';
import { locationAllowed, requirePerm, type ScopeTarget } from '../services/authz.ts';
import { canSeeOffer, isManagerAt, listingAgentRows, officeFor, realtyAccess, transitionListing, viewingView, type Offer, type RealtyAccess } from '../services/realty.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

type Ev = typeof realtyOfferEvents.$inferSelect;

export const realtyDealRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  const listingAgentIds = async (listingId: string) => (await listingAgentRows(s.db, [listingId])).map((r) => r.agent.id);
  const offerView = (o: Offer, events?: Ev[], agentName?: string | null) => ({
    id: o.id, listingId: o.listingId, locationId: o.locationId, buyerName: o.buyerName, buyerContactId: o.buyerContactId, enquiryId: o.enquiryId, submittedByAgentId: o.submittedByAgentId, submittedByAgentName: agentName ?? null,
    amount: { amount: o.amountMinor, currency: o.currency }, deposit: o.depositMinor != null ? { amount: o.depositMinor, currency: o.currency } : null, conditions: o.conditions,
    expiresAt: o.expiresAt?.toISOString() ?? null, status: o.status, createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString(),
    events: events?.map((e) => ({ id: e.id, action: e.action, party: e.party, amount: e.amountMinor != null ? { amount: e.amountMinor, currency: e.currency } : null, conditions: e.conditions, note: e.note, actorUserId: e.actorUserId, at: e.at.toISOString() })),
  });

  const loadListing = async (orgId: string, id: string) => {
    const [row] = await s.db.select({ l: realtyListings, loc: locations }).from(realtyListings).innerJoin(locations, eq(locations.id, realtyListings.locationId)).where(and(eq(realtyListings.id, id), eq(realtyListings.organizationId, orgId)));
    if (!row) throw notFound('Listing');
    return row;
  };

  // ───────── Offers ─────────
  app.get('/orgs/:orgId/realty/listings/:id/offers', { schema: { tags: ['realty'], security: secured, params: idParams, summary: 'Offers on a listing — visible to its listing agents and office managers; other agents see only offers they recorded' } }, async (req) => {
    const { l } = await loadListing(req.params.orgId, req.params.id);
    const a = await realtyAccess(req, s.db, req.params.orgId);
    const lag = await listingAgentIds(l.id);
    const rows = await s.db.select().from(realtyOffers).where(eq(realtyOffers.listingId, l.id)).orderBy(desc(realtyOffers.createdAt));
    const visible = rows.filter((o) => canSeeOffer(a, l, lag, o));
    if (!visible.length && !canSeeOffer(a, l, lag)) throw forbidden('Offers are visible only to the listing agents and office managers');
    const events = visible.length ? await s.db.select().from(realtyOfferEvents).where(inArray(realtyOfferEvents.offerId, visible.map((o) => o.id))).orderBy(asc(realtyOfferEvents.at)) : [];
    return { listing: { id: l.id, title: l.title, reference: l.reference, status: l.status, price: { amount: l.priceMinor, currency: l.currency } }, items: visible.map((o) => offerView(o, events.filter((e) => e.offerId === o.id))) };
  });

  app.get('/orgs/:orgId/realty/offers', { schema: { tags: ['realty'], security: secured, params: orgParams, querystring: z.object({ status: z.enum(OFFER_STATUSES).optional(), locationId: z.uuid().optional(), open: z.coerce.boolean().optional() }) } }, async (req) => {
    const a = await realtyAccess(req, s.db, req.params.orgId);
    const conds = [eq(realtyOffers.organizationId, req.params.orgId)];
    if (req.query.status) conds.push(eq(realtyOffers.status, req.query.status));
    if (req.query.open) conds.push(inArray(realtyOffers.status, [...OPEN_OFFER_STATUSES]));
    if (req.query.locationId) conds.push(eq(realtyOffers.locationId, req.query.locationId));
    const rows = await s.db.select({ o: realtyOffers, l: realtyListings }).from(realtyOffers).innerJoin(realtyListings, eq(realtyListings.id, realtyOffers.listingId)).where(and(...conds)).orderBy(desc(realtyOffers.updatedAt)).limit(300);
    const agentsByListing = new Map<string, string[]>();
    for (const r of await listingAgentRows(s.db, [...new Set(rows.map((r) => r.l.id))])) agentsByListing.set(r.la.listingId, [...(agentsByListing.get(r.la.listingId) ?? []), r.agent.id]);
    const visible = rows.filter(({ o, l }) => canSeeOffer(a, l, agentsByListing.get(l.id) ?? [], o));
    const ags = await s.db.select({ id: realtyAgents.id, name: realtyAgents.name }).from(realtyAgents).where(eq(realtyAgents.organizationId, req.params.orgId));
    return { items: visible.map(({ o, l }) => ({ ...offerView(o, undefined, ags.find((g) => g.id === o.submittedByAgentId)?.name), listing: { id: l.id, title: l.title, reference: l.reference, status: l.status, price: { amount: l.priceMinor, currency: l.currency } } })) };
  });

  app.get('/orgs/:orgId/realty/offers/:id', { schema: { tags: ['realty'], security: secured, params: idParams } }, async (req) => {
    const [o] = await s.db.select().from(realtyOffers).where(and(eq(realtyOffers.id, req.params.id), eq(realtyOffers.organizationId, req.params.orgId)));
    if (!o) throw notFound('Offer');
    const { l } = await loadListing(req.params.orgId, o.listingId);
    const a = await realtyAccess(req, s.db, req.params.orgId);
    // 404, not 403: an unauthorised agent should not learn that an offer exists.
    if (!canSeeOffer(a, l, await listingAgentIds(l.id), o)) throw notFound('Offer');
    const events = await s.db.select().from(realtyOfferEvents).where(eq(realtyOfferEvents.offerId, o.id)).orderBy(asc(realtyOfferEvents.at));
    return offerView(o, events);
  });

  app.post('/orgs/:orgId/realty/listings/:id/offers', {
    schema: {
      tags: ['realty'], security: secured, params: idParams, summary: 'Record an offer for a buyer. Amount is in the listing currency.',
      body: z.object({ buyerName: z.string().min(1).max(120), buyerContactId: z.uuid().optional(), enquiryId: z.uuid().optional(), amountMinor: z.number().int().min(1), currency: z.string().length(3), depositMinor: z.number().int().min(0).optional(), conditions: z.array(z.string().min(1).max(300)).max(20).default([]), expiresAt: isoDateTime.optional(), submittedByAgentId: z.uuid().optional(), note: z.string().max(1000).optional() }),
    },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const { l } = await loadListing(orgId, id);
    const a = await realtyAccess(req, s.db, orgId);
    if (!['active', 'under_offer'].includes(l.status)) throw conflict('listing_not_accepting_offers', `Offers can be recorded on active or under-offer listings (this one is ${l.status.replace('_', ' ')})`);
    if (req.body.currency !== l.currency) throw validationError(`Offers on this listing are in ${l.currency}`, { currency: `Must be ${l.currency}` });
    const manager = isManagerAt(a, l.locationId);
    const myAgent = a.agents.find((g) => g.locationId === l.locationId) ?? a.agents[0];
    if (!manager && !myAgent) throw forbidden('Only agents and office managers can record offers');
    if (!manager && !locationAllowed(a.opsWrite, l.locationId) && !(await listingAgentIds(l.id)).some((x) => a.agentIds.has(x))) throw forbidden('Missing permission operations.write for this office');
    const submittedBy = manager ? req.body.submittedByAgentId ?? myAgent?.id ?? null : myAgent!.id;
    if (req.body.submittedByAgentId && !manager && req.body.submittedByAgentId !== myAgent?.id) throw forbidden('Agents record offers for their own buyers');
    const o = await s.db.transaction(async (tx) => {
      const [row] = await tx.insert(realtyOffers).values({
        organizationId: orgId, locationId: l.locationId, listingId: l.id, buyerName: req.body.buyerName, buyerContactId: req.body.buyerContactId ?? null, enquiryId: req.body.enquiryId ?? null,
        submittedByAgentId: submittedBy, amountMinor: req.body.amountMinor, currency: l.currency, depositMinor: req.body.depositMinor ?? null, conditions: req.body.conditions,
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null, createdBy: req.user!.id,
      }).returning();
      await tx.insert(realtyOfferEvents).values({ organizationId: orgId, offerId: row!.id, action: 'submitted', party: 'buyer', amountMinor: row!.amountMinor, currency: row!.currency, conditions: row!.conditions, note: req.body.note ?? null, actorUserId: req.user!.id });
      if (req.body.enquiryId) await tx.update(realtyEnquiries).set({ status: 'offer_made', updatedAt: new Date() }).where(and(eq(realtyEnquiries.id, req.body.enquiryId), eq(realtyEnquiries.organizationId, orgId)));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'realty.offer.submitted', scopeKind: 'location', scopeId: l.locationId, targetType: 'realty_offer', targetId: row!.id, metadata: { amountMinor: row!.amountMinor, currency: row!.currency } });
      return row!;
    });
    const events = await s.db.select().from(realtyOfferEvents).where(eq(realtyOfferEvents.offerId, o.id));
    return reply.code(201).send(offerView(o, events));
  });

  const ACTION_TO: Record<string, OfferStatus | null> = { counter: 'countered', revise: 'submitted', accept: 'accepted', reject: 'rejected', withdraw: 'withdrawn', note: null };
  const VENDOR_SIDE = new Set(['counter', 'accept', 'reject']);

  app.post('/orgs/:orgId/realty/offers/:id/actions', {
    schema: {
      tags: ['realty'], security: secured, params: idParams,
      summary: 'Negotiate: counter/accept/reject (listing agents or managers, for the vendor), revise/withdraw (the buyer’s agent or managers), note. Accepting moves the listing under offer.',
      body: z.object({ action: z.enum(['counter', 'revise', 'accept', 'reject', 'withdraw', 'note']), amountMinor: z.number().int().min(1).optional(), conditions: z.array(z.string().min(1).max(300)).max(20).optional(), note: z.string().max(1000).optional() }),
    },
  }, async (req) => {
    const { orgId, id } = req.params;
    const [o] = await s.db.select().from(realtyOffers).where(and(eq(realtyOffers.id, id), eq(realtyOffers.organizationId, orgId)));
    if (!o) throw notFound('Offer');
    const { l, loc } = await loadListing(orgId, o.listingId);
    const a = await realtyAccess(req, s.db, orgId);
    const lag = await listingAgentIds(l.id);
    if (!canSeeOffer(a, l, lag, o)) throw notFound('Offer');
    const manager = isManagerAt(a, l.locationId);
    const listingSide = manager || lag.some((x) => a.agentIds.has(x));
    const buyerSide = manager || (!!o.submittedByAgentId && a.agentIds.has(o.submittedByAgentId));
    const act = req.body.action;
    if (VENDOR_SIDE.has(act) && !listingSide) throw forbidden('Only the listing agents or an office manager can respond for the vendor');
    if ((act === 'revise' || act === 'withdraw') && !buyerSide) throw forbidden('Only the buyer’s agent or an office manager can change or withdraw this offer');
    const to = ACTION_TO[act]!;
    if (to && !offerTransitionAllowed(o.status as OfferStatus, to)) throw conflict('invalid_offer_transition', `An offer that is ${o.status} cannot be ${act === 'accept' ? 'accepted' : act + 'ed'}`, { from: o.status, action: act });
    if ((act === 'counter' || act === 'revise') && !req.body.amountMinor) throw validationError('Enter the amount', { amountMinor: 'Required' });
    if (act === 'accept' && !['active', 'under_offer'].includes(l.status)) throw conflict('listing_not_accepting_offers', `The listing is ${l.status.replace('_', ' ')}`);
    const updated = await s.db.transaction(async (tx) => {
      const now = new Date();
      let row = o;
      if (to) {
        const [u] = await tx.update(realtyOffers).set({ status: to, amountMinor: req.body.amountMinor ?? o.amountMinor, conditions: req.body.conditions ?? o.conditions, updatedAt: now })
          .where(and(eq(realtyOffers.id, o.id), eq(realtyOffers.status, o.status))).returning().catch((err: { code?: string; cause?: { code?: string } }) => {
            if (err.code === '23505' || err.cause?.code === '23505') throw conflict('offer_already_accepted', 'Another offer on this listing is already accepted. Withdraw it first.');
            throw err;
          });
        if (!u) throw conflict('offer_changed', 'The offer changed while you were responding. Reload and try again.');
        row = u;
      }
      await tx.insert(realtyOfferEvents).values({
        organizationId: orgId, offerId: o.id, action: act === 'accept' ? 'accepted' : act === 'reject' ? 'rejected' : act === 'withdraw' ? 'withdrawn' : act === 'counter' ? 'countered' : act === 'revise' ? 'revised' : 'note',
        party: act === 'note' ? 'agent' : VENDOR_SIDE.has(act) ? 'vendor' : 'buyer', amountMinor: req.body.amountMinor ?? null, currency: req.body.amountMinor ? o.currency : null, conditions: req.body.conditions ?? null, note: req.body.note ?? null, actorUserId: req.user!.id,
      });
      const office = await officeFor(tx, loc);
      if (act === 'accept' && l.status === 'active') await transitionListing(tx, { listing: l, office, to: 'under_offer', actorUserId: req.user!.id, canApprove: true, note: 'Offer accepted' });
      if (act === 'withdraw' && o.status === 'accepted' && l.status === 'under_offer') await transitionListing(tx, { listing: l, office, to: 'active', actorUserId: req.user!.id, canApprove: true, note: 'Accepted offer withdrawn' });
      await audit(tx, { organizationId: orgId, ...actor(req), action: `realty.offer.${act}`, scopeKind: 'location', scopeId: l.locationId, targetType: 'realty_offer', targetId: o.id, metadata: { from: o.status, to: row.status, amountMinor: req.body.amountMinor ?? null, currency: o.currency } });
      return row;
    });
    const events = await s.db.select().from(realtyOfferEvents).where(eq(realtyOfferEvents.offerId, o.id)).orderBy(asc(realtyOfferEvents.at));
    return offerView(updated, events);
  });

  // ───────── Reports ─────────
  app.get('/orgs/:orgId/realty/reports', {
    schema: {
      tags: ['realty'], security: secured, params: orgParams,
      summary: 'Active listings, days on market, enquiry → viewing → offer funnel and sold/let volume per currency (never combined). Aggregates only — no client personal data.',
      querystring: z.object({ scopeKind: z.enum(['organization', 'region', 'owner_group', 'location']).default('organization'), scopeId: z.uuid().optional(), from: isoDateTime.optional(), to: isoDateTime.optional() }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    const scope: ScopeTarget = { organizationId: orgId, kind: req.query.scopeKind, id: req.query.scopeKind === 'organization' ? orgId : req.query.scopeId ?? '' };
    if (scope.kind !== 'organization' && !req.query.scopeId) throw validationError('scopeId is required', { scopeId: 'Required' });
    const a = await realtyAccess(req, s.db, orgId);
    const locs = (await s.db.select().from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt))))
      .filter((l) => scope.kind === 'organization' || (scope.kind === 'region' && l.regionId === scope.id) || (scope.kind === 'owner_group' && l.ownerGroupId === scope.id) || (scope.kind === 'location' && l.id === scope.id))
      .filter((l) => locationAllowed(a.reports, l.id));
    if (!locs.length) {
      await requirePerm(req, s.db, 'reports.read', scope);
      return { scope, period: null, locations: [], network: null };
    }
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 90 * 86400_000);
    const ids = locs.map((l) => l.id);
    const listings = await s.db.select().from(realtyListings).where(inArray(realtyListings.locationId, ids));
    const enq = await s.db.select({ loc: realtyEnquiries.locationId, n: sql<number>`count(*)::int` }).from(realtyEnquiries).where(and(inArray(realtyEnquiries.locationId, ids), gte(realtyEnquiries.createdAt, from), lt(realtyEnquiries.createdAt, to))).groupBy(realtyEnquiries.locationId);
    const vw = await s.db.select({ loc: realtyViewings.locationId, status: realtyViewings.status, n: sql<number>`count(*)::int` }).from(realtyViewings).where(and(inArray(realtyViewings.locationId, ids), gte(realtyViewings.createdAt, from), lt(realtyViewings.createdAt, to))).groupBy(realtyViewings.locationId, realtyViewings.status);
    const of = await s.db.select({ loc: realtyOffers.locationId, status: realtyOffers.status, n: sql<number>`count(*)::int` }).from(realtyOffers).where(and(inArray(realtyOffers.locationId, ids), gte(realtyOffers.createdAt, from), lt(realtyOffers.createdAt, to))).groupBy(realtyOffers.locationId, realtyOffers.status);
    const now = Date.now();
    const median = (xs: number[]) => { if (!xs.length) return null; const v = [...xs].sort((p, q) => p - q); const m = Math.floor(v.length / 2); return v.length % 2 ? v[m]! : Math.round((v[m - 1]! + v[m]!) / 2); };
    const volumes = (rows: typeof listings) => {
      const map = new Map<string, { currency: string; count: number; volumeMinor: number }>();
      for (const l of rows) { const c = map.get(l.currency) ?? { currency: l.currency, count: 0, volumeMinor: 0 }; c.count++; c.volumeMinor += l.closedPriceMinor ?? l.priceMinor; map.set(l.currency, c); }
      return [...map.values()].sort((x, y) => x.currency.localeCompare(y.currency));
    };
    const per = locs.map((loc) => {
      const ls = listings.filter((l) => l.locationId === loc.id);
      const live = ls.filter((l) => l.status === 'active' || l.status === 'under_offer');
      const domLive = live.filter((l) => l.firstActiveAt).map((l) => Math.floor((now - l.firstActiveAt!.getTime()) / 86400_000));
      const closed = ls.filter((l) => l.closedAt && l.closedAt >= from && l.closedAt < to);
      const domClosed = closed.filter((l) => l.firstActiveAt).map((l) => Math.floor((l.closedAt!.getTime() - l.firstActiveAt!.getTime()) / 86400_000));
      const viewings = vw.filter((x) => x.loc === loc.id && x.status !== 'cancelled').reduce((n, x) => n + x.n, 0);
      const offers = of.filter((x) => x.loc === loc.id).reduce((n, x) => n + x.n, 0);
      const enquiries = enq.find((x) => x.loc === loc.id)?.n ?? 0;
      return {
        locationId: loc.id, name: loc.name, country: loc.country, currency: loc.currency,
        listings: { comingSoon: ls.filter((l) => l.status === 'coming_soon').length, active: ls.filter((l) => l.status === 'active').length, underOffer: ls.filter((l) => l.status === 'under_offer').length, draft: ls.filter((l) => l.status === 'draft').length, awaitingApproval: ls.filter((l) => l.approvalStatus === 'pending').length },
        daysOnMarket: { liveMedian: median(domLive), liveCount: domLive.length, closedMedian: median(domClosed), closedCount: domClosed.length },
        funnel: { enquiries, viewings, offers, acceptedOffers: of.filter((x) => x.loc === loc.id && x.status === 'accepted').reduce((n, x) => n + x.n, 0), enquiryToViewing: enquiries ? Math.round((viewings / enquiries) * 1000) / 10 : null, viewingToOffer: viewings ? Math.round((offers / viewings) * 1000) / 10 : null },
        sold: volumes(closed.filter((l) => l.status === 'sold')), let: volumes(closed.filter((l) => l.status === 'let')),
      };
    });
    const merge = (key: 'sold' | 'let') => {
      const map = new Map<string, { currency: string; count: number; volumeMinor: number }>();
      for (const p of per) for (const v of p[key]) { const c = map.get(v.currency) ?? { currency: v.currency, count: 0, volumeMinor: 0 }; c.count += v.count; c.volumeMinor += v.volumeMinor; map.set(v.currency, c); }
      return [...map.values()].sort((x, y) => x.currency.localeCompare(y.currency));
    };
    const sum = (f: (p: (typeof per)[number]) => number) => per.reduce((n, p) => n + f(p), 0);
    const allLiveDom = listings.filter((l) => (l.status === 'active' || l.status === 'under_offer') && l.firstActiveAt).map((l) => Math.floor((now - l.firstActiveAt!.getTime()) / 86400_000));
    return {
      scope, period: { from: from.toISOString(), to: to.toISOString() }, generatedAt: new Date().toISOString(), source: 'BranchHarbor listings, enquiries, viewings and offers',
      definitions: { daysOnMarket: 'Days since the listing first became active (closed listings: until sold/let).', funnel: 'Records created in the period. Viewings exclude cancelled ones.', volume: 'Final price of listings sold/let in the period, in the listing currency. Currencies are never combined.' },
      locations: per,
      network: {
        listings: { active: sum((p) => p.listings.active), underOffer: sum((p) => p.listings.underOffer), comingSoon: sum((p) => p.listings.comingSoon), awaitingApproval: sum((p) => p.listings.awaitingApproval) },
        daysOnMarket: { liveMedian: median(allLiveDom), liveCount: allLiveDom.length },
        funnel: { enquiries: sum((p) => p.funnel.enquiries), viewings: sum((p) => p.funnel.viewings), offers: sum((p) => p.funnel.offers), acceptedOffers: sum((p) => p.funnel.acceptedOffers) },
        sold: merge('sold'), let: merge('let'), combinedVolume: null, combinedVolumeNote: 'Not shown — no currency conversion method is defined.',
      },
    };
  });

  // ───────── Agent's day ─────────
  app.get('/orgs/:orgId/realty/my-day', { schema: { tags: ['realty'], security: secured, params: orgParams, summary: 'Today’s viewings (office time zone), new enquiries (mine + office pool), offers awaiting a response and upcoming open houses' } }, async (req) => {
    const { orgId } = req.params;
    const a = await realtyAccess(req, s.db, orgId);
    return myDay(a, orgId);
  });

  async function myDay(a: RealtyAccess, orgId: string) {
    const agentIds = [...a.agentIds];
    const locIds = [...new Set(a.agents.map((g) => g.locationId))];
    if (!agentIds.length) return { agents: [], viewings: [], enquiries: [], offers: [], openHouses: [], note: 'You do not have an agent profile in this organisation.' };
    const locs = await s.db.select().from(locations).where(inArray(locations.id, locIds));
    const now = new Date();
    const windows = locs.map((l) => { const d = localDateParts(now, l.timeZone).date; const start = zonedToUtc(d, '00:00', l.timeZone); return { id: l.id, start, end: new Date(start.getTime() + 24 * 3600_000), tz: l.timeZone, date: d }; });
    const minStart = new Date(Math.min(...windows.map((w) => w.start.getTime()))), maxEnd = new Date(Math.max(...windows.map((w) => w.end.getTime())));
    const vs = await s.db.select({ v: realtyViewings, l: realtyListings }).from(realtyViewings).innerJoin(realtyListings, eq(realtyListings.id, realtyViewings.listingId))
      .where(and(inArray(realtyViewings.agentId, agentIds), gte(realtyViewings.startsAt, minStart), lt(realtyViewings.startsAt, maxEnd), inArray(realtyViewings.status, ['requested', 'confirmed', 'completed', 'no_show']))).orderBy(asc(realtyViewings.startsAt));
    const todays = vs.filter(({ v }) => { const w = windows.find((x) => x.id === v.locationId); return !!w && v.startsAt >= w.start && v.startsAt < w.end; });
    const enqs = await s.db.select().from(realtyEnquiries).where(and(eq(realtyEnquiries.organizationId, orgId), inArray(realtyEnquiries.locationId, locIds), eq(realtyEnquiries.status, 'new'))).orderBy(desc(realtyEnquiries.createdAt)).limit(50);
    const mineOrPool = enqs.filter((e) => !e.assignedAgentId || a.agentIds.has(e.assignedAgentId));
    const myListings = [...new Set((await s.db.select({ listingId: realtyListingAgents.listingId }).from(realtyListingAgents).where(inArray(realtyListingAgents.agentId, agentIds))).map((r) => r.listingId))];
    const offers = myListings.length ? await s.db.select({ o: realtyOffers, l: realtyListings }).from(realtyOffers).innerJoin(realtyListings, eq(realtyListings.id, realtyOffers.listingId)).where(and(inArray(realtyOffers.listingId, myListings), eq(realtyOffers.status, 'submitted'))).orderBy(asc(realtyOffers.createdAt)) : [];
    const oh = await s.db.select({ o: realtyOpenHouses, l: realtyListings }).from(realtyOpenHouses).innerJoin(realtyListings, eq(realtyListings.id, realtyOpenHouses.listingId)).where(and(inArray(realtyOpenHouses.agentId, agentIds), eq(realtyOpenHouses.status, 'scheduled'), gte(realtyOpenHouses.endsAt, now))).orderBy(asc(realtyOpenHouses.startsAt)).limit(10);
    const lt2 = new Map(locs.map((l) => [l.id, l.timeZone]));
    const listingTitles = new Map<string, string>();
    for (const e of mineOrPool) if (e.listingId && !listingTitles.has(e.listingId)) listingTitles.set(e.listingId, '');
    const titles = listingTitles.size ? await s.db.select({ id: realtyListings.id, title: realtyListings.title }).from(realtyListings).where(inArray(realtyListings.id, [...listingTitles.keys()])) : [];
    return {
      agents: a.agents.map((g) => ({ id: g.id, name: g.name, locationId: g.locationId })), dates: windows.map((w) => ({ locationId: w.id, date: w.date, timeZone: w.tz })),
      viewings: todays.map(({ v, l }) => viewingView(v, { includeContact: true, listing: l, timeZone: lt2.get(v.locationId) ?? null })),
      enquiries: mineOrPool.map((e) => ({ id: e.id, name: e.name, kind: e.kind, source: e.source, message: e.message, listingId: e.listingId, listingTitle: titles.find((t) => t.id === e.listingId)?.title ?? null, assignedToMe: !!e.assignedAgentId, createdAt: e.createdAt.toISOString(), email: e.email, phone: e.phone })),
      offers: offers.filter(({ o, l }) => canSeeOffer(a, l, myListings.includes(l.id) ? agentIds : [], o)).map(({ o, l }) => ({ ...offerView(o), listing: { id: l.id, title: l.title, reference: l.reference } })),
      openHouses: oh.map(({ o, l }) => ({ id: o.id, listingId: l.id, title: l.title, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(), timeZone: lt2.get(o.locationId) ?? null })),
    };
  }
};

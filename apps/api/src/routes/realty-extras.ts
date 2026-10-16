/**
 * Real Estate — portal syndication (Rightmove RTDF push, idealista / Zillow-RESO / REAXML hosted feeds; per-listing opt-in, per-office status), Marina proposals and
 * housekeeping jobs. Registered inside the authenticated scope by routes/realty.ts.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { findProtectedTargeting, PUBLIC_LISTING_STATUSES } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { locations, organizations, realtyAgents, realtyAiProposals, realtyListingAgents, realtyListings, realtyListingPortalFields, realtyOffices, realtySyndication } from '../db/schema/index.ts';
import { LEGACY_PORTAL_IDS, normalizePortalId, PORTAL_ADAPTERS, PORTAL_IDS } from '../integrations/realty-portals.ts';
import { lastSyncs, partnerConnection, partnerCredentials, partnerStatus } from '../services/partner-connections.ts';
import { exportPortal, feedListings, officeConnections, officeFeed, optOutRemoval, syndicationIssues } from '../services/realty-portals.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { actor, audit } from '../services/audit.ts';
import { locationAllowed, requirePerm } from '../services/authz.ts';
import { canEditListing, isManagerAt, listingAgentRows, officeFor, realtyAccess } from '../services/realty.ts';
import { draftListingDescription, proposeFollowUps, summariseFeedback } from '../services/realty-ai.ts';
import { runSavedSearchAlerts, runViewingReminders } from '../services/realty-jobs.ts';
import { idParams, orgParams, secured } from './_common.ts';

const portalParam = z.enum([...PORTAL_IDS, ...Object.keys(LEGACY_PORTAL_IDS)] as [string, ...string[]]);

export const realtyExtraRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  const loadListing = async (orgId: string, id: string) => {
    const [row] = await s.db.select({ l: realtyListings, loc: locations }).from(realtyListings).innerJoin(locations, eq(locations.id, realtyListings.locationId)).where(and(eq(realtyListings.id, id), eq(realtyListings.organizationId, orgId)));
    if (!row) throw notFound('Listing');
    return row;
  };
  const agentIdsOf = async (listingId: string) => (await listingAgentRows(s.db, [listingId])).map((r) => r.agent.id);

  // ───────── Syndication (portal feeds) ─────────
  const scopedLocationIds = (a: Awaited<ReturnType<typeof realtyAccess>>, locs: Array<{ id: string }>) => locs.filter((l) => locationAllowed(a.ops, l.id)).map((l) => l.id);
  const realtyLocations = async (orgId: string) => s.db.select({ id: locations.id, name: locations.name, country: locations.country }).from(locations).innerJoin(realtyOffices, eq(realtyOffices.locationId, locations.id)).where(eq(locations.organizationId, orgId));

  app.get('/orgs/:orgId/realty/syndication/portals', { schema: { tags: ['realty'], security: secured, params: orgParams, summary: 'Portal feeds with a status per office (not configured / sandbox / live) and the last push result. Nothing is ever reported live without credentials.' } }, async (req) => {
    const { orgId } = req.params;
    const a = await realtyAccess(req, s.db, orgId);
    const locs = (await realtyLocations(orgId)).filter((l) => locationAllowed(a.ops, l.id));
    const optRows = await s.db.select({ x: realtySyndication, locationId: realtyListings.locationId }).from(realtySyndication).innerJoin(realtyListings, eq(realtyListings.id, realtySyndication.listingId)).where(and(eq(realtySyndication.organizationId, orgId), eq(realtySyndication.optedIn, true)));
    const visible = optRows.filter((r) => locationAllowed(a.ops, r.locationId));
    const items = [];
    for (const p of Object.values(PORTAL_ADAPTERS)) {
      const conns = await officeConnections(s, orgId, p.id);
      const syncs = await lastSyncs(s, conns.map((c) => c.id));
      const offices = locs.filter((l) => p.countries.includes(l.country)).map((l) => {
        const c = conns.find((x) => x.locationId === l.id);
        const st = partnerStatus(c, c ? partnerCredentials(s, c) : {});
        const last = c ? syncs.get(c.id) : undefined;
        return {
          locationId: l.id, name: l.name, country: l.country, connectionId: c?.id ?? null, status: st.status, statusReason: st.reason,
          lastPush: last ? { at: last.createdAt.toISOString(), action: last.action, status: last.status, message: last.message } : null,
          lastFetchedAt: (c?.config.lastFetchedAt as string) ?? null,
        };
      });
      const mine = visible.filter((x) => normalizePortalId(x.x.portal) === p.id);
      const liveCount = offices.filter((o) => o.status === 'live').length;
      items.push({
        id: p.id, name: p.name, description: p.description, format: p.format, countries: p.countries, delivery: p.delivery,
        live: liveCount > 0, mode: liveCount > 0 ? 'live' : 'sandbox',
        status: liveCount > 0 ? `Live for ${liveCount} office(s)` : offices.some((o) => o.connectionId) ? 'Sandbox — nothing is transmitted' : 'Not configured — sandbox preview only',
        offices, optedInListings: mine.length, invalidListings: mine.filter((x) => x.x.lastStatus === 'invalid' || x.x.lastStatus === 'error').length,
        lastExportedAt: mine.filter((x) => x.x.lastExportedAt).map((x) => x.x.lastExportedAt!.toISOString()).sort().pop() ?? null,
      });
    }
    return { items };
  });

  app.get('/orgs/:orgId/realty/syndication/listings', { schema: { tags: ['realty'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }), summary: 'Opted-in listings with fresh per-portal validation errors and the last delivery result' } }, async (req) => {
    const { orgId } = req.params;
    const a = await realtyAccess(req, s.db, orgId);
    const ids = scopedLocationIds(a, await realtyLocations(orgId)).filter((id) => !req.query.locationId || id === req.query.locationId);
    return { items: await syndicationIssues(s, orgId, ids) };
  });

  app.put('/orgs/:orgId/realty/listings/:id/syndication/:portal', {
    schema: { tags: ['realty'], security: secured, params: idParams.extend({ portal: portalParam }), body: z.object({ optedIn: z.boolean() }), summary: 'Opt a listing in or out of a portal feed. Opting out removes it from the portal (push) or the feed (pull).' },
  }, async (req) => {
    const { orgId, id } = req.params;
    const portal = normalizePortalId(req.params.portal)!;
    const { l } = await loadListing(orgId, id);
    const a = await realtyAccess(req, s.db, orgId);
    if (!canEditListing(a, l, await agentIdsOf(l.id))) throw forbidden('Only the listing agents or an office manager can change syndication');
    const adapter = PORTAL_ADAPTERS[portal];
    if (req.body.optedIn && !adapter.countries.includes(l.country)) throw validationError(`${adapter.name} only accepts listings in ${adapter.countries.join(', ')}`, { portal: 'Country not supported by this feed' });
    const [feed] = await feedListings(s, orgId, [l.id]);
    const issues = adapter.validate(feed!);
    const [prev] = await s.db.select().from(realtySyndication).where(and(eq(realtySyndication.listingId, l.id), eq(realtySyndication.portal, portal)));
    const v = { organizationId: orgId, listingId: l.id, portal, optedIn: req.body.optedIn, lastIssues: issues, ...(req.body.optedIn && issues.length ? { lastStatus: 'invalid' } : {}), updatedBy: req.user!.id, updatedAt: new Date() };
    const [row] = await s.db.insert(realtySyndication).values(v).onConflictDoUpdate({ target: [realtySyndication.listingId, realtySyndication.portal], set: v }).returning();
    let removal: { status: string; message: string | null } | null = null;
    if (!req.body.optedIn && prev?.optedIn && ['published', 'sandbox_exported', 'error'].includes(prev.lastStatus)) removal = await optOutRemoval(s, orgId, l.id, portal);
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'realty.syndication.opt', scopeKind: 'location', scopeId: l.locationId, targetType: 'realty_listing', targetId: l.id, metadata: { portal, optedIn: req.body.optedIn } });
    const conn = await partnerConnection(s, portal, l.locationId);
    const st = partnerStatus(conn, conn ? partnerCredentials(s, conn) : {});
    return { portal, optedIn: row!.optedIn, issues, removal, officeStatus: st.status, mode: st.status === 'live' ? 'live' : 'sandbox', live: st.status === 'live' };
  });

  app.put('/orgs/:orgId/realty/listings/:id/portal-fields', {
    schema: {
      tags: ['realty'], security: secured, params: idParams, summary: 'Portal facts supplied by the business (price qualifier, tenure, council tax band, energy rating, availability)',
      body: z.object({
        priceQualifier: z.enum(['default', 'poa', 'guide_price', 'fixed_price', 'offers_in_excess_of', 'oiro', 'offers_over', 'from', 'coming_soon', 'sale_by_tender']).nullable().optional(),
        tenure: z.enum(['freehold', 'leasehold', 'share_of_freehold', 'commonhold', 'feudal', 'strata', 'none']).nullable().optional(),
        councilTaxBand: z.string().regex(/^([A-I]|exempt)$/).nullable().optional(),
        energyRating: z.string().regex(/^(A\+|A[1-4]?|B-?|[C-G]|inProcess|exempt)$/).nullable().optional(),
        availableFrom: z.iso.date().nullable().optional(),
      }),
    },
  }, async (req) => {
    const { orgId, id } = req.params;
    const { l } = await loadListing(orgId, id);
    const a = await realtyAccess(req, s.db, orgId);
    if (!canEditListing(a, l, await agentIdsOf(l.id))) throw forbidden('Only the listing agents or an office manager can change portal details');
    const v = { ...req.body, updatedBy: req.user!.id, updatedAt: new Date() };
    const [row] = await s.db.insert(realtyListingPortalFields).values({ organizationId: orgId, listingId: l.id, ...v }).onConflictDoUpdate({ target: realtyListingPortalFields.listingId, set: v }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'realty.listing.portal_fields', scopeKind: 'location', scopeId: l.locationId, targetType: 'realty_listing', targetId: l.id, metadata: req.body });
    return { priceQualifier: row!.priceQualifier, tenure: row!.tenure, councilTaxBand: row!.councilTaxBand, energyRating: row!.energyRating, availableFrom: row!.availableFrom };
  });

  app.get('/orgs/:orgId/realty/syndication/:portal/feed', {
    schema: { tags: ['realty'], security: secured, params: orgParams.extend({ portal: portalParam }), querystring: z.object({ locationId: z.uuid().optional() }), summary: 'Preview the feed for opted-in public listings (valid listings only) with per-listing issues' },
  }, async (req) => {
    const { orgId } = req.params;
    const portal = normalizePortalId(req.params.portal)!;
    const a = await realtyAccess(req, s.db, orgId);
    const adapter = PORTAL_ADAPTERS[portal];
    const ids = scopedLocationIds(a, await realtyLocations(orgId));
    if (req.query.locationId && !ids.includes(req.query.locationId)) throw forbidden('Missing permission operations.read for this office');
    // Without an office filter, a portal that serves exactly one of the user's offices previews that office's feed.
    const servedIds = (await realtyLocations(orgId)).filter((l) => ids.includes(l.id) && adapter.countries.includes(l.country)).map((l) => l.id);
    const locationId = req.query.locationId ?? (servedIds.length === 1 ? servedIds[0]! : null);
    const conn = locationId ? await partnerConnection(s, portal, locationId) : undefined;
    const st = partnerStatus(conn, conn ? partnerCredentials(s, conn) : {});
    const live = st.status === 'live' || st.status === 'awaiting_portal';
    const f = await officeFeed(s, orgId, portal, locationId ?? ids, { sandbox: !live, config: conn?.config ?? {} });
    return {
      portal: adapter.id, name: adapter.name, format: adapter.format, delivery: adapter.delivery, mode: live ? 'live' : 'sandbox', live: st.status === 'live', officeStatus: st.status,
      notice: live ? (adapter.delivery === 'pull' ? 'This is the content the portal fetches from your feed URL.' : 'These are the RTDF calls sent for this office.') : 'Sandbox preview. Nothing is sent to any portal until the office connection is complete and switched to live.',
      ...f,
    };
  });

  app.post('/orgs/:orgId/realty/syndication/:portal/export', {
    schema: { tags: ['realty'], security: secured, params: orgParams.extend({ portal: portalParam }), body: z.object({ locationId: z.uuid().optional() }), summary: 'Validate and deliver opted-in listings per office: push (live) or record sandbox results; withdrawn/sold listings are removed.' },
  }, async (req) => {
    const { orgId } = req.params;
    const portal = normalizePortalId(req.params.portal)!;
    const a = await realtyAccess(req, s.db, orgId);
    const ids = scopedLocationIds(a, await realtyLocations(orgId)).filter((id) => !req.body.locationId || id === req.body.locationId);
    if (ids.some((id) => !isManagerAt(a, id) && !locationAllowed(a.opsWrite, id))) throw forbidden('Missing permission operations.write for some offices');
    const { results, transmitted } = await exportPortal(s, orgId, portal, ids);
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'realty.syndication.export', scopeKind: 'organization', scopeId: orgId, targetType: 'portal', targetId: portal, metadata: { listings: results.length, transmitted } });
    return { portal, transmitted, mode: transmitted ? 'live' : 'sandbox', live: transmitted, results };
  });

  // ───────── AI ─────────
  app.post('/orgs/:orgId/realty/listings/:id/ai/description', {
    schema: { tags: ['realty'], security: secured, params: idParams, body: z.object({ tone: z.enum(['warm and factual', 'concise', 'premium', 'plain']).optional(), instructions: z.string().max(500).optional() }), summary: 'Draft a listing description from the supplied facts only (proposal; never applied automatically)' },
  }, async (req) => {
    const { orgId, id } = req.params;
    const { l } = await loadListing(orgId, id);
    await requirePerm(req, s.db, 'ai.use', { organizationId: orgId, kind: 'location', id: l.locationId }).catch(async (err) => {
      // Agents (staff) don't hold ai.use; the listing's own agents may still draft copy for it.
      const a = await realtyAccess(req, s.db, orgId);
      if (!(await agentIdsOf(l.id)).some((x) => a.agentIds.has(x))) throw err;
    });
    return draftListingDescription(s, { orgId, userId: req.user!.id, listing: l, instructions: req.body.instructions, tone: req.body.tone });
  });

  app.post('/orgs/:orgId/realty/listings/:id/ai/feedback-summary', { schema: { tags: ['realty'], security: secured, params: idParams, summary: 'Summarise viewing feedback for the listing (no buyer identities sent to the model)' } }, async (req) => {
    const { orgId, id } = req.params;
    const { l } = await loadListing(orgId, id);
    const a = await realtyAccess(req, s.db, orgId);
    if (!isManagerAt(a, l.locationId) && !(await agentIdsOf(l.id)).some((x) => a.agentIds.has(x))) throw forbidden('Only the listing agents or an office manager can summarise feedback');
    return summariseFeedback(s, { orgId, userId: req.user!.id, listing: l });
  });

  app.post('/orgs/:orgId/realty/ai/follow-ups', {
    schema: { tags: ['realty'], security: secured, params: orgParams, body: z.object({ listingId: z.uuid().optional(), locationId: z.uuid().optional(), instructions: z.string().max(500).optional() }), summary: 'Propose follow-ups for open enquiries and completed viewings. Refuses protected-characteristic targeting.' },
  }, async (req) => {
    const { orgId } = req.params;
    const a = await realtyAccess(req, s.db, orgId);
    let listing = null;
    if (req.body.listingId) listing = (await loadListing(orgId, req.body.listingId)).l;
    const target = listing?.locationId ?? req.body.locationId ?? null;
    const managedLocs = a.clients === 'all' ? null : [...a.clients];
    const allLocs = (await s.db.select({ id: locations.id }).from(locations).where(eq(locations.organizationId, orgId))).map((l) => l.id);
    const mgr = (managedLocs ?? allLocs).filter((x) => !target || x === target);
    const agentLocs = [...new Set(a.agents.map((g) => g.locationId))].filter((x) => !target || x === target);
    if (!mgr.length && !agentLocs.length) throw forbidden('Follow-ups use client records. Only agents and office managers can request them.');
    // Managers: all records at their offices. Agents only: their own enquiries/viewings.
    return proposeFollowUps(s, { orgId, userId: req.user!.id, listing, locationIds: mgr.length ? mgr : agentLocs, agentIds: mgr.length ? null : a.agentIds, instructions: req.body.instructions });
  });

  app.get('/orgs/:orgId/realty/ai/proposals', { schema: { tags: ['realty'], security: secured, params: orgParams, querystring: z.object({ listingId: z.uuid().optional() }) } }, async (req) => {
    const conds = [eq(realtyAiProposals.organizationId, req.params.orgId), eq(realtyAiProposals.userId, req.user!.id)];
    if (req.query.listingId) conds.push(eq(realtyAiProposals.listingId, req.query.listingId));
    const rows = await s.db.select().from(realtyAiProposals).where(and(...conds)).orderBy(desc(realtyAiProposals.createdAt)).limit(50);
    return { items: rows.map((p) => ({ ...p, createdAt: p.createdAt.toISOString(), decidedAt: p.decidedAt?.toISOString() ?? null })) };
  });

  app.post('/orgs/:orgId/realty/ai/proposals/:id/decision', {
    schema: { tags: ['realty'], security: secured, params: idParams, body: z.object({ decision: z.enum(['apply', 'dismiss']) }), summary: 'Apply a description draft to the listing (through the normal editor/approval path) or dismiss a proposal' },
  }, async (req) => {
    const { orgId, id } = req.params;
    const [p] = await s.db.select().from(realtyAiProposals).where(and(eq(realtyAiProposals.id, id), eq(realtyAiProposals.organizationId, orgId)));
    if (!p) throw notFound('Proposal');
    if (p.status !== 'proposed') throw conflict('already_decided', `This proposal is already ${p.status}`);
    if (p.userId !== req.user!.id) throw forbidden('Only the person who requested this draft can apply it');
    let result: Record<string, unknown> = {};
    if (req.body.decision === 'apply' && p.kind === 'listing_description' && p.listingId) {
      const out = p.output as { headline?: string; description?: string };
      const flagged = findProtectedTargeting(`${out.headline ?? ''}\n${out.description ?? ''}`);
      if (flagged.length) throw conflict('fair_housing_flagged', `This draft contains language that may steer by a protected characteristic (“${flagged[0]!.phrase}”). Edit it before using it.`);
      // Same rules as a manual edit: governed offices store the change for HQ approval.
      const res = await app.inject({ method: 'PATCH', url: `/v1/orgs/${orgId}/realty/listings/${p.listingId}`, headers: { authorization: req.headers.authorization ?? '' }, payload: { title: out.headline?.slice(0, 160), description: out.description } });
      if (res.statusCode >= 400) return res.json();
      result = { listing: (res.json() as { result: string }).result };
    }
    const [u] = await s.db.update(realtyAiProposals).set({ status: req.body.decision === 'apply' ? 'applied' : 'dismissed', decidedBy: req.user!.id, decidedAt: new Date() }).where(eq(realtyAiProposals.id, p.id)).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), actorType: 'user', action: `realty.ai.${req.body.decision}`, scopeKind: p.locationId ? 'location' : 'organization', scopeId: p.locationId ?? orgId, targetType: 'realty_ai_proposal', targetId: p.id, metadata: { kind: p.kind, ...result } });
    return { ...u!, result };
  });

  // ───────── Housekeeping ─────────
  app.post('/orgs/:orgId/realty/jobs/run', { schema: { tags: ['realty'], security: secured, params: orgParams, body: z.object({ job: z.enum(['viewing_reminders', 'saved_search_alerts']) }), summary: 'Run a realty housekeeping job now for this organisation (also runs every few minutes on the server)' } }, async (req) => {
    await requirePerm(req, s.db, 'org.manage', { organizationId: req.params.orgId, kind: 'organization', id: req.params.orgId });
    return req.body.job === 'viewing_reminders' ? runViewingReminders(s, { organizationId: req.params.orgId }) : runSavedSearchAlerts(s, { organizationId: req.params.orgId });
  });

};

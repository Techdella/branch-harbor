/**
 * Real Estate — portal syndication (sandbox adapters, per-listing opt-in), BranchHarbor AI proposals and
 * housekeeping jobs. Registered inside the authenticated scope by routes/realty.ts.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { findProtectedTargeting, PUBLIC_LISTING_STATUSES } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { locations, organizations, realtyAgents, realtyAiProposals, realtyListingAgents, realtyListings, realtyOffices, realtySyndication } from '../db/schema/index.ts';
import { PORTAL_ADAPTERS, PORTAL_IDS, type FeedListing, type PortalAdapter } from '../integrations/realty-portals.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { actor, audit } from '../services/audit.ts';
import { locationAllowed, requirePerm } from '../services/authz.ts';
import { canEditListing, isManagerAt, listingAgentRows, officeFor, realtyAccess } from '../services/realty.ts';
import { draftListingDescription, proposeFollowUps, summariseFeedback } from '../services/realty-ai.ts';
import { runSavedSearchAlerts, runViewingReminders } from '../services/realty-jobs.ts';
import { idParams, orgParams, secured } from './_common.ts';

const portalParam = z.enum(PORTAL_IDS as [PortalAdapter['id'], ...PortalAdapter['id'][]]);

export const realtyExtraRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  const loadListing = async (orgId: string, id: string) => {
    const [row] = await s.db.select({ l: realtyListings, loc: locations }).from(realtyListings).innerJoin(locations, eq(locations.id, realtyListings.locationId)).where(and(eq(realtyListings.id, id), eq(realtyListings.organizationId, orgId)));
    if (!row) throw notFound('Listing');
    return row;
  };
  const agentIdsOf = async (listingId: string) => (await listingAgentRows(s.db, [listingId])).map((r) => r.agent.id);

  async function feedListings(orgId: string, listingIds: string[]): Promise<FeedListing[]> {
    if (!listingIds.length) return [];
    const rows = await s.db.select({ l: realtyListings, loc: locations }).from(realtyListings).innerJoin(locations, eq(locations.id, realtyListings.locationId)).where(and(eq(realtyListings.organizationId, orgId), inArray(realtyListings.id, listingIds)));
    const offices = await s.db.select().from(realtyOffices).where(inArray(realtyOffices.locationId, [...new Set(rows.map((r) => r.loc.id))]));
    const agents = await listingAgentRows(s.db, listingIds);
    return rows.map(({ l, loc }) => {
      const office = offices.find((o) => o.locationId === loc.id);
      const lead = agents.find((x) => x.la.listingId === l.id && x.la.role === 'lead')?.agent;
      return {
        id: l.id, reference: l.reference, transaction: l.transaction as 'sale' | 'rent', propertyType: l.propertyType, status: l.status, title: l.title, description: l.description,
        address: { line1: l.addressLine1, line2: l.addressLine2, city: l.city, region: l.region, postalCode: l.postalCode, country: l.country }, hideStreet: l.hideStreet, geo: l.geo ?? null,
        price: { amount: l.priceMinor, currency: l.currency }, rentPeriod: l.rentPeriod, bedrooms: l.bedrooms, bathrooms: l.bathrooms, areaSqm: l.areaSqm,
        photos: l.photos, floorPlans: l.floorPlans, virtualTourUrl: l.virtualTourUrl, features: l.features,
        agent: lead ? { name: lead.name, email: lead.email, phone: lead.phone } : null,
        office: { name: loc.name, phone: loc.phone, brokerageLicence: office?.brokerageLicence ?? null },
        disclosures: [...(office?.disclosures ?? []), ...l.disclosures].map((d) => ({ label: d.label, text: d.text })),
      };
    });
  }

  // ───────── Syndication ─────────
  app.get('/orgs/:orgId/realty/syndication/portals', { schema: { tags: ['realty'], security: secured, params: orgParams, summary: 'Portal feed adapters. All run in sandbox: nothing is transmitted and no portal account is connected.' } }, async (req) => {
    const a = await realtyAccess(req, s.db, req.params.orgId);
    const optIns = await s.db.select().from(realtySyndication).where(and(eq(realtySyndication.organizationId, req.params.orgId), eq(realtySyndication.optedIn, true)));
    const listingLocs = optIns.length ? await s.db.select({ id: realtyListings.id, locationId: realtyListings.locationId }).from(realtyListings).where(inArray(realtyListings.id, optIns.map((x) => x.listingId))) : [];
    const visible = optIns.filter((x) => locationAllowed(a.ops, listingLocs.find((l) => l.id === x.listingId)?.locationId ?? null));
    return {
      items: Object.values(PORTAL_ADAPTERS).map((p) => ({
        id: p.id, name: p.name, description: p.description, format: p.format, countries: p.countries, mode: p.mode, live: p.live,
        status: 'Sandbox — preview only, not connected', optedInListings: visible.filter((x) => x.portal === p.id).length,
        lastExportedAt: visible.filter((x) => x.portal === p.id && x.lastExportedAt).map((x) => x.lastExportedAt!.toISOString()).sort().pop() ?? null,
      })),
    };
  });

  app.put('/orgs/:orgId/realty/listings/:id/syndication/:portal', {
    schema: { tags: ['realty'], security: secured, params: idParams.extend({ portal: portalParam }), body: z.object({ optedIn: z.boolean() }), summary: 'Opt a listing in or out of a portal feed (sandbox)' },
  }, async (req) => {
    const { orgId, id, portal } = req.params;
    const { l } = await loadListing(orgId, id);
    const a = await realtyAccess(req, s.db, orgId);
    if (!canEditListing(a, l, await agentIdsOf(l.id))) throw forbidden('Only the listing agents or an office manager can change syndication');
    const adapter = PORTAL_ADAPTERS[portal];
    if (req.body.optedIn && !adapter.countries.includes(l.country)) throw validationError(`${adapter.name} only accepts listings in ${adapter.countries.join(', ')}`, { portal: 'Country not supported by this feed' });
    const [feed] = await feedListings(orgId, [l.id]);
    const issues = adapter.validate(feed!);
    const v = { organizationId: orgId, listingId: l.id, portal, optedIn: req.body.optedIn, lastIssues: issues, updatedBy: req.user!.id, updatedAt: new Date() };
    const [row] = await s.db.insert(realtySyndication).values(v).onConflictDoUpdate({ target: [realtySyndication.listingId, realtySyndication.portal], set: v }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'realty.syndication.opt', scopeKind: 'location', scopeId: l.locationId, targetType: 'realty_listing', targetId: l.id, metadata: { portal, optedIn: req.body.optedIn } });
    return { portal, optedIn: row!.optedIn, issues, mode: 'sandbox', live: false };
  });

  const scopedOptIns = async (orgId: string, portal: PortalAdapter['id'], a: Awaited<ReturnType<typeof realtyAccess>>, locationId?: string) => {
    const rows = await s.db.select({ x: realtySyndication, l: realtyListings }).from(realtySyndication).innerJoin(realtyListings, eq(realtyListings.id, realtySyndication.listingId))
      .where(and(eq(realtySyndication.organizationId, orgId), eq(realtySyndication.portal, portal), eq(realtySyndication.optedIn, true), inArray(realtyListings.status, [...PUBLIC_LISTING_STATUSES])));
    return rows.filter(({ l }) => locationAllowed(a.ops, l.locationId) && (!locationId || l.locationId === locationId));
  };

  app.get('/orgs/:orgId/realty/syndication/:portal/feed', {
    schema: { tags: ['realty'], security: secured, params: orgParams.extend({ portal: portalParam }), querystring: z.object({ locationId: z.uuid().optional() }), summary: 'Preview the sandbox feed for opted-in public listings (valid listings only) with per-listing issues' },
  }, async (req) => {
    const { orgId, portal } = req.params;
    const a = await realtyAccess(req, s.db, orgId);
    const adapter = PORTAL_ADAPTERS[portal];
    const rows = await scopedOptIns(orgId, portal, a, req.query.locationId);
    const feed = await feedListings(orgId, rows.map((r) => r.l.id));
    const checked = feed.map((f) => ({ f, issues: adapter.validate(f) }));
    const [org] = await s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    return {
      portal: adapter.id, name: adapter.name, format: adapter.format, mode: 'sandbox', live: false, notice: 'Sandbox preview. Nothing is sent to any portal and no integration is live.',
      included: checked.filter((c) => !c.issues.length).map((c) => ({ listingId: c.f.id, reference: c.f.reference })),
      excluded: checked.filter((c) => c.issues.length).map((c) => ({ listingId: c.f.id, reference: c.f.reference, issues: c.issues })),
      content: adapter.build(checked.filter((c) => !c.issues.length).map((c) => c.f), { generatedAt: new Date().toISOString(), organization: org?.name ?? '' }),
    };
  });

  app.post('/orgs/:orgId/realty/syndication/:portal/export', {
    schema: { tags: ['realty'], security: secured, params: orgParams.extend({ portal: portalParam }), body: z.object({ locationId: z.uuid().optional() }), summary: 'Run a sandbox export: validates and records the result per listing. Nothing is transmitted.' },
  }, async (req) => {
    const { orgId, portal } = req.params;
    const a = await realtyAccess(req, s.db, orgId);
    const adapter = PORTAL_ADAPTERS[portal];
    const rows = await scopedOptIns(orgId, portal, a, req.body.locationId);
    if (rows.some(({ l }) => !isManagerAt(a, l.locationId) && !locationAllowed(a.opsWrite, l.locationId))) throw forbidden('Missing permission operations.write for some offices');
    const feed = await feedListings(orgId, rows.map((r) => r.l.id));
    const now = new Date();
    const results = [];
    for (const f of feed) {
      const issues = adapter.validate(f);
      await s.db.update(realtySyndication).set({ lastStatus: issues.length ? 'invalid' : 'sandbox_exported', lastIssues: issues, lastExportedAt: issues.length ? undefined : now, updatedAt: now })
        .where(and(eq(realtySyndication.listingId, f.id), eq(realtySyndication.portal, portal)));
      results.push({ listingId: f.id, reference: f.reference, status: issues.length ? 'invalid' : 'sandbox_exported', issues });
    }
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'realty.syndication.sandbox_export', scopeKind: 'organization', scopeId: orgId, targetType: 'portal', targetId: portal, metadata: { listings: results.length } });
    return { portal, mode: 'sandbox', live: false, transmitted: false, results };
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

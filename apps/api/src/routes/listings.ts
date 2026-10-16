import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { listingPatchSchema, specialHourSchema, type ListingProvider } from '@bh/shared';
import { holidayHourSets, listingChangeRequests, listingConnections, listingDrifts, listingSyncs, locations, reviewConnections, reviewListings } from '../db/schema/index.ts';
import { encrypt } from '../lib/crypto.ts';
import { conflict, forbidden, notFound } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { hasAt, requireAt, scopeFor } from '../services/comms-scope.ts';
import {
  LISTINGS, applyHolidayHours, checkDrift, decideChange, ensureSyncs, listingDetail, listingDirectories, listingsOverview, listingsTick, pushLocation, resolveDrift, serializeDrift,
  simulateDirectoryEdit, updateListing,
} from '../services/listings.ts';
import { idParams, orgParams, secured } from './_common.ts';

const tags = ['listings'];
const locParams = z.object({ orgId: z.uuid(), locationId: z.uuid() });
const provider = z.enum(['google', 'apple', 'bing']);

/**
 * Marketing → Listings (`/v1/orgs/:orgId/listings/...`). Access: `marketing.listings` — view (overview, health,
 * drift), edit (a location's open fields; changes to fields that need approval become requests), publish
 * (organisation-wide: every field, directory connections, drift decisions, bulk holiday hours, approving changes).
 */
export const listingRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;

  if (s.cfg.NODE_ENV !== 'test') {
    let timer: NodeJS.Timeout | null = null;
    app.addHook('onReady', async () => {
      timer = setInterval(() => void listingsTick(s).catch((err) => s.log.warn({ err }, 'listings tick failed')), 15 * 60_000);
      timer.unref?.();
    });
    app.addHook('onClose', async () => { if (timer) clearInterval(timer); });
  }

  app.addHook('preHandler', authenticate);
  const hq = (req: FastifyRequest, orgId: string) => hasAt(req, db, orgId, null, LISTINGS, 'publish');
  const requireHq = async (req: FastifyRequest, orgId: string) => { if (!(await hq(req, orgId))) throw forbidden('Only HQ with Listings publish access can do this'); };
  const scopeIds = async (req: FastifyRequest, orgId: string) => {
    const sc = await scopeFor(req, db, orgId, LISTINGS);
    return sc.all ? ('all' as const) : sc.locationIds!;
  };
  const checkLocation = async (orgId: string, id: string) => {
    const [l] = await db.select({ id: locations.id, name: locations.name }).from(locations).where(and(eq(locations.id, id), eq(locations.organizationId, orgId)));
    if (!l) throw notFound('Location');
    return l;
  };

  app.get('/orgs/:orgId/listings', { schema: { tags, security: secured, params: orgParams, summary: 'Listing health, directory sync state, drift and pending changes per location in scope' } }, async (req) => {
    const { orgId } = req.params;
    return { ...(await listingsOverview(s, orgId, await scopeIds(req, orgId))), canManage: await hq(req, orgId) };
  });

  app.get('/orgs/:orgId/listings/drifts', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum(['open', 'accepted', 'overwritten', 'dismissed', 'all']).default('open') }), summary: 'Fields edited outside BranchHarbor, per location and directory' } }, async (req) => {
    const { orgId } = req.params;
    const ids = await scopeIds(req, orgId);
    const rows = await db.select({ d: listingDrifts, name: locations.name }).from(listingDrifts).innerJoin(locations, eq(locations.id, listingDrifts.locationId))
      .where(and(eq(listingDrifts.organizationId, orgId), req.query.status === 'all' ? undefined : eq(listingDrifts.status, req.query.status), ids === 'all' ? undefined : ids.length ? inArray(listingDrifts.locationId, ids) : sql`false`))
      .orderBy(desc(listingDrifts.detectedAt)).limit(200);
    return { items: rows.map((r) => serializeDrift(r.d, r.name)), canResolve: await hq(req, orgId) };
  });

  app.post('/orgs/:orgId/listings/drifts/:id/resolve', {
    schema: { tags, security: secured, params: idParams, body: z.object({ action: z.enum(['accept', 'overwrite', 'dismiss']) }), summary: 'Accept the directory’s value (it becomes BranchHarbor’s and goes to the other directories), overwrite it with ours, or dismiss' },
  }, async (req) => {
    await requireHq(req, req.params.orgId);
    return serializeDrift(await resolveDrift(s, req.params.orgId, req.params.id, req.body.action, req.user!.id));
  });

  app.get('/orgs/:orgId/listings/changes', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending') }), summary: 'Location changes waiting for (or decided by) HQ' } }, async (req) => {
    const { orgId } = req.params;
    const ids = await scopeIds(req, orgId);
    const rows = await db.select({ c: listingChangeRequests, name: locations.name }).from(listingChangeRequests).innerJoin(locations, eq(locations.id, listingChangeRequests.locationId))
      .where(and(eq(listingChangeRequests.organizationId, orgId), req.query.status === 'all' ? undefined : eq(listingChangeRequests.status, req.query.status), ids === 'all' ? undefined : ids.length ? inArray(listingChangeRequests.locationId, ids) : sql`false`))
      .orderBy(desc(listingChangeRequests.createdAt)).limit(200);
    return { items: rows.map(({ c, name }) => ({ id: c.id, locationId: c.locationId, locationName: name, changes: c.changes, fields: Object.keys(c.changes), status: c.status, note: c.note, requestedBy: c.requestedBy, decisionNote: c.decisionNote, createdAt: c.createdAt.toISOString() })), canDecide: await hq(req, orgId) };
  });

  app.post('/orgs/:orgId/listings/changes/:id/decision', {
    schema: { tags, security: secured, params: idParams, body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).nullable().optional() }), summary: 'HQ approves (applies and pushes) or rejects a location’s listing change' },
  }, async (req) => {
    await requireHq(req, req.params.orgId);
    const r = await decideChange(s, req.params.orgId, req.params.id, req.body.decision, req.user!.id, req.body.note ?? null);
    return { id: r.id, status: r.status };
  });

  /* ── bulk holiday hours ── */

  app.get('/orgs/:orgId/listings/holiday-hours', { schema: { tags, security: secured, params: orgParams, summary: 'Holiday hours set across the network' } }, async (req) => {
    const { orgId } = req.params;
    await scopeIds(req, orgId);
    const rows = await db.select().from(holidayHourSets).where(eq(holidayHourSets.organizationId, orgId)).orderBy(desc(holidayHourSets.createdAt)).limit(50);
    return { items: rows.map((r) => ({ id: r.id, name: r.name, entries: r.entries, locationIds: r.locationIds, skippedLocationIds: r.skippedLocationIds, createdAt: r.createdAt.toISOString() })), canManage: await hq(req, orgId) };
  });

  app.post('/orgs/:orgId/listings/holiday-hours', {
    schema: {
      tags, security: secured, params: orgParams, summary: 'Set holiday hours at many locations at once (kept where a location set its own hours for those dates, unless overwrite)',
      body: z.object({ name: z.string().trim().min(2).max(120), entries: z.array(specialHourSchema).min(1).max(30), locationIds: z.array(z.uuid()).min(1).max(2000), overwrite: z.boolean().default(false) }),
    },
  }, async (req, reply) => {
    await requireHq(req, req.params.orgId);
    const r = await applyHolidayHours(s, req.params.orgId, req.body, req.user!.id);
    return reply.code(201).send({ id: r.set.id, applied: r.applied, skipped: r.skipped, pushed: r.pushes.reduce((a, p) => a + p.results.filter((x) => x.status === 'synced').length, 0) });
  });

  /* ── directory connections (Apple, Bing; Google comes from Reviews) ── */

  app.get('/orgs/:orgId/listings/connections', { schema: { tags, security: secured, params: orgParams, summary: 'Directory connections: Google (the Reviews Google Business Profile connection), Apple Business Connect, Bing Places' } }, async (req) => {
    const { orgId } = req.params;
    await scopeIds(req, orgId);
    const dirs = listingDirectories(s);
    const google = await db.select().from(reviewConnections).where(and(eq(reviewConnections.organizationId, orgId), eq(reviewConnections.provider, 'google')));
    const googleLinks = await db.select({ n: sql<number>`count(*)::int` }).from(reviewListings).where(eq(reviewListings.organizationId, orgId));
    const others = await db.select().from(listingConnections).where(eq(listingConnections.organizationId, orgId)).orderBy(desc(listingConnections.createdAt));
    const links = await db.select({ provider: listingSyncs.provider, n: sql<number>`count(*)::int` }).from(listingSyncs).where(eq(listingSyncs.organizationId, orgId)).groupBy(listingSyncs.provider);
    return {
      configured: { google: dirs.google.configured, apple: dirs.apple.configured, bing: dirs.bing.configured },
      google: { connections: google.map((c) => ({ id: c.id, mode: c.mode, status: c.status, accountEmail: c.accountEmail })), linkedLocations: googleLinks[0]?.n ?? 0 },
      items: others.map((c) => ({ id: c.id, provider: c.provider, mode: c.mode, status: c.status, accountName: c.accountName, lastError: c.lastError, createdAt: c.createdAt.toISOString(), linkedLocations: links.find((l) => l.provider === c.provider)?.n ?? 0 })),
      canManage: await hq(req, orgId),
    };
  });

  app.post('/orgs/:orgId/listings/connections', {
    schema: {
      tags, security: secured, params: orgParams, summary: 'Connect Apple Business Connect or Bing Places (live with credentials once the platform is approved; sandbox otherwise)',
      body: z.object({ provider: z.enum(['apple', 'bing']), accountName: z.string().trim().max(200).optional(), credential: z.string().min(4).max(2000).optional() }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requireHq(req, orgId);
    const live = !!req.body.credential && listingDirectories(s)[req.body.provider].configured;
    const [c] = await db.insert(listingConnections).values({ organizationId: orgId, provider: req.body.provider, mode: live ? 'live' : 'sandbox', accountName: req.body.accountName ?? null, credentialsEncrypted: live ? encrypt(req.body.credential!, s.cfg.ENCRYPTION_KEY) : null, connectedBy: req.user!.id }).returning();
    await audit(db, { organizationId: orgId, ...actor(req), action: 'listings.connection_added', scopeKind: 'organization', scopeId: orgId, targetType: 'listing_connection', targetId: c!.id, metadata: { provider: c!.provider, mode: c!.mode } });
    return reply.code(201).send({ id: c!.id, provider: c!.provider, mode: c!.mode });
  });

  app.post('/orgs/:orgId/listings/connections/:id/links', {
    schema: {
      tags, security: secured, params: idParams, summary: 'Link locations to their directory entries (`all` links every location in a sandbox connection)',
      body: z.object({ links: z.array(z.object({ locationId: z.uuid(), externalId: z.string().trim().min(1).max(200) })).max(2000).default([]), all: z.boolean().default(false) }),
    },
  }, async (req) => {
    const { orgId, id } = req.params;
    await requireHq(req, orgId);
    const [c] = await db.select().from(listingConnections).where(and(eq(listingConnections.id, id), eq(listingConnections.organizationId, orgId)));
    if (!c) throw notFound('Connection');
    let links = req.body.links;
    if (req.body.all) {
      if (c.mode !== 'sandbox') throw conflict('connection_live', 'Link live directory entries one by one with their directory ids');
      const locs = await db.select({ id: locations.id, code: locations.code }).from(locations).where(and(eq(locations.organizationId, orgId), sql`${locations.archivedAt} is null`));
      links = locs.map((l) => ({ locationId: l.id, externalId: `sandbox-${c.provider}-${l.code.toLowerCase()}` }));
    }
    for (const l of links) {
      await checkLocation(orgId, l.locationId);
      await db.insert(listingSyncs).values({ organizationId: orgId, locationId: l.locationId, provider: c.provider, connectionId: c.id, externalId: l.externalId, mode: c.mode, status: 'pending' })
        .onConflictDoUpdate({ target: [listingSyncs.locationId, listingSyncs.provider], set: { connectionId: c.id, externalId: l.externalId, mode: c.mode, status: 'pending', updatedAt: new Date() } });
    }
    await audit(db, { organizationId: orgId, ...actor(req), action: 'listings.locations_linked', scopeKind: 'organization', scopeId: orgId, targetType: 'listing_connection', targetId: c.id, metadata: { count: links.length } });
    return { linked: links.length };
  });

  app.post('/orgs/:orgId/listings/syncs/:id/simulate-edit', {
    schema: { tags, security: secured, params: idParams, body: listingPatchSchema, summary: 'Sandbox only: simulate someone editing the listing on the directory (runs drift detection)' },
  }, async (req) => {
    const [sync] = await db.select().from(listingSyncs).where(and(eq(listingSyncs.id, req.params.id), eq(listingSyncs.organizationId, req.params.orgId)));
    if (!sync) throw notFound('Listing sync');
    await requireAt(req, db, req.params.orgId, sync.locationId, LISTINGS, 'edit');
    return simulateDirectoryEdit(s, req.params.orgId, sync.id, req.body);
  });

  /* ── one location ── */

  app.get('/orgs/:orgId/listings/:locationId', { schema: { tags, security: secured, params: locParams, summary: 'The location’s canonical listing, field policy, directory sync state, drift and change requests' } }, async (req) => {
    const { orgId, locationId } = req.params;
    await checkLocation(orgId, locationId);
    await requireAt(req, db, orgId, locationId, LISTINGS, 'view');
    return { ...(await listingDetail(s, orgId, locationId)), canEdit: await hasAt(req, db, orgId, locationId, LISTINGS, 'edit'), canManage: await hq(req, orgId) };
  });

  app.patch('/orgs/:orgId/listings/:locationId', {
    schema: { tags, security: secured, params: locParams, body: listingPatchSchema.extend({ note: z.string().max(500).nullable().optional() }), summary: 'Change listing fields (HQ: any field; locations: open fields, approval fields become a request). Pushed to connected directories.' },
  }, async (req) => {
    const { orgId, locationId } = req.params;
    await checkLocation(orgId, locationId);
    await requireAt(req, db, orgId, locationId, LISTINGS, 'edit');
    const { note, ...patch } = req.body;
    return updateListing(s, orgId, locationId, patch, { userId: req.user!.id, hq: await hq(req, orgId), note: note ?? null });
  });

  app.post('/orgs/:orgId/listings/:locationId/push', { schema: { tags, security: secured, params: locParams, body: z.object({ provider: provider.optional() }).default({}), summary: 'Push the listing to the linked directories now' } }, async (req) => {
    const { orgId, locationId } = req.params;
    await checkLocation(orgId, locationId);
    await requireAt(req, db, orgId, locationId, LISTINGS, 'edit');
    return { results: await pushLocation(s, orgId, locationId, { provider: req.body.provider as ListingProvider | undefined, actorUserId: req.user!.id }) };
  });

  app.post('/orgs/:orgId/listings/:locationId/check', { schema: { tags, security: secured, params: locParams, summary: 'Check the directories for edits made outside BranchHarbor now' } }, async (req) => {
    const { orgId, locationId } = req.params;
    await checkLocation(orgId, locationId);
    await requireAt(req, db, orgId, locationId, LISTINGS, 'edit');
    await ensureSyncs(db, orgId, [locationId]);
    const syncs = await db.select().from(listingSyncs).where(eq(listingSyncs.locationId, locationId));
    const out = [];
    for (const x of syncs) out.push({ provider: x.provider, ...(await checkDrift(s, x.id)) });
    return { results: out };
  });
};

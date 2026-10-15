/**
 * Partner integrations per location/office: Uber Direct, Deliverect and property portals (Rightmove, idealista,
 * Zillow/RESO XML, REAXML). Credentials are write-only (encrypted, returned masked); `connections.manage` is needed
 * to change them, `operations.read` to see status. Test calls the real partner only when credentials are complete.
 */
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { connections, locations, partnerSyncLog } from '../db/schema/index.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { createDeliverectClient } from '../integrations/partners/deliverect.ts';
import { createRightmoveClient } from '../integrations/partners/rightmove.ts';
import { createUberDirectClient, uberAvailableIn } from '../integrations/partners/uber-direct.ts';
import { normalizePortalId } from '../integrations/realty-portals.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requireLocationPerm } from '../services/authz.ts';
import { deliverectMenuSnapshot, pushMenuToDeliverect, setDeliverectBusyMode } from '../services/foods-partners.ts';
import {
  catalogEntry, encryptCredentials, errInfo, isPartnerProvider, lastSyncs, logSync, missingFields, missingFieldKeys, PARTNER_CATALOG, PARTNER_PROVIDERS, partnerCredentials,
  serializePartnerConnection, type PartnerProvider,
} from '../services/partner-connections.ts';
import { officeFeed } from '../services/realty-portals.ts';
import { idParams, orgParams, secured } from './_common.ts';

const locParams = orgParams.extend({ locationId: z.uuid() });

export const partnerIntegrationRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  async function load(orgId: string, id: string) {
    const [c] = await s.db.select().from(connections).where(and(eq(connections.id, id), eq(connections.organizationId, orgId)));
    if (!c || !isPartnerProvider(c.provider) || !c.locationId) throw notFound('Partner connection');
    return c;
  }
  const splitInput = (provider: PartnerProvider, input: Record<string, unknown>) => {
    const fields = catalogEntry(provider).fields;
    const unknown = Object.keys(input).filter((k) => !fields.some((f) => f.key === k));
    if (unknown.length) throw validationError(`Unknown setting(s): ${unknown.join(', ')}`, Object.fromEntries(unknown.map((k) => [k, 'Not a setting for this provider'])));
    const config: Record<string, unknown> = {};
    const creds: Record<string, string | null> = {};
    for (const f of fields) {
      if (!(f.key in input)) continue;
      const v = input[f.key];
      if (f.secret) creds[f.key] = v === null || v === '' ? null : String(v);
      else if (f.type === 'boolean') config[f.key] = v === true || v === 'true';
      else if (f.type === 'select') { if (v !== null && v !== '' && !f.options!.includes(String(v))) throw validationError(`${f.label} must be one of ${f.options!.join(', ')}`, { [f.key]: 'Invalid option' }); config[f.key] = v === '' ? null : v; }
      else config[f.key] = v === null ? null : String(v).trim();
    }
    return { config, creds };
  };

  app.get('/orgs/:orgId/partner-connections', {
    schema: { tags: ['connections'], security: secured, params: orgParams, querystring: z.object({ industry: z.enum(['foods', 'realty']).optional(), locationId: z.uuid().optional() }), summary: 'Partner integrations per location (masked credentials, status, last result) and the catalogue' },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
    const manage = await authorisedLocations(req, s.db, orgId, 'connections.manage');
    const rows = (await s.db.select().from(connections).where(eq(connections.organizationId, orgId))).filter((c) => isPartnerProvider(c.provider) && c.locationId && (allowed === 'all' || allowed.has(c.locationId)) && (!req.query.locationId || c.locationId === req.query.locationId));
    const catalog = PARTNER_CATALOG.filter((c) => !req.query.industry || c.industry === req.query.industry);
    const items = rows.filter((c) => catalog.some((x) => x.provider === c.provider));
    const syncs = await lastSyncs(s, items.map((c) => c.id));
    const locs = await s.db.select({ id: locations.id, name: locations.name, country: locations.country, currency: locations.currency }).from(locations).where(eq(locations.organizationId, orgId));
    return {
      catalog,
      locations: locs.filter((l) => allowed === 'all' || allowed.has(l.id)).map((l) => ({ ...l, canManage: manage === 'all' || manage.has(l.id), uberDirectAvailable: uberAvailableIn(l.country, s.cfg.UBER_DIRECT_COUNTRIES) })),
      items: items.map((c) => {
        const last = syncs.get(c.id);
        return serializePartnerConnection(s, c, { canManage: manage === 'all' || manage.has(c.locationId!), lastResult: last ? { at: last.createdAt.toISOString(), action: last.action, status: last.status, message: last.message } : null });
      }),
    };
  });

  app.post('/orgs/:orgId/partner-connections', {
    schema: {
      tags: ['connections'], security: secured, params: orgParams, summary: 'Configure a partner for a location/office (starts in sandbox; credentials are encrypted and never returned)',
      body: z.object({ provider: z.enum(PARTNER_PROVIDERS), locationId: z.uuid(), settings: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])).default({}) }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    await requireLocationPerm(req, s.db, orgId, b.locationId, 'connections.manage');
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, b.locationId), eq(locations.organizationId, orgId)));
    if (!loc) throw notFound('Location');
    const entry = catalogEntry(b.provider);
    if (entry.countries && !entry.countries.includes(loc.country)) throw validationError(`${entry.name} only serves ${entry.countries.join(', ')}`, { locationId: 'Office country not supported' });
    const [dup] = await s.db.select({ id: connections.id }).from(connections).where(and(eq(connections.provider, b.provider), eq(connections.locationId, b.locationId)));
    if (dup) throw conflict('already_configured', `${entry.name} is already configured for this location`);
    const { config, creds } = splitInput(b.provider, b.settings);
    const defaults: Record<string, unknown> = b.provider === 'uber_direct' ? { feeMode: 'absorb' } : b.provider === 'deliverect' ? { environment: 'staging', posInjection: false, marketplaceOrders: false, autoAccept: false } : { feedTokenVersion: 1 };
    const cleanCreds = Object.fromEntries(Object.entries(creds).filter((e): e is [string, string] => !!e[1]));
    const [c] = await s.db.insert(connections).values({
      organizationId: orgId, locationId: b.locationId, provider: b.provider, kind: entry.kind, direction: entry.kind === 'portal' ? 'export' : 'bidirectional', authoritative: 'branchharbor',
      config: { ...defaults, ...config, enabled: true, mode: 'sandbox' }, credentialsEncrypted: encryptCredentials(s, cleanCreds), state: 'disconnected', createdBy: req.user!.id,
    }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'partner_connection.created', scopeKind: 'location', scopeId: b.locationId, targetType: 'connection', targetId: c!.id, metadata: { provider: b.provider, credentialKeys: Object.keys(cleanCreds) } });
    return reply.code(201).send(serializePartnerConnection(s, c!, { canManage: true, lastResult: null }));
  });

  app.patch('/orgs/:orgId/partner-connections/:id', {
    schema: {
      tags: ['connections'], security: secured, params: idParams, summary: 'Update settings/credentials (empty value removes a secret), enable/disable, or switch sandbox ↔ live (live needs complete credentials and a passing test)',
      body: z.object({ settings: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])).optional(), enabled: z.boolean().optional(), mode: z.enum(['sandbox', 'live']).optional() }),
    },
  }, async (req) => {
    const c = await load(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, c.organizationId, c.locationId!, 'connections.manage');
    const provider = c.provider as PartnerProvider;
    const { config, creds } = splitInput(provider, req.body.settings ?? {});
    const merged = { ...partnerCredentials(s, c) };
    for (const [k, v] of Object.entries(creds)) { if (v) merged[k] = v; else delete merged[k]; }
    const nextConfig: Record<string, unknown> = { ...c.config, ...config, ...(req.body.enabled !== undefined ? { enabled: req.body.enabled } : {}) };
    const credsChanged = Object.keys(creds).length > 0;
    if (req.body.mode === 'live') {
      const missing = missingFields(provider, nextConfig, merged);
      if (missing.length) throw conflict('incomplete', `Add ${missing.join(', ')} before going live`);
      if (credsChanged || c.state !== 'connected') throw conflict('test_required', 'Run a successful connection test before switching to live');
    }
    if (req.body.mode) nextConfig.mode = req.body.mode;
    if (credsChanged) nextConfig.mode = 'sandbox'; // new credentials must be tested again
    const [u] = await s.db.update(connections).set({ config: nextConfig, credentialsEncrypted: encryptCredentials(s, merged), ...(credsChanged ? { state: 'disconnected' } : {}), updatedAt: new Date() }).where(eq(connections.id, c.id)).returning();
    await audit(s.db, { organizationId: c.organizationId, ...actor(req), action: 'partner_connection.updated', scopeKind: 'location', scopeId: c.locationId, targetType: 'connection', targetId: c.id, metadata: { provider, settings: Object.keys(config), credentialsChanged: Object.keys(creds), enabled: req.body.enabled, mode: req.body.mode } });
    return serializePartnerConnection(s, u!, { canManage: true });
  });

  app.post('/orgs/:orgId/partner-connections/:id/test', { schema: { tags: ['connections'], security: secured, params: idParams, summary: 'Test the connection against the partner (sandbox message when credentials are incomplete)' } }, async (req) => {
    const c = await load(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, c.organizationId, c.locationId!, 'connections.manage');
    const provider = c.provider as PartnerProvider;
    const creds = partnerCredentials(s, c);
    const missing = missingFields(provider, c.config, creds);
    // `code` + `params` (additive) let apps phrase the outcome in the user's language; `message` stays the English line.
    let result: { ok: boolean; sandbox: boolean; message: string; code?: 'missing_credentials' | 'accepted' | 'feed_ready'; params?: Record<string, string | number | string[]> };
    if (missing.length) {
      result = { ok: false, sandbox: true, message: `Sandbox — add ${missing.join(', ')} to test against ${catalogEntry(provider).name}`, code: 'missing_credentials', params: { provider: catalogEntry(provider).name, missingKeys: missingFieldKeys(provider, c.config, creds) } };
    } else {
      try {
        if (provider === 'uber_direct') {
          await createUberDirectClient({ creds: { clientId: creds.clientId!, clientSecret: creds.clientSecret!, customerId: String(c.config.customerId) }, fetch: s.partnerFetch, authUrl: s.cfg.UBER_DIRECT_AUTH_URL, apiUrl: s.cfg.UBER_DIRECT_API_URL }).test();
          result = { ok: true, sandbox: false, message: 'Uber Direct accepted the credentials', code: 'accepted', params: { provider: 'Uber Direct' } };
        } else if (provider === 'deliverect') {
          await createDeliverectClient({ creds: { clientId: creds.clientId!, clientSecret: creds.clientSecret! }, config: c.config, fetch: s.partnerFetch, baseUrl: s.cfg.DELIVERECT_API_URL }).test();
          result = { ok: true, sandbox: false, message: `Deliverect ${String(c.config.environment ?? 'staging')} accepted the credentials`, code: 'accepted', params: { provider: `Deliverect ${String(c.config.environment ?? 'staging')}` } };
        } else if (provider === 'rightmove') {
          const r = await createRightmoveClient({ fetch: s.rightmoveFetch(creds.certificatePfxBase64!, creds.certificatePassword), baseUrl: (c.config.baseUrl as string) || undefined }).branchPropertyList(Number(c.config.networkId), Number(c.config.branchId));
          result = r.ok ? { ok: true, sandbox: false, message: 'Rightmove accepted the certificate and branch', code: 'accepted', params: { provider: 'Rightmove' } } : { ok: false, sandbox: false, message: r.errors.join('; ') || r.message || 'Rightmove rejected the request' };
        } else {
          const portal = normalizePortalId(provider)!;
          const f = await officeFeed(s, c.organizationId, portal, c.locationId, { sandbox: false, config: c.config });
          result = { ok: true, sandbox: false, message: `Feed ready: ${f.included.length} listing(s) included, ${f.excluded.length} need fixes. Give the feed URL to the portal.`, code: 'feed_ready', params: { included: f.included.length, excluded: f.excluded.length } };
        }
      } catch (err) {
        result = { ok: false, sandbox: false, message: errInfo(err).message };
      }
    }
    const now = new Date();
    const [u] = await s.db.update(connections).set(result.ok
      ? { state: 'connected', lastSuccessAt: now, lastError: null, updatedAt: now }
      : { state: result.sandbox ? 'disconnected' : 'authorization_expired', lastError: result.message, lastErrorAt: now, updatedAt: now }).where(eq(connections.id, c.id)).returning();
    await logSync(s, { organizationId: c.organizationId, connectionId: c.id, provider, locationId: c.locationId, action: 'test', status: result.ok ? 'ok' : result.sandbox ? 'sandbox' : 'error', message: result.message });
    return { result, connection: serializePartnerConnection(s, u!, { canManage: true, lastResult: { at: now.toISOString(), action: 'test', status: result.ok ? 'ok' : result.sandbox ? 'sandbox' : 'error', message: result.message } }) };
  });

  app.post('/orgs/:orgId/partner-connections/:id/rotate-feed-token', { schema: { tags: ['connections'], security: secured, params: idParams, summary: 'Issue a new feed URL (the old one stops working)' } }, async (req) => {
    const c = await load(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, c.organizationId, c.locationId!, 'connections.manage');
    if (catalogEntry(c.provider as PartnerProvider).delivery !== 'pull') throw conflict('not_a_feed', 'Only pull-based portal feeds have a feed URL');
    const [u] = await s.db.update(connections).set({ config: { ...c.config, feedTokenVersion: Number(c.config.feedTokenVersion ?? 1) + 1, lastFetchedAt: null }, updatedAt: new Date() }).where(eq(connections.id, c.id)).returning();
    await audit(s.db, { organizationId: c.organizationId, ...actor(req), action: 'partner_connection.feed_rotated', scopeKind: 'location', scopeId: c.locationId, targetType: 'connection', targetId: c.id });
    return serializePartnerConnection(s, u!, { canManage: true });
  });

  app.get('/orgs/:orgId/partner-connections/:id/log', { schema: { tags: ['connections'], security: secured, params: idParams, summary: 'Recent calls and results for this connection' } }, async (req) => {
    const c = await load(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, c.organizationId, c.locationId!, 'operations.read');
    const rows = await s.db.select().from(partnerSyncLog).where(eq(partnerSyncLog.connectionId, c.id)).orderBy(desc(partnerSyncLog.createdAt)).limit(50);
    return { items: rows.map((r) => ({ id: r.id, at: r.createdAt.toISOString(), action: r.action, status: r.status, httpStatus: r.httpStatus, message: r.message, targetType: r.targetType, targetId: r.targetId })) };
  });

  app.delete('/orgs/:orgId/partner-connections/:id', { schema: { tags: ['connections'], security: secured, params: idParams, summary: 'Disconnect: credentials removed, switched off (history kept)' } }, async (req) => {
    const c = await load(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, c.organizationId, c.locationId!, 'connections.manage');
    const [u] = await s.db.update(connections).set({ credentialsEncrypted: null, state: 'disconnected', config: { ...c.config, enabled: false, mode: 'sandbox' }, updatedAt: new Date() }).where(eq(connections.id, c.id)).returning();
    await audit(s.db, { organizationId: c.organizationId, ...actor(req), action: 'partner_connection.disconnected', scopeKind: 'location', scopeId: c.locationId, targetType: 'connection', targetId: c.id });
    return serializePartnerConnection(s, u!, { canManage: true });
  });

  // ───────── Deliverect operations ─────────
  const locationOf = async (orgId: string, locationId: string) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, orgId)));
    if (!loc) throw notFound('Location');
    return loc;
  };

  app.get('/orgs/:orgId/foods/locations/:locationId/deliverect/menu-snapshot', { schema: { tags: ['foods'], security: secured, params: locParams, summary: 'The menu snapshot that would be sent to Deliverect (prices, availability, sold-out, declared allergens)' } }, async (req) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    const { snapshot } = await deliverectMenuSnapshot(s, await locationOf(req.params.orgId, req.params.locationId));
    return snapshot;
  });

  app.post('/orgs/:orgId/foods/locations/:locationId/deliverect/menu-push', { schema: { tags: ['foods'], security: secured, params: locParams, summary: 'Publish the location menu to Deliverect (sandbox: snapshot only)' } }, async (req) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.write');
    const { snapshot: _snapshot, ...r } = await pushMenuToDeliverect(s, await locationOf(req.params.orgId, req.params.locationId), req.user!.id);
    return r;
  });

  app.post('/orgs/:orgId/foods/locations/:locationId/deliverect/busy', {
    schema: { tags: ['foods'], security: secured, params: locParams, body: z.object({ paused: z.boolean(), minutes: z.number().int().min(5).max(720).optional() }), summary: 'Busy mode: pause marketplace ordering through Deliverect (sandbox: recorded only)' },
  }, async (req) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.write');
    return setDeliverectBusyMode(s, await locationOf(req.params.orgId, req.params.locationId), req.body.paused, req.body.minutes, req.user!.id);
  });
};

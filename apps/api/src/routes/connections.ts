import { and, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { connections, externalMappings, syncRuns } from '../db/schema/index.ts';
import { CONNECTOR_CATALOG, CONNECTOR_PROVIDERS, type ConnectorProvider } from '../integrations/connectors.ts';
import { encrypt } from '../lib/crypto.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requirePerm, resolveScopeChain, type ScopeTarget } from '../services/authz.ts';
import { credentialsOf, serializeConnection } from '../services/connections.ts';
import { idParams, orgParams, secured } from './_common.ts';

export const connectionRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);
  const scopeOf = (orgId: string, locationId: string | null): ScopeTarget => (locationId ? { organizationId: orgId, kind: 'location', id: locationId } : { organizationId: orgId, kind: 'organization', id: orgId });

  async function load(orgId: string, id: string) {
    const [c] = await s.db.select().from(connections).where(and(eq(connections.id, id), eq(connections.organizationId, orgId)));
    if (!c) throw notFound('Connection');
    return c;
  }

  app.get('/orgs/:orgId/connections', { schema: { tags: ['connections'], security: secured, params: orgParams } }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'connections.manage');
    const rows = await s.db.select().from(connections).where(eq(connections.organizationId, req.params.orgId));
    const errs = await s.db.select({ id: externalMappings.connectionId, c: count() }).from(externalMappings).where(and(eq(externalMappings.organizationId, req.params.orgId), eq(externalMappings.status, 'error'))).groupBy(externalMappings.connectionId);
    return {
      items: rows.filter((c) => allowed === 'all' || (c.locationId && allowed.has(c.locationId))).map((c) => serializeConnection(c, { mappingErrors: errs.find((e) => e.id === c.id)?.c ?? 0 })),
      catalog: CONNECTOR_CATALOG,
    };
  });

  app.post('/orgs/:orgId/connections', {
    schema: {
      tags: ['connections'], security: secured, params: orgParams,
      summary: 'Create a connection. Declare data direction and which system is authoritative. Credentials are encrypted and never returned.',
      body: z.object({
        provider: z.enum(CONNECTOR_PROVIDERS), locationId: z.uuid().nullable().default(null),
        direction: z.enum(['import', 'export', 'bidirectional']), authoritative: z.enum(['external', 'branchharbor']),
        config: z.record(z.string(), z.unknown()).default({}), credentials: z.record(z.string(), z.string()).optional(),
      }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    await requirePerm(req, s.db, 'connections.manage', scopeOf(orgId, b.locationId));
    const cat = CONNECTOR_CATALOG.find((c) => c.provider === b.provider)!;
    if (cat.support === 'planned') throw conflict('connector_planned', `${cat.name} is planned and not yet available`);
    if (!cat.directions.includes(b.direction)) throw validationError(`${cat.name} supports: ${cat.directions.join(', ')}`, { direction: 'Unsupported direction' });
    const [c] = await s.db.insert(connections).values({
      organizationId: orgId, locationId: b.locationId, provider: b.provider, kind: cat.kind, direction: b.direction, authoritative: b.authoritative,
      config: b.config, credentialsEncrypted: b.credentials ? encrypt(JSON.stringify(b.credentials), s.cfg.ENCRYPTION_KEY) : null, state: 'disconnected', createdBy: req.user!.id,
    }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'connection.created', scopeKind: b.locationId ? 'location' : 'organization', scopeId: b.locationId ?? orgId, targetType: 'connection', targetId: c!.id, metadata: { provider: b.provider } });
    return reply.code(201).send(serializeConnection(c!));
  });

  app.post('/orgs/:orgId/connections/:id/test', { schema: { tags: ['connections'], security: secured, params: idParams, summary: 'Test the connection and update its state' } }, async (req) => {
    const c = await load(req.params.orgId, req.params.id);
    await requirePerm(req, s.db, 'connections.manage', scopeOf(c.organizationId, c.locationId));
    const result = await s.connectors[c.provider as ConnectorProvider].test(c.config, credentialsOf(s, c));
    const [u] = await s.db.update(connections).set({
      state: result.ok ? (c.lastSuccessAt ? 'connected' : 'initial_sync') : result.state,
      lastError: result.ok ? null : result.message, lastErrorAt: result.ok ? c.lastErrorAt : new Date(), updatedAt: new Date(),
    }).where(eq(connections.id, c.id)).returning();
    return { result, connection: serializeConnection(u!) };
  });

  app.post('/orgs/:orgId/connections/:id/sync', { schema: { tags: ['connections'], security: secured, params: idParams, summary: 'Queue a sync run (background)' } }, async (req, reply) => {
    const c = await load(req.params.orgId, req.params.id);
    await requirePerm(req, s.db, 'connections.manage', scopeOf(c.organizationId, c.locationId));
    if (c.state === 'authorization_expired' || c.state === 'disconnected') throw conflict('connection_unavailable', `Connection is ${c.state}. Test or re-authorise it first.`);
    const [run] = await s.db.insert(syncRuns).values({ organizationId: c.organizationId, connectionId: c.id }).returning();
    await s.jobs.enqueue('connection.sync', { connectionId: c.id, syncRunId: run!.id });
    return reply.code(202).send(run);
  });

  app.get('/orgs/:orgId/connections/:id/status', { schema: { tags: ['connections'], security: secured, params: idParams, summary: 'Sync health: state, last success, recent runs and mapping errors' } }, async (req) => {
    const c = await load(req.params.orgId, req.params.id);
    await requirePerm(req, s.db, 'connections.manage', scopeOf(c.organizationId, c.locationId));
    const runs = await s.db.select().from(syncRuns).where(eq(syncRuns.connectionId, c.id)).orderBy(desc(syncRuns.createdAt)).limit(10);
    const counts = await s.db.select({ status: externalMappings.status, c: count() }).from(externalMappings).where(eq(externalMappings.connectionId, c.id)).groupBy(externalMappings.status);
    const recovery = c.state === 'authorization_expired' ? 'Re-authorise the connection' : c.state === 'degraded' ? 'Resolve mapping errors or test the connection' : c.state === 'disconnected' ? 'Test the connection' : null;
    return { connection: serializeConnection(c), mappings: Object.fromEntries(counts.map((x) => [x.status, x.c])), recentRuns: runs, recoveryAction: recovery };
  });

  app.get('/orgs/:orgId/connections/:id/mappings', {
    schema: { tags: ['connections'], security: secured, params: idParams, querystring: z.object({ status: z.enum(['mapped', 'error', 'ignored', 'pending_review']).optional() }) },
  }, async (req) => {
    const c = await load(req.params.orgId, req.params.id);
    await requirePerm(req, s.db, 'connections.manage', scopeOf(c.organizationId, c.locationId));
    const conds = [eq(externalMappings.connectionId, c.id)];
    if (req.query.status) conds.push(eq(externalMappings.status, req.query.status));
    return { items: await s.db.select().from(externalMappings).where(and(...conds)).orderBy(desc(externalMappings.updatedAt)) };
  });

  app.post('/orgs/:orgId/connections/:id/mappings/:mappingId/resolve', {
    schema: {
      tags: ['connections'], security: secured, params: idParams.extend({ mappingId: z.uuid() }),
      summary: 'Resolve a mapping error by linking to a BranchHarbor record or ignoring it',
      body: z.discriminatedUnion('action', [z.object({ action: z.literal('map'), internalId: z.uuid() }), z.object({ action: z.literal('ignore') })]),
    },
  }, async (req) => {
    const c = await load(req.params.orgId, req.params.id);
    await requirePerm(req, s.db, 'connections.manage', scopeOf(c.organizationId, c.locationId));
    const [m] = await s.db.select().from(externalMappings).where(and(eq(externalMappings.id, req.params.mappingId), eq(externalMappings.connectionId, c.id)));
    if (!m) throw notFound('Mapping');
    if (req.body.action === 'map' && m.entityType === 'location') await resolveScopeChain(s.db, { organizationId: c.organizationId, kind: 'location', id: req.body.internalId });
    const [u] = await s.db.update(externalMappings).set(req.body.action === 'map'
      ? { status: 'mapped', internalId: req.body.internalId, error: null, resolvedBy: req.user!.id, updatedAt: new Date() }
      : { status: 'ignored', error: null, resolvedBy: req.user!.id, updatedAt: new Date() }).where(eq(externalMappings.id, m.id)).returning();
    const [{ remaining } = { remaining: 0 }] = await s.db.select({ remaining: count() }).from(externalMappings).where(and(eq(externalMappings.connectionId, c.id), eq(externalMappings.status, 'error')));
    if (remaining === 0 && c.state === 'degraded') await s.db.update(connections).set({ state: 'connected', lastError: null, updatedAt: new Date() }).where(eq(connections.id, c.id));
    await audit(s.db, { organizationId: c.organizationId, ...actor(req), action: 'connection.mapping_resolved', targetType: 'external_mapping', targetId: m.id, metadata: req.body });
    return { mapping: u, remainingErrors: remaining };
  });

  app.delete('/orgs/:orgId/connections/:id', { schema: { tags: ['connections'], security: secured, params: idParams, summary: 'Disconnect (credentials removed; mappings kept for audit)' } }, async (req) => {
    const c = await load(req.params.orgId, req.params.id);
    await requirePerm(req, s.db, 'connections.manage', scopeOf(c.organizationId, c.locationId));
    const [u] = await s.db.update(connections).set({ state: 'disconnected', credentialsEncrypted: null, updatedAt: new Date() }).where(eq(connections.id, c.id)).returning();
    await audit(s.db, { organizationId: c.organizationId, ...actor(req), action: 'connection.disconnected', targetType: 'connection', targetId: c.id });
    return serializeConnection(u!);
  });
};

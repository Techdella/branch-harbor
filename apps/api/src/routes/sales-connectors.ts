import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { SALES_CONNECTOR_PROVIDERS, SALES_SOURCE_KINDS, type SalesConnectorProvider } from '@bh/shared';
import { locations, ownerGroups, salesConnections } from '../db/schema/index.ts';
import { SALES_ADAPTERS } from '../integrations/sales/index.ts';
import { forbidden, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { capabilityLocations, hasCapability, locationAllowed, requireCapability, type ScopeTarget } from '../services/authz.ts';
import { major, toCsv } from '../services/finance/exports.ts';
import {
  catalog, completeOAuth, connectionsFor, createSalesConnection, disconnect, loadConnection, queueNightlySync, queueSync, reconnect, recentRuns, runSalesSync, salesCredentials, serializeRun,
  serializeSalesConnection,
} from '../services/sales-connectors.ts';
import { dailyRows, openStatementsFor, reconciliation, serializeSource, setSalesSource, sourcesFor } from '../services/sales-sources.ts';
import { idParams, orgParams, secured } from './_common.ts';

const MODULE = 'network.sales_connectors';
const tags = ['sales-connectors'];
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const configSchema = z.object({
  externalLocationId: z.string().max(120).optional(), restaurantGuid: z.string().max(60).optional(), siteId: z.string().max(20).optional(), shopDomain: z.string().max(200).optional(),
  series: z.enum(['x_series', 'k_series']).optional(), domainPrefix: z.string().max(80).optional(), merchantId: z.string().max(60).optional(),
  includeOnline: z.boolean().optional(), includeOnlineStore: z.boolean().optional(),
}).strict();

function range(q: { from?: string; to?: string }, now = new Date()) {
  if (q.from && q.to) {
    if (q.to < q.from) throw validationError('The end date must be on or after the start date', { to: 'After start' });
    if ((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > 366) throw validationError('Choose a period of one year or less', { from: 'Too long' });
    return { from: q.from, to: q.to };
  }
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** OAuth callback (public: the vendor redirects the merchant's browser here). Single-use state; always redirects to the app. */
export const salesConnectorPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.get('/sales-connectors/oauth/callback', {
    schema: { tags, querystring: z.record(z.string(), z.string()), summary: 'OAuth callback for POS / booking connectors (Square, Shopify, Lightspeed, Clover). Redirects back to the app.' },
  }, async (req, reply) => reply.redirect(await completeOAuth(s, req.query)));
};

/**
 * POS and booking sales connectors (`/v1/orgs/:orgId/sales-connectors`, module `network.sales_connectors`): connections
 * per location, sync runs, each location's gross-sales source and the reconciliation view.
 */
export const salesConnectorRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);
  s.jobs.register('sales.sync', async ({ runId }: { runId: string }) => runSalesSync(s, runId));
  s.jobs.register('sales.nightly', async () => { await queueNightlySync(s); });
  const locTarget = (orgId: string, id: string): ScopeTarget => ({ organizationId: orgId, kind: 'location', id });
  const some = (x: 'all' | Set<string>) => x === 'all' || x.size > 0;

  app.get('/orgs/:orgId/sales-connectors', { schema: { tags, security: secured, params: orgParams, summary: 'Connector catalogue, the locations in scope with their connections and gross-sales source' } }, async (req) => {
    const { orgId } = req.params;
    const scope = await capabilityLocations(req, db, orgId, MODULE, 'view');
    if (!some(scope)) throw forbidden('Sales connectors are not part of your access');
    const editable = await capabilityLocations(req, db, orgId, MODULE, 'edit');
    const publishable = await capabilityLocations(req, db, orgId, MODULE, 'publish');
    const conns = await connectionsFor(db, orgId, scope);
    const sources = await sourcesFor(db, orgId);
    const groups = new Map((await db.select({ id: ownerGroups.id, name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.organizationId, orgId))).map((g) => [g.id, g.name]));
    const locs = (await db.select().from(locations).where(eq(locations.organizationId, orgId))).filter((l) => !l.archivedAt && locationAllowed(scope, l.id)).sort((a, b) => a.name.localeCompare(b.name));
    return {
      catalog: catalog(s),
      locations: locs.map((l) => ({
        id: l.id, name: l.name, code: l.code, currency: l.currency, timeZone: l.timeZone, status: l.status, paymentsEnabled: l.paymentsEnabled, ownerGroupName: l.ownerGroupId ? groups.get(l.ownerGroupId) ?? null : null,
        source: serializeSource(l.id, sources.get(l.id)),
        connections: conns.filter((c) => c.locationId === l.id).map((c) => serializeSalesConnection(c)),
        can: { edit: locationAllowed(editable, l.id), publish: locationAllowed(publishable, l.id) },
      })),
      can: { edit: some(editable), publish: some(publishable), export: some(await capabilityLocations(req, db, orgId, MODULE, 'export')) },
    };
  });

  app.post('/orgs/:orgId/sales-connectors', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), provider: z.enum(SALES_CONNECTOR_PROVIDERS), config: configSchema.default({}) }), summary: 'Connect a POS / booking system for a location. Returns the vendor authorisation URL (OAuth) or the activation link (Mindbody).' },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requireCapability(req, db, MODULE, 'edit', locTarget(orgId, req.body.locationId));
    const r = await createSalesConnection(s, orgId, { locationId: req.body.locationId, provider: req.body.provider, config: req.body.config }, req.user!.id);
    return reply.code(201).send({ connection: serializeSalesConnection(r.connection), authorizeUrl: r.authorizeUrl, activationUrl: r.activationUrl });
  });

  app.get('/orgs/:orgId/sales-connectors/:id', { schema: { tags, security: secured, params: idParams, summary: 'A connection with its recent sync runs' } }, async (req) => {
    const c = await loadConnection(db, req.params.orgId, req.params.id);
    await requireCapability(req, db, MODULE, 'view', locTarget(c.organizationId, c.locationId));
    return { connection: serializeSalesConnection(c), runs: (await recentRuns(db, c.id, 20)).map(serializeRun) };
  });

  app.patch('/orgs/:orgId/sales-connectors/:id', { schema: { tags, security: secured, params: idParams, body: z.object({ config: configSchema }), summary: 'Change a connection’s settings (e.g. which vendor location feeds this location)' } }, async (req) => {
    const c = await loadConnection(db, req.params.orgId, req.params.id);
    await requireCapability(req, db, MODULE, 'edit', locTarget(c.organizationId, c.locationId));
    const first = !c.config.externalLocationId && !!req.body.config.externalLocationId;
    const [u] = await db.update(salesConnections).set({ config: { ...c.config, ...req.body.config }, updatedAt: new Date() }).where(eq(salesConnections.id, c.id)).returning();
    await audit(db, { organizationId: c.organizationId, actorUserId: req.user!.id, action: 'sales_connector.updated', scopeKind: 'location', scopeId: c.locationId, targetType: 'sales_connection', targetId: c.id, metadata: req.body.config });
    if (first && u!.status === 'connected') await queueSync(s, u!, 'initial', null, null, req.user!.id);
    return serializeSalesConnection(u!);
  });

  app.get('/orgs/:orgId/sales-connectors/:id/external-locations', { schema: { tags, security: secured, params: idParams, summary: 'The vendor account’s locations / outlets, to choose which one feeds this location' } }, async (req) => {
    const c = await loadConnection(db, req.params.orgId, req.params.id);
    await requireCapability(req, db, MODULE, 'edit', locTarget(c.organizationId, c.locationId));
    if (c.mode === 'sandbox') return { items: [{ id: `${c.provider}-sandbox-1`, name: 'Sandbox location', currency: null, timeZone: null }], sandbox: true };
    if (c.status !== 'connected') return { items: [], sandbox: false };
    try {
      return { items: await SALES_ADAPTERS[c.provider as SalesConnectorProvider].listLocations(s.cfg, s.partnerFetch, salesCredentials(s, c), c.config), sandbox: false };
    } catch (err) {
      return { items: [], sandbox: false, error: (err as Error).message };
    }
  });

  app.post('/orgs/:orgId/sales-connectors/:id/reconnect', { schema: { tags, security: secured, params: idParams, summary: 'Re-authorise an expired connection or re-check a pending activation' } }, async (req) => {
    const c = await loadConnection(db, req.params.orgId, req.params.id);
    await requireCapability(req, db, MODULE, 'edit', locTarget(c.organizationId, c.locationId));
    const r = await reconnect(s, c, req.user!.id);
    return { connection: serializeSalesConnection(r.connection), authorizeUrl: r.authorizeUrl, activationUrl: r.activationUrl };
  });

  app.post('/orgs/:orgId/sales-connectors/:id/sync', {
    schema: { tags, security: secured, params: idParams, body: z.object({ from: ymd.optional(), to: ymd.optional() }).default({}), summary: 'Resync now (background). Without dates: the last three days; with dates: up to 92 days.' },
  }, async (req, reply) => {
    const c = await loadConnection(db, req.params.orgId, req.params.id);
    await requireCapability(req, db, MODULE, 'edit', locTarget(c.organizationId, c.locationId));
    if (!!req.body.from !== !!req.body.to) throw validationError('Send both dates or neither', { to: 'Required with from' });
    const run = await queueSync(s, c, 'manual', req.body.from ?? null, req.body.to ?? null, req.user!.id);
    return reply.code(202).send(serializeRun(run));
  });

  app.delete('/orgs/:orgId/sales-connectors/:id', { schema: { tags, security: secured, params: idParams, summary: 'Disconnect (tokens removed; synced daily sales are kept)' } }, async (req) => {
    const c = await loadConnection(db, req.params.orgId, req.params.id);
    await requireCapability(req, db, MODULE, 'edit', locTarget(c.organizationId, c.locationId));
    return serializeSalesConnection(await disconnect(s, c, req.user!.id));
  });

  app.put('/orgs/:orgId/sales-connectors/sources/:locationId', {
    schema: {
      tags, security: secured, params: orgParams.extend({ locationId: z.uuid() }),
      body: z.object({ source: z.enum(SALES_SOURCE_KINDS), connectionId: z.uuid().nullable().optional(), varianceThresholdBps: z.number().int().min(0).max(5000).optional(), note: z.string().max(500).nullable().optional() }),
      summary: 'Set the location’s gross-sales source for royalties: BranchHarbor payments, one connector, or self-reported with evidence',
    },
  }, async (req) => {
    const { orgId, locationId } = req.params;
    await requireCapability(req, db, MODULE, 'publish', locTarget(orgId, locationId));
    const row = await setSalesSource(s, orgId, locationId, req.body, req.user!.id);
    return { ...serializeSource(locationId, row), openStatements: (await openStatementsFor(db, locationId)).length };
  });

  app.get('/orgs/:orgId/sales-connectors/reconciliation', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ from: ymd.optional(), to: ymd.optional() }), summary: 'BranchHarbor payments vs connector sales vs self-reported figures per location, with variance flags (per currency)' },
  }, async (req) => {
    const { orgId } = req.params;
    const scope = await capabilityLocations(req, db, orgId, MODULE, 'view');
    if (!some(scope)) throw forbidden('Sales connectors are not part of your access');
    return { ...(await reconciliation(db, orgId, scope, range(req.query).from, range(req.query).to)), can: { export: some(await capabilityLocations(req, db, orgId, MODULE, 'export')) } };
  });

  app.get('/orgs/:orgId/sales-connectors/reconciliation/export', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ from: ymd.optional(), to: ymd.optional() }), summary: 'The reconciliation as CSV (amounts in each location’s currency)' },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const scope = await capabilityLocations(req, db, orgId, MODULE, 'export');
    if (!some(scope)) throw forbidden('Exporting needs Sales connectors (export)');
    const r = await reconciliation(db, orgId, scope, range(req.query).from, range(req.query).to);
    const rows = r.rows.flatMap((x) => {
      const base = [x.location.name, x.location.code, x.location.currency, x.source.source];
      const bh = [...base, 'branchharbor', major(x.branchharbor.grossMinor, x.location.currency), major(x.branchharbor.refundsMinor, x.location.currency), major(x.branchharbor.taxMinor, x.location.currency), major(x.branchharbor.netMinor, x.location.currency), '', '', x.flags.join(' ')];
      const cs = x.connectors.map((c) => [...base, c.provider, major(c.grossMinor, x.location.currency), major(c.refundsMinor, x.location.currency), major(c.taxMinor, x.location.currency), major(c.netMinor, x.location.currency), c.missingDays, c.sandbox ? 'sandbox' : '', '']);
      const sr = x.selfReported.map((p) => [...base, `self_reported ${p.periodStart}`, major(p.grossMinor, p.currency), major(p.refundsMinor, p.currency), major(p.taxMinor, p.currency), '', '', p.comparison?.variance.pct ?? '', p.comparison?.variance.flagged ? 'variance' : '']);
      return [bh, ...cs, ...sr];
    });
    const csv = toCsv(['location', 'code', 'currency', 'source_of_record', 'data_from', 'gross', 'refunds', 'tax', 'net', 'missing_days', 'variance_pct_or_mode', 'flags'], rows);
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="sales-reconciliation-${r.from}-${r.to}.csv"`).send(csv);
  });

  app.get('/orgs/:orgId/sales-connectors/daily', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid(), from: ymd.optional(), to: ymd.optional() }), summary: 'Daily sales rows of a location (every source and channel)' },
  }, async (req) => {
    const { orgId } = req.params;
    await requireCapability(req, db, MODULE, 'view', locTarget(orgId, req.query.locationId));
    const [l] = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.id, req.query.locationId), eq(locations.organizationId, orgId)));
    if (!l) throw forbidden('Location not in this business');
    const r = range(req.query);
    return { ...r, items: await dailyRows(db, l.id, r.from, r.to) };
  });

  app.post('/orgs/:orgId/sales-connectors/nightly', { schema: { tags, security: secured, params: orgParams, summary: 'Queue the nightly sync now for this business’s connections (HQ)' } }, async (req, reply) => {
    const { orgId } = req.params;
    if (!(await hasCapability(req, db, MODULE, 'publish', { organizationId: orgId, kind: 'organization', id: orgId }))) throw forbidden('Only HQ can run the nightly sync');
    let queued = 0;
    for (const c of await connectionsFor(db, orgId, 'all')) if (c.status === 'connected') { await queueSync(s, c, 'nightly', null, null, req.user!.id); queued++; }
    return reply.code(202).send({ queued });
  });
};

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { organizations } from '../db/schema/index.ts';
import { forbidden } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { hasCapability } from '../services/authz.ts';
import { benchmarksFor, benchmarkSettings, lastFullMonth, recomputeBenchmarks, setBenchmarkOptIn } from '../services/benchmarks.ts';
import { requireNetwork } from '../services/businessMode.ts';
import { orgParams, secured } from './_common.ts';

const MODULE = 'network.benchmarks';
const tags = ['benchmarks'];
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');

/**
 * Opt-in network benchmarks (`/v1/orgs/:orgId/benchmarks`, module `network.benchmarks`, HQ-private): "you vs similar
 * networks" percentiles from k-anonymous, noised cohorts. Only participating organisations see benchmarks.
 */
export const benchmarkRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);
  s.jobs.register('benchmarks.recompute', async ({ period: p }: { period?: string }) => { await recomputeBenchmarks(s, p ?? lastFullMonth()); });
  const target = (orgId: string) => ({ organizationId: orgId, kind: 'organization' as const, id: orgId });
  const load = async (orgId: string) => (await db.select().from(organizations).where(eq(organizations.id, orgId)))[0]!;

  app.get('/orgs/:orgId/benchmarks', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ period: period.optional() }), summary: 'Your network against similar networks (same industry and region), as percentiles. Needs opting in.' },
  }, async (req) => {
    const { orgId } = req.params;
    if (!(await hasCapability(req, db, MODULE, 'view', target(orgId)))) throw forbidden('Benchmarks are not part of your access');
    const org = await load(orgId);
    requireNetwork(org, 'Network benchmarks');
    return { ...(await benchmarksFor(db, org, req.query.period ?? lastFullMonth())), can: { manage: await hasCapability(req, db, MODULE, 'publish', target(orgId)) } };
  });

  app.put('/orgs/:orgId/benchmarks/settings', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ optIn: z.boolean() }), summary: 'Take part in anonymised network benchmarks (off by default). Opting out deletes your contributions.' },
  }, async (req) => {
    const { orgId } = req.params;
    if (!(await hasCapability(req, db, MODULE, 'publish', target(orgId)))) throw forbidden('Only HQ can change benchmark participation');
    const org = await load(orgId);
    requireNetwork(org, 'Network benchmarks');
    const st = await setBenchmarkOptIn(s, org, req.body.optIn, req.user!.id);
    if (st.optIn) await s.jobs.enqueue('benchmarks.recompute', { period: lastFullMonth() }, { jobId: `benchmarks-${lastFullMonth()}-${orgId}` });
    return st;
  });

  app.get('/orgs/:orgId/benchmarks/settings', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    if (!(await hasCapability(req, db, MODULE, 'view', target(orgId)))) throw forbidden('Benchmarks are not part of your access');
    return benchmarkSettings(await load(orgId));
  });
};

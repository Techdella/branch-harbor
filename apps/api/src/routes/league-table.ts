import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { organizations } from '../db/schema/index.ts';
import { forbidden, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { capabilityLocations, hasCapability } from '../services/authz.ts';
import { LEAGUE_MODULE, leagueSettings, leagueTable } from '../services/league-table.ts';
import { major, toCsv } from '../services/finance/exports.ts';
import { orgParams, secured } from './_common.ts';

const tags = ['league-table'];
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const query = z.object({
  from: ymd.optional(),
  to: ymd.optional(),
  sort: z.enum(['revenue', 'growth', 'activity', 'occupancy', 'auditScore', 'royaltyStatus', 'reviewRating']).default('revenue'),
  regionId: z.uuid().optional(),
  ownerGroupId: z.uuid().optional(),
  territoryId: z.uuid().optional(),
});

/** Last full month by default. */
function period(q: { from?: string; to?: string }, now = new Date()) {
  if (q.from && q.to) {
    if (q.to < q.from) throw validationError('The end date must be on or after the start date', { to: 'After start' });
    if ((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > 731) throw validationError('Choose a period of two years or less', { from: 'Too long' });
    return { from: q.from, to: q.to };
  }
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/**
 * League table (`/v1/orgs/:orgId/league-table`, module `network.league_table`): ranking, network quartiles, the HQ
 * setting for what franchise owners see, and the CSV export.
 */
export const leagueTableRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);
  const orgTarget = (orgId: string) => ({ organizationId: orgId, kind: 'organization' as const, id: orgId });

  app.get('/orgs/:orgId/league-table', {
    schema: { tags, security: secured, params: orgParams, querystring: query, summary: 'Locations in scope ranked by revenue (per currency), growth, activity, occupancy, audit score, royalty status or review rating, with anonymised network quartiles' },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await capabilityLocations(req, db, orgId, LEAGUE_MODULE, 'view');
    if (allowed !== 'all' && !allowed.size) throw forbidden('The league table is not part of your access');
    const out = await leagueTable(req, db, orgId, { ...req.query, ...period(req.query) });
    return {
      ...out,
      can: {
        export: await (async () => { const x = await capabilityLocations(req, db, orgId, LEAGUE_MODULE, 'export'); return x === 'all' || x.size > 0; })(),
        manage: await hasCapability(req, db, LEAGUE_MODULE, 'publish', orgTarget(orgId)),
      },
    };
  });

  app.get('/orgs/:orgId/league-table/export', { schema: { tags, security: secured, params: orgParams, querystring: query, summary: 'The league table as CSV (export). Revenue columns are per location currency.' } }, async (req, reply) => {
    const { orgId } = req.params;
    const allowed = await capabilityLocations(req, db, orgId, LEAGUE_MODULE, 'export');
    if (allowed !== 'all' && !allowed.size) throw forbidden('Exporting the league table needs League table (export)');
    const out = await leagueTable(req, db, orgId, { ...req.query, ...period(req.query) });
    const rows = out.rows.filter((r) => allowed === 'all' || allowed.has(r.locationId));
    const csv = toCsv(
      ['rank', 'of', 'location', 'code', 'region', 'owner_group', 'currency', 'revenue', 'previous_revenue', 'growth_pct', out.activityKind ?? 'activity', 'occupancy_pct', 'audit_score_pct', 'royalty_status', 'review_rating', 'network_quartile'],
      rows.map((r) => [r.rank || '', r.rankOf || '', r.name, r.code, r.regionName ?? '', r.ownerGroupName ?? '', r.currency, r.revenueMinor === null ? '' : major(r.revenueMinor, r.currency), r.previousRevenueMinor === null ? '' : major(r.previousRevenueMinor, r.currency),
        r.growthPct ?? '', r.activity, r.occupancyPct ?? '', r.auditScorePct ?? '', r.royaltyStatus ?? '', r.reviewRating ?? '', r.quartile ?? '']),
    );
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="league-table-${out.period.from}-${out.period.to}.csv"`).send(csv);
  });

  app.get('/orgs/:orgId/league-table/settings', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    if (!(await hasCapability(req, db, LEAGUE_MODULE, 'publish', orgTarget(orgId)))) throw forbidden('Only HQ can change the league table settings');
    const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    return leagueSettings(o!);
  });

  app.put('/orgs/:orgId/league-table/settings', { schema: { tags, security: secured, params: orgParams, body: z.object({ franchiseeQuartiles: z.boolean() }), summary: 'Whether franchise owners see their locations against anonymised network quartiles' } }, async (req) => {
    const { orgId } = req.params;
    if (!(await hasCapability(req, db, LEAGUE_MODULE, 'publish', orgTarget(orgId)))) throw forbidden('Only HQ can change the league table settings');
    const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    const settings = { ...o!.settings, leagueTable: { ...((o!.settings.leagueTable as object) ?? {}), franchiseeQuartiles: req.body.franchiseeQuartiles } };
    await db.update(organizations).set({ settings, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'league_table.settings_updated', metadata: req.body, ip: req.ip });
    return leagueSettings({ settings });
  });
};

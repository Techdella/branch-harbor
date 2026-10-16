import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { bulkLaunchItems, bulkLaunches, importBatches, templates } from '../db/schema/index.ts';
import { forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { hasCapability } from '../services/authz.ts';
import { createLaunch, parseLaunchSheet, retryFailed, runLaunch, serializeLaunch, validateLaunchRows, type LaunchRow } from '../services/launches.ts';
import { idParams, orgParams, secured } from './_common.ts';

const MODULE = 'network.bulk_launch';
const tags = ['launches'];
const opt = z.string().max(500).nullable().optional();
const rowSchema = z.object({
  name: z.string().min(1).max(160), code: z.string().min(1).max(24), address_line1: z.string().min(1).max(200), address_line2: opt, city: z.string().min(1).max(120), state_region: opt, postal_code: opt,
  country: z.string().length(2), time_zone: z.string().min(1).max(60), currency: z.string().length(3), phone: opt, email: opt, region: opt, owner_group: opt, manager_email: opt, staff_emails: z.string().max(2000).nullable().optional(),
  listing_description: z.string().max(750).nullable().optional(), listing_categories: opt, opening_date: opt,
});

/**
 * Bulk location launch (`/v1/orgs/:orgId/launches`, module `network.bulk_launch`, HQ-private): parse a spreadsheet,
 * validate, launch (locations + sites from the brand template + listings data + staff invitations) and follow the
 * progress board. Publishing sites needs Bulk launch (publish); drafts need edit.
 */
export const launchRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);
  s.jobs.register('launches.run', async ({ launchId }: { launchId: string }) => runLaunch(s, launchId));
  const org = (orgId: string) => ({ organizationId: orgId, kind: 'organization' as const, id: orgId });
  const need = async (req: Parameters<typeof hasCapability>[0], orgId: string, action: 'view' | 'edit' | 'publish') => {
    if (!(await hasCapability(req, db, MODULE, action, org(orgId)))) throw forbidden(`Bulk launch (${action}) is needed`);
  };

  app.post('/orgs/:orgId/launches/parse', {
    bodyLimit: 12 * 1024 * 1024,
    schema: { tags, security: secured, params: orgParams, body: z.object({ filename: z.string().min(1).max(200), dataBase64: z.string().min(4) }).or(z.object({ importBatchId: z.uuid() })), summary: 'Read a launch spreadsheet (CSV / XLSX) or a locations import into launch rows, with row errors' },
  }, async (req) => {
    const { orgId } = req.params;
    await need(req, orgId, 'edit');
    let rows: LaunchRow[];
    if ('importBatchId' in req.body) {
      const [b] = await db.select().from(importBatches).where(and(eq(importBatches.id, req.body.importBatchId), eq(importBatches.organizationId, orgId)));
      if (!b || b.entity !== 'locations') throw notFound('Locations import');
      const col = (k: string) => b.mapping[k];
      rows = b.rows.map((r) => Object.fromEntries(['name', 'code', 'address_line1', 'address_line2', 'city', 'state_region', 'postal_code', 'country', 'time_zone', 'currency', 'phone', 'email', 'region', 'owner_group'].map((k) => [k, col(k) !== null && col(k) !== undefined ? r[col(k)!] ?? '' : '']))) as unknown as LaunchRow[];
    } else rows = parseLaunchSheet(req.body.filename, req.body.dataBase64);
    const checks = await validateLaunchRows(db, orgId, rows);
    return { rows, errors: checks.filter((c) => c.errors.length), valid: checks.filter((c) => !c.errors.length).length };
  });

  app.post('/orgs/:orgId/launches', {
    schema: {
      tags, security: secured, params: orgParams,
      body: z.object({
        name: z.string().min(1).max(120), templateId: z.uuid().nullable().optional(), siteMode: z.enum(['publish', 'draft']).default('draft'), locationStatus: z.enum(['onboarding', 'opening_soon', 'operating']).default('opening_soon'),
        inviteStaff: z.boolean().default(true), staffRole: z.enum(['staff', 'location_manager', 'content_social']).default('staff'), rows: z.array(rowSchema).min(1).max(200), importBatchId: z.uuid().nullable().optional(),
      }),
      summary: 'Launch many locations at once (background): location, site from the brand template, listings data, staff invitations',
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await need(req, orgId, req.body.siteMode === 'publish' ? 'publish' : 'edit');
    if (req.body.rows.some((r) => !r.name.trim())) throw validationError('Every row needs a name');
    const l = await createLaunch(s, orgId, { ...req.body, rows: req.body.rows as LaunchRow[] }, req.user!.id);
    return reply.code(202).send(serializeLaunch(l));
  });

  app.get('/orgs/:orgId/launches', { schema: { tags, security: secured, params: orgParams, summary: 'Launches, newest first, with the brand templates to launch from' } }, async (req) => {
    const { orgId } = req.params;
    await need(req, orgId, 'view');
    const rows = await db.select().from(bulkLaunches).where(eq(bulkLaunches.organizationId, orgId)).orderBy(desc(bulkLaunches.createdAt)).limit(50);
    const tpls = await db.select({ id: templates.id, name: templates.name, pageSlug: templates.pageSlug }).from(templates).where(eq(templates.organizationId, orgId)).orderBy(asc(templates.createdAt));
    return {
      items: rows.map((l) => serializeLaunch(l)), templates: tpls,
      can: { edit: await hasCapability(req, db, MODULE, 'edit', org(orgId)), publish: await hasCapability(req, db, MODULE, 'publish', org(orgId)) },
    };
  });

  app.get('/orgs/:orgId/launches/:id', { schema: { tags, security: secured, params: idParams, summary: 'The progress board: every location with its steps' } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'view');
    const [l] = await db.select().from(bulkLaunches).where(and(eq(bulkLaunches.id, id), eq(bulkLaunches.organizationId, orgId)));
    if (!l) throw notFound('Launch');
    const items = await db.select().from(bulkLaunchItems).where(eq(bulkLaunchItems.launchId, l.id)).orderBy(asc(bulkLaunchItems.rowNumber));
    return serializeLaunch(l, items);
  });

  app.post('/orgs/:orgId/launches/:id/retry', { schema: { tags, security: secured, params: idParams, summary: 'Retry the failed locations (each resumes at the step that failed)' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    const [l] = await db.select().from(bulkLaunches).where(and(eq(bulkLaunches.id, id), eq(bulkLaunches.organizationId, orgId)));
    if (!l) throw notFound('Launch');
    await need(req, orgId, l.siteMode === 'publish' ? 'publish' : 'edit');
    return reply.code(202).send({ retried: await retryFailed(s, orgId, id) });
  });
};

import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { IMPORTABLE_ROLES, IMPORT_ENTITIES, IMPORT_FIELDS, MIGRATION_TEMPLATES, importEntitiesFor, suggestRole, type ImportEntity } from '@bh/shared';
import { importBatches, organizations } from '../db/schema/index.ts';
import { conflict, forbidden, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { capabilityLocations, hasCapability } from '../services/authz.ts';
import { toCsv } from '../services/finance/exports.ts';
import { createBatch, loadBatch, moduleFor, planBatch, rollbackBatch, runBatch, serializeBatch, type BatchRow, type ImportAccess } from '../services/imports.ts';
import { idParams, orgParams, secured } from './_common.ts';

const MODULE = 'settings.import';
const tags = ['imports'];
const UPLOAD_LIMIT = 12 * 1024 * 1024;

/**
 * Import wizard (`/v1/orgs/:orgId/imports`, module `settings.import`): upload CSV / XLSX, map columns (auto-detected,
 * vendor migration templates), validate with a row-level preview, dry run, run in the background with progress, and
 * undo within 24 hours. Each record type also needs edit rights on what it creates, checked per row in its scope.
 */
export const importRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);
  s.jobs.register('imports.run', async ({ batchId }: { batchId: string }) => runBatch(s, batchId));
  const org = (orgId: string) => ({ organizationId: orgId, kind: 'organization' as const, id: orgId });

  async function canImport(req: FastifyRequest, orgId: string) {
    const x = await capabilityLocations(req, db, orgId, MODULE, 'edit');
    if (x !== 'all' && !x.size) throw forbidden('Importing needs Import (edit)');
  }
  async function industryOf(orgId: string) {
    return (await db.select({ i: organizations.industry }).from(organizations).where(eq(organizations.id, orgId)))[0]!.i;
  }
  async function accessFor(req: FastifyRequest, orgId: string, entity: ImportEntity): Promise<ImportAccess> {
    const module = moduleFor(entity, await industryOf(orgId));
    const locs = await capabilityLocations(req, db, orgId, module, 'edit');
    return { locations: locs === 'all' ? 'all' : [...locs], orgWide: await hasCapability(req, db, module, 'edit', org(orgId)) };
  }
  async function visible(req: FastifyRequest, b: BatchRow) {
    if (b.createdBy === req.user!.id) return;
    if (!(await hasCapability(req, db, MODULE, 'edit', org(b.organizationId)))) throw forbidden('This import belongs to someone else');
  }

  app.get('/orgs/:orgId/imports/catalog', { schema: { tags, security: secured, params: orgParams, summary: 'Record types this business can import, their fields, migration templates and assignable roles' } }, async (req) => {
    const { orgId } = req.params;
    const industry = await industryOf(orgId);
    const entities = importEntitiesFor(industry);
    return {
      industry,
      entities: await Promise.all(entities.map(async (e) => {
        const a = await accessFor(req, orgId, e);
        return { key: e, fields: IMPORT_FIELDS[e].map((f) => ({ key: f.key, type: f.type, required: !!f.required, values: f.values ?? null })), allowed: a.orgWide || a.locations === 'all' || a.locations.length > 0, orgWide: a.orgWide };
      })),
      templates: MIGRATION_TEMPLATES.filter((t) => entities.includes(t.entity)).map((t) => ({ key: t.key, vendor: t.vendor, entity: t.entity, columns: Object.values(t.columns).map((c) => c[0]) })),
      roles: IMPORTABLE_ROLES,
    };
  });

  app.get('/orgs/:orgId/imports/templates/:entity', { schema: { tags, security: secured, params: orgParams.extend({ entity: z.enum(IMPORT_ENTITIES) }), summary: 'A blank CSV with the columns BranchHarbor recognises for this record type' } }, async (req, reply) => {
    await canImport(req, req.params.orgId);
    const csv = toCsv(IMPORT_FIELDS[req.params.entity].map((f) => f.key), []);
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="branchharbor-${req.params.entity}.csv"`).send(csv);
  });

  app.get('/orgs/:orgId/imports', { schema: { tags, security: secured, params: orgParams, summary: 'Recent imports (yours, or all with Import organisation-wide)' } }, async (req) => {
    const { orgId } = req.params;
    const all = await hasCapability(req, db, MODULE, 'edit', org(orgId));
    if (!all) await canImport(req, orgId);
    const rows = await db.select().from(importBatches).where(and(eq(importBatches.organizationId, orgId), all ? undefined : eq(importBatches.createdBy, req.user!.id))).orderBy(desc(importBatches.createdAt)).limit(50);
    return { items: rows.map((b) => serializeBatch(b)) };
  });

  app.post('/orgs/:orgId/imports', {
    bodyLimit: UPLOAD_LIMIT,
    schema: {
      tags, security: secured, params: orgParams,
      body: z.object({ entity: z.enum(IMPORT_ENTITIES), filename: z.string().min(1).max(200), dataBase64: z.string().min(4), templateKey: z.string().max(60).nullable().optional() }),
      summary: 'Upload a CSV or XLSX file (≤ 8 MB, ≤ 5000 rows). Columns are matched automatically; vendor exports are recognised.',
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await canImport(req, orgId);
    const b = await createBatch(s, orgId, req.body, req.user!.id);
    return reply.code(201).send(serializeBatch(b, { sample: true }));
  });

  app.get('/orgs/:orgId/imports/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const b = await loadBatch(db, req.params.orgId, req.params.id);
    await visible(req, b);
    return serializeBatch(b, { sample: ['uploaded', 'validated'].includes(b.status) });
  });

  const optionsSchema = z.object({
    locationId: z.uuid().nullable().optional(), dateFormat: z.enum(['ymd', 'mdy', 'dmy']).optional(), currency: z.string().length(3).optional(), menuId: z.uuid().nullable().optional(),
    roleMapping: z.record(z.string().max(120), z.enum(IMPORTABLE_ROLES as unknown as [string, ...string[]])).optional(), sendInvites: z.boolean().optional(), createMissingParents: z.boolean().optional(),
  });

  app.put('/orgs/:orgId/imports/:id/mapping', {
    schema: {
      tags, security: secured, params: idParams, body: z.object({ mapping: z.record(z.string(), z.number().int().min(0).nullable()), options: optionsSchema.default({}) }),
      summary: 'Set the column mapping and options, then validate: returns counts, row errors and a preview of the first 50 rows',
    },
  }, async (req) => {
    const b = await loadBatch(db, req.params.orgId, req.params.id);
    await visible(req, b);
    if (!['uploaded', 'validated'].includes(b.status)) throw conflict('import_started', 'This import has already run');
    const fields = new Set(IMPORT_FIELDS[b.entity as ImportEntity].map((f) => f.key));
    for (const [k, v] of Object.entries(req.body.mapping)) {
      if (!fields.has(k)) throw validationError(`Unknown field "${k}"`, { [k]: 'Unknown field' });
      if (v !== null && v >= b.headers.length) throw validationError('Column out of range', { [k]: 'No such column' });
    }
    const access = await accessFor(req, b.organizationId, b.entity as ImportEntity);
    const options = { ...b.options, ...req.body.options, access };
    const [u] = await db.update(importBatches).set({ mapping: req.body.mapping, options, status: 'validated', updatedAt: new Date() }).where(eq(importBatches.id, b.id)).returning();
    const r = await planBatch(db, u!, access);
    await db.update(importBatches).set({ validRows: r.valid, errorRows: r.invalid, errors: r.errors.slice(0, 500) }).where(eq(importBatches.id, b.id));
    // Staff: the distinct titles in the file with the suggested BranchHarbor role, for the role-mapping step.
    const roleCol = u!.mapping.role;
    const roles = b.entity === 'staff' && roleCol !== null && roleCol !== undefined
      ? [...new Set(b.rows.map((row) => row[roleCol] ?? '').filter(Boolean))].map((title) => ({ title, role: ((req.body.options.roleMapping ?? {})[title] as string | undefined) ?? suggestRole(title) }))
      : [];
    return {
      batch: serializeBatch({ ...u!, validRows: r.valid, errorRows: r.invalid, errors: r.errors.slice(0, 500) }, { sample: true }),
      counts: { total: b.totalRows, valid: r.valid, invalid: r.invalid, create: r.creates, update: r.updates, skip: r.skips },
      preview: r.planned.slice(0, 50).map((p) => ({ row: p.row, action: p.errors.length ? 'error' : p.action, summary: p.summary, errors: p.errors, data: Object.fromEntries(Object.entries(p.data).filter(([k]) => !['existingId', 'customerId', 'locationId', 'scopeId'].includes(k))) })),
      roles,
    };
  });

  app.post('/orgs/:orgId/imports/:id/run', {
    schema: { tags, security: secured, params: idParams, body: z.object({ dryRun: z.boolean().default(false) }).default({ dryRun: false }), summary: 'Run the import (or a dry run) in the background. Rows with errors are skipped and listed.' },
  }, async (req, reply) => {
    const b = await loadBatch(db, req.params.orgId, req.params.id);
    await visible(req, b);
    await canImport(req, b.organizationId);
    if (b.status === 'uploaded') throw conflict('import_not_validated', 'Check the mapping and preview first');
    if (!['validated', 'completed'].includes(b.status) || (b.status === 'completed' && !b.dryRun)) throw conflict('import_started', 'This import has already run');
    // Access is re-read now (it may have changed since the preview).
    const access = await accessFor(req, b.organizationId, b.entity as ImportEntity);
    const [u] = await db.update(importBatches).set({ status: 'queued', dryRun: req.body.dryRun, options: { ...b.options, access }, processedRows: 0, createdCount: 0, updatedCount: 0, skippedCount: 0, updatedAt: new Date() }).where(eq(importBatches.id, b.id)).returning();
    await audit(db, { organizationId: b.organizationId, actorUserId: req.user!.id, action: req.body.dryRun ? 'import.dry_run' : 'import.started', targetType: 'import_batch', targetId: b.id, metadata: { entity: b.entity, rows: b.totalRows } });
    await s.jobs.enqueue('imports.run', { batchId: b.id });
    return reply.code(202).send(serializeBatch(u!));
  });

  app.post('/orgs/:orgId/imports/:id/rollback', { schema: { tags, security: secured, params: idParams, summary: 'Undo an import within 24 hours: created records removed, updated ones restored, invitations revoked' } }, async (req) => {
    const b = await loadBatch(db, req.params.orgId, req.params.id);
    await visible(req, b);
    await canImport(req, b.organizationId);
    const r = await rollbackBatch(s, b, req.user!.id);
    return { ...serializeBatch((await loadBatch(db, b.organizationId, b.id))), undone: r.records - r.kept.length, kept: r.kept };
  });

  app.get('/orgs/:orgId/imports/:id/errors', { schema: { tags, security: secured, params: idParams, summary: 'Row errors as CSV' } }, async (req, reply) => {
    const b = await loadBatch(db, req.params.orgId, req.params.id);
    await visible(req, b);
    const csv = toCsv(['row', 'field', 'code', 'message'], b.errors.map((e) => [e.row, e.field, e.code, e.message]));
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="import-errors-${b.id.slice(0, 8)}.csv"`).send(csv);
  });
};


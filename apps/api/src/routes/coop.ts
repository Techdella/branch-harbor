import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { COOP_BASES, COOP_PAYOUT_METHODS, COOP_PERIODS, COOP_SPEND_KINDS, LOCAL_ASSET_KINDS, localAssetFieldSchema, resolveLocalAsset } from '@bh/shared';
import { brandAssets, coopAllowances, coopClaims, coopRequests, financeDocuments, localAssetTemplates, localAssetVersions, locations } from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { hasAt, requireAt, scopeFor } from '../services/comms-scope.ts';
import {
  COOP, burnDown, createRequest, decideClaim, decideRequest, latestClaims, loadClaim, loadRequest, markClaimPaid, people, periodSummary, resubmitRequest, serializeClaim, serializeRequest, submitClaim,
} from '../services/coop.ts';
import { idParams, orgParams, secured } from './_common.ts';

const tags = ['coop'];
const UPLOAD_LIMIT = 24 * 1024 * 1024;
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const upload = z.object({ filename: z.string().min(1).max(200), contentType: z.string().min(3).max(120), dataBase64: z.string().min(4) });
const minorInt = z.number().int().min(0).max(1_000_000_000_00);
const creative = z.array(z.object({ kind: z.enum(['asset', 'local_asset', 'document', 'link']), id: z.string().max(64).nullable().optional(), url: z.url().max(2000).nullable().optional(), name: z.string().trim().min(1).max(200) })).max(20).default([]);

/**
 * Marketing → Co-op fund (`/v1/orgs/:orgId/coop/...`). Access: `marketing.coop` — view (allowances, burn-down,
 * requests and claims in scope), edit (submit requests and claims for the locations in scope), publish
 * (organisation-wide only: allowances, decisions with the brand checklist, reimbursement). Reimbursement can also be
 * recorded by Finance (organisation-wide `finance.marketing_fund` edit), since it books fund ledger spend.
 */
export const coopRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);

  const isHq = (req: FastifyRequest, orgId: string) => hasAt(req, db, orgId, null, COOP, 'publish');
  const requireHq = async (req: FastifyRequest, orgId: string) => { if (!(await isHq(req, orgId))) throw forbidden('Only HQ decides co-op requests and claims'); };
  const scopeIds = async (req: FastifyRequest, orgId: string) => {
    const sc = await scopeFor(req, db, orgId, COOP);
    return sc.all ? ('all' as const) : sc.locationIds!;
  };
  const locRow = async (orgId: string, id: string) => {
    const [l] = await db.select().from(locations).where(and(eq(locations.id, id), eq(locations.organizationId, orgId)));
    if (!l) throw notFound('Location');
    return l;
  };
  const locNames = async (orgId: string) => new Map((await db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.organizationId, orgId))).map((l) => [l.id, l.name]));
  const oneRequest = async (orgId: string, id: string) => {
    const r = await loadRequest(db, orgId, id);
    const [claim] = await latestClaims(db, [r.id]);
    const names = await people(db, [r.requestedBy, r.decidedBy, claim?.submittedBy, claim?.decidedBy]);
    return serializeRequest(r, names, (await locNames(orgId)).get(r.locationId) ?? null, claim ?? null);
  };

  /* ── overview and allowances ── */

  app.get('/orgs/:orgId/coop/overview', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ date: ymd.optional() }), summary: 'Budget burn-down per location and across the network (per currency) for the co-op period containing `date`' },
  }, async (req) => {
    const { orgId } = req.params;
    const ids = await scopeIds(req, orgId);
    const [pending] = await db.select({ requests: sql<number>`(count(*) filter (where ${coopRequests.status} = 'submitted'))::int` }).from(coopRequests)
      .where(and(eq(coopRequests.organizationId, orgId), ids === 'all' ? undefined : ids.length ? inArray(coopRequests.locationId, ids) : sql`false`));
    const [claims] = await db.select({ submitted: sql<number>`(count(*) filter (where ${coopClaims.status} = 'submitted'))::int`, approved: sql<number>`(count(*) filter (where ${coopClaims.status} = 'approved'))::int` }).from(coopClaims)
      .where(and(eq(coopClaims.organizationId, orgId), ids === 'all' ? undefined : ids.length ? inArray(coopClaims.locationId, ids) : sql`false`));
    return { ...(await burnDown(db, orgId, ids, req.query.date)), queue: { requests: pending?.requests ?? 0, claims: claims?.submitted ?? 0, toPay: claims?.approved ?? 0 }, canDecide: await isHq(req, orgId) };
  });

  app.get('/orgs/:orgId/coop/allowances', { schema: { tags, security: secured, params: orgParams, summary: 'Allowance rules: the network default and per-location overrides (in scope)' } }, async (req) => {
    const { orgId } = req.params;
    const ids = await scopeIds(req, orgId);
    const rows = await db.select().from(coopAllowances).where(and(eq(coopAllowances.organizationId, orgId), ids === 'all' ? undefined : or(isNull(coopAllowances.locationId), ids.length ? inArray(coopAllowances.locationId, ids) : sql`false`)));
    return { items: rows.map((r) => ({ id: r.id, locationId: r.locationId, period: r.period, basis: r.basis, percentBps: r.percentBps, fixedMinor: r.fixedMinor, matchRatioBps: r.matchRatioBps, active: r.active, updatedAt: r.updatedAt.toISOString() })), canEdit: await isHq(req, orgId) };
  });

  app.put('/orgs/:orgId/coop/allowances', {
    schema: {
      tags, security: secured, params: orgParams, summary: 'Set the network default (locationId null) or a location’s allowance: a percentage of its fund contributions or a fixed amount per period, with the matching ratio',
      body: z.object({ locationId: z.uuid().nullable().default(null), period: z.enum(COOP_PERIODS), basis: z.enum(COOP_BASES), percentBps: z.number().int().min(0).max(10_000).default(0), fixedMinor: minorInt.default(0), matchRatioBps: z.number().int().min(0).max(10_000), active: z.boolean().default(true) })
        .refine((b) => (b.basis === 'fixed' ? b.fixedMinor > 0 : b.percentBps > 0), { message: 'Set the percentage or the fixed amount', path: ['percentBps'] }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    await requireHq(req, orgId);
    const b = req.body;
    if (b.locationId) await locRow(orgId, b.locationId);
    const values = { period: b.period, basis: b.basis, percentBps: b.percentBps, fixedMinor: b.fixedMinor, matchRatioBps: b.matchRatioBps, active: b.active, updatedBy: req.user!.id, updatedAt: new Date() };
    const [existing] = await db.select().from(coopAllowances).where(and(eq(coopAllowances.organizationId, orgId), b.locationId ? eq(coopAllowances.locationId, b.locationId) : isNull(coopAllowances.locationId)));
    const [row] = existing ? await db.update(coopAllowances).set(values).where(eq(coopAllowances.id, existing.id)).returning() : await db.insert(coopAllowances).values({ organizationId: orgId, locationId: b.locationId, ...values }).returning();
    await audit(db, { organizationId: orgId, ...actor(req), action: 'coop.allowance_set', scopeKind: b.locationId ? 'location' : 'organization', scopeId: b.locationId ?? orgId, targetType: 'coop_allowance', targetId: row!.id, metadata: values });
    return { id: row!.id };
  });

  app.delete('/orgs/:orgId/coop/allowances/:id', { schema: { tags, security: secured, params: idParams, summary: 'Remove a location override (the network default applies again)' } }, async (req) => {
    await requireHq(req, req.params.orgId);
    const [r] = await db.delete(coopAllowances).where(and(eq(coopAllowances.id, req.params.id), eq(coopAllowances.organizationId, req.params.orgId))).returning();
    if (!r) throw notFound('Allowance');
    return { ok: true };
  });

  app.get('/orgs/:orgId/coop/locations/:id/summary', { schema: { tags, security: secured, params: idParams, querystring: z.object({ date: ymd.optional() }), summary: 'A location’s allowance, committed, claimed, paid and remaining for the period' } }, async (req) => {
    const { orgId, id } = req.params;
    const l = await locRow(orgId, id);
    await requireAt(req, db, orgId, id, COOP, 'view');
    return periodSummary(db, orgId, l, req.query.date);
  });

  /* ── requests ── */

  app.get('/orgs/:orgId/coop/requests', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.string().max(30).optional(), locationId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), summary: 'Pre-approval requests (with their claim) in scope' },
  }, async (req) => {
    const { orgId } = req.params;
    const ids = await scopeIds(req, orgId);
    if (req.query.locationId && ids !== 'all' && !ids.includes(req.query.locationId)) throw notFound('Location');
    const rows = await db.select().from(coopRequests).where(and(
      eq(coopRequests.organizationId, orgId), req.query.locationId ? eq(coopRequests.locationId, req.query.locationId) : ids === 'all' ? undefined : ids.length ? inArray(coopRequests.locationId, ids) : sql`false`,
      req.query.status ? eq(coopRequests.status, req.query.status) : undefined,
    )).orderBy(desc(coopRequests.createdAt)).limit(req.query.limit);
    const claims = await latestClaims(db, rows.map((r) => r.id));
    const names = await people(db, [...rows.flatMap((r) => [r.requestedBy, r.decidedBy]), ...claims.flatMap((c) => [c.submittedBy, c.decidedBy])]);
    const locs = await locNames(orgId);
    return { items: rows.map((r) => serializeRequest(r, names, locs.get(r.locationId) ?? null, claims.find((c) => c.requestId === r.id) ?? null)), canDecide: await isHq(req, orgId) };
  });

  app.post('/orgs/:orgId/coop/requests', {
    schema: {
      tags, security: secured, params: orgParams, summary: 'Submit a pre-approval request for local marketing (budget in the location’s currency, creative from brand assets, local asset templates or links)',
      body: z.object({ locationId: z.uuid(), kind: z.enum(COOP_SPEND_KINDS), title: z.string().trim().min(3).max(160), description: z.string().trim().max(4000).default(''), vendor: z.string().trim().max(160).nullable().optional(), startsOn: ymd, endsOn: ymd.nullable().optional(), budgetMinor: minorInt.refine((v) => v > 0, 'Must be > 0'), creative }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const l = await locRow(orgId, req.body.locationId);
    await requireAt(req, db, orgId, l.id, COOP, 'edit');
    const r = await createRequest(s, orgId, l, { ...req.body, vendor: req.body.vendor ?? null, endsOn: req.body.endsOn ?? null }, req.user!.id);
    return reply.code(201).send(await oneRequest(orgId, r.id));
  });

  app.get('/orgs/:orgId/coop/requests/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const r = await loadRequest(db, req.params.orgId, req.params.id);
    if (!(await hasAt(req, db, req.params.orgId, r.locationId, COOP, 'view'))) throw notFound('Co-op request');
    return { ...(await oneRequest(req.params.orgId, r.id)), canDecide: await isHq(req, req.params.orgId), canEdit: await hasAt(req, db, req.params.orgId, r.locationId, COOP, 'edit') };
  });

  app.patch('/orgs/:orgId/coop/requests/:id', {
    schema: {
      tags, security: secured, params: idParams, summary: 'Edit and resubmit a request (after “changes requested”)',
      body: z.object({ title: z.string().trim().min(3).max(160).optional(), description: z.string().trim().max(4000).optional(), vendor: z.string().trim().max(160).nullable().optional(), startsOn: ymd.optional(), endsOn: ymd.nullable().optional(), budgetMinor: minorInt.optional(), creative: creative.optional() }),
    },
  }, async (req) => {
    const r = await loadRequest(db, req.params.orgId, req.params.id);
    await requireAt(req, db, req.params.orgId, r.locationId, COOP, 'edit');
    await resubmitRequest(s, req.params.orgId, r.id, req.body, req.user!.id);
    return oneRequest(req.params.orgId, r.id);
  });

  app.post('/orgs/:orgId/coop/requests/:id/cancel', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const r = await loadRequest(db, req.params.orgId, req.params.id);
    await requireAt(req, db, req.params.orgId, r.locationId, COOP, 'edit');
    if (!['submitted', 'changes_requested', 'approved'].includes(r.status)) throw conflict('not_cancellable', 'Claimed, rejected or cancelled requests cannot be cancelled');
    await db.update(coopRequests).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(coopRequests.id, r.id));
    await audit(db, { organizationId: req.params.orgId, ...actor(req), action: 'coop.request_cancelled', scopeKind: 'location', scopeId: r.locationId, targetType: 'coop_request', targetId: r.id });
    return oneRequest(req.params.orgId, r.id);
  });

  app.post('/orgs/:orgId/coop/requests/:id/decision', {
    schema: {
      tags, security: secured, params: idParams, summary: 'HQ: approve (every brand checklist item ticked; amount within the allowance left), request changes, or reject',
      body: z.object({ decision: z.enum(['approve', 'reject', 'changes_requested']), checklist: z.array(z.object({ key: z.string().max(40), passed: z.boolean(), note: z.string().max(300).nullable().optional() })).max(20).default([]), approvedMinor: minorInt.nullable().optional(), note: z.string().max(1000).nullable().optional() }),
    },
  }, async (req) => {
    await requireHq(req, req.params.orgId);
    await decideRequest(s, req.params.orgId, req.params.id, { ...req.body, checklist: req.body.checklist.map((c) => ({ key: c.key, passed: c.passed, note: c.note ?? null })) }, req.user!.id);
    return oneRequest(req.params.orgId, req.params.id);
  });

  /* ── claims ── */

  app.post('/orgs/:orgId/coop/requests/:id/claim', {
    bodyLimit: UPLOAD_LIMIT,
    schema: {
      tags, security: secured, params: idParams, summary: 'Claim after the spend: amount spent, the invoice and proof of performance (files up to 5 MB each)',
      body: z.object({ spentMinor: minorInt.refine((v) => v > 0, 'Must be > 0'), invoice: upload, proofs: z.array(upload).max(5).default([]), proofNotes: z.string().trim().max(4000).default(''), performance: z.partialRecord(z.enum(['impressions', 'clicks', 'leads', 'calls', 'attendees', 'sales']), z.number().int().min(0)).default({}) }),
    },
  }, async (req, reply) => {
    const r = await loadRequest(db, req.params.orgId, req.params.id);
    await requireAt(req, db, req.params.orgId, r.locationId, COOP, 'edit');
    await submitClaim(s, req.params.orgId, r.id, req.body, req.user!.id);
    return reply.code(201).send(await oneRequest(req.params.orgId, r.id));
  });

  app.post('/orgs/:orgId/coop/claims/:id/decision', {
    schema: { tags, security: secured, params: idParams, body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).nullable().optional() }), summary: 'HQ approves a claim (reimbursable = eligible spend × match, capped at the allowance left) or rejects it' },
  }, async (req) => {
    await requireHq(req, req.params.orgId);
    const c = await decideClaim(s, req.params.orgId, req.params.id, req.body, req.user!.id);
    return oneRequest(req.params.orgId, c.requestId);
  });

  app.post('/orgs/:orgId/coop/claims/:id/pay', {
    schema: {
      tags, security: secured, params: idParams, summary: 'Record the reimbursement: booked as spend in the marketing fund ledger; paid by bank transfer (reference) or marked paid',
      body: z.object({ method: z.enum(COOP_PAYOUT_METHODS), reference: z.string().trim().max(120).nullable().optional(), paidOn: ymd.nullable().optional() }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    if (!(await isHq(req, orgId)) && !(await hasAt(req, db, orgId, null, 'finance.marketing_fund', 'edit'))) throw forbidden('Reimbursements are recorded by HQ marketing or finance');
    const c = await markClaimPaid(s, orgId, req.params.id, req.body, req.user!.id);
    return oneRequest(orgId, c.requestId);
  });

  app.get('/orgs/:orgId/coop/claims/:id/documents/:documentId', { schema: { tags, security: secured, params: z.object({ orgId: z.uuid(), id: z.uuid(), documentId: z.uuid() }), summary: 'Download a claim’s invoice or proof' } }, async (req, reply) => {
    const c = await loadClaim(db, req.params.orgId, req.params.id);
    if (!(await hasAt(req, db, req.params.orgId, c.locationId, COOP, 'view'))) throw notFound('Document');
    if (c.invoiceDocumentId !== req.params.documentId && !c.proofDocumentIds.includes(req.params.documentId)) throw notFound('Document');
    const [doc] = await db.select().from(financeDocuments).where(and(eq(financeDocuments.id, req.params.documentId), eq(financeDocuments.organizationId, req.params.orgId)));
    if (!doc) throw notFound('Document');
    return reply.header('Content-Disposition', `attachment; filename="${doc.filename.replace(/[^\w.\- ]/g, '_')}"`).type(doc.contentType).send(Buffer.from(doc.dataBase64, 'base64'));
  });

  /* ── approved local asset library ── */

  const canManageAssets = async (req: FastifyRequest, orgId: string) => (await isHq(req, orgId)) || (await hasAt(req, db, orgId, null, 'marketing.brand_assets', 'publish'));
  const serializeTemplate = (t: typeof localAssetTemplates.$inferSelect) => ({ id: t.id, name: t.name, kind: t.kind, baseAssetId: t.baseAssetId, baseUrl: t.baseUrl, width: t.width, height: t.height, fields: t.fields, status: t.status, updatedAt: t.updatedAt.toISOString() });

  app.get('/orgs/:orgId/coop/asset-templates', { schema: { tags, security: secured, params: orgParams, summary: 'Approved local asset templates (HQ also sees drafts)' } }, async (req) => {
    const { orgId } = req.params;
    await scopeIds(req, orgId);
    const manage = await canManageAssets(req, orgId);
    const rows = await db.select().from(localAssetTemplates).where(and(eq(localAssetTemplates.organizationId, orgId), manage ? sql`${localAssetTemplates.status} <> 'archived'` : eq(localAssetTemplates.status, 'published'))).orderBy(desc(localAssetTemplates.updatedAt));
    return { items: rows.map(serializeTemplate), canManage: manage };
  });

  const templateBody = z.object({
    name: z.string().trim().min(2).max(120), kind: z.enum(LOCAL_ASSET_KINDS), baseAssetId: z.uuid().nullable().optional(), width: z.number().int().min(100).max(6000).default(1080), height: z.number().int().min(100).max(6000).default(1080),
    fields: z.array(localAssetFieldSchema).min(1).max(20), status: z.enum(['draft', 'published', 'archived']).default('draft'),
  });
  const baseUrlFor = async (orgId: string, assetId: string | null | undefined) => {
    if (!assetId) return null;
    const [a] = await db.select({ url: brandAssets.url }).from(brandAssets).where(and(eq(brandAssets.id, assetId), eq(brandAssets.organizationId, orgId)));
    if (!a) throw validationError('Unknown brand asset', { baseAssetId: 'Not found' });
    return a.url;
  };

  app.post('/orgs/:orgId/coop/asset-templates', { schema: { tags, security: secured, params: orgParams, body: templateBody, summary: 'HQ: create a brand template (artwork from brand assets, text fields locked or open to locations)' } }, async (req, reply) => {
    const { orgId } = req.params;
    if (!(await canManageAssets(req, orgId))) throw forbidden('Only HQ manages brand templates');
    const keys = req.body.fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) throw validationError('Field keys must be unique', { fields: 'Duplicate key' });
    const [t] = await db.insert(localAssetTemplates).values({ organizationId: orgId, ...req.body, baseUrl: await baseUrlFor(orgId, req.body.baseAssetId), createdBy: req.user!.id }).returning();
    await audit(db, { organizationId: orgId, ...actor(req), action: 'coop.asset_template_created', scopeKind: 'organization', scopeId: orgId, targetType: 'local_asset_template', targetId: t!.id });
    return reply.code(201).send(serializeTemplate(t!));
  });

  app.put('/orgs/:orgId/coop/asset-templates/:id', { schema: { tags, security: secured, params: idParams, body: templateBody } }, async (req) => {
    const { orgId, id } = req.params;
    if (!(await canManageAssets(req, orgId))) throw forbidden('Only HQ manages brand templates');
    const [t] = await db.update(localAssetTemplates).set({ ...req.body, baseUrl: await baseUrlFor(orgId, req.body.baseAssetId), updatedAt: new Date() }).where(and(eq(localAssetTemplates.id, id), eq(localAssetTemplates.organizationId, orgId))).returning();
    if (!t) throw notFound('Template');
    return serializeTemplate(t);
  });

  app.get('/orgs/:orgId/coop/asset-templates/:id/versions', { schema: { tags, security: secured, params: idParams, querystring: z.object({ locationId: z.uuid().optional() }), summary: 'Locations’ customised versions of a template (in scope)' } }, async (req) => {
    const { orgId, id } = req.params;
    const ids = await scopeIds(req, orgId);
    const rows = await db.select().from(localAssetVersions).where(and(eq(localAssetVersions.organizationId, orgId), eq(localAssetVersions.templateId, id), req.query.locationId ? eq(localAssetVersions.locationId, req.query.locationId) : undefined, ids === 'all' ? undefined : ids.length ? inArray(localAssetVersions.locationId, ids) : sql`false`))
      .orderBy(desc(localAssetVersions.createdAt)).limit(100);
    return { items: rows.map((v) => ({ id: v.id, templateId: v.templateId, locationId: v.locationId, values: v.values, createdAt: v.createdAt.toISOString() })) };
  });

  app.post('/orgs/:orgId/coop/asset-templates/:id/versions', {
    schema: { tags, security: secured, params: idParams, body: z.object({ locationId: z.uuid(), values: z.record(z.string().max(40), z.string().max(500)) }), summary: 'A location customises the open fields of a published template (locked fields keep HQ’s text)' },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireAt(req, db, orgId, req.body.locationId, COOP, 'edit');
    const [t] = await db.select().from(localAssetTemplates).where(and(eq(localAssetTemplates.id, id), eq(localAssetTemplates.organizationId, orgId), eq(localAssetTemplates.status, 'published')));
    if (!t) throw notFound('Template');
    const r = resolveLocalAsset(t.fields, req.body.values);
    if (r.rejected.length) throw conflict('locked_or_too_long', `These fields are locked or too long: ${r.rejected.join(', ')}`, { fields: r.rejected });
    const [v] = await db.insert(localAssetVersions).values({ organizationId: orgId, templateId: t.id, locationId: req.body.locationId, values: r.values, createdBy: req.user!.id }).returning();
    return reply.code(201).send({ id: v!.id, templateId: t.id, locationId: v!.locationId, values: v!.values, createdAt: v!.createdAt.toISOString() });
  });
};

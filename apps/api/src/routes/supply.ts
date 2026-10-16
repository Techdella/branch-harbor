import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  OFF_CONTRACT_STATUSES, PO_STATUSES, catalogueItemBodySchema, offContractSchema, poCreateSchema, rebateProgrammeBodySchema, receiveSchema, supplierBodySchema, supplierCovers, supplySettingsSchema,
} from '@bh/shared';
import {
  complianceDocuments, locations, organizations, regions, supplyCatalogueItems, supplyOffContract, supplyPurchaseOrders, supplyReceipts, supplyRebateClaims, supplyRebateProgrammes, supplySettings,
  supplySupplierCertifications, supplySuppliers,
} from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { localDateParts } from '../lib/tz.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit as auditLog } from '../services/audit.ts';
import { requireMember } from '../services/authz.ts';
import { names, orgToday } from '../services/audits.ts';
import { toCsv, major } from '../services/finance/exports.ts';
import { storeFile } from '../services/ops-files.ts';
import {
  canAt, canOrg, canRebates, cancelPo, certificationsFor, checkStockLink, claimStatementCsv, claimStatementPdf, confirmPoBySupplier, createClaim, createPo, decidePo, inScope, loadPo, loadProgramme,
  loadSupplier, locationRow, poByToken, poCsv, poPdf, programmeSummary, publicPoView, receiveClaim, receivePo, requireAt, requireHq, requireRebates, scorecards, sendPo, serializeCert, serializeClaim,
  serializeItem, serializeOffContract, serializePo, serializeProgramme, serializeSupplier, settingsFor, submitPo, supplyLocations, supplyOverview,
} from '../services/supply.ts';
import { uploadSchema } from './audits.ts';
import { idParams, orgParams, secured } from './_common.ts';

const tags = ['supply'];
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const some = (x: 'all' | Set<string>) => x === 'all' || x.size > 0;
const UPLOAD_BODY_LIMIT = 15 * 1024 * 1024;

/**
 * Supplier and approved-vendor network (`/v1/orgs/:orgId/supply/...`): suppliers and catalogues (HQ), purchase orders
 * with approval above the threshold, receiving, off-contract spend, scorecards and rebates. The supplier's magic-link
 * pages are public (`/v1/public/supply/po/:token`).
 */
export const supplyRoutes: FastifyPluginAsyncZod = async (r) => {
  const s = r.ctx;
  const db = s.db;
  r.addHook('preHandler', authenticate);

  const viewable = async (req: Parameters<typeof supplyLocations>[0], orgId: string) => {
    const allowed = await supplyLocations(req, db, orgId);
    if (!some(allowed)) throw forbidden('Suppliers are not part of your access');
    return allowed;
  };
  const scopedLocations = async (orgId: string, allowed: 'all' | Set<string>) =>
    (await db.select({ id: locations.id, name: locations.name, country: locations.country, regionId: locations.regionId, currency: locations.currency, timeZone: locations.timeZone }).from(locations)
      .where(and(eq(locations.organizationId, orgId), sql`${locations.archivedAt} is null`)).orderBy(asc(locations.name))).filter((l) => inScope(allowed, l.id));

  /* ------------------------------ settings ------------------------------ */

  r.get('/orgs/:orgId/supply/settings', { schema: { tags, security: secured, params: orgParams, summary: 'Approval threshold per currency' } }, async (req) => {
    const { orgId } = req.params;
    await viewable(req, orgId);
    return { ...(await settingsFor(db, orgId)), canManage: await canOrg(req, db, orgId, 'publish') };
  });

  r.put('/orgs/:orgId/supply/settings', { schema: { tags, security: secured, params: orgParams, body: supplySettingsSchema, summary: 'Set the HQ approval threshold per currency (Suppliers publish, organisation-wide)' } }, async (req) => {
    const { orgId } = req.params;
    await requireHq(req, db, orgId);
    await db.insert(supplySettings).values({ organizationId: orgId, approvalThresholds: req.body.approvalThresholds as Record<string, number>, updatedBy: req.user!.id })
      .onConflictDoUpdate({ target: supplySettings.organizationId, set: { approvalThresholds: req.body.approvalThresholds as Record<string, number>, updatedBy: req.user!.id, updatedAt: new Date() } });
    await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'supply.settings_updated', targetType: 'supply_settings', targetId: orgId, metadata: req.body, ip: req.ip });
    return { ...(await settingsFor(db, orgId)), canManage: true };
  });

  /* ------------------------------ overview ------------------------------ */

  r.get('/orgs/:orgId/supply/overview', { schema: { tags, security: secured, params: orgParams, summary: 'Orders waiting, deliveries due, off-contract spend and spend per supplier (per currency) for the locations in scope' } }, async (req) => {
    const { orgId } = req.params;
    const allowed = await viewable(req, orgId);
    const out = await supplyOverview(db, orgId, allowed, await orgToday(db, orgId));
    return {
      ...out,
      can: { manage: await canOrg(req, db, orgId, 'publish'), order: some(await supplyLocations(req, db, orgId, 'edit')), approve: some(await supplyLocations(req, db, orgId, 'publish')), export: some(await supplyLocations(req, db, orgId, 'export')), rebates: await canRebates(req, db, orgId, 'view') },
      locations: (await scopedLocations(orgId, allowed)).map((l) => ({ id: l.id, name: l.name, currency: l.currency, country: l.country })),
    };
  });

  /* ------------------------------ suppliers ----------------------------- */

  r.get('/orgs/:orgId/supply/suppliers', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum(['active', 'suspended', 'archived', 'all']).default('active'), locationId: z.uuid().optional() }), summary: 'Approved suppliers (HQ: all; locations: active suppliers approved for their locations) with certifications and scorecards' },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await viewable(req, orgId);
    const hq = await canOrg(req, db, orgId, 'publish');
    const conds = [eq(supplySuppliers.organizationId, orgId)];
    if (!hq) conds.push(eq(supplySuppliers.status, 'active'));
    else if (req.query.status !== 'all') conds.push(eq(supplySuppliers.status, req.query.status));
    let rows = await db.select().from(supplySuppliers).where(and(...conds)).orderBy(asc(supplySuppliers.name));
    const locs = await scopedLocations(orgId, allowed);
    const target = req.query.locationId ? locs.filter((l) => l.id === req.query.locationId) : locs;
    if (req.query.locationId && !target.length) throw notFound('Location');
    if (!hq || req.query.locationId) rows = rows.filter((x) => target.some((l) => supplierCovers(x, l)));
    const today = await orgToday(db, orgId);
    const certs = await certificationsFor(s, orgId, rows.map((x) => x.id), today);
    const counts = rows.length ? await db.select({ id: supplyCatalogueItems.supplierId, n: sql<number>`count(*)::int` }).from(supplyCatalogueItems).where(and(inArray(supplyCatalogueItems.supplierId, rows.map((x) => x.id)), eq(supplyCatalogueItems.active, true))).groupBy(supplyCatalogueItems.supplierId) : [];
    const cards = await scorecards(db, orgId, allowed, rows.map((x) => x.id));
    const regionNames = new Map((await db.select({ id: regions.id, name: regions.name }).from(regions).where(eq(regions.organizationId, orgId))).map((x) => [x.id, x.name]));
    return {
      items: rows.map((x) => serializeSupplier(x, { certifications: certs.get(x.id) ?? [], itemCount: counts.find((c) => c.id === x.id)?.n ?? 0, scorecard: cards.get(x.id) ?? null, regionNames })),
      can: { manage: hq },
    };
  });

  r.post('/orgs/:orgId/supply/suppliers', { schema: { tags, security: secured, params: orgParams, body: supplierBodySchema, summary: 'Add an approved supplier (HQ)' } }, async (req, reply) => {
    const { orgId } = req.params;
    await requireHq(req, db, orgId);
    const [x] = await db.insert(supplySuppliers).values({ organizationId: orgId, ...req.body, createdBy: req.user!.id }).returning();
    await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'supplier.created', targetType: 'supplier', targetId: x!.id, metadata: { name: x!.name }, ip: req.ip });
    return reply.code(201).send(serializeSupplier(x!));
  });

  r.get('/orgs/:orgId/supply/suppliers/:id', { schema: { tags, security: secured, params: idParams, summary: 'A supplier with its catalogue, certifications, contract and scorecard' } }, async (req) => {
    const { orgId, id } = req.params;
    const allowed = await viewable(req, orgId);
    const x = await loadSupplier(db, orgId, id);
    const hq = await canOrg(req, db, orgId, 'publish');
    const locs = await scopedLocations(orgId, allowed);
    if (!hq && (x.status !== 'active' || !locs.some((l) => supplierCovers(x, l)))) throw notFound('Supplier');
    const today = await orgToday(db, orgId);
    const items = await db.select().from(supplyCatalogueItems).where(and(eq(supplyCatalogueItems.supplierId, id), ...(hq ? [] : [eq(supplyCatalogueItems.active, true)]))).orderBy(asc(supplyCatalogueItems.category), asc(supplyCatalogueItems.name));
    const certs = await certificationsFor(s, orgId, [id], today);
    const cards = await scorecards(db, orgId, allowed, [id]);
    const regionNames = new Map((await db.select({ id: regions.id, name: regions.name }).from(regions).where(eq(regions.organizationId, orgId))).map((r2) => [r2.id, r2.name]));
    return { ...serializeSupplier(x, { certifications: certs.get(id) ?? [], itemCount: items.filter((i) => i.active).length, scorecard: cards.get(id) ?? null, regionNames }), items: items.map((i) => serializeItem(i)), can: { manage: hq } };
  });

  r.put('/orgs/:orgId/supply/suppliers/:id', { schema: { tags, security: secured, params: idParams, body: supplierBodySchema } }, async (req) => {
    const { orgId, id } = req.params;
    await requireHq(req, db, orgId);
    await loadSupplier(db, orgId, id);
    const [x] = await db.update(supplySuppliers).set({ ...req.body, updatedAt: new Date() }).where(eq(supplySuppliers.id, id)).returning();
    await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'supplier.updated', targetType: 'supplier', targetId: id, metadata: { status: x!.status }, ip: req.ip });
    return serializeSupplier(x!);
  });

  const certBody = z.object({
    name: z.string().trim().min(1).max(160), required: z.boolean().default(true), complianceDocumentId: z.uuid().nullable().optional().default(null), issuer: z.string().trim().max(160).nullable().optional().default(null),
    reference: z.string().trim().max(120).nullable().optional().default(null), expiresOn: ymd.nullable().optional().default(null), file: uploadSchema.nullable().optional().default(null),
  });
  r.post('/orgs/:orgId/supply/suppliers/:id/certifications', { bodyLimit: UPLOAD_BODY_LIMIT, schema: { tags, security: secured, params: idParams, body: certBody, summary: 'Record a certification the supplier must hold: link a compliance document or upload the certificate (HQ)' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireHq(req, db, orgId);
    await loadSupplier(db, orgId, id);
    const b = req.body;
    if (b.complianceDocumentId) {
      const [d] = await db.select({ id: complianceDocuments.id }).from(complianceDocuments).where(and(eq(complianceDocuments.id, b.complianceDocumentId), eq(complianceDocuments.organizationId, orgId)));
      if (!d) throw validationError('Unknown compliance document', { complianceDocumentId: 'Not found' });
    }
    const f = b.file ? await storeFile(s, db, { organizationId: orgId, purpose: 'supplier_certificate', upload: b.file, uploadedBy: req.user!.id }) : null;
    const [c] = await db.insert(supplySupplierCertifications).values({ organizationId: orgId, supplierId: id, name: b.name, required: b.required, complianceDocumentId: b.complianceDocumentId, fileId: f?.id ?? null, issuer: b.issuer, reference: b.reference, expiresOn: b.expiresOn, createdBy: req.user!.id }).returning();
    const today = await orgToday(db, orgId);
    return reply.code(201).send(serializeCert(s, c!, today));
  });

  r.delete('/orgs/:orgId/supply/suppliers/:id/certifications/:certId', { schema: { tags, security: secured, params: idParams.extend({ certId: z.uuid() }) } }, async (req, reply) => {
    const { orgId, id, certId } = req.params;
    await requireHq(req, db, orgId);
    const del = await db.delete(supplySupplierCertifications).where(and(eq(supplySupplierCertifications.id, certId), eq(supplySupplierCertifications.supplierId, id), eq(supplySupplierCertifications.organizationId, orgId))).returning();
    if (!del.length) throw notFound('Certification');
    return reply.code(204).send();
  });

  /* ------------------------------ catalogue ----------------------------- */

  r.post('/orgs/:orgId/supply/suppliers/:id/items', { schema: { tags, security: secured, params: idParams, body: catalogueItemBodySchema, summary: 'Add a catalogue item (SKU, pack, price per currency, MOQ, lead time; optional stock link)' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireHq(req, db, orgId);
    await loadSupplier(db, orgId, id);
    await checkStockLink(db, orgId, req.body);
    const [dup] = await db.select({ id: supplyCatalogueItems.id }).from(supplyCatalogueItems).where(and(eq(supplyCatalogueItems.supplierId, id), eq(supplyCatalogueItems.sku, req.body.sku)));
    if (dup) throw conflict('sku_exists', `SKU ${req.body.sku} is already in this catalogue`);
    const [i] = await db.insert(supplyCatalogueItems).values({ organizationId: orgId, supplierId: id, ...req.body, prices: req.body.prices as Record<string, number> }).returning();
    return reply.code(201).send(serializeItem(i!));
  });

  r.put('/orgs/:orgId/supply/items/:id', { schema: { tags, security: secured, params: idParams, body: catalogueItemBodySchema } }, async (req) => {
    const { orgId, id } = req.params;
    await requireHq(req, db, orgId);
    const [cur] = await db.select().from(supplyCatalogueItems).where(and(eq(supplyCatalogueItems.id, id), eq(supplyCatalogueItems.organizationId, orgId)));
    if (!cur) throw notFound('Catalogue item');
    await checkStockLink(db, orgId, req.body);
    const [dup] = await db.select({ id: supplyCatalogueItems.id }).from(supplyCatalogueItems).where(and(eq(supplyCatalogueItems.supplierId, cur.supplierId), eq(supplyCatalogueItems.sku, req.body.sku), sql`${supplyCatalogueItems.id} <> ${id}`));
    if (dup) throw conflict('sku_exists', `SKU ${req.body.sku} is already in this catalogue`);
    const [i] = await db.update(supplyCatalogueItems).set({ ...req.body, prices: req.body.prices as Record<string, number>, updatedAt: new Date() }).where(eq(supplyCatalogueItems.id, id)).returning();
    return serializeItem(i!);
  });

  r.get('/orgs/:orgId/supply/catalogue', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid(), supplierId: z.uuid().optional(), q: z.string().trim().max(80).optional() }), summary: 'What a location can order: active items from suppliers approved for it, priced in its currency' },
  }, async (req) => {
    const { orgId } = req.params;
    await requireAt(req, db, orgId, req.query.locationId, 'view');
    const loc = await locationRow(db, orgId, req.query.locationId);
    const sups = (await db.select().from(supplySuppliers).where(and(eq(supplySuppliers.organizationId, orgId), eq(supplySuppliers.status, 'active')))).filter((x) => supplierCovers(x, loc) && (!req.query.supplierId || x.id === req.query.supplierId));
    const items = sups.length ? await db.select().from(supplyCatalogueItems).where(and(inArray(supplyCatalogueItems.supplierId, sups.map((x) => x.id)), eq(supplyCatalogueItems.active, true))).orderBy(asc(supplyCatalogueItems.category), asc(supplyCatalogueItems.name)) : [];
    const q = req.query.q?.toLowerCase();
    const list = items.filter((i) => !q || i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q) || i.category.toLowerCase().includes(q));
    return {
      location: { id: loc.id, name: loc.name, currency: loc.currency },
      suppliers: sups.map((x) => ({ id: x.id, name: x.name, contract: x.contract })),
      items: list.map((i) => ({ ...serializeItem(i, loc.currency), supplierName: sups.find((x) => x.id === i.supplierId)?.name ?? null })),
      canOrder: await canAt(req, db, orgId, loc.id, 'edit'),
    };
  });

  /* ---------------------------- purchase orders ------------------------- */

  r.get('/orgs/:orgId/supply/orders', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum([...PO_STATUSES, 'open', 'all']).default('all'), locationId: z.uuid().optional(), supplierId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), summary: 'Purchase orders at the locations in scope (open = sent, confirmed or partly received)' },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await viewable(req, orgId);
    const conds = [eq(supplyPurchaseOrders.organizationId, orgId)];
    if (req.query.status === 'open') conds.push(inArray(supplyPurchaseOrders.status, ['sent', 'confirmed', 'partially_received']));
    else if (req.query.status !== 'all') conds.push(eq(supplyPurchaseOrders.status, req.query.status));
    if (req.query.locationId) conds.push(eq(supplyPurchaseOrders.locationId, req.query.locationId));
    if (req.query.supplierId) conds.push(eq(supplyPurchaseOrders.supplierId, req.query.supplierId));
    if (allowed !== 'all') conds.push(inArray(supplyPurchaseOrders.locationId, [...allowed]));
    const rows = await db.select({ p: supplyPurchaseOrders, loc: locations.name, sup: supplySuppliers.name }).from(supplyPurchaseOrders).innerJoin(locations, eq(locations.id, supplyPurchaseOrders.locationId)).innerJoin(supplySuppliers, eq(supplySuppliers.id, supplyPurchaseOrders.supplierId))
      .where(and(...conds)).orderBy(sql`case ${supplyPurchaseOrders.status} when 'pending_approval' then 0 when 'partially_received' then 1 when 'confirmed' then 2 when 'sent' then 3 when 'draft' then 4 else 5 end`, desc(supplyPurchaseOrders.createdAt)).limit(req.query.limit);
    const people = await names(db, rows.map((x) => x.p.createdBy));
    const today = await orgToday(db, orgId);
    return { items: rows.map(({ p, loc, sup }) => serializePo(p, { locationName: loc, supplierName: sup, names: people, today })), today, can: { approve: some(await supplyLocations(req, db, orgId, 'publish')), order: some(await supplyLocations(req, db, orgId, 'edit')), export: some(await supplyLocations(req, db, orgId, 'export')) } };
  });

  r.post('/orgs/:orgId/supply/orders', { schema: { tags, security: secured, params: orgParams, body: poCreateSchema.extend({ submit: z.boolean().default(false) }), summary: 'Create a purchase order from the catalogue (Suppliers edit at the location); submit sends it, or asks HQ above the threshold' } }, async (req, reply) => {
    const { orgId } = req.params;
    await requireAt(req, db, orgId, req.body.locationId, 'edit', 'Ordering needs Suppliers (edit) at this location');
    let po = await createPo(db, orgId, req.body, req.user!.id);
    let confirmUrl: string | null = null;
    let approvalRequired = false;
    if (req.body.submit) ({ purchaseOrder: po, confirmUrl, approvalRequired } = await submitPo(s, po, req.user!.id));
    return reply.code(201).send({ ...serializePo(po, { today: await orgToday(db, orgId) }), approvalRequired, confirmUrl });
  });

  r.get('/orgs/:orgId/supply/orders/export', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ from: ymd.optional(), to: ymd.optional() }), summary: 'Purchase order lines as CSV (Suppliers export)' } }, async (req, reply) => {
    const { orgId } = req.params;
    const allowed = await supplyLocations(req, db, orgId, 'export');
    if (!some(allowed)) throw forbidden('Exporting orders needs Suppliers (export)');
    const rows = (await db.select({ p: supplyPurchaseOrders, loc: locations.name, sup: supplySuppliers.name }).from(supplyPurchaseOrders).innerJoin(locations, eq(locations.id, supplyPurchaseOrders.locationId)).innerJoin(supplySuppliers, eq(supplySuppliers.id, supplyPurchaseOrders.supplierId))
      .where(eq(supplyPurchaseOrders.organizationId, orgId)).orderBy(desc(supplyPurchaseOrders.createdAt))).filter(({ p }) => inScope(allowed, p.locationId))
      .filter(({ p }) => (!req.query.from || p.createdAt.toISOString().slice(0, 10) >= req.query.from) && (!req.query.to || p.createdAt.toISOString().slice(0, 10) <= req.query.to));
    const csv = toCsv(['po_number', 'created_at', 'status', 'location', 'supplier', 'sku', 'item', 'ordered', 'received', 'damaged', 'unit_price', 'line_total', 'currency', 'expected', 'first_delivery'],
      rows.flatMap(({ p, loc, sup }) => p.lines.map((l) => [p.number, p.createdAt.toISOString(), p.status, loc, sup, l.sku, l.name, l.quantity, l.received, l.damaged, major(l.unitPriceMinor, p.currency), major(l.totalMinor, p.currency), p.currency, p.expectedDeliveryDate ?? '', p.firstDeliveryOn ?? ''])));
    return reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="purchase-orders.csv"').send(csv);
  });

  const poDetail = async (req: Parameters<typeof loadPo>[0], orgId: string, id: string) => {
    const p = await loadPo(req, db, orgId, id);
    const [loc] = await db.select({ name: locations.name, timeZone: locations.timeZone }).from(locations).where(eq(locations.id, p.locationId));
    const [sup] = await db.select({ name: supplySuppliers.name }).from(supplySuppliers).where(eq(supplySuppliers.id, p.supplierId));
    const receipts = await db.select().from(supplyReceipts).where(eq(supplyReceipts.purchaseOrderId, id)).orderBy(asc(supplyReceipts.createdAt));
    const people = await names(db, [p.createdBy, ...p.history.map((h) => h.by), ...receipts.map((x) => x.receivedBy)]);
    const edit = await canAt(req, db, orgId, p.locationId, 'edit');
    const publish = await canAt(req, db, orgId, p.locationId, 'publish');
    const today = localDateParts(new Date(), loc?.timeZone ?? 'UTC').date;
    return serializePo(p, {
      locationName: loc?.name, supplierName: sup?.name, names: people, receipts, today,
      can: {
        submit: edit && (p.status === 'draft' || p.status === 'rejected'), approve: publish && p.status === 'pending_approval' && p.createdBy !== req.user!.id, resend: edit && (p.status === 'sent' || p.status === 'confirmed'),
        receive: edit && ['sent', 'confirmed', 'partially_received'].includes(p.status), cancel: (edit || publish) && ['draft', 'pending_approval', 'approved', 'rejected', 'sent', 'confirmed'].includes(p.status),
      },
    });
  };

  r.get('/orgs/:orgId/supply/orders/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => poDetail(req, req.params.orgId, req.params.id));

  r.post('/orgs/:orgId/supply/orders/:id/submit', { schema: { tags, security: secured, params: idParams, summary: 'Submit a draft: above the threshold it waits for HQ approval, otherwise it is sent to the supplier' } }, async (req) => {
    const { orgId, id } = req.params;
    const p = await loadPo(req, db, orgId, id);
    await requireAt(req, db, orgId, p.locationId, 'edit');
    const out = await submitPo(s, p, req.user!.id);
    return { ...(await poDetail(req, orgId, id)), approvalRequired: out.approvalRequired, confirmUrl: out.confirmUrl };
  });

  r.post('/orgs/:orgId/supply/orders/:id/decision', { schema: { tags, security: secured, params: idParams, body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).optional() }), summary: 'Approve (and send) or reject an order above the threshold (Suppliers publish at the location)' } }, async (req) => {
    const { orgId, id } = req.params;
    const p = await loadPo(req, db, orgId, id);
    await requireAt(req, db, orgId, p.locationId, 'publish', 'Approving orders needs Suppliers (publish) at this location');
    if (req.body.decision === 'reject' && !req.body.note) throw validationError('Say why the order is rejected', { note: 'Required when rejecting' });
    const out = await decidePo(s, p, req.body.decision, req.user!.id, req.body.note ?? null);
    return { ...(await poDetail(req, orgId, id)), confirmUrl: out.confirmUrl };
  });

  r.post('/orgs/:orgId/supply/orders/:id/send', { schema: { tags, security: secured, params: idParams, summary: 'Send the order to the supplier again (a new magic link replaces the old one)' } }, async (req) => {
    const { orgId, id } = req.params;
    const p = await loadPo(req, db, orgId, id);
    await requireAt(req, db, orgId, p.locationId, 'edit');
    if (p.status !== 'sent' && p.status !== 'confirmed') throw conflict('invalid_transition', `This order is ${p.status}`);
    const out = await sendPo(s, p, req.user!.id);
    return { ...(await poDetail(req, orgId, id)), confirmUrl: out.confirmUrl };
  });

  r.post('/orgs/:orgId/supply/orders/:id/receive', { schema: { tags, security: secured, params: idParams, body: receiveSchema, summary: 'Record a delivery: good packs restock linked inventory; damage and shortfalls are recorded as issues' } }, async (req) => {
    const { orgId, id } = req.params;
    const p = await loadPo(req, db, orgId, id);
    await requireAt(req, db, orgId, p.locationId, 'edit', 'Receiving needs Suppliers (edit) at this location');
    const out = await receivePo(s, id, req.body, req.user!.id);
    return { ...(await poDetail(req, orgId, id)), inventory: out.inventory, receiptId: out.receipt.id };
  });

  r.post('/orgs/:orgId/supply/orders/:id/cancel', { schema: { tags, security: secured, params: idParams, body: z.object({ reason: z.string().trim().max(500).optional() }) } }, async (req) => {
    const { orgId, id } = req.params;
    const p = await loadPo(req, db, orgId, id);
    if (!(await canAt(req, db, orgId, p.locationId, 'edit')) && !(await canAt(req, db, orgId, p.locationId, 'publish'))) throw forbidden();
    await cancelPo(db, p, req.user!.id, req.body.reason ?? null);
    return poDetail(req, orgId, id);
  });

  const poFile = async (req: Parameters<typeof loadPo>[0], orgId: string, id: string) => {
    const p = await loadPo(req, db, orgId, id);
    const [loc] = await db.select().from(locations).where(eq(locations.id, p.locationId));
    const [sup] = await db.select({ name: supplySuppliers.name }).from(supplySuppliers).where(eq(supplySuppliers.id, p.supplierId));
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    return { p, ctx: { orgName: org?.name ?? '', supplierName: sup?.name ?? '', locationName: loc?.name ?? '', address: [loc?.address?.line1, loc?.address?.city, loc?.address?.postalCode, loc?.address?.country].filter(Boolean).join(', ') } };
  };
  r.get('/orgs/:orgId/supply/orders/:id/pdf', { schema: { tags, security: secured, params: idParams, summary: 'The order as a PDF' } }, async (req, reply) => {
    const { p, ctx } = await poFile(req, req.params.orgId, req.params.id);
    return reply.type('application/pdf').header('content-disposition', `attachment; filename="${p.number}.pdf"`).send(poPdf(p, ctx));
  });
  r.get('/orgs/:orgId/supply/orders/:id/csv', { schema: { tags, security: secured, params: idParams, summary: 'The order as CSV' } }, async (req, reply) => {
    const { p } = await poFile(req, req.params.orgId, req.params.id);
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${p.number}.csv"`).send(poCsv(p));
  });

  /* ---------------------------- scorecards ------------------------------ */

  r.get('/orgs/:orgId/supply/scorecards', { schema: { tags, security: secured, params: orgParams, summary: 'On-time delivery, fill rate and issues per supplier (orders at the locations in scope)' } }, async (req) => {
    const { orgId } = req.params;
    const allowed = await viewable(req, orgId);
    const cards = await scorecards(db, orgId, allowed);
    const sups = cards.size ? await db.select({ id: supplySuppliers.id, name: supplySuppliers.name, status: supplySuppliers.status }).from(supplySuppliers).where(inArray(supplySuppliers.id, [...cards.keys()])) : [];
    return { items: sups.map((x) => ({ supplierId: x.id, name: x.name, status: x.status, ...cards.get(x.id)! })).sort((a, b) => (a.score ?? 101) - (b.score ?? 101)) };
  });

  /* --------------------------- off-contract ----------------------------- */

  r.get('/orgs/:orgId/supply/off-contract', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum([...OFF_CONTRACT_STATUSES, 'all']).default('all'), locationId: z.uuid().optional() }), summary: 'Purchases outside the approved catalogue at the locations in scope' } }, async (req) => {
    const { orgId } = req.params;
    const allowed = await viewable(req, orgId);
    const conds = [eq(supplyOffContract.organizationId, orgId)];
    if (req.query.status !== 'all') conds.push(eq(supplyOffContract.status, req.query.status));
    if (req.query.locationId) conds.push(eq(supplyOffContract.locationId, req.query.locationId));
    if (allowed !== 'all') conds.push(inArray(supplyOffContract.locationId, [...allowed]));
    const rows = await db.select({ x: supplyOffContract, loc: locations.name, sug: supplySuppliers.name }).from(supplyOffContract).innerJoin(locations, eq(locations.id, supplyOffContract.locationId))
      .leftJoin(supplySuppliers, eq(supplySuppliers.id, supplyOffContract.suggestedSupplierId)).where(and(...conds)).orderBy(desc(supplyOffContract.purchasedOn)).limit(300);
    const people = await names(db, rows.flatMap(({ x }) => [x.createdBy, x.reviewedBy]));
    return { items: rows.map(({ x, loc, sug }) => serializeOffContract(s, x, { locationName: loc, names: people, suggested: sug })), can: { review: some(await supplyLocations(req, db, orgId, 'publish')), log: some(await supplyLocations(req, db, orgId, 'edit')) } };
  });

  r.post('/orgs/:orgId/supply/off-contract', { bodyLimit: UPLOAD_BODY_LIMIT, schema: { tags, security: secured, params: orgParams, body: offContractSchema.extend({ receipt: uploadSchema.nullable().optional().default(null) }), summary: 'Log a purchase outside the approved catalogue (flagged for HQ)' } }, async (req, reply) => {
    const { orgId } = req.params;
    const { receipt, ...b } = req.body;
    await requireAt(req, db, orgId, b.locationId, 'edit', 'Logging purchases needs Suppliers (edit) at this location');
    const f = receipt ? await storeFile(s, db, { organizationId: orgId, locationId: b.locationId, purpose: 'purchase_receipt', upload: receipt, uploadedBy: req.user!.id }) : null;
    const [x] = await db.insert(supplyOffContract).values({ organizationId: orgId, ...b, receiptFileId: f?.id ?? null, createdBy: req.user!.id }).returning();
    await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'supply.off_contract_logged', scopeKind: 'location', scopeId: b.locationId, targetType: 'supply_off_contract', targetId: x!.id, metadata: { amountMinor: b.amountMinor, currency: b.currency, vendor: b.vendorName }, ip: req.ip });
    return reply.code(201).send(serializeOffContract(s, x!));
  });

  r.post('/orgs/:orgId/supply/off-contract/:id/review', { schema: { tags, security: secured, params: idParams, body: z.object({ status: z.enum(['accepted', 'action_required']), note: z.string().trim().max(1000).optional(), suggestedSupplierId: z.uuid().nullable().optional() }), summary: 'HQ review of an off-contract purchase: accept it, or ask the location to use an approved supplier' } }, async (req) => {
    const { orgId, id } = req.params;
    const [x] = await db.select().from(supplyOffContract).where(and(eq(supplyOffContract.id, id), eq(supplyOffContract.organizationId, orgId)));
    if (!x || !(await canAt(req, db, orgId, x.locationId, 'view'))) throw notFound('Purchase');
    await requireAt(req, db, orgId, x.locationId, 'publish', 'Reviewing off-contract purchases needs Suppliers (publish)');
    if (req.body.suggestedSupplierId) await loadSupplier(db, orgId, req.body.suggestedSupplierId);
    if (req.body.status === 'action_required' && !req.body.note) throw validationError('Tell the location what to do instead', { note: 'Required' });
    const [u] = await db.update(supplyOffContract).set({ status: req.body.status, reviewNote: req.body.note ?? null, suggestedSupplierId: req.body.suggestedSupplierId ?? null, reviewedBy: req.user!.id, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(supplyOffContract.id, id)).returning();
    return serializeOffContract(s, u!);
  });

  /* ------------------------------ rebates ------------------------------- */

  r.get('/orgs/:orgId/supply/rebates', { schema: { tags: ['supply', 'finance'], security: secured, params: orgParams, summary: 'Rebate programmes with the current period’s accrual, the next tier, claimable periods and claims (HQ)' } }, async (req) => {
    const { orgId } = req.params;
    await requireRebates(req, db, orgId, 'view');
    const rows = await db.select({ p: supplyRebateProgrammes, sup: supplySuppliers.name }).from(supplyRebateProgrammes).innerJoin(supplySuppliers, eq(supplySuppliers.id, supplyRebateProgrammes.supplierId)).where(eq(supplyRebateProgrammes.organizationId, orgId)).orderBy(asc(supplySuppliers.name), asc(supplyRebateProgrammes.name));
    const today = await orgToday(db, orgId);
    const items = [];
    for (const { p, sup } of rows) items.push({ ...serializeProgramme(p, sup), ...(await programmeSummary(db, p, today)) });
    const totals = new Map<string, { currency: string; accruedMinor: number; claimedOpenMinor: number; receivedMinor: number; fundShareMinor: number }>();
    for (const x of items) {
      const t = totals.get(x.currency) ?? { currency: x.currency, accruedMinor: 0, claimedOpenMinor: 0, receivedMinor: 0, fundShareMinor: 0 };
      t.accruedMinor += x.current.accruedMinor + (x.claimable?.accruedMinor ?? 0);
      for (const c of x.claims) { if (c.status === 'submitted' || c.status === 'draft') t.claimedOpenMinor += c.amountMinor; if (c.status === 'received') { t.receivedMinor += c.receivedMinor ?? 0; t.fundShareMinor += c.fundShareMinor ?? 0; } }
      totals.set(x.currency, t);
    }
    return { items, today, totals: [...totals.values()], can: { edit: await canRebates(req, db, orgId, 'edit'), export: await canRebates(req, db, orgId, 'export') } };
  });

  const programmeCheck = async (orgId: string, b: z.infer<typeof rebateProgrammeBodySchema>) => {
    await loadSupplier(db, orgId, b.supplierId);
    if (b.itemIds.length) {
      const n = await db.select({ id: supplyCatalogueItems.id }).from(supplyCatalogueItems).where(and(inArray(supplyCatalogueItems.id, b.itemIds), eq(supplyCatalogueItems.supplierId, b.supplierId)));
      if (n.length !== new Set(b.itemIds).size) throw validationError('An item is not in this supplier’s catalogue', { itemIds: 'Unknown item' });
    }
  };

  r.post('/orgs/:orgId/supply/rebates', { schema: { tags: ['supply', 'finance'], security: secured, params: orgParams, body: rebateProgrammeBodySchema, summary: 'Set up a rebate programme (percent of spend or per pack, tiered by volume)' } }, async (req, reply) => {
    const { orgId } = req.params;
    await requireRebates(req, db, orgId, 'edit');
    await programmeCheck(orgId, req.body);
    const [p] = await db.insert(supplyRebateProgrammes).values({ organizationId: orgId, ...req.body, createdBy: req.user!.id }).returning();
    await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'supply_rebate.programme_created', targetType: 'supply_rebate_programme', targetId: p!.id, metadata: { supplierId: p!.supplierId }, ip: req.ip });
    return reply.code(201).send(serializeProgramme(p!));
  });

  r.put('/orgs/:orgId/supply/rebates/:id', { schema: { tags: ['supply', 'finance'], security: secured, params: idParams, body: rebateProgrammeBodySchema } }, async (req) => {
    const { orgId, id } = req.params;
    await requireRebates(req, db, orgId, 'edit');
    await loadProgramme(db, orgId, id);
    await programmeCheck(orgId, req.body);
    const [p] = await db.update(supplyRebateProgrammes).set({ ...req.body, updatedAt: new Date() }).where(eq(supplyRebateProgrammes.id, id)).returning();
    return serializeProgramme(p!);
  });

  r.post('/orgs/:orgId/supply/rebates/:id/claims', { schema: { tags: ['supply', 'finance'], security: secured, params: idParams, body: z.object({ periodStart: ymd }), summary: 'Raise a claim for an ended period, with a statement per location' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireRebates(req, db, orgId, 'edit');
    const p = await loadProgramme(db, orgId, id);
    const c = await createClaim(db, p, req.body.periodStart, await orgToday(db, orgId), req.user!.id);
    return reply.code(201).send(serializeClaim(c));
  });

  const loadClaim = async (orgId: string, id: string) => {
    const [c] = await db.select().from(supplyRebateClaims).where(and(eq(supplyRebateClaims.id, id), eq(supplyRebateClaims.organizationId, orgId)));
    if (!c) throw notFound('Rebate claim');
    return c;
  };

  r.post('/orgs/:orgId/supply/rebates/claims/:id/submit', { schema: { tags: ['supply', 'finance'], security: secured, params: idParams, summary: 'Mark a claim as sent to the supplier' } }, async (req) => {
    const { orgId, id } = req.params;
    await requireRebates(req, db, orgId, 'edit');
    const c = await loadClaim(orgId, id);
    if (c.status !== 'draft') throw conflict('invalid_transition', `This claim is ${c.status}`);
    const [u] = await db.update(supplyRebateClaims).set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() }).where(eq(supplyRebateClaims.id, id)).returning();
    return serializeClaim(u!);
  });

  r.post('/orgs/:orgId/supply/rebates/claims/:id/received', { schema: { tags: ['supply', 'finance'], security: secured, params: idParams, body: z.object({ amountMinor: z.number().int().min(0), receivedOn: ymd }), summary: 'Record the rebate as received; the programme’s fund share is booked into the marketing fund' } }, async (req) => {
    const { orgId, id } = req.params;
    await requireRebates(req, db, orgId, 'edit');
    const c = await loadClaim(orgId, id);
    const p = await loadProgramme(db, orgId, c.programmeId);
    return serializeClaim(await receiveClaim(db, c, p, req.body.amountMinor, req.body.receivedOn, req.user!.id));
  });

  r.post('/orgs/:orgId/supply/rebates/claims/:id/void', { schema: { tags: ['supply', 'finance'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    await requireRebates(req, db, orgId, 'edit');
    const c = await loadClaim(orgId, id);
    if (c.status === 'received') throw conflict('invalid_transition', 'A received claim cannot be voided');
    const [u] = await db.update(supplyRebateClaims).set({ status: 'void', updatedAt: new Date() }).where(eq(supplyRebateClaims.id, id)).returning();
    return serializeClaim(u!);
  });

  r.get('/orgs/:orgId/supply/rebates/claims/:id/statement', { schema: { tags: ['supply', 'finance'], security: secured, params: idParams, querystring: z.object({ format: z.enum(['csv', 'pdf']).default('pdf') }), summary: 'The claim statement (per location) as PDF or CSV' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireRebates(req, db, orgId, 'export');
    const c = await loadClaim(orgId, id);
    const p = await loadProgramme(db, orgId, c.programmeId);
    const sup = await loadSupplier(db, orgId, c.supplierId);
    if (req.query.format === 'csv') return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${c.number}.csv"`).send(claimStatementCsv(c, sup.name));
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    return reply.type('application/pdf').header('content-disposition', `attachment; filename="${c.number}.pdf"`).send(claimStatementPdf(c, { orgName: org?.name ?? '', supplierName: sup.name, programmeName: p.name, basis: p.basis }));
  });
};

/** The supplier's magic-link pages (no login): view the order, download PDF / CSV, confirm with a delivery date. */
export const supplyPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const token = z.string().min(16).max(80);
  const P = z.object({ token });
  const ptags = ['public', 'supply'];
  app.get('/public/supply/po/:token', { schema: { tags: ptags, params: P, summary: 'A purchase order for the supplier (magic link)' }, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) =>
    publicPoView(s, await poByToken(s.db, req.params.token)));
  app.post('/public/supply/po/:token/confirm', {
    schema: { tags: ptags, params: P, body: z.object({ expectedDeliveryDate: ymd, reference: z.string().trim().max(80).optional(), note: z.string().trim().max(1000).optional(), lines: z.array(z.object({ itemId: z.uuid(), confirmedQuantity: z.number().int().min(0).max(100_000) })).max(200).optional() }), summary: 'The supplier confirms the order (quantities and delivery date)' },
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req) => {
    const po = await poByToken(s.db, req.params.token);
    await confirmPoBySupplier(s, po, req.body);
    return publicPoView(s, await poByToken(s.db, req.params.token));
  });
  const file = async (tok: string) => {
    const p = await poByToken(s.db, tok);
    const [loc] = await s.db.select().from(locations).where(eq(locations.id, p.locationId));
    const [sup] = await s.db.select({ name: supplySuppliers.name }).from(supplySuppliers).where(eq(supplySuppliers.id, p.supplierId));
    const [org] = await s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, p.organizationId));
    return { p, ctx: { orgName: org?.name ?? '', supplierName: sup?.name ?? '', locationName: loc?.name ?? '', address: [loc?.address?.line1, loc?.address?.city, loc?.address?.postalCode, loc?.address?.country].filter(Boolean).join(', ') } };
  };
  app.get('/public/supply/po/:token/order.pdf', { schema: { tags: ptags, params: P, hide: true }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { p, ctx } = await file(req.params.token);
    return reply.type('application/pdf').header('content-disposition', `attachment; filename="${p.number}.pdf"`).header('cache-control', 'private, no-store').send(poPdf(p, ctx));
  });
  app.get('/public/supply/po/:token/order.csv', { schema: { tags: ptags, params: P, hide: true }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { p } = await file(req.params.token);
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${p.number}.csv"`).header('cache-control', 'private, no-store').send(poCsv(p));
  });
};


import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { COMPLIANCE_CATEGORIES } from '@bh/shared';
import { complianceDocuments, complianceRequirements, ownerGroups } from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { names } from '../services/audits.ts';
import {
  canActOnTarget, canOrgCompliance, complianceLocations, complianceMatrix, docVisible, loadDocument, orgDay, orgLocationsFull, runComplianceJobs, serializeDocument, serializeRequirement,
  supersedeOlder,
} from '../services/compliance.ts';
import { storeFile } from '../services/ops-files.ts';
import { toCsv } from '../services/finance/exports.ts';
import { idParams, orgParams, secured } from './_common.ts';
import { uploadSchema } from './audits.ts';

const tags = ['compliance'];
const some = (x: 'all' | Set<string>) => x === 'all' || x.size > 0;
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const currency = z.string().length(3).transform((c) => c.toUpperCase());
const jurisdiction = z.string().trim().regex(/^[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?$/, 'Country (CA) or country-region (CA-ON)').transform((j) => j.toUpperCase());

const requirementBody = z.object({
  name: z.string().trim().min(1).max(160),
  category: z.enum(COMPLIANCE_CATEGORIES),
  description: z.string().trim().max(1000).default(''),
  coverageType: z.string().trim().max(120).nullable().default(null),
  minAmountMinor: z.number().int().min(0).nullable().default(null),
  currency: currency.nullable().default(null),
  appliesTo: z.enum(['location', 'owner_group']).default('location'),
  jurisdictions: z.array(jurisdiction).max(50).default([]),
  requiresExpiry: z.boolean().default(true),
}).refine((r) => r.minAmountMinor == null || !!r.currency, { path: ['currency'], message: 'Give the currency of the minimum amount' });

const documentBody = z.object({
  requirementId: z.uuid().nullable().default(null),
  locationId: z.uuid().nullable().default(null),
  ownerGroupId: z.uuid().nullable().default(null),
  category: z.enum(COMPLIANCE_CATEGORIES),
  title: z.string().trim().min(1).max(200),
  issuer: z.string().trim().max(200).nullable().default(null),
  reference: z.string().trim().max(120).nullable().default(null),
  coverageType: z.string().trim().max(120).nullable().default(null),
  coverageAmountMinor: z.number().int().min(0).nullable().default(null),
  currency: currency.nullable().default(null),
  issuedOn: ymd.nullable().default(null),
  expiresOn: ymd.nullable().default(null),
  file: uploadSchema,
}).refine((d) => !!d.locationId !== !!d.ownerGroupId, { path: ['locationId'], message: 'Choose a location or an owner group' })
  .refine((d) => d.coverageAmountMinor == null || !!d.currency, { path: ['currency'], message: 'Give the currency of the amount' })
  .refine((d) => !d.issuedOn || !d.expiresOn || d.expiresOn > d.issuedOn, { path: ['expiresOn'], message: 'The expiry date must be after the issue date' });

/**
 * Compliance documents (`/v1/orgs/:orgId/compliance/...`, module `legal.compliance_documents`): HQ requirements,
 * uploads by franchisees (web or mobile), review, the compliance matrix, expiry reminders and the CSV export.
 */
export const complianceRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);

  /* ----------------------------- requirements ----------------------------- */

  app.get('/orgs/:orgId/compliance/requirements', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ includeInactive: z.coerce.boolean().default(false) }) } }, async (req) => {
    const { orgId } = req.params;
    await complianceLocations(req, db, orgId);
    const rows = await db.select().from(complianceRequirements).where(eq(complianceRequirements.organizationId, orgId));
    return { items: rows.filter((r) => req.query.includeInactive || r.active).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)).map(serializeRequirement), canManage: await canOrgCompliance(req, db, orgId, 'publish') };
  });

  app.post('/orgs/:orgId/compliance/requirements', { schema: { tags, security: secured, params: orgParams, body: requirementBody, summary: 'Add a requirement, e.g. "General liability ≥ 2,000,000 USD" for locations in some jurisdictions (publish, organisation-wide)' } }, async (req, reply) => {
    const { orgId } = req.params;
    if (!(await canOrgCompliance(req, db, orgId, 'publish'))) throw forbidden('Only HQ can set compliance requirements');
    const [r] = await db.insert(complianceRequirements).values({ organizationId: orgId, ...req.body, createdBy: req.user!.id }).returning();
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'compliance.requirement_added', targetType: 'compliance_requirement', targetId: r!.id, ip: req.ip });
    return reply.code(201).send(serializeRequirement(r!));
  });

  app.put('/orgs/:orgId/compliance/requirements/:id', { schema: { tags, security: secured, params: idParams, body: requirementBody.and(z.object({ active: z.boolean().default(true) })) } }, async (req) => {
    const { orgId, id } = req.params;
    if (!(await canOrgCompliance(req, db, orgId, 'publish'))) throw forbidden('Only HQ can set compliance requirements');
    const [r] = await db.update(complianceRequirements).set({ ...req.body, updatedAt: new Date() }).where(and(eq(complianceRequirements.id, id), eq(complianceRequirements.organizationId, orgId))).returning();
    if (!r) throw notFound('Requirement');
    return serializeRequirement(r);
  });

  /* -------------------------------- matrix -------------------------------- */

  app.get('/orgs/:orgId/compliance/matrix', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ regionId: z.uuid().optional(), ownerGroupId: z.uuid().optional(), category: z.enum(COMPLIANCE_CATEGORIES).optional() }), summary: 'Locations × requirements with valid / expiring within 30 days / expired / missing / pending review / below the minimum' },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await complianceLocations(req, db, orgId);
    const out = await complianceMatrix(db, orgId, allowed, req.query);
    return {
      ...out,
      can: { manage: await canOrgCompliance(req, db, orgId, 'publish'), upload: some(await complianceLocations(req, db, orgId, 'edit')), export: some(await complianceLocations(req, db, orgId, 'export')) },
    };
  });

  app.get('/orgs/:orgId/compliance/export', { schema: { tags, security: secured, params: orgParams, summary: 'The compliance matrix as CSV (export)' } }, async (req, reply) => {
    const { orgId } = req.params;
    const allowed = await complianceLocations(req, db, orgId, 'export');
    if (allowed !== 'all' && !allowed.size) throw forbidden('Exporting needs Compliance documents (export)');
    const m = await complianceMatrix(db, orgId, allowed);
    const csv = toCsv(['location', 'code', 'owner_group', ...m.requirements.map((r) => r.name), 'compliant', 'applicable'],
      m.rows.map((r) => [r.location.name, r.location.code, r.location.ownerGroupName ?? '', ...r.cells.map((c) => (c.state === 'not_applicable' ? 'n/a' : `${c.state}${c.expiresOn ? ` (${c.expiresOn})` : ''}`)), r.compliant, r.applicable]));
    return reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="compliance-matrix.csv"').send(csv);
  });

  /* ------------------------------- documents ------------------------------ */

  app.get('/orgs/:orgId/compliance/documents', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'expiring', 'expired', 'all']).default('all'), locationId: z.uuid().optional(), requirementId: z.uuid().optional(), expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional() }), summary: 'Documents for the locations (and owner groups) in scope. `expiringWithinDays` feeds the Legal renewals & expiries tracker.' },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await complianceLocations(req, db, orgId);
    const locs = await orgLocationsFull(db, orgId);
    const today = await orgDay(db, orgId);
    const rows = await db.select({ d: complianceDocuments, req: complianceRequirements.name, grp: ownerGroups.name }).from(complianceDocuments)
      .leftJoin(complianceRequirements, eq(complianceRequirements.id, complianceDocuments.requirementId)).leftJoin(ownerGroups, eq(ownerGroups.id, complianceDocuments.ownerGroupId))
      .where(eq(complianceDocuments.organizationId, orgId)).orderBy(desc(complianceDocuments.createdAt)).limit(2000);
    const locName = new Map(locs.map((l) => [l.id, l.name]));
    const people = await names(db, rows.flatMap(({ d }) => [d.uploadedBy, d.reviewedBy]));
    let items = rows.filter(({ d }) => docVisible(d, allowed, locs))
      .filter(({ d }) => !req.query.locationId || d.locationId === req.query.locationId || (!!d.ownerGroupId && locs.find((l) => l.id === req.query.locationId)?.ownerGroupId === d.ownerGroupId))
      .filter(({ d }) => !req.query.requirementId || d.requirementId === req.query.requirementId)
      .map(({ d, req: rn, grp }) => serializeDocument(s, d, today, { locationName: d.locationId ? locName.get(d.locationId) ?? null : null, ownerGroupName: grp, requirementName: rn, names: people }));
    if (req.query.status === 'expiring') items = items.filter((d) => d.expiry === 'expiring' && !d.superseded);
    else if (req.query.status === 'expired') items = items.filter((d) => d.expiry === 'expired' && !d.superseded);
    else if (req.query.status !== 'all') items = items.filter((d) => d.status === req.query.status);
    if (req.query.expiringWithinDays !== undefined) items = items.filter((d) => d.status === 'approved' && !d.superseded && d.daysLeft !== null && d.daysLeft <= req.query.expiringWithinDays!).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
    return { items, today };
  });

  app.post('/orgs/:orgId/compliance/documents', { bodyLimit: 15 * 1024 * 1024, schema: { tags, security: secured, params: orgParams, body: documentBody, summary: 'Upload a certificate, licence or permit for a location or an owner group (edit there). HQ uploads (publish) are approved straight away.' } }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    await complianceLocations(req, db, orgId);
    const locs = await orgLocationsFull(db, orgId);
    if (b.locationId && !locs.some((l) => l.id === b.locationId)) throw notFound('Location');
    if (b.ownerGroupId) {
      const [g] = await db.select({ id: ownerGroups.id }).from(ownerGroups).where(and(eq(ownerGroups.id, b.ownerGroupId), eq(ownerGroups.organizationId, orgId)));
      if (!g) throw notFound('Owner group');
    }
    if (!(await canActOnTarget(req, db, orgId, b, 'edit'))) throw forbidden('You can only upload documents for your own locations');
    if (b.requirementId) {
      const [r] = await db.select().from(complianceRequirements).where(and(eq(complianceRequirements.id, b.requirementId), eq(complianceRequirements.organizationId, orgId)));
      if (!r) throw notFound('Requirement');
      if ((r.appliesTo === 'owner_group') !== !!b.ownerGroupId) throw validationError(r.appliesTo === 'owner_group' ? 'This requirement is held per owner group' : 'This requirement is held per location', { locationId: 'Wrong target for this requirement' });
      if (r.requiresExpiry && !b.expiresOn) throw validationError('Give the expiry date', { expiresOn: 'Required for this document' });
    }
    const autoApprove = await canActOnTarget(req, db, orgId, b, 'publish');
    const now = new Date();
    const d = await db.transaction(async (tx) => {
      const f = await storeFile(s, tx, { organizationId: orgId, locationId: b.locationId, ownerGroupId: b.ownerGroupId, purpose: 'compliance_document', upload: b.file, uploadedBy: req.user!.id });
      const { file: _file, ...fields } = b;
      const [d] = await tx.insert(complianceDocuments).values({
        organizationId: orgId, ...fields, fileId: f.id, uploadedBy: req.user!.id,
        status: autoApprove ? 'approved' : 'pending', ...(autoApprove ? { reviewedBy: req.user!.id, reviewedAt: now } : {}),
      }).returning();
      if (autoApprove) await supersedeOlder(tx, d!, now);
      await audit(tx, { organizationId: orgId, actorUserId: req.user!.id, action: 'compliance.document_uploaded', scopeKind: b.locationId ? 'location' : 'owner_group', scopeId: (b.locationId ?? b.ownerGroupId)!, targetType: 'compliance_document', targetId: d!.id, metadata: { category: b.category, autoApprove }, ip: req.ip });
      return d!;
    });
    return reply.code(201).send(serializeDocument(s, d, await orgDay(db, orgId)));
  });

  app.get('/orgs/:orgId/compliance/documents/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    const d = await loadDocument(req, db, orgId, id);
    const people = await names(db, [d.uploadedBy, d.reviewedBy]);
    return serializeDocument(s, d, await orgDay(db, orgId), { names: people });
  });

  app.post('/orgs/:orgId/compliance/documents/:id/review', {
    schema: { tags, security: secured, params: idParams, body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).optional() }), summary: 'Approve or reject an upload (publish for that location); approving replaces the older document' },
  }, async (req) => {
    const { orgId, id } = req.params;
    const d = await loadDocument(req, db, orgId, id);
    if (!(await canActOnTarget(req, db, orgId, d, 'publish'))) throw forbidden('Only HQ can review compliance documents');
    if (d.status !== 'pending') throw conflict('document_not_pending', 'This document was already reviewed');
    if (req.body.decision === 'reject' && !req.body.note) throw validationError('Say why it is rejected', { note: 'Required when rejecting' });
    const now = new Date();
    const u = await db.transaction(async (tx) => {
      const [u] = await tx.update(complianceDocuments).set({ status: req.body.decision === 'approve' ? 'approved' : 'rejected', reviewNote: req.body.note ?? null, reviewedBy: req.user!.id, reviewedAt: now, updatedAt: now })
        .where(and(eq(complianceDocuments.id, id), eq(complianceDocuments.status, 'pending'))).returning();
      if (!u) throw conflict('document_not_pending', 'This document was already reviewed');
      if (u.status === 'approved') await supersedeOlder(tx, u, now);
      await audit(tx, { organizationId: orgId, actorUserId: req.user!.id, action: `compliance.document_${u.status}`, targetType: 'compliance_document', targetId: id, ip: req.ip });
      return u;
    });
    if (u.uploadedBy && u.uploadedBy !== req.user!.id) {
      const { users } = await import('../db/schema/index.ts');
      const [up] = await db.select({ email: users.email }).from(users).where(eq(users.id, u.uploadedBy));
      if (up) await s.jobs.enqueue('email.send', { to: up.email, subject: `${u.title}: ${u.status === 'approved' ? 'approved' : 'needs a new upload'}`, text: `${u.title} was ${u.status} by HQ.${u.reviewNote ? `\n\n${u.reviewNote}` : ''}\nOpen: ${s.cfg.APP_URL}/compliance`, tag: 'compliance_review' });
    }
    return serializeDocument(s, u, await orgDay(db, orgId));
  });

  app.post('/orgs/:orgId/compliance/jobs/run', { schema: { tags, security: secured, params: orgParams, summary: 'Send due expiry reminders (60, 30, 7 days and on expiry, with escalation to HQ) now. Also runs daily.' } }, async (req) => {
    const { orgId } = req.params;
    if (!(await canOrgCompliance(req, db, orgId, 'publish'))) throw forbidden('Only HQ can run compliance reminders');
    return runComplianceJobs(s, new Date(), orgId);
  });
};

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AUDIT_PURPOSES, AUDIT_STATUSES, STARTER_AUDIT_TEMPLATES, auditAnswerSchema, auditTemplateBodySchema, startersFor } from '@bh/shared';
import { auditActions, auditTemplates, audits, franchiseProjects, locations, organizations } from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit as auditLog } from '../services/audit.ts';
import { requireMember } from '../services/authz.ts';
import {
  MODULE, actionOverdue, auditDashboard, auditDetail, auditLocations, canAt, canConduct, canOrg, completeAudit, getTemplate, inScope, loadAction, loadAudit, names, orgToday,
  preOpeningState, projectForLocation, requireAt, runAuditJobs, saveAnswers, scheduleAudit, serializeAction, serializeAudit, serializeTemplate, usersWithCapability,
} from '../services/audits.ts';
import { filesById, fileView, readFileBytes, storeFile, verifyFileSignature } from '../services/ops-files.ts';
import { opsFiles } from '../db/schema/index.ts';
import { toCsv } from '../services/finance/exports.ts';
import { idParams, orgParams, secured } from './_common.ts';

const tags = ['audits'];
const some = (x: 'all' | Set<string>) => x === 'all' || x.size > 0;
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const uploadSchema = z.object({ filename: z.string().trim().min(1).max(200), contentType: z.string().min(3).max(120), dataBase64: z.string().min(4) });
const UPLOAD_BODY_LIMIT = 15 * 1024 * 1024;

/**
 * Field visits and audits (`/v1/orgs/:orgId/audits/...`, module `operations.audits`): checklist templates, scheduling,
 * conducting with autosave and photos, scoring, corrective actions, re-audits, the dashboard and the CSV export.
 * Signed private file links are served at `/v1/files/:id`.
 */
export const privateFileRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  // Private files (audit photos, evidence, certificates): signed, expiring links only. No bearer token, so <img> works.
  app.get('/files/:id', { schema: { tags, params: z.object({ id: z.uuid() }), querystring: z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(100) }), hide: true } }, async (req, reply) => {
    if (!verifyFileSignature(s, req.params.id, req.query.exp, req.query.sig)) throw notFound('File');
    const [f] = await db.select().from(opsFiles).where(eq(opsFiles.id, req.params.id));
    if (!f) throw notFound('File');
    const data = await readFileBytes(s, f);
    if (!data) throw notFound('File');
    reply.header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff').header('cross-origin-resource-policy', 'cross-origin')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox").header('content-disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
    return reply.type(f.mime).send(data);
  });
};

export const auditRoutes: FastifyPluginAsyncZod = async (r) => {
  const s = r.ctx;
  const db = s.db;
  r.addHook('preHandler', authenticate);

    /* ------------------------------ templates ------------------------------ */

    r.get('/orgs/:orgId/audits/templates', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum(['active', 'archived', 'all']).default('active') }), summary: 'Checklist templates (anyone with Audits)' } }, async (req) => {
      const { orgId } = req.params;
      await requireMember(req, db, orgId);
      const conds = [eq(auditTemplates.organizationId, orgId)];
      if (req.query.status !== 'all') conds.push(eq(auditTemplates.status, req.query.status));
      const rows = await db.select().from(auditTemplates).where(and(...conds)).orderBy(asc(auditTemplates.name));
      return { items: rows.map(serializeTemplate), canManage: await canOrg(req, db, orgId, 'publish') };
    });

    r.get('/orgs/:orgId/audits/starters', { schema: { tags, security: secured, params: orgParams, summary: 'Starter checklists offered for this industry (no sample data, sensible checks to edit)' } }, async (req) => {
      const { orgId } = req.params;
      await requireMember(req, db, orgId);
      const [o] = await db.select({ industry: organizations.industry }).from(organizations).where(eq(organizations.id, orgId));
      return { items: startersFor(o!.industry).map((t) => ({ key: t.key, name: t.name, description: t.description, preOpening: !!t.preOpening, questionCount: t.sections.reduce((n, x) => n + x.questions.length, 0), sections: t.sections.map((x) => x.title) })) };
    });

    const templateCreate = z.union([z.object({ starterKey: z.string().min(1).max(40) }), auditTemplateBodySchema]);
    r.post('/orgs/:orgId/audits/templates', { schema: { tags, security: secured, params: orgParams, body: templateCreate, summary: 'Create a checklist from scratch or from a starter (Audits publish, organisation-wide)' } }, async (req, reply) => {
      const { orgId } = req.params;
      if (!(await canOrg(req, db, orgId, 'publish'))) throw forbidden('Only HQ can manage checklist templates');
      let body;
      let starterKey: string | null = null;
      if ('starterKey' in req.body) {
        const st = STARTER_AUDIT_TEMPLATES.find((t) => t.key === (req.body as { starterKey: string }).starterKey);
        if (!st) throw validationError('Unknown starter checklist', { starterKey: 'Unknown' });
        body = auditTemplateBodySchema.parse(st);
        starterKey = st.key;
      } else body = req.body;
      const [t] = await db.insert(auditTemplates).values({ organizationId: orgId, ...body, starterKey, createdBy: req.user!.id, updatedBy: req.user!.id }).returning();
      await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'audit_template.created', targetType: 'audit_template', targetId: t!.id, metadata: { starterKey }, ip: req.ip });
      return reply.code(201).send(serializeTemplate(t!));
    });

    r.get('/orgs/:orgId/audits/templates/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
      await requireMember(req, db, req.params.orgId);
      return serializeTemplate(await getTemplate(db, req.params.orgId, req.params.id));
    });

    r.put('/orgs/:orgId/audits/templates/:id', { schema: { tags, security: secured, params: idParams, body: auditTemplateBodySchema, summary: 'Edit a checklist (new version; scheduled audits keep the checklist they were created with)' } }, async (req) => {
      const { orgId, id } = req.params;
      if (!(await canOrg(req, db, orgId, 'publish'))) throw forbidden('Only HQ can manage checklist templates');
      const t = await getTemplate(db, orgId, id);
      const [u] = await db.update(auditTemplates).set({ ...req.body, version: t.version + 1, updatedBy: req.user!.id, updatedAt: new Date() }).where(eq(auditTemplates.id, id)).returning();
      // Audits that haven't started yet pick up the new version.
      await db.update(audits).set({ checklist: { name: u!.name, sections: u!.sections, passThreshold: u!.passThreshold, reauditDays: u!.reauditDays, correctiveDays: u!.correctiveDays, version: u!.version }, updatedAt: new Date() })
        .where(and(eq(audits.templateId, id), eq(audits.status, 'scheduled')));
      await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'audit_template.updated', targetType: 'audit_template', targetId: id, metadata: { version: u!.version }, ip: req.ip });
      return serializeTemplate(u!);
    });

    r.post('/orgs/:orgId/audits/templates/:id/status', { schema: { tags, security: secured, params: idParams, body: z.object({ status: z.enum(['active', 'archived']) }) } }, async (req) => {
      const { orgId, id } = req.params;
      if (!(await canOrg(req, db, orgId, 'publish'))) throw forbidden('Only HQ can manage checklist templates');
      await getTemplate(db, orgId, id);
      const [u] = await db.update(auditTemplates).set({ status: req.body.status, updatedAt: new Date() }).where(eq(auditTemplates.id, id)).returning();
      return serializeTemplate(u!);
    });

    /* ------------------------------- audits -------------------------------- */

    r.get('/orgs/:orgId/audits', {
      schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum([...AUDIT_STATUSES, 'open', 'all']).default('all'), locationId: z.uuid().optional(), mine: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), summary: 'Audits at the locations in scope (open = scheduled or in progress; mine = assigned to me)' },
    }, async (req) => {
      const { orgId } = req.params;
      const allowed = await auditLocations(req, db, orgId);
      const conds = [eq(audits.organizationId, orgId)];
      if (req.query.status === 'open') conds.push(inArray(audits.status, ['scheduled', 'in_progress']));
      else if (req.query.status !== 'all') conds.push(eq(audits.status, req.query.status));
      if (req.query.locationId) conds.push(eq(audits.locationId, req.query.locationId));
      if (req.query.mine) conds.push(eq(audits.auditorUserId, req.user!.id));
      if (allowed !== 'all') conds.push(allowed.size ? inArray(audits.locationId, [...allowed]) : sql`false`);
      const rows = await db.select({ a: audits, loc: locations.name }).from(audits).innerJoin(locations, eq(locations.id, audits.locationId)).where(and(...conds))
        .orderBy(sql`case when ${audits.status} in ('scheduled','in_progress') then 0 else 1 end`, asc(audits.dueDate), desc(audits.completedAt)).limit(req.query.limit);
      const today = await orgToday(db, orgId);
      const ids = rows.map((x) => x.a.id);
      const acts = ids.length ? await db.select({ auditId: auditActions.auditId, status: auditActions.status, dueDate: auditActions.dueDate }).from(auditActions).where(inArray(auditActions.auditId, ids)) : [];
      const people = await names(db, rows.map((x) => x.a.auditorUserId));
      return {
        items: rows.map(({ a, loc }) => serializeAudit(a, today, {
          locationName: loc, auditorName: a.auditorUserId ? people.get(a.auditorUserId) : null,
          openActions: acts.filter((x) => x.auditId === a.id && x.status !== 'verified').length, overdueActions: acts.filter((x) => x.auditId === a.id && actionOverdue(x, today)).length,
        })),
        today,
        can: { schedule: await canOrg(req, db, orgId, 'publish'), export: some(await auditLocations(req, db, orgId, 'export')) },
      };
    });

    r.get('/orgs/:orgId/audits/auditors', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid() }), summary: 'People who can conduct audits at a location (Audits edit there)' } }, async (req) => {
      const { orgId } = req.params;
      await requireAt(req, db, orgId, req.query.locationId, 'publish');
      const ids = await usersWithCapability(db, orgId, req.query.locationId, MODULE, 'edit');
      const people = await names(db, ids);
      return { items: ids.map((id) => ({ id, name: people.get(id) ?? '' })).sort((a, b) => a.name.localeCompare(b.name)) };
    });

    const scheduleBody = z.object({ locationId: z.uuid(), templateId: z.uuid(), dueDate: ymd, auditorUserId: z.uuid().nullable().default(null), purpose: z.enum(AUDIT_PURPOSES).default('routine'), projectId: z.uuid().nullable().optional() });
    r.post('/orgs/:orgId/audits', { schema: { tags, security: secured, params: orgParams, body: scheduleBody, summary: 'Schedule an audit for a location with a due date and an auditor (Audits publish at the location)' } }, async (req, reply) => {
      const { orgId } = req.params;
      const b = req.body;
      await requireAt(req, db, orgId, b.locationId, 'publish', 'Scheduling audits needs Audits (publish) at this location');
      if (b.purpose === 'pre_opening') {
        if (!b.projectId) throw validationError('Choose the new-location project', { projectId: 'Required for a pre-opening audit' });
        const proj = await projectForLocation(db, orgId, b.projectId);
        if (proj.locationId !== b.locationId) throw validationError('This project is for another location', { projectId: 'Location mismatch' });
        await db.update(franchiseProjects).set({ preOpeningTemplateId: b.templateId, updatedAt: new Date() }).where(eq(franchiseProjects.id, proj.id));
      }
      const a = await scheduleAudit(db, orgId, { ...b, projectId: b.purpose === 'pre_opening' ? b.projectId : null }, req.user!.id);
      await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'audit.scheduled', scopeKind: 'location', scopeId: a.locationId, targetType: 'audit', targetId: a.id, metadata: { templateId: b.templateId, dueDate: b.dueDate, purpose: b.purpose }, ip: req.ip });
      if (a.auditorUserId && a.auditorUserId !== req.user!.id) {
        const [loc] = await db.select({ name: locations.name }).from(locations).where(eq(locations.id, a.locationId));
        const { users } = await import('../db/schema/index.ts');
        const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, a.auditorUserId));
        if (u) await s.jobs.enqueue('email.send', { to: u.email, subject: `Audit scheduled: ${a.checklist.name} at ${loc?.name ?? ''}`, text: `You are the auditor for ${a.checklist.name} at ${loc?.name ?? ''}, due ${a.dueDate}.\nOpen: ${s.cfg.APP_URL}/audits/${a.id}`, tag: 'audit_scheduled' });
      }
      return reply.code(201).send(serializeAudit(a, await orgToday(db, orgId)));
    });

    r.put('/orgs/:orgId/audits/projects/:id/pre-opening', {
      schema: { tags, security: secured, params: idParams, body: z.object({ templateId: z.uuid().nullable() }), summary: 'Use an audit checklist for a new location’s pre-opening checks: the opening can only be requested once an audit with it passes (null removes the requirement)' },
    }, async (req) => {
      const { orgId, id } = req.params;
      if (!(await canOrg(req, db, orgId, 'publish'))) throw forbidden('Only HQ can set the pre-opening checklist');
      const proj = await projectForLocation(db, orgId, id);
      if (proj.status === 'opened' || proj.status === 'cancelled') throw conflict('project_not_active', `The project is ${proj.status}`);
      if (req.body.templateId) await getTemplate(db, orgId, req.body.templateId);
      const [u] = await db.update(franchiseProjects).set({ preOpeningTemplateId: req.body.templateId, updatedAt: new Date() }).where(eq(franchiseProjects.id, id)).returning();
      await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'franchise.pre_opening_checklist_set', targetType: 'franchise_project', targetId: id, metadata: { templateId: req.body.templateId }, ip: req.ip });
      return { projectId: id, preOpening: await preOpeningState(db, u!) };
    });

    r.get('/orgs/:orgId/audits/dashboard', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }), summary: 'Audit scores by location over time, overdue corrective actions and overdue audits for the locations in scope' } }, async (req) => {
      const { orgId } = req.params;
      const allowed = await auditLocations(req, db, orgId);
      return auditDashboard(s, orgId, allowed, req.query.months);
    });

    r.get('/orgs/:orgId/audits/export', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ from: ymd.optional(), to: ymd.optional() }), summary: 'Completed audits as CSV (Audits export, locations in scope)' } }, async (req, reply) => {
      const { orgId } = req.params;
      const allowed = await auditLocations(req, db, orgId, 'export');
      if (allowed !== 'all' && !allowed.size) throw forbidden('Exporting audits needs Audits (export)');
      const rows = await db.select({ a: audits, loc: locations.name, code: locations.code }).from(audits).innerJoin(locations, eq(locations.id, audits.locationId))
        .where(and(eq(audits.organizationId, orgId), eq(audits.status, 'completed'))).orderBy(desc(audits.completedAt));
      const people = await names(db, rows.map((x) => x.a.auditorUserId));
      const acts = await db.select({ auditId: auditActions.auditId, status: auditActions.status }).from(auditActions).where(eq(auditActions.organizationId, orgId));
      const list = rows.filter(({ a }) => inScope(allowed, a.locationId))
        .filter(({ a }) => (!req.query.from || a.completedAt!.toISOString().slice(0, 10) >= req.query.from) && (!req.query.to || a.completedAt!.toISOString().slice(0, 10) <= req.query.to));
      const csv = toCsv(['completed_at', 'location', 'location_code', 'checklist', 'purpose', 'auditor', 'score_pct', 'passed', 'critical_failed', 'corrective_actions', 'open_actions', 'reaudit_due'],
        list.map(({ a, loc, code }) => [a.completedAt!.toISOString(), loc, code, a.checklist.name, a.purpose, a.auditorUserId ? people.get(a.auditorUserId) ?? '' : '', a.scoreTenths === null ? '' : (a.scoreTenths / 10).toFixed(1), a.passed ? 'yes' : 'no', a.criticalFailed ? 'yes' : 'no',
          acts.filter((x) => x.auditId === a.id).length, acts.filter((x) => x.auditId === a.id && x.status !== 'verified').length, a.reauditDueDate ?? '']));
      return reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="audits.csv"').send(csv);
    });

    r.post('/orgs/:orgId/audits/jobs/run', { schema: { tags, security: secured, params: orgParams, summary: 'Send due reminders for overdue corrective actions and audits now (also runs on the schedule)' } }, async (req) => {
      const { orgId } = req.params;
      if (!(await canOrg(req, db, orgId, 'publish'))) throw forbidden('Only HQ can run audit reminders');
      return runAuditJobs(s, new Date(), orgId);
    });

    /* -------------------------- corrective actions ------------------------- */

    r.get('/orgs/:orgId/audits/actions', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum(['open', 'submitted', 'verified', 'overdue', 'active', 'all']).default('active'), locationId: z.uuid().optional() }), summary: 'Corrective actions at the locations in scope (active = open or waiting for verification)' } }, async (req) => {
      const { orgId } = req.params;
      const allowed = await auditLocations(req, db, orgId);
      const today = await orgToday(db, orgId);
      const conds = [eq(auditActions.organizationId, orgId)];
      if (req.query.status === 'active') conds.push(inArray(auditActions.status, ['open', 'submitted']));
      else if (req.query.status === 'overdue') conds.push(eq(auditActions.status, 'open'), sql`${auditActions.dueDate} < ${today}`);
      else if (req.query.status !== 'all') conds.push(eq(auditActions.status, req.query.status));
      if (req.query.locationId) conds.push(eq(auditActions.locationId, req.query.locationId));
      if (allowed !== 'all') conds.push(allowed.size ? inArray(auditActions.locationId, [...allowed]) : sql`false`);
      const rows = await db.select({ x: auditActions, loc: locations.name }).from(auditActions).innerJoin(locations, eq(locations.id, auditActions.locationId)).where(and(...conds)).orderBy(asc(auditActions.dueDate)).limit(500);
      const people = await names(db, rows.flatMap(({ x }) => [x.submittedBy, x.verifiedBy]));
      return { items: rows.map(({ x, loc }) => serializeAction(s, x, today, { locationName: loc, names: people })), today };
    });

    r.post('/orgs/:orgId/audits/actions/:id/evidence', { bodyLimit: UPLOAD_BODY_LIMIT, schema: { tags, security: secured, params: idParams, body: uploadSchema, summary: 'Upload an evidence photo for a corrective action (Audits edit at the location)' } }, async (req, reply) => {
      const { orgId, id } = req.params;
      const x = await loadAction(req, db, orgId, id);
      await requireAt(req, db, orgId, x.locationId, 'edit');
      const f = await storeFile(s, db, { organizationId: orgId, locationId: x.locationId, purpose: 'corrective_evidence', upload: req.body, uploadedBy: req.user!.id });
      return reply.code(201).send(fileView(s, f));
    });

    r.post('/orgs/:orgId/audits/actions/:id/submit', { schema: { tags, security: secured, params: idParams, body: z.object({ note: z.string().trim().max(2000).default(''), evidenceFileIds: z.array(z.uuid()).min(1).max(10) }), summary: 'Mark a corrective action done with evidence; the auditor then verifies it' } }, async (req) => {
      const { orgId, id } = req.params;
      const x = await loadAction(req, db, orgId, id);
      await requireAt(req, db, orgId, x.locationId, 'edit', 'Completing corrective actions needs Audits (edit) at this location');
      if (x.status !== 'open') throw conflict('action_not_open', x.status === 'verified' ? 'This corrective action is already verified' : 'This corrective action is waiting for verification');
      const files = await filesById(db, orgId, req.body.evidenceFileIds);
      if (req.body.evidenceFileIds.some((fid) => { const f = files.get(fid); return !f || f.purpose !== 'corrective_evidence' || f.locationId !== x.locationId; })) {
        throw validationError('Upload the evidence photo for this action first', { evidenceFileIds: 'Unknown file' });
      }
      const [u] = await db.update(auditActions).set({ status: 'submitted', responseNote: req.body.note || null, evidenceFileIds: req.body.evidenceFileIds, submittedBy: req.user!.id, submittedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(auditActions.id, id), eq(auditActions.status, 'open'))).returning();
      if (!u) throw conflict('action_not_open', 'This corrective action changed. Reload and try again.');
      await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'audit_action.submitted', scopeKind: 'location', scopeId: x.locationId, targetType: 'audit_action', targetId: id, ip: req.ip });
      return serializeAction(s, u, await orgToday(db, orgId));
    });

    r.post('/orgs/:orgId/audits/actions/:id/verify', { schema: { tags, security: secured, params: idParams, body: z.object({ decision: z.enum(['verify', 'reopen']), note: z.string().trim().max(2000).optional() }), summary: 'Verify a corrective action, or reopen it with a note (the auditor, or Audits publish at the location)' } }, async (req) => {
      const { orgId, id } = req.params;
      const x = await loadAction(req, db, orgId, id);
      const [a] = await db.select({ auditorUserId: audits.auditorUserId }).from(audits).where(eq(audits.id, x.auditId));
      const isAuditor = a?.auditorUserId === req.user!.id && (await canAt(req, db, orgId, x.locationId, 'edit'));
      if (!isAuditor && !(await canAt(req, db, orgId, x.locationId, 'publish'))) throw forbidden('Only the auditor or HQ can verify corrective actions');
      if (x.submittedBy === req.user!.id && !(await canAt(req, db, orgId, x.locationId, 'publish'))) throw forbidden('You cannot verify your own fix');
      if (x.status !== 'submitted') throw conflict('action_not_submitted', 'Only a completed action waiting for verification can be verified');
      if (req.body.decision === 'reopen' && !req.body.note) throw validationError('Say what still needs fixing', { note: 'Required when reopening' });
      const now = new Date();
      const [u] = await db.update(auditActions).set(req.body.decision === 'verify'
        ? { status: 'verified', verifiedBy: req.user!.id, verifiedAt: now, reviewNote: req.body.note ?? null, updatedAt: now }
        : { status: 'open', reviewNote: req.body.note ?? null, reopenedCount: x.reopenedCount + 1, remindedAt: null, updatedAt: now }).where(and(eq(auditActions.id, id), eq(auditActions.status, 'submitted'))).returning();
      if (!u) throw conflict('action_not_submitted', 'This corrective action changed. Reload and try again.');
      await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: req.body.decision === 'verify' ? 'audit_action.verified' : 'audit_action.reopened', scopeKind: 'location', scopeId: x.locationId, targetType: 'audit_action', targetId: id, ip: req.ip });
      return serializeAction(s, u, await orgToday(db, orgId));
    });

    /* ----------------------------- one audit ------------------------------- */

    r.get('/orgs/:orgId/audits/:id', { schema: { tags, security: secured, params: idParams, summary: 'Audit report: checklist, answers with photos, score breakdown and corrective actions' } }, async (req) => {
      const a = await loadAudit(req, db, req.params.orgId, req.params.id);
      return auditDetail(s, req, a);
    });

    r.patch('/orgs/:orgId/audits/:id', { schema: { tags, security: secured, params: idParams, body: z.object({ dueDate: ymd.optional(), auditorUserId: z.uuid().nullable().optional() }), summary: 'Reschedule or reassign (Audits publish at the location)' } }, async (req) => {
      const { orgId, id } = req.params;
      const a = await loadAudit(req, db, orgId, id);
      await requireAt(req, db, orgId, a.locationId, 'publish');
      if (a.status === 'completed' || a.status === 'cancelled') throw conflict('audit_closed', 'This audit is already closed');
      if (req.body.auditorUserId) {
        const ok = await usersWithCapability(db, orgId, a.locationId, MODULE, 'edit');
        if (!ok.includes(req.body.auditorUserId)) throw validationError('This person cannot conduct audits at this location', { auditorUserId: 'Needs Audits (edit) at this location' });
      }
      const [u] = await db.update(audits).set({ ...req.body, remindedAt: null, updatedAt: new Date() }).where(eq(audits.id, id)).returning();
      return serializeAudit(u!, await orgToday(db, orgId));
    });

    r.post('/orgs/:orgId/audits/:id/cancel', { schema: { tags, security: secured, params: idParams, body: z.object({ reason: z.string().trim().max(500).optional() }) } }, async (req) => {
      const { orgId, id } = req.params;
      const a = await loadAudit(req, db, orgId, id);
      await requireAt(req, db, orgId, a.locationId, 'publish');
      if (a.status === 'completed' || a.status === 'cancelled') throw conflict('audit_closed', 'This audit is already closed');
      const [u] = await db.update(audits).set({ status: 'cancelled', cancelReason: req.body.reason ?? null, updatedAt: new Date() }).where(eq(audits.id, id)).returning();
      await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'audit.cancelled', scopeKind: 'location', scopeId: a.locationId, targetType: 'audit', targetId: id, ip: req.ip });
      return serializeAudit(u!, await orgToday(db, orgId));
    });

    r.put('/orgs/:orgId/audits/:id/answers', {
      schema: { tags, security: secured, params: idParams, body: z.object({ answers: z.record(z.string().max(40), auditAnswerSchema) }), summary: 'Autosave answers (merged per question, so offline saves never wipe other answers)' },
    }, async (req) => {
      const { orgId, id } = req.params;
      const a = await loadAudit(req, db, orgId, id);
      if (!(await canConduct(req, db, a))) throw forbidden('Only the assigned auditor can fill in this audit');
      const u = await saveAnswers(db, a, req.body.answers);
      return { id: u.id, status: u.status, revision: u.revision, savedAt: u.updatedAt.toISOString() };
    });

    r.post('/orgs/:orgId/audits/:id/photos', { bodyLimit: UPLOAD_BODY_LIMIT, schema: { tags, security: secured, params: idParams, body: uploadSchema, summary: 'Upload a photo for this audit (private; attach it to an answer with photoIds)' } }, async (req, reply) => {
      const { orgId, id } = req.params;
      const a = await loadAudit(req, db, orgId, id);
      if (!(await canConduct(req, db, a))) throw forbidden('Only the assigned auditor can add photos to this audit');
      if (a.status === 'completed' || a.status === 'cancelled') throw conflict('audit_closed', 'This audit is already closed');
      const f = await storeFile(s, db, { organizationId: orgId, locationId: a.locationId, purpose: 'audit_photo', upload: req.body, uploadedBy: req.user!.id });
      return reply.code(201).send(fileView(s, f));
    });

    r.post('/orgs/:orgId/audits/:id/complete', {
      schema: { tags, security: secured, params: idParams, body: z.object({ summary: z.string().trim().max(4000).optional(), answers: z.record(z.string().max(40), auditAnswerSchema).optional() }), summary: 'Finish the audit: score it, raise corrective actions for failed items and schedule the re-audit when it failed' },
    }, async (req) => {
      const { orgId, id } = req.params;
      let a = await loadAudit(req, db, orgId, id);
      if (!(await canConduct(req, db, a))) throw forbidden('Only the assigned auditor can complete this audit');
      if (req.body.answers && Object.keys(req.body.answers).length) a = await saveAnswers(db, a, req.body.answers);
      const out = await completeAudit(s, a, req.user!.id, req.body.summary ?? null);
      await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'audit.completed', scopeKind: 'location', scopeId: a.locationId, targetType: 'audit', targetId: id, metadata: { scorePct: out.score.scorePct, passed: out.score.passed, criticalFailed: out.score.criticalFailed, actions: out.score.failedItems.length }, ip: req.ip });
      if (out.score.failedItems.length) {
        const ids = (await usersWithCapability(db, orgId, a.locationId, MODULE, 'edit')).filter((u) => u !== req.user!.id);
        const [loc] = await db.select({ name: locations.name }).from(locations).where(eq(locations.id, a.locationId));
        const { users } = await import('../db/schema/index.ts');
        const emails = ids.length ? await db.select({ email: users.email }).from(users).where(inArray(users.id, ids)) : [];
        for (const e of emails) {
          await s.jobs.enqueue('email.send', { to: e.email, subject: `Audit result for ${loc?.name ?? ''}: ${out.score.scorePct ?? '—'}% (${out.score.passed ? 'passed' : 'failed'})`, text: `${a.checklist.name} at ${loc?.name ?? ''} is complete.\n${out.score.failedItems.length} corrective actions need a fix with a photo.${out.reaudit ? `\nRe-audit due ${out.reaudit.dueDate}.` : ''}\nOpen the report: ${s.cfg.APP_URL}/audits/${a.id}`, tag: 'audit_completed' });
        }
      }
      return auditDetail(s, req, out.audit);
    });
};

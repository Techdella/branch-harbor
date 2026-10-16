import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { SELF_CHECK_STARTERS, auditAnswerSchema, auditScheduleBodySchema, auditTemplateBodySchema, selfCheckScheduleBodySchema, selfCheckStartersFor, scheduleDueDates, type AuditFrequency } from '@bh/shared';
import { auditActions, auditSchedules, auditTemplates, audits, courses, locations, organizations, selfCheckRuns, selfCheckSchedules } from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit as auditLog } from '../services/audit.ts';
import { requireMember } from '../services/authz.ts';
import { MODULE as AUDITS, auditLocations, canAt, canOrg, loadAction, names, orgToday, serializeAction, usersWithCapability } from '../services/audits.ts';
import {
  assignRetraining, auditTrends, completeRun, createSelfCheckRuns, fieldConsultantFor, loadRun, loadSchedule, loadSelfSchedule, nextDueOf, requireSelfPublishFor, runAuditSchedules,
  runSelfCheckJobs, saveRunAnswers, scheduleLocations, selfCan, selfCheckDashboard, selfLocations, serializeRun, serializeSchedule, serializeSelfSchedule, trainingFor, visitPlan,
} from '../services/audit-programmes.ts';
import { fileView, storeFile } from '../services/ops-files.ts';
import { toCsv } from '../services/finance/exports.ts';
import { uploadSchema } from './audits.ts';
import { idParams, orgParams, secured } from './_common.ts';

const tags = ['audits'];
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const some = (x: 'all' | Set<string>) => x === 'all' || x.size > 0;

/**
 * Audits phase 2 (`/v1/orgs/:orgId/audits/...`, module `operations.audits`): recurring schedules, trend analytics, the
 * visit planner and the retraining link; and self-checks (`/v1/orgs/:orgId/self-checks/...`, module
 * `operations.self_checks`): schedules, today's checklists, results and the dashboard.
 */
export const auditProgrammeRoutes: FastifyPluginAsyncZod = async (r) => {
  const s = r.ctx;
  const db = s.db;
  r.addHook('preHandler', authenticate);

  /* ----------------------------- schedules ----------------------------- */

  const requireHq = async (req: Parameters<typeof canOrg>[0], orgId: string) => {
    if (!(await canOrg(req, db, orgId, 'publish'))) throw forbidden('Only HQ can manage audit schedules');
  };

  r.get('/orgs/:orgId/audits/schedules', { schema: { tags, security: secured, params: orgParams, summary: 'Recurring audit schedules (HQ: Audits publish organisation-wide)' } }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    await requireHq(req, orgId);
    const rows = await db.select({ x: auditSchedules, t: auditTemplates.name }).from(auditSchedules).innerJoin(auditTemplates, eq(auditTemplates.id, auditSchedules.templateId)).where(eq(auditSchedules.organizationId, orgId)).orderBy(asc(auditSchedules.name));
    const people = await names(db, rows.map(({ x }) => x.auditorUserId));
    const today = await orgToday(db, orgId);
    const items = [];
    for (const { x, t } of rows) items.push(serializeSchedule(x, { templateName: t, auditorName: x.auditorUserId ? people.get(x.auditorUserId) : null, locationCount: (await scheduleLocations(db, orgId, x.target)).length, nextDue: nextDueOf(x, today) }));
    return { items, today };
  });

  const checkScheduleBody = async (orgId: string, b: z.infer<typeof auditScheduleBodySchema>) => {
    const [t] = await db.select().from(auditTemplates).where(and(eq(auditTemplates.id, b.templateId), eq(auditTemplates.organizationId, orgId)));
    if (!t) throw notFound('Checklist template');
    if (t.status !== 'active') throw conflict('template_archived', 'This checklist is archived');
    if (b.auditorRule === 'user' && !b.auditorUserId) throw validationError('Choose the auditor', { auditorUserId: 'Required' });
    if (b.auditorUserId) {
      const any = await usersWithCapability(db, orgId, null, AUDITS, 'view');
      const locs = await scheduleLocations(db, orgId, b.target);
      let ok = any.includes(b.auditorUserId);
      for (const l of locs) { if (ok) break; ok = (await usersWithCapability(db, orgId, l.id, AUDITS, 'edit')).includes(b.auditorUserId); }
      if (!ok) throw validationError('This person cannot conduct audits at these locations', { auditorUserId: 'Needs Audits (edit)' });
    }
  };

  r.post('/orgs/:orgId/audits/schedules', { schema: { tags, security: secured, params: orgParams, body: auditScheduleBodySchema, summary: 'Create a recurring audit schedule (e.g. a monthly brand visit at every location)' } }, async (req, reply) => {
    const { orgId } = req.params;
    await requireHq(req, orgId);
    await checkScheduleBody(orgId, req.body);
    const [x] = await db.insert(auditSchedules).values({ organizationId: orgId, ...req.body, createdBy: req.user!.id }).returning();
    await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'audit_schedule.created', targetType: 'audit_schedule', targetId: x!.id, metadata: { frequency: x!.frequency, target: x!.target }, ip: req.ip });
    return reply.code(201).send(serializeSchedule(x!, { locationCount: (await scheduleLocations(db, orgId, x!.target)).length, nextDue: nextDueOf(x!, await orgToday(db, orgId)) }));
  });

  r.put('/orgs/:orgId/audits/schedules/:id', { schema: { tags, security: secured, params: idParams, body: auditScheduleBodySchema } }, async (req) => {
    const { orgId, id } = req.params;
    await requireHq(req, orgId);
    await loadSchedule(db, orgId, id);
    await checkScheduleBody(orgId, req.body);
    const [x] = await db.update(auditSchedules).set({ ...req.body, updatedAt: new Date() }).where(eq(auditSchedules.id, id)).returning();
    return serializeSchedule(x!, { locationCount: (await scheduleLocations(db, orgId, x!.target)).length, nextDue: nextDueOf(x!, await orgToday(db, orgId)) });
  });

  r.delete('/orgs/:orgId/audits/schedules/:id', { schema: { tags, security: secured, params: idParams, summary: 'Delete a schedule (audits it already created stay)' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireHq(req, orgId);
    await loadSchedule(db, orgId, id);
    await db.delete(auditSchedules).where(eq(auditSchedules.id, id));
    await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'audit_schedule.deleted', targetType: 'audit_schedule', targetId: id, ip: req.ip });
    return reply.code(204).send();
  });

  r.get('/orgs/:orgId/audits/schedules/:id/preview', { schema: { tags, security: secured, params: idParams, querystring: z.object({ count: z.coerce.number().int().min(1).max(12).default(3) }), summary: 'The next due dates and, per location, who the audit will be assigned to' } }, async (req) => {
    const { orgId, id } = req.params;
    await requireHq(req, orgId);
    const x = await loadSchedule(db, orgId, id);
    const today = await orgToday(db, orgId);
    const dates = scheduleDueDates({ frequency: x.frequency as AuditFrequency, interval: x.interval, anchorDate: x.anchorDate }, today, `${Number(today.slice(0, 4)) + 3}-12-31`).slice(0, req.query.count);
    const locs = await scheduleLocations(db, orgId, x.target);
    const cache = new Map<string, string[]>();
    const rows = [];
    for (const l of locs) {
      let auditor = x.auditorRule === 'field_consultant' ? await fieldConsultantFor(db, orgId, l, cache) : null;
      let source: 'field_consultant' | 'default' | 'none' = auditor ? 'field_consultant' : 'none';
      if (!auditor && x.auditorUserId) {
        const ok = cache.get(l.id) ?? (await usersWithCapability(db, orgId, l.id, AUDITS, 'edit'));
        if (ok.includes(x.auditorUserId)) { auditor = x.auditorUserId; source = 'default'; }
      }
      rows.push({ locationId: l.id, name: l.name, auditorUserId: auditor, source });
    }
    const people = await names(db, rows.map((r) => r.auditorUserId));
    return { dates, locations: rows.map((r) => ({ ...r, auditorName: r.auditorUserId ? people.get(r.auditorUserId) ?? null : null })) };
  });

  r.post('/orgs/:orgId/audits/schedules/:id/run', { schema: { tags, security: secured, params: idParams, summary: 'Create the audits now due within the lead window (also runs daily)' } }, async (req) => {
    const { orgId, id } = req.params;
    await requireHq(req, orgId);
    await loadSchedule(db, orgId, id);
    return runAuditSchedules(s, new Date(), { organizationId: orgId, scheduleId: id });
  });

  /* ------------------------------- trends ------------------------------ */

  r.get('/orgs/:orgId/audits/trends', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ months: z.coerce.number().int().min(2).max(24).default(6), templateId: z.uuid().optional(), regionId: z.uuid().optional() }), summary: 'Score trends per location, region and checklist section, and the most-failed items (HQ audits only)' },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await auditLocations(req, db, orgId);
    return auditTrends(db, orgId, allowed, req.query);
  });

  /* ---------------------------- visit planner --------------------------- */

  r.get('/orgs/:orgId/audits/visits', {
    schema: {
      tags, security: secured, params: orgParams,
      querystring: z.object({ auditorUserId: z.uuid().optional(), from: ymd.optional(), to: ymd.optional(), lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() }),
      summary: 'A field consultant’s upcoming visits per day in nearest-neighbour route order (straight-line distance from the start point)',
    },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await auditLocations(req, db, orgId);
    if (!some(allowed)) throw forbidden('Audits are not part of your access');
    const who = req.query.auditorUserId ?? req.user!.id;
    if (who !== req.user!.id && !(await canOrg(req, db, orgId, 'publish'))) throw forbidden('Only HQ can see another consultant’s visits');
    const today = await orgToday(db, orgId);
    const from = req.query.from ?? today;
    const to = req.query.to ?? new Date(Date.parse(`${from}T00:00:00Z`) + 27 * 86_400_000).toISOString().slice(0, 10);
    const start = req.query.lat !== undefined && req.query.lng !== undefined ? { lat: req.query.lat, lng: req.query.lng } : null;
    const plan = await visitPlan(db, orgId, allowed, who, from, to, start, today);
    // HQ can switch between consultants with open visits.
    let auditors: Array<{ id: string; name: string }> | null = null;
    if (await canOrg(req, db, orgId, 'publish')) {
      const ids = (await db.selectDistinct({ id: audits.auditorUserId }).from(audits).where(and(eq(audits.organizationId, orgId), inArray(audits.status, ['scheduled', 'in_progress'])))).map((x) => x.id).filter((x): x is string => !!x);
      const n = await names(db, ids);
      auditors = ids.map((id) => ({ id, name: n.get(id) ?? '' })).sort((a, b) => a.name.localeCompare(b.name));
    }
    return { ...plan, auditorUserId: who, auditors };
  });

  /* ------------------------------ training ------------------------------ */

  r.get('/orgs/:orgId/audits/courses', { schema: { tags, security: secured, params: orgParams, summary: 'Published academy courses a checklist item can recommend for retraining' } }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    if (!(await canOrg(req, db, orgId, 'publish')) && !some(await auditLocations(req, db, orgId, 'edit'))) throw forbidden('Audits (edit) needed');
    const rows = await db.select({ id: courses.id, title: courses.title }).from(courses).where(and(eq(courses.organizationId, orgId), eq(courses.status, 'published'))).orderBy(asc(courses.title));
    return { items: rows };
  });

  r.post('/orgs/:orgId/audits/actions/:id/training', { schema: { tags, security: secured, params: idParams, body: z.object({ courseId: z.uuid() }), summary: 'Assign retraining for a corrective action to the location’s team (the auditor, or Audits publish at the location)' } }, async (req) => {
    const { orgId, id } = req.params;
    const x = await loadAction(req, db, orgId, id);
    const [a] = await db.select({ auditorUserId: audits.auditorUserId }).from(audits).where(eq(audits.id, x.auditId));
    const isAuditor = a?.auditorUserId === req.user!.id && (await canAt(req, db, orgId, x.locationId, 'edit'));
    if (!isAuditor && !(await canAt(req, db, orgId, x.locationId, 'publish'))) throw forbidden('Only the auditor or HQ can assign retraining');
    if (x.status === 'verified') throw conflict('action_closed', 'This corrective action is already verified');
    if (x.trainingAssignmentId) throw conflict('training_assigned', 'Retraining is already assigned for this action');
    const [c] = await db.select().from(courses).where(and(eq(courses.id, req.body.courseId), eq(courses.organizationId, orgId)));
    if (!c) throw notFound('Course');
    if (c.status !== 'published') throw conflict('course_not_published', 'Only published courses can be assigned');
    const assignmentId = await assignRetraining(s, orgId, x.locationId, c.id, x.id, x.dueDate, req.user!.id);
    const [u] = await db.update(auditActions).set({ trainingCourseId: c.id, trainingAssignmentId: assignmentId, updatedAt: new Date() }).where(eq(auditActions.id, id)).returning();
    await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'audit_action.retraining_assigned', scopeKind: 'location', scopeId: x.locationId, targetType: 'audit_action', targetId: id, metadata: { courseId: c.id }, ip: req.ip });
    return serializeAction(s, u!, await orgToday(db, orgId), { training: await trainingFor(db, [u!]) });
  });

  /* ============================ self-checks ============================ */

  const T = ['self-checks'];

  r.get('/orgs/:orgId/self-checks/starters', { schema: { tags: T, security: secured, params: orgParams, summary: 'Starter self-check checklists for this industry (opening, closing, temperature log)' } }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    const [o] = await db.select({ industry: organizations.industry }).from(organizations).where(eq(organizations.id, orgId));
    return { items: selfCheckStartersFor(o!.industry).map((t) => ({ key: t.key, kind: t.kind, name: t.name, description: t.description, dueTime: t.dueTime, questionCount: t.sections.reduce((n, x) => n + x.questions.length, 0) })) };
  });

  r.get('/orgs/:orgId/self-checks/templates', { schema: { tags: T, security: secured, params: orgParams, summary: 'Active checklists that self-checks can use' } }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    const rows = await db.select({ id: auditTemplates.id, name: auditTemplates.name, starterKey: auditTemplates.starterKey, sections: auditTemplates.sections }).from(auditTemplates).where(and(eq(auditTemplates.organizationId, orgId), eq(auditTemplates.status, 'active'))).orderBy(asc(auditTemplates.name));
    return { items: rows.map((t) => ({ id: t.id, name: t.name, starterKey: t.starterKey, questionCount: t.sections.reduce((n, x) => n + x.questions.length, 0) })) };
  });

  r.post('/orgs/:orgId/self-checks/templates', { schema: { tags: T, security: secured, params: orgParams, body: z.object({ starterKey: z.string().min(1).max(40) }), summary: 'Create a checklist from a self-check starter (HQ: Self-checks or Audits publish organisation-wide)' } }, async (req, reply) => {
    const { orgId } = req.params;
    if (!(await selfCan(req, db, orgId, null, 'publish')) && !(await canOrg(req, db, orgId, 'publish'))) throw forbidden('Only HQ can create checklists');
    const st = SELF_CHECK_STARTERS.find((x) => x.key === req.body.starterKey);
    if (!st) throw validationError('Unknown starter checklist', { starterKey: 'Unknown' });
    const body = auditTemplateBodySchema.parse(st);
    const [t] = await db.insert(auditTemplates).values({ organizationId: orgId, ...body, starterKey: st.key, createdBy: req.user!.id, updatedBy: req.user!.id }).returning();
    return reply.code(201).send({ id: t!.id, name: t!.name, starterKey: t!.starterKey, questionCount: body.sections.reduce((n, x) => n + x.questions.length, 0) });
  });

  r.get('/orgs/:orgId/self-checks/schedules', { schema: { tags: T, security: secured, params: orgParams, summary: 'Which self-checks run where and when' } }, async (req) => {
    const { orgId } = req.params;
    const allowed = await selfLocations(req, db, orgId);
    if (!some(allowed)) throw forbidden('Self-checks are not part of your access');
    const rows = await db.select({ x: selfCheckSchedules, t: auditTemplates.name }).from(selfCheckSchedules).innerJoin(auditTemplates, eq(auditTemplates.id, selfCheckSchedules.templateId)).where(eq(selfCheckSchedules.organizationId, orgId)).orderBy(asc(selfCheckSchedules.dueTime));
    const items = [];
    for (const { x, t } of rows) {
      const locs = (await scheduleLocations(db, orgId, x.target)).filter((l) => allowed === 'all' || allowed.has(l.id));
      if (locs.length) items.push(serializeSelfSchedule(x, { templateName: t, locationCount: locs.length }));
    }
    return { items, can: { manage: some(await selfLocations(req, db, orgId, 'publish')), manageAll: await selfCan(req, db, orgId, null, 'publish') } };
  });

  const checkTemplate = async (orgId: string, templateId: string) => {
    const [t] = await db.select().from(auditTemplates).where(and(eq(auditTemplates.id, templateId), eq(auditTemplates.organizationId, orgId)));
    if (!t) throw notFound('Checklist template');
    if (t.status !== 'active') throw conflict('template_archived', 'This checklist is archived');
    return t;
  };

  r.post('/orgs/:orgId/self-checks/schedules', { schema: { tags: T, security: secured, params: orgParams, body: selfCheckScheduleBodySchema, summary: 'Set a self-check for locations (Self-checks publish at every target location)' } }, async (req, reply) => {
    const { orgId } = req.params;
    await requireSelfPublishFor(req, db, orgId, req.body.target);
    const t = await checkTemplate(orgId, req.body.templateId);
    const [x] = await db.insert(selfCheckSchedules).values({ organizationId: orgId, ...req.body, weekdays: [...new Set(req.body.weekdays)].sort(), createdBy: req.user!.id }).returning();
    await createSelfCheckRuns(s, new Date(), orgId);
    await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'self_check_schedule.created', targetType: 'self_check_schedule', targetId: x!.id, metadata: { target: x!.target }, ip: req.ip });
    return reply.code(201).send(serializeSelfSchedule(x!, { templateName: t.name, locationCount: (await scheduleLocations(db, orgId, x!.target)).length }));
  });

  r.put('/orgs/:orgId/self-checks/schedules/:id', { schema: { tags: T, security: secured, params: idParams, body: selfCheckScheduleBodySchema } }, async (req) => {
    const { orgId, id } = req.params;
    const cur = await loadSelfSchedule(db, orgId, id);
    await requireSelfPublishFor(req, db, orgId, cur.target);
    await requireSelfPublishFor(req, db, orgId, req.body.target);
    const t = await checkTemplate(orgId, req.body.templateId);
    const [x] = await db.update(selfCheckSchedules).set({ ...req.body, weekdays: [...new Set(req.body.weekdays)].sort(), updatedAt: new Date() }).where(eq(selfCheckSchedules.id, id)).returning();
    return serializeSelfSchedule(x!, { templateName: t.name, locationCount: (await scheduleLocations(db, orgId, x!.target)).length });
  });

  r.delete('/orgs/:orgId/self-checks/schedules/:id', { schema: { tags: T, security: secured, params: idParams } }, async (req, reply) => {
    const { orgId, id } = req.params;
    const cur = await loadSelfSchedule(db, orgId, id);
    await requireSelfPublishFor(req, db, orgId, cur.target);
    await db.delete(selfCheckSchedules).where(eq(selfCheckSchedules.id, id));
    return reply.code(204).send();
  });

  r.get('/orgs/:orgId/self-checks/today', { schema: { tags: T, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }), summary: 'Today’s self-checks at the locations in scope (created on demand), with yesterday’s unfinished ones' } }, async (req) => {
    const { orgId } = req.params;
    const allowed = await selfLocations(req, db, orgId);
    if (!some(allowed)) throw forbidden('Self-checks are not part of your access');
    await createSelfCheckRuns(s, new Date(), orgId);
    const d = await selfCheckDashboard(db, orgId, allowed, 1);
    const items = d.today_runs.filter((x) => !req.query.locationId || x.locationId === req.query.locationId);
    const canFill = new Map<string, boolean>();
    for (const x of items) if (!canFill.has(x.locationId)) canFill.set(x.locationId, await selfCan(req, db, orgId, x.locationId, 'edit'));
    return { today: d.today, items: items.map((x) => ({ ...x, canFill: canFill.get(x.locationId) ?? false })) };
  });

  r.get('/orgs/:orgId/self-checks/dashboard', { schema: { tags: T, security: secured, params: orgParams, querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }), summary: 'Self-check completion and pass rates per location, missed checks and failures (kept apart from HQ audits)' } }, async (req) => {
    const { orgId } = req.params;
    const allowed = await selfLocations(req, db, orgId);
    if (!some(allowed)) throw forbidden('Self-checks are not part of your access');
    return { ...(await selfCheckDashboard(db, orgId, allowed, req.query.days)), can: { export: some(await selfLocations(req, db, orgId, 'export')), manage: some(await selfLocations(req, db, orgId, 'publish')) } };
  });

  r.get('/orgs/:orgId/self-checks/export', { schema: { tags: T, security: secured, params: orgParams, querystring: z.object({ from: ymd.optional(), to: ymd.optional() }), summary: 'Self-check results as CSV (Self-checks export)' } }, async (req, reply) => {
    const { orgId } = req.params;
    const allowed = await selfLocations(req, db, orgId, 'export');
    if (!some(allowed)) throw forbidden('Exporting self-checks needs Self-checks (export)');
    const conds = [eq(selfCheckRuns.organizationId, orgId)];
    if (req.query.from) conds.push(gte(selfCheckRuns.date, req.query.from));
    if (req.query.to) conds.push(lte(selfCheckRuns.date, req.query.to));
    const rows = (await db.select({ r: selfCheckRuns, loc: locations.name, sch: selfCheckSchedules.name }).from(selfCheckRuns).innerJoin(locations, eq(locations.id, selfCheckRuns.locationId)).innerJoin(selfCheckSchedules, eq(selfCheckSchedules.id, selfCheckRuns.scheduleId))
      .where(and(...conds)).orderBy(desc(selfCheckRuns.date))).filter((x) => allowed === 'all' || allowed.has(x.r.locationId));
    const people = await names(db, rows.map((x) => x.r.completedBy));
    const csv = toCsv(['date', 'location', 'self_check', 'status', 'score_pct', 'passed', 'critical_failed', 'failed_items', 'completed_by', 'completed_at'],
      rows.map(({ r: x, loc, sch }) => [x.date, loc, sch, x.status, x.scoreTenths === null ? '' : (x.scoreTenths / 10).toFixed(1), x.passed === null ? '' : x.passed ? 'yes' : 'no', x.criticalFailed ? 'yes' : 'no', x.failedItems.map((f) => f.text).join('; '), x.completedBy ? people.get(x.completedBy) ?? '' : '', x.completedAt?.toISOString() ?? '']));
    return reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="self-checks.csv"').send(csv);
  });

  r.post('/orgs/:orgId/self-checks/jobs/run', { schema: { tags: T, security: secured, params: orgParams, summary: 'Create today’s self-checks, send due reminders and mark missed ones now (also runs hourly)' } }, async (req) => {
    const { orgId } = req.params;
    if (!(await selfCan(req, db, orgId, null, 'publish'))) throw forbidden('Only HQ can run self-check jobs');
    return runSelfCheckJobs(s, new Date(), orgId);
  });

  r.get('/orgs/:orgId/self-checks/runs/:id', { schema: { tags: T, security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    const run = await loadRun(req, db, orgId, id);
    const [loc] = await db.select({ name: locations.name, timeZone: locations.timeZone }).from(locations).where(eq(locations.id, run.locationId));
    const [sch] = await db.select({ name: selfCheckSchedules.name, kind: selfCheckSchedules.kind }).from(selfCheckSchedules).where(eq(selfCheckSchedules.id, run.scheduleId));
    const people = await names(db, [run.completedBy]);
    return { ...serializeRun(run, { locationName: loc?.name, scheduleName: sch?.name, kind: sch?.kind, completedByName: run.completedBy ? people.get(run.completedBy) : null, full: true }), timeZone: loc?.timeZone ?? 'UTC', canFill: run.status !== 'completed' && (await selfCan(req, db, orgId, run.locationId, 'edit')) };
  });

  r.put('/orgs/:orgId/self-checks/runs/:id/answers', { schema: { tags: T, security: secured, params: idParams, body: z.object({ answers: z.record(z.string().max(40), auditAnswerSchema) }), summary: 'Autosave answers (merged per question)' } }, async (req) => {
    const { orgId, id } = req.params;
    const run = await loadRun(req, db, orgId, id);
    if (!(await selfCan(req, db, orgId, run.locationId, 'edit'))) throw forbidden('Filling in self-checks needs Self-checks (edit) at this location');
    const u = await saveRunAnswers(db, run, req.body.answers);
    return { id: u.id, status: u.status, savedAt: u.updatedAt.toISOString() };
  });

  r.post('/orgs/:orgId/self-checks/runs/:id/photos', { bodyLimit: 15 * 1024 * 1024, schema: { tags: T, security: secured, params: idParams, body: uploadSchema } }, async (req, reply) => {
    const { orgId, id } = req.params;
    const run = await loadRun(req, db, orgId, id);
    if (!(await selfCan(req, db, orgId, run.locationId, 'edit'))) throw forbidden('Filling in self-checks needs Self-checks (edit) at this location');
    const f = await storeFile(s, db, { organizationId: orgId, locationId: run.locationId, purpose: 'audit_photo', upload: req.body, uploadedBy: req.user!.id });
    return reply.code(201).send(fileView(s, f));
  });

  r.post('/orgs/:orgId/self-checks/runs/:id/complete', { schema: { tags: T, security: secured, params: idParams, body: z.object({ answers: z.record(z.string().max(40), auditAnswerSchema).optional(), note: z.string().trim().max(2000).optional() }), summary: 'Finish a self-check: scores it; a failed critical item alerts the location’s managers' } }, async (req) => {
    const { orgId, id } = req.params;
    let run = await loadRun(req, db, orgId, id);
    if (!(await selfCan(req, db, orgId, run.locationId, 'edit'))) throw forbidden('Filling in self-checks needs Self-checks (edit) at this location');
    if (req.body.answers && Object.keys(req.body.answers).length) run = await saveRunAnswers(db, run, req.body.answers);
    const u = await completeRun(s, run, req.user!.id, req.body.note ?? null);
    await auditLog(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'self_check.completed', scopeKind: 'location', scopeId: run.locationId, targetType: 'self_check_run', targetId: id, metadata: { passed: u.passed, criticalFailed: u.criticalFailed }, ip: req.ip });
    return serializeRun(u, { full: true });
  });

  r.get('/orgs/:orgId/self-checks/runs', {
    schema: { tags: T, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), status: z.enum(['due', 'in_progress', 'completed', 'missed', 'failed', 'all']).default('all'), from: ymd.optional(), to: ymd.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await selfLocations(req, db, orgId);
    if (!some(allowed)) throw forbidden('Self-checks are not part of your access');
    const conds = [eq(selfCheckRuns.organizationId, orgId)];
    if (req.query.locationId) conds.push(eq(selfCheckRuns.locationId, req.query.locationId));
    if (req.query.status === 'failed') conds.push(eq(selfCheckRuns.status, 'completed'), eq(selfCheckRuns.passed, false));
    else if (req.query.status !== 'all') conds.push(eq(selfCheckRuns.status, req.query.status));
    if (req.query.from) conds.push(gte(selfCheckRuns.date, req.query.from));
    if (req.query.to) conds.push(lte(selfCheckRuns.date, req.query.to));
    if (allowed !== 'all') conds.push(inArray(selfCheckRuns.locationId, [...allowed]));
    const rows = await db.select({ r: selfCheckRuns, loc: locations.name, sch: selfCheckSchedules.name, kind: selfCheckSchedules.kind }).from(selfCheckRuns).innerJoin(locations, eq(locations.id, selfCheckRuns.locationId)).innerJoin(selfCheckSchedules, eq(selfCheckSchedules.id, selfCheckRuns.scheduleId))
      .where(and(...conds)).orderBy(desc(selfCheckRuns.date), sql`${selfCheckRuns.dueAt} asc`).limit(req.query.limit);
    const people = await names(db, rows.map((x) => x.r.completedBy));
    return { items: rows.map(({ r: x, loc, sch, kind }) => serializeRun(x, { locationName: loc, scheduleName: sch, kind, completedByName: x.completedBy ? people.get(x.completedBy) : null })) };
  });
};

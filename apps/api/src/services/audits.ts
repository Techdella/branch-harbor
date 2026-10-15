/**
 * Field visits and audits (Operations → Audits, capability `operations.audits`).
 *
 * - HQ (publish) manages checklist templates and schedules audits for a location with a due date and an auditor.
 * - The auditor (edit at the location, and assigned) conducts the audit on the web or the phone: answers autosave per
 *   question (offline edits merge per question), photos upload as private files.
 * - Completing scores the audit (percentage, automatic fail on a failed critical item), raises one corrective action
 *   per failed item for the location, and when it failed schedules the re-audit automatically.
 * - The location (edit at the location) completes corrective actions with an evidence photo; the auditor (or anyone
 *   with publish at the location) verifies or reopens them.
 * - Pre-opening audits are tied to a franchise onboarding project: the opening can't be requested until one passes.
 *
 * Everything is scoped: lists only hold the locations where the viewer has the module, a record outside it is 404.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { scoreAudit, type AccessAction, type AuditAnswers, type AuditSection } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { auditActions, auditTemplates, audits, franchiseProjects, locations, organizations, users, type AuditChecklist } from '../db/schema/index.ts';
import { hasCapabilityInScope, type ScopeChain } from '../domain/scope.ts';
import { addDays, localDateParts } from '../lib/tz.ts';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.ts';
import { capabilityLocations, hasCapability, loadOrgAssignments, requireMember } from './authz.ts';
import { filesById, signedFileUrl } from './ops-files.ts';

export const MODULE = 'operations.audits';
export type Audit = typeof audits.$inferSelect;
export type AuditAction = typeof auditActions.$inferSelect;
export type AuditTemplate = typeof auditTemplates.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/* ------------------------------------------------------------------ */
/* Access                                                              */
/* ------------------------------------------------------------------ */

const orgTarget = (organizationId: string) => ({ organizationId, kind: 'organization' as const, id: organizationId });
const locTarget = (organizationId: string, locationId: string) => ({ organizationId, kind: 'location' as const, id: locationId });

export const canOrg = (req: FastifyRequest, db: Exec, organizationId: string, action: AccessAction) => hasCapability(req, db, MODULE, action, orgTarget(organizationId));
export const canAt = (req: FastifyRequest, db: Exec, organizationId: string, locationId: string, action: AccessAction) => hasCapability(req, db, MODULE, action, locTarget(organizationId, locationId));

export async function requireAt(req: FastifyRequest, db: Exec, organizationId: string, locationId: string, action: AccessAction, message?: string) {
  if (!(await canAt(req, db, organizationId, locationId, action))) throw forbidden(message ?? `You don't have ${action} access to audits at this location`);
}

/** Locations whose audits the viewer may see (or act on). */
export const auditLocations = (req: FastifyRequest, db: Exec, organizationId: string, action: AccessAction = 'view') => capabilityLocations(req, db, organizationId, MODULE, action);
export const inScope = (allowed: 'all' | Set<string>, locationId: string) => allowed === 'all' || allowed.has(locationId);

/** Loads an audit the viewer can see (404 otherwise: no enumeration across franchisees). */
export async function loadAudit(req: FastifyRequest, db: Exec, organizationId: string, id: string): Promise<Audit> {
  await requireMember(req, db, organizationId);
  const [a] = await db.select().from(audits).where(and(eq(audits.id, id), eq(audits.organizationId, organizationId)));
  if (!a || !(await canAt(req, db, organizationId, a.locationId, 'view'))) throw notFound('Audit');
  return a;
}

/** The assigned auditor (with edit at the location), or anyone with publish there, may conduct the audit. */
export async function canConduct(req: FastifyRequest, db: Exec, a: Audit): Promise<boolean> {
  if (await canAt(req, db, a.organizationId, a.locationId, 'publish')) return true;
  return a.auditorUserId === req.user?.id && (await canAt(req, db, a.organizationId, a.locationId, 'edit'));
}

/** People who hold a capability at a location (or organisation-wide when `locationId` is null). */
export async function usersWithCapability(db: Exec, organizationId: string, locationId: string | null, module: string, action: AccessAction): Promise<string[]> {
  let chain: ScopeChain = { organizationId, kind: 'organization' };
  if (locationId) {
    const [l] = await db.select({ id: locations.id, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId }).from(locations).where(eq(locations.id, locationId));
    if (l) chain = { organizationId, kind: 'location', locationId: l.id, regionId: l.regionId, ownerGroupId: l.ownerGroupId };
  }
  const byUser = await loadOrgAssignments(db, organizationId);
  return [...byUser.entries()].filter(([, a]) => hasCapabilityInScope(a, module, action, chain)).map(([id]) => id);
}

export async function orgToday(db: Exec, organizationId: string, now = new Date()) {
  const [o] = await db.select({ tz: organizations.defaultTimeZone }).from(organizations).where(eq(organizations.id, organizationId));
  return localDateParts(now, o?.tz ?? 'UTC').date;
}

async function locationToday(db: Exec, locationId: string, now = new Date()) {
  const [l] = await db.select({ tz: locations.timeZone }).from(locations).where(eq(locations.id, locationId));
  return localDateParts(now, l?.tz ?? 'UTC').date;
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export function serializeTemplate(t: AuditTemplate) {
  const questions = t.sections.reduce((n, s) => n + s.questions.length, 0);
  return {
    id: t.id, name: t.name, description: t.description, starterKey: t.starterKey, sections: t.sections, passThreshold: t.passThreshold, reauditDays: t.reauditDays,
    correctiveDays: t.correctiveDays, status: t.status, version: t.version, questionCount: questions, criticalCount: t.sections.reduce((n, s) => n + s.questions.filter((q) => q.critical).length, 0),
    createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(),
  };
}

export async function getTemplate(db: Exec, organizationId: string, id: string) {
  const [t] = await db.select().from(auditTemplates).where(and(eq(auditTemplates.id, id), eq(auditTemplates.organizationId, organizationId)));
  if (!t) throw notFound('Checklist template');
  return t;
}

export const checklistOf = (t: AuditTemplate): AuditChecklist => ({ name: t.name, sections: t.sections, passThreshold: t.passThreshold, reauditDays: t.reauditDays, correctiveDays: t.correctiveDays, version: t.version });

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

export interface ScheduleInput { locationId: string; templateId: string; dueDate: string; auditorUserId: string | null; purpose: 'routine' | 'pre_opening' | 'reaudit'; projectId?: string | null; parentAuditId?: string | null }

/** Schedule an audit (HQ / publish at the location). The auditor must hold edit on audits at that location. */
export async function scheduleAudit(db: Exec, organizationId: string, input: ScheduleInput, actorUserId: string | null): Promise<Audit> {
  const t = await getTemplate(db, organizationId, input.templateId);
  if (t.status !== 'active') throw conflict('template_archived', 'This checklist is archived');
  const [loc] = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.id, input.locationId), eq(locations.organizationId, organizationId)));
  if (!loc) throw notFound('Location');
  if (input.auditorUserId) {
    const allowed = await usersWithCapability(db, organizationId, input.locationId, MODULE, 'edit');
    if (!allowed.includes(input.auditorUserId)) throw new AppError(400, 'validation_failed', 'This person cannot conduct audits at this location', { auditorUserId: 'Needs Audits (edit) at this location' });
  }
  const [a] = await db.insert(audits).values({
    organizationId, locationId: input.locationId, templateId: t.id, checklist: checklistOf(t), purpose: input.purpose, dueDate: input.dueDate, auditorUserId: input.auditorUserId,
    scheduledBy: actorUserId, projectId: input.projectId ?? null, parentAuditId: input.parentAuditId ?? null,
  }).returning();
  return a!;
}

/* ------------------------------------------------------------------ */
/* Conducting                                                          */
/* ------------------------------------------------------------------ */

const questionIds = (sections: AuditSection[]) => new Set(sections.flatMap((s) => s.questions.map((q) => q.id)));

/**
 * Autosave: merges the answers sent (by question) into the audit. Saves from an offline phone arrive later and only
 * overwrite the questions they carry, so two devices never wipe each other's work.
 */
export async function saveAnswers(db: Exec, a: Audit, answers: AuditAnswers, now = new Date()) {
  if (a.status === 'completed' || a.status === 'cancelled') throw conflict('audit_closed', 'This audit is already closed');
  const ids = questionIds(a.checklist.sections);
  const unknown = Object.keys(answers).filter((k) => !ids.has(k));
  if (unknown.length) throw new AppError(400, 'validation_failed', 'Unknown question', { answers: `Not in this checklist: ${unknown.slice(0, 5).join(', ')}` });
  const photoIds = Object.values(answers).flatMap((x) => x.photoIds ?? []);
  if (photoIds.length) {
    const files = await filesById(db, a.organizationId, photoIds);
    const bad = photoIds.filter((id) => { const f = files.get(id); return !f || f.purpose !== 'audit_photo' || f.locationId !== a.locationId; });
    if (bad.length) throw new AppError(400, 'validation_failed', 'A photo does not belong to this audit', { photoIds: 'Upload photos to this audit first' });
  }
  const [u] = await db.update(audits).set({
    answers: sql`${audits.answers} || ${JSON.stringify(answers)}::jsonb`,
    revision: sql`${audits.revision} + 1`,
    status: 'in_progress',
    startedAt: a.startedAt ?? now,
    updatedAt: now,
  }).where(and(eq(audits.id, a.id), inArray(audits.status, ['scheduled', 'in_progress']))).returning();
  if (!u) throw conflict('audit_closed', 'This audit is already closed');
  return u;
}

/** Completes an audit: scores it, raises corrective actions and, when it failed, schedules the re-audit. */
export async function completeAudit(s: Services, a: Audit, actorUserId: string, summary: string | null, now = new Date()) {
  if (a.status === 'completed') throw conflict('audit_closed', 'This audit is already completed');
  if (a.status === 'cancelled') throw conflict('audit_closed', 'This audit was cancelled');
  const score = scoreAudit(a.checklist, a.answers);
  if (score.unanswered.length) {
    throw new AppError(409, 'audit_incomplete', `${score.unanswered.length} questions still need an answer (or n/a)`, undefined, { unanswered: score.unanswered });
  }
  const today = await locationToday(s.db, a.locationId, now);
  const reauditDue = score.passed ? null : addDays(today, a.checklist.reauditDays);
  const qText = new Map(a.checklist.sections.flatMap((sec) => sec.questions.map((q) => [q.id, { text: q.text, section: sec.title }] as const)));
  return s.db.transaction(async (tx) => {
    const [done] = await tx.update(audits).set({
      status: 'completed', completedAt: now, startedAt: a.startedAt ?? now, scoreTenths: score.scorePct === null ? null : Math.round(score.scorePct * 10), passed: score.passed,
      criticalFailed: score.criticalFailed, summary, reauditDueDate: reauditDue, updatedAt: now,
    }).where(and(eq(audits.id, a.id), inArray(audits.status, ['scheduled', 'in_progress']))).returning();
    if (!done) throw conflict('audit_closed', 'This audit is already closed');
    if (score.failedItems.length) {
      await tx.insert(auditActions).values(score.failedItems.map((f) => ({
        organizationId: a.organizationId, auditId: a.id, locationId: a.locationId, questionId: f.questionId, sectionTitle: qText.get(f.questionId)?.section ?? '',
        title: qText.get(f.questionId)?.text ?? f.questionId, reason: f.reason ?? 'no', critical: f.critical, auditorNote: a.answers[f.questionId]?.note ?? null,
        // Critical items are fixed faster: half the usual time (at least a day).
        dueDate: addDays(today, f.critical ? Math.max(1, Math.ceil(a.checklist.correctiveDays / 2)) : a.checklist.correctiveDays),
      }))).onConflictDoNothing();
    }
    let reaudit: Audit | null = null;
    if (!score.passed && a.templateId) {
      const [t] = await tx.select().from(auditTemplates).where(eq(auditTemplates.id, a.templateId));
      const [r] = await tx.insert(audits).values({
        organizationId: a.organizationId, locationId: a.locationId, templateId: a.templateId, checklist: t && t.status === 'active' ? checklistOf(t) : a.checklist, purpose: a.purpose === 'pre_opening' ? 'pre_opening' : 'reaudit',
        dueDate: reauditDue!, auditorUserId: a.auditorUserId, scheduledBy: actorUserId, parentAuditId: a.id, projectId: a.projectId,
      }).returning();
      reaudit = r!;
    }
    return { audit: done, score, reaudit };
  });
}

/* ------------------------------------------------------------------ */
/* Corrective actions                                                  */
/* ------------------------------------------------------------------ */

export async function loadAction(req: FastifyRequest, db: Exec, organizationId: string, id: string) {
  await requireMember(req, db, organizationId);
  const [x] = await db.select().from(auditActions).where(and(eq(auditActions.id, id), eq(auditActions.organizationId, organizationId)));
  if (!x || !(await canAt(req, db, organizationId, x.locationId, 'view'))) throw notFound('Corrective action');
  return x;
}

export function actionOverdue(x: Pick<AuditAction, 'status' | 'dueDate'>, today: string) {
  return x.status === 'open' && x.dueDate < today;
}

export interface ActionTraining { courseId: string; courseTitle: string | null; assigned: boolean; enrolled: number; completed: number }
export function serializeAction(s: Services, x: AuditAction, today: string, extra: { locationName?: string | null; names?: Map<string, string>; training?: Map<string, ActionTraining> } = {}) {
  return {
    id: x.id, auditId: x.auditId, locationId: x.locationId, locationName: extra.locationName ?? null, questionId: x.questionId, sectionTitle: x.sectionTitle, title: x.title, reason: x.reason,
    critical: x.critical, auditorNote: x.auditorNote, dueDate: x.dueDate, status: x.status, overdue: actionOverdue(x, today), responseNote: x.responseNote,
    evidence: x.evidenceFileIds.map((id) => ({ id, url: signedFileUrl(s, id) })), submittedBy: x.submittedBy ? { id: x.submittedBy, name: extra.names?.get(x.submittedBy) ?? null } : null,
    submittedAt: iso(x.submittedAt), verifiedBy: x.verifiedBy ? { id: x.verifiedBy, name: extra.names?.get(x.verifiedBy) ?? null } : null, verifiedAt: iso(x.verifiedAt),
    reviewNote: x.reviewNote, reopenedCount: x.reopenedCount,
    // Retraining loop (audits phase 2): the recommended course and the location team's progress on it.
    training: extra.training?.get(x.id) ?? (x.trainingCourseId ? { courseId: x.trainingCourseId, courseTitle: null, assigned: !!x.trainingAssignmentId, enrolled: 0, completed: 0 } : null),
  };
}

/* ------------------------------------------------------------------ */
/* Reports and serialisers                                             */
/* ------------------------------------------------------------------ */

export async function names(db: Exec, ids: Array<string | null | undefined>) {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = uniq.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uniq)) : [];
  return new Map(rows.map((r) => [r.id, r.name]));
}

export function serializeAudit(a: Audit, today: string, extra: { locationName?: string | null; auditorName?: string | null; templateName?: string | null; openActions?: number; overdueActions?: number } = {}) {
  return {
    id: a.id, locationId: a.locationId, locationName: extra.locationName ?? null, templateId: a.templateId, name: a.checklist.name, purpose: a.purpose, status: a.status,
    dueDate: a.dueDate, overdue: (a.status === 'scheduled' || a.status === 'in_progress') && a.dueDate < today,
    auditor: a.auditorUserId ? { id: a.auditorUserId, name: extra.auditorName ?? null } : null, parentAuditId: a.parentAuditId, projectId: a.projectId,
    startedAt: iso(a.startedAt), completedAt: iso(a.completedAt), scorePct: a.scoreTenths === null ? null : a.scoreTenths / 10, passed: a.passed, criticalFailed: a.criticalFailed,
    passThreshold: a.checklist.passThreshold, reauditDueDate: a.reauditDueDate, revision: a.revision,
    openActions: extra.openActions ?? 0, overdueActions: extra.overdueActions ?? 0, updatedAt: a.updatedAt.toISOString(),
  };
}

/**
 * The full report: checklist, answers with photo links, score breakdown and corrective actions. While an audit is
 * being conducted only the auditor and HQ (publish) see its answers; the location sees the finished report.
 */
export async function auditDetail(s: Services, req: FastifyRequest, a: Audit) {
  const today = await locationToday(s.db, a.locationId);
  const [loc] = await s.db.select({ name: locations.name, timeZone: locations.timeZone }).from(locations).where(eq(locations.id, a.locationId));
  const actions = await s.db.select().from(auditActions).where(eq(auditActions.auditId, a.id)).orderBy(asc(auditActions.dueDate));
  const people = await names(s.db, [a.auditorUserId, a.scheduledBy, ...actions.flatMap((x) => [x.submittedBy, x.verifiedBy])]);
  const conduct = await canConduct(req, s.db, a);
  const training = await (await import('./audit-programmes.ts')).trainingFor(s.db, actions);
  const showAnswers = a.status === 'completed' || conduct;
  const answers = showAnswers ? a.answers : {};
  const photoIds = Object.values(answers).flatMap((x) => x.photoIds ?? []);
  const files = await filesById(s.db, a.organizationId, photoIds);
  const score = showAnswers ? scoreAudit(a.checklist, a.answers) : null;
  const [parent] = a.parentAuditId ? await s.db.select({ id: audits.id, scoreTenths: audits.scoreTenths, completedAt: audits.completedAt }).from(audits).where(eq(audits.id, a.parentAuditId)) : [];
  const [next] = await s.db.select({ id: audits.id, dueDate: audits.dueDate, status: audits.status }).from(audits).where(eq(audits.parentAuditId, a.id)).limit(1);
  return {
    ...serializeAudit(a, today, { locationName: loc?.name ?? null, auditorName: a.auditorUserId ? people.get(a.auditorUserId) ?? null : null, openActions: actions.filter((x) => x.status !== 'verified').length, overdueActions: actions.filter((x) => actionOverdue(x, today)).length }),
    timeZone: loc?.timeZone ?? 'UTC', summary: a.summary, checklist: a.checklist,
    answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { ...v, photos: (v.photoIds ?? []).map((id) => ({ id, url: signedFileUrl(s, id), name: files.get(id)?.name ?? null })) }])),
    breakdown: score ? { sections: score.sections, failed: score.failedItems.map((f) => ({ questionId: f.questionId, reason: f.reason, critical: f.critical })), unanswered: score.unanswered, liveScorePct: score.scorePct, livePassed: score.passed } : null,
    actions: actions.map((x) => serializeAction(s, x, today, { locationName: loc?.name, names: people, training })),
    scheduleId: a.scheduleId,
    parent: parent ? { id: parent.id, scorePct: parent.scoreTenths === null ? null : parent.scoreTenths / 10, completedAt: iso(parent.completedAt) } : null,
    reaudit: next ?? null,
    permissions: {
      conduct: conduct && (a.status === 'scheduled' || a.status === 'in_progress'),
      manage: await canAt(req, s.db, a.organizationId, a.locationId, 'publish'),
      respond: await canAt(req, s.db, a.organizationId, a.locationId, 'edit'),
      verify: a.auditorUserId === req.user?.id || (await canAt(req, s.db, a.organizationId, a.locationId, 'publish')),
    },
  };
}

/** Scores by location over time, overdue corrective actions and overdue audits, for the locations in scope. */
export async function auditDashboard(s: Services, organizationId: string, allowed: 'all' | Set<string>, months = 6, now = new Date()) {
  const today = await orgToday(s.db, organizationId, now);
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const locs = (await s.db.select({ id: locations.id, name: locations.name, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId, status: locations.status }).from(locations)
    .where(and(eq(locations.organizationId, organizationId), isNull(locations.archivedAt)))).filter((l) => inScope(allowed, l.id));
  const ids = locs.map((l) => l.id);
  if (!ids.length) return { today, months: [] as string[], locations: [], network: [], overdueActions: [], overdueAudits: [], upcoming: [], totals: { completed: 0, passed: 0, openActions: 0, overdueActions: 0, overdueAudits: 0, averageScorePct: null as number | null } };
  const done = await s.db.select({ id: audits.id, locationId: audits.locationId, completedAt: audits.completedAt, scoreTenths: audits.scoreTenths, passed: audits.passed, name: sql<string>`${audits.checklist}->>'name'` })
    .from(audits).where(and(eq(audits.organizationId, organizationId), inArray(audits.locationId, ids), eq(audits.status, 'completed'), gte(audits.completedAt, from))).orderBy(asc(audits.completedAt));
  const open = await s.db.select().from(audits).where(and(eq(audits.organizationId, organizationId), inArray(audits.locationId, ids), inArray(audits.status, ['scheduled', 'in_progress']))).orderBy(asc(audits.dueDate));
  const acts = await s.db.select().from(auditActions).where(and(eq(auditActions.organizationId, organizationId), inArray(auditActions.locationId, ids), inArray(auditActions.status, ['open', 'submitted']))).orderBy(asc(auditActions.dueDate));
  const people = await names(s.db, open.map((a) => a.auditorUserId));
  const monthKeys = Array.from({ length: months }, (_, i) => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
  const locName = new Map(locs.map((l) => [l.id, l.name]));
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const rows = locs.map((l) => {
    const mine = done.filter((d) => d.locationId === l.id);
    const last = mine[mine.length - 1];
    const byMonth = monthKeys.map((m) => avg(mine.filter((d) => d.completedAt!.toISOString().slice(0, 7) === m && d.scoreTenths !== null).map((d) => d.scoreTenths! / 10)));
    return {
      locationId: l.id, name: l.name, regionId: l.regionId, ownerGroupId: l.ownerGroupId,
      latest: last ? { auditId: last.id, scorePct: last.scoreTenths === null ? null : last.scoreTenths / 10, passed: last.passed, completedAt: iso(last.completedAt), name: last.name } : null,
      byMonth, audits: mine.length,
      openActions: acts.filter((x) => x.locationId === l.id).length, overdueActions: acts.filter((x) => x.locationId === l.id && actionOverdue(x, today)).length,
      nextDue: open.find((a) => a.locationId === l.id)?.dueDate ?? null,
    };
  });
  const network = monthKeys.map((m) => ({ month: m, averageScorePct: avg(done.filter((d) => d.completedAt!.toISOString().slice(0, 7) === m && d.scoreTenths !== null).map((d) => d.scoreTenths! / 10)), audits: done.filter((d) => d.completedAt!.toISOString().slice(0, 7) === m).length }));
  return {
    today, months: monthKeys, locations: rows, network,
    overdueActions: acts.filter((x) => actionOverdue(x, today)).map((x) => serializeAction(s, x, today, { locationName: locName.get(x.locationId) })),
    overdueAudits: open.filter((a) => a.dueDate < today).map((a) => serializeAudit(a, today, { locationName: locName.get(a.locationId), auditorName: a.auditorUserId ? people.get(a.auditorUserId) : null })),
    upcoming: open.filter((a) => a.dueDate >= today).slice(0, 20).map((a) => serializeAudit(a, today, { locationName: locName.get(a.locationId), auditorName: a.auditorUserId ? people.get(a.auditorUserId) : null })),
    totals: {
      completed: done.length, passed: done.filter((d) => d.passed).length, openActions: acts.length, overdueActions: acts.filter((x) => actionOverdue(x, today)).length,
      overdueAudits: open.filter((a) => a.dueDate < today).length, averageScorePct: avg(done.filter((d) => d.scoreTenths !== null).map((d) => d.scoreTenths! / 10)),
    },
  };
}

/** Latest completed audit score per location (league table). */
export async function latestScores(db: Exec, organizationId: string, locationIds: string[], before = new Date()) {
  if (!locationIds.length) return new Map<string, { scorePct: number | null; passed: boolean | null; completedAt: Date }>();
  const rows = await db.select({ locationId: audits.locationId, scoreTenths: audits.scoreTenths, passed: audits.passed, completedAt: audits.completedAt }).from(audits)
    .where(and(eq(audits.organizationId, organizationId), inArray(audits.locationId, locationIds), eq(audits.status, 'completed'), lte(audits.completedAt, before))).orderBy(desc(audits.completedAt));
  const out = new Map<string, { scorePct: number | null; passed: boolean | null; completedAt: Date }>();
  for (const r of rows) if (!out.has(r.locationId)) out.set(r.locationId, { scorePct: r.scoreTenths === null ? null : r.scoreTenths / 10, passed: r.passed, completedAt: r.completedAt! });
  return out;
}

/* ------------------------------------------------------------------ */
/* Pre-opening checks (new-location flow)                              */
/* ------------------------------------------------------------------ */

/** The pre-opening audit state of an onboarding project (null when the project has no pre-opening checklist). */
export async function preOpeningState(db: Exec, proj: { id: string; preOpeningTemplateId: string | null }) {
  if (!proj.preOpeningTemplateId) return null;
  const rows = await db.select().from(audits).where(and(eq(audits.projectId, proj.id), sql`${audits.status} <> 'cancelled'`)).orderBy(desc(audits.createdAt));
  const passed = rows.find((a) => a.status === 'completed' && a.passed);
  const latest = rows[0];
  const [t] = await db.select({ name: auditTemplates.name }).from(auditTemplates).where(eq(auditTemplates.id, proj.preOpeningTemplateId));
  return {
    templateId: proj.preOpeningTemplateId, templateName: t?.name ?? null, passed: !!passed,
    passedAuditId: passed?.id ?? null,
    latest: latest ? { id: latest.id, status: latest.status, dueDate: latest.dueDate, scorePct: latest.scoreTenths === null ? null : latest.scoreTenths / 10, passed: latest.passed } : null,
  };
}

/** Go-live guard: a project with a pre-opening checklist needs a passed audit. */
export async function assertPreOpeningPassed(db: Exec, proj: { id: string; preOpeningTemplateId: string | null }) {
  const st = await preOpeningState(db, proj);
  if (st && !st.passed) {
    throw new AppError(409, 'pre_opening_audit_required', 'The pre-opening audit has not passed yet', undefined, { latest: st.latest, templateId: st.templateId });
  }
}

export async function projectForLocation(db: Exec, organizationId: string, projectId: string) {
  const [p] = await db.select().from(franchiseProjects).where(and(eq(franchiseProjects.id, projectId), eq(franchiseProjects.organizationId, organizationId)));
  if (!p) throw notFound('Project');
  return p;
}

/* ------------------------------------------------------------------ */
/* Reminders                                                           */
/* ------------------------------------------------------------------ */

/**
 * Daily housekeeping: remind the location about overdue corrective actions and the auditor about overdue audits
 * (each once). Runs from the API's scheduler and `POST /audits/jobs/run`.
 */
export async function runAuditJobs(s: Services, now = new Date(), organizationId?: string) {
  const inOrg = <T>(col: T) => (organizationId ? eq(col as never, organizationId) : undefined);
  const day = now.toISOString().slice(0, 10);
  let actionReminders = 0;
  let auditReminders = 0;
  const overdueActs = await s.db.select({ x: auditActions, loc: locations.name }).from(auditActions).innerJoin(locations, eq(locations.id, auditActions.locationId))
    .where(and(eq(auditActions.status, 'open'), lt(auditActions.dueDate, day), isNull(auditActions.remindedAt), inOrg(auditActions.organizationId)));
  for (const { x, loc } of overdueActs) {
    const ids = await usersWithCapability(s.db, x.organizationId, x.locationId, MODULE, 'edit');
    const emails = ids.length ? await s.db.select({ email: users.email }).from(users).where(inArray(users.id, ids)) : [];
    for (const r of emails) {
      await s.jobs.enqueue('email.send', { to: r.email, subject: `Overdue corrective action at ${loc}: ${x.title}`, text: `A corrective action from an audit at ${loc} was due on ${x.dueDate}.\n\n${x.title}\n\nAdd a photo of the fix and mark it done: ${s.cfg.APP_URL}/audits/${x.auditId}`, tag: 'audit_action_overdue' });
    }
    await s.db.update(auditActions).set({ remindedAt: now }).where(eq(auditActions.id, x.id));
    actionReminders++;
  }
  const overdueAudits = await s.db.select({ a: audits, loc: locations.name }).from(audits).innerJoin(locations, eq(locations.id, audits.locationId))
    .where(and(inArray(audits.status, ['scheduled', 'in_progress']), lt(audits.dueDate, day), isNull(audits.remindedAt), inOrg(audits.organizationId)));
  for (const { a, loc } of overdueAudits) {
    if (a.auditorUserId) {
      const [u] = await s.db.select({ email: users.email }).from(users).where(eq(users.id, a.auditorUserId));
      if (u) await s.jobs.enqueue('email.send', { to: u.email, subject: `Overdue audit: ${a.checklist.name} at ${loc}`, text: `The ${a.checklist.name} audit at ${loc} was due on ${a.dueDate}.\nOpen: ${s.cfg.APP_URL}/audits/${a.id}`, tag: 'audit_overdue' });
    }
    await s.db.update(audits).set({ remindedAt: now }).where(eq(audits.id, a.id));
    auditReminders++;
  }
  return { actionReminders, auditReminders };
}

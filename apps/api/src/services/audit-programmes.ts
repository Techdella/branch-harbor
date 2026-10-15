/**
 * Audits phase 2 (Operations → Audits and Operations → Self-checks):
 *
 * - Recurring schedules: a checklist for a set of locations every N weeks / months / quarters. A job creates each audit
 *   `leadDays` before it is due, assigned to the location's field consultant (its account manager with Audits edit
 *   there) or a named auditor. One audit per schedule, location and due date, so re-runs never duplicate.
 * - Trend analytics: scores per location, region and checklist section by month, and the most-failed items.
 * - Retraining loop: a failed item whose question recommends an academy course records the course on the corrective
 *   action and, when set to auto-assign, assigns it to the location's team (finding → task → retraining → verified fix).
 * - Visit planner: a consultant's upcoming visits per day in nearest-neighbour route order.
 * - Self-checks: daily / weekly checklists the location runs itself (opening, closing, temperature logs), with reminders
 *   before the due time; missed runs are marked. Results stay apart from HQ audits.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  haversineKm, nearestNeighbourRoute, questionTraining, routeKm, scheduleDueDates, scoreAudit, selfCheckDueOn, targetIncludes,
  type AccessAction, type AuditAnswers, type AuditFrequency, type GeoPoint, type ScheduleTarget,
} from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import {
  accountManagers, auditActions, auditSchedules, auditTemplates, audits, courses, enrolments, locations, organizations, regions, selfCheckRuns, selfCheckSchedules, users,
  type AuditChecklist,
} from '../db/schema/index.ts';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.ts';
import { addDays, localDateParts, zonedToUtc } from '../lib/tz.ts';
import { MODULE as AUDITS, checklistOf, names, orgToday, usersWithCapability, type Audit } from './audits.ts';
import { capabilityLocations, hasCapability, requireMember } from './authz.ts';
import { notify } from './notifications.ts';

export const SELF = 'operations.self_checks';
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
type LocRow = { id: string; name: string; regionId: string | null; ownerGroupId: string | null; timeZone: string; status: string; geo: GeoPoint | null; address: unknown; archivedAt: Date | null };

async function orgLocations(db: Exec, organizationId: string): Promise<LocRow[]> {
  return db.select({ id: locations.id, name: locations.name, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId, timeZone: locations.timeZone, status: locations.status, geo: locations.geo, address: locations.address, archivedAt: locations.archivedAt })
    .from(locations).where(and(eq(locations.organizationId, organizationId), isNull(locations.archivedAt)));
}

/* ------------------------------------------------------------------ */
/* Recurring audit schedules                                           */
/* ------------------------------------------------------------------ */

export type AuditSchedule = typeof auditSchedules.$inferSelect;

export async function loadSchedule(db: Exec, organizationId: string, id: string) {
  const [x] = await db.select().from(auditSchedules).where(and(eq(auditSchedules.id, id), eq(auditSchedules.organizationId, organizationId)));
  if (!x) throw notFound('Audit schedule');
  return x;
}

/**
 * The location's field consultant: its account manager (location, then owner group, then region) who holds Audits edit
 * at the location. Null when there is none.
 */
export async function fieldConsultantFor(db: Exec, organizationId: string, loc: Pick<LocRow, 'id' | 'regionId' | 'ownerGroupId'>, allowedCache?: Map<string, string[]>): Promise<string | null> {
  const rows = await db.select().from(accountManagers).where(eq(accountManagers.organizationId, organizationId));
  const rank = (r: typeof rows[number]) => (r.scopeKind === 'location' && r.scopeId === loc.id ? 0 : r.scopeKind === 'owner_group' && r.scopeId === loc.ownerGroupId ? 1 : r.scopeKind === 'region' && r.scopeId === loc.regionId ? 2 : 9);
  const candidates = rows.filter((r) => rank(r) < 9).sort((a, b) => rank(a) - rank(b));
  if (!candidates.length) return null;
  const allowed = allowedCache?.get(loc.id) ?? (await usersWithCapability(db, organizationId, loc.id, AUDITS, 'edit'));
  allowedCache?.set(loc.id, allowed);
  return candidates.find((c) => allowed.includes(c.userId))?.userId ?? null;
}

export function serializeSchedule(x: AuditSchedule, extra: { templateName?: string | null; auditorName?: string | null; locationCount?: number; nextDue?: string | null } = {}) {
  return {
    id: x.id, name: x.name, templateId: x.templateId, templateName: extra.templateName ?? null, target: x.target, frequency: x.frequency, interval: x.interval, anchorDate: x.anchorDate, leadDays: x.leadDays,
    auditorRule: x.auditorRule, auditor: x.auditorUserId ? { id: x.auditorUserId, name: extra.auditorName ?? null } : null, active: x.active, lastRunAt: iso(x.lastRunAt),
    locationCount: extra.locationCount ?? 0, nextDue: extra.nextDue ?? null,
  };
}

export async function scheduleLocations(db: Exec, organizationId: string, target: ScheduleTarget) {
  return (await orgLocations(db, organizationId)).filter((l) => l.status !== 'closed' && targetIncludes(target, l));
}

/** Next due date from today (in the organisation's time zone). */
export function nextDueOf(x: Pick<AuditSchedule, 'frequency' | 'interval' | 'anchorDate'>, today: string) {
  return scheduleDueDates({ frequency: x.frequency as AuditFrequency, interval: x.interval, anchorDate: x.anchorDate }, today, addDays(today, 800))[0] ?? null;
}

/**
 * Creates the audits that fall within each active schedule's lead window (today … today + leadDays). Idempotent: an
 * audit already created for the same schedule, location and due date is skipped. Runs daily and from
 * `POST /audits/schedules/:id/run`.
 */
export async function runAuditSchedules(s: Services, now = new Date(), opts: { organizationId?: string; scheduleId?: string } = {}) {
  const conds = [eq(auditSchedules.active, true)];
  if (opts.organizationId) conds.push(eq(auditSchedules.organizationId, opts.organizationId));
  if (opts.scheduleId) conds.push(eq(auditSchedules.id, opts.scheduleId));
  const list = await s.db.select().from(auditSchedules).where(and(...conds));
  let created = 0;
  const createdIds: string[] = [];
  for (const sch of list) {
    const [t] = await s.db.select().from(auditTemplates).where(eq(auditTemplates.id, sch.templateId));
    if (!t || t.status !== 'active') continue;
    const today = await orgToday(s.db, sch.organizationId, now);
    const dates = scheduleDueDates({ frequency: sch.frequency as AuditFrequency, interval: sch.interval, anchorDate: sch.anchorDate }, today, addDays(today, sch.leadDays));
    if (!dates.length) { await s.db.update(auditSchedules).set({ lastRunAt: now }).where(eq(auditSchedules.id, sch.id)); continue; }
    const locs = await scheduleLocations(s.db, sch.organizationId, sch.target);
    const cache = new Map<string, string[]>();
    for (const loc of locs) {
      let auditor: string | null = sch.auditorRule === 'field_consultant' ? await fieldConsultantFor(s.db, sch.organizationId, loc, cache) : null;
      if (!auditor && sch.auditorUserId) {
        const ok = cache.get(loc.id) ?? (await usersWithCapability(s.db, sch.organizationId, loc.id, AUDITS, 'edit'));
        cache.set(loc.id, ok);
        if (ok.includes(sch.auditorUserId)) auditor = sch.auditorUserId;
      }
      for (const due of dates) {
        const [a] = await s.db.insert(audits).values({
          organizationId: sch.organizationId, locationId: loc.id, templateId: t.id, checklist: checklistOf(t), purpose: 'routine', dueDate: due, auditorUserId: auditor, scheduledBy: sch.createdBy, scheduleId: sch.id,
        }).onConflictDoNothing().returning();
        if (!a) continue;
        created++;
        createdIds.push(a.id);
        if (auditor) {
          const [u] = await s.db.select({ email: users.email }).from(users).where(eq(users.id, auditor));
          if (u) await s.jobs.enqueue('email.send', { to: u.email, subject: `Visit scheduled: ${t.name} at ${loc.name} by ${due}`, text: `${sch.name}: ${t.name} at ${loc.name} is due ${due}.\nPlan your visits: ${s.cfg.APP_URL}/audits?tab=visits\nOpen: ${s.cfg.APP_URL}/audits/${a.id}`, tag: 'audit_scheduled' });
        }
      }
    }
    await s.db.update(auditSchedules).set({ lastRunAt: now }).where(eq(auditSchedules.id, sch.id));
  }
  return { created, auditIds: createdIds };
}

/* ------------------------------------------------------------------ */
/* Retraining loop                                                     */
/* ------------------------------------------------------------------ */

/**
 * After an audit completes: corrective actions whose question recommends a course get it recorded; auto-assign
 * questions assign the course to the location's team, due with the corrective action.
 */
export async function linkTraining(s: Services, a: Audit, actorUserId: string | null) {
  const acts = await s.db.select().from(auditActions).where(eq(auditActions.auditId, a.id));
  let assigned = 0;
  for (const x of acts) {
    const tr = questionTraining(a.checklist.sections, x.questionId);
    if (!tr) continue;
    const [c] = await s.db.select({ id: courses.id, status: courses.status }).from(courses).where(and(eq(courses.id, tr.courseId), eq(courses.organizationId, a.organizationId)));
    if (!c) continue;
    let assignmentId: string | null = null;
    if (tr.autoAssign && c.status === 'published') {
      assignmentId = await assignRetraining(s, a.organizationId, a.locationId, c.id, x.id, x.dueDate, actorUserId);
      assigned++;
    }
    await s.db.update(auditActions).set({ trainingCourseId: c.id, trainingAssignmentId: assignmentId, updatedAt: new Date() }).where(eq(auditActions.id, x.id));
  }
  return { assigned };
}

export async function assignRetraining(s: Services, organizationId: string, locationId: string, courseId: string, actionId: string, dueDate: string, actorUserId: string | null) {
  const { assignTraining } = await import('./training.ts');
  const r = await assignTraining(s, organizationId, { targetType: 'course', targetId: courseId, audience: { locationIds: [locationId] }, dueAt: new Date(`${dueDate}T23:59:00Z`), source: 'audit', sourceRef: actionId }, actorUserId);
  return r.assignment.id;
}

/** Retraining progress for corrective actions: the course and how many of the assigned people completed it. */
export async function trainingFor(db: Exec, actions: Array<{ id: string; trainingCourseId: string | null; trainingAssignmentId: string | null }>) {
  const out = new Map<string, { courseId: string; courseTitle: string | null; assigned: boolean; enrolled: number; completed: number }>();
  const withCourse = actions.filter((x) => x.trainingCourseId);
  if (!withCourse.length) return out;
  const titles = new Map((await db.select({ id: courses.id, title: courses.title }).from(courses).where(inArray(courses.id, [...new Set(withCourse.map((x) => x.trainingCourseId!))]))).map((c) => [c.id, c.title]));
  const assignmentIds = withCourse.map((x) => x.trainingAssignmentId).filter((x): x is string => !!x);
  const enr = assignmentIds.length ? await db.select({ assignmentId: enrolments.assignmentId, status: enrolments.status }).from(enrolments).where(inArray(enrolments.assignmentId, assignmentIds)) : [];
  for (const x of withCourse) {
    const mine = enr.filter((e) => e.assignmentId === x.trainingAssignmentId);
    out.set(x.id, { courseId: x.trainingCourseId!, courseTitle: titles.get(x.trainingCourseId!) ?? null, assigned: !!x.trainingAssignmentId, enrolled: mine.length, completed: mine.filter((e) => e.status === 'completed').length });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Trends                                                              */
/* ------------------------------------------------------------------ */

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/**
 * Score trends for HQ audits (self-checks are not included): average score per month for the network, each location,
 * each region and each checklist section, and the most-failed items with how often they fail when asked.
 */
export async function auditTrends(db: Exec, organizationId: string, allowed: 'all' | Set<string>, opts: { months: number; templateId?: string; regionId?: string }, now = new Date()) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (opts.months - 1), 1));
  const months = Array.from({ length: opts.months }, (_, i) => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
  const locs = (await orgLocations(db, organizationId)).filter((l) => (allowed === 'all' || allowed.has(l.id)) && (!opts.regionId || l.regionId === opts.regionId));
  const ids = locs.map((l) => l.id);
  const regionRows = await db.select({ id: regions.id, name: regions.name }).from(regions).where(eq(regions.organizationId, organizationId));
  const empty = { months, network: months.map((m) => ({ month: m, averageScorePct: null as number | null, audits: 0 })), locations: [], regions: [], sections: [], mostFailed: [], totals: { audits: 0, averageScorePct: null as number | null, passRatePct: null as number | null } };
  if (!ids.length) return empty;
  const conds = [eq(audits.organizationId, organizationId), inArray(audits.locationId, ids), eq(audits.status, 'completed'), gte(audits.completedAt, from)];
  if (opts.templateId) conds.push(eq(audits.templateId, opts.templateId));
  const done = await db.select().from(audits).where(and(...conds)).orderBy(asc(audits.completedAt));
  const monthOf = (a: Audit) => a.completedAt!.toISOString().slice(0, 7);
  const score = (a: Audit) => (a.scoreTenths === null ? null : a.scoreTenths / 10);
  const series = (list: Audit[]) => months.map((m) => avg(list.filter((a) => monthOf(a) === m).map(score).filter((x): x is number => x !== null)));
  const locById = new Map(locs.map((l) => [l.id, l]));
  // Sections: re-score each audit's stored answers against its own checklist snapshot, grouped by section title.
  const sec = new Map<string, { title: string; byMonth: Map<string, number[]>; all: number[] }>();
  const asked = new Map<string, number>();
  for (const a of done) {
    const sc = scoreAudit(a.checklist, a.answers);
    for (const s of sc.sections) {
      if (s.scorePct === null) continue;
      const k = s.title.trim().toLowerCase();
      const e = sec.get(k) ?? { title: s.title, byMonth: new Map<string, number[]>(), all: [] as number[] };
      e.byMonth.set(monthOf(a), [...(e.byMonth.get(monthOf(a)) ?? []), s.scorePct]);
      e.all.push(s.scorePct);
      sec.set(k, e);
    }
    for (const s of a.checklist.sections) for (const q of s.questions) asked.set(`${q.id}|${q.text}`, (asked.get(`${q.id}|${q.text}`) ?? 0) + 1);
  }
  const acts = done.length ? await db.select({ questionId: auditActions.questionId, title: auditActions.title, sectionTitle: auditActions.sectionTitle, critical: auditActions.critical, locationId: auditActions.locationId, reason: auditActions.reason, trainingCourseId: auditActions.trainingCourseId })
    .from(auditActions).where(inArray(auditActions.auditId, done.map((a) => a.id))) : [];
  const failed = new Map<string, { questionId: string; title: string; sectionTitle: string; critical: boolean; fails: number; locations: Set<string>; reasons: Map<string, number>; trainingCourseId: string | null }>();
  for (const x of acts) {
    const k = `${x.questionId}|${x.title}`;
    const e = failed.get(k) ?? { questionId: x.questionId, title: x.title, sectionTitle: x.sectionTitle, critical: x.critical, fails: 0, locations: new Set(), reasons: new Map(), trainingCourseId: x.trainingCourseId };
    e.fails++;
    e.locations.add(x.locationId);
    e.reasons.set(x.reason, (e.reasons.get(x.reason) ?? 0) + 1);
    failed.set(k, e);
  }
  const scored = done.map(score).filter((x): x is number => x !== null);
  return {
    months,
    network: months.map((m, i) => ({ month: m, averageScorePct: series(done)[i]!, audits: done.filter((a) => monthOf(a) === m).length })),
    locations: locs.map((l) => {
      const mine = done.filter((a) => a.locationId === l.id);
      const s = series(mine);
      const vals = s.filter((x): x is number => x !== null);
      return { locationId: l.id, name: l.name, regionId: l.regionId, byMonth: s, audits: mine.length, averageScorePct: avg(mine.map(score).filter((x): x is number => x !== null)), change: vals.length >= 2 ? Math.round((vals[vals.length - 1]! - vals[0]!) * 10) / 10 : null };
    }).sort((a, b) => (a.averageScorePct ?? 101) - (b.averageScorePct ?? 101)),
    regions: regionRows.map((r) => {
      const mine = done.filter((a) => locById.get(a.locationId)?.regionId === r.id);
      return { regionId: r.id, name: r.name, byMonth: series(mine), audits: mine.length, averageScorePct: avg(mine.map(score).filter((x): x is number => x !== null)) };
    }).filter((r) => r.audits > 0),
    sections: [...sec.values()].map((e) => ({ title: e.title, byMonth: months.map((m) => avg(e.byMonth.get(m) ?? [])), averageScorePct: avg(e.all), audits: e.all.length })).sort((a, b) => (a.averageScorePct ?? 101) - (b.averageScorePct ?? 101)),
    mostFailed: [...failed.entries()].map(([k, e]) => ({
      questionId: e.questionId, title: e.title, sectionTitle: e.sectionTitle, critical: e.critical, fails: e.fails, asked: asked.get(k) ?? e.fails, failRatePct: Math.round((e.fails / (asked.get(k) ?? e.fails)) * 1000) / 10,
      locations: e.locations.size, topReason: [...e.reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, trainingCourseId: e.trainingCourseId,
    })).sort((a, b) => b.fails - a.fails || b.failRatePct - a.failRatePct).slice(0, 15),
    totals: { audits: done.length, averageScorePct: avg(scored), passRatePct: done.length ? Math.round((done.filter((a) => a.passed).length / done.length) * 1000) / 10 : null },
  };
}

/* ------------------------------------------------------------------ */
/* Visit planner                                                       */
/* ------------------------------------------------------------------ */

/**
 * A consultant's open audits between `from` and `to`, grouped by due day and ordered by nearest neighbour (from the
 * start point when given, else from the first stop). Overdue audits come first as their own group.
 */
export async function visitPlan(db: Exec, organizationId: string, allowed: 'all' | Set<string>, auditorUserId: string, from: string, to: string, start: GeoPoint | null, today: string) {
  const rows = await db.select({ a: audits, l: locations }).from(audits).innerJoin(locations, eq(locations.id, audits.locationId))
    .where(and(eq(audits.organizationId, organizationId), eq(audits.auditorUserId, auditorUserId), inArray(audits.status, ['scheduled', 'in_progress']), lte(audits.dueDate, to))).orderBy(asc(audits.dueDate));
  const visible = rows.filter((r) => allowed === 'all' || allowed.has(r.a.locationId));
  const stop = (r: (typeof visible)[number]) => ({
    auditId: r.a.id, name: r.a.checklist.name, status: r.a.status, dueDate: r.a.dueDate, overdue: r.a.dueDate < today, purpose: r.a.purpose,
    locationId: r.l.id, locationName: r.l.name, address: r.l.address, geo: r.l.geo ?? null, timeZone: r.l.timeZone,
  });
  const overdue = visible.filter((r) => r.a.dueDate < from || r.a.dueDate < today).map(stop);
  const upcoming = visible.filter((r) => r.a.dueDate >= from && r.a.dueDate >= today).map(stop);
  const days: Array<{ date: string; stops: Array<ReturnType<typeof stop> & { legKm: number | null; order: number }>; totalKm: number }> = [];
  for (const date of [...new Set(upcoming.map((x) => x.dueDate))].sort()) {
    const route = nearestNeighbourRoute(upcoming.filter((x) => x.dueDate === date), start).map((x, i) => ({ ...x, order: i + 1 }));
    days.push({ date, stops: route, totalKm: routeKm(route) });
  }
  const overdueRoute = nearestNeighbourRoute(overdue, start).map((x, i) => ({ ...x, order: i + 1 }));
  return { from, to, today, start, overdue: overdueRoute, overdueKm: routeKm(overdueRoute), days, visits: upcoming.length + overdue.length, withoutLocation: [...upcoming, ...overdue].filter((x) => !x.geo).length };
}

export const distanceKm = haversineKm;

/* ------------------------------------------------------------------ */
/* Self-checks                                                         */
/* ------------------------------------------------------------------ */

export type SelfSchedule = typeof selfCheckSchedules.$inferSelect;
export type SelfRun = typeof selfCheckRuns.$inferSelect;

export const selfCan = (req: FastifyRequest, db: Exec, organizationId: string, locationId: string | null, action: AccessAction) =>
  hasCapability(req, db, SELF, action, locationId ? { organizationId, kind: 'location', id: locationId } : { organizationId, kind: 'organization', id: organizationId });
export const selfLocations = (req: FastifyRequest, db: Exec, organizationId: string, action: AccessAction = 'view') => capabilityLocations(req, db, organizationId, SELF, action);

export async function loadSelfSchedule(db: Exec, organizationId: string, id: string) {
  const [x] = await db.select().from(selfCheckSchedules).where(and(eq(selfCheckSchedules.id, id), eq(selfCheckSchedules.organizationId, organizationId)));
  if (!x) throw notFound('Self-check');
  return x;
}

export async function loadRun(req: FastifyRequest, db: Exec, organizationId: string, id: string) {
  await requireMember(req, db, organizationId);
  const [r] = await db.select().from(selfCheckRuns).where(and(eq(selfCheckRuns.id, id), eq(selfCheckRuns.organizationId, organizationId)));
  if (!r || !(await selfCan(req, db, organizationId, r.locationId, 'view'))) throw notFound('Self-check');
  return r;
}

export function serializeSelfSchedule(x: SelfSchedule, extra: { templateName?: string | null; locationCount?: number } = {}) {
  return {
    id: x.id, name: x.name, templateId: x.templateId, templateName: extra.templateName ?? null, kind: x.kind, target: x.target, weekdays: x.weekdays, dueTime: x.dueTime,
    remindMinutesBefore: x.remindMinutesBefore, active: x.active, locationCount: extra.locationCount ?? 0,
  };
}

export function serializeRun(r: SelfRun, extra: { locationName?: string | null; scheduleName?: string | null; kind?: string | null; completedByName?: string | null; full?: boolean; now?: Date } = {}) {
  const now = extra.now ?? new Date();
  const base = {
    id: r.id, scheduleId: r.scheduleId, scheduleName: extra.scheduleName ?? r.checklist.name, kind: extra.kind ?? null, locationId: r.locationId, locationName: extra.locationName ?? null, date: r.date,
    dueAt: r.dueAt.toISOString(), late: (r.status === 'due' || r.status === 'in_progress') && r.dueAt < now, status: r.status, name: r.checklist.name,
    scorePct: r.scoreTenths === null ? null : r.scoreTenths / 10, passed: r.passed, criticalFailed: r.criticalFailed, failedItems: r.failedItems, completedAt: iso(r.completedAt),
    completedBy: r.completedBy ? { id: r.completedBy, name: extra.completedByName ?? null } : null,
    questionCount: r.checklist.sections.reduce((n, s) => n + s.questions.length, 0), answered: Object.keys(r.answers).length,
  };
  return extra.full ? { ...base, checklist: r.checklist, answers: r.answers, note: r.note } : base;
}

/** Creates today's runs (each location's local date) for every active self-check due today. Idempotent. */
export async function createSelfCheckRuns(s: Services, now = new Date(), organizationId?: string) {
  const conds = [eq(selfCheckSchedules.active, true)];
  if (organizationId) conds.push(eq(selfCheckSchedules.organizationId, organizationId));
  const list = await s.db.select().from(selfCheckSchedules).where(and(...conds));
  let created = 0;
  const locCache = new Map<string, LocRow[]>();
  for (const sch of list) {
    const [t] = await s.db.select().from(auditTemplates).where(eq(auditTemplates.id, sch.templateId));
    if (!t || t.status !== 'active') continue;
    const locs = locCache.get(sch.organizationId) ?? (await orgLocations(s.db, sch.organizationId));
    locCache.set(sch.organizationId, locs);
    for (const loc of locs.filter((l) => l.status === 'operating' && targetIncludes(sch.target, l))) {
      const today = localDateParts(now, loc.timeZone).date;
      if (!selfCheckDueOn(sch, today)) continue;
      const [r] = await s.db.insert(selfCheckRuns).values({ organizationId: sch.organizationId, scheduleId: sch.id, locationId: loc.id, date: today, dueAt: zonedToUtc(today, sch.dueTime, loc.timeZone), checklist: checklistOf(t) })
        .onConflictDoNothing().returning();
      if (r) created++;
    }
  }
  return created;
}

/**
 * Creates today's runs, sends reminders shortly before the due time to the people who run them, and marks earlier
 * days' unfinished runs as missed. Runs hourly with the quality jobs.
 */
export async function runSelfCheckJobs(s: Services, now = new Date(), organizationId?: string) {
  const created = await createSelfCheckRuns(s, now, organizationId);
  let reminded = 0;
  // Reminders: runs not done whose reminder time has passed (each once).
  const open = await s.db.select({ r: selfCheckRuns, sch: selfCheckSchedules, loc: locations.name }).from(selfCheckRuns).innerJoin(selfCheckSchedules, eq(selfCheckSchedules.id, selfCheckRuns.scheduleId)).innerJoin(locations, eq(locations.id, selfCheckRuns.locationId))
    .where(and(inArray(selfCheckRuns.status, ['due', 'in_progress']), isNull(selfCheckRuns.remindedAt), organizationId ? eq(selfCheckRuns.organizationId, organizationId) : undefined));
  for (const { r, sch, loc } of open) {
    if (r.dueAt.getTime() - sch.remindMinutesBefore * 60_000 > now.getTime()) continue;
    // The location's own team (people holding Self-checks edit organisation-wide are HQ, not reminded per location).
    const hq = new Set(await usersWithCapability(s.db, r.organizationId, null, SELF, 'edit'));
    const ids = (await usersWithCapability(s.db, r.organizationId, r.locationId, SELF, 'edit')).filter((id) => !hq.has(id));
    if (ids.length) await notify(s, { userIds: ids, organizationId: r.organizationId, category: 'network_update', title: `${sch.name} due at ${sch.dueTime}`, body: loc, data: { kind: 'self_check', runId: r.id, link: `/self-checks/${r.id}` } }).catch(() => {});
    await s.db.update(selfCheckRuns).set({ remindedAt: now }).where(eq(selfCheckRuns.id, r.id));
    reminded++;
  }
  // Missed: runs from an earlier local day that were never completed.
  const stale = await s.db.select({ r: selfCheckRuns, tz: locations.timeZone }).from(selfCheckRuns).innerJoin(locations, eq(locations.id, selfCheckRuns.locationId))
    .where(and(inArray(selfCheckRuns.status, ['due', 'in_progress']), lte(selfCheckRuns.date, addDays(now.toISOString().slice(0, 10), 1)), organizationId ? eq(selfCheckRuns.organizationId, organizationId) : undefined));
  let missed = 0;
  for (const { r, tz } of stale) {
    if (r.date >= localDateParts(now, tz).date) continue;
    await s.db.update(selfCheckRuns).set({ status: 'missed', updatedAt: now }).where(and(eq(selfCheckRuns.id, r.id), inArray(selfCheckRuns.status, ['due', 'in_progress'])));
    missed++;
  }
  return { created, reminded, missed };
}

export async function saveRunAnswers(db: Exec, r: SelfRun, answers: AuditAnswers) {
  if (r.status === 'completed') throw conflict('self_check_closed', 'This self-check is already completed');
  const ids = new Set(r.checklist.sections.flatMap((s) => s.questions.map((q) => q.id)));
  const unknown = Object.keys(answers).filter((k) => !ids.has(k));
  if (unknown.length) throw new AppError(400, 'validation_failed', 'Unknown question', { answers: unknown.slice(0, 5).join(', ') });
  const [u] = await db.update(selfCheckRuns).set({ answers: sql`${selfCheckRuns.answers} || ${JSON.stringify(answers)}::jsonb`, status: r.status === 'missed' ? 'missed' : 'in_progress', updatedAt: new Date() })
    .where(and(eq(selfCheckRuns.id, r.id), inArray(selfCheckRuns.status, ['due', 'in_progress', 'missed']))).returning();
  if (!u) throw conflict('self_check_closed', 'This self-check is already completed');
  return u;
}

/** Completes a run: scores it; a failed critical item alerts the people with Self-checks publish at the location. */
export async function completeRun(s: Services, r: SelfRun, by: string, note: string | null) {
  if (r.status === 'completed') throw conflict('self_check_closed', 'This self-check is already completed');
  const sc = scoreAudit(r.checklist, r.answers);
  if (sc.unanswered.length) throw new AppError(409, 'audit_incomplete', `${sc.unanswered.length} questions still need an answer (or n/a)`, undefined, { unanswered: sc.unanswered });
  const text = new Map(r.checklist.sections.flatMap((x) => x.questions.map((q) => [q.id, q.text] as const)));
  const [u] = await s.db.update(selfCheckRuns).set({
    status: 'completed', completedAt: new Date(), completedBy: by, note, scoreTenths: sc.scorePct === null ? null : Math.round(sc.scorePct * 10), passed: sc.passed, criticalFailed: sc.criticalFailed,
    failedItems: sc.failedItems.map((f) => ({ questionId: f.questionId, text: text.get(f.questionId) ?? f.questionId, reason: f.reason, critical: f.critical })), updatedAt: new Date(),
  }).where(and(eq(selfCheckRuns.id, r.id), inArray(selfCheckRuns.status, ['due', 'in_progress', 'missed']))).returning();
  if (!u) throw conflict('self_check_closed', 'This self-check is already completed');
  if (sc.criticalFailed) {
    const managers = (await usersWithCapability(s.db, r.organizationId, r.locationId, SELF, 'publish')).filter((id) => id !== by);
    const [loc] = await s.db.select({ name: locations.name }).from(locations).where(eq(locations.id, r.locationId));
    if (managers.length) await notify(s, { userIds: managers, organizationId: r.organizationId, category: 'network_update', title: `${r.checklist.name}: critical item failed at ${loc?.name ?? ''}`, body: u!.failedItems.filter((f) => f.critical).map((f) => f.text).join(', ').slice(0, 170), data: { kind: 'self_check', runId: r.id, link: `/self-checks/${r.id}` } }).catch(() => {});
  }
  return u!;
}

/** Self-check results for the locations in scope: completion and pass rates, today's runs, and recent failures. */
export async function selfCheckDashboard(db: Exec, organizationId: string, allowed: 'all' | Set<string>, days: number, now = new Date()) {
  const locs = (await orgLocations(db, organizationId)).filter((l) => allowed === 'all' || allowed.has(l.id));
  const ids = locs.map((l) => l.id);
  const today = await orgToday(db, organizationId, now);
  const since = addDays(today, -(days - 1));
  if (!ids.length) return { today, since, totals: { runs: 0, completed: 0, missed: 0, failed: 0, completionPct: null as number | null, passPct: null as number | null }, locations: [], today_runs: [], failures: [], byDay: [] };
  const runs = await db.select({ r: selfCheckRuns, sch: selfCheckSchedules.name, kind: selfCheckSchedules.kind }).from(selfCheckRuns).innerJoin(selfCheckSchedules, eq(selfCheckSchedules.id, selfCheckRuns.scheduleId))
    .where(and(eq(selfCheckRuns.organizationId, organizationId), inArray(selfCheckRuns.locationId, ids), gte(selfCheckRuns.date, addDays(since, -1)))).orderBy(desc(selfCheckRuns.date));
  const name = new Map(locs.map((l) => [l.id, l.name]));
  const inWindow = runs.filter((x) => x.r.date >= since);
  const closed = inWindow.filter((x) => x.r.status === 'completed' || x.r.status === 'missed');
  const completed = inWindow.filter((x) => x.r.status === 'completed');
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const dates = Array.from({ length: days }, (_, i) => addDays(since, i));
  const people = await names(db, completed.map((x) => x.r.completedBy));
  return {
    today, since,
    totals: { runs: inWindow.length, completed: completed.length, missed: inWindow.filter((x) => x.r.status === 'missed').length, failed: completed.filter((x) => !x.r.passed).length, completionPct: pct(completed.length, closed.length), passPct: pct(completed.filter((x) => x.r.passed).length, completed.length) },
    locations: locs.map((l) => {
      const mine = inWindow.filter((x) => x.r.locationId === l.id);
      const c = mine.filter((x) => x.r.status === 'completed');
      const cl = mine.filter((x) => x.r.status === 'completed' || x.r.status === 'missed');
      return { locationId: l.id, name: l.name, runs: mine.length, completionPct: pct(c.length, cl.length), passPct: pct(c.filter((x) => x.r.passed).length, c.length), missed: mine.filter((x) => x.r.status === 'missed').length, criticalFails: c.filter((x) => x.r.criticalFailed).length };
    }).filter((l) => l.runs > 0),
    byDay: dates.map((d) => {
      const mine = inWindow.filter((x) => x.r.date === d);
      return { date: d, completed: mine.filter((x) => x.r.status === 'completed').length, missed: mine.filter((x) => x.r.status === 'missed').length, failed: mine.filter((x) => x.r.status === 'completed' && !x.r.passed).length, open: mine.filter((x) => x.r.status === 'due' || x.r.status === 'in_progress').length };
    }),
    today_runs: runs.filter((x) => x.r.date >= addDays(today, -1) && (x.r.status === 'due' || x.r.status === 'in_progress' || x.r.date === today))
      .map((x) => serializeRun(x.r, { locationName: name.get(x.r.locationId), scheduleName: x.sch, kind: x.kind, completedByName: x.r.completedBy ? people.get(x.r.completedBy) : null, now })),
    failures: completed.filter((x) => !x.r.passed).slice(0, 20).map((x) => serializeRun(x.r, { locationName: name.get(x.r.locationId), scheduleName: x.sch, kind: x.kind, completedByName: x.r.completedBy ? people.get(x.r.completedBy) : null, now })),
  };
}

/** Requires Self-checks publish at every location a target covers (HQ: organisation-wide). */
export async function requireSelfPublishFor(req: FastifyRequest, db: Exec, organizationId: string, target: ScheduleTarget) {
  if (await selfCan(req, db, organizationId, null, 'publish')) return;
  const allowed = await selfLocations(req, db, organizationId, 'publish');
  if (target.kind === 'all') throw forbidden('Only HQ can set self-checks for every location');
  const locs = await scheduleLocations(db, organizationId, target);
  if (!locs.length || locs.some((l) => allowed !== 'all' && !allowed.has(l.id))) throw forbidden('You can only set self-checks for your own locations');
}

export const orgName = async (db: Exec, organizationId: string) => (await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId)))[0]?.name ?? '';

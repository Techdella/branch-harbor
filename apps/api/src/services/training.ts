import { and, asc, eq, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import {
  certificates, courseLeads, courseLessons, courseModules, courses, enrolments, learningPaths, lessonProgress, quizAttempts, trainingAssignments, users,
  type Audience, type QuizQuestion,
} from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { audienceIncludes, orgViewers, type Viewer } from './network-access.ts';
import { networkNotify } from './network-notify.ts';
import { paymentTargetExtensions, type PaymentRow } from './payments.ts';

export type Course = typeof courses.$inferSelect;
export type Lesson = typeof courseLessons.$inferSelect;
export type Enrolment = typeof enrolments.$inferSelect;

/** Authors edit their own (and co-taught) courses; HQ training managers edit any. */
export function canEditCourse(c: Course, v: Viewer) {
  if (v.orgPerms.has('training.manage')) return true;
  return v.perms.has('training.author') && (c.authorId === v.userId || c.trainerUserIds.includes(v.userId));
}

export function canSeeCourse(c: Course, v: Viewer) {
  if (canEditCourse(c, v)) return true;
  return c.status === 'published' && v.perms.has('training.learn');
}

export async function courseOutline(db: Exec, courseId: string) {
  const [mods, lessons] = await Promise.all([
    db.select().from(courseModules).where(eq(courseModules.courseId, courseId)).orderBy(asc(courseModules.position), asc(courseModules.title)),
    db.select().from(courseLessons).where(eq(courseLessons.courseId, courseId)).orderBy(asc(courseLessons.position), asc(courseLessons.title)),
  ]);
  return mods.map((m) => ({ ...m, lessons: lessons.filter((l) => l.moduleId === m.id) }));
}

export async function loadCourse(db: Exec, organizationId: string, id: string) {
  const [c] = await db.select().from(courses).where(and(eq(courses.id, id), eq(courses.organizationId, organizationId)));
  if (!c) throw notFound('Course');
  return c;
}

/** Strip answers before a quiz goes to a learner. */
export const learnerQuiz = (q: QuizQuestion[] | null) => (q ?? []).map((x) => ({ id: x.id, prompt: x.prompt, options: x.options, multiple: x.correct.length > 1 }));

const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const SATISFIED = ['active', 'completed', 'pending_payment'];

/** Courses a training target expands to (a course, or every course in a path). */
async function targetCourseIds(db: Exec, organizationId: string, targetType: string, targetId: string) {
  if (targetType === 'course') return [targetId];
  const [p] = await db.select().from(learningPaths).where(and(eq(learningPaths.id, targetId), eq(learningPaths.organizationId, organizationId)));
  return p?.courseIds ?? [];
}

/** Create the enrolments an assignment implies for one person (idempotent). Returns the new enrolments. */
async function materialise(db: Exec, a: typeof trainingAssignments.$inferSelect, userId: string, courseIds: string[], now = new Date()) {
  if (!courseIds.length) return [];
  const published = await db.select({ id: courses.id }).from(courses).where(and(inArray(courses.id, courseIds), eq(courses.status, 'published')));
  const ids = published.map((c) => c.id);
  if (!ids.length) return [];
  const existing = await db.select({ courseId: enrolments.courseId }).from(enrolments).where(and(eq(enrolments.userId, userId), inArray(enrolments.courseId, ids), inArray(enrolments.status, SATISFIED)));
  const have = new Set(existing.map((e) => e.courseId));
  const dueAt = a.dueAt ?? (a.dueInDays ? new Date(now.getTime() + a.dueInDays * 86_400_000) : null);
  const todo = ids.filter((id) => !have.has(id));
  if (!todo.length) return [];
  return db.insert(enrolments).values(todo.map((courseId) => ({ organizationId: a.organizationId, courseId, userId, source: a.source === 'recertification' ? 'assignment' : 'assignment', assignmentId: a.id, status: 'active', dueAt }))).returning();
}

/** People who join later (or whose certificate expired) get their assigned training when they open the academy. */
export async function ensureAssignedEnrolments(db: Exec, v: Viewer) {
  const list = await db.select().from(trainingAssignments).where(eq(trainingAssignments.organizationId, v.organizationId));
  let created = 0;
  for (const a of list) {
    if (!audienceIncludes(a.audience, v, { hqSeesAll: false })) continue;
    created += (await materialise(db, a, v.userId, await targetCourseIds(db, v.organizationId, a.targetType, a.targetId))).length;
  }
  return created;
}

export interface AssignInput { targetType: 'course' | 'path'; targetId: string; audience: Audience; dueAt?: Date | null; dueInDays?: number | null; source?: string; sourceRef?: string | null }

/**
 * Assign a course or learning path. Enrolments are created now for everyone the audience matches (and later for
 * people who join). This is also the hook the franchise onboarding flow uses for new franchisees.
 */
export async function assignTraining(s: Services, organizationId: string, input: AssignInput, actorUserId: string | null) {
  const courseIds = await targetCourseIds(s.db, organizationId, input.targetType, input.targetId);
  if (input.targetType === 'course') await loadCourse(s.db, organizationId, input.targetId);
  else if (!courseIds.length) throw notFound('Learning path');
  const [a] = await s.db.insert(trainingAssignments).values({
    organizationId, targetType: input.targetType, targetId: input.targetId, audience: input.audience, dueAt: input.dueAt ?? null, dueInDays: input.dueInDays ?? null,
    source: input.source ?? 'manual', sourceRef: input.sourceRef ?? null, assignedBy: actorUserId,
  }).returning();
  const viewers = (await orgViewers(s.db, organizationId)).filter((v) => v.perms.has('training.learn') && audienceIncludes(input.audience, v, { hqSeesAll: false }));
  const notifyIds: string[] = [];
  let enrolled = 0;
  for (const v of viewers) {
    const made = await materialise(s.db, a!, v.userId, courseIds);
    enrolled += made.length;
    if (made.length) notifyIds.push(v.userId);
  }
  const titles = await s.db.select({ title: courses.title }).from(courses).where(inArray(courses.id, courseIds));
  await networkNotify(s, {
    organizationId, userIds: notifyIds, exclude: actorUserId ? [actorUserId] : [], kind: 'course_assigned',
    title: titles.length === 1 ? `New training: ${titles[0]!.title}` : `New training: ${titles.length} courses`, body: input.dueAt ? `Due ${input.dueAt.toISOString().slice(0, 10)}` : null, link: '/training', data: { assignmentId: a!.id },
  });
  await audit(s.db, { organizationId, actorUserId, action: 'training.assigned', targetType: input.targetType, targetId: input.targetId, metadata: { audience: input.audience, enrolled, source: input.source ?? 'manual' } });
  return { assignment: a!, people: viewers.length, enrolled };
}

/** Prerequisites the person has not completed (with a still-valid completion). */
export async function missingPrerequisites(db: Exec, c: Course, userId: string) {
  if (!c.prerequisiteIds.length) return [];
  const done = await db.select({ courseId: enrolments.courseId }).from(enrolments).where(and(eq(enrolments.userId, userId), inArray(enrolments.courseId, c.prerequisiteIds), eq(enrolments.status, 'completed')));
  const ok = new Set(done.map((d) => d.courseId));
  const missing = c.prerequisiteIds.filter((id) => !ok.has(id));
  if (!missing.length) return [];
  return db.select({ id: courses.id, title: courses.title }).from(courses).where(inArray(courses.id, missing));
}

/** Self-enrol (or resume) in a published internal course. */
export async function startCourse(db: Exec, c: Course, v: Viewer) {
  if (c.status !== 'published' && !canEditCourse(c, v)) throw notFound('Course');
  const [current] = await db.select().from(enrolments).where(and(eq(enrolments.courseId, c.id), eq(enrolments.userId, v.userId), inArray(enrolments.status, ['active', 'completed'])));
  if (current) return current;
  if (c.visibility === 'public' && c.priceMinor && !canEditCourse(c, v) && !v.hq) throw conflict('payment_required', 'This course is sold to the public. Ask HQ to enrol you.');
  const missing = await missingPrerequisites(db, c, v.userId);
  if (missing.length) throw conflict('prerequisites_missing', `Complete ${missing.map((m) => m.title).join(', ')} first`, { missing });
  const [e] = await db.insert(enrolments).values({ organizationId: c.organizationId, courseId: c.id, userId: v.userId, source: 'self', status: 'active', startedAt: new Date() }).returning();
  return e!;
}

export async function myEnrolment(db: Exec, courseId: string, userId: string) {
  const [e] = await db.select().from(enrolments).where(and(eq(enrolments.courseId, courseId), eq(enrolments.userId, userId), inArray(enrolments.status, ['active', 'completed', 'expired', 'pending_payment']))).orderBy(sql`${enrolments.createdAt} desc`).limit(1);
  return e ?? null;
}

const certCode = () => randomBytes(6).toString('hex').toUpperCase().replace(/(.{4})(?=.)/g, '$1-');

/** Recompute progress; on the last lesson, complete the enrolment, set re-certification expiry and issue a certificate. */
export async function refreshProgress(s: Services, tx: Tx | Exec, e: Enrolment) {
  const lessons = await tx.select({ id: courseLessons.id }).from(courseLessons).where(eq(courseLessons.courseId, e.courseId));
  const done = await tx.select({ id: lessonProgress.lessonId }).from(lessonProgress).where(eq(lessonProgress.enrolmentId, e.id));
  const doneIds = new Set(done.map((d) => d.id));
  const completedCount = lessons.filter((l) => doneIds.has(l.id)).length;
  const pct = lessons.length ? Math.round((completedCount / lessons.length) * 100) : 0;
  if (e.status === 'active' && lessons.length > 0 && completedCount === lessons.length) {
    const [c] = await tx.select().from(courses).where(eq(courses.id, e.courseId));
    const now = new Date();
    const expiresAt = c!.validityMonths ? addMonths(now, c!.validityMonths) : null;
    const [u] = await tx.update(enrolments).set({ status: 'completed', progressPct: 100, completedAt: now, expiresAt, updatedAt: now }).where(and(eq(enrolments.id, e.id), eq(enrolments.status, 'active'))).returning();
    if (u && c!.certificateEnabled) {
      const [learner] = e.userId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, e.userId)) : [];
      await tx.insert(certificates).values({ organizationId: e.organizationId, enrolmentId: e.id, courseId: c!.id, userId: e.userId, code: certCode(), learnerName: learner?.name ?? e.learnerName ?? '', courseTitle: c!.title, issuedAt: now, expiresAt });
    }
    if (u) await audit(tx, { organizationId: e.organizationId, actorUserId: e.userId, action: 'training.completed', targetType: 'course', targetId: c!.id, metadata: { enrolmentId: e.id } });
    return u ?? e;
  }
  const [u] = await tx.update(enrolments).set({ progressPct: pct, startedAt: e.startedAt ?? new Date(), updatedAt: new Date() }).where(eq(enrolments.id, e.id)).returning();
  return u!;
}

export async function completeLesson(s: Services, e: Enrolment, lesson: Lesson) {
  if (e.status !== 'active') throw conflict('enrolment_not_active', e.status === 'completed' ? 'You have already completed this course' : 'This enrolment is not active');
  if (lesson.kind === 'quiz') throw conflict('quiz_required', 'Pass the quiz to complete this lesson');
  return s.db.transaction(async (tx) => {
    await tx.insert(lessonProgress).values({ organizationId: e.organizationId, enrolmentId: e.id, lessonId: lesson.id }).onConflictDoNothing();
    return refreshProgress(s, tx, e);
  });
}

/** Score a quiz attempt. Every question must be answered; multi-answer questions need the exact set. */
export async function submitQuiz(s: Services, e: Enrolment, lesson: Lesson, c: Course, answers: Record<string, number[]>) {
  if (e.status !== 'active') throw conflict('enrolment_not_active', 'This enrolment is not active');
  if (lesson.kind !== 'quiz' || !lesson.quiz?.length) throw validationError('This lesson has no quiz');
  const missing = lesson.quiz.filter((q) => !answers[q.id]?.length);
  if (missing.length) throw validationError('Answer every question', Object.fromEntries(missing.map((q) => [`answers.${q.id}`, 'Required'])));
  const results = lesson.quiz.map((q) => {
    const given = [...new Set(answers[q.id]!)].sort();
    const correct = [...q.correct].sort();
    return { questionId: q.id, correct: given.length === correct.length && given.every((x, i) => x === correct[i]), explanation: q.explanation ?? null };
  });
  const score = Math.round((results.filter((r) => r.correct).length / results.length) * 100);
  const passMark = lesson.passMark ?? c.passMark;
  const passed = score >= passMark;
  return s.db.transaction(async (tx) => {
    const [attempt] = await tx.insert(quizAttempts).values({ organizationId: e.organizationId, enrolmentId: e.id, lessonId: lesson.id, answers, score, passed }).returning();
    let enrolment = e;
    if (passed) {
      await tx.insert(lessonProgress).values({ organizationId: e.organizationId, enrolmentId: e.id, lessonId: lesson.id, score }).onConflictDoUpdate({ target: [lessonProgress.enrolmentId, lessonProgress.lessonId], set: { score: sql`greatest(${lessonProgress.score}, ${score})` } });
      enrolment = await refreshProgress(s, tx, e);
    }
    // Correct answers are revealed only after a pass, so a failed attempt can't be used as an answer key.
    return { attempt: attempt!, score, passed, passMark, results: passed ? results : results.map((r) => ({ questionId: r.questionId, correct: r.correct, explanation: null })), enrolment };
  });
}

/** Completion per location for the courses in scope (HQ: every location; managers: their own). */
export async function completionReport(db: Exec, organizationId: string, scopeLocationIds: Set<string> | 'all', courseId?: string) {
  const viewers = (await orgViewers(db, organizationId)).filter((v) => !v.hq && v.perms.has('training.learn'));
  const rows = await db.select({ e: enrolments, title: courses.title }).from(enrolments).innerJoin(courses, eq(courses.id, enrolments.courseId))
    .where(and(eq(enrolments.organizationId, organizationId), isNotNull(enrolments.userId), ne(enrolments.status, 'cancelled'), ...(courseId ? [eq(enrolments.courseId, courseId)] : [])));
  const scores = await db.select({ enrolmentId: quizAttempts.enrolmentId, best: sql<number>`max(${quizAttempts.score})::int` }).from(quizAttempts).where(eq(quizAttempts.organizationId, organizationId)).groupBy(quizAttempts.enrolmentId);
  const best = new Map(scores.map((x) => [x.enrolmentId, x.best]));
  const now = new Date();
  const byLoc = new Map<string, { assigned: number; completed: number; overdue: number; expired: number; inProgress: number; scoreSum: number; scoreN: number; people: Set<string> }>();
  for (const v of viewers) {
    for (const locId of v.locationIds) {
      if (scopeLocationIds !== 'all' && !scopeLocationIds.has(locId)) continue;
      const agg = byLoc.get(locId) ?? { assigned: 0, completed: 0, overdue: 0, expired: 0, inProgress: 0, scoreSum: 0, scoreN: 0, people: new Set<string>() };
      agg.people.add(v.userId);
      for (const r of rows.filter((x) => x.e.userId === v.userId)) {
        agg.assigned++;
        if (r.e.status === 'completed') agg.completed++;
        else if (r.e.status === 'expired') agg.expired++;
        else if (r.e.dueAt && r.e.dueAt < now) agg.overdue++;
        else if (r.e.progressPct > 0) agg.inProgress++;
        const b = best.get(r.e.id);
        if (b !== undefined) { agg.scoreSum += b; agg.scoreN++; }
      }
      byLoc.set(locId, agg);
    }
  }
  return [...byLoc.entries()].map(([locationId, a]) => ({
    locationId, people: a.people.size, assigned: a.assigned, completed: a.completed, inProgress: a.inProgress, overdue: a.overdue, expired: a.expired,
    completionRate: a.assigned ? Math.round((a.completed / a.assigned) * 100) : null, averageScore: a.scoreN ? Math.round(a.scoreSum / a.scoreN) : null,
  }));
}

/** Course leads: pick the course trainer with the fewest open leads (round robin by load). */
export async function pickTrainer(db: Exec, c: Course | null): Promise<string | null> {
  const trainers = c?.trainerUserIds ?? [];
  if (!trainers.length) return c?.authorId ?? null;
  const load = await db.select({ userId: courseLeads.assignedTo, n: sql<number>`count(*)::int` }).from(courseLeads)
    .where(and(inArray(courseLeads.assignedTo, trainers), inArray(courseLeads.status, ['new', 'contacted']))).groupBy(courseLeads.assignedTo);
  const m = new Map(load.map((l) => [l.userId, l.n]));
  return [...trainers].sort((a, b) => (m.get(a) ?? 0) - (m.get(b) ?? 0))[0] ?? null;
}

export async function createCourseLead(s: Services, c: Course | null, organizationId: string, input: { name: string; email: string; phone?: string | null; message?: string | null; source: string; campaign?: string | null; utm?: Record<string, string>; marketingConsent?: boolean; assignedTo?: string | null }) {
  const assignedTo = input.assignedTo ?? (await pickTrainer(s.db, c));
  const [lead] = await s.db.insert(courseLeads).values({
    organizationId, courseId: c?.id ?? null, name: input.name, email: input.email.toLowerCase(), phone: input.phone ?? null, message: input.message ?? null,
    source: input.source, campaign: input.campaign ?? null, utm: input.utm ?? {}, assignedTo, marketingConsent: !!input.marketingConsent,
  }).returning();
  if (assignedTo) {
    await networkNotify(s, { organizationId, userIds: [assignedTo], kind: 'course_lead', title: `New course lead: ${input.name}`, body: c ? c.title : null, link: '/training?tab=leads', data: { leadId: lead!.id } });
  }
  return lead!;
}

/** Recertification: completions past their expiry become "expired" and the person is told to re-certify. */
export async function runTrainingHousekeeping(s: Services, now = new Date()) {
  const due = await s.db.update(enrolments).set({ status: 'expired', updatedAt: now }).where(and(eq(enrolments.status, 'completed'), isNotNull(enrolments.expiresAt), lte(enrolments.expiresAt, now))).returning();
  for (const e of due) {
    if (!e.userId) continue;
    const [c] = await s.db.select({ title: courses.title }).from(courses).where(eq(courses.id, e.courseId));
    await networkNotify(s, { organizationId: e.organizationId, userIds: [e.userId], kind: 'certificate_expiring', title: `Your ${c?.title ?? 'course'} certification has expired`, body: 'Retake the course to re-certify.', link: `/training?course=${e.courseId}`, data: { courseId: e.courseId } });
  }
  return due.length;
}

// ── Paid public courses: the enrolment a payment pays for (registered with the payments module) ──
paymentTargetExtensions.course_enrolment = {
  async fulfil(tx: Tx, p: PaymentRow) {
    const [e] = await tx.select().from(enrolments).where(eq(enrolments.id, p.targetId!)).for('update');
    if (!e) return { fulfilled: false, note: 'Course enrolment missing' };
    if (e.status === 'active' || e.status === 'completed') return { fulfilled: true, note: 'Enrolment already confirmed' };
    if (e.status !== 'pending_payment') return { fulfilled: false, note: `Enrolment is ${e.status} — needs review` };
    const [c] = await tx.select().from(courses).where(eq(courses.id, e.courseId)).for('update');
    if (c?.seats) {
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(enrolments).where(and(eq(enrolments.courseId, e.courseId), inArray(enrolments.status, ['active', 'completed']), eq(enrolments.source, 'public_purchase')));
      if (n >= c.seats) return { fulfilled: false, note: 'Paid after the course filled up — refund or add a seat' };
    }
    await tx.update(enrolments).set({ status: 'active', paymentId: p.id, startedAt: new Date(), updatedAt: new Date() }).where(eq(enrolments.id, e.id));
    if (e.learnerEmail) {
      await tx.update(courseLeads).set({ status: 'enrolled', enrolmentId: e.id, updatedAt: new Date() })
        .where(and(eq(courseLeads.organizationId, e.organizationId), eq(courseLeads.email, e.learnerEmail.toLowerCase()), inArray(courseLeads.status, ['new', 'contacted'])));
    }
    await audit(tx, { organizationId: e.organizationId, actorUserId: null, actorType: 'webhook', action: 'training.enrolment_paid', targetType: 'enrolment', targetId: e.id, metadata: { paymentId: p.id } });
    return { fulfilled: true, note: 'Course enrolment confirmed' };
  },
  async isRecorded(db: Exec, p: PaymentRow) {
    const [e] = await db.select().from(enrolments).where(eq(enrolments.id, p.targetId!));
    return { ok: !!e && ['active', 'completed'].includes(e.status), expected: e?.amountMinor && e.currency ? { amount: e.amountMinor, currency: e.currency } : null };
  },
};

export async function requireEditable(db: Exec, organizationId: string, id: string, v: Viewer) {
  const c = await loadCourse(db, organizationId, id);
  if (!canEditCourse(c, v)) throw canSeeCourse(c, v) ? forbidden('You cannot edit this course') : notFound('Course');
  return c;
}

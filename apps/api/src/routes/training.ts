import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  certificates, courseLessons, leads, courseModules, courses, enrolments, learningPaths, lessonProgress, locations, organizations, quizAttempts, trainingAssignments, users,
} from '../db/schema/index.ts';
import { sha256, randomToken } from '../lib/crypto.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { slugify } from '../lib/slug.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { certificatePdf } from '../services/certificate-pdf.ts';
import { audienceSummary } from '../services/community.ts';
import { orgViewers, requireNetworkPerm, userNames, validateAudience, viewerFor, type Viewer } from '../services/network-access.ts';
import { networkNotify } from '../services/network-notify.ts';
import { createPaymentForTarget } from '../services/payments.ts';
import {
  assignTraining, canEditCourse, canSeeCourse, completeLesson, completionReport, courseOutline, createCourseLead, ensureAssignedEnrolments, learnerQuiz, loadCourse,
  missingPrerequisites, myEnrolment, requireEditable, startCourse, submitQuiz, type Course,
} from '../services/training.ts';
import { idParams, iso, isoDateTime, orgParams, secured } from './_common.ts';
import { attachmentsSchema, audienceSchema, httpUrl } from './network-common.ts';

const tags = ['training'];
const quizSchema = z.array(z.object({
  id: z.string().min(1).max(40), prompt: z.string().trim().min(1).max(1000), options: z.array(z.string().trim().min(1).max(300)).min(2).max(8),
  correct: z.array(z.number().int().min(0).max(7)).min(1), explanation: z.string().max(1000).nullable().optional(),
})).max(50);
const currencyCode = z.string().regex(/^[A-Z]{3}$/);

function serializeCourse(c: Course, extra: Record<string, unknown> = {}) {
  return {
    id: c.id, slug: c.slug, title: c.title, summary: c.summary, description: c.description, coverUrl: c.coverUrl, status: c.status, visibility: c.visibility, category: c.category,
    estimatedMinutes: c.estimatedMinutes, passMark: c.passMark, certificateEnabled: c.certificateEnabled, validityMonths: c.validityMonths, prerequisiteIds: c.prerequisiteIds,
    trainerUserIds: c.trainerUserIds, price: c.priceMinor !== null && c.currency ? { amount: c.priceMinor, currency: c.currency } : null, saleLocationId: c.saleLocationId, seats: c.seats,
    startsOn: c.startsOn, scheduleNote: c.scheduleNote, authorId: c.authorId, submittedAt: iso(c.submittedAt), approvedAt: iso(c.approvedAt), reviewComment: c.reviewComment, publishedAt: iso(c.publishedAt),
    updatedAt: c.updatedAt.toISOString(), ...extra,
  };
}

export const trainingRoutes: FastifyPluginAsyncZod = async (_root) => {
  const root = _root.withTypeProvider<ZodTypeProvider>();
  const s = root.ctx;

  // ───────────────────────── public (brand site) ─────────────────────────
  async function brand(slug: string) {
    const [org] = await s.db.select().from(organizations).where(and(eq(organizations.slug, slug), eq(organizations.status, 'active')));
    if (!org) throw notFound('Brand');
    return org;
  }
  async function publicCourse(orgId: string, slug: string) {
    const [c] = await s.db.select().from(courses).where(and(eq(courses.organizationId, orgId), eq(courses.slug, slug), eq(courses.status, 'published'), eq(courses.visibility, 'public')));
    if (!c) throw notFound('Course');
    return c;
  }
  async function seatsLeft(c: Course) {
    if (!c.seats) return null;
    const [{ n } = { n: 0 }] = await s.db.select({ n: sql<number>`count(*)::int` }).from(enrolments).where(and(eq(enrolments.courseId, c.id), eq(enrolments.source, 'public_purchase'), inArray(enrolments.status, ['active', 'completed'])));
    return Math.max(0, c.seats - n);
  }
  const publicView = async (c: Course, withOutline: boolean) => ({
    slug: c.slug, title: c.title, summary: c.summary, description: c.description, coverUrl: c.coverUrl, category: c.category, estimatedMinutes: c.estimatedMinutes,
    price: c.priceMinor !== null && c.currency ? { amount: c.priceMinor, currency: c.currency } : null, seats: c.seats, seatsLeft: await seatsLeft(c), startsOn: c.startsOn, scheduleNote: c.scheduleNote,
    certificate: c.certificateEnabled, purchasable: !!(c.priceMinor && c.currency && c.saleLocationId),
    trainers: [...(await userNames(s.db, c.trainerUserIds)).values()],
    ...(withOutline ? { outline: (await courseOutline(s.db, c.id)).map((m) => ({ title: m.title, lessons: m.lessons.map((l) => ({ title: l.title, kind: l.kind, minutes: l.minutes })) })) } : {}),
  });

  root.get('/public/courses/:brandSlug', { schema: { tags: ['public', ...tags], params: z.object({ brandSlug: z.string().min(1).max(80) }), summary: 'Public courses a brand sells (e.g. teacher trainings)' } }, async (req) => {
    const org = await brand(req.params.brandSlug);
    const rows = await s.db.select().from(courses).where(and(eq(courses.organizationId, org.id), eq(courses.status, 'published'), eq(courses.visibility, 'public'))).orderBy(asc(courses.startsOn), asc(courses.title));
    return { brand: { name: org.name, slug: org.slug }, items: await Promise.all(rows.map((c) => publicView(c, false))) };
  });

  root.get('/public/courses/:brandSlug/:courseSlug', { schema: { tags: ['public', ...tags], params: z.object({ brandSlug: z.string().min(1).max(80), courseSlug: z.string().min(1).max(120) }) } }, async (req) => {
    const org = await brand(req.params.brandSlug);
    return { brand: { name: org.name, slug: org.slug }, course: await publicView(await publicCourse(org.id, req.params.courseSlug), true) };
  });

  const contact = { name: z.string().trim().min(1).max(120), email: z.email().max(200), phone: z.string().trim().max(40).nullable().optional() };
  const utm = z.object({ source: z.string().max(100).optional(), medium: z.string().max(100).optional(), campaign: z.string().max(150).optional(), content: z.string().max(150).optional(), term: z.string().max(150).optional() }).optional();

  root.post('/public/courses/:brandSlug/:courseSlug/leads', {
    schema: { tags: ['public', ...tags], params: z.object({ brandSlug: z.string().min(1).max(80), courseSlug: z.string().min(1).max(120) }), body: z.object({ ...contact, message: z.string().max(2000).nullable().optional(), utm, marketingConsent: z.boolean().default(false), botToken: z.string().optional() }), summary: 'Course enquiry (ad campaign leads carry utm) → course leads list, assigned to a trainer' },
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!(await s.botCheck.verify(req.body.botToken, req.ip))) throw validationError('Please confirm you are not a robot');
    const org = await brand(req.params.brandSlug);
    const c = await publicCourse(org.id, req.params.courseSlug);
    const u = Object.fromEntries(Object.entries(req.body.utm ?? {}).filter(([, val]) => !!val)) as Record<string, string>;
    const lead = await createCourseLead(s, c, org.id, { name: req.body.name, email: req.body.email, phone: req.body.phone, message: req.body.message, source: u.campaign || u.source ? 'ad_campaign' : 'website', campaign: u.campaign ?? null, utm: u, marketingConsent: req.body.marketingConsent });
    reply.code(201);
    return { received: true, id: lead.id };
  });

  root.post('/public/courses/:brandSlug/:courseSlug/enrol', {
    schema: { tags: ['public', ...tags], params: z.object({ brandSlug: z.string().min(1).max(80), courseSlug: z.string().min(1).max(120) }), body: z.object({ ...contact, utm, acceptTerms: z.literal(true) }), summary: 'Buy a public course: creates a pending enrolment and its card payment (target course_enrolment)' },
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const org = await brand(req.params.brandSlug);
    const c = await publicCourse(org.id, req.params.courseSlug);
    if (!c.priceMinor || !c.currency || !c.saleLocationId) throw conflict('not_for_sale', 'This course cannot be bought online. Send an enquiry instead.');
    const left = await seatsLeft(c);
    if (left !== null && left <= 0) throw conflict('course_full', 'This course is full. Send an enquiry to join the waiting list.');
    const email = req.body.email.toLowerCase();
    const [existingUser] = await s.db.select({ id: users.id }).from(users).where(and(sql`lower(${users.email}) = ${email}`, sql`${users.emailVerifiedAt} is not null`));
    const [already] = await s.db.select().from(enrolments).where(and(eq(enrolments.courseId, c.id), eq(enrolments.learnerEmail, email), inArray(enrolments.status, ['active', 'completed'])));
    if (already) throw conflict('already_enrolled', 'You are already enrolled in this course');
    const token = randomToken(24);
    const [e] = await s.db.insert(enrolments).values({
      organizationId: org.id, courseId: c.id, userId: existingUser?.id ?? null, learnerName: req.body.name, learnerEmail: email, learnerPhone: req.body.phone ?? null, source: 'public_purchase', status: 'pending_payment',
      amountMinor: c.priceMinor, currency: c.currency, accessTokenHash: sha256(token),
    }).returning();
    const p = await createPaymentForTarget(s, { organizationId: org.id, locationId: c.saleLocationId, amountMinor: c.priceMinor, currency: c.currency, targetType: 'course_enrolment', targetId: e!.id, description: c.title, recordSnapshot: { courseId: c.id, learnerEmail: email } });
    await s.db.update(enrolments).set({ paymentId: p.payment.id }).where(eq(enrolments.id, e!.id));
    const u = Object.fromEntries(Object.entries(req.body.utm ?? {}).filter(([, val]) => !!val)) as Record<string, string>;
    const [lead] = await s.db.select().from(leads).where(and(eq(leads.organizationId, org.id), eq(leads.kind, 'course'), eq(leads.email, email), eq(leads.courseId, c.id)));
    if (!lead) await createCourseLead(s, c, org.id, { name: req.body.name, email, phone: req.body.phone, source: u.campaign || u.source ? 'ad_campaign' : 'website', campaign: u.campaign ?? null, utm: u, message: 'Started checkout' });
    reply.code(201);
    return { enrolmentId: e!.id, status: e!.status, accessToken: token, payment: { id: p.payment.id, clientSecret: p.clientSecret, sandbox: p.sandbox, amount: c.priceMinor, currency: c.currency } };
  });

  root.get('/public/course-enrolments/:id', { schema: { tags: ['public', ...tags], params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10).max(200) }), summary: 'Enrolment status for the buyer (token from checkout)' } }, async (req) => {
    const [e] = await s.db.select().from(enrolments).where(eq(enrolments.id, req.params.id));
    if (!e || !e.accessTokenHash || e.accessTokenHash !== sha256(req.query.token)) throw notFound('Enrolment');
    const [c] = await s.db.select().from(courses).where(eq(courses.id, e.courseId));
    return { id: e.id, status: e.status, course: { title: c!.title, startsOn: c!.startsOn, scheduleNote: c!.scheduleNote }, learnerName: e.learnerName };
  });

  root.get('/public/certificates/:code', { schema: { tags: ['public', ...tags], params: z.object({ code: z.string().min(4).max(40) }), summary: 'Verify a certificate' } }, async (req) => {
    const [c] = await s.db.select({ cert: certificates, org: organizations.name }).from(certificates).innerJoin(organizations, eq(organizations.id, certificates.organizationId)).where(eq(certificates.code, req.params.code.toUpperCase()));
    if (!c) throw notFound('Certificate');
    const now = new Date();
    return { code: c.cert.code, learnerName: c.cert.learnerName, courseTitle: c.cert.courseTitle, issuer: c.org, issuedAt: c.cert.issuedAt.toISOString(), expiresAt: iso(c.cert.expiresAt), valid: !c.cert.revokedAt && (!c.cert.expiresAt || c.cert.expiresAt > now) };
  });

  // ───────────────────────── signed-in ─────────────────────────
  await root.register(async (_app) => {
    const app = _app.withTypeProvider<ZodTypeProvider>();
    app.addHook('preHandler', authenticate);
    const base = '/orgs/:orgId/training';
    const learner = async (req: Parameters<typeof viewerFor>[0], orgId: string) => {
      const v = await viewerFor(req, s.db, orgId);
      if (!v.perms.has('training.learn') && !v.perms.has('training.author')) requireNetworkPerm(v, 'training.learn');
      return v;
    };

    async function enrolmentRows(v: Viewer) {
      return s.db.select({ e: enrolments, c: courses }).from(enrolments).innerJoin(courses, eq(courses.id, enrolments.courseId))
        .where(and(eq(enrolments.organizationId, v.organizationId), eq(enrolments.userId, v.userId), ne(enrolments.status, 'cancelled'))).orderBy(asc(enrolments.dueAt), desc(enrolments.updatedAt));
    }

    app.get(`${base}/home`, { schema: { tags, security: secured, params: orgParams, summary: 'My learning: assigned and in-progress courses, catalogue, paths, certificates' } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      await ensureAssignedEnrolments(s.db, v);
      const mine = await enrolmentRows(v);
      // Latest enrolment per course (a re-certification creates a new one).
      const latest = new Map<string, (typeof mine)[number]>();
      for (const r of mine) { const cur = latest.get(r.c.id); if (!cur || cur.e.createdAt < r.e.createdAt) latest.set(r.c.id, r); }
      const now = new Date();
      const catalogue = (await s.db.select().from(courses).where(and(eq(courses.organizationId, v.organizationId), eq(courses.status, 'published'))).orderBy(asc(courses.title))).filter((c) => canSeeCourse(c, v));
      const paths = await s.db.select().from(learningPaths).where(and(eq(learningPaths.organizationId, v.organizationId), eq(learningPaths.status, 'published'))).orderBy(asc(learningPaths.title));
      const certs = await s.db.select().from(certificates).where(and(eq(certificates.organizationId, v.organizationId), eq(certificates.userId, v.userId))).orderBy(desc(certificates.issuedAt));
      const authoring = v.perms.has('training.author') || v.orgPerms.has('training.manage')
        ? (await s.db.select().from(courses).where(eq(courses.organizationId, v.organizationId)).orderBy(desc(courses.updatedAt))).filter((c) => canEditCourse(c, v) && c.status !== 'archived').map((c) => serializeCourse(c))
        : [];
      const completedIds = new Set([...latest.values()].filter((r) => r.e.status === 'completed').map((r) => r.c.id));
      return {
        enrolments: [...latest.values()].map(({ e, c }) => ({
          id: e.id, status: e.status, progressPct: e.progressPct, dueAt: iso(e.dueAt), overdue: !!(e.dueAt && e.dueAt < now && e.status === 'active'), completedAt: iso(e.completedAt), expiresAt: iso(e.expiresAt), source: e.source,
          course: { id: c.id, title: c.title, summary: c.summary, estimatedMinutes: c.estimatedMinutes, category: c.category, coverUrl: c.coverUrl },
        })),
        catalogue: catalogue.filter((c) => !latest.has(c.id) && !(c.visibility === 'public' && c.priceMinor)).map((c) => serializeCourse(c, { locked: c.prerequisiteIds.some((p) => !completedIds.has(p)) })),
        paths: paths.map((p) => ({ id: p.id, title: p.title, description: p.description, courses: p.courseIds.map((id) => ({ id, title: catalogue.find((c) => c.id === id)?.title ?? '', completed: completedIds.has(id) })) })),
        certificates: certs.map((c) => ({ id: c.id, code: c.code, courseTitle: c.courseTitle, issuedAt: c.issuedAt.toISOString(), expiresAt: iso(c.expiresAt), valid: !c.revokedAt && (!c.expiresAt || c.expiresAt > now) })),
        authoring,
        can: { author: v.perms.has('training.author'), manage: v.orgPerms.has('training.manage'), assign: v.perms.has('training.assign'), leads: v.perms.has('courseleads.read') },
      };
    });

    const courseBody = z.object({
      title: z.string().trim().min(1).max(200), summary: z.string().max(500).nullable().optional(), description: z.string().max(20_000).nullable().optional(), coverUrl: httpUrl.nullable().optional(),
      visibility: z.enum(['internal', 'public']).default('internal'), category: z.string().max(80).nullable().optional(), estimatedMinutes: z.number().int().min(1).max(100_000).nullable().optional(),
      passMark: z.number().int().min(0).max(100).default(80), certificateEnabled: z.boolean().default(true), validityMonths: z.number().int().min(1).max(120).nullable().optional(),
      prerequisiteIds: z.array(z.uuid()).max(20).default([]), trainerUserIds: z.array(z.uuid()).max(20).default([]),
      priceMinor: z.number().int().min(0).max(100_000_000).nullable().optional(), currency: currencyCode.nullable().optional(), saleLocationId: z.uuid().nullable().optional(),
      seats: z.number().int().min(1).max(100_000).nullable().optional(), startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), scheduleNote: z.string().max(500).nullable().optional(),
    });

    async function checkCourseRefs(orgId: string, b: Partial<z.infer<typeof courseBody>>, selfId?: string) {
      if (b.prerequisiteIds?.length) {
        if (selfId && b.prerequisiteIds.includes(selfId)) throw validationError('A course cannot require itself', { prerequisiteIds: 'Remove this course' });
        const rows = await s.db.select({ id: courses.id }).from(courses).where(and(eq(courses.organizationId, orgId), inArray(courses.id, b.prerequisiteIds)));
        if (rows.length !== new Set(b.prerequisiteIds).size) throw validationError('Unknown prerequisite', { prerequisiteIds: 'Unknown course' });
      }
      if (b.trainerUserIds?.length) {
        const members = new Set((await orgViewers(s.db, orgId)).map((x) => x.userId));
        if (!b.trainerUserIds.every((id) => members.has(id))) throw validationError('Trainers must be members of the network', { trainerUserIds: 'Unknown person' });
      }
      if (b.saleLocationId) {
        const [l] = await s.db.select().from(locations).where(and(eq(locations.id, b.saleLocationId), eq(locations.organizationId, orgId)));
        if (!l) throw validationError('Unknown location', { saleLocationId: 'Unknown location' });
        if (b.currency && l.currency !== b.currency) throw validationError(`The price must be in ${l.currency}, the currency of ${l.name}`, { currency: `Use ${l.currency}` });
      }
      if ((b.priceMinor ?? 0) > 0 && !b.currency) throw validationError('Choose a currency for the price', { currency: 'Required' });
    }

    app.post(`${base}/courses`, { schema: { tags, security: secured, params: orgParams, body: courseBody } }, async (req, reply) => {
      const v = await learner(req, req.params.orgId);
      requireNetworkPerm(v, 'training.author');
      await checkCourseRefs(v.organizationId, req.body);
      const slugBase = slugify(req.body.title) || 'course';
      const taken = await s.db.select({ slug: courses.slug }).from(courses).where(and(eq(courses.organizationId, v.organizationId), sql`${courses.slug} like ${`${slugBase}%`}`));
      const slug = taken.some((t) => t.slug === slugBase) ? `${slugBase}-${taken.length + 1}` : slugBase;
      const trainers = req.body.trainerUserIds.length || v.orgPerms.has('training.manage') ? req.body.trainerUserIds : [v.userId];
      const [c] = await s.db.insert(courses).values({ organizationId: v.organizationId, slug, ...req.body, trainerUserIds: trainers, authorId: v.userId, status: 'draft' }).returning();
      await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: 'training.course_created', targetType: 'course', targetId: c!.id });
      reply.code(201);
      return serializeCourse(c!);
    });

    app.get(`${base}/courses`, { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum(['draft', 'pending_approval', 'published', 'archived']).optional() }) } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const rows = (await s.db.select().from(courses).where(and(eq(courses.organizationId, v.organizationId), ...(req.query.status ? [eq(courses.status, req.query.status)] : []))).orderBy(desc(courses.updatedAt))).filter((c) => canSeeCourse(c, v));
      const counts = rows.length ? await s.db.select({ courseId: enrolments.courseId, enrolled: sql<number>`count(*)::int`, completed: sql<number>`count(*) filter (where ${enrolments.status} = 'completed')::int` }).from(enrolments).where(inArray(enrolments.courseId, rows.map((r) => r.id))).groupBy(enrolments.courseId) : [];
      const cm = new Map(counts.map((x) => [x.courseId, x]));
      const authors = await userNames(s.db, rows.map((r) => r.authorId));
      return { items: rows.map((c) => serializeCourse(c, { canEdit: canEditCourse(c, v), authorName: c.authorId ? authors.get(c.authorId) ?? null : null, enrolled: cm.get(c.id)?.enrolled ?? 0, completed: cm.get(c.id)?.completed ?? 0 })) };
    });

    app.get(`${base}/courses/:id`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const c = await loadCourse(s.db, v.organizationId, req.params.id);
      if (!canSeeCourse(c, v)) throw notFound('Course');
      const editor = canEditCourse(c, v);
      const outline = await courseOutline(s.db, c.id);
      const e = await myEnrolment(s.db, c.id, v.userId);
      const done = e ? await s.db.select().from(lessonProgress).where(eq(lessonProgress.enrolmentId, e.id)) : [];
      const doneIds = new Map(done.map((d) => [d.lessonId, d]));
      const trainerNames = await userNames(s.db, c.trainerUserIds);
      return {
        course: serializeCourse(c, { canEdit: editor, canReview: v.orgPerms.has('training.manage'), trainers: c.trainerUserIds.map((id) => ({ id, name: trainerNames.get(id) ?? '' })) }),
        outline: outline.map((m) => ({
          id: m.id, title: m.title, position: m.position,
          lessons: m.lessons.map((l) => ({ id: l.id, title: l.title, kind: l.kind, minutes: l.minutes, position: l.position, completed: doneIds.has(l.id), score: doneIds.get(l.id)?.score ?? null, ...(editor ? { body: l.body, videoUrl: l.videoUrl, attachments: l.attachments, quiz: l.quiz, passMark: l.passMark } : {}) })),
        })),
        enrolment: e ? { id: e.id, status: e.status, progressPct: e.progressPct, dueAt: iso(e.dueAt), completedAt: iso(e.completedAt), expiresAt: iso(e.expiresAt) } : null,
        missingPrerequisites: await missingPrerequisites(s.db, c, v.userId),
      };
    });

    app.patch(`${base}/courses/:id`, { schema: { tags, security: secured, params: idParams, body: courseBody.partial() } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const c = await requireEditable(s.db, v.organizationId, req.params.id, v);
      await checkCourseRefs(v.organizationId, { ...req.body, currency: req.body.currency ?? c.currency, saleLocationId: req.body.saleLocationId === undefined ? c.saleLocationId : req.body.saleLocationId }, c.id);
      const [u] = await s.db.update(courses).set({ ...req.body, updatedAt: new Date() }).where(eq(courses.id, c.id)).returning();
      return serializeCourse(u!);
    });

    app.post(`${base}/courses/:id/submit`, { schema: { tags, security: secured, params: idParams, summary: 'Author: send the course to HQ for approval' } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const c = await requireEditable(s.db, v.organizationId, req.params.id, v);
      if (c.status !== 'draft') throw conflict('invalid_state', `This course is ${c.status.replace('_', ' ')}`);
      const outline = await courseOutline(s.db, c.id);
      if (!outline.some((m) => m.lessons.length)) throw conflict('course_empty', 'Add at least one lesson before submitting');
      const badQuiz = outline.flatMap((m) => m.lessons).find((l) => l.kind === 'quiz' && !l.quiz?.length);
      if (badQuiz) throw conflict('quiz_empty', `The quiz “${badQuiz.title}” has no questions`);
      const [u] = await s.db.update(courses).set({ status: 'pending_approval', submittedAt: new Date(), reviewComment: null, updatedAt: new Date() }).where(eq(courses.id, c.id)).returning();
      const reviewers = (await orgViewers(s.db, v.organizationId)).filter((x) => x.orgPerms.has('training.manage')).map((x) => x.userId);
      await networkNotify(s, { organizationId: v.organizationId, userIds: reviewers, exclude: [v.userId], kind: 'course_approval', title: `Course to review: ${c.title}`, link: `/training?course=${c.id}`, data: { courseId: c.id } });
      await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: 'training.course_submitted', targetType: 'course', targetId: c.id });
      return serializeCourse(u!);
    });

    app.post(`${base}/courses/:id/review`, { schema: { tags, security: secured, params: idParams, body: z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).optional() }), summary: 'HQ: approve publishing (or send back with comments)' } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      requireNetworkPerm(v, 'training.manage', { orgWide: true });
      const c = await loadCourse(s.db, v.organizationId, req.params.id);
      if (c.status !== 'pending_approval' && !(c.status === 'draft' && req.body.decision === 'approve')) throw conflict('invalid_state', `This course is ${c.status.replace('_', ' ')}`);
      if (req.body.decision === 'reject' && !req.body.comment) throw validationError('Tell the author what to change', { comment: 'Required' });
      const now = new Date();
      const [u] = await s.db.update(courses).set(req.body.decision === 'approve'
        ? { status: 'published', approvedBy: v.userId, approvedAt: now, publishedAt: c.publishedAt ?? now, reviewComment: req.body.comment ?? null, updatedAt: now }
        : { status: 'draft', reviewComment: req.body.comment ?? null, updatedAt: now }).where(eq(courses.id, c.id)).returning();
      if (c.authorId) await networkNotify(s, { organizationId: v.organizationId, userIds: [c.authorId], exclude: [v.userId], kind: 'course_reviewed', title: req.body.decision === 'approve' ? `Published: ${c.title}` : `Changes requested: ${c.title}`, body: req.body.comment ?? null, link: `/training?course=${c.id}`, data: { courseId: c.id } });
      await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: `training.course_${req.body.decision === 'approve' ? 'approved' : 'rejected'}`, targetType: 'course', targetId: c.id, metadata: { comment: req.body.comment } });
      return serializeCourse(u!);
    });

    app.post(`${base}/courses/:id/archive`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const c = await requireEditable(s.db, v.organizationId, req.params.id, v);
      if (c.status === 'published' && !v.orgPerms.has('training.manage')) throw forbidden('Only HQ can withdraw a published course');
      const [u] = await s.db.update(courses).set({ status: 'archived', updatedAt: new Date() }).where(eq(courses.id, c.id)).returning();
      return serializeCourse(u!);
    });

    // ── modules & lessons ──
    app.post(`${base}/courses/:id/modules`, { schema: { tags, security: secured, params: idParams, body: z.object({ title: z.string().trim().min(1).max(200), position: z.number().int().min(0).max(1000).optional() }) } }, async (req, reply) => {
      const v = await learner(req, req.params.orgId);
      const c = await requireEditable(s.db, v.organizationId, req.params.id, v);
      const [{ n } = { n: 0 }] = await s.db.select({ n: sql<number>`count(*)::int` }).from(courseModules).where(eq(courseModules.courseId, c.id));
      const [m] = await s.db.insert(courseModules).values({ organizationId: v.organizationId, courseId: c.id, title: req.body.title, position: req.body.position ?? n }).returning();
      reply.code(201);
      return { id: m!.id, title: m!.title, position: m!.position };
    });

    async function moduleFor(v: Viewer, id: string) {
      const [m] = await s.db.select().from(courseModules).where(and(eq(courseModules.id, id), eq(courseModules.organizationId, v.organizationId)));
      if (!m) throw notFound('Module');
      return { m, c: await requireEditable(s.db, v.organizationId, m.courseId, v) };
    }
    app.patch(`${base}/modules/:id`, { schema: { tags, security: secured, params: idParams, body: z.object({ title: z.string().trim().min(1).max(200).optional(), position: z.number().int().min(0).max(1000).optional() }) } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const { m } = await moduleFor(v, req.params.id);
      const [u] = await s.db.update(courseModules).set(req.body).where(eq(courseModules.id, m.id)).returning();
      return { id: u!.id, title: u!.title, position: u!.position };
    });
    app.delete(`${base}/modules/:id`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const { m, c } = await moduleFor(v, req.params.id);
      if (c.status === 'published') throw conflict('course_published', 'Archive or edit lessons instead of removing a module from a published course');
      await s.db.delete(courseModules).where(eq(courseModules.id, m.id));
      return { ok: true };
    });

    const lessonBody = z.object({
      title: z.string().trim().min(1).max(200), kind: z.enum(['text', 'video', 'file', 'quiz']).default('text'), body: z.string().max(100_000).nullable().optional(), videoUrl: httpUrl.nullable().optional(),
      attachments: attachmentsSchema, quiz: quizSchema.nullable().optional(), passMark: z.number().int().min(0).max(100).nullable().optional(), minutes: z.number().int().min(1).max(10_000).nullable().optional(), position: z.number().int().min(0).max(1000).optional(),
    });
    const checkLesson = (b: Partial<z.infer<typeof lessonBody>>) => {
      if (b.kind === 'video' && !b.videoUrl) throw validationError('Add the video link', { videoUrl: 'Required' });
      if (b.kind === 'quiz' && b.quiz) for (const q of b.quiz) if (q.correct.some((i) => i >= q.options.length)) throw validationError('A correct answer points to a missing option', { quiz: `Check question “${q.prompt.slice(0, 40)}”` });
    };
    app.post(`${base}/modules/:id/lessons`, { schema: { tags, security: secured, params: idParams, body: lessonBody } }, async (req, reply) => {
      const v = await learner(req, req.params.orgId);
      const { m, c } = await moduleFor(v, req.params.id);
      checkLesson(req.body);
      const [{ n } = { n: 0 }] = await s.db.select({ n: sql<number>`count(*)::int` }).from(courseLessons).where(eq(courseLessons.moduleId, m.id));
      const [l] = await s.db.insert(courseLessons).values({ organizationId: v.organizationId, courseId: c.id, moduleId: m.id, ...req.body, position: req.body.position ?? n }).returning();
      reply.code(201);
      return { id: l!.id, title: l!.title, kind: l!.kind, position: l!.position };
    });

    async function lessonFor(v: Viewer, id: string) {
      const [l] = await s.db.select().from(courseLessons).where(and(eq(courseLessons.id, id), eq(courseLessons.organizationId, v.organizationId)));
      if (!l) throw notFound('Lesson');
      return l;
    }
    app.patch(`${base}/lessons/:id`, { schema: { tags, security: secured, params: idParams, body: lessonBody.partial().extend({ moduleId: z.uuid().optional() }) } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const l = await lessonFor(v, req.params.id);
      await requireEditable(s.db, v.organizationId, l.courseId, v);
      checkLesson({ kind: l.kind as 'text', videoUrl: l.videoUrl, ...req.body });
      if (req.body.moduleId) {
        const [m] = await s.db.select().from(courseModules).where(and(eq(courseModules.id, req.body.moduleId), eq(courseModules.courseId, l.courseId)));
        if (!m) throw validationError('Unknown module', { moduleId: 'Unknown module' });
      }
      const [u] = await s.db.update(courseLessons).set(req.body).where(eq(courseLessons.id, l.id)).returning();
      return { id: u!.id, title: u!.title, kind: u!.kind, position: u!.position };
    });
    app.delete(`${base}/lessons/:id`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const l = await lessonFor(v, req.params.id);
      const c = await requireEditable(s.db, v.organizationId, l.courseId, v);
      if (c.status === 'published') throw conflict('course_published', 'Lessons can’t be removed from a published course');
      await s.db.delete(courseLessons).where(eq(courseLessons.id, l.id));
      return { ok: true };
    });

    // ── learning ──
    app.post(`${base}/courses/:id/start`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const c = await loadCourse(s.db, v.organizationId, req.params.id);
      if (!canSeeCourse(c, v)) throw notFound('Course');
      const e = await startCourse(s.db, c, v);
      if (!e.startedAt) await s.db.update(enrolments).set({ startedAt: new Date() }).where(eq(enrolments.id, e.id));
      return { id: e.id, status: e.status, progressPct: e.progressPct };
    });

    async function learnerContext(v: Viewer, lessonId: string) {
      const l = await lessonFor(v, lessonId);
      const c = await loadCourse(s.db, v.organizationId, l.courseId);
      if (!canSeeCourse(c, v)) throw notFound('Lesson');
      const e = await myEnrolment(s.db, c.id, v.userId);
      return { l, c, e };
    }

    app.get(`${base}/lessons/:id`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const { l, c, e } = await learnerContext(v, req.params.id);
      if (!e && !canEditCourse(c, v)) throw conflict('not_enrolled', 'Start the course first');
      const outline = await courseOutline(s.db, c.id);
      const flat = outline.flatMap((m) => m.lessons);
      const i = flat.findIndex((x) => x.id === l.id);
      const [p] = e ? await s.db.select().from(lessonProgress).where(and(eq(lessonProgress.enrolmentId, e.id), eq(lessonProgress.lessonId, l.id))) : [];
      const attempts = e ? await s.db.select().from(quizAttempts).where(and(eq(quizAttempts.enrolmentId, e.id), eq(quizAttempts.lessonId, l.id))).orderBy(desc(quizAttempts.createdAt)) : [];
      return {
        id: l.id, courseId: c.id, courseTitle: c.title, title: l.title, kind: l.kind, body: l.body, videoUrl: l.videoUrl, attachments: l.attachments, minutes: l.minutes,
        quiz: l.kind === 'quiz' ? learnerQuiz(l.quiz) : null, passMark: l.kind === 'quiz' ? l.passMark ?? c.passMark : null,
        completed: !!p, score: p?.score ?? null, attempts: attempts.map((a) => ({ score: a.score, passed: a.passed, at: a.createdAt.toISOString() })),
        previousId: flat[i - 1]?.id ?? null, nextId: flat[i + 1]?.id ?? null, enrolment: e ? { id: e.id, status: e.status, progressPct: e.progressPct } : null,
      };
    });

    app.post(`${base}/lessons/:id/complete`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const { l, e } = await learnerContext(v, req.params.id);
      if (!e) throw conflict('not_enrolled', 'Start the course first');
      const u = await completeLesson(s, e, l);
      return { enrolment: { id: u.id, status: u.status, progressPct: u.progressPct, completedAt: iso(u.completedAt) } };
    });

    app.post(`${base}/lessons/:id/quiz`, { schema: { tags, security: secured, params: idParams, body: z.object({ answers: z.record(z.string(), z.array(z.number().int().min(0).max(7)).max(8)) }) } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const { l, c, e } = await learnerContext(v, req.params.id);
      if (!e) throw conflict('not_enrolled', 'Start the course first');
      const r = await submitQuiz(s, e, l, c, req.body.answers);
      const [cert] = r.enrolment.status === 'completed' ? await s.db.select().from(certificates).where(eq(certificates.enrolmentId, e.id)) : [];
      return { score: r.score, passed: r.passed, passMark: r.passMark, results: r.results, enrolment: { id: r.enrolment.id, status: r.enrolment.status, progressPct: r.enrolment.progressPct }, certificate: cert ? { id: cert.id, code: cert.code } : null };
    });

    app.get(`${base}/certificates/:id/pdf`, { schema: { tags, security: secured, params: idParams, summary: 'Certificate as a PDF' } }, async (req, reply) => {
      const v = await learner(req, req.params.orgId);
      const [c] = await s.db.select().from(certificates).where(and(eq(certificates.id, req.params.id), eq(certificates.organizationId, v.organizationId)));
      if (!c || (c.userId !== v.userId && !v.orgPerms.has('training.manage') && !v.perms.has('training.assign'))) throw notFound('Certificate');
      const [org] = await s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, v.organizationId));
      const pdf = certificatePdf({ brand: org?.name ?? '', learnerName: c.learnerName, courseTitle: c.courseTitle, issuedOn: c.issuedAt.toISOString().slice(0, 10), expiresOn: c.expiresAt?.toISOString().slice(0, 10) ?? null, code: c.code, verifyUrl: `${s.cfg.PUBLIC_API_URL}/v1/public/certificates/${c.code}` });
      reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="certificate-${c.code}.pdf"`);
      return reply.send(pdf);
    });

    // ── paths & assignments ──
    app.get(`${base}/paths`, { schema: { tags, security: secured, params: orgParams } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const rows = await s.db.select().from(learningPaths).where(eq(learningPaths.organizationId, v.organizationId)).orderBy(asc(learningPaths.title));
      return { items: rows.filter((p) => p.status === 'published' || v.orgPerms.has('training.manage')).map((p) => ({ id: p.id, title: p.title, description: p.description, courseIds: p.courseIds, status: p.status })) };
    });
    const pathBody = z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(2000).nullable().optional(), courseIds: z.array(z.uuid()).min(1).max(50), status: z.enum(['draft', 'published', 'archived']).default('published') });
    app.post(`${base}/paths`, { schema: { tags, security: secured, params: orgParams, body: pathBody } }, async (req, reply) => {
      const v = await learner(req, req.params.orgId);
      requireNetworkPerm(v, 'training.manage', { orgWide: true });
      const rows = await s.db.select({ id: courses.id }).from(courses).where(and(eq(courses.organizationId, v.organizationId), inArray(courses.id, req.body.courseIds)));
      if (rows.length !== new Set(req.body.courseIds).size) throw validationError('Unknown course in path', { courseIds: 'Unknown course' });
      const [p] = await s.db.insert(learningPaths).values({ organizationId: v.organizationId, ...req.body, createdBy: v.userId }).returning();
      reply.code(201);
      return { id: p!.id, title: p!.title, courseIds: p!.courseIds, status: p!.status };
    });
    app.patch(`${base}/paths/:id`, { schema: { tags, security: secured, params: idParams, body: pathBody.partial() } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      requireNetworkPerm(v, 'training.manage', { orgWide: true });
      const [p] = await s.db.update(learningPaths).set({ ...req.body, updatedAt: new Date() }).where(and(eq(learningPaths.id, req.params.id), eq(learningPaths.organizationId, v.organizationId))).returning();
      if (!p) throw notFound('Learning path');
      return { id: p.id, title: p.title, courseIds: p.courseIds, status: p.status };
    });

    const assignBody = z.object({ targetType: z.enum(['course', 'path']), targetId: z.uuid(), audience: audienceSchema, dueAt: isoDateTime.nullable().optional(), dueInDays: z.number().int().min(1).max(730).nullable().optional() });
    app.post(`${base}/assignments`, { schema: { tags, security: secured, params: orgParams, body: assignBody, summary: 'Assign a course or path to roles / locations / owner groups / people (managers: within their scope)' } }, async (req, reply) => {
      const v = await learner(req, req.params.orgId);
      requireNetworkPerm(v, 'training.assign');
      const audience = await validateAudience(s.db, v.organizationId, req.body.audience, v.orgPerms.has('training.assign') ? undefined : v);
      const r = await assignTraining(s, v.organizationId, { ...req.body, audience, dueAt: req.body.dueAt ? new Date(req.body.dueAt) : null }, v.userId);
      reply.code(201);
      return { id: r.assignment.id, people: r.people, enrolled: r.enrolled };
    });

    app.post(`${base}/paths/:id/assign`, {
      schema: { tags, security: secured, params: idParams, body: z.object({ ownerGroupId: z.uuid().optional(), locationId: z.uuid().optional(), userIds: z.array(z.uuid()).max(100).optional(), roles: z.array(z.string().max(40)).max(10).optional(), dueInDays: z.number().int().min(1).max(730).nullable().optional(), dueAt: isoDateTime.nullable().optional(), source: z.enum(['manual', 'onboarding']).default('manual'), sourceRef: z.string().max(200).nullable().optional() }), summary: 'Hook for onboarding: assign a learning path to a new franchisee (owner group), a location or named people' },
    }, async (req, reply) => {
      const v = await learner(req, req.params.orgId);
      requireNetworkPerm(v, 'training.assign');
      const b = req.body;
      if (!b.ownerGroupId && !b.locationId && !b.userIds?.length) throw validationError('Choose an owner group, a location or people', { ownerGroupId: 'Required' });
      const audience = await validateAudience(s.db, v.organizationId, { ...(b.ownerGroupId ? { ownerGroupIds: [b.ownerGroupId] } : {}), ...(b.locationId ? { locationIds: [b.locationId] } : {}), ...(b.userIds?.length ? { userIds: b.userIds } : {}), ...(b.roles?.length ? { roles: b.roles } : {}) }, v.orgPerms.has('training.assign') ? undefined : v);
      const r = await assignTraining(s, v.organizationId, { targetType: 'path', targetId: req.params.id, audience, dueAt: b.dueAt ? new Date(b.dueAt) : null, dueInDays: b.dueInDays ?? null, source: b.source, sourceRef: b.sourceRef ?? null }, v.userId);
      reply.code(201);
      return { id: r.assignment.id, people: r.people, enrolled: r.enrolled };
    });

    app.get(`${base}/assignments`, { schema: { tags, security: secured, params: orgParams } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      requireNetworkPerm(v, 'training.assign');
      const rows = await s.db.select().from(trainingAssignments).where(eq(trainingAssignments.organizationId, v.organizationId)).orderBy(desc(trainingAssignments.createdAt));
      const visible = v.orgPerms.has('training.assign') ? rows : rows.filter((a) => a.assignedBy === v.userId);
      const cs = await s.db.select({ id: courses.id, title: courses.title }).from(courses).where(eq(courses.organizationId, v.organizationId));
      const ps = await s.db.select({ id: learningPaths.id, title: learningPaths.title }).from(learningPaths).where(eq(learningPaths.organizationId, v.organizationId));
      const title = new Map([...cs, ...ps].map((x) => [x.id, x.title]));
      return { items: visible.map((a) => ({ id: a.id, targetType: a.targetType, targetId: a.targetId, title: title.get(a.targetId) ?? '', audience: audienceSummary(a.audience), dueAt: iso(a.dueAt), dueInDays: a.dueInDays, source: a.source, createdAt: a.createdAt.toISOString() })) };
    });

    app.delete(`${base}/assignments/:id`, { schema: { tags, security: secured, params: idParams, summary: 'Remove an assignment (enrolments already started are kept)' } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      requireNetworkPerm(v, 'training.assign');
      const [a] = await s.db.select().from(trainingAssignments).where(and(eq(trainingAssignments.id, req.params.id), eq(trainingAssignments.organizationId, v.organizationId)));
      if (!a || (!v.orgPerms.has('training.assign') && a.assignedBy !== v.userId)) throw notFound('Assignment');
      await s.db.delete(trainingAssignments).where(eq(trainingAssignments.id, a.id));
      await s.db.update(enrolments).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(enrolments.assignmentId, a.id), eq(enrolments.status, 'active'), eq(enrolments.progressPct, 0)));
      return { ok: true };
    });

    // ── reports ──
    const reportScope = (v: Viewer): 'all' | Set<string> => {
      if (v.orgPerms.has('training.manage') || v.orgPerms.has('training.assign')) return 'all';
      requireNetworkPerm(v, 'training.assign');
      return v.locationIds;
    };
    app.get(`${base}/reports/completion`, { schema: { tags, security: secured, params: orgParams, querystring: z.object({ courseId: z.uuid().optional() }), summary: 'Completion per location (HQ: the network; managers: their locations)' } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const scope = reportScope(v);
      const rows = await completionReport(s.db, v.organizationId, scope, req.query.courseId);
      const locs = await s.db.select({ id: locations.id, name: locations.name, code: locations.code }).from(locations).where(eq(locations.organizationId, v.organizationId));
      const lm = new Map(locs.map((l) => [l.id, l]));
      return { items: rows.map((r) => ({ ...r, locationName: lm.get(r.locationId)?.name ?? '', locationCode: lm.get(r.locationId)?.code ?? '' })).sort((a, b) => a.locationName.localeCompare(b.locationName)) };
    });

    app.get(`${base}/reports/people`, { schema: { tags, security: secured, params: orgParams, querystring: z.object({ courseId: z.uuid().optional(), locationId: z.uuid().optional() }) } }, async (req) => {
      const v = await learner(req, req.params.orgId);
      const scope = reportScope(v);
      if (req.query.locationId && scope !== 'all' && !scope.has(req.query.locationId)) throw notFound('Location');
      const people = (await orgViewers(s.db, v.organizationId)).filter((x) => !x.hq && x.perms.has('training.learn') && [...x.locationIds].some((l) => (scope === 'all' || scope.has(l)) && (!req.query.locationId || l === req.query.locationId)));
      if (!people.length) return { items: [] };
      const rows = await s.db.select({ e: enrolments, title: courses.title }).from(enrolments).innerJoin(courses, eq(courses.id, enrolments.courseId))
        .where(and(eq(enrolments.organizationId, v.organizationId), inArray(enrolments.userId, people.map((p) => p.userId)), ne(enrolments.status, 'cancelled'), ...(req.query.courseId ? [eq(enrolments.courseId, req.query.courseId)] : [])));
      const names = await userNames(s.db, people.map((p) => p.userId));
      const now = new Date();
      return {
        items: people.map((p) => ({
          userId: p.userId, name: names.get(p.userId) ?? '', roles: [...p.roles], locationIds: [...p.locationIds],
          courses: rows.filter((r) => r.e.userId === p.userId).map((r) => ({ courseId: r.e.courseId, title: r.title, status: r.e.status, progressPct: r.e.progressPct, dueAt: iso(r.e.dueAt), overdue: !!(r.e.dueAt && r.e.dueAt < now && r.e.status === 'active'), completedAt: iso(r.e.completedAt), expiresAt: iso(r.e.expiresAt) })),
        })).sort((a, b) => a.name.localeCompare(b.name)),
      };
    });
    // Course leads are worked in Sales → Course leads (/orgs/:orgId/sales/leads?kind=course).
  });
};

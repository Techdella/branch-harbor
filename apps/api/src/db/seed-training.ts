/**
 * Demo seed for the Training academy: Stillwater Yoga's internal courses (with videos, files and quizzes), a learning
 * path for new franchisees, assignments, progress and certificates, a course waiting for HQ approval, and the public
 * 200-hour teacher training sold on the brand site with leads from the spring ad campaign. Sample data only.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';

type User = typeof t.users.$inferSelect;
export interface TrainingSeedCtx { db: Db; swId: string; meId: string; demo: User; maya: User; lena: User; jamie: User; elena: User; aisha: User; tom: User }

const D = 86_400_000;
type LessonSeed = { title: string; kind: 'text' | 'video' | 'file' | 'quiz'; body?: string; videoUrl?: string; minutes?: number; attachments?: t.Attachment[]; quiz?: t.QuizQuestion[] };

export async function seedTraining(c: TrainingSeedCtx) {
  const { db, swId } = c;
  const ago = (ms: number) => new Date(Date.now() - ms);
  const byEmail = async (e: string) => (await db.select().from(t.users).where(eq(t.users.email, e)))[0];
  const sam = await byEmail('sam.tran@demo.branchharbor.com');
  const jordan = await byEmail('jordan.lee@demo.branchharbor.com');
  const locs = await db.select().from(t.locations).where(eq(t.locations.organizationId, swId));
  const qw = locs.find((l) => l.code === 'TOR-QW')!;
  const groups = await db.select().from(t.ownerGroups).where(eq(t.ownerGroups.organizationId, swId));

  const course = async (p: Partial<typeof t.courses.$inferInsert> & { title: string; slug: string }, modules: Array<{ title: string; lessons: LessonSeed[] }>) => {
    const [row] = await db.insert(t.courses).values({ organizationId: swId, status: 'published', authorId: c.lena.id, trainerUserIds: [c.lena.id], approvedBy: c.demo.id, approvedAt: ago(30 * D), publishedAt: ago(30 * D), ...p }).returning();
    const lessons: Array<typeof t.courseLessons.$inferSelect> = [];
    for (const [mi, m] of modules.entries()) {
      const [mod] = await db.insert(t.courseModules).values({ organizationId: swId, courseId: row!.id, title: m.title, position: mi }).returning();
      if (m.lessons.length) lessons.push(...(await db.insert(t.courseLessons).values(m.lessons.map((l, li) => ({ organizationId: swId, courseId: row!.id, moduleId: mod!.id, position: li, attachments: [], ...l }))).returning()));
    }
    return { course: row!, lessons };
  };

  const day = await course({ title: 'Running your day in BranchHarbor', slug: 'running-your-day', summary: 'Check-in, waitlists, cover requests and cash-up.', category: 'Operations', estimatedMinutes: 25, authorId: c.jamie.id, trainerUserIds: [c.jamie.id] }, [
    { title: 'Front desk', lessons: [
      { title: 'Opening the day', kind: 'video', videoUrl: 'https://www.youtube.com/watch?v=stillwater-open', minutes: 6, body: 'How to open the day, check the schedule and see who is on the waitlist.' },
      { title: 'Checking members in', kind: 'text', minutes: 5, body: 'Search by name or scan the member QR code. Late arrivals within 10 minutes can still be checked in.' },
    ] },
    { title: 'Wrap-up', lessons: [
      { title: 'Quick check', kind: 'quiz', minutes: 4, quiz: [
        { id: 'q1', prompt: 'A member arrives 8 minutes late. What do you do?', options: ['Turn them away', 'Check them in and let the teacher know', 'Mark a no-show'], correct: [1] },
        { id: 'q2', prompt: 'Where do you see who is on the waitlist?', options: ['On the class in the schedule', 'In Reports only'], correct: [0] },
      ] },
    ] },
  ]);
  const brand = await course({ title: 'Brand standards v4.0', slug: 'brand-standards-v4', summary: 'Logo, colour, photography and class names.', category: 'Brand', estimatedMinutes: 15, validityMonths: 12, authorId: c.elena.id, trainerUserIds: [c.elena.id] }, [
    { title: 'The guide', lessons: [
      { title: 'What changed in v4.0', kind: 'file', minutes: 8, body: 'Read the guide, then take the quiz.', attachments: [{ name: 'Brand standards v4.0.pdf', url: 'https://example.com/stillwater/brand-standards-v4.pdf', mimeType: 'application/pdf' }] },
      { title: 'Brand quiz', kind: 'quiz', minutes: 5, quiz: [
        { id: 'q1', prompt: 'What is the lime accent reserved for?', options: ['Backgrounds', 'Calls to action', 'Body text'], correct: [1] },
        { id: 'q2', prompt: 'Which photography is allowed? (choose all that apply)', options: ['Natural light studio shots', 'Stock photos with filters', 'Real members with consent'], correct: [0, 2] },
        { id: 'q3', prompt: 'Class names follow…', options: ['The naming guide', 'Each teacher’s choice'], correct: [0] },
      ] },
    ] },
  ]);
  const privacy = await course({ title: 'Customer privacy basics', slug: 'customer-privacy-basics', summary: 'What member data you may see and share.', category: 'Compliance', estimatedMinutes: 12, validityMonths: 12 }, [
    { title: 'Privacy', lessons: [
      { title: 'Personal data at the front desk', kind: 'text', minutes: 6, body: 'Only look up what you need to serve the member in front of you. Never share contact details or health notes.' },
      { title: 'Privacy quiz', kind: 'quiz', minutes: 4, quiz: [{ id: 'q1', prompt: 'A caller asks for a member’s phone number. You…', options: ['Give it if they say they are family', 'Never share it; offer to pass on a message'], correct: [1] }] },
    ] },
  ]);
  const owner = await course({ title: 'Franchise owner foundations', slug: 'franchise-owner-foundations', summary: 'Royalties, reporting, local marketing and your first 90 days.', category: 'Franchise onboarding', estimatedMinutes: 90, prerequisiteIds: [brand.course.id], authorId: c.lena.id }, [
    { title: 'Your first 90 days', lessons: [
      { title: 'How HQ supports you', kind: 'video', videoUrl: 'https://vimeo.com/000000000', minutes: 12 },
      { title: 'Reading your royalty statement', kind: 'text', minutes: 10, body: 'Royalties are 6% of gross class and membership revenue, invoiced monthly in your local currency.' },
    ] },
    { title: 'Teaching standards', lessons: [{ title: 'Observing classes', kind: 'text', minutes: 15, body: 'Observe each teacher once per quarter using the class observation form.' }] },
  ]);
  // A course the trainer has submitted and HQ still has to approve.
  await course({ title: 'Prenatal yoga: safe sequencing', slug: 'prenatal-safe-sequencing', status: 'pending_approval', approvedBy: null, approvedAt: null, publishedAt: null, submittedAt: ago(D), summary: 'Contraindications and modifications by trimester.', category: 'Teaching', estimatedMinutes: 45 }, [
    { title: 'Sequencing', lessons: [{ title: 'Trimester by trimester', kind: 'text', minutes: 20, body: 'First trimester: avoid overheating…' }] },
  ]);
  // Public teacher training sold on the brand site (payments through Queen West).
  const ytt = await course({
    title: '200-Hour Yoga Teacher Training (Spring cohort)', slug: '200-hour-teacher-training', visibility: 'public', category: 'Teacher training', summary: 'Become a certified yoga teacher in 12 weekends with Lena Okafor.',
    description: 'Our Yoga Alliance–registered 200-hour programme: anatomy, sequencing, philosophy and lots of practice teaching. Weekends at Queen West, Toronto, from February to May. Includes the course manual and mentoring.',
    priceMinor: 349900, currency: 'CAD', saleLocationId: qw.id, seats: 24, startsOn: '2027-02-06', scheduleNote: '12 weekends · Saturdays and Sundays 9:00–17:00', estimatedMinutes: 12_000, validityMonths: null,
  }, [
    { title: 'Weekend 1: Foundations', lessons: [{ title: 'Welcome and course manual', kind: 'file', minutes: 30, attachments: [{ name: 'YTT manual.pdf', url: 'https://example.com/stillwater/ytt-manual.pdf', mimeType: 'application/pdf' }] }] },
    { title: 'Weekend 2: Anatomy', lessons: [{ title: 'The spine in movement', kind: 'video', videoUrl: 'https://www.youtube.com/watch?v=stillwater-anatomy', minutes: 45 }] },
  ]);

  // Learning path for new franchisees (the onboarding hook assigns it to each new owner group).
  const [path] = await db.insert(t.learningPaths).values({ organizationId: swId, title: 'New franchisee onboarding', description: 'Everything a new owner completes before opening.', courseIds: [brand.course.id, owner.course.id, privacy.course.id], createdBy: c.demo.id }).returning();

  // Assignments: all staff take "Running your day" and "Brand standards"; privacy for everyone; path to Lakeshore.
  const [aDay, aBrand, , aPath] = await db.insert(t.trainingAssignments).values([
    { organizationId: swId, targetType: 'course', targetId: day.course.id, audience: { roles: ['staff', 'location_manager'] }, dueInDays: 14, assignedBy: c.jamie.id },
    { organizationId: swId, targetType: 'course', targetId: brand.course.id, audience: {}, dueAt: new Date(Date.now() + 9 * D), assignedBy: c.elena.id },
    { organizationId: swId, targetType: 'course', targetId: privacy.course.id, audience: { roles: ['staff'] }, dueAt: ago(2 * D), assignedBy: c.jamie.id },
    { organizationId: swId, targetType: 'path', targetId: path!.id, audience: { ownerGroupIds: [groups.find((g) => g.name === 'Lakeshore Holdings')!.id], roles: ['franchise_owner'] }, dueInDays: 60, source: 'onboarding', sourceRef: 'leslieville-opening', assignedBy: c.demo.id },
  ]).returning();

  // Progress: Sam completed two courses (with certificates), Maya is half-way, Jordan is overdue on privacy.
  const enrol = async (u: User | undefined, courseRow: typeof t.courses.$inferSelect, lessons: typeof day.lessons, opts: { assignmentId?: string; done: number; dueAt?: Date | null; completedAgo?: number }) => {
    if (!u) return;
    const all = opts.done >= lessons.length;
    const completedAt = all ? ago(opts.completedAgo ?? 3 * D) : null;
    const expiresAt = all && courseRow.validityMonths ? new Date(completedAt!.getTime() + courseRow.validityMonths * 30 * D) : null;
    const [e] = await db.insert(t.enrolments).values({ organizationId: swId, courseId: courseRow.id, userId: u.id, source: 'assignment', assignmentId: opts.assignmentId ?? null, status: all ? 'completed' : 'active', dueAt: opts.dueAt ?? null, startedAt: opts.done ? ago(6 * D) : null, completedAt, expiresAt, progressPct: Math.round((Math.min(opts.done, lessons.length) / lessons.length) * 100) }).returning();
    if (opts.done) await db.insert(t.lessonProgress).values(lessons.slice(0, opts.done).map((l) => ({ organizationId: swId, enrolmentId: e!.id, lessonId: l.id, completedAt: ago(5 * D), score: l.kind === 'quiz' ? 100 : null })));
    for (const l of lessons.slice(0, opts.done).filter((x) => x.kind === 'quiz')) await db.insert(t.quizAttempts).values({ organizationId: swId, enrolmentId: e!.id, lessonId: l.id, answers: Object.fromEntries((l.quiz ?? []).map((q) => [q.id, q.correct])), score: 100, passed: true, createdAt: ago(5 * D) });
    if (all) await db.insert(t.certificates).values({ organizationId: swId, enrolmentId: e!.id, courseId: courseRow.id, userId: u.id, code: randomBytes(6).toString('hex').toUpperCase().replace(/(.{4})(?=.)/g, '$1-'), learnerName: u.name, courseTitle: courseRow.title, issuedAt: completedAt!, expiresAt });
  };
  await enrol(sam, day.course, day.lessons, { assignmentId: aDay!.id, done: 99, completedAgo: 10 * D });
  await enrol(sam, brand.course, brand.lessons, { assignmentId: aBrand!.id, done: 99, completedAgo: 2 * D });
  await enrol(c.maya, day.course, day.lessons, { assignmentId: aDay!.id, done: 2, dueAt: new Date(Date.now() + 5 * D) });
  await enrol(jordan, privacy.course, privacy.lessons, { done: 0, dueAt: ago(2 * D) });
  await enrol(c.aisha, brand.course, brand.lessons, { assignmentId: aPath!.id, done: 99, completedAgo: 20 * D });
  await enrol(c.aisha, owner.course, owner.lessons, { assignmentId: aPath!.id, done: 1, dueAt: new Date(Date.now() + 40 * D) });

  // Public teacher training: two paid enrolments and leads from the spring ad campaign, assigned to Lena.
  for (const [i, buyer] of [['Priya Shah', 'priya.shah@example.com'], ['Marcus Hill', 'marcus.hill@example.com']].entries()) {
    const [e] = await db.insert(t.enrolments).values({ organizationId: swId, courseId: ytt.course.id, learnerName: buyer[0], learnerEmail: buyer[1], source: 'public_purchase', status: 'active', amountMinor: 349900, currency: 'CAD', startedAt: ago((i + 1) * 4 * D) }).returning();
    const [p] = await db.insert(t.paymentReferences).values({ organizationId: swId, locationId: qw.id, provider: 'stripe', externalId: `pi_seed_${randomBytes(8).toString('hex')}`, connectedAccountId: qw.stripeAccountId, amountMinor: 349900, currency: 'CAD', applicationFeeMinor: 3499, state: 'succeeded', succeededAt: ago((i + 1) * 4 * D), targetType: 'course_enrolment', targetId: e!.id, sandbox: 1 }).returning();
    await db.update(t.enrolments).set({ paymentId: p!.id }).where(eq(t.enrolments.id, e!.id));
  }
  await db.insert(t.leads).values([
    { organizationId: swId, kind: 'course', locationId: qw.id, courseId: ytt.course.id, name: 'Priya Shah', email: 'priya.shah@example.com', source: 'ad_campaign', campaign: 'ytt-spring', utm: { source: 'meta', campaign: 'ytt-spring' }, assignedUserId: c.lena.id, status: 'converted', createdAt: ago(9 * D) },
    { organizationId: swId, kind: 'course', locationId: qw.id, courseId: ytt.course.id, name: 'Chloé Martin', email: 'chloe.martin@example.com', phone: '+1 416 555 0133', message: 'Is there a payment plan?', source: 'ad_campaign', campaign: 'ytt-spring', utm: { source: 'meta', medium: 'paid_social', campaign: 'ytt-spring' }, assignedUserId: c.lena.id, status: 'new', marketingConsent: true, createdAt: ago(5 * 3600_000) },
    { organizationId: swId, kind: 'course', locationId: qw.id, courseId: ytt.course.id, name: 'Devon Brooks', email: 'devon.brooks@example.com', message: 'Can I join if I practise twice a week?', source: 'ad_campaign', campaign: 'ytt-spring', utm: { source: 'google', medium: 'cpc', campaign: 'ytt-spring' }, assignedUserId: c.lena.id, status: 'contacted', notes: 'Called 14 Oct — sending the syllabus.', createdAt: ago(2 * D) },
    { organizationId: swId, kind: 'course', locationId: qw.id, courseId: ytt.course.id, name: 'Hannah Wolf', email: 'hannah.wolf@example.com', source: 'website', assignedUserId: c.lena.id, status: 'new', createdAt: ago(D) },
  ]);

  // Maple & Ember: one food-safety course with a quiz, assigned to every kitchen.
  const [fs] = await db.insert(t.courses).values({ organizationId: c.meId, slug: 'food-safety-refresher', title: 'Food safety refresher', summary: 'Temperatures, allergens and cleaning.', status: 'published', category: 'Compliance', estimatedMinutes: 20, validityMonths: 12, authorId: c.demo.id, approvedBy: c.demo.id, approvedAt: ago(10 * D), publishedAt: ago(10 * D) }).returning();
  const [fm] = await db.insert(t.courseModules).values({ organizationId: c.meId, courseId: fs!.id, title: 'Essentials' }).returning();
  await db.insert(t.courseLessons).values([
    { organizationId: c.meId, courseId: fs!.id, moduleId: fm!.id, title: 'Danger zone temperatures', kind: 'text', position: 0, body: 'Keep cold food at or below 5°C and hot food at or above 63°C.' },
    { organizationId: c.meId, courseId: fs!.id, moduleId: fm!.id, title: 'Quick check', kind: 'quiz', position: 1, quiz: [{ id: 'q1', prompt: 'Hot holding temperature?', options: ['50°C', '63°C or above'], correct: [1] }] },
  ]);
  await db.insert(t.trainingAssignments).values({ organizationId: c.meId, targetType: 'course', targetId: fs!.id, audience: {}, dueInDays: 30, assignedBy: c.demo.id });

  return { courses: 6, publicCourse: ytt.course.slug };
}

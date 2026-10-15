/**
 * Northlight Yoga International (demo site only): Community, Training academy, course leads and the help desk, so
 * each demo login lands on real content — the CMO coaches franchise owners, the instructor-trainers write courses and
 * work their own course leads, every studio has announcements to read. Sample data only; called from seed-northlight.ts.
 */
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { slaTargets } from '../services/helpdesk.ts';

type User = typeof t.users.$inferSelect;
type Loc = typeof t.locations.$inferSelect;
const H = 3600_000;
const D = 24 * H;

export interface NorthlightNetworkInput {
  db: Db;
  orgId: string;
  team: { ceo: User; cmo: User; trainer1: User; trainer2: User; foPacific: User; foThames: User; lmKits: User; staffKits: User };
  regions: { na: string; eu: string };
  groups: { pacific: string; thames: string };
  L: Record<string, Loc>;
}

export async function seedNorthlightNetwork({ db, orgId, team, regions, groups, L }: NorthlightNetworkInput) {
  const ago = (ms: number) => new Date(Date.now() - ms);
  const ahead = (ms: number) => new Date(Date.now() + ms);

  // ── Community: the CMO is the owners' marketing coach in both regions ──
  await db.insert(t.accountManagers).values([
    { organizationId: orgId, userId: team.cmo.id, scopeKind: 'region', scopeId: regions.na, title: 'CMO · local marketing coach', bookingUrl: 'https://calendly.com/northlight-hannah/coaching', bio: 'I help studios plan intro offers, local ads and teacher-training launches.' },
    { organizationId: orgId, userId: team.cmo.id, scopeKind: 'region', scopeId: regions.eu, title: 'CMO · local marketing coach', bookingUrl: 'https://calendly.com/northlight-hannah/coaching' },
  ]);
  const anns = await db.insert(t.communityAnnouncements).values([
    { organizationId: orgId, title: 'Hot-room safety update — please read and confirm', authorId: team.ceo.id, requiredRead: true, pinned: true, status: 'published', publishAt: ago(3 * D), notifiedAt: ago(3 * D), dueAt: ahead(7 * D), body: 'Room temperature now caps at 40°C for every heated class. The new hot-room safety course is in Training; complete it by the due date.' },
    { organizationId: orgId, title: 'January intro month: campaign kit is ready', authorId: team.cmo.id, status: 'published', publishAt: ago(D), notifiedAt: ago(D), body: 'Ads, posters and email copy for the January intro month are in the Resource library → Marketing. Book a coaching slot if you want help with local targeting.' },
  ]).returning();
  await db.insert(t.communityAnnouncementReads).values({ organizationId: orgId, announcementId: anns[0]!.id, userId: team.lmKits.id, readAt: ago(2 * D), acknowledgedAt: ago(2 * D) });
  const spaces = await db.insert(t.communitySpaces).values([
    { organizationId: orgId, slug: 'all-studios', name: 'All studios', description: 'Open discussion across the network.', icon: 'hash', position: 1 },
    { organizationId: orgId, slug: 'franchise-owners', name: 'Franchise owners', description: 'Owners and HQ leadership only.', icon: 'briefcase', audience: { roles: ['franchise_owner'] }, position: 2 },
    { organizationId: orgId, slug: 'marketing', name: 'Marketing', description: 'Campaign questions and local ideas.', icon: 'share', position: 3 },
  ]).returning();
  const [th] = await db.insert(t.communityThreads).values({ organizationId: orgId, spaceId: spaces[2]!.id, authorId: team.foPacific.id, title: 'Kitsilano: intro month sold 40 passes', body: 'We boosted the intro month post to a 3 km radius and sold 40 passes in a week.', createdAt: ago(2 * D), lastActivityAt: ago(D), replyCount: 1 }).returning();
  await db.insert(t.communityReplies).values({ organizationId: orgId, threadId: th!.id, authorId: team.cmo.id, body: 'Great result — I will share your targeting as a template for the other studios.', createdAt: ago(D) });
  const folders = await db.insert(t.libraryFolders).values([{ organizationId: orgId, name: 'Marketing', position: 1 }, { organizationId: orgId, name: 'Operations SOPs', position: 2 }]).returning();
  await db.insert(t.libraryResources).values([
    { organizationId: orgId, folderId: folders[0]!.id, kind: 'link', title: 'January intro month campaign kit', summary: 'Ads, posters and email copy.', url: 'https://example.com/northlight/intro-month-kit', tags: ['campaign'] },
    { organizationId: orgId, folderId: folders[1]!.id, kind: 'sop', title: 'Hot-room checklist', summary: 'Before every heated class.', body: '1. Heat to the class temperature (max 40°C).\n2. Check humidity and ventilation.\n3. Water and towels at the door.', tags: ['safety'] },
  ]);
  // Coaching threads: the CMO with each franchise owner group.
  for (const [scopeId, owner, msg] of [[groups.pacific, team.foPacific, 'Liam, your intro month converts at 34% — let’s plan the spring teacher training launch.'], [groups.thames, team.foThames, 'Oliver, for the Dublin opening I suggest a founding-member offer. Shall we review it on Thursday?']] as const) {
    const [c] = await db.insert(t.coachingThreads).values({ organizationId: orgId, scopeKind: 'owner_group', scopeId, managerUserId: team.cmo.id, lastMessageAt: ago(6 * H) }).returning();
    await db.insert(t.coachingMessages).values([
      { organizationId: orgId, threadId: c!.id, authorId: team.cmo.id, body: msg, createdAt: ago(D) },
      { organizationId: orgId, threadId: c!.id, authorId: owner.id, body: 'Sounds good — Thursday works.', createdAt: ago(6 * H) },
    ]);
  }

  // ── Help desk ──
  const [cat] = await db.insert(t.helpdeskCategories).values({ organizationId: orgId, name: 'Studio operations', firstResponseMinutes: 240, resolutionMinutes: 2880, defaultAssigneeId: team.ceo.id }).returning();
  const created = ago(5 * H);
  const [tk] = await db.insert(t.tickets).values({
    organizationId: orgId, number: 2001, locationId: L['YVR-KT']!.id, requesterId: team.lmKits.id, requesterEmail: team.lmKits.email, categoryId: cat!.id, subject: 'Heater in the hot room cycles off',
    priority: 'high', status: 'open', assigneeId: team.ceo.id, ...slaTargets('high', cat!, created), createdAt: created, updatedAt: created,
  }).returning();
  await db.insert(t.ticketMessages).values({ organizationId: orgId, ticketId: tk!.id, authorId: team.lmKits.id, body: 'The heater switches off after 20 minutes in the 17:45 class.', createdAt: created });

  // ── Training academy: an internal course by Sofia, a public teacher training sold at Toronto Annex ──
  const course = async (p: Partial<typeof t.courses.$inferInsert> & { title: string; slug: string; authorId: string }, lessons: Array<{ title: string; kind: 'text' | 'quiz'; body?: string; quiz?: t.QuizQuestion[] }>) => {
    const [row] = await db.insert(t.courses).values({ organizationId: orgId, status: 'published', trainerUserIds: [p.authorId], approvedBy: team.ceo.id, approvedAt: ago(20 * D), publishedAt: ago(20 * D), ...p }).returning();
    const [mod] = await db.insert(t.courseModules).values({ organizationId: orgId, courseId: row!.id, title: 'Lessons', position: 0 }).returning();
    await db.insert(t.courseLessons).values(lessons.map((l, i) => ({ organizationId: orgId, courseId: row!.id, moduleId: mod!.id, position: i, attachments: [], minutes: 5, ...l })));
    return row!;
  };
  const safety = await course({ title: 'Hot-room safety', slug: 'hot-room-safety', summary: 'Temperatures, hydration and when to stop a class.', category: 'Safety', estimatedMinutes: 15, validityMonths: 12, authorId: team.trainer1.id }, [
    { title: 'Before class', kind: 'text', body: 'Check the room is at most 40°C and that water is available at the door.' },
    { title: 'Quick check', kind: 'quiz', quiz: [{ id: 'q1', prompt: 'Maximum room temperature?', options: ['40°C', '45°C'], correct: [0] }] },
  ]);
  await db.insert(t.trainingAssignments).values({ organizationId: orgId, targetType: 'course', targetId: safety.id, audience: { roles: ['staff', 'location_manager'] }, dueAt: ahead(7 * D), assignedBy: team.trainer1.id });
  const ytt = await course({
    title: '200-Hour Hot Yoga Teacher Training', slug: 'hot-yoga-teacher-training', visibility: 'public', category: 'Teacher training', summary: 'Become a certified hot yoga teacher in 10 weekends.', authorId: team.trainer1.id,
    trainerUserIds: [team.trainer1.id, team.trainer2.id], priceMinor: 329900, currency: 'CAD', saleLocationId: L['TOR-AX']!.id, seats: 20, startsOn: '2027-03-06', scheduleNote: '10 weekends at Toronto Annex',
  }, [{ title: 'Welcome', kind: 'text', body: 'Course manual and the first weekend plan.' }]);
  // Course leads from the spring ad campaign, routed to the two trainers.
  await db.insert(t.courseLeads).values([
    { organizationId: orgId, courseId: ytt.id, name: 'Nadia Petrov', email: 'nadia.petrov@example.com', message: 'Is there an early-bird price?', source: 'ad_campaign', campaign: 'ytt-spring', utm: { source: 'meta', campaign: 'ytt-spring' }, assignedTo: team.trainer1.id, status: 'new', marketingConsent: true, createdAt: ago(4 * H) },
    { organizationId: orgId, courseId: ytt.id, name: 'Ben Carter', email: 'ben.carter@example.com', source: 'website', assignedTo: team.trainer1.id, status: 'contacted', notes: 'Sent the syllabus.', createdAt: ago(2 * D) },
    { organizationId: orgId, courseId: ytt.id, name: 'Joanna Wu', email: 'joanna.wu@example.com', source: 'ad_campaign', campaign: 'ytt-spring', utm: { source: 'google', campaign: 'ytt-spring' }, assignedTo: team.trainer2.id, status: 'new', createdAt: ago(D) },
  ]);
  return { courses: 2, publicCourse: ytt.slug, leads: 3 };
}

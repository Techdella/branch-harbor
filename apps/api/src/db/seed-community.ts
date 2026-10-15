/**
 * Demo seed for the network workspaces: Community (announcements with required reads, discussion spaces, resource
 * library, events, account managers and coaching threads) and the Help desk, for the Stillwater Yoga Collective
 * franchise network and the Maple & Ember restaurant group. Sample data only; called from seed.ts.
 */
import { eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { slaTargets, type Priority } from '../services/helpdesk.ts';

type User = typeof t.users.$inferSelect;
export interface CommunitySeedCtx {
  db: Db;
  swId: string;
  meId: string;
  demo: User;
  maya: User;
  priya: User;
  upsertUser: (email: string, name: string, locale?: string) => Promise<User>;
}

const H = 3600_000;
const D = 24 * H;

export async function seedCommunity(c: CommunitySeedCtx) {
  const { db, swId } = c;
  const ago = (ms: number) => new Date(Date.now() - ms);
  const ahead = (ms: number) => new Date(Date.now() + ms);

  // ── People: HQ account managers, the CMO who coaches owners, an instructor-trainer, two franchise owners ──
  const jamie = await c.upsertUser('jamie.morgan@demo.branchharbor.com', 'Jamie Morgan');
  const elena = await c.upsertUser('elena.costa@demo.branchharbor.com', 'Elena Costa');
  const lena = await c.upsertUser('lena.okafor@demo.branchharbor.com', 'Lena Okafor');
  const aisha = await c.upsertUser('aisha.rahman@demo.branchharbor.com', 'Aisha Rahman');
  const tom = await c.upsertUser('tom.becker@demo.branchharbor.com', 'Tom Becker', 'de');
  const byEmail = async (e: string) => (await db.select().from(t.users).where(eq(t.users.email, e)))[0];
  const sam = await byEmail('sam.tran@demo.branchharbor.com');
  const ava = await byEmail('ava.diaz@demo.branchharbor.com');

  const locs = await db.select().from(t.locations).where(eq(t.locations.organizationId, swId));
  const loc = (code: string) => locs.find((l) => l.code === code)!;
  const regions = await db.select().from(t.regions).where(eq(t.regions.organizationId, swId));
  const region = (name: string) => regions.find((r) => r.name === name)!;
  const groups = await db.select().from(t.ownerGroups).where(eq(t.ownerGroups.organizationId, swId));
  const group = (name: string) => groups.find((g) => g.name === name)!;

  await db.insert(t.roleAssignments).values([
    { organizationId: swId, userId: jamie.id, role: 'hq_admin', scopeKind: 'organization', scopeId: swId },
    { organizationId: swId, userId: elena.id, role: 'hq_admin', scopeKind: 'organization', scopeId: swId },
    { organizationId: swId, userId: lena.id, role: 'instructor_trainer', scopeKind: 'location', scopeId: loc('TOR-QW').id },
    { organizationId: swId, userId: aisha.id, role: 'franchise_owner', scopeKind: 'owner_group', scopeId: group('Lakeshore Holdings').id },
    { organizationId: swId, userId: tom.id, role: 'franchise_owner', scopeKind: 'owner_group', scopeId: group('Spree Studios GmbH').id },
  ]).onConflictDoNothing();

  // ── Account managers (HQ contacts) with external booking links ──
  await db.insert(t.accountManagers).values([
    { organizationId: swId, userId: jamie.id, scopeKind: 'region', scopeId: region('North America').id, title: 'Franchise success manager', bookingUrl: 'https://calendly.com/stillwater-jamie/30min', phone: '+1 416 555 0190', bio: 'Former studio owner. I help North American studios with launches, staffing and the numbers.' },
    { organizationId: swId, userId: elena.id, scopeKind: 'region', scopeId: region('Europe').id, title: 'Chief Marketing Officer · owner coach', bookingUrl: 'https://calendly.com/elena-costa-cmo/coaching', bio: 'I coach owners on local marketing, intro offers and teacher-training launches. Book a 30-minute call any week.' },
    { organizationId: swId, userId: elena.id, scopeKind: 'region', scopeId: region('Asia-Pacific').id, title: 'Chief Marketing Officer · owner coach', bookingUrl: 'https://calendly.com/elena-costa-cmo/coaching' },
  ]).onConflictDoNothing();

  // ── Announcements ──
  const anns = await db.insert(t.communityAnnouncements).values([
    {
      organizationId: swId, title: 'Brand standards v4.0 — please read and confirm', authorId: c.demo.id, requiredRead: true, pinned: true, status: 'published', publishAt: ago(5 * D), notifiedAt: ago(5 * D), dueAt: ahead(9 * D),
      body: 'Our refreshed brand standards are live. Key changes: the lime accent is now reserved for calls to action, studio photography uses natural light only, and class names follow the new naming guide.\n\nRead the guide in Resources → Brand, then confirm below by the due date.',
      attachments: [{ name: 'Brand standards v4.0.pdf', url: 'https://example.com/stillwater/brand-standards-v4.pdf', mimeType: 'application/pdf' }],
    },
    { organizationId: swId, title: 'Network call Thursday: Q4 intro offer results', authorId: jamie.id, status: 'published', publishAt: ago(2 * D), notifiedAt: ago(2 * D), body: 'Join us Thursday at 1 pm Eastern. We will share intro offer results by studio and the plan for January. Agenda in Events.' },
    { organizationId: swId, title: 'Europe: VAT invoices for the marketing fund', authorId: elena.id, status: 'published', publishAt: ago(1 * D), notifiedAt: ago(1 * D), audience: { regionIds: [region('Europe').id] }, requiredRead: true, dueAt: ahead(4 * D), body: 'From November the marketing fund invoices show VAT separately. Please forward them to your accountant. Questions in Operations help.' },
    { organizationId: swId, title: 'Owners: royalty statements for September', authorId: c.demo.id, status: 'published', publishAt: ago(3 * D), notifiedAt: ago(3 * D), audience: { roles: ['franchise_owner'] }, body: 'September statements are in the Finance workspace. Reach out to your account manager with any question.' },
    { organizationId: swId, title: 'Holiday schedule template', authorId: jamie.id, status: 'published', publishAt: ahead(3 * D), body: 'Use the attached template for your holiday timetable. Studios choose their own hours.' },
  ]).returning();
  const reads: Array<typeof t.communityAnnouncementReads.$inferInsert> = [];
  if (sam) reads.push({ organizationId: swId, announcementId: anns[0]!.id, userId: sam.id, readAt: ago(4 * D), acknowledgedAt: ago(4 * D) });
  reads.push({ organizationId: swId, announcementId: anns[0]!.id, userId: c.maya.id, readAt: ago(3 * D) });
  reads.push({ organizationId: swId, announcementId: anns[0]!.id, userId: aisha.id, readAt: ago(2 * D), acknowledgedAt: ago(2 * D) });
  await db.insert(t.communityAnnouncementReads).values(reads).onConflictDoNothing();

  // ── Spaces & threads (from the HQ / Location prototypes) ──
  const spaces = await db.insert(t.communitySpaces).values([
    { organizationId: swId, slug: 'all-locations', name: 'All locations', description: 'Open discussion across the network.', icon: 'hash', position: 1 },
    { organizationId: swId, slug: 'franchise-owners', name: 'Franchise owners', description: 'Owners and HQ leadership only.', icon: 'briefcase', audience: { roles: ['franchise_owner'] }, position: 2 },
    { organizationId: swId, slug: 'marketing', name: 'Marketing', description: 'Campaign questions and local ideas.', icon: 'share', position: 3 },
    { organizationId: swId, slug: 'operations-help', name: 'Operations help', description: 'Ask HQ operations. Questions are marked answered.', icon: 'help', kind: 'qa', position: 4 },
    { organizationId: swId, slug: 'region-north-america', name: 'Region: North America', description: 'Studios in North America.', icon: 'pin', audience: { regionIds: [region('North America').id] }, position: 5 },
    { organizationId: swId, slug: 'teacher-trainers', name: 'Teacher trainers', description: 'Lead trainers planning cohorts and assessments.', icon: 'book', audience: { roles: ['instructor_trainer'] }, position: 6 },
    { organizationId: swId, slug: 'hq-team', name: 'HQ team', description: 'HQ only.', icon: 'building', audience: { hqOnly: true }, position: 7 },
  ]).returning();
  const sp = (slug: string) => spaces.find((s) => s.slug === slug)!;
  const thread = async (slug: string, authorId: string, title: string, body: string, when: number, replies: Array<[string, string, number]>, accepted?: number) => {
    const [th] = await db.insert(t.communityThreads).values({ organizationId: swId, spaceId: sp(slug).id, authorId, title, body, createdAt: ago(when), lastActivityAt: ago(replies.length ? replies[replies.length - 1]![2] : when), replyCount: replies.length }).returning();
    const rs = replies.length ? await db.insert(t.communityReplies).values(replies.map(([a, b, w]) => ({ organizationId: swId, threadId: th!.id, authorId: a, body: b, createdAt: ago(w) }))).returning() : [];
    if (accepted !== undefined && rs[accepted]) await db.update(t.communityThreads).set({ acceptedReplyId: rs[accepted]!.id }).where(eq(t.communityThreads.id, th!.id));
    return { th: th!, rs };
  };
  const ref = await thread('all-locations', aisha.id, 'Referral offer: 9 sign-ups in a week', 'Has anyone tried the new referral offer? Ours went out Friday and we’ve had 9 sign-ups.', 2 * D, [
    [jamie.id, 'Great result. I’ll share the Queen West version as a template for other studios.', 2 * D - 22 * 60_000],
    [tom.id, 'We’ll try it in Mitte next week — did you change the default copy?', D],
  ]);
  await db.insert(t.communityReactions).values([{ organizationId: swId, targetType: 'thread', targetId: ref.th.id, userId: tom.id, reaction: 'celebrate' }, { organizationId: swId, targetType: 'thread', targetId: ref.th.id, userId: jamie.id, reaction: 'like' }]);
  await thread('operations-help', tom.id, 'Payouts pending for 3 days — normal?', 'Our payment payouts show as pending for 3 days. Is that normal for new accounts?', 6 * H, [
    [jamie.id, 'Yes, the first payouts take up to 7 days while the provider verifies the account. I’ve checked yours and it’s on track.', 5 * H],
  ], 0);
  await thread('operations-help', c.maya.id, 'How do I move a class to another room?', 'We are repainting Studio B next week. Can I move all its classes in one go?', 3 * D, []);
  await thread('franchise-owners', aisha.id, 'Leslieville opening: what helped your pre-sales?', 'We open Leslieville in six weeks. Which pre-sale offers worked best for your openings?', 4 * D, [[tom.id, 'Founding memberships capped at 50 sold out in 10 days for us.', 3 * D]]);
  await thread('marketing', elena.id, 'Spring teacher training campaign: assets ready', 'The ad creatives and landing page copy for the 200-hour teacher training are in Resources → Marketing. Leads go straight to Lena’s course leads list.', D, []);
  await thread('region-north-america', aisha.id, 'Share a booth at the Toronto wellness fair?', 'Anyone in North America want to split a booth at the community fair next month?', 5 * D, [[ava?.id ?? jamie.id, 'Seattle can’t make it, but we’d love the booth design files after.', 4 * D]]);

  // ── Resource library + knowledge base ──
  const folders = await db.insert(t.libraryFolders).values([
    { organizationId: swId, name: 'Brand', position: 1 },
    { organizationId: swId, name: 'Operations SOPs', position: 2 },
    { organizationId: swId, name: 'Owner playbooks', position: 3, audience: { roles: ['franchise_owner', 'location_manager', 'regional_manager'] } },
    { organizationId: swId, name: 'Marketing', position: 4 },
    { organizationId: swId, name: 'Help articles', position: 5 },
  ]).returning();
  const folder = (n: string) => folders.find((f) => f.name === n)!.id;
  const docs: Array<typeof t.libraryResources.$inferInsert> = [
    { organizationId: swId, folderId: folder('Brand'), kind: 'document', title: 'Brand standards v4.0', summary: 'Logo, colour, photography and class naming rules.', url: 'https://example.com/stillwater/brand-standards-v4.pdf', fileName: 'brand-standards-v4.pdf', tags: ['brand', 'logo'], currentVersion: 4 },
    { organizationId: swId, folderId: folder('Operations SOPs'), kind: 'sop', title: 'Opening and closing checklist', summary: 'Daily steps for front desk.', body: '1. Unlock and disarm.\n2. Heating to 21°C (hot rooms 32°C).\n3. Check props and mats are clean.\n4. Open the day in BranchHarbor and check waitlists.\n5. At close: cash-up, laundry, lights, alarm.', tags: ['front desk', 'daily'] },
    { organizationId: swId, folderId: folder('Operations SOPs'), kind: 'sop', title: 'Incident and injury reporting', summary: 'What to do and what to record.', body: 'Stop the class if needed, give first aid, call emergency services when in doubt. Record the incident the same day and tell your studio manager.', tags: ['safety'] },
    { organizationId: swId, folderId: folder('Owner playbooks'), kind: 'playbook', title: 'New studio launch playbook', summary: '12-week plan from lease signing to opening day.', body: 'Weeks 12–8: build-out and hiring. Weeks 8–4: founding memberships and pre-sales. Weeks 4–0: soft launch, teacher onboarding, opening event.', tags: ['launch', 'pre-sales'] },
    { organizationId: swId, folderId: folder('Owner playbooks'), kind: 'playbook', title: 'Pricing intro offers', summary: 'How to price and measure intro offers.', body: 'Keep the intro offer below a drop-in price for two weeks of unlimited classes. Track conversion to membership at day 30.', tags: ['pricing'] },
    { organizationId: swId, folderId: folder('Marketing'), kind: 'link', title: 'Teacher training ad creatives (spring)', summary: 'Meta and Google ad sets.', url: 'https://example.com/stillwater/ytt-spring-creatives', tags: ['ads', 'teacher training'] },
    { organizationId: swId, folderId: folder('Help articles'), kind: 'kb_article', helpCategory: 'Payments', title: 'Why is my payout pending?', summary: 'First payouts take up to 7 days.', body: 'New payment accounts are verified by the provider before the first payout. This takes up to 7 days. After that payouts arrive on your schedule.', tags: ['payments', 'payout'] },
    { organizationId: swId, folderId: folder('Help articles'), kind: 'kb_article', helpCategory: 'Connections', title: 'Fix a booking sync error', summary: 'When a class type can’t be matched.', body: 'Open Connections, choose the booking system and map the class type that shows an error. Sync runs again within 5 minutes.', tags: ['mindbody', 'sync'] },
    { organizationId: swId, folderId: folder('Help articles'), kind: 'kb_article', helpCategory: 'Team', title: 'Invite a staff member', summary: 'Give someone access to your studio.', body: 'Go to Team, choose Invite, enter their email and pick the role. They get an email to accept.', tags: ['team'] },
  ];
  const res = await db.insert(t.libraryResources).values(docs).returning();
  await db.insert(t.libraryVersions).values(res.map((r) => ({ organizationId: swId, resourceId: r.id, version: r.currentVersion, title: r.title, body: r.body, url: r.url, fileName: r.fileName, note: r.currentVersion > 1 ? 'Updated for v4.0' : 'First version' })));

  // ── Events ──
  const nextThu = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((4 - d.getUTCDay() + 7) % 7 || 7)); d.setUTCHours(17, 0, 0, 0); return d; })();
  const events = await db.insert(t.communityEvents).values([
    { organizationId: swId, title: 'Network call: Q4 intro offers', kind: 'network_call', startsAt: nextThu, endsAt: new Date(nextThu.getTime() + H), timeZone: 'America/Toronto', joinUrl: 'https://meet.example.com/stillwater-network', description: 'Results by studio, January plan, Q&A.', createdBy: jamie.id },
    { organizationId: swId, title: 'Trainer workshop: assessing practice teaching', kind: 'training', startsAt: new Date(nextThu.getTime() + 7 * D), endsAt: new Date(nextThu.getTime() + 7 * D + 2 * H), timeZone: 'America/Toronto', joinUrl: 'https://meet.example.com/stillwater-trainers', audience: { roles: ['instructor_trainer', 'location_manager'] }, createdBy: lena.id },
    { organizationId: swId, title: 'Europe owners’ breakfast (Berlin)', kind: 'in_person', startsAt: new Date(nextThu.getTime() + 14 * D - 9 * H), endsAt: new Date(nextThu.getTime() + 14 * D - 7 * H), timeZone: 'Europe/Berlin', place: 'Spree Studios, Torstraße 118', capacity: 20, audience: { regionIds: [region('Europe').id] }, createdBy: elena.id },
  ]).returning();
  await db.insert(t.communityEventRsvps).values([{ organizationId: swId, eventId: events[0]!.id, userId: aisha.id, status: 'going' }, { organizationId: swId, eventId: events[0]!.id, userId: tom.id, status: 'maybe' }, { organizationId: swId, eventId: events[2]!.id, userId: tom.id, status: 'going' }]);

  // ── Coaching threads ──
  const [coach] = await db.insert(t.coachingThreads).values({ organizationId: swId, scopeKind: 'owner_group', scopeId: group('Lakeshore Holdings').id, managerUserId: jamie.id, lastMessageAt: ago(20 * H) }).returning();
  await db.insert(t.coachingMessages).values([
    { organizationId: swId, threadId: coach!.id, authorId: jamie.id, body: 'Hi Aisha, I’ve booked our quarterly review for Thursday. Anything you want added?', createdAt: ago(2 * D) },
    { organizationId: swId, threadId: coach!.id, authorId: aisha.id, body: 'Yes — Leslieville pre-sales and whether we should run the teacher training at Queen West again.', createdAt: ago(20 * H) },
  ]);
  const [coach2] = await db.insert(t.coachingThreads).values({ organizationId: swId, scopeKind: 'owner_group', scopeId: group('Spree Studios GmbH').id, managerUserId: elena.id, lastMessageAt: ago(6 * H) }).returning();
  await db.insert(t.coachingMessages).values([{ organizationId: swId, threadId: coach2!.id, authorId: elena.id, body: 'Tom, your Mitte intro offer converts at 31% — top of Europe. Book a slot with my link and we’ll plan the spring campaign.', createdAt: ago(6 * H) }]);

  // ── Notifications (inbox) ──
  await db.insert(t.networkNotifications).values([
    { organizationId: swId, userId: c.maya.id, kind: 'announcement', title: 'Required read: Brand standards v4.0 — please read and confirm', link: `/community?announcement=${anns[0]!.id}`, createdAt: ago(5 * D) },
    { organizationId: swId, userId: c.maya.id, kind: 'required_read_reminder', title: 'Reminder: please read and confirm “Brand standards v4.0”', link: `/community?announcement=${anns[0]!.id}`, createdAt: ago(D) },
    { organizationId: swId, userId: aisha.id, kind: 'coaching', title: 'Message from Jamie Morgan', body: 'I’ve booked our quarterly review for Thursday.', link: `/community?coaching=${coach!.id}`, createdAt: ago(2 * D) },
  ]);

  // ── Help desk ──
  await db.insert(t.helpdeskSettings).values({ organizationId: swId, inboundToken: 'stillwater7k2' }).onConflictDoNothing();
  const cats = await db.insert(t.helpdeskCategories).values([
    { organizationId: swId, name: 'Payments', firstResponseMinutes: 120, resolutionMinutes: 1440, defaultAssigneeId: jamie.id, position: 1 },
    { organizationId: swId, name: 'Website', firstResponseMinutes: 240, resolutionMinutes: 2880, position: 2 },
    { organizationId: swId, name: 'Connections', firstResponseMinutes: 240, resolutionMinutes: 2880, defaultAssigneeId: jamie.id, position: 3 },
    { organizationId: swId, name: 'Marketing', firstResponseMinutes: 480, resolutionMinutes: 4320, defaultAssigneeId: elena.id, position: 4 },
    { organizationId: swId, name: 'Training', firstResponseMinutes: 480, resolutionMinutes: 4320, position: 5 },
  ]).returning();
  const cat = (n: string) => cats.find((x) => x.name === n)!;
  const ticket = async (n: number, p: { subject: string; body: string; cat: string; priority: Priority; requester: User; location: string; status: string; assignee: User | null; age: number; replies?: Array<[User, string, number, boolean?]>; csat?: number }) => {
    const created = ago(p.age);
    const due = slaTargets(p.priority, cat(p.cat), created);
    const firstHq = p.replies?.find(([u, , , internal]) => u.id !== p.requester.id && !internal);
    const [tk] = await db.insert(t.tickets).values({
      organizationId: swId, number: n, locationId: loc(p.location).id, requesterId: p.requester.id, requesterEmail: p.requester.email, categoryId: cat(p.cat).id, subject: p.subject, priority: p.priority, status: p.status,
      assigneeId: p.assignee?.id ?? null, ...due, firstRespondedAt: firstHq ? ago(firstHq[2]) : null, pausedAt: p.status === 'pending' ? ago(p.replies?.[p.replies.length - 1]?.[2] ?? 0) : null,
      resolvedAt: ['resolved', 'closed'].includes(p.status) ? ago(Math.max(0, p.age - 20 * H)) : null, closedAt: p.status === 'closed' ? ago(Math.max(0, p.age - 22 * H)) : null, satisfaction: p.csat ?? null, createdAt: created, updatedAt: ago(p.replies?.[p.replies.length - 1]?.[2] ?? p.age),
    }).returning();
    await db.insert(t.ticketMessages).values([
      { organizationId: swId, ticketId: tk!.id, authorId: p.requester.id, body: p.body, createdAt: created },
      ...(p.replies ?? []).map(([u, b, w, internal]) => ({ organizationId: swId, ticketId: tk!.id, authorId: u.id, body: b, internal: !!internal, createdAt: ago(w) })),
    ]);
  };
  await ticket(1001, { subject: 'Card reader shows error 12', body: 'The front desk reader at Queen West stopped taking cards this morning.', cat: 'Payments', priority: 'urgent', requester: c.maya, location: 'TOR-QW', status: 'open', assignee: jamie, age: 40 * 60_000 });
  await ticket(1002, { subject: 'Mindbody class type not syncing', body: '“Hot Vinyasa” shows an error in Connections.', cat: 'Connections', priority: 'normal', requester: ava ?? c.maya, location: 'SEA-CH', status: 'pending', assignee: jamie, age: 26 * H, replies: [[jamie, 'Map “Hot Vinyasa” to Vinyasa Flow in Connections → Mindbody and tell me if the error clears.', 24 * H], [jamie, 'Same mapping issue as Capitol Hill last month.', 24 * H, true]] });
  await ticket(1003, { subject: 'Change the hero photo on the Mitte site', body: 'The new photo is in our shared folder; the hero field is locked.', cat: 'Website', priority: 'low', requester: tom, location: 'BER-MI', status: 'open', assignee: null, age: 3 * D });
  await ticket(1004, { subject: 'Payout delayed for September', body: 'Our September payout hasn’t arrived.', cat: 'Payments', priority: 'high', requester: aisha, location: 'TOR-QW', status: 'closed', assignee: jamie, age: 9 * D, replies: [[jamie, 'The bank holiday moved the payout by two days. It has arrived now.', 9 * D - 2 * H]], csat: 5 });
  await db.insert(t.cannedReplies).values([
    { organizationId: swId, title: 'First payout timing', body: 'New payment accounts are verified before the first payout, which can take up to 7 days. I’ve checked yours and it’s on track.', createdBy: jamie.id },
    { organizationId: swId, title: 'Locked website field', body: 'That field is locked by HQ to keep the brand consistent. Send us the change and we’ll update it for you, or request approval from the website editor.', createdBy: jamie.id },
    { organizationId: swId, title: 'Ask for a screenshot', body: 'Could you send a screenshot of the error and the time it happened? That helps us find it faster.', createdBy: jamie.id },
  ]);

  // ── Maple & Ember (foods network): a lighter community ──
  const meLocs = await db.select().from(t.locations).where(eq(t.locations.organizationId, c.meId));
  await db.insert(t.communityAnnouncements).values([
    { organizationId: c.meId, title: 'Allergen matrix updated — confirm by Friday', authorId: c.demo.id, requiredRead: true, pinned: true, status: 'published', publishAt: ago(D), notifiedAt: ago(D), dueAt: ahead(3 * D), body: 'The smoked brisket sandwich now contains mustard. Update your allergen boards and confirm you have read the new matrix.' },
    { organizationId: c.meId, title: 'Pearl opening: training shifts', authorId: c.demo.id, status: 'published', publishAt: ago(2 * D), notifiedAt: ago(2 * D), audience: { locationIds: meLocs.filter((l) => l.code === 'PDX-PL' || l.code === 'SEA-BL').map((l) => l.id) }, body: 'Ballard will host Pearl’s new kitchen team for two training shifts next week.' },
  ]);
  await db.insert(t.communitySpaces).values([
    { organizationId: c.meId, slug: 'kitchen-leads', name: 'Kitchen leads', description: 'Recipes, prep and equipment.', icon: 'chef', position: 1 },
    { organizationId: c.meId, slug: 'ops-help', name: 'Operations help', description: 'Ask HQ operations.', icon: 'help', kind: 'qa', position: 2 },
  ]);
  await db.insert(t.helpdeskCategories).values([{ organizationId: c.meId, name: 'Kitchen equipment', firstResponseMinutes: 120, resolutionMinutes: 1440 }, { organizationId: c.meId, name: 'Online ordering', firstResponseMinutes: 60, resolutionMinutes: 480 }]);

  return { users: [jamie.email, elena.email, lena.email, aisha.email, tom.email], lena, jamie, elena, aisha, tom };
}

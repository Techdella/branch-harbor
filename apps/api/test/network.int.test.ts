import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { communityAnnouncements, enrolments, networkNotifications, ownerGroups, paymentReferences, regions, tickets } from '../src/db/schema/index.ts';
import { signStripePayload } from '../src/integrations/payments.ts';
import { runNetworkHousekeeping } from '../src/services/community.ts';
import { runHelpdeskSla } from '../src/services/helpdesk.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, memberWithRole, uid, verifiedUser, WEBHOOK_SECRET } from './helpers.ts';

type U = { token: string; userId: string; email: string };

describe.skipIf(!hasDb)('network workspaces: community, training academy, help desk (DB)', () => {
  let app: FastifyInstance;
  let owner: U;
  let orgId: string;
  let orgSlug: string;
  let north: string; let south: string; let groupA: string; let groupB: string;
  let la1: any; let lb1: any;
  let hq: U; let franA: U; let franB: U; let staffA: U; let staffB: U; let trainer: U; let rmNorth: U; let outsider: U;
  const base = () => `/v1/orgs/${orgId}`;
  const notes = async (userId: string, kind?: string) => (await app.ctx.db.select().from(networkNotifications).where(and(eq(networkNotifications.userId, userId), eq(networkNotifications.organizationId, orgId)))).filter((n) => !kind || n.kind === kind);

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Olivia Owner');
    const org = await createOrg(app, owner.token);
    orgId = org.id; orgSlug = org.slug;
    const [n, so] = await app.ctx.db.insert(regions).values([{ organizationId: orgId, name: 'North' }, { organizationId: orgId, name: 'South' }]).returning();
    const [ga, gb] = await app.ctx.db.insert(ownerGroups).values([{ organizationId: orgId, name: 'Group A' }, { organizationId: orgId, name: 'Group B' }]).returning();
    north = n!.id; south = so!.id; groupA = ga!.id; groupB = gb!.id;
    la1 = await createLocation(app, owner.token, orgId, { regionId: north, ownerGroupId: groupA });
    lb1 = await createLocation(app, owner.token, orgId, { regionId: south, ownerGroupId: groupB });
    await enablePublicAndPayments(app, owner.token, orgId, la1.id);
    hq = await memberWithRole(app, owner.token, orgId, 'hq_admin', { kind: 'organization', id: orgId }, 'Hana HQ');
    franA = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: groupA }, 'Frank A');
    franB = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: groupB }, 'Fiona B');
    staffA = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: la1.id }, 'Sam A');
    staffB = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: lb1.id }, 'Sky B');
    trainer = await memberWithRole(app, owner.token, orgId, 'instructor_trainer', { kind: 'location', id: la1.id }, 'Tara Trainer');
    rmNorth = await memberWithRole(app, owner.token, orgId, 'regional_manager', { kind: 'region', id: north }, 'Rae North');
    outsider = await verifiedUser(app, 'Out Sider');
  });
  afterAll(async () => { await app?.close(); });

  // ───────────── Community ─────────────
  let regionAnn: string;
  it('targets announcements by region and role: a location staff member sees only what is addressed to them', async () => {
    const r = await call(app, 'POST', `${base()}/community/announcements`, { token: hq.token, body: { title: 'North: new opening checklist', body: 'Please read the updated checklist.', audience: { regionIds: [north] }, requiredRead: true, dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString() } });
    expect(r.status).toBe(201);
    regionAnn = r.body.id;
    expect(r.body.notified).toBeGreaterThanOrEqual(3); // staffA, franA, trainer, rmNorth (not HQ, not South)
    const owners = await call(app, 'POST', `${base()}/community/announcements`, { token: hq.token, body: { title: 'Owners only: Q3 royalties', body: 'Statements are out.', audience: { roles: ['franchise_owner'] } } });
    expect(owners.status).toBe(201);

    const a = await call(app, 'GET', `${base()}/community/announcements`, { token: staffA.token });
    expect(a.body.items.map((x: any) => x.title)).toEqual(['North: new opening checklist']);
    const b = await call(app, 'GET', `${base()}/community/announcements`, { token: staffB.token });
    expect(b.body.items).toHaveLength(0);
    expect((await call(app, 'GET', `${base()}/community/announcements/${regionAnn}`, { token: staffB.token })).status).toBe(404);
    const fa = await call(app, 'GET', `${base()}/community/announcements`, { token: franA.token });
    expect(fa.body.items.map((x: any) => x.title).sort()).toEqual(['North: new opening checklist', 'Owners only: Q3 royalties']);
    const fb = await call(app, 'GET', `${base()}/community/announcements`, { token: franB.token });
    expect(fb.body.items.map((x: any) => x.title)).toEqual(['Owners only: Q3 royalties']);
    expect((await notes(staffA.userId, 'announcement')).length).toBe(1);
    expect((await notes(staffB.userId, 'announcement')).length).toBe(0);
    // Outsiders can't even tell the organisation exists.
    expect((await call(app, 'GET', `${base()}/community/announcements`, { token: outsider.token })).status).toBe(404);
  });

  it('records read receipts and confirmations, and reminds people who have not confirmed', async () => {
    expect((await call(app, 'POST', `${base()}/community/announcements/${regionAnn}/read`, { token: staffA.token })).status).toBe(200);
    const ack = await call(app, 'POST', `${base()}/community/announcements/${regionAnn}/acknowledge`, { token: staffA.token });
    expect(ack.body.acknowledgedAt).toBeTruthy();
    expect((await call(app, 'POST', `${base()}/community/announcements/${regionAnn}/acknowledge`, { token: staffB.token })).status).toBe(404);
    const rc = await call(app, 'GET', `${base()}/community/announcements/${regionAnn}/receipts`, { token: hq.token });
    expect(rc.status).toBe(200);
    const ids = rc.body.items.map((x: any) => x.userId);
    expect(ids).toEqual(expect.arrayContaining([staffA.userId, franA.userId, trainer.userId, rmNorth.userId]));
    expect(ids).not.toContain(staffB.userId);
    expect(rc.body.totals.acknowledged).toBe(1);
    expect((await call(app, 'GET', `${base()}/community/announcements/${regionAnn}/receipts`, { token: staffA.token })).status).toBe(403);
    const me = await call(app, 'GET', `${base()}/community/me`, { token: franA.token });
    expect(me.body.counters.requiredReadsPending).toBe(1);
    const rem = await call(app, 'POST', `${base()}/community/announcements/${regionAnn}/remind`, { token: hq.token });
    expect(rem.body.reminded).toBe(ids.length - 1);
    expect((await notes(franA.userId, 'required_read_reminder')).length).toBe(1);
    expect((await notes(staffA.userId, 'required_read_reminder')).length).toBe(0);
    expect((await call(app, 'POST', `${base()}/community/announcements/${regionAnn}/remind`, { token: hq.token })).body.error.code).toBe('reminded_recently');
  });

  it('schedules announcements and lets regional managers address only their own region', async () => {
    const later = await call(app, 'POST', `${base()}/community/announcements`, { token: hq.token, body: { title: 'Scheduled: holiday hours', body: 'Coming soon', publishAt: new Date(Date.now() + 3600_000).toISOString() } });
    expect(later.status).toBe(201);
    expect(later.body.status).toBe('scheduled');
    expect((await call(app, 'GET', `${base()}/community/announcements`, { token: staffB.token })).body.items).toHaveLength(0);
    const manage = await call(app, 'GET', `${base()}/community/announcements?manage=true`, { token: hq.token });
    expect(manage.body.items.find((x: any) => x.id === later.body.id).status).toBe('scheduled');
    await app.ctx.db.update(communityAnnouncements).set({ publishAt: new Date(Date.now() - 1000) }).where(eq(communityAnnouncements.id, later.body.id));
    const sweep = await runNetworkHousekeeping(app.ctx);
    expect(sweep.published).toBeGreaterThan(0);
    expect((await call(app, 'GET', `${base()}/community/announcements`, { token: staffB.token })).body.items.map((x: any) => x.title)).toEqual(['Scheduled: holiday hours']);

    const south = await call(app, 'POST', `${base()}/community/announcements`, { token: rmNorth.token, body: { title: 'x', body: 'y', audience: { regionIds: [lb1.regionId] } } });
    expect(south.status).toBe(403);
    expect((await call(app, 'POST', `${base()}/community/announcements`, { token: rmNorth.token, body: { title: 'x', body: 'y' } })).status).toBe(403);
    expect((await call(app, 'POST', `${base()}/community/announcements`, { token: rmNorth.token, body: { title: 'North call', body: 'Thursday', audience: { regionIds: [north] } } })).status).toBe(201);
    expect((await call(app, 'POST', `${base()}/community/announcements`, { token: staffA.token, body: { title: 'x', body: 'y' } })).status).toBe(403);
  });

  let qa: string; let hqOnly: string; let thread: string; let replyId: string;
  it('runs discussion spaces with Q&A, mentions, reactions and HQ-only spaces', async () => {
    expect((await call(app, 'POST', `${base()}/community/spaces`, { token: staffA.token, body: { name: 'Nope' } })).status).toBe(403);
    qa = (await call(app, 'POST', `${base()}/community/spaces`, { token: hq.token, body: { name: 'Operations help', kind: 'qa' } })).body.id;
    hqOnly = (await call(app, 'POST', `${base()}/community/spaces`, { token: hq.token, body: { name: 'HQ team', audience: { hqOnly: true } } })).body.id;
    const sp = await call(app, 'GET', `${base()}/community/spaces`, { token: staffA.token });
    expect(sp.body.items.map((x: any) => x.name)).toEqual(['Operations help']);
    expect((await call(app, 'GET', `${base()}/community/spaces/${hqOnly}/threads`, { token: staffA.token })).status).toBe(404);

    const t = await call(app, 'POST', `${base()}/community/spaces/${qa}/threads`, { token: staffA.token, body: { title: 'Payouts pending for 3 days?', body: 'Is that normal? @Frank', mentions: [franA.userId, outsider.userId] } });
    expect(t.status).toBe(201);
    expect(t.body.mentions).toEqual([franA.userId]);
    thread = t.body.id;
    expect((await notes(franA.userId, 'mention')).length).toBe(1);
    const r = await call(app, 'POST', `${base()}/community/threads/${thread}/replies`, { token: hq.token, body: { body: 'Yes — first payouts take up to 7 days.' } });
    replyId = r.body.id;
    expect((await notes(staffA.userId, 'reply')).length).toBe(1);
    expect((await call(app, 'POST', `${base()}/community/threads/${thread}/accept`, { token: staffB.token, body: { replyId } })).status).toBe(403);
    expect((await call(app, 'POST', `${base()}/community/threads/${thread}/accept`, { token: staffA.token, body: { replyId } })).body.acceptedReplyId).toBe(replyId);
    const like = await call(app, 'POST', `${base()}/community/reactions`, { token: staffB.token, body: { targetType: 'reply', targetId: replyId, reaction: 'thanks' } });
    expect(like.body).toMatchObject({ active: true, counts: { thanks: 1 } });
    const unlike = await call(app, 'POST', `${base()}/community/reactions`, { token: staffB.token, body: { targetType: 'reply', targetId: replyId, reaction: 'thanks' } });
    expect(unlike.body.active).toBe(false);
    const view = await call(app, 'GET', `${base()}/community/threads/${thread}`, { token: staffB.token });
    expect(view.body.thread.acceptedReplyId).toBe(replyId);
    expect(view.body.replies[0].accepted).toBe(true);
  });

  it('moderates: report, hide (hidden for everyone but moderators and the author) and lock', async () => {
    const bad = await call(app, 'POST', `${base()}/community/threads/${thread}/replies`, { token: staffB.token, body: { body: 'Buy cheap followers at spam.example' } });
    const rep = await call(app, 'POST', `${base()}/community/reports`, { token: staffA.token, body: { targetType: 'reply', targetId: bad.body.id, reason: 'Spam link' } });
    expect(rep.status).toBe(201);
    expect((await call(app, 'GET', `${base()}/community/reports`, { token: staffA.token })).status).toBe(403);
    const queue = await call(app, 'GET', `${base()}/community/reports`, { token: hq.token });
    expect(queue.body.items.map((x: any) => x.id)).toContain(rep.body.id);
    expect((await call(app, 'POST', `${base()}/community/moderation`, { token: staffA.token, body: { targetType: 'reply', targetId: bad.body.id, action: 'hide', reason: 'spam' } })).status).toBe(403);
    expect((await call(app, 'POST', `${base()}/community/moderation`, { token: hq.token, body: { targetType: 'reply', targetId: bad.body.id, action: 'hide' } })).status).toBe(400);
    expect((await call(app, 'POST', `${base()}/community/moderation`, { token: hq.token, body: { targetType: 'reply', targetId: bad.body.id, action: 'hide', reason: 'Spam', reportId: rep.body.id } })).status).toBe(200);
    const asA = await call(app, 'GET', `${base()}/community/threads/${thread}`, { token: staffA.token });
    expect(asA.body.replies.map((x: any) => x.id)).not.toContain(bad.body.id);
    const asAuthor = await call(app, 'GET', `${base()}/community/threads/${thread}`, { token: staffB.token });
    expect(asAuthor.body.replies.find((x: any) => x.id === bad.body.id).hidden).toBe(true);
    const asHq = await call(app, 'GET', `${base()}/community/threads/${thread}`, { token: hq.token });
    expect(asHq.body.replies.find((x: any) => x.id === bad.body.id)).toMatchObject({ hidden: true, hiddenReason: 'Spam' });
    expect((await call(app, 'GET', `${base()}/community/reports`, { token: hq.token })).body.items.map((x: any) => x.id)).not.toContain(rep.body.id);
    await call(app, 'POST', `${base()}/community/moderation`, { token: hq.token, body: { targetType: 'thread', targetId: thread, action: 'lock' } });
    expect((await call(app, 'POST', `${base()}/community/threads/${thread}/replies`, { token: staffB.token, body: { body: 'one more' } })).body.error.code).toBe('thread_locked');
  });

  it('shows each franchisee their account manager and keeps 1:1 coaching threads private', async () => {
    const am = await call(app, 'POST', `${base()}/community/account-managers`, { token: owner.token, body: { userId: hq.userId, scopeKind: 'owner_group', scopeId: groupA, title: 'Franchise coach', bookingUrl: 'https://calendly.com/hana-hq/30min' } });
    expect(am.status).toBe(201);
    expect((await call(app, 'POST', `${base()}/community/account-managers`, { token: owner.token, body: { userId: staffA.userId, scopeKind: 'owner_group', scopeId: groupB } })).status).toBe(400);
    const meA = await call(app, 'GET', `${base()}/community/me`, { token: franA.token });
    expect(meA.body.accountManagers).toEqual([expect.objectContaining({ userId: hq.userId, bookingUrl: 'https://calendly.com/hana-hq/30min' })]);
    expect((await call(app, 'GET', `${base()}/community/me`, { token: franB.token })).body.accountManagers).toEqual([]);
    const th = await call(app, 'POST', `${base()}/community/coaching`, { token: franA.token, body: { managerUserId: hq.userId, body: 'Can we review my Q3 numbers?' } });
    expect(th.status).toBe(201);
    expect((await call(app, 'GET', `${base()}/community/coaching/${th.body.id}`, { token: franB.token })).status).toBe(404);
    expect((await call(app, 'GET', `${base()}/community/coaching/${th.body.id}`, { token: staffA.token })).status).toBe(404);
    expect((await call(app, 'GET', `${base()}/community/coaching`, { token: franB.token })).body.items).toEqual([]);
    expect((await call(app, 'POST', `${base()}/community/coaching`, { token: franB.token, body: { managerUserId: hq.userId, body: 'hi' } })).status).toBe(404);
    const asAm = await call(app, 'GET', `${base()}/community/coaching/${th.body.id}`, { token: hq.token });
    expect(asAm.body.messages).toHaveLength(1);
    expect((await call(app, 'POST', `${base()}/community/coaching/${th.body.id}/messages`, { token: hq.token, body: { body: 'Sure — book a slot with my link.' } })).status).toBe(201);
    expect((await notes(franA.userId, 'coaching')).length).toBe(1);
  });

  it('serves polling with ETags and stores notification preferences', async () => {
    const first = await call(app, 'GET', `${base()}/community/updates`, { token: staffA.token });
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    expect((await call(app, 'GET', `${base()}/community/updates`, { token: staffA.token, headers: { 'if-none-match': etag } })).status).toBe(304);
    await call(app, 'POST', `${base()}/community/notifications/read`, { token: staffA.token, body: {} });
    expect((await call(app, 'GET', `${base()}/community/updates`, { token: staffA.token, headers: { 'if-none-match': etag } })).status).toBe(200);
    await call(app, 'PUT', `${base()}/community/notification-prefs`, { token: staffB.token, body: { inApp: true, push: false, emailDigest: 'off', mutedKinds: ['announcement'], mutedSpaceIds: [] } });
    const before = (await notes(staffB.userId, 'announcement')).length;
    await call(app, 'POST', `${base()}/community/announcements`, { token: hq.token, body: { title: 'Muted for Sky', body: 'x' } });
    expect((await notes(staffB.userId, 'announcement')).length).toBe(before);
  });

  it('searches the resource library with folder permissions and versions', async () => {
    const folder = await call(app, 'POST', `${base()}/resources/folders`, { token: hq.token, body: { name: 'Owner playbooks', audience: { roles: ['franchise_owner'] } } });
    const doc = await call(app, 'POST', `${base()}/resources`, { token: hq.token, body: { title: 'Pricing playbook', kind: 'playbook', folderId: folder.body.id, body: 'How to price intro offers' } });
    await call(app, 'POST', `${base()}/resources`, { token: hq.token, body: { title: 'Opening checklist SOP', kind: 'sop', body: 'Unlock doors, check heating, pricing boards' } });
    expect((await call(app, 'GET', `${base()}/resources?q=pricing`, { token: franA.token })).body.items.map((x: any) => x.title).sort()).toEqual(['Opening checklist SOP', 'Pricing playbook']);
    expect((await call(app, 'GET', `${base()}/resources?q=pricing`, { token: staffA.token })).body.items.map((x: any) => x.title)).toEqual(['Opening checklist SOP']);
    expect((await call(app, 'GET', `${base()}/resources/${doc.body.id}`, { token: staffA.token })).status).toBe(404);
    const v2 = await call(app, 'PATCH', `${base()}/resources/${doc.body.id}`, { token: hq.token, body: { body: 'v2 text', note: 'Updated for 2027' } });
    expect(v2.body.version).toBe(2);
    expect((await call(app, 'GET', `${base()}/resources/${doc.body.id}`, { token: franA.token })).body.versions.map((x: any) => x.version)).toEqual([2, 1]);
    expect((await call(app, 'POST', `${base()}/resources`, { token: staffA.token, body: { title: 'x', body: 'y' } })).status).toBe(403);
  });

  // ───────────── Training ─────────────
  let course: string; let textLesson: string; let quizLesson: string;
  it('lets instructor-trainers author courses that HQ approves before publishing', async () => {
    expect((await call(app, 'POST', `${base()}/training/courses`, { token: staffA.token, body: { title: 'Nope' } })).status).toBe(403);
    const c = await call(app, 'POST', `${base()}/training/courses`, { token: trainer.token, body: { title: 'Brand standards v4', passMark: 80, validityMonths: 12 } });
    expect(c.status).toBe(201);
    course = c.body.id;
    expect(c.body.trainerUserIds).toEqual([trainer.userId]);
    const m = await call(app, 'POST', `${base()}/training/courses/${course}/modules`, { token: trainer.token, body: { title: 'Basics' } });
    textLesson = (await call(app, 'POST', `${base()}/training/modules/${m.body.id}/lessons`, { token: trainer.token, body: { title: 'Welcome', kind: 'video', videoUrl: 'https://www.youtube.com/watch?v=abc', body: 'Watch this' } })).body.id;
    quizLesson = (await call(app, 'POST', `${base()}/training/modules/${m.body.id}/lessons`, {
      token: trainer.token,
      body: { title: 'Check', kind: 'quiz', quiz: [{ id: 'q1', prompt: 'Logo clear space?', options: ['None', '1x', '2x'], correct: [1] }, { id: 'q2', prompt: 'Primary colour?', options: ['Lime', 'Red'], correct: [0] }] },
    })).body.id;
    expect((await call(app, 'POST', `${base()}/training/courses/${course}/review`, { token: trainer.token, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(app, 'POST', `${base()}/training/courses/${course}/submit`, { token: trainer.token })).body.status).toBe('pending_approval');
    expect((await notes(hq.userId, 'course_approval')).length).toBe(1);
    expect((await call(app, 'POST', `${base()}/training/courses/${course}/review`, { token: hq.token, body: { decision: 'reject' } })).status).toBe(400);
    expect((await call(app, 'POST', `${base()}/training/courses/${course}/review`, { token: hq.token, body: { decision: 'approve' } })).body.status).toBe('published');
  });

  it('assigns training to a location, tracks progress, scores quizzes against the pass mark and issues a certificate', async () => {
    const a = await call(app, 'POST', `${base()}/training/assignments`, { token: hq.token, body: { targetType: 'course', targetId: course, audience: { locationIds: [la1.id], roles: ['staff'] }, dueInDays: 14 } });
    expect(a.status).toBe(201);
    expect(a.body.enrolled).toBe(1);
    const homeA = await call(app, 'GET', `${base()}/training/home`, { token: staffA.token });
    expect(homeA.body.enrolments.map((e: any) => e.course.id)).toEqual([course]);
    expect(homeA.body.enrolments[0].dueAt).toBeTruthy();
    expect((await call(app, 'GET', `${base()}/training/home`, { token: staffB.token })).body.enrolments).toEqual([]);
    expect((await notes(staffA.userId, 'course_assigned')).length).toBe(1);

    const lesson = await call(app, 'GET', `${base()}/training/lessons/${quizLesson}`, { token: staffA.token });
    expect(lesson.body.quiz[0]).not.toHaveProperty('correct');
    expect((await call(app, 'POST', `${base()}/training/lessons/${quizLesson}/complete`, { token: staffA.token })).body.error.code).toBe('quiz_required');
    const done1 = await call(app, 'POST', `${base()}/training/lessons/${textLesson}/complete`, { token: staffA.token });
    expect(done1.body.enrolment.progressPct).toBe(50);
    const fail = await call(app, 'POST', `${base()}/training/lessons/${quizLesson}/quiz`, { token: staffA.token, body: { answers: { q1: [1], q2: [1] } } });
    expect(fail.body).toMatchObject({ score: 50, passed: false, passMark: 80, certificate: null });
    expect(fail.body.enrolment.status).toBe('active');
    const pass = await call(app, 'POST', `${base()}/training/lessons/${quizLesson}/quiz`, { token: staffA.token, body: { answers: { q1: [1], q2: [0] } } });
    expect(pass.body).toMatchObject({ score: 100, passed: true });
    expect(pass.body.enrolment).toMatchObject({ status: 'completed', progressPct: 100 });
    expect(pass.body.certificate.code).toMatch(/^[0-9A-F]{4}-/);
    const pdf = await app.inject({ method: 'GET', url: `${base()}/training/certificates/${pass.body.certificate.id}/pdf`, headers: { authorization: `Bearer ${staffA.token}` } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await app.inject({ method: 'GET', url: `${base()}/training/certificates/${pass.body.certificate.id}/pdf`, headers: { authorization: `Bearer ${staffB.token}` } })).statusCode).toBe(404);
    const verify = await call(app, 'GET', `/v1/public/certificates/${pass.body.certificate.code}`);
    expect(verify.body).toMatchObject({ valid: true, learnerName: 'Sam A', courseTitle: 'Brand standards v4' });
    expect(verify.body.expiresAt).toBeTruthy();
  });

  it('reports completion per location within the viewer’s scope and enforces prerequisites', async () => {
    const all = await call(app, 'GET', `${base()}/training/reports/completion?courseId=${course}`, { token: hq.token });
    expect(all.body.items.find((x: any) => x.locationId === la1.id)).toMatchObject({ completed: 1, completionRate: 100 });
    const mine = await call(app, 'GET', `${base()}/training/reports/completion`, { token: franB.token });
    expect(mine.body.items.every((x: any) => x.locationId === lb1.id)).toBe(true);
    expect((await call(app, 'GET', `${base()}/training/reports/completion`, { token: staffA.token })).status).toBe(403);

    const adv = await call(app, 'POST', `${base()}/training/courses`, { token: hq.token, body: { title: 'Advanced standards', prerequisiteIds: [course] } });
    const m = await call(app, 'POST', `${base()}/training/courses/${adv.body.id}/modules`, { token: hq.token, body: { title: 'M' } });
    await call(app, 'POST', `${base()}/training/modules/${m.body.id}/lessons`, { token: hq.token, body: { title: 'L', body: 'text' } });
    await call(app, 'POST', `${base()}/training/courses/${adv.body.id}/review`, { token: hq.token, body: { decision: 'approve' } });
    expect((await call(app, 'POST', `${base()}/training/courses/${adv.body.id}/start`, { token: staffB.token })).body.error.code).toBe('prerequisites_missing');
    expect((await call(app, 'POST', `${base()}/training/courses/${adv.body.id}/start`, { token: staffA.token })).status).toBe(200);
  });

  it('assigns a learning path to a new franchisee (owner group) through the onboarding hook', async () => {
    const p = await call(app, 'POST', `${base()}/training/paths`, { token: hq.token, body: { title: 'New franchisee onboarding', courseIds: [course] } });
    expect(p.status).toBe(201);
    expect((await call(app, 'POST', `${base()}/training/paths/${p.body.id}/assign`, { token: franB.token, body: { ownerGroupId: groupA } })).status).toBe(403);
    const r = await call(app, 'POST', `${base()}/training/paths/${p.body.id}/assign`, { token: hq.token, body: { ownerGroupId: groupB, dueInDays: 30, source: 'onboarding', sourceRef: 'onboarding-project-123' } });
    expect(r.status).toBe(201);
    expect(r.body.enrolled).toBe(2); // Fiona (owner) + Sky (staff at B's location)
    expect((await call(app, 'GET', `${base()}/training/home`, { token: franB.token })).body.enrolments.map((e: any) => e.source)).toEqual(['assignment']);
  });

  it('sells a public course on the brand site: leads to trainers, enrolment paid through the signed payment webhook', async () => {
    const c = await call(app, 'POST', `${base()}/training/courses`, { token: hq.token, body: { title: '200-hour teacher training', visibility: 'public', priceMinor: 350000, currency: 'CAD', saleLocationId: la1.id, seats: 20, startsOn: '2027-02-01', trainerUserIds: [trainer.userId] } });
    expect(c.status).toBe(201);
    const m = await call(app, 'POST', `${base()}/training/courses/${c.body.id}/modules`, { token: hq.token, body: { title: 'Weekend 1' } });
    await call(app, 'POST', `${base()}/training/modules/${m.body.id}/lessons`, { token: hq.token, body: { title: 'Philosophy', body: 'Intro' } });
    expect((await call(app, 'GET', `/v1/public/courses/${orgSlug}/${c.body.slug}`)).status).toBe(404);
    await call(app, 'POST', `${base()}/training/courses/${c.body.id}/review`, { token: hq.token, body: { decision: 'approve' } });
    const pub = await call(app, 'GET', `/v1/public/courses/${orgSlug}`);
    expect(pub.body.items.map((x: any) => x.slug)).toContain(c.body.slug);
    const detail = await call(app, 'GET', `/v1/public/courses/${orgSlug}/${c.body.slug}`);
    expect(detail.body.course).toMatchObject({ price: { amount: 350000, currency: 'CAD' }, purchasable: true, seatsLeft: 20 });

    const lead = await call(app, 'POST', `/v1/public/courses/${orgSlug}/${c.body.slug}/leads`, { body: { name: 'Lee Learner', email: `lee-${uid()}@example.com`, message: 'Payment plans?', utm: { source: 'meta', campaign: 'ytt-spring' } } });
    expect(lead.status).toBe(201);
    const tl = await call(app, 'GET', `${base()}/training/leads`, { token: trainer.token });
    expect(tl.body.items.find((x: any) => x.id === lead.body.id)).toMatchObject({ source: 'ad_campaign', campaign: 'ytt-spring', assignedTo: { id: trainer.userId } });
    expect((await call(app, 'GET', `${base()}/training/leads`, { token: franA.token })).status).toBe(403);
    expect((await notes(trainer.userId, 'course_lead')).length).toBeGreaterThan(0);

    const buyer = `buyer-${uid()}@example.com`;
    const enrol = await call(app, 'POST', `/v1/public/courses/${orgSlug}/${c.body.slug}/enrol`, { body: { name: 'Bea Buyer', email: buyer, acceptTerms: true, utm: { campaign: 'ytt-spring' } } });
    expect(enrol.status).toBe(201);
    expect(enrol.body).toMatchObject({ status: 'pending_payment', payment: { sandbox: true, amount: 350000, currency: 'CAD' } });
    const [pay] = await app.ctx.db.select().from(paymentReferences).where(eq(paymentReferences.id, enrol.body.payment.id));
    expect(pay!.targetType).toBe('course_enrolment');
    const payload = JSON.stringify({
      id: `evt_${uid()}`, object: 'event', type: 'payment_intent.succeeded', api_version: '2026-09-30', created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null },
      data: { object: { id: pay!.externalId, object: 'payment_intent', amount: 350000, amount_received: 350000, currency: 'cad', status: 'succeeded', metadata: {} } },
    });
    const hook = await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload, headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(payload, WEBHOOK_SECRET) } });
    expect(hook.statusCode).toBe(200);
    const [e] = await app.ctx.db.select().from(enrolments).where(eq(enrolments.id, enrol.body.enrolmentId));
    expect(e!.status).toBe('active');
    const status = await call(app, 'GET', `/v1/public/course-enrolments/${enrol.body.enrolmentId}?token=${enrol.body.accessToken}`);
    expect(status.body.status).toBe('active');
    const leads = await call(app, 'GET', `${base()}/training/leads?status=enrolled`, { token: hq.token });
    expect(leads.body.items.map((x: any) => x.email)).toContain(buyer);
    expect((await call(app, 'POST', `/v1/public/courses/${orgSlug}/${c.body.slug}/enrol`, { body: { name: 'Bea Buyer', email: buyer, acceptTerms: true } })).body.error.code).toBe('already_enrolled');
    const recon = await call(app, 'GET', `${base()}/payments/reconciliation`, { token: owner.token });
    expect(recon.body.items.filter((i: any) => i.paymentId === pay!.id)).toEqual([]);
  });

  // ───────────── Help desk ─────────────
  let ticketId: string; let ticketNo: number;
  it('raises tickets with SLA targets, auto-assigns to HQ and keeps internal notes internal', async () => {
    const cat = await call(app, 'POST', `${base()}/helpdesk/categories`, { token: hq.token, body: { name: 'Payments', firstResponseMinutes: 60, resolutionMinutes: 480, defaultAssigneeId: hq.userId } });
    expect(cat.status).toBe(201);
    expect((await call(app, 'POST', `${base()}/helpdesk/categories`, { token: staffA.token, body: { name: 'x' } })).status).toBe(403);
    const t = await call(app, 'POST', `${base()}/helpdesk/tickets`, { token: staffA.token, body: { subject: 'Card reader offline', body: 'Front desk reader shows error 12', categoryId: cat.body.id, priority: 'urgent' } });
    expect(t.status).toBe(201);
    ticketId = t.body.id; ticketNo = t.body.number;
    expect(t.body.assignee.id).toBe(hq.userId);
    expect(t.body.location.id).toBe(la1.id);
    const fr = new Date(t.body.sla.firstResponse.dueAt).getTime() - new Date(t.body.createdAt).getTime();
    expect(Math.round(fr / 60_000)).toBe(15); // urgent = a quarter of 60 minutes
    expect((await notes(hq.userId, 'ticket_assigned')).length).toBe(1);
    expect((await call(app, 'GET', `${base()}/helpdesk/tickets/${ticketId}`, { token: staffB.token })).status).toBe(404);
    expect((await call(app, 'GET', `${base()}/helpdesk/tickets/${ticketId}`, { token: franA.token })).status).toBe(200);
    expect((await call(app, 'PATCH', `${base()}/helpdesk/tickets/${ticketId}`, { token: staffA.token, body: { priority: 'low' } })).status).toBe(403);
    expect((await call(app, 'PATCH', `${base()}/helpdesk/tickets/${ticketId}`, { token: hq.token, body: { assigneeId: staffA.userId } })).status).toBe(400);

    await call(app, 'POST', `${base()}/helpdesk/tickets/${ticketId}/messages`, { token: hq.token, body: { body: 'Known issue with firmware 3.2', internal: true } });
    const reply = await call(app, 'POST', `${base()}/helpdesk/tickets/${ticketId}/messages`, { token: hq.token, body: { body: 'Please restart the reader and tell us if it is back.' } });
    expect(reply.body.ticket.status).toBe('pending');
    expect(reply.body.ticket.sla.firstResponse.state).toBe('met');
    expect(reply.body.ticket.sla.resolution.state).toBe('paused');
    const asStaff = await call(app, 'GET', `${base()}/helpdesk/tickets/${ticketId}`, { token: staffA.token });
    expect(asStaff.body.messages.map((m: any) => m.internal)).toEqual([false, false]);
    expect((await call(app, 'GET', `${base()}/helpdesk/tickets/${ticketId}`, { token: hq.token })).body.messages).toHaveLength(3);
    const back = await call(app, 'POST', `${base()}/helpdesk/tickets/${ticketId}/messages`, { token: staffA.token, body: { body: 'Still offline.' } });
    expect(back.body.ticket.status).toBe('open');
    expect((await call(app, 'POST', `${base()}/helpdesk/tickets/${ticketId}/messages`, { token: staffA.token, body: { body: 'x', internal: true } })).status).toBe(400);
  });

  it('alerts on SLA breaches once, resolves, collects a satisfaction rating and accepts email-in', async () => {
    await app.ctx.db.update(tickets).set({ resolutionDueAt: new Date(Date.now() - 60_000) }).where(eq(tickets.id, ticketId));
    expect(await runHelpdeskSla(app.ctx)).toBeGreaterThanOrEqual(1);
    expect(await runHelpdeskSla(app.ctx)).toBe(0);
    expect((await notes(hq.userId, 'sla')).length).toBe(1);
    const list = await call(app, 'GET', `${base()}/helpdesk/tickets`, { token: hq.token });
    expect(list.body.items.find((x: any) => x.id === ticketId).sla.resolution.state).toBe('breached');
    expect((await call(app, 'POST', `${base()}/helpdesk/tickets/${ticketId}/rating`, { token: staffA.token, body: { score: 5 } })).body.error.code).toBe('not_resolved');
    const res = await call(app, 'PATCH', `${base()}/helpdesk/tickets/${ticketId}`, { token: hq.token, body: { status: 'resolved' } });
    expect(res.body.status).toBe('resolved');
    expect((await call(app, 'POST', `${base()}/helpdesk/tickets/${ticketId}/rating`, { token: franA.token, body: { score: 1 } })).status).toBe(403);
    const rate = await call(app, 'POST', `${base()}/helpdesk/tickets/${ticketId}/rating`, { token: staffA.token, body: { score: 5, comment: 'Quick help' } });
    expect(rate.body).toEqual({ satisfaction: 5, status: 'closed' });

    const ov = await call(app, 'GET', `${base()}/helpdesk/overview`, { token: hq.token });
    expect(ov.body.inboundAddress).toMatch(new RegExp(`^support\\+${orgSlug}\\.[a-z0-9x]+@`));
    expect(ov.body.satisfaction).toMatchObject({ average: 5, responses: 1 });
    expect((await call(app, 'GET', `${base()}/helpdesk/overview`, { token: staffA.token })).body.inboundAddress).toBeNull();
    const mail = await call(app, 'POST', '/v1/helpdesk/inbound-email', { body: { to: ov.body.inboundAddress, from: staffB.email, subject: 'Booking sync error', text: 'Mindbody shows 2 errors' } });
    expect(mail.status).toBe(201);
    const [created] = await app.ctx.db.select().from(tickets).where(eq(tickets.id, mail.body.ticketId));
    expect(created).toMatchObject({ channel: 'email', requesterId: staffB.userId, locationId: lb1.id });
    const threaded = await call(app, 'POST', '/v1/helpdesk/inbound-email', { body: { to: ov.body.inboundAddress, from: staffB.email, subject: `Re: [#${mail.body.number}] Booking sync error`, text: 'Screenshot attached' } });
    expect(threaded.body.threaded).toBe(true);
    expect((await call(app, 'POST', '/v1/helpdesk/inbound-email', { body: { to: ov.body.inboundAddress, from: 'stranger@example.com', subject: 'Hi', text: 'Hello' } })).status).toBe(403);
    expect((await call(app, 'POST', '/v1/helpdesk/inbound-email', { body: { to: `support+${orgSlug}.wrongtoken@inbound.branchharbor.com`, from: staffB.email, subject: 'Hi', text: 'Hello' } })).status).toBe(404);
    expect(ticketNo).toBeGreaterThan(1000);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';
import { attendance, consentRecords, registrations, sportsInstalments, sportsNotifications, trainingSessions } from '../src/db/schema/index.ts';
import { runInstalmentReminders } from '../src/services/sports-core.ts';
import { guardiansOf } from '../src/services/sports-notify.ts';
import type { AiProvider } from '../src/integrations/ai.ts';

const answers = (extra: Record<string, unknown> = {}) => ({ emergency_contact_name: 'Robin Grey', emergency_contact_phone: '+1 416 555 0199', medical_notes: 'Peanut allergy — carries EpiPen', medical_action_plan: 'EpiPen in the blue bag', photo_consent: true, ...extra });
const isoDay = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);

describe.skipIf(!hasDb)('sports full product (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string };
  let coachA: { token: string; userId: string };
  let coachB: { token: string; userId: string };
  let orgId: string;
  let loc: any;
  let setup: any;
  let pCap: any; // capacity 1, approval required
  let pFlow: any; // capacity 1, no approval (hold expiry)
  let pInst: any; // instalments, no approval, sibling discount
  let teamA: any, teamB: any, squad: any;
  let pitch1: any, pitch2: any;
  const o = (p: string) => `/v1/orgs/${orgId}${p}`;

  let ipSeq = 0;
  // Public registration is rate limited per visitor; give each simulated family its own address.
  const register = (programmeId: string, guardianEmail: string, child: string, dob: string, extra: Record<string, unknown> = {}) =>
    call(app, 'POST', `/v1/public/sports/programmes/${programmeId}/registrations`, { headers: { 'x-forwarded-for': `10.9.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}` }, body: { guardian: { name: `Guardian of ${child}`, email: guardianEmail }, participant: { name: child, dateOfBirth: dob }, relationship: 'parent', answers: answers(), acceptRefundPolicy: true, absenceAlerts: true, ...extra } });
  const confirm = (paymentId: string, outcome: 'succeeded' | 'failed' = 'succeeded') => call(app, 'POST', `/v1/public/payments/${paymentId}/sandbox-confirm`, { body: { outcome } });
  const portal = async (locationId: string, email: string) => {
    const link = await call(app, 'POST', '/v1/public/sports/portal/request-link', { body: { locationId, email } });
    expect(link.status).toBe(202);
    const sess = await call(app, 'POST', '/v1/public/sports/portal/session', { body: { token: link.body.devLinkToken } });
    expect(sess.status).toBe(200);
    return sess.body.portalToken as string;
  };
  const acceptInto = async (programme: any, email: string, child: string, team: any, dob = '2017-03-03') => {
    const r = await register(programme.id, email, child, dob);
    expect(r.status).toBe(201);
    if (r.body.payment) expect((await confirm(r.body.payment.id)).status).toBe(200);
    if (team) {
      const reg = (await app.ctx.db.select().from(registrations).where(eq(registrations.id, r.body.registration.id)))[0]!;
      if (reg.status === 'accepted') await app.ctx.db.update(registrations).set({ teamId: team.id }).where(eq(registrations.id, reg.id));
      else expect((await call(app, 'POST', o(`/sports/registrations/${reg.id}/review`), { token: owner.token, body: { decision: 'accept', teamId: team.id } })).status).toBe(200);
    }
    return r.body;
  };

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Director Dana');
    orgId = (await createOrg(app, owner.token, { industry: 'sports' })).id;
    loc = await createLocation(app, owner.token, orgId, { name: 'Lakeshore' });
    await enablePublicAndPayments(app, owner.token, orgId, loc.id);
    coachA = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: loc.id }, 'Coach Alex');
    coachB = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: loc.id }, 'Coach Blair');
    const fee = { refundPolicy: 'Full refund before the first session; none afterwards.' };
    const res = await call(app, 'POST', o('/sports/setup'), {
      token: owner.token,
      body: {
        locationId: loc.id, publish: true,
        season: { name: 'Fall 2026', startsOn: isoDay(-30), endsOn: isoDay(120), ageRule: 'birth_year', ageCutoffDate: '2026-12-31' },
        venues: [{ name: 'Pitch 1', kind: 'pitch' }, { name: 'Pitch 2', kind: 'pitch' }],
        programmes: [
          { name: 'Elite trial', ageMin: 8, ageMax: 10, capacity: 1, feeMinor: 10_000, requiresApproval: true, ...fee, feePlans: [{ name: 'Pay in full', kind: 'full' }] },
          { name: 'Drop-in', ageMin: 8, ageMax: 10, capacity: 1, feeMinor: 5_000, requiresApproval: false, ...fee, holdMinutes: 10 },
          {
            name: 'Youth league', ageMin: 6, ageMax: 12, capacity: 30, feeMinor: 30_000, requiresApproval: false, siblingDiscountBps: 1000, ...fee,
            feePlans: [{ name: 'Pay in full', kind: 'full' }, { name: '3 instalments', kind: 'instalments', schedule: [{ dueOn: isoDay(0), shareBps: 3334 }, { dueOn: isoDay(30), shareBps: 3333 }, { dueOn: isoDay(60), shareBps: 3333 }] }],
            teams: [{ name: 'U10 Blue', capacity: 1, coachUserId: coachA.userId }, { name: 'U10 Red', capacity: 5, coachUserId: coachB.userId }, { name: 'Cup squad', kind: 'squad', capacity: 3 }],
          },
        ],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    setup = res.body;
    [pCap, pFlow, pInst] = setup.programmes;
    [teamA, teamB, squad] = pInst.teams;
    [pitch1, pitch2] = setup.venues;
  });
  afterAll(async () => { await app?.close(); });

  it('setup wizard: season → programmes with age rule, venues, fee plans and groups; catalogue filters by date of birth', async () => {
    expect(setup.season.ageRule).toBe('birth_year');
    expect(pInst.teams).toHaveLength(3);
    const bad = await call(app, 'POST', o('/sports/setup'), { token: owner.token, body: { locationId: loc.id, season: { name: 'x', startsOn: isoDay(0), endsOn: isoDay(10) }, programmes: [{ name: 'Paid no policy', feeMinor: 100 }] } });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.fields)).toContain('programmes.0.refundPolicy');
    const coachTry = await call(app, 'POST', o('/sports/setup'), { token: coachA.token, body: { locationId: loc.id, season: { name: 'x', startsOn: isoDay(0), endsOn: isoDay(10) }, programmes: [{ name: 'Free' }] } });
    expect(coachTry.status).toBe(403);
    const preview = await call(app, 'GET', o(`/sports/age-preview?locationId=${loc.id}&startsOn=2026-09-01&endsOn=2027-06-01&ageMin=8&ageMax=10`), { token: owner.token });
    expect(preview.body).toMatchObject({ rule: 'birth_year', cutoffDate: '2027-12-31', birthDates: { from: '2017-01-01', to: '2019-12-31' } });
    const all = await call(app, 'GET', `/v1/public/sports/${loc.id}/programmes`);
    expect(all.body.items).toHaveLength(3);
    const young = await call(app, 'GET', `/v1/public/sports/${loc.id}/programmes?dob=2019-06-01`); // 7 in 2026 → only Youth league (6–12)
    expect(young.body.items.map((p: any) => p.name)).toEqual(['Youth league']);
    const yl = all.body.items.find((p: any) => p.name === 'Youth league');
    expect(yl.paymentOptions.find((x: any) => x.kind === 'instalments').instalments.map((i: any) => i.amountMinor)).toEqual([10_002, 9999, 9999]);
    expect(yl.questions.find((q: any) => q.key === 'medical_notes').restricted).toBe(true);
  });

  it('age eligibility is enforced at registration with the participant\'s age group in the error', async () => {
    const r = await register(pCap.id, `old-${uid()}@example.com`, 'Too Old', '2014-05-05');
    expect(r.status).toBe(400);
    expect(r.body.error.fields['participant.dateOfBirth']).toMatch(/12 \(U12\)/);
  });

  it('capacity and approval rules survive failed payments, retries and duplicate webhooks', async () => {
    const a = await register(pCap.id, `ga-${uid()}@example.com`, 'Ada Lane', '2017-04-04');
    expect(a.status).toBe(201);
    expect(a.body.registration.status).toBe('submitted');
    const b = await register(pCap.id, `gb-${uid()}@example.com`, 'Ben Hale', '2017-05-05');
    expect(b.body.registration.status).toBe('waitlisted'); // A's place is held while paying
    expect(b.body.payment).toBeNull();

    expect((await confirm(a.body.payment.id, 'failed')).status).toBe(200);
    const retry = await call(app, 'POST', `/v1/public/sports/registrations/${a.body.registration.id}/pay`, { body: { manageToken: a.body.manageToken } });
    expect(retry.status).toBe(200);
    expect(retry.body.payment.id).not.toBe(a.body.payment.id);
    expect((await confirm(retry.body.payment.id)).status).toBe(200);
    // Duplicate delivery and a late success on the failed intent change nothing.
    await confirm(retry.body.payment.id);
    await confirm(a.body.payment.id);
    let ra = (await app.ctx.db.select().from(registrations).where(eq(registrations.id, a.body.registration.id)))[0]!;
    expect(ra.status).toBe('awaiting_review'); // paid ≠ selected
    const wrongToken = await call(app, 'POST', `/v1/public/sports/registrations/${a.body.registration.id}/pay`, { body: { manageToken: 'x'.repeat(30) } });
    expect(wrongToken.status).toBe(404);

    expect((await call(app, 'POST', o(`/sports/registrations/${a.body.registration.id}/review`), { token: owner.token, body: { decision: 'accept' } })).status).toBe(200);
    const fromWaitlist = await call(app, 'POST', o(`/sports/registrations/${b.body.registration.id}/review`), { token: owner.token, body: { decision: 'accept' } });
    expect(fromWaitlist.status).toBe(409);
    expect(fromWaitlist.body.error.code).toBe('programme_full');
    ra = (await app.ctx.db.select().from(registrations).where(eq(registrations.id, a.body.registration.id)))[0]!;
    expect(ra.status).toBe('accepted');
  });

  it('a payment that arrives after the hold expired never oversells: the late payer is waitlisted for review', async () => {
    const g1 = await register(pFlow.id, `g1-${uid()}@example.com`, 'Cal Moss', '2017-01-02');
    await app.ctx.db.update(registrations).set({ holdExpiresAt: new Date(Date.now() - 60_000) }).where(eq(registrations.id, g1.body.registration.id));
    const g2 = await register(pFlow.id, `g2-${uid()}@example.com`, 'Dee Park', '2017-01-03');
    expect(g2.body.registration.status).toBe('submitted'); // the expired hold released the place
    await confirm(g1.body.payment.id); // late
    await confirm(g2.body.payment.id);
    const rows = await app.ctx.db.select().from(registrations).where(eq(registrations.programmeId, pFlow.id));
    expect(rows.find((r) => r.id === g1.body.registration.id)!.status).toBe('waitlisted');
    expect(rows.find((r) => r.id === g1.body.registration.id)!.reviewNote).toMatch(/refund/);
    expect(rows.find((r) => r.id === g2.body.registration.id)!.status).toBe('accepted');
    expect(rows.filter((r) => r.status === 'accepted')).toHaveLength(1);
    const again = await call(app, 'POST', `/v1/public/sports/registrations/${g1.body.registration.id}/pay`, { body: { manageToken: g1.body.manageToken } });
    expect(again.status).toBe(409);
  });

  it('instalments: schedule, first payment at checkout, sibling discount, unpaid → due/overdue, reminders once per stage, aid and waivers', async () => {
    const email = `fam-${uid()}@example.com`;
    const plan = (await call(app, 'GET', `/v1/public/sports/${loc.id}/programmes`)).body.items.find((p: any) => p.name === 'Youth league').paymentOptions.find((x: any) => x.kind === 'instalments');
    const r1 = await register(pInst.id, email, 'Eli Stone', '2017-02-02', { feePlanId: plan.id });
    expect(r1.body.instalments.map((i: any) => i.amount.amount)).toEqual([10_002, 9999, 9999]);
    expect(r1.body.payment.amount).toBe(10_002);
    await confirm(r1.body.payment.id);
    const inst = await app.ctx.db.select().from(sportsInstalments).where(eq(sportsInstalments.registrationId, r1.body.registration.id));
    expect(inst.map((i) => i.status).sort()).toEqual(['paid', 'scheduled', 'scheduled']);
    expect((await app.ctx.db.select().from(registrations).where(eq(registrations.id, r1.body.registration.id)))[0]!.status).toBe('accepted');

    // Sibling (same guardian, same season): 10% off.
    const r2 = await register(pInst.id, email, 'Fay Stone', '2018-02-02');
    expect(r2.body.registration.totalFee.amount).toBe(27_000);
    await confirm(r2.body.payment.id);

    // 45 days later the second instalment is overdue: one reminder per stage, never repeated.
    const later = new Date(Date.now() + 45 * 86400_000);
    const run1 = await runInstalmentReminders(app.ctx, later, orgId);
    expect(run1.sent).toBeGreaterThanOrEqual(1);
    const run2 = await runInstalmentReminders(app.ctx, later, orgId);
    expect(run2.sent).toBe(0);
    const reminders = await app.ctx.db.select().from(sportsNotifications).where(and(eq(sportsNotifications.kind, 'instalment_reminder'), eq(sportsNotifications.organizationId, orgId)));
    expect(reminders.length).toBe(run1.sent);
    await app.ctx.db.update(sportsInstalments).set({ dueOn: isoDay(-3) }).where(and(eq(sportsInstalments.registrationId, r1.body.registration.id), eq(sportsInstalments.seq, 2)));
    const bal = await call(app, 'GET', o('/sports/balances?state=overdue'), { token: owner.token });
    const mine = bal.body.items.find((x: any) => x.registrationId === r1.body.registration.id);
    expect(mine.balance).toMatchObject({ state: 'overdue', overdue: 9999, outstanding: 19_998, paid: 10_002 });
    expect(bal.body.totals.find((t: any) => t.currency === 'CAD').overdue).toBeGreaterThanOrEqual(9999);
    expect(bal.body.combined).toBeNull();

    // Coaches cannot grant aid; directors can; amounts never exceed what is owed.
    expect((await call(app, 'POST', o(`/sports/registrations/${r1.body.registration.id}/fee-adjustments`), { token: coachA.token, body: { kind: 'financial_aid', amountMinor: 5000, reason: 'Hardship fund' } })).status).toBe(403);
    expect((await call(app, 'POST', o(`/sports/registrations/${r1.body.registration.id}/fee-adjustments`), { token: owner.token, body: { kind: 'financial_aid', amountMinor: 50_000, reason: 'Too much' } })).status).toBe(400);
    expect((await call(app, 'POST', o(`/sports/registrations/${r1.body.registration.id}/fee-adjustments`), { token: owner.token, body: { kind: 'financial_aid', amountMinor: 15_000, reason: 'Hardship fund' } })).status).toBe(201);
    let after = await app.ctx.db.select().from(sportsInstalments).where(eq(sportsInstalments.registrationId, r1.body.registration.id));
    expect(after.filter((i) => i.status === 'scheduled').reduce((a, i) => a + i.amountMinor, 0)).toBe(4998);
    expect(after.find((i) => i.seq === 3)!.status).toBe('waived');
    expect((await call(app, 'POST', o(`/sports/registrations/${r1.body.registration.id}/fee-adjustments`), { token: owner.token, body: { kind: 'waiver', waiveAll: true, reason: 'Coach volunteer family' } })).status).toBe(201);
    after = await app.ctx.db.select().from(sportsInstalments).where(eq(sportsInstalments.registrationId, r1.body.registration.id));
    expect(after.every((i) => i.status !== 'scheduled')).toBe(true);
  });

  it('guardian portal: a guardian only sees and acts for their own participants; invitations and disputes control access', async () => {
    const emailA = `pa-${uid()}@example.com`;
    const emailB = `pb-${uid()}@example.com`;
    const a = await acceptInto(pInst, emailA, 'Gus Reed', teamB);
    const b = await acceptInto(pInst, emailB, 'Hal Wren', teamB);
    const tokA = await portal(loc.id, emailA);
    const tokB = await portal(loc.id, emailB);
    const ovA = await call(app, 'POST', '/v1/public/sports/portal/overview', { body: { portalToken: tokA } });
    expect(ovA.body.participants.map((p: any) => p.name)).toEqual(['Gus Reed']);
    const unknown = await call(app, 'POST', '/v1/public/sports/portal/request-link', { body: { locationId: loc.id, email: `nobody-${uid()}@example.com` } });
    expect(unknown.status).toBe(202);
    expect(unknown.body.devLinkToken).toBeUndefined();

    // B's records are invisible to A.
    const bReg = (await app.ctx.db.select().from(registrations).where(eq(registrations.id, b.registration.id)))[0]!;
    const bInst = (await app.ctx.db.select().from(sportsInstalments).where(eq(sportsInstalments.registrationId, bReg.id)))[0];
    if (bInst) expect((await call(app, 'POST', `/v1/public/sports/portal/instalments/${bInst.id}/pay`, { body: { portalToken: tokA } })).status).toBe(404);
    const [sess] = await app.ctx.db.insert(trainingSessions).values({ organizationId: orgId, locationId: loc.id, teamId: teamB.id, startsAt: new Date(Date.now() + 86400_000), endsAt: new Date(Date.now() + 86400_000 + 5400_000), venue: 'Pitch 2', venueId: pitch2.id }).returning();
    expect((await call(app, 'POST', '/v1/public/sports/portal/absences', { body: { portalToken: tokA, participantId: bReg.participantCustomerId, sessionId: sess!.id, reason: 'illness' } })).status).toBe(404);
    const own = await call(app, 'POST', '/v1/public/sports/portal/absences', { body: { portalToken: tokA, participantId: ovA.body.participants[0].id, sessionId: sess!.id, reason: 'illness', note: 'Fever' } });
    expect(own.status).toBe(201);
    expect((await call(app, 'POST', '/v1/public/sports/portal/overview', { body: { portalToken: 'z'.repeat(40) } })).status).toBe(401);

    // Second guardian: invited by A, verified by accepting the emailed token.
    const partner = `partner-${uid()}@example.com`;
    const inv = await call(app, 'POST', '/v1/public/sports/portal/invitations', { body: { portalToken: tokA, participantId: ovA.body.participants[0].id, email: partner, name: 'Pat Reed' } });
    expect(inv.status).toBe(201);
    expect((await call(app, 'POST', '/v1/public/sports/portal/invitations', { body: { portalToken: tokB, participantId: ovA.body.participants[0].id, email: `x-${uid()}@example.com` } })).status).toBe(404);
    const acc = await call(app, 'POST', '/v1/public/sports/invitations/accept', { body: { token: inv.body.devInvitationToken } });
    expect(acc.status).toBe(200);
    expect((await call(app, 'POST', '/v1/public/sports/invitations/accept', { body: { token: inv.body.devInvitationToken } })).status).toBe(401);
    const ovP = await call(app, 'POST', '/v1/public/sports/portal/overview', { body: { portalToken: acc.body.portalToken } });
    expect(ovP.body.participants.map((p: any) => p.name)).toEqual(['Gus Reed']);

    // A disputes the partner's relationship → partner loses access until the club resolves it.
    const relId = (await call(app, 'POST', '/v1/public/sports/portal/overview', { body: { portalToken: tokA } })).body.participants[0].otherGuardians[0].relationshipId;
    const disp = await call(app, 'POST', '/v1/public/sports/portal/disputes', { body: { portalToken: tokA, relationshipId: relId, reason: 'This person is not a parent of my child' } });
    expect(disp.status).toBe(201);
    expect((await call(app, 'POST', '/v1/public/sports/portal/overview', { body: { portalToken: acc.body.portalToken } })).body.participants).toEqual([]);
    expect((await call(app, 'POST', o(`/sports/disputes/${disp.body.id}/resolve`), { token: coachA.token, body: { outcome: 'dismiss', note: 'checked' } })).status).toBe(403);
    expect((await call(app, 'POST', o(`/sports/disputes/${disp.body.id}/resolve`), { token: owner.token, body: { outcome: 'dismiss', note: 'Verified birth certificate in person' } })).status).toBe(200);
    expect((await call(app, 'POST', '/v1/public/sports/portal/overview', { body: { portalToken: acc.body.portalToken } })).body.participants).toHaveLength(1);

    // App account with the same verified email sees the same participant (and only that one).
    const stranger = await verifiedUser(app, 'Someone Else');
    expect((await call(app, 'GET', '/v1/me/sports', { token: stranger.token })).body.participants).toEqual([]);
    const su = await call(app, 'POST', '/v1/auth/signup', { body: { name: 'Gus Parent', email: emailA, password: 'correct horse battery staple', acceptTerms: true } });
    const ver = await call(app, 'POST', '/v1/auth/verify-email', { body: { token: su.body.devVerificationToken } });
    const me = await call(app, 'GET', '/v1/me/sports', { token: ver.body.accessToken });
    expect(me.body.participants.map((p: any) => p.name)).toEqual(['Gus Reed']);
    expect(me.body.schedule.some((x: any) => x.id === sess!.id)).toBe(true);
    expect((await call(app, 'POST', '/v1/me/sports/absences', { token: ver.body.accessToken, body: { participantId: bReg.participantCustomerId, sessionId: sess!.id, reason: 'illness' } })).status).toBe(404);
  });

  it('transfers check the target group capacity and keep history; coaches cannot transfer', async () => {
    const p1 = await acceptInto(pInst, `t1-${uid()}@example.com`, 'Ivy Cole', teamA);
    const p2 = await acceptInto(pInst, `t2-${uid()}@example.com`, 'Jo Cole', teamB);
    const full = await call(app, 'POST', o(`/sports/registrations/${p2.registration.id}/transfer`), { token: owner.token, body: { toTeamId: teamA.id, reason: 'Friends' } });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('team_full');
    expect((await call(app, 'POST', o(`/sports/registrations/${p1.registration.id}/transfer`), { token: coachA.token, body: { toTeamId: teamB.id } })).status).toBe(403);
    const ok = await call(app, 'POST', o(`/sports/registrations/${p1.registration.id}/transfer`), { token: owner.token, body: { toTeamId: teamB.id, reason: 'Better age fit' } });
    expect(ok.status).toBe(200);
    const nowOk = await call(app, 'POST', o(`/sports/registrations/${p2.registration.id}/transfer`), { token: owner.token, body: { toTeamId: teamA.id } });
    expect(nowOk.status).toBe(200);
    const detail = await call(app, 'GET', o(`/sports/teams/${teamA.id}`), { token: owner.token });
    expect(detail.body.moves.map((m: any) => m.participant).sort()).toEqual(['Ivy Cole', 'Jo Cole']);
    expect(detail.body.roster.map((r: any) => r.name)).toEqual(['Jo Cole']);
  });

  it('coach-scoped access: own team roster with coach-visible care notes only; other teams forbidden; selection needs a different director', async () => {
    const [sA] = await app.ctx.db.insert(trainingSessions).values({ organizationId: orgId, locationId: loc.id, teamId: teamA.id, startsAt: new Date(Date.now() + 2 * 86400_000), endsAt: new Date(Date.now() + 2 * 86400_000 + 5400_000), venue: 'Pitch 1', venueId: pitch1.id }).returning();
    expect((await call(app, 'GET', o(`/sports/sessions/${sA!.id}/roster`), { token: coachB.token })).status).toBe(403);
    const roster = await call(app, 'GET', o(`/sports/sessions/${sA!.id}/roster`), { token: coachA.token });
    expect(roster.status).toBe(200);
    const kid = roster.body.roster[0];
    expect(kid.care.emergencyContact.phone).toBe('+1 416 555 0199');
    expect(kid.care.actionPlan).toBe('EpiPen in the blue bag');
    expect(JSON.stringify(roster.body)).not.toContain('Peanut');
    const reg = (await app.ctx.db.select().from(registrations).where(and(eq(registrations.teamId, teamA.id), eq(registrations.status, 'accepted'))))[0]!;
    const coachView = await call(app, 'GET', o(`/sports/registrations/${reg.id}/restricted`), { token: coachA.token });
    expect(coachView.body.access).toBe('coach');
    expect(coachView.body.answers.medical_notes).toBeUndefined();
    expect((await call(app, 'GET', o(`/sports/registrations/${reg.id}/restricted`), { token: coachB.token })).status).toBe(403);
    const full = await call(app, 'GET', o(`/sports/registrations/${reg.id}/restricted`), { token: owner.token });
    expect(full.body.answers.medical_notes).toMatch(/Peanut/);
    expect((await call(app, 'GET', o('/sports/registrations'), { token: coachA.token })).body.items).toEqual([]);

    const sel = await call(app, 'POST', o('/sports/selections'), { token: coachA.token, body: { squadTeamId: squad.id, title: 'Spring cup', participants: [{ id: reg.participantCustomerId, note: 'Attended every session' }] } });
    expect(sel.status).toBe(201);
    expect((await call(app, 'POST', o(`/sports/selections/${sel.body.id}/decision`), { token: coachA.token, body: { decision: 'approve' } })).status).toBe(403);
    const dec = await call(app, 'POST', o(`/sports/selections/${sel.body.id}/decision`), { token: owner.token, body: { decision: 'approve' } });
    expect(dec.status).toBe(200);
    expect(dec.body.added).toBe(1);
    const team = await call(app, 'GET', o(`/sports/teams/${squad.id}`), { token: owner.token });
    expect(team.body.roster).toHaveLength(1);
    const ownSel = await call(app, 'POST', o('/sports/selections'), { token: owner.token, body: { squadTeamId: squad.id, title: 'Self', participants: [{ id: reg.participantCustomerId }] } });
    expect((await call(app, 'POST', o(`/sports/selections/${ownSel.body.id}/decision`), { token: owner.token, body: { decision: 'approve' } })).status).toBe(403);
  });

  it('notifications reach only the affected group: cancellation, announcement and consent-aware absence alerts', async () => {
    // Every verified guardian of a participant on the team (registrant + accepted second guardians).
    const rosterGuardians = async (team: any) => {
      const regs = await app.ctx.db.select().from(registrations).where(and(eq(registrations.teamId, team.id), eq(registrations.status, 'accepted')));
      return new Set((await guardiansOf(app.ctx.db, orgId, regs.map((r) => r.participantCustomerId))).map((g) => g.guardian.id));
    };
    const [sB] = await app.ctx.db.insert(trainingSessions).values({ organizationId: orgId, locationId: loc.id, teamId: teamB.id, startsAt: new Date(Date.now() + 3 * 86400_000), endsAt: new Date(Date.now() + 3 * 86400_000 + 5400_000), venue: 'Pitch 2', venueId: pitch2.id }).returning();
    const cancel = await call(app, 'POST', o(`/sports/sessions/${sB!.id}/cancel`), { token: coachB.token, body: { reason: 'Pitch waterlogged' } });
    expect(cancel.status).toBe(200);
    const gB = await rosterGuardians(teamB);
    const sent = await app.ctx.db.select().from(sportsNotifications).where(and(eq(sportsNotifications.refType, 'training_session'), eq(sportsNotifications.refId, sB!.id)));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((n) => gB.has(n.guardianCustomerId))).toBe(true);
    const gA = await rosterGuardians(teamA);
    expect(sent.some((n) => gA.has(n.guardianCustomerId))).toBe(false);
    expect(cancel.body.delivery.recipients).toBe(sent.length);

    const ann = await call(app, 'POST', o('/sports/announcements'), { token: coachA.token, body: { scopeKind: 'team', scopeId: teamA.id, title: 'Bring water', body: 'Hot day on Saturday.' } });
    expect(ann.status).toBe(201);
    const annRows = await app.ctx.db.select().from(sportsNotifications).where(eq(sportsNotifications.refId, ann.body.id));
    expect(annRows.length).toBe(gA.size);
    expect(annRows.every((n) => gA.has(n.guardianCustomerId))).toBe(true);
    expect((await call(app, 'POST', o('/sports/announcements'), { token: coachA.token, body: { scopeKind: 'team', scopeId: teamB.id, title: 'x', body: 'y' } })).status).toBe(403);
    expect((await call(app, 'POST', o('/sports/announcements'), { token: coachA.token, body: { scopeKind: 'programme', scopeId: pInst.id, title: 'x', body: 'y' } })).status).toBe(403);

    // Absence alert: one guardian opted out → skipped, others notified.
    // Two participants with a single (registrant) guardian each, who opted in to absence alerts at registration.
    const allB = await app.ctx.db.select().from(registrations).where(and(eq(registrations.teamId, teamB.id), eq(registrations.status, 'accepted')));
    const regsB = [];
    for (const r of allB) if ((await guardiansOf(app.ctx.db, orgId, [r.participantCustomerId])).length === 1) regsB.push(r);
    const optOut = regsB[0]!;
    await app.ctx.db.insert(consentRecords).values({ organizationId: orgId, customerId: optOut.guardianCustomerId, purpose: 'sports_absence_alerts', version: '2026-10', granted: false, source: 'test' });
    const [sB2] = await app.ctx.db.insert(trainingSessions).values({ organizationId: orgId, locationId: loc.id, teamId: teamB.id, startsAt: new Date(Date.now() - 2 * 3600_000), endsAt: new Date(Date.now() - 600_000), venue: 'Pitch 2' }).returning();
    const marks = regsB.slice(0, 2).map((r) => ({ participantId: r.participantCustomerId, status: 'absent' }));
    const res = await call(app, 'POST', o(`/sports/sessions/${sB2!.id}/attendance`), { token: coachB.token, body: { marks } });
    expect(res.status).toBe(200);
    expect(res.body.skippedNoConsent).toBe(1);
    expect(res.body.notifiedGuardians).toBe(1);
    const again = await call(app, 'POST', o(`/sports/sessions/${sB2!.id}/attendance`), { token: coachB.token, body: { marks } });
    expect(again.body.notifiedGuardians).toBe(0); // never twice for the same absence
    expect((await app.ctx.db.select().from(attendance).where(eq(attendance.sessionId, sB2!.id))).every((a) => a.guardianNotifiedAt)).toBe(true);
  });

  it('venue conflicts: half-pitch clash detected, rule-based resolutions proposed, applying one clears the clash', async () => {
    const half = (await call(app, 'POST', o('/sports/venues'), { token: owner.token, body: { locationId: loc.id, name: 'Pitch 1 — half A', kind: 'pitch', parentVenueId: pitch1.id } })).body;
    const start = new Date(Date.now() + 5 * 86400_000);
    start.setUTCHours(21, 0, 0, 0);
    const mk = (team: any, venueId: string) => call(app, 'POST', o(`/sports/teams/${team.id}/sessions`), { token: owner.token, body: { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 5400_000).toISOString(), venueId } });
    await mk(teamA, pitch1.id);
    const clash = await mk(teamB, half.id);
    expect(clash.body.venueConflicts).toHaveLength(1);
    const res = await call(app, 'GET', o(`/sports/sessions/${clash.body.session.id}/resolutions`), { token: owner.token });
    expect(res.body.conflicts).toHaveLength(1);
    const venueMove = res.body.proposals.find((p: any) => p.proposal.kind === 'move_venue');
    expect(venueMove.proposal.venueName).toBe('Pitch 2');
    expect((await call(app, 'POST', o(`/sports/schedule-proposals/${venueMove.id}/apply`), { token: coachB.token, body: {} })).status).toBe(403);
    const applied = await call(app, 'POST', o(`/sports/schedule-proposals/${venueMove.id}/apply`), { token: owner.token, body: { notify: false } });
    expect(applied.status).toBe(200);
    expect((await call(app, 'GET', o(`/sports/sessions/${clash.body.session.id}/resolutions`), { token: owner.token })).body.conflicts).toEqual([]);
    const fx = await call(app, 'POST', o(`/sports/teams/${teamA.id}/fixtures`), { token: coachA.token, body: { opponent: 'Riverdale FC', homeAway: 'away', date: isoDay(9), kickoff: '10:30', venueName: 'Riverdale Park', notify: false } });
    expect(fx.status).toBe(201);
    expect(fx.body.kickoffLocal).toMatchObject({ time: '10:30', timeZone: 'America/Toronto' });
    const rec = await call(app, 'POST', o(`/sports/teams/${teamB.id}/recurring-sessions`), { token: owner.token, body: { weekdays: [2, 4], startTime: '18:00', durationMinutes: 60, from: isoDay(14), until: isoDay(27), venueId: pitch2.id } });
    expect(rec.status).toBe(201);
    expect(rec.body.created).toBe(4);
  });

  it('reports separate currencies and mark missing attendance as unavailable', async () => {
    const r = await call(app, 'GET', o('/sports/reports'), { token: owner.token });
    expect(r.status).toBe(200);
    expect(r.body.combinedBalance).toBeNull();
    expect(r.body.enrolment.find((e: any) => e.programme === 'Elite trial')).toMatchObject({ capacity: 1, accepted: 1, waitlisted: 1 });
    const squadAtt = r.body.attendance.find((a: any) => a.team === 'Cup squad');
    expect(squadAtt.rate).toBeNull();
    expect(squadAtt.rateUnavailableReason).toMatch(/No attendance/);
    expect((await call(app, 'GET', o('/sports/reports'), { token: coachA.token })).status).toBe(403);
  });
});

describe.skipIf(!hasDb)('sports AI: drafts and proposals only, never sensitive data in context (DB)', () => {
  let app: FastifyInstance;
  const prompts: string[] = [];
  const fakeAi: AiProvider = {
    enabled: true, model: 'test-model',
    async createMessage({ messages, tools }) {
      prompts.push(JSON.stringify(messages));
      const tool = tools[0]!;
      const input = tool.name === 'rank_options' ? { ranking: [{ index: 0, rationale: 'Same time, other pitch' }, { index: 99, rationale: 'invented' }] } : { text: 'A friendly draft.' };
      return { id: 'm', type: 'message', role: 'assistant', model: 'test-model', content: [{ type: 'tool_use', id: 't', name: tool.name, input }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as never;
    },
  };
  afterAll(async () => { await app?.close(); });

  it('description, enrolment summary and conflict ranking never include names, contacts or medical answers', async () => {
    app = await makeApp({ ai: fakeAi });
    const owner = await verifiedUser(app, 'AI Director');
    const orgId = (await createOrg(app, owner.token, { industry: 'sports' })).id;
    const loc = await createLocation(app, owner.token, orgId);
    await enablePublicAndPayments(app, owner.token, orgId, loc.id);
    const st = await call(app, 'POST', `/v1/orgs/${orgId}/sports/setup`, { token: owner.token, body: { locationId: loc.id, publish: true, season: { name: 'Winter', startsOn: isoDay(-5), endsOn: isoDay(90) }, venues: [{ name: 'Court 1', kind: 'court' }, { name: 'Court 2', kind: 'court' }], programmes: [{ name: 'Futsal', ageMin: 5, ageMax: 15, teams: [{ name: 'A' }, { name: 'B' }] }] } });
    const prog = st.body.programmes[0];
    const email = `secret-${uid()}@example.com`;
    const reg = await call(app, 'POST', `/v1/public/sports/programmes/${prog.id}/registrations`, { body: { guardian: { name: 'Private Parent', email }, participant: { name: 'Secret Child', dateOfBirth: '2016-06-06' }, answers: answers({ medical_notes: 'Type 1 diabetes' }), acceptRefundPolicy: true } });
    expect(reg.status).toBe(201);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/sports/ai/programme-description`, { token: owner.token, body: { programmeId: prog.id } })).body.draft).toBe('A friendly draft.');
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/sports/ai/enrolment-summary`, { token: owner.token, body: {} })).status).toBe(200);
    const start = new Date(Date.now() + 86400_000);
    const v = st.body.venues[0];
    for (const t of prog.teams) await call(app, 'POST', `/v1/orgs/${orgId}/sports/teams/${t.id}/sessions`, { token: owner.token, body: { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString(), venueId: v.id } });
    const sessions = (await call(app, 'GET', `/v1/orgs/${orgId}/sports/sessions?from=${new Date().toISOString()}`, { token: owner.token })).body.items;
    const ranked = await call(app, 'POST', `/v1/orgs/${orgId}/sports/ai/conflict-resolutions`, { token: owner.token, body: { sessionId: sessions[0].id } });
    expect(ranked.status).toBe(200);
    expect(ranked.body.status).toBe('proposals_only');
    expect(ranked.body.proposals).toHaveLength(1); // the invented index is dropped
    expect(ranked.body.proposals[0].status).toBe('proposed');
    const all = prompts.join('\n');
    for (const secret of ['Secret Child', 'Private Parent', email, 'diabetes', 'Robin Grey', '555 0199']) expect(all).not.toContain(secret);
    // AI never changed the schedule.
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/sports/sessions?from=${new Date().toISOString()}`, { token: owner.token })).body.items.filter((x: any) => x.venueConflict)).toHaveLength(2);
  });

  it('AI unavailable → 503 and nothing else is affected', async () => {
    const off = await makeApp();
    const owner = await verifiedUser(off, 'No AI');
    const orgId = (await createOrg(off, owner.token, { industry: 'sports' })).id;
    const loc = await createLocation(off, owner.token, orgId);
    const st = await call(off, 'POST', `/v1/orgs/${orgId}/sports/setup`, { token: owner.token, body: { locationId: loc.id, season: { name: 'S', startsOn: isoDay(0), endsOn: isoDay(30) }, programmes: [{ name: 'P' }] } });
    const r = await call(off, 'POST', `/v1/orgs/${orgId}/sports/ai/programme-description`, { token: owner.token, body: { programmeId: st.body.programmes[0].id } });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('ai_unavailable');
    await off.close();
  });
});

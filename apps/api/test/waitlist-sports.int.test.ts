import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { customers, registrations, waitlistEntries } from '../src/db/schema/index.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, inMinutes, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('leaving a class waitlist: guest (manage token) and signed-in customer (DB)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let loc: any;
  let occId: string;

  beforeAll(async () => {
    app = await makeApp();
    ({ token } = await verifiedUser(app));
    orgId = (await createOrg(app, token)).id;
    loc = await createLocation(app, token, orgId);
    await enablePublicAndPayments(app, token, orgId, loc.id);
    const ct = (await call(app, 'POST', `/v1/orgs/${orgId}/studios/class-types`, { token, body: { locationId: loc.id, name: 'Yin', durationMinutes: 60, defaultCapacity: 1 } })).body.id;
    occId = (await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences`, { token, body: { locationId: loc.id, classTypeId: ct, startsAt: inMinutes(2 * 24 * 60), capacity: 1 } })).body.items[0].id;
    expect((await call(app, 'POST', `/v1/public/studios/occurrences/${occId}/bookings`, { body: { contact: { name: 'First In', email: `first-${uid()}@example.com` } } })).body.outcome).toBe('confirmed');
  });
  afterAll(async () => { await app?.close(); });

  it('a guest leaves with the token from their confirmation; a wrong token reveals nothing; leaving twice is refused', async () => {
    const w = await call(app, 'POST', `/v1/public/studios/occurrences/${occId}/bookings`, { body: { contact: { name: 'Guest Waiter', email: `g-${uid()}@example.com` }, joinWaitlist: true } });
    expect(w.body).toMatchObject({ outcome: 'waitlisted', position: 1, manageToken: expect.any(String) });
    expect((await call(app, 'POST', `/v1/public/studios/waitlist/${w.body.waitlistEntryId}/leave`, { body: { manageToken: 'not-the-right-token' } })).status).toBe(404);
    const ok = await call(app, 'POST', `/v1/public/studios/waitlist/${w.body.waitlistEntryId}/leave`, { body: { manageToken: w.body.manageToken } });
    expect(ok.body).toEqual({ id: w.body.waitlistEntryId, status: 'left' });
    const again = await call(app, 'POST', `/v1/public/studios/waitlist/${w.body.waitlistEntryId}/leave`, { body: { manageToken: w.body.manageToken } });
    expect(again.body.error.code).toBe('waitlist_not_active');
    const [row] = await app.ctx.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, w.body.waitlistEntryId));
    expect(row!.status).toBe('left');
    expect(row!.leftAt).toBeTruthy();
  });

  it('a signed-in customer leaves via /me; other people cannot; positions move up', async () => {
    const cust = await verifiedUser(app, 'Casey Customer');
    const other = await verifiedUser(app, 'Other Person');
    const mine = await call(app, 'POST', `/v1/public/studios/occurrences/${occId}/bookings`, { body: { contact: { name: 'Casey Customer', email: cust.email }, joinWaitlist: true } });
    const next = await call(app, 'POST', `/v1/public/studios/occurrences/${occId}/bookings`, { body: { contact: { name: 'Next Person', email: `n-${uid()}@example.com` }, joinWaitlist: true } });
    expect(next.body.position).toBe(2);
    const list = await call(app, 'GET', '/v1/me/bookings', { token: cust.token });
    expect(list.body.items.find((i: any) => i.kind === 'waitlist')).toMatchObject({ id: mine.body.waitlistEntryId, waitlistPosition: 1 });
    expect((await call(app, 'POST', `/v1/me/waitlist/${mine.body.waitlistEntryId}/leave`, { token: other.token })).status).toBe(404);
    expect((await call(app, 'POST', `/v1/me/waitlist/${mine.body.waitlistEntryId}/leave`, { token: cust.token })).body.status).toBe('left');
    expect((await call(app, 'GET', '/v1/me/bookings', { token: cust.token })).body.items.filter((i: any) => i.kind === 'waitlist')).toEqual([]);
    // Freeing the confirmed seat now promotes the remaining waiter, not the one who left.
    const occ = await call(app, 'GET', `/v1/orgs/${orgId}/studios/occurrences/${occId}`, { token });
    await call(app, 'POST', `/v1/orgs/${orgId}/studios/bookings/${occ.body.attendees[0].bookingId}/cancel`, { token });
    const [promoted] = await app.ctx.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, next.body.waitlistEntryId));
    expect(promoted!.status).toBe('promoted');
  });
});

describe.skipIf(!hasDb)('sports schedule: sessions with attendance summary, venue conflicts and coach scoping (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string };
  let coach: { token: string; userId: string };
  let orgId: string;
  let loc: any;
  let u12: any;
  let u14: any;

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Director');
    orgId = (await createOrg(app, owner.token, { industry: 'sports' })).id;
    loc = await createLocation(app, owner.token, orgId, { name: 'North Shore Toronto' });
    coach = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: loc.id }, 'Coach Kim');
    const prog = (await call(app, 'POST', `/v1/orgs/${orgId}/sports/programmes`, { token: owner.token, body: { locationId: loc.id, name: 'Youth development', feeMinor: 0, requiresApproval: false, status: 'published' } })).body;
    u12 = (await call(app, 'POST', `/v1/orgs/${orgId}/sports/teams`, { token: owner.token, body: { programmeId: prog.id, name: 'U12 Blue', coachUserId: coach.userId } })).body;
    u14 = (await call(app, 'POST', `/v1/orgs/${orgId}/sports/teams`, { token: owner.token, body: { programmeId: prog.id, name: 'U14 Red' } })).body;
    // Two accepted players on U12.
    for (const n of ['Leo Park', 'Ava Singh']) {
      const [c] = await app.ctx.db.insert(customers).values({ organizationId: orgId, locationId: loc.id, name: n }).returning();
      await app.ctx.db.insert(registrations).values({ organizationId: orgId, locationId: loc.id, programmeId: prog.id, participantCustomerId: c!.id, status: 'accepted', teamId: u12.id });
    }
  });
  afterAll(async () => { await app?.close(); });

  it('lists training and fixtures with a venue conflict flag and attendance counts; coaches only see their teams', async () => {
    const mk = (team: any, start: number, venue: string, kind = 'training') => call(app, 'POST', `/v1/orgs/${orgId}/sports/teams/${team.id}/sessions`, { token: owner.token, body: { startsAt: inMinutes(start), endsAt: inMinutes(start + 90), venue, kind } });
    const a = (await mk(u12, 24 * 60, 'Pitch 1')).body.session;
    const clash = await mk(u14, 24 * 60 + 30, 'Pitch 1');
    expect(clash.body.venueConflicts).toHaveLength(1);
    await mk(u12, 3 * 24 * 60, 'Lamport Stadium', 'fixture');

    const roster = await call(app, 'GET', `/v1/orgs/${orgId}/sports/sessions/${a.id}/roster`, { token: coach.token });
    expect(roster.body.roster).toHaveLength(2);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/sports/sessions/${a.id}/attendance`, { token: coach.token, body: { marks: [{ participantId: roster.body.roster[0].id, status: 'present' }, { participantId: roster.body.roster[1].id, status: 'absent' }] } })).body.recorded).toBe(2);

    const all = await call(app, 'GET', `/v1/orgs/${orgId}/sports/sessions`, { token: owner.token });
    expect(all.body.items).toHaveLength(3);
    const first = all.body.items.find((x: any) => x.id === a.id);
    expect(first).toMatchObject({ kind: 'training', venueConflict: true, rosterCount: 2, attendance: { recorded: 2, present: 1, absent: 1 }, team: { name: 'U12 Blue', coach: { name: 'Coach Kim' } }, location: { timeZone: 'America/Toronto' } });
    expect(first.conflicts[0].teamName).toBe('U14 Red');
    expect(all.body.items.find((x: any) => x.kind === 'fixture').venueConflict).toBe(false);

    const mine = await call(app, 'GET', `/v1/orgs/${orgId}/sports/sessions`, { token: coach.token });
    expect(new Set(mine.body.items.map((x: any) => x.team.name))).toEqual(new Set(['U12 Blue']));
    // A coach cannot take attendance for a team they don't coach.
    const other = all.body.items.find((x: any) => x.team.name === 'U14 Red');
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/sports/sessions/${other.id}/roster`, { token: coach.token })).status).toBe(403);
  });
});

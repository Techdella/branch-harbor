import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { auditEvents } from '../src/db/schema/index.ts';
import { call, createLocation, createOrg, hasDb, inMinutes, makeApp, memberWithRole, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('staff shifts, swap requests with manager approval, and the time clock (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string };
  let manager: { token: string; userId: string };
  let sam: { token: string; userId: string };
  let jordan: { token: string; userId: string };
  let orgId: string;
  let loc: any;
  let other: any;

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Owner');
    orgId = (await createOrg(app, owner.token)).id;
    loc = await createLocation(app, owner.token, orgId, { name: 'Queen West' });
    other = await createLocation(app, owner.token, orgId, { name: 'Seattle', currency: 'USD', timeZone: 'America/Los_Angeles', address: { line1: '1 Pike', city: 'Seattle', region: 'WA', country: 'US' } });
    manager = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: loc.id }, 'Maya Manager');
    sam = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: loc.id }, 'Sam Tran');
    jordan = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: loc.id }, 'Jordan Lee');
  });
  afterAll(async () => { await app?.close(); });

  const schedule = (token: string, body: any) => call(app, 'POST', `/v1/orgs/${orgId}/shifts`, { token, body: { locationId: loc.id, role: 'Front desk', ...body } });

  it('lets managers schedule shifts (UTC + location time zone) and rejects staff, strangers and overlaps', async () => {
    const r = await schedule(manager.token, { userId: sam.userId, startsAt: inMinutes(24 * 60), endsAt: inMinutes(24 * 60 + 480), repeatWeeks: 2 });
    expect(r.status).toBe(201);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0]).toMatchObject({ user: { id: sam.userId, name: 'Sam Tran' }, location: { timeZone: 'America/Toronto' }, status: 'scheduled', clockedInAt: null });

    expect((await schedule(sam.token, { userId: jordan.userId, startsAt: inMinutes(3000), endsAt: inMinutes(3100) })).status).toBe(403);
    const overlap = await schedule(manager.token, { userId: sam.userId, startsAt: inMinutes(24 * 60 + 60), endsAt: inMinutes(24 * 60 + 120) });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('shift_overlap');
    // Someone who doesn't work at the location cannot be scheduled there.
    const outsider = await verifiedUser(app, 'Outsider');
    expect((await schedule(manager.token, { userId: outsider.userId, startsAt: inMinutes(5000), endsAt: inMinutes(5100) })).body.error.fields.userId).toBeTruthy();
    // The manager has no rights at the other location.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/shifts`, { token: manager.token, body: { locationId: other.id, userId: sam.userId, role: 'x', startsAt: inMinutes(6000), endsAt: inMinutes(6100) } })).status).toBe(403);

    // Staff see the team schedule for their location.
    const list = await call(app, 'GET', `/v1/orgs/${orgId}/shifts?locationId=${loc.id}&from=${encodeURIComponent(inMinutes(0))}&to=${encodeURIComponent(inMinutes(20 * 24 * 60))}`, { token: jordan.token });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(2);
  });

  it('routes a swap through /approvals: staff cannot approve, the manager approval reassigns both shifts, and it is audited', async () => {
    const mine = (await schedule(manager.token, { userId: sam.userId, startsAt: inMinutes(4 * 24 * 60), endsAt: inMinutes(4 * 24 * 60 + 240) })).body.items[0];
    const theirs = (await schedule(manager.token, { userId: jordan.userId, startsAt: inMinutes(5 * 24 * 60), endsAt: inMinutes(5 * 24 * 60 + 240) })).body.items[0];

    // Only the shift holder can ask.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/shifts/${mine.id}/swap-requests`, { token: jordan.token, body: { toUserId: jordan.userId } })).status).toBe(403);
    const req = await call(app, 'POST', `/v1/orgs/${orgId}/shifts/${mine.id}/swap-requests`, { token: sam.token, body: { toUserId: jordan.userId, toShiftId: theirs.id, reason: 'Exam that morning' } });
    expect(req.status).toBe(201);
    expect(req.body.approval).toMatchObject({ kind: 'shift_swap', status: 'pending', canDecide: false, requester: { name: 'Sam Tran' } });
    const approvalId = req.body.approval.id;
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/shifts/${mine.id}/swap-requests`, { token: sam.token, body: { toUserId: jordan.userId } })).body.error.code).toBe('swap_pending');

    // Staff (even the colleague) cannot decide; nor can the requester.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/approvals/${approvalId}/decision`, { token: jordan.token, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/approvals/${approvalId}/decision`, { token: sam.token, body: { decision: 'approve' } })).status).toBe(403);
    // Nothing moved before approval.
    let shifts = (await call(app, 'GET', `/v1/orgs/${orgId}/shifts?locationId=${loc.id}&from=${encodeURIComponent(inMinutes(3 * 24 * 60))}&to=${encodeURIComponent(inMinutes(6 * 24 * 60))}`, { token: manager.token })).body.items;
    expect(shifts.find((x: any) => x.id === mine.id).user.id).toBe(sam.userId);
    expect(shifts.find((x: any) => x.id === mine.id).pendingSwap.toUser.name).toBe('Jordan Lee');

    const inbox = await call(app, 'GET', `/v1/orgs/${orgId}/approvals?kind=shift_swap`, { token: manager.token });
    expect(inbox.body.items.find((a: any) => a.id === approvalId)).toMatchObject({ canDecide: true, payload: { from: { name: 'Sam Tran' }, to: { name: 'Jordan Lee' } } });

    const ok = await call(app, 'POST', `/v1/orgs/${orgId}/approvals/${approvalId}/decision`, { token: manager.token, body: { decision: 'approve', comment: 'Covered' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', executionResult: { nowAssignedTo: jordan.userId, swappedShiftId: theirs.id } });
    expect(ok.body.executedAt).toBeTruthy();
    shifts = (await call(app, 'GET', `/v1/orgs/${orgId}/shifts?locationId=${loc.id}&from=${encodeURIComponent(inMinutes(3 * 24 * 60))}&to=${encodeURIComponent(inMinutes(6 * 24 * 60))}`, { token: manager.token })).body.items;
    expect(shifts.find((x: any) => x.id === mine.id).user.id).toBe(jordan.userId);
    expect(shifts.find((x: any) => x.id === theirs.id).user.id).toBe(sam.userId);
    // Deciding twice is refused.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/approvals/${approvalId}/decision`, { token: manager.token, body: { decision: 'approve' } })).body.error.code).toBe('already_decided');

    const events = await app.ctx.db.select().from(auditEvents).where(eq(auditEvents.organizationId, orgId));
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['approval.requested', 'shift.swapped', 'approval.approved']));
  });

  it('a rejected swap changes nothing', async () => {
    const sh = (await schedule(manager.token, { userId: sam.userId, startsAt: inMinutes(9 * 24 * 60), endsAt: inMinutes(9 * 24 * 60 + 120) })).body.items[0];
    const req = await call(app, 'POST', `/v1/orgs/${orgId}/shifts/${sh.id}/swap-requests`, { token: sam.token, body: { toUserId: jordan.userId } });
    const rej = await call(app, 'POST', `/v1/orgs/${orgId}/approvals/${req.body.approval.id}/decision`, { token: owner.token, body: { decision: 'reject', comment: 'Short-staffed' } });
    expect(rej.body).toMatchObject({ status: 'rejected', decisionComment: 'Short-staffed', executedAt: null });
    const swaps = await call(app, 'GET', `/v1/orgs/${orgId}/shift-swaps?status=rejected`, { token: manager.token });
    expect(swaps.body.items.some((x: any) => x.shiftId === sh.id)).toBe(true);
    const list = await call(app, 'GET', `/v1/orgs/${orgId}/shifts?userId=${sam.userId}&from=${encodeURIComponent(inMinutes(8.5 * 24 * 60))}&to=${encodeURIComponent(inMinutes(9.5 * 24 * 60))}`, { token: manager.token });
    expect(list.body.items[0].user.id).toBe(sam.userId);
  });

  it('clocks in against today’s shift (not too early, not twice) and out again; /me/shifts shows the state', async () => {
    const today = (await schedule(manager.token, { userId: jordan.userId, startsAt: inMinutes(30), endsAt: inMinutes(300) })).body.items[0];
    const later = (await schedule(manager.token, { userId: jordan.userId, startsAt: inMinutes(600), endsAt: inMinutes(700) })).body.items[0];
    const clockIn = (body: any, token = jordan.token) => call(app, 'POST', `/v1/orgs/${orgId}/time-clock/clock-in`, { token, body: { locationId: loc.id, source: 'mobile', ...body } });

    expect((await clockIn({ shiftId: later.id })).body.error.code).toBe('outside_shift_window');
    expect((await clockIn({ shiftId: today.id }, sam.token)).status).toBe(403);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/time-clock/clock-out`, { token: jordan.token, body: {} })).body.error.code).toBe('not_clocked_in');

    const ci = await clockIn({ shiftId: today.id });
    expect(ci.status).toBe(201);
    expect(ci.body.shift.clockedInAt).toBeTruthy();
    expect((await clockIn({ shiftId: today.id })).body.error.code).toBe('already_clocked_in');

    const me = await call(app, 'GET', '/v1/me/shifts', { token: jordan.token });
    expect(me.body.openClock).toMatchObject({ shiftId: today.id, locationId: loc.id });
    expect(me.body.items.find((x: any) => x.id === today.id)).toMatchObject({ clockedInAt: expect.any(String), clockedOutAt: null, location: { name: 'Queen West' } });

    const co = await call(app, 'POST', `/v1/orgs/${orgId}/time-clock/clock-out`, { token: jordan.token, body: { source: 'mobile' } });
    expect(co.status).toBe(201);
    expect(co.body.shift.clockedOutAt).toBeTruthy();
    expect((await call(app, 'GET', '/v1/me/shifts', { token: jordan.token })).body.openClock).toBeNull();

    // Managers see the timesheet; staff only their own entries.
    const ts = await call(app, 'GET', `/v1/orgs/${orgId}/time-clock?locationId=${loc.id}`, { token: manager.token });
    expect(ts.body.items[0]).toMatchObject({ userName: 'Jordan Lee', shiftId: today.id, minutes: expect.any(Number) });
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/time-clock`, { token: sam.token })).body.items).toEqual([]);
  });

  it('cancelling a shift cancels its pending swap', async () => {
    const sh = (await schedule(manager.token, { userId: sam.userId, startsAt: inMinutes(10 * 24 * 60), endsAt: inMinutes(10 * 24 * 60 + 60) })).body.items[0];
    await call(app, 'POST', `/v1/orgs/${orgId}/shifts/${sh.id}/swap-requests`, { token: sam.token, body: { toUserId: jordan.userId } });
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/shifts/${sh.id}/cancel`, { token: sam.token, body: {} })).status).toBe(403);
    const c = await call(app, 'POST', `/v1/orgs/${orgId}/shifts/${sh.id}/cancel`, { token: manager.token, body: { reason: 'Closed for maintenance' } });
    expect(c.body.status).toBe('cancelled');
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/shift-swaps?status=cancelled`, { token: manager.token })).body.items.some((x: any) => x.shiftId === sh.id)).toBe(true);
  });
});

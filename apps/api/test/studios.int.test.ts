import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { classBookings } from '../src/db/schema/index.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, uid, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('studios booking with capacity, holds and waitlist (DB)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let loc: any;
  let classTypeId: string;
  const contact = () => ({ name: `Member ${uid()}`, email: `m-${uid()}@example.com` });
  const schedule = async (capacity: number, priceMinor = 0) => {
    const r = await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences`, { token, body: { locationId: loc.id, classTypeId, startsAt: new Date(Date.now() + 2 * 86400_000).toISOString(), capacity, priceMinor } });
    expect(r.status).toBe(201);
    return r.body.items[0];
  };
  const book = (occId: string, body: any) => call(app, 'POST', `/v1/public/studios/occurrences/${occId}/bookings`, { body });

  beforeAll(async () => {
    app = await makeApp();
    ({ token } = await verifiedUser(app));
    orgId = (await createOrg(app, token)).id;
    loc = await createLocation(app, token, orgId);
    await enablePublicAndPayments(app, token, orgId, loc.id);
    classTypeId = (await call(app, 'POST', `/v1/orgs/${orgId}/studios/class-types`, { token, body: { locationId: loc.id, name: 'Morning Vinyasa', durationMinutes: 60, defaultCapacity: 12 } })).body.id;
  });
  afterAll(async () => { await app?.close(); });

  it('confirms free bookings up to capacity, then offers the waitlist, and promotes on cancellation', async () => {
    const occ = await schedule(2);
    const a = await book(occ.id, { contact: contact() });
    const bContact = contact();
    const b = await book(occ.id, { contact: bContact });
    expect([a.body.outcome, b.body.outcome]).toEqual(['confirmed', 'confirmed']);

    const dup = await book(occ.id, { contact: bContact });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_booking');

    const full = await book(occ.id, { contact: contact() });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('class_full');
    expect(full.body.error.details.waitlistAvailable).toBe(true);

    const w = await book(occ.id, { contact: contact(), joinWaitlist: true });
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ outcome: 'waitlisted', position: 1 });

    const sched = await call(app, 'GET', `/v1/public/studios/${loc.id}/schedule`);
    expect(sched.body.items.find((i: any) => i.id === occ.id)).toMatchObject({ spotsLeft: 0, status: 'full', action: 'join_waitlist' });

    const cancel = await call(app, 'POST', `/v1/public/studios/bookings/${a.body.bookingId}/cancel`, { body: { manageToken: a.body.manageToken } });
    expect(cancel.status).toBe(200);
    expect(cancel.body.waitlistPromoted).toBe(true);
    const detail = await call(app, 'GET', `/v1/orgs/${orgId}/studios/occurrences/${occ.id}`, { token });
    expect(detail.body.attendees.filter((x: any) => x.status === 'confirmed')).toHaveLength(2);
    expect(detail.body.waitlist[0].status).toBe('promoted');
    expect(detail.body.spotsLeft).toBe(0);
  });

  it('never oversells under concurrent booking attempts', async () => {
    const occ = await schedule(3);
    const results = await Promise.all(Array.from({ length: 8 }, () => book(occ.id, { contact: contact() })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'class_full')).toHaveLength(5);
  });

  it('holds paid seats during checkout, confirms on payment, and recovers payment-after-expiry via reconciliation', async () => {
    const occ = await schedule(1, 2800);
    const held = await book(occ.id, { contact: contact() });
    expect(held.status).toBe(201);
    expect(held.body.outcome).toBe('held');
    expect(held.body.payment).toMatchObject({ amount: 2800, currency: 'CAD', sandbox: true });
    // Seat is held: the next customer sees the class as full.
    expect((await book(occ.id, { contact: contact() })).body.error.code).toBe('class_full');

    // Simulate the hold expiring and another customer taking the seat.
    await app.ctx.db.update(classBookings).set({ holdExpiresAt: new Date(Date.now() - 1000) }).where(eq(classBookings.id, held.body.bookingId));
    const other = await book(occ.id, { contact: contact() });
    expect(other.body.outcome).toBe('held');
    const paidOther = await call(app, 'POST', `/v1/public/payments/${other.body.payment.id}/sandbox-confirm`, { body: { outcome: 'succeeded' } });
    expect(paidOther.status).toBe(200);

    // Payment for the expired hold arrives late: payment succeeds but the class is full → recovery queue.
    const late = await call(app, 'POST', `/v1/public/payments/${held.body.payment.id}/sandbox-confirm`, { body: { outcome: 'succeeded' } });
    expect(late.body.payment.state).toBe('succeeded');
    expect(late.body.outcome.note).toMatch(/hold expired/);
    const queue = await call(app, 'GET', `/v1/orgs/${orgId}/payments/reconciliation`, { token });
    const item = queue.body.items.find((i: any) => i.paymentId === held.body.payment.id);
    expect(item).toMatchObject({ kind: 'paid_without_record', targetType: 'class_booking', recoverable: true });

    // Recover explicitly (authorised user accepts going over capacity).
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/payments/${held.body.payment.id}/recreate-record`, { token, body: { allowOverCapacity: false } })).status).toBe(409);
    const rec = await call(app, 'POST', `/v1/orgs/${orgId}/payments/${held.body.payment.id}/recreate-record`, { token, body: { allowOverCapacity: true } });
    expect(rec.status).toBe(200);
    const after = await call(app, 'GET', `/v1/orgs/${orgId}/payments/reconciliation`, { token });
    expect(after.body.items.find((i: any) => i.paymentId === held.body.payment.id)).toBeUndefined();
  });

  it('runs the instructor cover flow: request → accept → manager approval updates the class', async () => {
    const occ = await schedule(10);
    const sub = await verifiedUser(app, 'Sam Tran');
    const inv = await call(app, 'POST', `/v1/orgs/${orgId}/invitations`, { token, body: { email: sub.email, role: 'staff', scope: { kind: 'location', id: loc.id } } });
    await call(app, 'POST', '/v1/invitations/accept', { token: sub.token, body: { token: inv.body.devInvitationToken } });
    const cr = await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences/${occ.id}/cover-requests`, { token, body: { reason: 'Travelling' } });
    expect(cr.status).toBe(201);
    const acc = await call(app, 'POST', `/v1/orgs/${orgId}/studios/cover-requests/${cr.body.id}/accept`, { token: sub.token });
    expect(acc.body.status).toBe('accepted');
    // Staff cannot approve their own cover.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/studios/cover-requests/${cr.body.id}/decision`, { token: sub.token, body: { decision: 'approve' } })).status).toBe(403);
    const ok = await call(app, 'POST', `/v1/orgs/${orgId}/studios/cover-requests/${cr.body.id}/decision`, { token, body: { decision: 'approve' } });
    expect(ok.body.status).toBe('approved');
    expect(ok.body.history.map((h: any) => h.action)).toEqual(['requested', 'accepted', 'approved']);
    const detail = await call(app, 'GET', `/v1/orgs/${orgId}/studios/occurrences/${occ.id}`, { token });
    expect(detail.body.instructorName).toBe('Sam Tran');
  });
});

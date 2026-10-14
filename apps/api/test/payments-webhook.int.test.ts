import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { auditEvents, classBookings, paymentReferences, webhookEvents } from '../src/db/schema/index.ts';
import { signStripePayload } from '../src/integrations/payments.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, uid, verifiedUser, WEBHOOK_SECRET } from './helpers.ts';

describe.skipIf(!hasDb)('Stripe webhook idempotency, refunds and reconciliation (DB)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let loc: any;
  let occId: string;

  const event = (id: string, pi: { id: string; amount: number; currency: string }, type = 'payment_intent.succeeded') => JSON.stringify({
    id, object: 'event', type, api_version: '2026-09-30', created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null },
    data: { object: { id: pi.id, object: 'payment_intent', amount: pi.amount, amount_received: pi.amount, currency: pi.currency, status: type === 'payment_intent.succeeded' ? 'succeeded' : 'requires_payment_method', metadata: {} } },
  });
  const post = (payload: string, sig = signStripePayload(payload, WEBHOOK_SECRET)) =>
    app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload, headers: { 'content-type': 'application/json', 'stripe-signature': sig } });

  beforeAll(async () => {
    app = await makeApp();
    ({ token } = await verifiedUser(app));
    orgId = (await createOrg(app, token)).id;
    loc = await createLocation(app, token, orgId);
    await enablePublicAndPayments(app, token, orgId, loc.id);
    const ct = await call(app, 'POST', `/v1/orgs/${orgId}/studios/class-types`, { token, body: { locationId: loc.id, name: 'Slow Flow', durationMinutes: 75, defaultCapacity: 10 } });
    occId = (await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences`, { token, body: { locationId: loc.id, classTypeId: ct.body.id, startsAt: new Date(Date.now() + 86400_000).toISOString(), priceMinor: 2800 } })).body.items[0].id;
  });
  afterAll(async () => { await app?.close(); });

  it('rejects unsigned or tampered events', async () => {
    const payload = event(`evt_${uid()}`, { id: 'pi_x', amount: 1, currency: 'cad' });
    expect((await post(payload, 'bad-signature')).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload, headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
  });

  it('processes a duplicate delivery exactly once', async () => {
    const b = await call(app, 'POST', `/v1/public/studios/occurrences/${occId}/bookings`, { body: { contact: { name: 'Lee', email: `lee-${uid()}@example.com` } } });
    expect(b.body.outcome).toBe('held');
    const [pay] = await app.ctx.db.select().from(paymentReferences).where(eq(paymentReferences.id, b.body.payment.id));
    const evtId = `evt_${uid()}`;
    const payload = event(evtId, { id: pay!.externalId, amount: 2800, currency: 'cad' });

    const first = await post(payload);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ received: true, duplicate: false, status: 'processed' });
    const second = await post(payload);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ received: true, duplicate: true });

    // Concurrent duplicates are also safe.
    const concurrent = await Promise.all([post(payload), post(payload), post(payload)]);
    expect(concurrent.every((r) => r.json().duplicate === true)).toBe(true);

    expect(await app.ctx.db.select().from(webhookEvents).where(eq(webhookEvents.eventId, evtId))).toHaveLength(1);
    const audits = await app.ctx.db.select().from(auditEvents).where(eq(auditEvents.targetId, pay!.id));
    expect(audits.filter((a) => a.action === 'payment.payment_intent.succeeded')).toHaveLength(1);
    const [booking] = await app.ctx.db.select().from(classBookings).where(eq(classBookings.id, b.body.bookingId));
    expect(booking!.status).toBe('confirmed');
    const [after] = await app.ctx.db.select().from(paymentReferences).where(eq(paymentReferences.id, pay!.id));
    expect(after!.state).toBe('succeeded');
  });

  it('flags amount mismatches and supports partial refunds within the remaining amount', async () => {
    const b = await call(app, 'POST', `/v1/public/studios/occurrences/${occId}/bookings`, { body: { contact: { name: 'Kai', email: `kai-${uid()}@example.com` } } });
    const [pay] = await app.ctx.db.select().from(paymentReferences).where(eq(paymentReferences.id, b.body.payment.id));
    await post(event(`evt_${uid()}`, { id: pay!.externalId, amount: 2500, currency: 'cad' }));
    const q = await call(app, 'GET', `/v1/orgs/${orgId}/payments/reconciliation`, { token });
    expect(q.body.items.find((i: any) => i.paymentId === pay!.id && i.kind === 'amount_mismatch')).toMatchObject({ expected: { amount: 2800, currency: 'CAD' }, actual: { amount: 2500, currency: 'CAD' } });

    const wrongCurrency = await call(app, 'POST', `/v1/orgs/${orgId}/payments/${pay!.id}/refunds`, { token, body: { amountMinor: 500, confirmCurrency: 'USD' } });
    expect(wrongCurrency.status).toBe(400);
    const r1 = await call(app, 'POST', `/v1/orgs/${orgId}/payments/${pay!.id}/refunds`, { token, body: { amountMinor: 1000, confirmCurrency: 'CAD', reason: 'Goodwill' } });
    expect(r1.status).toBe(201);
    expect(r1.body.payment).toMatchObject({ refundState: 'partial', refunded: { amount: 1000, currency: 'CAD' } });
    const tooMuch = await call(app, 'POST', `/v1/orgs/${orgId}/payments/${pay!.id}/refunds`, { token, body: { amountMinor: 1801, confirmCurrency: 'CAD' } });
    expect(tooMuch.body.error.code).toBe('refund_exceeds_remaining');
    const r2 = await call(app, 'POST', `/v1/orgs/${orgId}/payments/${pay!.id}/refunds`, { token, body: { amountMinor: 1800, confirmCurrency: 'CAD' } });
    expect(r2.body.payment.refundState).toBe('complete');

    // Staff cannot refund.
    const staff = await verifiedUser(app);
    const inv = await call(app, 'POST', `/v1/orgs/${orgId}/invitations`, { token, body: { email: staff.email, role: 'staff', scope: { kind: 'location', id: loc.id } } });
    await call(app, 'POST', '/v1/invitations/accept', { token: staff.token, body: { token: inv.body.devInvitationToken } });
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/payments/${pay!.id}/refunds`, { token: staff.token, body: { amountMinor: 1, confirmCurrency: 'CAD' } })).status).toBe(403);
  });

  it('records payments for intents it did not create as paid-without-record', async () => {
    const payload = JSON.stringify({
      id: `evt_${uid()}`, object: 'event', type: 'payment_intent.succeeded', created: 1, livemode: false, pending_webhooks: 0, request: { id: null, idempotency_key: null }, api_version: null,
      data: { object: { id: `pi_ext_${uid()}`, object: 'payment_intent', amount: 1500, amount_received: 1500, currency: 'cad', status: 'succeeded', metadata: { bh_org: orgId, bh_location: loc.id, bh_target_type: 'food_order', bh_target_id: crypto.randomUUID() } } },
    });
    expect((await post(payload)).json().status).toBe('processed');
    const q = await call(app, 'GET', `/v1/orgs/${orgId}/payments/reconciliation`, { token });
    expect(q.body.counts.paid_without_record).toBeGreaterThanOrEqual(1);
  });
});

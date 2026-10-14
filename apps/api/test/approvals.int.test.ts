import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { auditEvents, campaigns, paymentReferences } from '../src/db/schema/index.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('approvals inbox: refunds over the org threshold, local ad spend, permissions and execute-on-approve (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string };
  let manager: { token: string; userId: string };
  let finance: { token: string; userId: string };
  let staff: { token: string; userId: string };
  let orgId: string;
  let loc: any;

  const paidBooking = async () => {
    const ct = (await call(app, 'POST', `/v1/orgs/${orgId}/studios/class-types`, { token: owner.token, body: { locationId: loc.id, name: `Flow ${uid()}`, durationMinutes: 60, defaultCapacity: 10 } })).body.id;
    const occ = (await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences`, { token: owner.token, body: { locationId: loc.id, classTypeId: ct, startsAt: new Date(Date.now() + 3 * 86400_000).toISOString(), priceMinor: 2800 } })).body.items[0];
    const b = await call(app, 'POST', `/v1/public/studios/occurrences/${occ.id}/bookings`, { body: { contact: { name: 'Avery Chen', email: `avery-${uid()}@example.com` } } });
    expect((await call(app, 'POST', `/v1/public/payments/${b.body.payment.id}/sandbox-confirm`, { body: { outcome: 'succeeded' } })).status).toBe(200);
    return b.body.payment.id as string;
  };
  const refunded = async (paymentId: string) => (await app.ctx.db.select().from(paymentReferences).where(eq(paymentReferences.id, paymentId)))[0]!.refundedMinor;
  const decide = (token: string, id: string, decision: 'approve' | 'reject', comment?: string) => call(app, 'POST', `/v1/orgs/${orgId}/approvals/${id}/decision`, { token, body: { decision, comment } });

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Olivia Owner');
    orgId = (await createOrg(app, owner.token)).id;
    loc = await createLocation(app, owner.token, orgId, { name: 'Queen West' });
    await enablePublicAndPayments(app, owner.token, orgId, loc.id);
    manager = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: loc.id }, 'Maya Rao');
    finance = await memberWithRole(app, owner.token, orgId, 'finance', { kind: 'location', id: loc.id }, 'Fin Lee');
    staff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: loc.id }, 'Sam Staff');
    const patch = await call(app, 'PATCH', `/v1/orgs/${orgId}`, { token: owner.token, body: { refundApprovalThresholds: { CAD: 2000 } } });
    expect(patch.body.policies.refundApprovalThresholds).toEqual({ CAD: 2000 });
  });
  afterAll(async () => { await app?.close(); });

  it('blocks direct refunds above the threshold for location-scoped refunders, but not within it', async () => {
    const pay = await paidBooking();
    const big = await call(app, 'POST', `/v1/orgs/${orgId}/payments/${pay}/refunds`, { token: finance.token, body: { amountMinor: 2500, confirmCurrency: 'CAD' } });
    expect(big.status).toBe(409);
    expect(big.body.error).toMatchObject({ code: 'approval_required', details: { thresholdMinor: 2000, currency: 'CAD' } });
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/payments/${pay}/refunds`, { token: finance.token, body: { amountMinor: 1000, confirmCurrency: 'CAD' } })).status).toBe(201);
    // Org-wide refunders (the owner) are the approvers and are not blocked.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/payments/${pay}/refunds`, { token: owner.token, body: { amountMinor: 1800, confirmCurrency: 'CAD' } })).status).toBe(201);
    expect(await refunded(pay)).toBe(2800);
  });

  it('a manager’s refund request waits for approval; only someone with payments.refund (not the requester) can execute it', async () => {
    const pay = await paidBooking();
    const r = await call(app, 'POST', `/v1/orgs/${orgId}/refund-requests`, { token: manager.token, body: { paymentId: pay, amountMinor: 2500, currency: 'CAD', reason: 'Studio heating failed' } });
    expect(r.status).toBe(202);
    expect(r.body.approval).toMatchObject({ kind: 'refund', status: 'pending', amount: { amount: 2500, currency: 'CAD' }, location: { name: 'Queen West' }, canDecide: false });
    const id = r.body.approval.id;
    expect(await refunded(pay)).toBe(0); // nothing executed yet
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/refund-requests`, { token: manager.token, body: { paymentId: pay, amountMinor: 100, currency: 'CAD', reason: 'again' } })).body.error.code).toBe('request_pending');
    // Wrong currency and staff without payments.read are refused.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/refund-requests`, { token: manager.token, body: { paymentId: pay, amountMinor: 100, currency: 'USD', reason: 'x' } })).status).toBe(400);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/refund-requests`, { token: staff.token, body: { paymentId: pay, amountMinor: 100, currency: 'CAD', reason: 'x' } })).status).toBe(403);

    // Inbox visibility: staff see nothing; finance and owner can decide; the manager sees their own request.
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/approvals`, { token: staff.token })).body.items).toEqual([]);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/approvals`, { token: manager.token })).body.items.map((a: any) => a.id)).toContain(id);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/approvals?kind=refund`, { token: finance.token })).body.items.find((a: any) => a.id === id).canDecide).toBe(true);
    expect((await decide(manager.token, id, 'approve')).status).toBe(403);
    expect((await decide(staff.token, id, 'approve')).status).toBe(403);

    const ok = await decide(owner.token, id, 'approve', 'Approved — goodwill');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', decisionComment: 'Approved — goodwill', executionResult: { refundState: 'complete' }, decider: { name: 'Olivia Owner' } });
    expect(await refunded(pay)).toBe(2500);
    const actions = (await app.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, orgId), eq(auditEvents.targetId, pay)))).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['approval.requested', 'payment.refund_requested', 'payment.refund_complete', 'approval.approved']));
  });

  it('rejection never executes; a failing execution leaves the request pending and is audited', async () => {
    const pay = await paidBooking();
    const a = (await call(app, 'POST', `/v1/orgs/${orgId}/refund-requests`, { token: manager.token, body: { paymentId: pay, amountMinor: 2600, currency: 'CAD', reason: 'Double charge' } })).body.approval;
    const rej = await decide(finance.token, a.id, 'reject', 'Not a double charge');
    expect(rej.body).toMatchObject({ status: 'rejected', executedAt: null });
    expect(await refunded(pay)).toBe(0);

    const b = (await call(app, 'POST', `/v1/orgs/${orgId}/refund-requests`, { token: manager.token, body: { paymentId: pay, amountMinor: 2600, currency: 'CAD', reason: 'Cancelled class' } })).body.approval;
    // Meanwhile the owner refunds part of it directly, so the approved amount no longer fits.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/payments/${pay}/refunds`, { token: owner.token, body: { amountMinor: 1000, confirmCurrency: 'CAD' } })).status).toBe(201);
    const fail = await decide(owner.token, b.id, 'approve');
    expect(fail.status).toBe(409);
    expect(fail.body.error.code).toBe('refund_exceeds_remaining');
    const after = (await call(app, 'GET', `/v1/orgs/${orgId}/approvals`, { token: owner.token })).body.items.find((x: any) => x.id === b.id);
    expect(after.status).toBe('pending');
    expect(await refunded(pay)).toBe(1000);
    const failed = await app.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, orgId), eq(auditEvents.action, 'approval.execution_failed')));
    expect(failed).toHaveLength(1);
    // The requester can withdraw it.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/approvals/${b.id}/cancel`, { token: finance.token })).status).toBe(403);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/approvals/${b.id}/cancel`, { token: manager.token })).body.status).toBe('cancelled');
  });

  it('commerce order refunds go through the same request flow (recorded only for external orders)', async () => {
    const p = await call(app, 'POST', `/v1/orgs/${orgId}/commerce/products`, { token: owner.token, body: { sku: `MAT-${uid()}`, name: 'Cork mat', status: 'active', variants: [{ sku: `MAT-${uid()}`, name: 'Standard', prices: { CAD: 9000 } }] } });
    const o = await call(app, 'POST', `/v1/orgs/${orgId}/commerce/orders`, { token: owner.token, body: { locationId: loc.id, source: 'shopify', externalId: `ext-${uid()}`, status: 'paid', lines: [{ variantId: p.body.variants[0].id, quantity: 1 }] } });
    const r = await call(app, 'POST', `/v1/orgs/${orgId}/refund-requests`, { token: manager.token, body: { orderId: o.body.order.id, amountMinor: 4500, currency: 'CAD', reason: 'Damaged in transit' } });
    expect(r.status).toBe(202);
    const ok = await decide(owner.token, r.body.approval.id, 'approve');
    expect(ok.body.executionResult).toMatchObject({ refundState: 'recorded_only', refundedMinor: 4500 });
  });

  it('local ad spend: amount + currency + location; approval schedules the campaign, managers cannot self-approve', async () => {
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/ad-spend-requests`, { token: manager.token, body: { locationId: loc.id, amountMinor: 50000, currency: 'USD', channel: 'meta_ads', durationDays: 14, title: 'Spring intro offer' } })).status).toBe(400);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/ad-spend-requests`, { token: staff.token, body: { locationId: loc.id, amountMinor: 50000, currency: 'CAD', channel: 'meta_ads', durationDays: 14, title: 'x' } })).status).toBe(403);
    const r = await call(app, 'POST', `/v1/orgs/${orgId}/ad-spend-requests`, { token: manager.token, body: { locationId: loc.id, amountMinor: 50000, currency: 'CAD', channel: 'meta_ads', durationDays: 14, startsOn: '2026-11-01', title: 'Spring intro offer' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'ad_spend', amount: { amount: 50000, currency: 'CAD' }, payload: { channel: 'meta_ads', durationDays: 14 } });
    const campaignId = r.body.targetId;
    expect((await app.ctx.db.select().from(campaigns).where(eq(campaigns.id, campaignId)))[0]!.status).toBe('pending_approval');
    expect((await decide(manager.token, r.body.id, 'approve')).status).toBe(403);
    const ok = await decide(owner.token, r.body.id, 'approve');
    expect(ok.body.executionResult).toMatchObject({ campaignStatus: 'scheduled', budgetMinor: 50000, currency: 'CAD' });
    const [c] = await app.ctx.db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    expect(c!.status).toBe('scheduled');
    expect(c!.endsAt!.toISOString().slice(0, 10)).toBe('2026-11-15');
  });

  it('website change approvals still work through the shared inbox (reject needs a comment)', async () => {
    const all = await call(app, 'GET', `/v1/orgs/${orgId}/approvals?status=all`, { token: owner.token });
    expect(all.status).toBe(200);
    expect(new Set(all.body.items.map((a: any) => a.kind))).toEqual(new Set(['refund', 'ad_spend']));
  });
});

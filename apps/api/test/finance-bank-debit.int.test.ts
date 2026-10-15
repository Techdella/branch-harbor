import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { financeCollectionAttempts, financePaymentMethods, locations, paymentReferences } from '../src/db/schema/index.ts';
import { processStripeEvent } from '../src/services/payments.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

/**
 * Royalty collection by bank debit (sandbox Stripe): the franchisee chooses card or the local bank debit, sees and
 * accepts the exact mandate text (stored verbatim), the debit stays processing until the delayed outcome, failures
 * reopen the invoice for the existing dunning (with one failure notice per attempt), the flat collection fee is
 * recorded per attempt, mandates Stripe reports inactive are revoked, and monthly franchisee statements are issued
 * (in-app, PDF, emailed) with per-franchisee isolation.
 */
describe.skipIf(!hasDb)('finance: bank-debit collection and monthly statements (DB)', () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof verifiedUser>>;
  let finance: Awaited<ReturnType<typeof verifiedUser>>;
  let foEu: Awaited<ReturnType<typeof verifiedUser>>;
  let foCa: Awaited<ReturnType<typeof verifiedUser>>;
  let orgId: string;
  let gEu: string;
  let gCa: string;
  let dub: string;
  let tor: string;
  let periodId: string;
  const SEP = '2026-09-01';
  const base = () => `/v1/orgs/${orgId}/finance`;
  const pay = async (locationId: string, currency: string, amountMinor: number, at: string) => {
    await app.ctx.db.insert(paymentReferences).values({ organizationId: orgId, locationId, provider: 'stripe', externalId: `pi_test_${uid()}${uid()}`, connectedAccountId: 'acct_sandbox_t', amountMinor, currency, applicationFeeMinor: 0, state: 'succeeded', succeededAt: new Date(at), targetType: 'class_booking', targetId: randomUUID(), sandbox: 1 });
  };
  const statementOf = async (locationId: string) => (await call(app, 'GET', `${base()}/statements`, { token: finance.token })).body.items.find((x: any) => x.location.id === locationId);

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Franchisor');
    orgId = (await createOrg(app, owner.token, { name: `Harbour Yoga ${uid()}` })).id;
    gEu = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'Liffey Studios', legalName: 'Liffey Studios Ltd' } })).body.id;
    gCa = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'Lakeshore' } })).body.id;
    dub = (await createLocation(app, owner.token, orgId, { name: 'Dublin Docklands', ownerGroupId: gEu, timeZone: 'Europe/Dublin', currency: 'EUR', address: { line1: '1 Quay', city: 'Dublin', country: 'IE' } })).id;
    tor = (await createLocation(app, owner.token, orgId, { name: 'Toronto Lakeshore', ownerGroupId: gCa })).id;
    await app.ctx.db.update(locations).set({ paymentsEnabled: true, stripeAccountId: 'acct_sandbox_t' }).where(eq(locations.organizationId, orgId));
    finance = await memberWithRole(app, owner.token, orgId, 'finance_lead', { kind: 'organization', id: orgId }, 'Finance Lead');
    foEu = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: gEu }, 'Owner Liffey');
    foCa = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: gCa }, 'Owner Lakeshore');
    const basis = { streams: ['bookings', 'memberships', 'retail', 'food', 'other'], netOfRefunds: true, excludeTax: true, excludeTips: true, includeExternalSales: true };
    for (const currency of ['EUR', 'CAD']) expect((await call(app, 'POST', `${base()}/terms`, { token: finance.token, body: { currency, effectiveFrom: '2026-01-01', royaltyBps: 600, marketingFundBps: 200, basis } })).status).toBe(201);
    await pay(dub, 'EUR', 500_000, '2026-09-10T10:00:00Z');
    await pay(tor, 'CAD', 300_000, '2026-09-11T15:00:00Z');
    const closed = await call(app, 'POST', `${base()}/periods/close`, { token: finance.token, body: { startDate: SEP } });
    expect(closed.status).toBe(200);
    periodId = closed.body.period.id;
  });
  afterAll(async () => { await app?.close(); });

  it('lets the franchisee choose card or the local bank debit and stores the exact mandate shown', async () => {
    const methods = await call(app, 'GET', `${base()}/payment-methods`, { token: foEu.token });
    expect(methods.body.ownerGroups).toEqual([{ id: gEu, name: 'Liffey Studios', currencies: [{ currency: 'EUR', methodTypes: ['card', 'sepa_debit'] }] }]);
    const preview = await call(app, 'GET', `${base()}/payment-methods/mandate?ownerGroupId=${gEu}&currency=EUR&methodType=sepa_debit`, { token: foEu.token });
    expect(preview.status).toBe(200);
    expect(preview.body.mandateText).toContain('SEPA Direct Debit mandate');
    expect(preview.body.mandateText).toContain('Liffey Studios Ltd');
    expect(preview.body.mandateText).toContain('within 8 weeks');
    expect((await call(app, 'GET', `${base()}/payment-methods/mandate?ownerGroupId=${gEu}&currency=EUR&methodType=bacs_debit`, { token: foEu.token })).status).toBe(400);
    expect((await call(app, 'GET', `${base()}/payment-methods/mandate?ownerGroupId=${gEu}&currency=EUR&methodType=sepa_debit`, { token: foCa.token })).status).toBe(403);
    const pad = await call(app, 'GET', `${base()}/payment-methods/mandate?ownerGroupId=${gCa}&currency=CAD&methodType=acss_debit`, { token: foCa.token });
    expect(pad.body.mandateText).toContain('Pre-Authorized Debit (PAD) Agreement');

    const stale = await call(app, 'POST', `${base()}/payment-methods/setup`, { token: foEu.token, body: { ownerGroupId: gEu, currency: 'EUR', methodType: 'sepa_debit', acceptMandate: true, mandateText: 'an older text' } });
    expect(stale.body.error.code).toBe('mandate_text_changed');
    const setup = await call(app, 'POST', `${base()}/payment-methods/setup`, { token: foEu.token, body: { ownerGroupId: gEu, currency: 'EUR', methodType: 'sepa_debit', acceptMandate: true, mandateText: preview.body.mandateText, locale: 'en-GB' } });
    expect(setup.status).toBe(201);
    const [row] = await app.ctx.db.select().from(financePaymentMethods).where(eq(financePaymentMethods.id, setup.body.id));
    expect(row).toMatchObject({ mandateText: preview.body.mandateText, methodType: 'sepa_debit', mandateLocale: 'en-GB', status: 'pending', mandateAcceptedBy: foEu.userId });
    const active = await call(app, 'POST', `${base()}/payment-methods/${setup.body.id}/sandbox-confirm`, { token: foEu.token, body: { outcome: 'ok' } });
    expect(active.body).toMatchObject({ status: 'active', methodType: 'sepa_debit', display: { bankName: 'Sandbox Bank', last4: '4242' } });
    expect(active.body.mandateId).toMatch(/^mandate_sandbox_/);
  });

  it('collects by SEPA: processing, then the delayed failure reopens the invoice for dunning, then success', async () => {
    const st = await statementOf(dub);
    expect((await call(app, 'POST', `${base()}/statements/${st.id}/approve`, { token: finance.token })).status).toBe(200);
    const issued = await call(app, 'POST', `${base()}/statements/${st.id}/invoice`, { token: finance.token });
    expect(issued.status).toBe(201);
    expect(issued.body.collection.status).toBe('processing');
    const id = issued.body.invoice.id;
    expect((await call(app, 'GET', `${base()}/invoices/${id}`, { token: foEu.token })).body.status).toBe('processing');
    const [att1] = await app.ctx.db.select().from(financeCollectionAttempts).where(eq(financeCollectionAttempts.invoiceId, id));
    // Flat BranchHarbor collection fee in the price-book currency (EUR 0.95), taken as the platform fee — not a percentage.
    expect(att1).toMatchObject({ methodType: 'sepa_debit', platformFeeMinor: 95, status: 'processing', settledAt: null });
    expect((await app.ctx.db.select().from(paymentReferences).where(eq(paymentReferences.id, att1!.paymentId!)))[0]!.applicationFeeMinor).toBe(95);

    // Days later the bank returns the debit.
    const failed = await call(app, 'POST', `${base()}/invoices/${id}/sandbox-settle`, { token: finance.token, body: { outcome: 'failed' } });
    expect(failed.status).toBe(200);
    const after = await call(app, 'GET', `${base()}/invoices/${id}`, { token: foEu.token });
    expect(after.body.status).toBe('open');
    const [att1b] = await app.ctx.db.select().from(financeCollectionAttempts).where(eq(financeCollectionAttempts.id, att1!.id));
    expect(att1b).toMatchObject({ status: 'failed', platformFeeMinor: 0 });
    expect(att1b!.settledAt).toBeInstanceOf(Date);

    // The existing dunning tells the franchisee once, then retries on the policy's day.
    const due = issued.body.invoice.dueDate as string;
    const day = (d: number) => new Date(Date.parse(`${due}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
    const before = app.ctx.mailer.outbox.length;
    const r1 = await call(app, 'POST', `${base()}/dunning/run`, { token: finance.token, body: { today: day(-5) } });
    expect(r1.body.failureNotices).toBe(1);
    const notice = app.ctx.mailer.outbox.slice(before).find((m) => m.to === foEu.email)!;
    expect(notice.subject).toContain('failed');
    expect(notice.text).toContain(`retried automatically on ${day(3)}`);
    expect((await call(app, 'POST', `${base()}/dunning/run`, { token: finance.token, body: { today: day(-5) } })).body.failureNotices).toBe(0);
    const r2 = await call(app, 'POST', `${base()}/dunning/run`, { token: finance.token, body: { today: day(3) } });
    expect(r2.body.retries).toBe(1);
    const [, att2] = await app.ctx.db.select().from(financeCollectionAttempts).where(eq(financeCollectionAttempts.invoiceId, id)).orderBy(financeCollectionAttempts.attempt);
    expect(att2).toMatchObject({ status: 'processing', platformFeeMinor: 95 });
    expect((await call(app, 'POST', `${base()}/invoices/${id}/sandbox-settle`, { token: finance.token, body: { outcome: 'succeeded' } })).body.invoice.status).toBe('paid');
  });

  it('revokes a method when Stripe reports its mandate inactive, and tracks micro-deposit verification', async () => {
    const [pm] = await app.ctx.db.select().from(financePaymentMethods).where(eq(financePaymentMethods.ownerGroupId, gEu));
    const event = (type: string, object: Record<string, unknown>) => ({ id: `evt_${uid()}`, object: 'event', type, account: 'acct_sandbox_t', created: 0, livemode: false, api_version: null, pending_webhooks: 0, request: { id: null, idempotency_key: null }, data: { object } }) as unknown as Stripe.Event;
    const r = await processStripeEvent(app.ctx, event('mandate.updated', { id: pm!.mandateId, object: 'mandate', status: 'inactive' }));
    expect(r.note).toContain('revoked');
    expect((await app.ctx.db.select().from(financePaymentMethods).where(eq(financePaymentMethods.id, pm!.id)))[0]).toMatchObject({ status: 'revoked', failureReason: 'mandate_inactive' });

    const ach = await call(app, 'POST', `${base()}/payment-methods/setup`, { token: foCa.token, body: { ownerGroupId: gCa, currency: 'CAD', methodType: 'acss_debit', acceptMandate: true } });
    expect(ach.status).toBe(201);
    await processStripeEvent(app.ctx, event('setup_intent.requires_action', { id: 'seti_x', object: 'setup_intent', metadata: { bh_finance_method: ach.body.id, bh_org: orgId }, next_action: { type: 'verify_with_microdeposits', verify_with_microdeposits: { hosted_verification_url: 'https://payments.stripe.com/microdeposit/abc' } } }));
    const list = await call(app, 'GET', `${base()}/payment-methods`, { token: foCa.token });
    expect(list.body.items.find((m: any) => m.id === ach.body.id)).toMatchObject({ status: 'verifying', verificationUrl: 'https://payments.stripe.com/microdeposit/abc' });
    expect((await call(app, 'POST', `${base()}/payment-methods/${ach.body.id}/sandbox-confirm`, { token: foCa.token, body: { outcome: 'ok' } })).body.status).toBe('active');
  });

  it('issues monthly statements per franchisee: in-app, PDF and email, each franchisee sees only their own', async () => {
    const st = await statementOf(tor);
    await call(app, 'POST', `${base()}/statements/${st.id}/approve`, { token: finance.token });
    await call(app, 'POST', `${base()}/statements/${st.id}/invoice`, { token: finance.token });
    expect((await call(app, 'POST', `${base()}/periods/${periodId}/franchisee-statements`, { token: foEu.token })).status).toBe(403);
    const before = app.ctx.mailer.outbox.length;
    const issued = await call(app, 'POST', `${base()}/periods/${periodId}/franchisee-statements`, { token: finance.token });
    expect(issued.status).toBe(200);
    expect(issued.body.items).toHaveLength(2);
    expect(issued.body.emailed).toBe(2);
    const eu = issued.body.items.find((x: any) => x.ownerGroup.id === gEu);
    expect(eu).toMatchObject({ currency: 'EUR', grossSalesMinor: 500_000, royaltyMinor: 30_000, marketingFundMinor: 10_000, totalMinor: 40_000, collectedMinor: 40_000, collectionFeeMinor: 95 });
    expect(eu.lines[0]).toMatchObject({ locationName: 'Dublin Docklands', salesSource: 'branchharbor', royaltyRateBps: 600, marketingFundRateBps: 200, collectionMethod: 'sepa_debit', collectionStatus: 'succeeded', invoiceStatus: 'paid', collectionFeeMinor: 95 });
    expect(eu.lines[0].collectionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const mail = app.ctx.mailer.outbox.slice(before).find((m) => m.to === foEu.email)!;
    expect(mail.subject).toContain('September 2026');
    expect(mail.text).toContain('/finance/statements?tab=monthly&statement=');
    // Re-issuing refreshes the same rows without emailing again.
    const again = await call(app, 'POST', `${base()}/periods/${periodId}/franchisee-statements`, { token: finance.token });
    expect(again.body.emailed).toBe(0);
    expect(again.body.items.map((x: any) => x.id).sort()).toEqual(issued.body.items.map((x: any) => x.id).sort());

    const mine = await call(app, 'GET', `${base()}/franchisee-statements`, { token: foEu.token });
    expect(mine.body.items.map((x: any) => x.ownerGroup.id)).toEqual([gEu]);
    const other = issued.body.items.find((x: any) => x.ownerGroup.id === gCa);
    expect((await call(app, 'GET', `${base()}/franchisee-statements/${other.id}`, { token: foEu.token })).status).toBe(404);
    const pdf = await call(app, 'GET', `${base()}/franchisee-statements/${eu.id}/pdf`, { token: foEu.token });
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const text = pdf.raw.rawPayload.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('ROYALTY STATEMENT');
    expect(text).toContain('SEPA Direct Debit');
    expect(text).toContain('paid by the franchisor');
    expect((await call(app, 'GET', `${base()}/franchisee-statements/${eu.id}/pdf`, { token: foCa.token })).status).toBe(404);
  });
});

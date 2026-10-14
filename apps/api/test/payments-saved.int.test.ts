/**
 * Saved cards, subscriptions, off-session charges and Connect webhooks with a MOCKED Stripe client (the live code
 * paths run, but nothing ever reaches Stripe), plus the sandbox end-to-end path for instalments.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { and, eq } from 'drizzle-orm';
import type { Config } from '../src/config.ts';
import {
  customers, locations, memberships, offSessionCharges, paymentConsents, paymentCustomers, paymentReferences, registrations, sportsInstalments, stripeRecurringPrices, studioFees, studioMembershipPlans,
} from '../src/db/schema/index.ts';
import { createPaymentsProvider, signStripePayload, verifyStripeWebhook } from '../src/integrations/payments.ts';
import { ensureMembershipSubscription, runAutoFeeCharges, runInstalmentAutoCharges } from '../src/services/payments-saved.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, uid, verifiedUser, WEBHOOK_SECRET } from './helpers.ts';

const CONNECT_SECRET = 'whsec_connect_test_secret_for_branchharbor';
const SECRET_KEY = 'sk_test_mock_must_never_leak_0001';
const PUBLISHABLE = 'pk_test_mock_publishable_0001';
const ACCOUNT = 'acct_mock_studio_0001';
const DAY = 86400_000;
const quiet = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as never;

/** Minimal mocked Stripe client: records calls and returns deterministic objects. */
function mockStripe() {
  let n = 0;
  const id = (p: string) => `${p}_mock_${++n}`;
  const state = { offSession: 'succeed' as 'succeed' | 'decline' | 'sca' };
  const client = {
    accounts: { create: vi.fn(async () => ({ id: ACCOUNT })), retrieve: vi.fn(async () => ({ charges_enabled: true, payouts_enabled: true, details_submitted: true })) },
    accountLinks: { create: vi.fn(async () => ({ url: 'https://connect.stripe.test/onboarding', expires_at: Math.floor(Date.now() / 1000) + 300 })) },
    paymentIntents: {
      create: vi.fn(async (params: Record<string, any>) => {
        const pid = id('pi');
        if (params.off_session) {
          if (state.offSession === 'decline') {
            throw Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined', raw: { payment_intent: { id: pid, client_secret: `${pid}_secret_x`, status: 'requires_payment_method' } } });
          }
          if (state.offSession === 'sca') {
            throw Object.assign(new Error('This payment requires authentication.'), { type: 'StripeCardError', code: 'authentication_required', raw: { payment_intent: { id: pid, client_secret: `${pid}_secret_x`, status: 'requires_action' } } });
          }
          return { id: pid, client_secret: `${pid}_secret_x`, status: 'succeeded' };
        }
        return { id: pid, client_secret: `${pid}_secret_x`, status: 'requires_payment_method' };
      }),
      update: vi.fn(async (pid: string) => ({ id: pid })),
      cancel: vi.fn(async (pid: string) => ({ id: pid })),
    },
    customers: { create: vi.fn(async () => ({ id: id('cus') })), update: vi.fn(async (cid: string) => ({ id: cid })) },
    setupIntents: { create: vi.fn(async () => { const sid = id('seti'); return { id: sid, client_secret: `${sid}_secret_x` }; }) },
    paymentMethods: { retrieve: vi.fn(async () => ({ type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031 } })) },
    prices: { list: vi.fn(async () => ({ data: [] })), create: vi.fn(async () => ({ id: id('price') })) },
    products: { create: vi.fn(async () => ({ id: id('prod') })) },
    subscriptions: {
      create: vi.fn(async () => ({ id: id('sub'), status: 'trialing', latest_invoice: null })),
      update: vi.fn(async (sid: string) => ({ id: sid })), cancel: vi.fn(async (sid: string) => ({ id: sid })), retrieve: vi.fn(async (sid: string) => ({ id: sid, customer: 'cus_x' })),
    },
    invoices: { list: vi.fn(async () => ({ data: [{ id: 'in_open_1' }] })), pay: vi.fn(async () => ({ id: 'in_open_1', status: 'paid' })) },
    refunds: { create: vi.fn(async () => ({ id: id('re'), status: 'succeeded' })) },
  };
  return { client: client as unknown as Stripe, mock: client, state };
}

const cfgFor = (over: Partial<Config> = {}) => ({ STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_PUBLISHABLE_KEY: PUBLISHABLE, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT_SECRET, ...over }) as Config;

const eventJson = (type: string, object: Record<string, unknown>, account?: string) => JSON.stringify({
  id: `evt_${uid()}${uid()}`, object: 'event', type, api_version: '2026-09-30', created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null },
  ...(account ? { account } : {}), data: { object },
});

describe('Connect webhook signature selection (unit)', () => {
  const cfg = { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT_SECRET };
  const scoped = eventJson('payment_intent.succeeded', { id: 'pi_1', object: 'payment_intent' }, ACCOUNT);
  const platform = eventJson('account.updated', { id: ACCOUNT, object: 'account' });

  it('verifies connected-account events with the Connect secret only on the Connect endpoint', () => {
    expect(verifyStripeWebhook(cfg, scoped, signStripePayload(scoped, CONNECT_SECRET), 'connect').source).toBe('connect');
    expect(() => verifyStripeWebhook(cfg, scoped, signStripePayload(scoped, WEBHOOK_SECRET), 'connect')).toThrow();
    // A Connect-signed event without `account` is rejected (scope mismatch).
    expect(() => verifyStripeWebhook(cfg, platform, signStripePayload(platform, CONNECT_SECRET), 'connect')).toThrow(/without an account/);
  });

  it('platform endpoint uses STRIPE_WEBHOOK_SECRET and rejects account-scoped events; the legacy URL falls back to the Connect secret', () => {
    expect(verifyStripeWebhook(cfg, platform, signStripePayload(platform, WEBHOOK_SECRET), 'platform').source).toBe('platform');
    expect(() => verifyStripeWebhook(cfg, scoped, signStripePayload(scoped, WEBHOOK_SECRET), 'platform')).toThrow(/connected-account/);
    expect(() => verifyStripeWebhook(cfg, platform, signStripePayload(platform, CONNECT_SECRET), 'platform')).toThrow();
    expect(verifyStripeWebhook(cfg, scoped, signStripePayload(scoped, CONNECT_SECRET), 'auto').source).toBe('connect');
    expect(verifyStripeWebhook(cfg, platform, signStripePayload(platform, WEBHOOK_SECRET), 'auto').source).toBe('platform');
    expect(() => verifyStripeWebhook({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET: undefined }, scoped, signStripePayload(scoped, CONNECT_SECRET), 'connect')).toThrow();
  });
});

describe.skipIf(!hasDb)('Saved cards, subscriptions and off-session charges (mocked Stripe, live code paths)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let loc: any;
  let occId: string;
  const { client, mock, state } = mockStripe();
  const postConnect = (payload: string, secret = CONNECT_SECRET) => app.inject({ method: 'POST', url: '/v1/webhooks/stripe/connect', payload, headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(payload, secret) } });
  const newCustomer = async (name = 'Ana Member') => (await app.ctx.db.insert(customers).values({ organizationId: orgId, locationId: loc.id, name, email: `c-${uid()}@example.com` }).returning())[0]!;
  const saveCard = async (customerId: string, pm = 'pm_mock_card') => {
    await app.ctx.db.insert(paymentCustomers).values({ organizationId: orgId, customerId, connectedAccountId: ACCOUNT, stripeCustomerId: `cus_mock_${uid()}`, defaultPaymentMethodId: pm }).onConflictDoUpdate({ target: [paymentCustomers.customerId, paymentCustomers.connectedAccountId], set: { defaultPaymentMethodId: pm } });
  };
  const consent = (customerId: string, purpose: string, targetType: string | null = null, targetId: string | null = null) =>
    app.ctx.db.insert(paymentConsents).values({ organizationId: orgId, customerId, connectedAccountId: ACCOUNT, purpose, targetType, targetId, text: 'I agree' });

  beforeAll(async () => {
    const provider = createPaymentsProvider(cfgFor(), quiet, client);
    app = await makeApp({ payments: provider }, { STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_PUBLISHABLE_KEY: PUBLISHABLE, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT_SECRET });
    ({ token } = await verifiedUser(app));
    orgId = (await createOrg(app, token)).id;
    loc = await createLocation(app, token, orgId);
    await enablePublicAndPayments(app, token, orgId, loc.id);
    // Live onboarding does not enable charges until Stripe says so (account.updated); simulate that.
    await app.ctx.db.update(locations).set({ paymentsEnabled: true, stripeAccountId: ACCOUNT }).where(eq(locations.id, loc.id));
    const ct = await call(app, 'POST', `/v1/orgs/${orgId}/studios/class-types`, { token, body: { locationId: loc.id, name: 'Power Flow', durationMinutes: 60, defaultCapacity: 10 } });
    occId = (await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences`, { token, body: { locationId: loc.id, classTypeId: ct.body.id, startsAt: new Date(Date.now() + DAY).toISOString(), priceMinor: 2500 } })).body.items[0].id;
  });
  afterAll(async () => { await app?.close(); });

  it('exposes the publishable key and connected account per payment — never a secret key or webhook secret', async () => {
    const b = await call(app, 'POST', `/v1/public/studios/occurrences/${occId}/bookings`, { body: { contact: { name: 'Lee', email: `lee-${uid()}@example.com` } } });
    expect(b.status).toBe(201);
    expect(b.body.payment.clientSecret).toMatch(/^pi_mock_\d+_secret_x$/);
    const view = await call(app, 'GET', `/v1/public/payments/${b.body.payment.id}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ mode: 'live', publishableKey: PUBLISHABLE, stripeAccount: ACCOUNT, cardEntryAvailable: true, state: 'created', amount: { amount: 2500, currency: 'CAD' } });
    expect(view.body.clientSecret).toBeUndefined();
    const cfg = await call(app, 'GET', `/v1/public/payments/config?locationId=${loc.id}`);
    expect(cfg.body).toMatchObject({ mode: 'live', publishableKey: PUBLISHABLE, stripeAccount: ACCOUNT });
    for (const body of [view.body, cfg.body, b.body]) {
      const json = JSON.stringify(body);
      expect(json).not.toContain(SECRET_KEY);
      expect(json).not.toContain('whsec_');
      expect(json).not.toMatch(/sk_(test|live)_/);
    }
    // The intent is a direct charge on the connected account.
    const created = mock.paymentIntents.create.mock.calls.at(-1)! as unknown as [Record<string, unknown>, Stripe.RequestOptions];
    expect(created[1]).toMatchObject({ stripeAccount: ACCOUNT });
    expect(created[0]).toMatchObject({ automatic_payment_methods: { enabled: true } });
    // The action link needs the signed token.
    expect((await call(app, 'GET', `/v1/public/payments/${b.body.payment.id}/action?token=${'x'.repeat(43)}`)).status).toBe(404);
  });

  it('save-card consent attaches the Customer + setup_future_usage; payment_intent.succeeded (Connect) remembers the card', async () => {
    const b = await call(app, 'POST', `/v1/public/studios/occurrences/${occId}/bookings`, { body: { contact: { name: 'Sam', email: `sam-${uid()}@example.com` } } });
    const pid = b.body.payment.id;
    const r = await call(app, 'POST', `/v1/public/payments/${pid}/save-card`, { body: { purposes: ['save_card'], text: 'Save this card', locale: 'en' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [p] = await app.ctx.db.select().from(paymentReferences).where(eq(paymentReferences.id, pid));
    const upd = mock.paymentIntents.update.mock.calls.at(-1)! as unknown as [string, Record<string, unknown>, Stripe.RequestOptions];
    expect(upd[0]).toBe(p!.externalId);
    expect(upd[1]).toMatchObject({ setup_future_usage: 'off_session' });
    expect(upd[2]).toMatchObject({ stripeAccount: ACCOUNT });
    const cust = String(upd[1].customer);
    const res = await postConnect(eventJson('payment_intent.succeeded', { id: p!.externalId, object: 'payment_intent', amount: 2500, amount_received: 2500, currency: 'cad', status: 'succeeded', metadata: {}, customer: cust, payment_method: 'pm_saved_1', setup_future_usage: 'off_session' }, ACCOUNT));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ source: 'connect', duplicate: false });
    const [pc] = await app.ctx.db.select().from(paymentCustomers).where(eq(paymentCustomers.stripeCustomerId, cust));
    expect(pc!.defaultPaymentMethodId).toBe('pm_saved_1');
    // The platform secret cannot sign Connect events.
    expect((await postConnect(eventJson('payment_intent.succeeded', { id: 'pi_x', object: 'payment_intent' }, ACCOUNT), WEBHOOK_SECRET)).statusCode).toBe(400);
  });

  it('membership subscription: created once with the saved card and one price per plan/currency (idempotent)', async () => {
    const [plan] = await app.ctx.db.insert(studioMembershipPlans).values({ organizationId: orgId, name: `Unlimited ${uid()}`, prices: { CAD: 9900 } } as typeof studioMembershipPlans.$inferInsert).returning();
    const make = async () => {
      const c = await newCustomer();
      const [m] = await app.ctx.db.insert(memberships).values({ organizationId: orgId, locationId: loc.id, customerId: c.id, plan: plan!.name, planId: plan!.id, status: 'active', priceMinor: 9900, currency: 'CAD', startsAt: new Date(), recurring: true, currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * DAY) }).returning();
      return { c, m: m! };
    };
    const a = await make();
    expect((await ensureMembershipSubscription(app.ctx, a.m.id)).status).toBe('needs_consent');
    await consent(a.c.id, 'renewals', 'studio_purchase', null);
    expect((await ensureMembershipSubscription(app.ctx, a.m.id)).status).toBe('needs_card');
    await saveCard(a.c.id, 'pm_member_a');

    const before = mock.subscriptions.create.mock.calls.length;
    const [r1, r2] = await Promise.all([ensureMembershipSubscription(app.ctx, a.m.id), ensureMembershipSubscription(app.ctx, a.m.id)]);
    const r3 = await ensureMembershipSubscription(app.ctx, a.m.id);
    expect(mock.subscriptions.create.mock.calls.length - before).toBe(1);
    expect(new Set([r1.subscriptionId, r2.subscriptionId, r3.subscriptionId]).size).toBe(1);
    expect(r3.status).toBe('exists');
    const sc = mock.subscriptions.create.mock.calls.at(-1)! as unknown as [Record<string, any>, Stripe.RequestOptions];
    expect(sc[0]).toMatchObject({ default_payment_method: 'pm_member_a', items: [{ price: expect.stringMatching(/^price_mock_/) }] });
    expect(sc[0].trial_end).toBeGreaterThan(Date.now() / 1000 + 29 * 86400);
    expect(sc[1]).toMatchObject({ stripeAccount: ACCOUNT, idempotencyKey: `membership:${a.m.id}:subscription` });

    // A second member on the same plan reuses the price created on the connected account.
    const pricesBefore = mock.prices.create.mock.calls.length;
    const b = await make();
    await consent(b.c.id, 'renewals');
    await saveCard(b.c.id, 'pm_member_b');
    expect((await ensureMembershipSubscription(app.ctx, b.m.id)).status).toBe('created');
    expect(mock.prices.create.mock.calls.length).toBe(pricesBefore);
    expect(await app.ctx.db.select().from(stripeRecurringPrices).where(eq(stripeRecurringPrices.planKey, `studio_plan:${plan!.id}`))).toHaveLength(1);
  });

  it('renewals: invoice.payment_failed → grace, subscription unpaid → suspended, invoice.paid → reactivated (Connect events)', async () => {
    const c = await newCustomer('Riley Renew');
    const [m] = await app.ctx.db.insert(memberships).values({ organizationId: orgId, locationId: loc.id, customerId: c.id, plan: 'Monthly', status: 'active', priceMinor: 8000, currency: 'CAD', startsAt: new Date(), recurring: true, currentPeriodStart: new Date(Date.now() - 30 * DAY), currentPeriodEnd: new Date(), stripeSubscriptionId: `sub_live_${uid()}` }).returning();
    const sub = m!.stripeSubscriptionId!;
    const get = async () => (await app.ctx.db.select().from(memberships).where(eq(memberships.id, m!.id)))[0]!;

    expect((await postConnect(eventJson('invoice.payment_failed', { id: `in_${uid()}`, object: 'invoice', subscription: sub, amount_paid: 0, currency: 'cad' }, ACCOUNT))).statusCode).toBe(200);
    let after = await get();
    expect(after.status).toBe('grace');
    expect(after.graceUntil!.getTime()).toBeGreaterThan(Date.now());

    expect((await postConnect(eventJson('customer.subscription.updated', { id: sub, object: 'subscription', status: 'unpaid' }, ACCOUNT))).statusCode).toBe(200);
    expect((await get()).status).toBe('suspended');

    const paid = eventJson('invoice.paid', { id: `in_${uid()}`, object: 'invoice', subscription: sub, amount_paid: 8000, currency: 'cad', billing_reason: 'subscription_cycle', payment_intent: `pi_${uid()}` }, ACCOUNT);
    expect((await postConnect(paid)).statusCode).toBe(200);
    after = await get();
    expect(after.status).toBe('active');
    expect(after.graceUntil).toBeNull();
    expect(after.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now() + 25 * DAY);
    // Duplicate delivery is a no-op.
    expect((await postConnect(paid)).json()).toMatchObject({ duplicate: true });

    // past_due on an active membership → grace.
    expect((await postConnect(eventJson('customer.subscription.updated', { id: sub, object: 'subscription', status: 'past_due' }, ACCOUNT))).statusCode).toBe(200);
    expect((await get()).status).toBe('grace');
  });

  it('card update (SetupIntent): setup_intent.succeeded sets the default card and retries the open renewal', async () => {
    const c = await newCustomer('Uma Update');
    await saveCard(c.id, 'pm_old');
    const sub = `sub_live_${uid()}`;
    await app.ctx.db.insert(memberships).values({ organizationId: orgId, locationId: loc.id, customerId: c.id, plan: 'Monthly', status: 'grace', graceUntil: new Date(Date.now() + 3 * DAY), priceMinor: 8000, currency: 'CAD', startsAt: new Date(), recurring: true, currentPeriodEnd: new Date(), stripeSubscriptionId: sub });
    const [pc] = await app.ctx.db.select().from(paymentCustomers).where(eq(paymentCustomers.customerId, c.id));
    const payBefore = mock.invoices.pay.mock.calls.length;
    const res = await postConnect(eventJson('setup_intent.succeeded', { id: `seti_${uid()}`, object: 'setup_intent', status: 'succeeded', customer: pc!.stripeCustomerId, payment_method: 'pm_new_card' }, ACCOUNT));
    expect(res.statusCode, res.body).toBe(200);
    const [after] = await app.ctx.db.select().from(paymentCustomers).where(eq(paymentCustomers.id, pc!.id));
    expect(after).toMatchObject({ defaultPaymentMethodId: 'pm_new_card', cardBrand: 'visa', cardLast4: '4242' });
    expect(mock.subscriptions.update.mock.calls.some((x) => (x as unknown[])[0] === sub && ((x as unknown[])[1] as Record<string, unknown>).default_payment_method === 'pm_new_card')).toBe(true);
    expect(mock.invoices.pay.mock.calls.length).toBe(payBefore + 1);
  });

  it('automatic fees: charged only with consent + saved card, after the waive window, once per fee; failures stay unpaid and visible', async () => {
    const withConsent = await newCustomer('Fee Consent');
    const noConsent = await newCustomer('Fee NoConsent');
    const mkFee = async (customerId: string, kind = 'late_cancel') => (await app.ctx.db.insert(studioFees).values({ organizationId: orgId, locationId: loc.id, customerId, bookingId: crypto.randomUUID(), kind, amountMinor: 1500, currency: 'CAD' }).returning())[0]!;
    const f1 = await mkFee(withConsent.id);
    const f2 = await mkFee(noConsent.id);
    await consent(withConsent.id, 'fees', 'class_booking', f1.bookingId);
    await saveCard(withConsent.id, 'pm_fee_ok');
    await saveCard(noConsent.id, 'pm_fee_other');

    // Within the waive window (default 24h): nothing is charged.
    expect((await runAutoFeeCharges(app.ctx, new Date(), { organizationId: orgId })).charged).toBe(0);
    const later = new Date(Date.now() + 25 * 3600_000);
    const run = await runAutoFeeCharges(app.ctx, later, { organizationId: orgId });
    expect(run.charged).toBe(1);
    const offCalls = mock.paymentIntents.create.mock.calls.filter((x) => ((x as unknown[])[0] as Record<string, unknown>).off_session) as unknown as Array<[Record<string, unknown>, Stripe.RequestOptions]>;
    expect(offCalls).toHaveLength(1);
    expect(offCalls[0]![0]).toMatchObject({ amount: 1500, currency: 'cad', payment_method: 'pm_fee_ok', confirm: true, off_session: true });
    expect(offCalls[0]![1]).toMatchObject({ stripeAccount: ACCOUNT, idempotencyKey: `studio_fee:${f1.id}:1` });
    // Fee is paid only when the signed webhook arrives.
    expect((await app.ctx.db.select().from(studioFees).where(eq(studioFees.id, f1.id)))[0]!.status).toBe('due');
    const [ch] = await app.ctx.db.select().from(offSessionCharges).where(eq(offSessionCharges.refId, f1.id));
    const [p] = await app.ctx.db.select().from(paymentReferences).where(eq(paymentReferences.id, ch!.paymentId!));
    const ok = await postConnect(eventJson('payment_intent.succeeded', { id: p!.externalId, object: 'payment_intent', amount: 1500, amount_received: 1500, currency: 'cad', status: 'succeeded', metadata: {} }, ACCOUNT));
    expect(ok.statusCode).toBe(200);
    expect((await app.ctx.db.select().from(studioFees).where(eq(studioFees.id, f1.id)))[0]!.status).toBe('paid');
    expect((await app.ctx.db.select().from(studioFees).where(eq(studioFees.id, f2.id)))[0]!.status).toBe('due');
    expect((await app.ctx.db.select().from(offSessionCharges).where(eq(offSessionCharges.id, ch!.id)))[0]!.state).toBe('succeeded');

    // Idempotent: running again never charges the same fee twice.
    await runAutoFeeCharges(app.ctx, later, { organizationId: orgId });
    expect(mock.paymentIntents.create.mock.calls.filter((x) => ((x as unknown[])[0] as Record<string, unknown>).off_session)).toHaveLength(1);

    // Decline: fee stays due, attempt recorded as failed, customer emailed, visible to staff; waive still possible.
    const f3 = await mkFee(withConsent.id, 'no_show');
    await consent(withConsent.id, 'fees', 'class_booking', f3.bookingId);
    state.offSession = 'decline';
    const failed = await runAutoFeeCharges(app.ctx, later, { organizationId: orgId });
    expect(failed.failed).toBe(1);
    expect((await app.ctx.db.select().from(studioFees).where(eq(studioFees.id, f3.id)))[0]!.status).toBe('due');
    const [ch3] = await app.ctx.db.select().from(offSessionCharges).where(eq(offSessionCharges.refId, f3.id));
    expect(ch3).toMatchObject({ state: 'failed', failureCode: 'card_declined' });
    expect(ch3!.notifiedAt).not.toBeNull();
    const staff = await call(app, 'GET', `/v1/orgs/${orgId}/payments/off-session-charges?state=failed`, { token });
    expect(staff.body.items.some((x: any) => x.refId === f3.id && x.failureMessage)).toBe(true);
    const list = await call(app, 'GET', `/v1/orgs/${orgId}/studios/fees?status=due`, { token });
    expect(list.body.items.find((x: any) => x.id === f3.id).autoCharge).toMatchObject({ state: 'failed' });
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/studios/fees/${f3.id}/waive`, { token, body: { reason: 'Card declined, goodwill' } })).status).toBe(200);

    // SCA on an off-session charge: requires_action + signed link to complete it.
    const f4 = await mkFee(withConsent.id);
    await consent(withConsent.id, 'fees', 'class_booking', f4.bookingId);
    state.offSession = 'sca';
    expect((await runAutoFeeCharges(app.ctx, later, { organizationId: orgId })).requiresAction).toBe(1);
    const [ch4] = await app.ctx.db.select().from(offSessionCharges).where(eq(offSessionCharges.refId, f4.id));
    expect(ch4!.state).toBe('requires_action');
    const { paymentActionToken } = await import('../src/services/payments-saved.ts');
    const action = await call(app, 'GET', `/v1/public/payments/${ch4!.paymentId}/action?token=${paymentActionToken(app.ctx.cfg, ch4!.paymentId!)}`);
    expect(action.status).toBe(200);
    expect(action.body).toMatchObject({ publishableKey: PUBLISHABLE, stripeAccount: ACCOUNT, clientSecret: expect.stringMatching(/_secret_x$/) });

    // Organisation setting off: no automatic charging.
    state.offSession = 'succeed';
    const f5 = await mkFee(withConsent.id);
    await consent(withConsent.id, 'fees', 'class_booking', f5.bookingId);
    expect((await call(app, 'PUT', `/v1/orgs/${orgId}/payments/automation`, { token, body: { autoChargeFees: false } })).status).toBe(200);
    expect((await runAutoFeeCharges(app.ctx, later, { organizationId: orgId })).charged).toBe(0);
    expect(await app.ctx.db.select().from(offSessionCharges).where(eq(offSessionCharges.refId, f5.id))).toHaveLength(0);
    await call(app, 'PUT', `/v1/orgs/${orgId}/payments/automation`, { token, body: { autoChargeFees: true } });
  });
});

describe.skipIf(!hasDb)('Sports instalments charged off-session on the due date (sandbox end to end)', () => {
  let app: FastifyInstance;
  let owner: { token: string };
  let orgId: string;
  let loc: any;
  let programme: any;
  const isoDay = (d: number) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Treasurer Tess');
    orgId = (await createOrg(app, owner.token, { industry: 'sports' })).id;
    loc = await createLocation(app, owner.token, orgId, { name: 'Riverside' });
    await enablePublicAndPayments(app, owner.token, orgId, loc.id);
    const res = await call(app, 'POST', `/v1/orgs/${orgId}/sports/setup`, {
      token: owner.token,
      body: {
        locationId: loc.id, publish: true,
        season: { name: 'Winter', startsOn: isoDay(-5), endsOn: isoDay(120), ageRule: 'birth_year', ageCutoffDate: '2026-12-31' },
        programmes: [{
          name: 'Hockey', ageMin: 6, ageMax: 12, capacity: 30, feeMinor: 30_000, requiresApproval: false, refundPolicy: 'No refunds after the first session.',
          feePlans: [{ name: 'Pay in full', kind: 'full' }, { name: '3 instalments', kind: 'instalments', schedule: [{ dueOn: isoDay(0), shareBps: 3334 }, { dueOn: isoDay(30), shareBps: 3333 }, { dueOn: isoDay(60), shareBps: 3333 }] }],
        }],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    programme = res.body.programmes[0];
  });
  afterAll(async () => { await app?.close(); });

  it('saves the card with consent at checkout, charges the next instalment on its due date, and a decline leaves it overdue with a portal path', async () => {
    const plan = (await call(app, 'GET', `/v1/public/sports/${loc.id}/programmes`)).body.items[0].paymentOptions.find((x: any) => x.kind === 'instalments');
    const email = `guardian-${uid()}@example.com`;
    const r = await call(app, 'POST', `/v1/public/sports/programmes/${programme.id}/registrations`, { body: { guardian: { name: 'Gail Guardian', email }, participant: { name: 'Kit', dateOfBirth: '2017-05-05' }, relationship: 'parent', answers: { emergency_contact_name: 'Robin Grey', emergency_contact_phone: '+1 416 555 0199', photo_consent: true }, acceptRefundPolicy: true, feePlanId: plan.id } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pid = r.body.payment.id;
    const view = await call(app, 'GET', `/v1/public/payments/${pid}`);
    expect(view.body.saveCard).toMatchObject({ mode: 'required', purposes: ['instalments'] });
    expect(view.body).toMatchObject({ mode: 'sandbox', publishableKey: null, stripeAccount: null });
    expect((await call(app, 'POST', `/v1/public/payments/${pid}/save-card`, { body: { purposes: ['instalments'], text: 'Charge the remaining instalments', locale: 'en' } })).status).toBe(200);
    expect((await call(app, 'POST', `/v1/public/payments/${pid}/sandbox-confirm`, { body: { outcome: 'succeeded' } })).status).toBe(200);

    const reg = (await app.ctx.db.select().from(registrations).where(eq(registrations.id, r.body.registration.id)))[0]!;
    expect(reg.status).toBe('accepted');
    const [pc] = await app.ctx.db.select().from(paymentCustomers).where(eq(paymentCustomers.customerId, reg.guardianCustomerId!));
    expect(pc!.defaultPaymentMethodId).toMatch(/^pm_sandbox_/);

    // Not due yet → nothing happens; on the due date → charged and paid through the event processor.
    expect((await runInstalmentAutoCharges(app.ctx, new Date(Date.now() + 5 * DAY), { organizationId: orgId })).charged).toBe(0);
    const run = await runInstalmentAutoCharges(app.ctx, new Date(Date.now() + 31 * DAY), { organizationId: orgId });
    expect(run.charged).toBe(1);
    const inst = await app.ctx.db.select().from(sportsInstalments).where(eq(sportsInstalments.registrationId, reg.id));
    expect(inst.sort((a, b) => a.seq - b.seq).map((i) => i.status)).toEqual(['paid', 'paid', 'scheduled']);
    // Idempotent.
    expect((await runInstalmentAutoCharges(app.ctx, new Date(Date.now() + 31 * DAY), { organizationId: orgId })).charged).toBe(0);

    // The card starts declining: the third instalment fails, stays unpaid and is marked overdue; the guardian is notified.
    await app.ctx.db.update(paymentCustomers).set({ defaultPaymentMethodId: 'pm_sandbox_decline_1' }).where(eq(paymentCustomers.id, pc!.id));
    const fail = await runInstalmentAutoCharges(app.ctx, new Date(Date.now() + 61 * DAY), { organizationId: orgId });
    expect(fail.failed).toBe(1);
    const third = (await app.ctx.db.select().from(sportsInstalments).where(and(eq(sportsInstalments.registrationId, reg.id), eq(sportsInstalments.seq, 3))))[0]!;
    expect(third.status).toBe('scheduled');
    expect(third.lastReminderStage).toBe('overdue');
    const [ch] = await app.ctx.db.select().from(offSessionCharges).where(eq(offSessionCharges.refId, third.id));
    expect(ch).toMatchObject({ state: 'failed' });
    expect(ch!.notifiedAt).not.toBeNull();
    const [failedPay] = await app.ctx.db.select().from(paymentReferences).where(eq(paymentReferences.id, third.paymentId!));
    expect(failedPay!.state).toBe('failed');

    // The guardian can still pay it in the portal (a fresh intent).
    const link = await call(app, 'POST', '/v1/public/sports/portal/request-link', { body: { locationId: loc.id, email } });
    const sess = await call(app, 'POST', '/v1/public/sports/portal/session', { body: { token: link.body.devLinkToken } });
    const pay = await call(app, 'POST', `/v1/public/sports/portal/instalments/${third.id}/pay`, { body: { portalToken: sess.body.portalToken } });
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    expect(pay.body.payment.id).not.toBe(third.paymentId);
  });

  it('card update in sandbox through a SetupIntent (guardian portal)', async () => {
    const email = `g2-${uid()}@example.com`;
    const r = await call(app, 'POST', `/v1/public/sports/programmes/${programme.id}/registrations`, { body: { guardian: { name: 'Gus', email }, participant: { name: 'Lou', dateOfBirth: '2016-05-05' }, relationship: 'parent', answers: { emergency_contact_name: 'Robin Grey', emergency_contact_phone: '+1 416 555 0199', photo_consent: true }, acceptRefundPolicy: true } });
    await call(app, 'POST', `/v1/public/payments/${r.body.payment.id}/sandbox-confirm`, { body: { outcome: 'succeeded' } });
    const link = await call(app, 'POST', '/v1/public/sports/portal/request-link', { body: { locationId: loc.id, email } });
    const sess = await call(app, 'POST', '/v1/public/sports/portal/session', { body: { token: link.body.devLinkToken } });
    const setup = await call(app, 'POST', '/v1/public/sports/portal/payment-method/setup', { body: { portalToken: sess.body.portalToken, locationId: loc.id } });
    expect(setup.status, JSON.stringify(setup.body)).toBe(201);
    expect(setup.body).toMatchObject({ sandbox: true, publishableKey: null });
    const done = await call(app, 'POST', `/v1/public/payments/setup/${setup.body.setupIntentId}/sandbox-complete`, { body: { paymentCustomerId: setup.body.paymentCustomerId, token: setup.body.sandboxToken } });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const card = await call(app, 'POST', '/v1/public/sports/portal/payment-method', { body: { portalToken: sess.body.portalToken, locationId: loc.id } });
    expect(card.body.card).toMatchObject({ brand: 'visa', last4: '4242' });
    expect(card.body.purposes).toContain('instalments');
    // Bad sandbox token is refused.
    expect((await call(app, 'POST', `/v1/public/payments/setup/${setup.body.setupIntentId}/sandbox-complete`, { body: { paymentCustomerId: setup.body.paymentCustomerId, token: 'x'.repeat(43) } })).status).toBe(404);
  });
});

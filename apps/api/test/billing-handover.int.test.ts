/**
 * Billing: mid-period handover of a location fee to a franchisee (prorated charge for the rest of HQ's period; Stripe
 * proration live, computed in the sandbox), the franchisee's own subscription status and next charge, the extra-brand
 * fee as a subscription item, and when a plan switch is charged (monthly ↔ annual: now).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { listPriceMinor } from '@bh/shared';
import type { Config } from '../src/config.ts';
import { billingInvoices, franchiseeBillingAccounts, ownerGroups, subscriptions } from '../src/db/schema/index.ts';
import { createPlatformBilling } from '../src/integrations/platform-billing.ts';
import { renderBillingEmail } from '../src/services/billing-emails.ts';
import { runBillingSweep } from '../src/services/billing.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid } from './helpers.ts';

const DAY = 86_400_000;
const quiet = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as never;

async function userAt(app: FastifyInstance, domain: string, name = 'Owner') {
  const email = `owner-${uid()}@${domain}`;
  const su = await call(app, 'POST', '/v1/auth/signup', { body: { name, email, password: 'correct horse battery staple', acceptTerms: true } });
  const v = await call(app, 'POST', '/v1/auth/verify-email', { body: { token: su.body.devVerificationToken } });
  return { token: v.body.accessToken as string, email, userId: su.body.user.id as string };
}

describe('live mid-period handover and extra brands (mocked Stripe)', () => {
  it('starts a franchisee share mid-period on HQ’s cycle with prorations, and invoices an added share at once', async () => {
    const create = vi.fn(async () => ({ id: 'sub_fr', status: 'active', items: { data: [{ current_period_end: 1_900_000_000 }] }, latest_invoice: { id: 'in_pr', status: 'paid', total: 3250, amount_paid: 3250, amount_due: 3250, currency: 'usd' } }));
    const update = vi.fn(async (id: string) => ({ id, status: 'active', items: { data: [] } }));
    const client = {
      subscriptions: { retrieve: vi.fn(async () => ({ items: { data: [{ id: 'si_a', price: { lookup_key: 'network_location_franchisee_100pct:usd:month:6500' } }] } })), update, create },
      prices: { list: vi.fn(async (p: { lookup_keys: string[] }) => ({ data: [{ id: `price_${p.lookup_keys[0]}` }] })), create: vi.fn() },
      products: { search: vi.fn(), create: vi.fn() },
      customers: { update: vi.fn() },
    };
    const billing = createPlatformBilling({ STRIPE_TAX_ENABLED: false } as Config, { client: client as unknown as Stripe, mode: 'live', publishableKey: 'pk_test' }, quiet);
    const anchor = new Date(Date.now() + 15 * DAY);
    const created = await billing.createSubscription({ customerId: 'cus_fr', paymentMethodId: 'pm_fr', currency: 'USD', interval: 'month', lines: [{ lookupKey: 'network_location_franchisee_100pct', productName: 'f', unitAmountMinor: 6500, quantity: 1 }], trialDays: null, trialFee: null, trialEnd: null, billingCycleAnchor: anchor, metadata: {}, idempotencyKey: 'k1' });
    const [cp] = create.mock.calls[0] as unknown as [Record<string, any>];
    expect(cp).toMatchObject({ billing_cycle_anchor: Math.floor(anchor.getTime() / 1000), proration_behavior: 'create_prorations' });
    expect(cp.trial_end).toBeUndefined();
    expect(created.latestInvoice).toMatchObject({ id: 'in_pr', total: 3250 });
    await billing.updateItems('sub_fr', { currency: 'USD', interval: 'month', lines: [{ lookupKey: 'network_location_franchisee_100pct', productName: 'f', unitAmountMinor: 6500, quantity: 2 }], prorate: true, invoiceNow: true, idempotencyKey: 'k2' });
    expect((update.mock.calls[0] as unknown as [string, Record<string, any>])[1].proration_behavior).toBe('always_invoice');
  });

  it('the sandbox computes the same prorated first charge', async () => {
    const billing = createPlatformBilling({ STRIPE_TAX_ENABLED: false } as Config, { client: null, mode: 'sandbox', publishableKey: null }, quiet);
    const s = await billing.createSubscription({ customerId: 'cus_sandbox_x', paymentMethodId: 'pm_sandbox_card_US', currency: 'USD', interval: 'month', lines: [{ lookupKey: 'x', productName: 'x', unitAmountMinor: 10_000, quantity: 1 }], trialDays: null, trialFee: null, billingCycleAnchor: new Date(Date.now() + 15 * DAY), metadata: {}, idempotencyKey: `k-${uid()}` });
    expect(s.status).toBe('active');
    expect(s.latestInvoice!.total).toBeGreaterThanOrEqual(4999);
    expect(s.latestInvoice!.total).toBeLessThanOrEqual(5000);
  });

  it('a monthly ↔ annual switch email says it was charged now', async () => {
    const m = await renderBillingEmail({ kind: 'plan_changed', business: 'Harbour', planName: 'Hosted', amount: { amountMinor: 209_000, currency: 'USD' }, interval: 'year', prorationNow: { amountMinor: 199_000, currency: 'USD' }, chargedNow: true, billingUrl: 'https://app/x' }, { name: 'Ana', locale: 'en' });
    expect(m.text).toContain('we charged $1,990.00 now');
    expect(m.text).not.toContain('next invoice');
  });
});

describe.skipIf(!hasDb)('mid-period handover, franchisee status, extra brands and plan switch timing (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });
  const b = (orgId: string) => `/v1/orgs/${orgId}/billing`;

  it('a fee handed to a franchisee mid-period is charged to them prorated now; their screen shows status, next charge and invoices', async () => {
    const o = await userAt(app, `ho-${uid()}.example`);
    const org = await createOrg(app, o.token, { country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/New_York' });
    const [group] = await app.ctx.db.insert(ownerGroups).values({ organizationId: org.id, name: 'Austin Franchise LLC' }).returning();
    const loc = (name: string, over: Record<string, unknown> = {}) => createLocation(app, o.token, org.id, { name, currency: 'USD', timeZone: 'America/Chicago', address: { line1: `${uid()} Congress`, city: 'Austin', country: 'US' }, ...over });
    for (const n of ['One', 'Two', 'Three']) await loc(n);
    await loc('Austin South', { ownerGroupId: group!.id });
    await call(app, 'POST', `${b(org.id)}/checkout`, { token: o.token, body: { plan: 'network', billingCountry: 'US' } });
    await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: o.token, body: { paymentMethodId: `pm_sandbox_card_US_${uid()}`, acceptTerms: true } });
    // HQ's plan is running: halfway through a monthly period.
    const [sub0] = await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
    await runBillingSweep(app.ctx, new Date(sub0!.trialEndsAt!.getTime() + 1000));
    const periodEnd = new Date(Date.now() + 15 * DAY);
    await app.ctx.db.update(subscriptions).set({ status: 'active', currentPeriodEnd: periodEnd }).where(eq(subscriptions.id, sub0!.id));

    // The franchisee sets up billing while HQ still pays: nothing to charge yet.
    const fo = await memberWithRole(app, o.token, org.id, 'franchise_owner', { kind: 'owner_group', id: group!.id }, 'Ana Franchisee');
    await call(app, 'POST', `/v1/orgs/${org.id}/franchisee-billing/setup`, { token: fo.token, body: { scopeKind: 'owner_group', scopeId: group!.id, billingCountry: 'US' } });
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/franchisee-billing/confirm`, { token: fo.token, body: { scopeKind: 'owner_group', scopeId: group!.id, paymentMethodId: `pm_sandbox_card_US_${uid()}` } })).body.status).toBe('active');
    let view = await call(app, 'GET', `/v1/orgs/${org.id}/franchisee-billing`, { token: fo.token });
    expect(view.body.accounts[0].subscription).toMatchObject({ status: 'none', nextChargeAt: null, nextCharge: { amount: 0, currency: 'USD' } });

    // Mid-period handover: the location's fee moves to the franchisee.
    expect((await call(app, 'PUT', `${b(org.id)}/payers`, { token: o.token, body: { scopeKind: 'owner_group', scopeId: group!.id, payer: 'franchisee' } })).status).toBe(200);
    const fee = listPriceMinor('USD', 'network');
    const acct = async () => (await app.ctx.db.select().from(franchiseeBillingAccounts).where(and(eq(franchiseeBillingAccounts.organizationId, org.id), eq(franchiseeBillingAccounts.scopeId, group!.id))))[0]!;
    let a = await acct();
    expect(a.subscriptionStatus).toBe('active');
    expect(a.currentPeriodEnd!.getTime()).toBe(periodEnd.getTime());
    const invs = async () => app.ctx.db.select().from(billingInvoices).where(and(eq(billingInvoices.organizationId, org.id), eq(billingInvoices.franchiseeAccountId, a.id)));
    let prorated = await invs();
    expect(prorated).toHaveLength(1);
    expect(prorated[0]).toMatchObject({ payer: 'franchisee', kind: 'franchisee_fee', currency: 'USD', status: 'paid' });
    expect(prorated[0]!.totalMinor).toBeGreaterThanOrEqual(Math.floor(fee * 0.49));
    expect(prorated[0]!.totalMinor).toBeLessThanOrEqual(Math.ceil(fee * 0.5));

    view = await call(app, 'GET', `/v1/orgs/${org.id}/franchisee-billing`, { token: fo.token });
    expect(view.body.accounts[0].subscription).toMatchObject({ status: 'active', interval: 'month', nextChargeAt: periodEnd.toISOString(), nextCharge: { amount: fee, currency: 'USD' }, startsWithHqPlan: false });
    expect(view.body.invoices[0]).toMatchObject({ kind: 'franchisee_fee', total: { amount: prorated[0]!.totalMinor, currency: 'USD' } });

    // A second location handed over later in the period is charged for its remaining share at once too.
    await loc('Austin North', { ownerGroupId: group!.id });
    a = await acct();
    expect(a.subscriptionLines[0]!.quantity).toBe(2);
    prorated = await invs();
    expect(prorated).toHaveLength(2);
    view = await call(app, 'GET', `/v1/orgs/${org.id}/franchisee-billing`, { token: fo.token });
    expect(view.body.accounts[0].subscription.nextCharge.amount).toBe(2 * fee);

    // At renewal the franchisee is billed the full share with HQ and the next charge moves on.
    await runBillingSweep(app.ctx, new Date(periodEnd.getTime() + 1000));
    a = await acct();
    expect(a.currentPeriodEnd!.getTime()).toBe(periodEnd.getTime() + 30 * DAY);
    expect((await invs()).some((i) => i.totalMinor === 2 * fee)).toBe(true);
  });

  it('each brand beyond the first is a subscription item at the extra-brand fee, in the quote and the charge', async () => {
    const o = await userAt(app, `br-${uid()}.example`);
    const org = await createOrg(app, o.token, { country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/New_York' });
    await createLocation(app, o.token, org.id, { currency: 'USD', timeZone: 'America/New_York', address: { line1: '1 Main', city: 'Boston', country: 'US' } });
    await call(app, 'POST', `${b(org.id)}/checkout`, { token: o.token, body: { plan: 'network', billingCountry: 'US' } });
    await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: o.token, body: { paymentMethodId: `pm_sandbox_card_US_${uid()}`, acceptTerms: true } });
    const extra = listPriceMinor('USD', 'extraBrand');
    const lines = async () => (await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id)))[0]!.syncedLines;
    expect((await lines()).some((l) => l.lookupKey === 'extra_brand')).toBe(false);

    const second = await call(app, 'POST', `/v1/orgs/${org.id}/brands`, { token: o.token, body: { name: `Second ${uid()}` } });
    await call(app, 'POST', `/v1/orgs/${org.id}/brands`, { token: o.token, body: { name: `Third ${uid()}` } });
    expect((await lines()).find((l) => l.lookupKey === 'extra_brand')).toMatchObject({ unitAmountMinor: extra, quantity: 2, productName: 'BranchHarbor extra brand' });
    const view = await call(app, 'GET', b(org.id), { token: o.token });
    expect(view.body.quote.lines.find((l: any) => l.kind === 'brand')).toEqual({ kind: 'brand', quantity: 2, unitMinor: extra, amountMinor: 2 * extra });
    expect(view.body.hqTotal.amount).toBe(listPriceMinor('USD', 'platform') + 2 * extra);
    const quote = await call(app, 'GET', `${b(org.id)}/quote?plan=hosted&billingCountry=US&locations=2`, { token: o.token });
    expect(quote.body.quote.lines.find((l: any) => l.kind === 'brand').quantity).toBe(2);

    // At renewal the brand line is part of the charge.
    const [sub] = await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
    await runBillingSweep(app.ctx, new Date(sub!.trialEndsAt!.getTime() + 1000));
    const [inv] = await app.ctx.db.select().from(billingInvoices).where(and(eq(billingInvoices.organizationId, org.id), eq(billingInvoices.kind, 'subscription')));
    expect(inv!.totalMinor).toBe(listPriceMinor('USD', 'platform') + 2 * extra);
    expect(inv!.lines.find((l) => l.description === 'brand')).toMatchObject({ quantity: 2, amountMinor: 2 * extra });

    // Archiving a brand takes it off.
    expect((await call(app, 'DELETE', `/v1/orgs/${org.id}/brands/${second.body.id}`, { token: o.token })).status).toBe(200);
    expect((await lines()).find((l) => l.lookupKey === 'extra_brand')!.quantity).toBe(1);
  });

  it('a plan switch says when it is charged: monthly ↔ annual now, same period on the next invoice', async () => {
    const o = await userAt(app, `pc-${uid()}.example`);
    const org = await createOrg(app, o.token, { country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/New_York' });
    for (let i = 0; i < 2; i++) await createLocation(app, o.token, org.id, { currency: 'USD', timeZone: 'America/New_York', address: { line1: `${i} Main`, city: 'Boston', country: 'US' } });
    await call(app, 'POST', `${b(org.id)}/checkout`, { token: o.token, body: { plan: 'hosted', billingCountry: 'US' } });
    await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: o.token, body: { paymentMethodId: `pm_sandbox_card_US_${uid()}`, acceptTerms: true } });
    expect((await call(app, 'GET', `${b(org.id)}/change/preview?plan=hosted&interval=year`, { token: o.token })).body.charge).toBe('none');
    const [sub] = await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
    await runBillingSweep(app.ctx, new Date(sub!.trialEndsAt!.getTime() + 1000));
    await app.ctx.db.update(subscriptions).set({ currentPeriodEnd: new Date(Date.now() + 15 * DAY) }).where(eq(subscriptions.id, sub!.id));
    expect((await call(app, 'GET', `${b(org.id)}/change/preview?plan=hosted&interval=year`, { token: o.token })).body).toMatchObject({ charge: 'now', effective: 'now' });
    expect((await call(app, 'GET', `${b(org.id)}/change/preview?plan=network&interval=month`, { token: o.token })).body.charge).toBe('next_invoice');
    const changed = await call(app, 'POST', `${b(org.id)}/change`, { token: o.token, body: { plan: 'hosted', interval: 'year' } });
    expect(changed.status).toBe(200);
    expect(app.ctx.mailer.outbox.filter((m) => m.to === o.email).at(-1)!.text).toContain('now, less the unused part of your previous period');
  });
});

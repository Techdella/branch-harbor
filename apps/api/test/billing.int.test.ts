/**
 * BranchHarbor plan billing (sandbox Stripe): the paid 14-day trial, the billing-country lock at checkout and in the
 * webhook, one trial per business/card/email domain, trial reminders and conversion, cancellation, billing-country
 * change, who pays each network location's fee, franchisee billing, enforcement without a plan, and the data export.
 */
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { listPriceMinor } from '@bh/shared';
import { auditEvents, dataExports, ownerGroups, subscriptions } from '../src/db/schema/index.ts';
import { signStripePayload } from '../src/integrations/payments.ts';
import { runBillingSweep } from '../src/services/billing.ts';
import { WEBHOOK_SECRET, call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid } from './helpers.ts';

const DAY = 86_400_000;

/** A verified user at a given email domain (one paid trial per business email domain). */
async function userAt(app: FastifyInstance, domain: string, name = 'Owner') {
  const email = `owner-${uid()}@${domain}`;
  const su = await call(app, 'POST', '/v1/auth/signup', { body: { name, email, password: 'correct horse battery staple', acceptTerms: true } });
  const v = await call(app, 'POST', '/v1/auth/verify-email', { body: { token: su.body.devVerificationToken } });
  return { token: v.body.accessToken as string, email };
}

/** Reads the entries of a ZIP produced by the export (deflate, no data descriptors). */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extra;
    out[name] = inflateRawSync(buf.subarray(start, start + size)).toString('utf8');
    i = start + size;
  }
  return out;
}

describe.skipIf(!hasDb)('BranchHarbor billing: paid trial, country lock, payers, export', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });
  afterAll(async () => {
    await app?.close();
  });
  const b = (orgId: string) => `/v1/orgs/${orgId}/billing`;

  it('a new business has no free trial: it starts a 14-day trial that costs the local trial fee', async () => {
    const owner = await userAt(app, `uk-${uid()}.example`);
    const org = await createOrg(app, owner.token, { country: 'GB', defaultCurrency: 'GBP', defaultTimeZone: 'Europe/London' });
    await createLocation(app, owner.token, org.id, { currency: 'GBP', timeZone: 'Europe/London', address: { line1: '1 High St', city: 'London', country: 'GB' } });

    const view = await call(app, 'GET', b(org.id), { token: owner.token });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ status: 'checkout_required', plan: 'network', currency: 'GBP', priceList: 'GBP', tier: 'A', trial: { days: 14, fee: { amount: 399, currency: 'GBP' }, endsAt: null } });
    expect(view.body.trialEligibility).toEqual({ eligible: true, reason: null });
    expect(view.body.terms).toMatchObject({ trialDays: 14, reminderDays: [3, 1], cancellationFee: false, freeDataExport: true, taxExclusive: true });

    // The client cannot pick a cheaper currency for a GB billing address.
    const wrong = await call(app, 'POST', `${b(org.id)}/checkout`, { token: owner.token, body: { plan: 'network', billingCountry: 'GB', currency: 'INR' } });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('currency_mismatch');

    // Quote from the billing country: Network = platform fee incl. 3 locations.
    const start = await call(app, 'POST', `${b(org.id)}/checkout`, { token: owner.token, body: { plan: 'network', billingCountry: 'gb' } });
    expect(start.status).toBe(200);
    expect(start.body.quote).toMatchObject({ priceList: 'GBP', currency: 'GBP', includedLocations: 3, totalMinor: listPriceMinor('GBP', 'platform'), trialFeeMinor: 399 });
    expect(start.body.trial).toMatchObject({ eligible: true, days: 14, fee: { amount: 399, currency: 'GBP' } });
    expect(start.body.setup.mode).toBe('sandbox');

    // Card issued in the US for a GB billing country: refused with a clear message.
    const us = await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: owner.token, body: { paymentMethodId: 'pm_sandbox_card_US_x1', acceptTerms: true } });
    expect(us.status).toBe(409);
    expect(us.body.error.code).toBe('card_country_mismatch');
    expect(us.body.error.message).toMatch(/issued in United States.*billing country is United Kingdom/);
    // A tax ID from another country does not help either.
    const badTax = await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: owner.token, body: { paymentMethodId: 'pm_sandbox_card_US_x1', taxId: 'DE123456789', acceptTerms: true } });
    expect(badTax.status).toBe(400);
    expect(badTax.body.error.code).toBe('invalid_tax_id');
    // Terms must be accepted.
    expect((await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: owner.token, body: { paymentMethodId: 'pm_sandbox_card_GB_g1' } })).status).toBe(400);

    const ok = await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: owner.token, body: { paymentMethodId: 'pm_sandbox_card_GB_g1', acceptTerms: true } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'trialing', trialUsed: false, evidence: 'card' });
    const endsAt = Date.parse(ok.body.trialEndsAt);
    expect(Math.abs(endsAt - (Date.now() + 14 * DAY))).toBeLessThan(60_000);
    expect(ok.body.billing).toMatchObject({ status: 'trialing', billingCountry: 'GB', countryLocked: true, card: { last4: '4242', country: 'GB' }, trial: { daysLeft: 14 } });
    expect(ok.body.billing.invoices).toHaveLength(1);
    expect(ok.body.billing.invoices[0]).toMatchObject({ kind: 'trial_fee', status: 'paid', total: { amount: 399, currency: 'GBP' } });
    const mail = app.ctx.mailer.outbox.filter((m) => m.to === owner.email);
    expect(mail.at(-1)!.subject).toMatch(/14-day BranchHarbor trial has started/);
    expect(mail.at(-1)!.text).toMatch(/starts automatically on .* unless you cancel/);

    // A second checkout is refused.
    expect((await call(app, 'POST', `${b(org.id)}/checkout`, { token: owner.token, body: { plan: 'network', billingCountry: 'GB' } })).body.error.code).toBe('already_subscribed');

    // Reminders 3 days and 1 day before, then the plan starts automatically.
    const [sub] = await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
    const end = sub!.trialEndsAt!.getTime();
    await runBillingSweep(app.ctx, new Date(end - 2.5 * DAY));
    await runBillingSweep(app.ctx, new Date(end - 2.4 * DAY)); // not sent twice
    await runBillingSweep(app.ctx, new Date(end - 0.5 * DAY));
    const reminders = app.ctx.mailer.outbox.filter((m) => m.to === owner.email && m.tag === 'billing-trial-reminder');
    expect(reminders.map((m) => m.subject)).toEqual([expect.stringMatching(/ends in 3 days/), expect.stringMatching(/ends tomorrow/)]);
    expect(reminders[0]!.text).toMatch(/£239\.00 per month/);
    await runBillingSweep(app.ctx, new Date(end + 60_000));
    const after = await call(app, 'GET', b(org.id), { token: owner.token });
    expect(after.body.status).toBe('active');
    expect(after.body.invoices.map((i: any) => i.kind)).toEqual(['subscription', 'trial_fee']);
    expect(after.body.invoices[0].total).toEqual({ amount: 23_900, currency: 'GBP' });
  });

  it('one paid trial per card, per business email domain; a later checkout starts the plan straight away', async () => {
    const domain = `acme-${uid()}.example`;
    const a = await userAt(app, domain);
    const orgA = await createOrg(app, a.token, { country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/New_York', model: 'independent', firstLocation: { address: { line1: '1 Main', city: 'Austin', country: 'US' } } });
    expect((await call(app, 'POST', `${b(orgA.id)}/checkout`, { token: a.token, body: { plan: 'network', billingCountry: 'US' } })).status).toBe(400); // independents are on Solo
    expect((await call(app, 'POST', `${b(orgA.id)}/checkout`, { token: a.token, body: { plan: 'solo', billingCountry: 'US' } })).body.trial.fee).toEqual({ amount: 499, currency: 'USD' });
    const fp = uid();
    expect((await call(app, 'POST', `${b(orgA.id)}/checkout/confirm`, { token: a.token, body: { paymentMethodId: `pm_sandbox_card_US_${fp}`, acceptTerms: true } })).body.status).toBe('trialing');

    // Same business email domain, different card → no second trial.
    const a2 = await userAt(app, domain);
    const orgA2 = await createOrg(app, a2.token, { country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/New_York' });
    const s2 = await call(app, 'POST', `${b(orgA2.id)}/checkout`, { token: a2.token, body: { plan: 'hosted', billingCountry: 'US', locations: 2 } });
    expect(s2.body.trial).toMatchObject({ eligible: false, reason: 'email_domain_used' });
    const c2 = await call(app, 'POST', `${b(orgA2.id)}/checkout/confirm`, { token: a2.token, body: { paymentMethodId: `pm_sandbox_card_US_${uid()}`, acceptTerms: true } });
    expect(c2.body).toMatchObject({ status: 'active', trialUsed: true, trialRefusedReason: 'email_domain_used' });
    expect(c2.body.billing.invoices[0]).toMatchObject({ kind: 'subscription', total: { amount: 2 * 5900, currency: 'USD' } });

    // Same card, another domain → no second trial.
    const c = await userAt(app, `other-${uid()}.example`);
    const orgC = await createOrg(app, c.token, { country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/New_York' });
    await call(app, 'POST', `${b(orgC.id)}/checkout`, { token: c.token, body: { plan: 'connector', billingCountry: 'US' } });
    const cc = await call(app, 'POST', `${b(orgC.id)}/checkout/confirm`, { token: c.token, body: { paymentMethodId: `pm_sandbox_card_US_${fp}`, acceptTerms: true } });
    expect(cc.body).toMatchObject({ status: 'active', trialRefusedReason: 'card_used' });

    // A declined card leaves the business without a plan.
    const d = await userAt(app, `decl-${uid()}.example`);
    const orgD = await createOrg(app, d.token, { country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/New_York' });
    await call(app, 'POST', `${b(orgD.id)}/checkout`, { token: d.token, body: { plan: 'connector', billingCountry: 'US' } });
    const declined = await call(app, 'POST', `${b(orgD.id)}/checkout/confirm`, { token: d.token, body: { paymentMethodId: 'pm_sandbox_decline', acceptTerms: true } });
    expect(declined.status).toBe(402);
  });

  it('a foreign card is accepted with a tax ID from the billing country; cancelling during the trial ends it with no further charge', async () => {
    const o = await userAt(app, `fr-${uid()}.example`);
    const org = await createOrg(app, o.token, { country: 'FR', defaultCurrency: 'EUR', defaultTimeZone: 'Europe/Paris' });
    await call(app, 'POST', `${b(org.id)}/checkout`, { token: o.token, body: { plan: 'hosted', billingCountry: 'FR' } });
    const r = await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: o.token, body: { paymentMethodId: `pm_sandbox_card_DE_${uid()}`, taxId: 'FR40303265045', acceptTerms: true } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'trialing', evidence: 'tax_id' });
    expect(r.body.billing.invoices[0].total).toEqual({ amount: 449, currency: 'EUR' });

    const cancel = await call(app, 'POST', `${b(org.id)}/cancel`, { token: o.token, body: { reason: 'Not now' } });
    expect(cancel.body.cancelAtPeriodEnd).toBe(true);
    // No reminders once cancelled; the trial simply ends.
    const [sub] = await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
    await runBillingSweep(app.ctx, new Date(sub!.trialEndsAt!.getTime() - DAY / 2));
    expect(app.ctx.mailer.outbox.some((m) => m.to === o.email && m.tag === 'billing-trial-reminder')).toBe(false);
    await runBillingSweep(app.ctx, new Date(sub!.trialEndsAt!.getTime() + 1000));
    const v = await call(app, 'GET', b(org.id), { token: o.token });
    expect(v.body.status).toBe('canceled');
    expect(v.body.invoices).toHaveLength(1);
  });

  it('enforcement: without a paid trial the business is read-only; billing and export stay open', async () => {
    const enforced = await makeApp({}, { BILLING_ENFORCE: 'true' });
    try {
      const o = await userAt(enforced, `enf-${uid()}.example`);
      const org = await createOrg(enforced, o.token, { country: 'NG', defaultCurrency: 'NGN', defaultTimeZone: 'Africa/Lagos' });
      const blocked = await call(enforced, 'POST', `/v1/orgs/${org.id}/locations`, { token: o.token, body: { name: 'Ikeja', code: 'IKJ', address: { line1: '1 Allen Ave', city: 'Lagos', country: 'NG' }, timeZone: 'Africa/Lagos', currency: 'NGN' } });
      expect(blocked.status).toBe(402);
      expect(blocked.body.error.code).toBe('plan_required');
      expect((await call(enforced, 'GET', `/v1/orgs/${org.id}/locations`, { token: o.token })).status).toBe(200);
      const st = await call(enforced, 'POST', `/v1/orgs/${org.id}/billing/checkout`, { token: o.token, body: { plan: 'network', billingCountry: 'NG' } });
      expect(st.body.trial.fee).toEqual({ amount: 250_000, currency: 'NGN' });
      expect((await call(enforced, 'POST', `/v1/orgs/${org.id}/billing/checkout/confirm`, { token: o.token, body: { paymentMethodId: `pm_sandbox_card_NG_${uid()}`, acceptTerms: true } })).body.status).toBe('trialing');
      const created = await call(enforced, 'POST', `/v1/orgs/${org.id}/locations`, { token: o.token, body: { name: 'Ikeja', code: 'IKJ', address: { line1: '1 Allen Ave', city: 'Lagos', country: 'NG' }, timeZone: 'Africa/Lagos', currency: 'NGN' } });
      expect(created.status).toBe(201);
    } finally {
      await enforced.close();
    }
  });

  it('network: platform fee covers 3 locations; HQ chooses who pays each further location; franchisees see and pay their share', async () => {
    const o = await userAt(app, `net-${uid()}.example`);
    const org = await createOrg(app, o.token, { country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/New_York' });
    const [ga] = await app.ctx.db.insert(ownerGroups).values({ organizationId: org.id, name: 'Lagos Franchise Ltd' }).returning();
    const locs: Record<string, any>[] = [];
    for (let i = 0; i < 6; i++) {
      locs.push(await createLocation(app, o.token, org.id, { name: `Store ${i + 1}`, currency: 'USD', timeZone: 'America/New_York', address: { line1: `${i} Main`, city: 'Boston', country: 'US' }, ...(i >= 4 ? { ownerGroupId: ga!.id } : {}) }));
    }
    await call(app, 'POST', `${b(org.id)}/checkout`, { token: o.token, body: { plan: 'network', billingCountry: 'US' } });
    expect((await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: o.token, body: { paymentMethodId: `pm_sandbox_card_US_${uid()}`, acceptTerms: true } })).body.status).toBe('trialing');

    // Store 4 (HQ-owned) franchisee-paid; the owner group (stores 5–6) split 40 % franchisee.
    expect((await call(app, 'PUT', `${b(org.id)}/payers`, { token: o.token, body: { scopeKind: 'location', scopeId: locs[3]!.id, payer: 'franchisee' } })).status).toBe(200);
    expect((await call(app, 'PUT', `${b(org.id)}/payers`, { token: o.token, body: { scopeKind: 'owner_group', scopeId: ga!.id, payer: 'split' } })).status).toBe(400);
    expect((await call(app, 'PUT', `${b(org.id)}/payers`, { token: o.token, body: { scopeKind: 'owner_group', scopeId: ga!.id, payer: 'split', franchiseePercent: 40 } })).status).toBe(200);
    const v = await call(app, 'GET', b(org.id), { token: o.token });
    expect(v.body.quote).toMatchObject({ totalMinor: 29_900 + 3 * 8900, includedLocations: 3 });
    expect(v.body.platformFee).toEqual({ amount: 29_900, currency: 'USD', includedLocations: 3 });
    const rows = v.body.locations as any[];
    expect(rows.filter((r) => r.included)).toHaveLength(3);
    expect(rows[3]).toMatchObject({ payer: 'franchisee', source: 'location', hqMinor: 0, franchiseeMinor: 8900 });
    expect(rows[4]).toMatchObject({ payer: 'split', source: 'owner_group', franchiseePercent: 40, hqMinor: 5340, franchiseeMinor: 3560 });
    expect(v.body.hqTotal).toEqual({ amount: 29_900 + 3 * 8900 - 8900 - 2 * 3560, currency: 'USD', interval: 'month' });

    // The franchise owner sees only their locations and pays in their own billing country (NG price list).
    const fo = await memberWithRole(app, o.token, org.id, 'franchise_owner', { kind: 'owner_group', id: ga!.id }, 'Femi Franchisee');
    expect((await call(app, 'GET', b(org.id), { token: fo.token })).status).toBe(403);
    const fv = await call(app, 'GET', `/v1/orgs/${org.id}/franchisee-billing`, { token: fo.token });
    expect(fv.status).toBe(200);
    expect(fv.body.locations.map((l: any) => l.name)).toEqual(['Store 5', 'Store 6']);
    expect(fv.body.locations[0]).toMatchObject({ payer: 'split', franchiseePercent: 40, amount: { amount: 3560, currency: 'USD' } });
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/franchisee-billing/setup`, { token: fo.token, body: { scopeKind: 'location', scopeId: locs[0]!.id, billingCountry: 'NG' } })).status).toBe(403);
    const setup = await call(app, 'POST', `/v1/orgs/${org.id}/franchisee-billing/setup`, { token: fo.token, body: { scopeKind: 'owner_group', scopeId: ga!.id, billingCountry: 'NG' } });
    expect(setup.body).toMatchObject({ priceList: 'NGN', currency: 'NGN' });
    const bad = await call(app, 'POST', `/v1/orgs/${org.id}/franchisee-billing/confirm`, { token: fo.token, body: { scopeKind: 'owner_group', scopeId: ga!.id, paymentMethodId: 'pm_sandbox_card_GB_z' } });
    expect(bad.body.error.code).toBe('card_country_mismatch');
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/franchisee-billing/confirm`, { token: fo.token, body: { scopeKind: 'owner_group', scopeId: ga!.id, paymentMethodId: `pm_sandbox_card_NG_${uid()}` } })).body.status).toBe('active');
    const fv2 = await call(app, 'GET', `/v1/orgs/${org.id}/franchisee-billing`, { token: fo.token });
    expect(fv2.body.locations[0].amount).toEqual({ amount: Math.round(listPriceMinor('NGN', 'network') * 0.4), currency: 'NGN' });

    // When the plan starts, HQ and the franchisee are each invoiced their part.
    const [sub] = await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
    await runBillingSweep(app.ctx, new Date(sub!.trialEndsAt!.getTime() + 1000));
    const hq = await call(app, 'GET', b(org.id), { token: o.token });
    expect(hq.body.invoices[0]).toMatchObject({ kind: 'subscription', payer: 'hq', total: { amount: hq.body.hqTotal.amount, currency: 'USD' } });
    const fv3 = await call(app, 'GET', `/v1/orgs/${org.id}/franchisee-billing`, { token: fo.token });
    expect(fv3.body.invoices[0]).toMatchObject({ kind: 'franchisee_fee', payer: 'franchisee', total: { amount: 2 * Math.round(listPriceMinor('NGN', 'network') * 0.4), currency: 'NGN' } });
  });

  it('billing country change needs a matching card and applies from the next cycle', async () => {
    const o = await userAt(app, `move-${uid()}.example`);
    const org = await createOrg(app, o.token, { country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/New_York' });
    await call(app, 'POST', `${b(org.id)}/checkout`, { token: o.token, body: { plan: 'hosted', billingCountry: 'US' } });
    await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: o.token, body: { paymentMethodId: `pm_sandbox_card_US_${uid()}`, acceptTerms: true } });
    const start = await call(app, 'POST', `${b(org.id)}/country`, { token: o.token, body: { billingCountry: 'NG' } });
    expect(start.body.quote).toMatchObject({ currency: 'NGN', priceList: 'NGN' });
    expect((await call(app, 'POST', `${b(org.id)}/country/confirm`, { token: o.token, body: { paymentMethodId: 'pm_sandbox_card_US_q' } })).body.error.code).toBe('card_country_mismatch');
    const ok = await call(app, 'POST', `${b(org.id)}/country/confirm`, { token: o.token, body: { paymentMethodId: `pm_sandbox_card_NG_${uid()}` } });
    expect(ok.body.pendingChange).toMatchObject({ status: 'scheduled', billingCountry: 'NG' });
    let v = await call(app, 'GET', b(org.id), { token: o.token });
    expect(v.body).toMatchObject({ billingCountry: 'US', currency: 'USD' }); // unchanged until the next cycle
    const [sub] = await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
    await runBillingSweep(app.ctx, new Date(sub!.currentPeriodEnd!.getTime() + 1000));
    v = await call(app, 'GET', b(org.id), { token: o.token });
    expect(v.body).toMatchObject({ status: 'active', billingCountry: 'NG', currency: 'NGN', priceList: 'NGN', pendingChange: null, card: { country: 'NG' } });
  });

  it('the webhook re-checks the country lock and cancels a subscription charged in another currency', async () => {
    const o = await userAt(app, `wh-${uid()}.example`);
    const org = await createOrg(app, o.token, { country: 'GB', defaultCurrency: 'GBP', defaultTimeZone: 'Europe/London' });
    await call(app, 'POST', `${b(org.id)}/checkout`, { token: o.token, body: { plan: 'hosted', billingCountry: 'GB' } });
    await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: o.token, body: { paymentMethodId: `pm_sandbox_card_GB_${uid()}`, acceptTerms: true } });
    const [sub] = await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
    const post = (event: object) => {
      const payload = JSON.stringify(event);
      return app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload, headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(payload, WEBHOOK_SECRET) } });
    };
    const ev = (status: string, currency: string) => ({ id: `evt_${uid()}`, object: 'event', type: 'customer.subscription.updated', data: { object: { id: sub!.stripeSubscriptionId, object: 'subscription', status, currency, cancel_at_period_end: false } } });
    expect((await post(ev('active', 'gbp'))).statusCode).toBe(200);
    expect((await call(app, 'GET', b(org.id), { token: o.token })).body.status).toBe('active');
    expect((await post(ev('active', 'inr'))).statusCode).toBe(200);
    expect((await call(app, 'GET', b(org.id), { token: o.token })).body.status).toBe('canceled');
    const audits = await app.ctx.db.select().from(auditEvents).where(eq(auditEvents.organizationId, org.id));
    expect(audits.find((a) => a.action === 'billing.country_lock_violation')?.metadata).toMatchObject({ reason: 'currency_mismatch', billingCountry: 'GB' });
  });

  it('free data export: owner only, ZIP of CSVs scoped to the business, 7-day emailed link', async () => {
    // Own app instance: sign-up is rate limited per client.
    const app = await makeApp();
    try {
      await exportFlow(app);
    } finally {
      await app.close();
    }
  });
});

async function exportFlow(app: FastifyInstance) {
  {
    const o = await userAt(app, `exp-${uid()}.example`);
    const org = await createOrg(app, o.token, { country: 'GB', defaultCurrency: 'GBP', defaultTimeZone: 'Europe/London' });
    const other = await createOrg(app, o.token, { country: 'GB', defaultCurrency: 'GBP', defaultTimeZone: 'Europe/London' });
    await createLocation(app, o.token, org.id, { name: 'Camden, "North"', currency: 'GBP', timeZone: 'Europe/London', address: { line1: '1 High St', city: 'London', country: 'GB' } });
    await createLocation(app, o.token, other.id, { name: 'Other Business Shop', currency: 'GBP', timeZone: 'Europe/London', address: { line1: '2 High St', city: 'Leeds', country: 'GB' } });
    const staff = await memberWithRole(app, o.token, org.id, 'hq_admin', { kind: 'organization', id: org.id });
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/exports`, { token: staff.token })).status).toBe(403);

    const req = await call(app, 'POST', `/v1/orgs/${org.id}/exports`, { token: o.token });
    expect(req.status).toBe(202);
    await app.ctx.jobs.drain();
    const list = await call(app, 'GET', `/v1/orgs/${org.id}/exports`, { token: o.token });
    const ex = list.body.items[0];
    expect(ex).toMatchObject({ id: req.body.id, status: 'ready' });
    expect(Date.parse(ex.expiresAt) - Date.now()).toBeGreaterThan(6.9 * DAY);
    const names = ex.files.map((f: any) => f.name);
    for (const f of ['organization.csv', 'people.csv', 'locations.csv', 'customers.csv', 'leads.csv', 'class_bookings.csv', 'orders.csv', 'invoices.csv', 'branchharbor_invoices.csv']) expect(names).toContain(f);

    const mail = app.ctx.mailer.outbox.filter((m) => m.to === o.email && m.tag === 'data-export').at(-1)!;
    const link = /\/v1\/exports\/[0-9a-f-]+\/download\?token=\S+/.exec(mail.text)![0];
    const dl = await app.inject({ method: 'GET', url: link });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    const files = unzip(dl.rawPayload);
    expect(files['README.txt']).toMatch(/BranchHarbor data export/);
    expect(files['locations.csv']).toContain('"Camden, ""North"""');
    expect(files['locations.csv']).not.toContain('Other Business Shop');
    expect(files['people.csv']).toContain(o.email);
    expect(files['people.csv']).not.toMatch(/password/i);

    // Wrong token → 404; expired → 410; owner download from Settings works.
    expect((await app.inject({ method: 'GET', url: link.replace(/token=.*/, 'token=wrong-token-123') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/orgs/${org.id}/exports/${ex.id}/download`, headers: { authorization: `Bearer ${o.token}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/orgs/${other.id}/exports/${ex.id}/download`, headers: { authorization: `Bearer ${o.token}` } })).statusCode).toBe(404);
    await app.ctx.db.update(dataExports).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(dataExports.id, ex.id));
    expect((await app.inject({ method: 'GET', url: link })).statusCode).toBe(410);
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/exports`, { token: o.token })).body.items[0].status).toBe('expired');
  }
}

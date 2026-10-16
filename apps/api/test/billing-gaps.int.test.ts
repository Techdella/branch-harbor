/**
 * Billing gaps: live franchisee charging (a subscription per franchisee billing account in its own currency, quantities
 * that follow the network, trial-to-plan conversion and payment failures by webhook), change card / change plan with
 * proration, and billing emails in the recipient's language. Sandbox fakes for the API paths; a mocked Stripe client for
 * the live item updates.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { listPriceMinor } from '@bh/shared';
import type { Config } from '../src/config.ts';
import { auditEvents, franchiseeBillingAccounts, locations, ownerGroups, subscriptions, users } from '../src/db/schema/index.ts';
import { createPlatformBilling } from '../src/integrations/platform-billing.ts';
import { signStripePayload } from '../src/integrations/payments.ts';
import { renderBillingEmail } from '../src/services/billing-emails.ts';
import { runBillingSweep } from '../src/services/billing.ts';
import { WEBHOOK_SECRET, call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid } from './helpers.ts';

const DAY = 86_400_000;
const quiet = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as never;

async function userAt(app: FastifyInstance, domain: string, name = 'Owner') {
  const email = `owner-${uid()}@${domain}`;
  const su = await call(app, 'POST', '/v1/auth/signup', { body: { name, email, password: 'correct horse battery staple', acceptTerms: true } });
  const v = await call(app, 'POST', '/v1/auth/verify-email', { body: { token: su.body.devVerificationToken } });
  return { token: v.body.accessToken as string, email, userId: su.body.user.id as string };
}

describe('billing emails in the recipient’s language', () => {
  it('renders every billing email in the five app locales, with local money and dates; other locales read English', async () => {
    const base = { business: 'Harbour Fitness', billingUrl: 'https://app.example/settings#billing' };
    const fr = await renderBillingEmail({ kind: 'trial_started', ...base, trialFee: { amountMinor: 449, currency: 'EUR' }, planName: 'Network', amount: { amountMinor: 27_900, currency: 'EUR' }, interval: 'month', startsOn: new Date('2026-11-01T00:00:00Z'), taxAdded: true }, { name: 'Élodie', locale: 'fr' });
    expect(fr.subject).toBe('Votre essai BranchHarbor de 14 jours a commencé');
    expect(fr.text).toMatch(/Bonjour Élodie/);
    expect(fr.text).toMatch(/4,49\s€/);
    expect(fr.text).toMatch(/1 novembre 2026/);
    expect(fr.html).toContain('Ouvrir Paramètres → Facturation');
    const de = await renderBillingEmail({ kind: 'payment_failed', ...base, amount: { amountMinor: 8300, currency: 'EUR' } }, { name: 'Jonas', locale: 'de-AT' });
    expect(de.subject).toBe('Wir konnten Ihre BranchHarbor-Zahlung nicht einziehen');
    const pt = await renderBillingEmail({ kind: 'trial_reminder', ...base, days: 1, planName: 'Hosted', amount: { amountMinor: 20_900, currency: 'BRL' }, interval: 'month', startsOn: new Date('2026-11-01T00:00:00Z'), taxAdded: false, last4: '4242' }, { name: 'Ana', locale: 'pt-BR' });
    expect(pt.subject).toMatch(/termina amanhã/);
    expect(pt.text).toMatch(/R\$\s209,00/);
    const es = await renderBillingEmail({ kind: 'export_ready', business: 'Harbour', files: 12, sizeKb: 40, expiresOn: new Date('2026-11-01T00:00:00Z'), link: 'https://api.example/v1/exports/x/download?token=abc' }, { name: 'Luis', locale: 'es' });
    expect(es.text).toContain('https://api.example/v1/exports/x/download?token=abc');
    expect(es.subject).toBe('Tu exportación de datos de BranchHarbor está lista');
    const it = await renderBillingEmail({ kind: 'trial_converted', ...base, planName: 'Solo' }, { name: 'Gianni', locale: 'it' });
    expect(it.locale).toBe('en');
    expect(it.subject).toBe('Your BranchHarbor plan has started');
  });
});

describe('live subscription item updates (mocked Stripe)', () => {
  it('updates items by lookup key, removes missing ones, prorates only when asked, and aligns a franchisee start with HQ', async () => {
    const update = vi.fn(async (id: string) => ({ id, status: 'active', items: { data: [] } }));
    const create = vi.fn(async () => ({ id: 'sub_fr', status: 'trialing', trial_end: 1_800_000_000, items: { data: [{ current_period_end: 1_800_000_000 }] } }));
    const client = {
      subscriptions: {
        retrieve: vi.fn(async () => ({ items: { data: [{ id: 'si_platform', price: { lookup_key: 'network_platform:usd:month:29900' } }, { id: 'si_loc', price: { lookup_key: 'network_location:usd:month:8900' } }, { id: 'si_old', price: { lookup_key: 'network_location_hq_share:usd:month:5340' } }] } })),
        update, create,
      },
      prices: { list: vi.fn(async (p: { lookup_keys: string[] }) => ({ data: [{ id: `price_${p.lookup_keys[0]}` }] })), create: vi.fn() },
      products: { search: vi.fn(), create: vi.fn() },
      customers: { update: vi.fn() },
    };
    const billing = createPlatformBilling({ STRIPE_TAX_ENABLED: false } as Config, { client: client as unknown as Stripe, mode: 'live', publishableKey: 'pk_test' }, quiet);
    await billing.updateItems('sub_hq', {
      currency: 'USD', interval: 'month', prorate: true, idempotencyKey: 'k1',
      lines: [{ lookupKey: 'network_platform', productName: 'p', unitAmountMinor: 29_900, quantity: 1 }, { lookupKey: 'network_location', productName: 'l', unitAmountMinor: 8900, quantity: 4 }],
    });
    const [, params] = update.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(params.proration_behavior).toBe('create_prorations');
    expect(params.items).toEqual([
      { id: 'si_platform', price: 'price_network_platform:usd:month:29900', quantity: 1 },
      { id: 'si_loc', price: 'price_network_location:usd:month:8900', quantity: 4 },
      { id: 'si_old', deleted: true },
    ]);
    await billing.updateItems('sub_hq', { currency: 'USD', interval: 'year', prorate: false, idempotencyKey: 'k2', lines: [] });
    expect((update.mock.calls[1] as unknown as [string, Record<string, any>])[1].proration_behavior).toBe('none');

    const startAt = new Date(Date.now() + 10 * DAY);
    await billing.createSubscription({ customerId: 'cus_fr', paymentMethodId: 'pm_fr', currency: 'NGN', interval: 'month', lines: [{ lookupKey: 'network_location_franchisee_100pct', productName: 'f', unitAmountMinor: 6_500_000, quantity: 2 }], trialDays: null, trialFee: null, trialEnd: startAt, metadata: {}, idempotencyKey: 'k3' });
    const [cp] = create.mock.calls[0] as unknown as [Record<string, any>];
    expect(cp).toMatchObject({ customer: 'cus_fr', default_payment_method: 'pm_fr', trial_end: Math.floor(startAt.getTime() / 1000), items: [{ price: 'price_network_location_franchisee_100pct:ngn:month:6500000', quantity: 2 }] });
    expect(cp.trial_period_days).toBeUndefined();
  });
});

describe.skipIf(!hasDb)('live franchisee charging, change card and plan (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });
  const b = (orgId: string) => `/v1/orgs/${orgId}/billing`;
  const post = (event: object) => {
    const payload = JSON.stringify(event);
    return app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload, headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(payload, WEBHOOK_SECRET) } });
  };

  it('a franchisee-paid location gets its own subscription in the franchisee currency; quantities follow locations; webhooks convert and flag failures', async () => {
    const o = await userAt(app, `fr-${uid()}.example`);
    await app.ctx.db.update(users).set({ locale: 'fr' }).where(eq(users.email, o.email));
    const org = await createOrg(app, o.token, { country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/New_York' });
    const [group] = await app.ctx.db.insert(ownerGroups).values({ organizationId: org.id, name: 'Lagos Franchise Ltd' }).returning();
    const loc = (name: string, over: Record<string, unknown> = {}) => createLocation(app, o.token, org.id, { name, currency: 'USD', timeZone: 'America/New_York', address: { line1: `${uid()} Main`, city: 'Boston', country: 'US' }, ...over });
    for (const n of ['One', 'Two', 'Three']) await loc(n);
    const lagos = await loc('Lagos Island', { ownerGroupId: group!.id });
    await call(app, 'POST', `${b(org.id)}/checkout`, { token: o.token, body: { plan: 'network', billingCountry: 'US' } });
    const ok = await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: o.token, body: { paymentMethodId: `pm_sandbox_card_US_${uid()}`, acceptTerms: true } });
    expect(ok.body.status).toBe('trialing');
    // The confirmation is in the owner's language.
    expect(app.ctx.mailer.outbox.filter((m) => m.to === o.email).at(-1)!.subject).toBe('Votre essai BranchHarbor de 14 jours a commencé');

    expect((await call(app, 'PUT', `${b(org.id)}/payers`, { token: o.token, body: { scopeKind: 'owner_group', scopeId: group!.id, payer: 'franchisee' } })).status).toBe(200);
    let [sub] = await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
    // HQ's items no longer include the franchisee-paid location.
    expect(sub!.syncedLines.map((l) => [l.lookupKey, l.quantity])).toEqual([['network_platform', 1]]);

    const fo = await memberWithRole(app, o.token, org.id, 'franchise_owner', { kind: 'owner_group', id: group!.id }, 'Femi Franchisee');
    await call(app, 'POST', `/v1/orgs/${org.id}/franchisee-billing/setup`, { token: fo.token, body: { scopeKind: 'owner_group', scopeId: group!.id, billingCountry: 'NG' } });
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/franchisee-billing/confirm`, { token: fo.token, body: { scopeKind: 'owner_group', scopeId: group!.id, paymentMethodId: `pm_sandbox_card_NG_${uid()}` } })).body.status).toBe('active');
    const acct = async () => (await app.ctx.db.select().from(franchiseeBillingAccounts).where(and(eq(franchiseeBillingAccounts.organizationId, org.id), eq(franchiseeBillingAccounts.scopeId, group!.id))))[0]!;
    let a = await acct();
    const ngn = listPriceMinor('NGN', 'network');
    expect(a).toMatchObject({ currency: 'NGN', subscriptionStatus: 'trialing', stripeSubscriptionId: expect.stringMatching(/^sub_sandbox_/) });
    expect(a.subscriptionLines).toEqual([expect.objectContaining({ lookupKey: 'network_location_franchisee_100pct', unitAmountMinor: ngn, quantity: 1 })]);
    // It starts when HQ's plan starts.
    expect(a.currentPeriodEnd!.getTime()).toBe(sub!.trialEndsAt!.getTime());

    // A second unit for the franchisee raises the quantity; archiving it lowers it again.
    const second = await loc('Lekki', { ownerGroupId: group!.id });
    a = await acct();
    expect(a.subscriptionLines[0]!.quantity).toBe(2);
    expect((await call(app, 'PATCH', `/v1/orgs/${org.id}/locations/${second.id}`, { token: o.token, body: { status: 'closed' } })).status).toBe(200);
    a = await acct();
    expect(a.subscriptionLines[0]!.quantity).toBe(1);
    // An HQ location beyond the three included lands on HQ's own items.
    await loc('Four');
    [sub] = await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
    expect(sub!.syncedLines.map((l) => [l.lookupKey, l.quantity])).toEqual([['network_location', 1], ['network_platform', 1]]);
    const audits = await app.ctx.db.select().from(auditEvents).where(eq(auditEvents.organizationId, org.id));
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(['billing.quantities_synced', 'billing.franchisee_subscription_created', 'billing.franchisee_quantities_synced']));

    // Live webhooks: Stripe converts HQ's trial to the plan on day 15.
    const conv = await post({ id: `evt_${uid()}`, object: 'event', type: 'customer.subscription.updated', data: { object: { id: sub!.stripeSubscriptionId, object: 'subscription', status: 'active', currency: 'usd', cancel_at_period_end: false }, previous_attributes: { status: 'trialing' } } });
    expect(conv.statusCode).toBe(200);
    expect((await call(app, 'GET', b(org.id), { token: o.token })).body.status).toBe('active');
    expect(app.ctx.mailer.outbox.filter((m) => m.to === o.email).at(-1)!.subject).toBe('Votre formule BranchHarbor a démarré');
    expect((await app.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, org.id), eq(auditEvents.action, 'billing.trial_converted')))).length).toBe(1);
    // …and the franchisee's subscription follows on its own.
    await post({ id: `evt_${uid()}`, object: 'event', type: 'customer.subscription.updated', data: { object: { id: a.stripeSubscriptionId, object: 'subscription', status: 'active', currency: 'ngn', items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] } } } });
    expect((await acct()).subscriptionStatus).toBe('active');
    // A failed franchisee payment flags the account and tells the franchisee.
    const fail = await post({ id: `evt_${uid()}`, object: 'event', type: 'invoice.payment_failed', data: { object: { id: `in_${uid()}`, object: 'invoice', subscription: a.stripeSubscriptionId, status: 'open', currency: 'ngn', total: ngn, amount_due: ngn, amount_paid: 0, subtotal: ngn } } });
    expect(fail.statusCode).toBe(200);
    expect((await acct()).subscriptionStatus).toBe('past_due');
    expect(app.ctx.mailer.outbox.some((m) => m.to === fo.email && m.tag === 'billing-payment-failed')).toBe(true);
    const fv = await call(app, 'GET', `/v1/orgs/${org.id}/franchisee-billing`, { token: fo.token });
    expect(fv.body.invoices[0]).toMatchObject({ kind: 'franchisee_fee', payer: 'franchisee', status: 'open', total: { amount: ngn, currency: 'NGN' } });

    // invoice.created for a renewal re-syncs quantities (a location added behind billing's back).
    await app.ctx.db.insert(locations).values({ organizationId: org.id, name: 'Five', code: `F${uid().slice(0, 5)}`.toUpperCase(), slug: `five-${uid()}`, address: { line1: '5 Main', city: 'Boston', country: 'US' }, country: 'US', timeZone: 'America/New_York', currency: 'USD', status: 'operating' });
    await post({ id: `evt_${uid()}`, object: 'event', type: 'invoice.created', data: { object: { id: `in_${uid()}`, object: 'invoice', subscription: sub!.stripeSubscriptionId, billing_reason: 'subscription_cycle', status: 'draft', currency: 'usd', total: 0, amount_due: 0, amount_paid: 0 } } });
    [sub] = await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
    expect(sub!.syncedLines.find((l) => l.lookupKey === 'network_location')!.quantity).toBe(2);
    // HQ payment failure: past due, owners told in their language.
    await post({ id: `evt_${uid()}`, object: 'event', type: 'invoice.payment_failed', data: { object: { id: `in_${uid()}`, object: 'invoice', subscription: sub!.stripeSubscriptionId, status: 'open', currency: 'usd', total: 50_000, amount_due: 50_000, amount_paid: 0, subtotal: 50_000 } } });
    expect((await call(app, 'GET', b(org.id), { token: o.token })).body.status).toBe('past_due');
    expect(app.ctx.mailer.outbox.filter((m) => m.to === o.email).at(-1)!.subject).toBe('Nous n’avons pas pu encaisser votre paiement BranchHarbor');
  });

  it('change card with the country check; switch plan and interval with a proration preview; cancel and resume', async () => {
    const o = await userAt(app, `chg-${uid()}.example`);
    const org = await createOrg(app, o.token, { country: 'GB', defaultCurrency: 'GBP', defaultTimeZone: 'Europe/London' });
    for (let i = 0; i < 2; i++) await createLocation(app, o.token, org.id, { currency: 'GBP', timeZone: 'Europe/London', address: { line1: `${i} High St`, city: 'London', country: 'GB' } });
    await call(app, 'POST', `${b(org.id)}/checkout`, { token: o.token, body: { plan: 'hosted', billingCountry: 'GB' } });
    await call(app, 'POST', `${b(org.id)}/checkout/confirm`, { token: o.token, body: { paymentMethodId: `pm_sandbox_card_GB_${uid()}`, acceptTerms: true } });

    // Card: a card from another country is refused (unless a GB tax ID is given), a GB card is saved.
    const setup = await call(app, 'POST', `${b(org.id)}/payment-method`, { token: o.token });
    expect(setup.body).toMatchObject({ billingCountry: 'GB', setup: { mode: 'sandbox', setupIntentId: expect.stringMatching(/^seti_/) } });
    expect((await call(app, 'POST', `${b(org.id)}/payment-method/confirm`, { token: o.token, body: { paymentMethodId: 'pm_sandbox_card_US_x' } })).body.error.code).toBe('card_country_mismatch');
    const card = await call(app, 'POST', `${b(org.id)}/payment-method/confirm`, { token: o.token, body: { paymentMethodId: `pm_sandbox_card_GB_${uid()}` } });
    expect(card.status).toBe(200);
    expect(card.body.billing.card).toEqual({ brand: 'visa', last4: '4242', country: 'GB' });

    // During the trial a switch costs nothing now: the new plan starts on day 15.
    const pTrial = await call(app, 'GET', `${b(org.id)}/change/preview?plan=network&interval=month`, { token: o.token });
    expect(pTrial.body).toMatchObject({ effective: 'trial_end', proration: { amount: 0, currency: 'GBP' }, from: { plan: 'hosted' }, to: { plan: 'network', hqTotal: { amount: listPriceMinor('GBP', 'platform'), currency: 'GBP' } } });
    expect((await call(app, 'GET', `${b(org.id)}/change/preview?plan=solo&interval=month`, { token: o.token })).status).toBe(400);

    // After the trial: upgrading mid-period prorates the difference; going annual charges the year less unused time.
    const [sub] = await app.ctx.db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
    await runBillingSweep(app.ctx, new Date(sub!.trialEndsAt!.getTime() + 1000));
    await app.ctx.db.update(subscriptions).set({ currentPeriodEnd: new Date(Date.now() + 15 * DAY) }).where(eq(subscriptions.id, sub!.id));
    const hosted = 2 * listPriceMinor('GBP', 'hosted');
    const network = listPriceMinor('GBP', 'platform');
    const up = await call(app, 'GET', `${b(org.id)}/change/preview?plan=network&interval=month`, { token: o.token });
    expect(up.body).toMatchObject({ effective: 'now', from: { hqTotal: { amount: hosted } }, to: { hqTotal: { amount: network } } });
    expect(up.body.proration.amount).toBeGreaterThan(Math.round((network - hosted) * 0.45));
    expect(up.body.proration.amount).toBeLessThan(Math.round((network - hosted) * 0.55));
    const annual = await call(app, 'GET', `${b(org.id)}/change/preview?plan=hosted&interval=year`, { token: o.token });
    expect(annual.body.to.hqTotal.amount).toBe(hosted * 10);
    expect(annual.body.proration.amount).toBe(hosted * 10 - Math.round(hosted * (15 / 30)));

    const changed = await call(app, 'POST', `${b(org.id)}/change`, { token: o.token, body: { plan: 'network', interval: 'month' } });
    expect(changed.status).toBe(200);
    expect(changed.body.billing).toMatchObject({ plan: 'network', interval: 'month', platformFee: { amount: network, currency: 'GBP' } });
    expect(changed.body.billing.invoices[0]).toMatchObject({ kind: 'subscription', total: { amount: changed.body.proration.amount, currency: 'GBP' } });
    expect(app.ctx.mailer.outbox.filter((m) => m.to === o.email).at(-1)!.subject).toBe('Your BranchHarbor plan is now Network');
    expect((await call(app, 'POST', `${b(org.id)}/change`, { token: o.token, body: { plan: 'network', interval: 'month' } })).status).toBe(400);
    expect((await call(app, 'POST', `${b(org.id)}/change`, { token: o.token, body: { plan: 'network', interval: 'year' } })).body.billing.interval).toBe('year');

    // Cancel at period end, then resume.
    expect((await call(app, 'POST', `${b(org.id)}/cancel`, { token: o.token, body: {} })).body.cancelAtPeriodEnd).toBe(true);
    expect((await call(app, 'GET', b(org.id), { token: o.token })).body).toMatchObject({ cancelAtPeriodEnd: true, nextChargeAt: null });
    expect((await call(app, 'POST', `${b(org.id)}/resume`, { token: o.token })).body.cancelAtPeriodEnd).toBe(false);
  });
});

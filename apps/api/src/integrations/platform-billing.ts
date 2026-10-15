import type Stripe from 'stripe';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import type { PaymentsProvider } from './payments.ts';

/**
 * BranchHarbor's own plan billing on the PLATFORM Stripe account (never a connected account): customers, card setup,
 * the paid-trial subscription and its invoices. Uses the same Stripe client as payments (`payments.client`), so tests
 * that inject a mocked Stripe client exercise these live paths too.
 *
 * Paid trial in Stripe: a subscription with `trial_period_days: 14` plus a one-off trial-fee invoice item
 * (`add_invoice_items`). Stripe puts the item on the first ($0 trial) invoice, charges it immediately with the saved
 * card, and starts billing the plan automatically when the trial ends unless the subscription is cancelled first.
 *
 * Sandbox (no STRIPE_SECRET_KEY): deterministic fake ids. Payment methods are simulated by id:
 * `pm_sandbox_card_{COUNTRY}[_{fingerprint}]` (e.g. pm_sandbox_card_GB_a1) is a card issued in COUNTRY;
 * `pm_sandbox_decline…` is declined.
 */
export interface CardDetails { brand: string | null; last4: string | null; country: string | null; fingerprint: string | null; expMonth: number | null; expYear: number | null }
export interface PlatformInvoice { id: string; number: string | null; status: string; amountPaid: number; amountDue: number; tax: number; total: number; subtotal: number; currency: string; hostedUrl: string | null; periodStart: Date | null; periodEnd: Date | null }
export interface PlatformSubscription { id: string; status: string; trialEnd: Date | null; currentPeriodEnd: Date | null; latestInvoice: PlatformInvoice | null }

export interface SubscriptionLine { lookupKey: string; productName: string; unitAmountMinor: number; quantity: number }

export class CardDeclinedError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export interface PlatformBilling {
  readonly mode: 'live' | 'sandbox';
  readonly publishableKey: string | null;
  createCustomer(input: { email: string | null; name: string; country: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<{ id: string }>;
  createSetupIntent(input: { customerId: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<{ id: string; clientSecret: string | null }>;
  /** The payment method a confirmed SetupIntent saved (live). */
  setupIntentPaymentMethod(setupIntentId: string, customerId: string): Promise<string | null>;
  retrieveCard(paymentMethodId: string): Promise<CardDetails | null>;
  addTaxId(customerId: string, country: string, value: string): Promise<void>;
  createSubscription(input: {
    customerId: string; paymentMethodId: string; currency: string; interval: 'month' | 'year'; lines: SubscriptionLine[];
    trialDays: number | null; trialFee: { amountMinor: number; description: string } | null; metadata: Record<string, string>; idempotencyKey: string;
  }): Promise<PlatformSubscription>;
  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<void>;
  cancelNow(subscriptionId: string): Promise<void>;
}

const isSandbox = (id: string | null | undefined) => !id || id.includes('_sandbox_');
const fake = (prefix: string, seed: string) => `${prefix}_sandbox_${sha256(seed).slice(0, 14)}`;

/** Stripe tax ID type for a business tax ID in `country`. */
function taxIdType(country: string): string | null {
  const eu = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
  if (eu.includes(country)) return 'eu_vat';
  const map: Record<string, string> = { GB: 'gb_vat', AU: 'au_abn', NZ: 'nz_gst', CA: 'ca_bn', IN: 'in_gst', NG: 'ng_tin', ZA: 'za_vat', CH: 'ch_vat', NO: 'no_vat', BR: 'br_cnpj', MX: 'mx_rfc', SG: 'sg_uen', JP: 'jp_cn', AE: 'ae_trn', SA: 'sa_vat', US: 'us_ein', KE: 'ke_pin', EG: 'eg_tin', TR: 'tr_tin', MY: 'my_sst', ID: 'id_npwp', PH: 'ph_tin', HK: 'hk_br' };
  return map[country] ?? null;
}

function sandboxCard(pm: string): CardDetails | null {
  if (!pm.startsWith('pm_')) return null;
  const m = /^pm_sandbox_card_([A-Z]{2})(?:_([A-Za-z0-9]+))?$/.exec(pm);
  const country = m?.[1] ?? 'US';
  return { brand: 'visa', last4: '4242', country, fingerprint: m?.[2] ? `fp_${m[2]}` : `fp_${sha256(pm).slice(0, 12)}`, expMonth: 12, expYear: new Date().getUTCFullYear() + 3 };
}

const toDate = (sec: unknown) => (typeof sec === 'number' ? new Date(sec * 1000) : null);

export function invoiceFromStripe(inv: Record<string, any>): PlatformInvoice {
  const line = inv.lines?.data?.[0];
  return {
    id: String(inv.id), number: inv.number ?? null, status: String(inv.status ?? 'open'), amountPaid: Number(inv.amount_paid ?? 0), amountDue: Number(inv.amount_due ?? 0),
    tax: Number(inv.tax ?? (Array.isArray(inv.total_taxes) ? inv.total_taxes.reduce((s: number, t: { amount?: number }) => s + (t.amount ?? 0), 0) : 0)),
    total: Number(inv.total ?? 0), subtotal: Number(inv.subtotal ?? inv.total ?? 0), currency: String(inv.currency ?? 'usd').toUpperCase(), hostedUrl: inv.hosted_invoice_url ?? null,
    periodStart: toDate(line?.period?.start ?? inv.period_start), periodEnd: toDate(line?.period?.end ?? inv.period_end),
  };
}

/** Current period end of a Stripe subscription (top-level on older API versions, per item on newer ones). */
export function subscriptionPeriodEnd(sub: Record<string, any>): Date | null {
  return toDate(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end);
}

export function createPlatformBilling(cfg: Config, payments: Pick<PaymentsProvider, 'client' | 'mode' | 'publishableKey'>, log: FastifyBaseLogger): PlatformBilling {
  const stripe: Stripe | null = payments.client;
  const productIds = new Map<string, string>();

  async function ensurePrice(currency: string, interval: 'month' | 'year', line: SubscriptionLine): Promise<string> {
    const lookupKey = `${line.lookupKey}:${currency.toLowerCase()}:${interval}:${line.unitAmountMinor}`;
    const existing = await stripe!.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    if (existing.data[0]) return existing.data[0].id;
    const productKey = `bh_platform_${line.lookupKey}`;
    let productId = productIds.get(productKey);
    if (!productId) {
      const found = await stripe!.products.search({ query: `metadata['bh_key']:'${productKey}'`, limit: 1 }).catch(() => null);
      productId = found?.data[0]?.id ?? (await stripe!.products.create({ name: line.productName, metadata: { bh_key: productKey } }, { idempotencyKey: `product:${productKey}` })).id;
      productIds.set(productKey, productId);
    }
    const price = await stripe!.prices.create({
      product: productId, currency: currency.toLowerCase(), unit_amount: line.unitAmountMinor, recurring: { interval }, lookup_key: lookupKey,
      tax_behavior: 'exclusive', metadata: { bh_platform: '1' },
    }, { idempotencyKey: `price:${lookupKey}` });
    return price.id;
  }

  async function trialProduct(): Promise<string> {
    const key = 'bh_platform_trial_fee';
    const cached = productIds.get(key);
    if (cached) return cached;
    const found = await stripe!.products.search({ query: `metadata['bh_key']:'${key}'`, limit: 1 }).catch(() => null);
    const id = found?.data[0]?.id ?? (await stripe!.products.create({ name: 'BranchHarbor 14-day trial', metadata: { bh_key: key } }, { idempotencyKey: `product:${key}` })).id;
    productIds.set(key, id);
    return id;
  }

  return {
    mode: stripe ? 'live' : 'sandbox',
    publishableKey: payments.publishableKey,
    async createCustomer({ email, name, country, metadata, idempotencyKey }) {
      if (!stripe) return { id: fake('cus', idempotencyKey) };
      const c = await stripe.customers.create({ email: email ?? undefined, name, address: { country }, metadata, preferred_locales: [] }, { idempotencyKey });
      return { id: c.id };
    },
    async createSetupIntent({ customerId, metadata, idempotencyKey }) {
      if (!stripe || isSandbox(customerId)) {
        const id = `seti_sandbox_${randomToken(10)}`;
        return { id, clientSecret: `${id}_secret_sandbox` };
      }
      const si = await stripe.setupIntents.create({ customer: customerId, usage: 'off_session', automatic_payment_methods: { enabled: true, allow_redirects: 'never' }, metadata }, { idempotencyKey });
      return { id: si.id, clientSecret: si.client_secret };
    },
    async setupIntentPaymentMethod(setupIntentId, customerId) {
      if (!stripe || isSandbox(setupIntentId)) return null;
      const si = await stripe.setupIntents.retrieve(setupIntentId);
      const cust = typeof si.customer === 'string' ? si.customer : si.customer?.id;
      if (si.status !== 'succeeded' || cust !== customerId) return null;
      return typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id ?? null;
    },
    async retrieveCard(pm) {
      if (!stripe || isSandbox(pm)) return sandboxCard(pm);
      const p = await stripe.paymentMethods.retrieve(pm);
      const c = p.card;
      return c ? { brand: c.brand ?? null, last4: c.last4 ?? null, country: c.country ?? null, fingerprint: c.fingerprint ?? null, expMonth: c.exp_month ?? null, expYear: c.exp_year ?? null } : null;
    },
    async addTaxId(customerId, country, value) {
      if (!stripe || isSandbox(customerId)) return;
      const type = taxIdType(country);
      if (!type) return log.info({ country }, '[billing] no Stripe tax ID type for country; stored on BranchHarbor only');
      try {
        await stripe.customers.createTaxId(customerId, { type: type as Stripe.CustomerCreateTaxIdParams.Type, value });
      } catch (err) {
        log.warn({ err: (err as Error).message, country }, '[billing] Stripe refused the tax ID');
        throw new CardDeclinedError('The tax ID was not accepted. Check the number and try again.', 'invalid_tax_id');
      }
    },
    async createSubscription(i) {
      if (!stripe || isSandbox(i.customerId)) {
        if (i.paymentMethodId.includes('decline')) throw new CardDeclinedError('Your card was declined (sandbox).', 'card_declined');
        const now = Date.now();
        const trialEnd = i.trialDays ? new Date(now + i.trialDays * 86400_000) : null;
        const periodEnd = trialEnd ?? new Date(now + (i.interval === 'year' ? 365 : 30) * 86400_000);
        const id = fake('sub', i.idempotencyKey);
        const planTotal = i.lines.reduce((s, l) => s + l.unitAmountMinor * l.quantity, 0);
        const charged = i.trialFee ? i.trialFee.amountMinor : planTotal;
        return {
          id, status: trialEnd ? 'trialing' : 'active', trialEnd, currentPeriodEnd: periodEnd,
          latestInvoice: { id: fake('in', `${i.idempotencyKey}:first`), number: null, status: 'paid', amountPaid: charged, amountDue: charged, tax: 0, total: charged, subtotal: charged, currency: i.currency, hostedUrl: null, periodStart: new Date(now), periodEnd },
        };
      }
      const items = [];
      for (const l of i.lines) items.push({ price: await ensurePrice(i.currency, i.interval, l), quantity: l.quantity });
      try {
        const sub = await stripe.subscriptions.create({
          customer: i.customerId,
          default_payment_method: i.paymentMethodId,
          items,
          ...(i.trialDays ? { trial_period_days: i.trialDays, trial_settings: { end_behavior: { missing_payment_method: 'cancel' } } } : {}),
          ...(i.trialFee ? { add_invoice_items: [{ price_data: { currency: i.currency.toLowerCase(), product: await trialProduct(), unit_amount: i.trialFee.amountMinor, tax_behavior: 'exclusive' } }] } : {}),
          automatic_tax: { enabled: cfg.STRIPE_TAX_ENABLED },
          payment_behavior: 'error_if_incomplete',
          off_session: true,
          expand: ['latest_invoice'],
          metadata: i.metadata,
        } as Stripe.SubscriptionCreateParams, { idempotencyKey: i.idempotencyKey });
        const raw = sub as unknown as Record<string, any>;
        const inv = raw.latest_invoice && typeof raw.latest_invoice === 'object' ? invoiceFromStripe(raw.latest_invoice) : null;
        return { id: sub.id, status: sub.status, trialEnd: toDate(raw.trial_end), currentPeriodEnd: subscriptionPeriodEnd(raw), latestInvoice: inv };
      } catch (err) {
        const e = err as { type?: string; code?: string; message?: string };
        if (e.type === 'StripeCardError' || e.code === 'card_declined' || e.code === 'authentication_required') throw new CardDeclinedError(e.message ?? 'The card was declined', e.code ?? 'card_declined');
        throw err;
      }
    },
    async setCancelAtPeriodEnd(id, cancel) {
      if (!stripe || isSandbox(id)) return;
      await stripe.subscriptions.update(id, { cancel_at_period_end: cancel });
    },
    async cancelNow(id) {
      if (!stripe || isSandbox(id)) return;
      await stripe.subscriptions.cancel(id);
    },
  };
}

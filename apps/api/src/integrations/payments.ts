import Stripe from 'stripe';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';

export interface CreateIntentInput {
  amountMinor: number;
  currency: string;
  connectedAccountId: string | null;
  applicationFeeMinor: number;
  metadata: Record<string, string>;
  idempotencyKey: string;
  description?: string;
  /** Stripe Customer (on the connected account) the intent belongs to. */
  customerId?: string | null;
  /** Keep the card for later merchant-initiated charges (renewals, instalments, fees). */
  setupFutureUsage?: 'off_session' | null;
}

export interface OffSessionChargeInput {
  amountMinor: number;
  currency: string;
  connectedAccountId: string | null;
  applicationFeeMinor: number;
  customerId: string;
  paymentMethodId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
  description?: string;
}

export interface OffSessionChargeResult {
  /** PaymentIntent id (present whenever Stripe created one, also for declines). */
  id: string | null;
  status: 'succeeded' | 'processing' | 'requires_action' | 'failed';
  clientSecret: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
}

export interface CardSummary { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null }

/** Where a verified webhook event came from: the platform endpoint or the Connect endpoint (events of connected accounts). */
export type WebhookSource = 'platform' | 'connect';

export interface PaymentsProvider {
  readonly mode: 'live' | 'sandbox';
  readonly webhooksEnabled: boolean;
  readonly connectWebhooksEnabled: boolean;
  /** Browser/app key. Only set in live mode; it is public by design (never the secret key). */
  readonly publishableKey: string | null;
  /** The underlying Stripe client (null in sandbox). Tests inject a mock. */
  readonly client: Stripe | null;
  createConnectedAccount(input: { country: string; email?: string | null; businessName: string }): Promise<{ accountId: string }>;
  createOnboardingLink(accountId: string, refreshUrl: string, returnUrl: string): Promise<{ url: string; expiresAt: Date | null }>;
  getAccountStatus(accountId: string): Promise<{ chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }>;
  createPaymentIntent(input: CreateIntentInput): Promise<{ id: string; clientSecret: string | null; status: string }>;
  /** Attach a Customer and `setup_future_usage` to an unconfirmed intent (the customer ticked "save this card"). */
  enableCardSaving(input: { paymentIntentId: string; connectedAccountId: string | null; customerId: string }): Promise<void>;
  cancelPaymentIntent(id: string, connectedAccountId: string | null): Promise<void>;
  createRefund(input: { paymentIntentId: string; amountMinor: number; connectedAccountId: string | null; idempotencyKey: string; reason?: string }): Promise<{ id: string; status: 'pending' | 'complete' | 'failed' }>;
  createCustomer(input: { connectedAccountId: string | null; email: string | null; name: string | null; metadata: Record<string, string>; idempotencyKey: string }): Promise<{ id: string }>;
  setDefaultPaymentMethod(input: { connectedAccountId: string | null; customerId: string; paymentMethodId: string }): Promise<void>;
  retrievePaymentMethod(id: string, connectedAccountId: string | null): Promise<CardSummary | null>;
  createSetupIntent(input: { connectedAccountId: string | null; customerId: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<{ id: string; clientSecret: string | null }>;
  /** Find-or-create a recurring price (and its product) on the connected account by lookup key. */
  ensureRecurringPrice(input: { connectedAccountId: string | null; lookupKey: string; productName: string; amountMinor: number; currency: string; interval: 'week' | 'month'; metadata: Record<string, string> }): Promise<{ productId: string; priceId: string }>;
  createSubscription(input: {
    connectedAccountId: string | null; customerId: string; priceId: string; defaultPaymentMethodId: string | null; trialEnd: Date | null;
    applicationFeePercent: number; metadata: Record<string, string>; idempotencyKey: string; collectFirstPayment: boolean;
  }): Promise<{ id: string; status: string; clientSecret: string | null }>;
  updateSubscriptionPaymentMethod(input: { connectedAccountId: string | null; subscriptionId: string; paymentMethodId: string }): Promise<void>;
  /** Retry open invoices of a subscription now (after a card update). */
  payOpenInvoices(input: { connectedAccountId: string | null; subscriptionId: string }): Promise<number>;
  chargeOffSession(input: OffSessionChargeInput): Promise<OffSessionChargeResult>;
  /** Verifies the Stripe-Signature header against the secret of `source` and returns the parsed event. Throws on failure. */
  constructWebhookEvent(rawBody: Buffer | string, signature: string, source?: WebhookSource): Stripe.Event;
}

/**
 * Picks the signing secret for a webhook endpoint and enforces that the event's scope matches it:
 * Connect endpoint events always carry `account`; platform endpoint events never do.
 * Returns the verified event and where it came from. `endpoint: 'auto'` (the legacy single URL) tries
 * the platform secret first, then the Connect secret.
 */
export function verifyStripeWebhook(cfg: Pick<Config, 'STRIPE_WEBHOOK_SECRET' | 'STRIPE_CONNECT_WEBHOOK_SECRET'>, rawBody: Buffer | string, signature: string, endpoint: WebhookSource | 'auto'): { event: Stripe.Event; source: WebhookSource } {
  const verifier = new Stripe('sk_test_sandbox_placeholder');
  const candidates: Array<[WebhookSource, string | undefined]> = endpoint === 'platform' ? [['platform', cfg.STRIPE_WEBHOOK_SECRET]]
    : endpoint === 'connect' ? [['connect', cfg.STRIPE_CONNECT_WEBHOOK_SECRET]]
      : [['platform', cfg.STRIPE_WEBHOOK_SECRET], ['connect', cfg.STRIPE_CONNECT_WEBHOOK_SECRET]];
  let lastErr: Error = new Error('Webhook secret not configured');
  for (const [source, secret] of candidates) {
    if (!secret) continue;
    let event: Stripe.Event;
    try {
      event = verifier.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      lastErr = err as Error;
      continue;
    }
    const scoped = !!(event as { account?: string }).account;
    if (source === 'connect' && !scoped) throw new Error('Connect endpoint received an event without an account');
    if (source === 'platform' && scoped && endpoint !== 'auto') throw new Error('Platform endpoint received a connected-account event');
    return { event, source: scoped ? 'connect' : source };
  }
  throw lastErr;
}

const isSandboxId = (id: string | null | undefined) => !!id && id.includes('_sandbox_');

/**
 * Stripe Connect adapter (direct charges on connected accounts with an application fee).
 * Without STRIPE_SECRET_KEY it runs in sandbox mode: deterministic fake ids, no network calls.
 * Webhook verification requires STRIPE_WEBHOOK_SECRET (platform events) and/or STRIPE_CONNECT_WEBHOOK_SECRET
 * (connected-account events) in every mode — unsigned events are rejected.
 * `client` lets tests inject a mocked Stripe client to exercise the live code paths without network calls.
 */
export function createPaymentsProvider(cfg: Config, log: FastifyBaseLogger, client?: Stripe): PaymentsProvider {
  const live = !!cfg.STRIPE_SECRET_KEY;
  const stripe = live ? client ?? new Stripe(cfg.STRIPE_SECRET_KEY!, { maxNetworkRetries: 2, appInfo: { name: 'BranchHarbor' } }) : null;
  if (!live) log.warn('[stripe] STRIPE_SECRET_KEY not set — payments run in SANDBOX mode (no real charges)');
  if (!cfg.STRIPE_WEBHOOK_SECRET) log.warn('[stripe] STRIPE_WEBHOOK_SECRET not set — platform webhook endpoint will reject events');
  if (live && !cfg.STRIPE_CONNECT_WEBHOOK_SECRET) log.warn('[stripe] STRIPE_CONNECT_WEBHOOK_SECRET not set — connected-account events (direct charges, subscriptions) cannot be received on /v1/webhooks/stripe/connect');
  if (live && !cfg.STRIPE_PUBLISHABLE_KEY) log.warn('[stripe] STRIPE_PUBLISHABLE_KEY not set — customers cannot enter cards');
  const opts = (acct: string | null, idem?: string): Stripe.RequestOptions => ({ ...(acct ? { stripeAccount: acct } : {}), ...(idem ? { idempotencyKey: idem } : {}) });
  const fake = (prefix: string, seed?: string) => `${prefix}_sandbox_${seed ? sha256(seed).slice(0, 14) : randomToken(10)}`;

  return {
    mode: live ? 'live' : 'sandbox',
    webhooksEnabled: !!cfg.STRIPE_WEBHOOK_SECRET || !!cfg.STRIPE_CONNECT_WEBHOOK_SECRET,
    connectWebhooksEnabled: !!cfg.STRIPE_CONNECT_WEBHOOK_SECRET,
    publishableKey: live && cfg.STRIPE_PUBLISHABLE_KEY?.startsWith('pk_') ? cfg.STRIPE_PUBLISHABLE_KEY : null,
    client: stripe,
    async createConnectedAccount({ country, email, businessName }) {
      if (!stripe) return { accountId: `acct_sandbox_${randomToken(8)}` };
      const acct = await stripe.accounts.create({
        country,
        email: email ?? undefined,
        business_profile: { name: businessName },
        controller: { fees: { payer: 'account' }, losses: { payments: 'stripe' }, stripe_dashboard: { type: 'full' } },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      });
      return { accountId: acct.id };
    },
    async createOnboardingLink(accountId, refreshUrl, returnUrl) {
      if (!stripe) return { url: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}sandbox_account=${accountId}`, expiresAt: null };
      const link = await stripe.accountLinks.create({ account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' });
      return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
    },
    async getAccountStatus(accountId) {
      if (!stripe) return { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };
      const a = await stripe.accounts.retrieve(accountId);
      return { chargesEnabled: !!a.charges_enabled, payoutsEnabled: !!a.payouts_enabled, detailsSubmitted: !!a.details_submitted };
    },
    async createPaymentIntent(input) {
      if (!stripe) {
        const id = `pi_sandbox_${randomToken(12)}`;
        return { id, clientSecret: `${id}_secret_sandbox`, status: 'requires_payment_method' };
      }
      const pi = await stripe.paymentIntents.create(
        {
          amount: input.amountMinor,
          currency: input.currency.toLowerCase(),
          // Card, wallets (Apple Pay / Google Pay) and local methods the connected account has enabled.
          automatic_payment_methods: { enabled: true },
          metadata: input.metadata,
          description: input.description,
          ...(input.customerId ? { customer: input.customerId } : {}),
          ...(input.setupFutureUsage ? { setup_future_usage: input.setupFutureUsage } : {}),
          ...(input.connectedAccountId && input.applicationFeeMinor > 0 ? { application_fee_amount: input.applicationFeeMinor } : {}),
        },
        opts(input.connectedAccountId, input.idempotencyKey),
      );
      return { id: pi.id, clientSecret: pi.client_secret, status: pi.status };
    },
    async enableCardSaving({ paymentIntentId, connectedAccountId, customerId }) {
      if (!stripe || isSandboxId(paymentIntentId)) return;
      await stripe.paymentIntents.update(paymentIntentId, { customer: customerId, setup_future_usage: 'off_session' }, opts(connectedAccountId));
    },
    async cancelPaymentIntent(id, acct) {
      if (!stripe || isSandboxId(id)) return;
      await stripe.paymentIntents.cancel(id, {}, opts(acct));
    },
    async createRefund({ paymentIntentId, amountMinor, connectedAccountId, idempotencyKey, reason }) {
      if (!stripe || isSandboxId(paymentIntentId)) return { id: `re_sandbox_${randomToken(10)}`, status: 'complete' };
      const r = await stripe.refunds.create(
        { payment_intent: paymentIntentId, amount: amountMinor, metadata: reason ? { reason } : undefined },
        opts(connectedAccountId, idempotencyKey),
      );
      const status = r.status === 'succeeded' ? 'complete' : r.status === 'failed' || r.status === 'canceled' ? 'failed' : 'pending';
      return { id: r.id, status };
    },
    async createCustomer({ connectedAccountId, email, name, metadata, idempotencyKey }) {
      if (!stripe) return { id: fake('cus', idempotencyKey) };
      const c = await stripe.customers.create({ email: email ?? undefined, name: name ?? undefined, metadata }, opts(connectedAccountId, idempotencyKey));
      return { id: c.id };
    },
    async setDefaultPaymentMethod({ connectedAccountId, customerId, paymentMethodId }) {
      if (!stripe || isSandboxId(customerId)) return;
      await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } }, opts(connectedAccountId));
    },
    async retrievePaymentMethod(id, acct) {
      if (!stripe || isSandboxId(id)) return { brand: 'visa', last4: '4242', expMonth: 12, expYear: new Date().getUTCFullYear() + 3 };
      const pm = await stripe.paymentMethods.retrieve(id, {}, opts(acct));
      const card = pm.card;
      return card ? { brand: card.brand ?? null, last4: card.last4 ?? null, expMonth: card.exp_month ?? null, expYear: card.exp_year ?? null } : { brand: pm.type, last4: null, expMonth: null, expYear: null };
    },
    async createSetupIntent({ connectedAccountId, customerId, metadata, idempotencyKey }) {
      if (!stripe || isSandboxId(customerId)) {
        const id = `seti_sandbox_${randomToken(10)}`;
        return { id, clientSecret: `${id}_secret_sandbox` };
      }
      const si = await stripe.setupIntents.create({ customer: customerId, usage: 'off_session', automatic_payment_methods: { enabled: true }, metadata }, opts(connectedAccountId, idempotencyKey));
      return { id: si.id, clientSecret: si.client_secret };
    },
    async ensureRecurringPrice({ connectedAccountId, lookupKey, productName, amountMinor, currency, interval, metadata }) {
      if (!stripe) return { productId: fake('prod', `${connectedAccountId}:${lookupKey}`), priceId: fake('price', `${connectedAccountId}:${lookupKey}`) };
      const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 }, opts(connectedAccountId));
      const hit = existing.data[0];
      if (hit) return { productId: typeof hit.product === 'string' ? hit.product : hit.product.id, priceId: hit.id };
      const product = await stripe.products.create({ name: productName, metadata }, opts(connectedAccountId, `product:${lookupKey}`));
      const price = await stripe.prices.create({ product: product.id, currency: currency.toLowerCase(), unit_amount: amountMinor, recurring: { interval }, lookup_key: lookupKey, metadata }, opts(connectedAccountId, `price:${lookupKey}`));
      return { productId: product.id, priceId: price.id };
    },
    async createSubscription(i) {
      if (!stripe || isSandboxId(i.customerId)) return { id: fake('sub', i.idempotencyKey), status: i.collectFirstPayment ? 'incomplete' : 'trialing', clientSecret: i.collectFirstPayment ? `pi_sandbox_${randomToken(8)}_secret_sandbox` : null };
      const sub = await stripe.subscriptions.create({
        customer: i.customerId,
        items: [{ price: i.priceId }],
        ...(i.defaultPaymentMethodId ? { default_payment_method: i.defaultPaymentMethodId } : {}),
        ...(i.trialEnd ? { trial_end: Math.floor(i.trialEnd.getTime() / 1000) } : {}),
        ...(i.collectFirstPayment ? { payment_behavior: 'default_incomplete' as const, expand: ['latest_invoice.confirmation_secret'] } : { off_session: true }),
        payment_settings: { save_default_payment_method: 'on_subscription' },
        ...(i.connectedAccountId && i.applicationFeePercent > 0 ? { application_fee_percent: i.applicationFeePercent } : {}),
        metadata: i.metadata,
      }, opts(i.connectedAccountId, i.idempotencyKey));
      const inv = sub.latest_invoice && typeof sub.latest_invoice !== 'string' ? sub.latest_invoice : null;
      return { id: sub.id, status: sub.status, clientSecret: inv?.confirmation_secret?.client_secret ?? null };
    },
    async updateSubscriptionPaymentMethod({ connectedAccountId, subscriptionId, paymentMethodId }) {
      if (!stripe || isSandboxId(subscriptionId)) return;
      await stripe.subscriptions.update(subscriptionId, { default_payment_method: paymentMethodId }, opts(connectedAccountId));
    },
    async payOpenInvoices({ connectedAccountId, subscriptionId }) {
      if (!stripe || isSandboxId(subscriptionId)) return 0;
      const open = await stripe.invoices.list({ subscription: subscriptionId, status: 'open', limit: 5 }, opts(connectedAccountId));
      let paid = 0;
      for (const inv of open.data) {
        if (!inv.id) continue;
        try {
          await stripe.invoices.pay(inv.id, { off_session: true }, opts(connectedAccountId));
          paid++;
        } catch (err) {
          log.warn({ err: (err as Error).message, invoice: inv.id }, '[stripe] invoice retry failed');
        }
      }
      return paid;
    },
    async chargeOffSession(i) {
      if (!stripe || isSandboxId(i.customerId)) {
        // Sandbox: deterministic outcomes driven by the saved method id (pm_sandbox_decline / pm_sandbox_sca).
        const id = `pi_sandbox_${randomToken(12)}`;
        if (i.paymentMethodId.includes('decline')) return { id, status: 'failed', clientSecret: `${id}_secret_sandbox`, failureCode: 'card_declined', failureMessage: 'Your card was declined (sandbox).' };
        if (i.paymentMethodId.includes('sca')) return { id, status: 'requires_action', clientSecret: `${id}_secret_sandbox`, failureCode: 'authentication_required', failureMessage: 'Your bank asks you to confirm this payment (sandbox).' };
        return { id, status: 'succeeded', clientSecret: `${id}_secret_sandbox` };
      }
      try {
        const pi = await stripe.paymentIntents.create({
          amount: i.amountMinor, currency: i.currency.toLowerCase(), customer: i.customerId, payment_method: i.paymentMethodId, off_session: true, confirm: true,
          metadata: i.metadata, description: i.description,
          ...(i.connectedAccountId && i.applicationFeeMinor > 0 ? { application_fee_amount: i.applicationFeeMinor } : {}),
        }, opts(i.connectedAccountId, i.idempotencyKey));
        const status = pi.status === 'succeeded' ? 'succeeded' : pi.status === 'requires_action' ? 'requires_action' : pi.status === 'processing' ? 'processing' : 'failed';
        return { id: pi.id, status, clientSecret: pi.client_secret };
      } catch (err) {
        const e = err as { type?: string; code?: string; message?: string; raw?: { payment_intent?: { id?: string; client_secret?: string; status?: string } }; payment_intent?: { id?: string; client_secret?: string; status?: string } };
        const pi = e.raw?.payment_intent ?? e.payment_intent;
        if (e.type !== 'StripeCardError' && !pi) throw err;
        const sca = e.code === 'authentication_required' || pi?.status === 'requires_action';
        return { id: pi?.id ?? null, status: sca ? 'requires_action' : 'failed', clientSecret: pi?.client_secret ?? null, failureCode: e.code ?? 'card_error', failureMessage: e.message ?? 'The card was declined' };
      }
    },
    constructWebhookEvent(rawBody, signature, source) {
      return verifyStripeWebhook(cfg, rawBody, signature, source ?? 'auto').event;
    },
  };
}

/** Test helper: produce a valid Stripe-Signature header for a payload. */
export function signStripePayload(payload: string, secret: string): string {
  const stripe = new Stripe('sk_test_sandbox_placeholder');
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

import Stripe from 'stripe';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';
import { randomToken } from '../lib/crypto.ts';

export interface CreateIntentInput {
  amountMinor: number;
  currency: string;
  connectedAccountId: string | null;
  applicationFeeMinor: number;
  metadata: Record<string, string>;
  idempotencyKey: string;
  description?: string;
}

export interface PaymentsProvider {
  readonly mode: 'live' | 'sandbox';
  readonly webhooksEnabled: boolean;
  createConnectedAccount(input: { country: string; email?: string | null; businessName: string }): Promise<{ accountId: string }>;
  createOnboardingLink(accountId: string, refreshUrl: string, returnUrl: string): Promise<{ url: string; expiresAt: Date | null }>;
  getAccountStatus(accountId: string): Promise<{ chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }>;
  createPaymentIntent(input: CreateIntentInput): Promise<{ id: string; clientSecret: string | null; status: string }>;
  cancelPaymentIntent(id: string, connectedAccountId: string | null): Promise<void>;
  createRefund(input: { paymentIntentId: string; amountMinor: number; connectedAccountId: string | null; idempotencyKey: string; reason?: string }): Promise<{ id: string; status: 'pending' | 'complete' | 'failed' }>;
  /** Verifies the Stripe-Signature header and returns the parsed event. Throws on failure. */
  constructWebhookEvent(rawBody: Buffer | string, signature: string): Stripe.Event;
}

/**
 * Stripe Connect adapter (direct charges on connected accounts with an application fee).
 * Without STRIPE_SECRET_KEY it runs in sandbox mode: deterministic fake ids, no network calls.
 * Webhook verification requires STRIPE_WEBHOOK_SECRET in every mode — unsigned events are rejected.
 */
export function createPaymentsProvider(cfg: Config, log: FastifyBaseLogger): PaymentsProvider {
  const live = !!cfg.STRIPE_SECRET_KEY;
  // A client is still needed for signature verification in sandbox mode; it makes no network calls for that.
  const stripe = new Stripe(cfg.STRIPE_SECRET_KEY ?? 'sk_test_sandbox_placeholder', { maxNetworkRetries: 2, appInfo: { name: 'BranchHarbor' } });
  if (!live) log.warn('[stripe] STRIPE_SECRET_KEY not set — payments run in SANDBOX mode (no real charges)');
  if (!cfg.STRIPE_WEBHOOK_SECRET) log.warn('[stripe] STRIPE_WEBHOOK_SECRET not set — webhook endpoint will reject events');
  const opts = (acct: string | null, idem?: string): Stripe.RequestOptions => ({ ...(acct ? { stripeAccount: acct } : {}), ...(idem ? { idempotencyKey: idem } : {}) });

  return {
    mode: live ? 'live' : 'sandbox',
    webhooksEnabled: !!cfg.STRIPE_WEBHOOK_SECRET,
    async createConnectedAccount({ country, email, businessName }) {
      if (!live) return { accountId: `acct_sandbox_${randomToken(8)}` };
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
      if (!live) return { url: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}sandbox_account=${accountId}`, expiresAt: null };
      const link = await stripe.accountLinks.create({ account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' });
      return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
    },
    async getAccountStatus(accountId) {
      if (!live) return { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };
      const a = await stripe.accounts.retrieve(accountId);
      return { chargesEnabled: !!a.charges_enabled, payoutsEnabled: !!a.payouts_enabled, detailsSubmitted: !!a.details_submitted };
    },
    async createPaymentIntent(input) {
      if (!live) {
        const id = `pi_sandbox_${randomToken(12)}`;
        return { id, clientSecret: `${id}_secret_sandbox`, status: 'requires_payment_method' };
      }
      const pi = await stripe.paymentIntents.create(
        {
          amount: input.amountMinor,
          currency: input.currency.toLowerCase(),
          automatic_payment_methods: { enabled: true },
          metadata: input.metadata,
          description: input.description,
          ...(input.connectedAccountId && input.applicationFeeMinor > 0 ? { application_fee_amount: input.applicationFeeMinor } : {}),
        },
        opts(input.connectedAccountId, input.idempotencyKey),
      );
      return { id: pi.id, clientSecret: pi.client_secret, status: pi.status };
    },
    async cancelPaymentIntent(id, acct) {
      if (!live) return;
      await stripe.paymentIntents.cancel(id, {}, opts(acct));
    },
    async createRefund({ paymentIntentId, amountMinor, connectedAccountId, idempotencyKey, reason }) {
      if (!live) return { id: `re_sandbox_${randomToken(10)}`, status: 'complete' };
      const r = await stripe.refunds.create(
        { payment_intent: paymentIntentId, amount: amountMinor, metadata: reason ? { reason } : undefined },
        opts(connectedAccountId, idempotencyKey),
      );
      const status = r.status === 'succeeded' ? 'complete' : r.status === 'failed' || r.status === 'canceled' ? 'failed' : 'pending';
      return { id: r.id, status };
    },
    constructWebhookEvent(rawBody, signature) {
      if (!cfg.STRIPE_WEBHOOK_SECRET) throw new Error('Webhook secret not configured');
      return stripe.webhooks.constructEvent(rawBody, signature, cfg.STRIPE_WEBHOOK_SECRET);
    },
  };
}

/** Test helper: produce a valid Stripe-Signature header for a payload. */
export function signStripePayload(payload: string, secret: string): string {
  const stripe = new Stripe('sk_test_sandbox_placeholder');
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

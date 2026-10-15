/**
 * Royalty collection and payout data from Stripe (docs/API_INTEGRATIONS.md "Finance: royalty collection").
 *
 * Mechanism: the franchisor's own connected account (the "collection account") is the merchant. Each franchisee
 * (owner group) is a Stripe Customer on that account; a SetupIntent saves a card or a bank-debit method together with
 * the mandate the franchisee accepted (ACH, Canadian PAD, Bacs, SEPA, BECS by currency). Royalty invoices are then
 * charged off-session as direct charges on the collection account, so funds land with the franchisor and never on the
 * BranchHarbor platform balance. Connect account debits / transfers from the franchisee's connected account are not
 * used: their funds would arrive on the platform (not the franchisor), they are limited to same-region accounts, and
 * holding a franchisor's money on the platform is a money-transmission question we do not take on.
 *
 * Without STRIPE_SECRET_KEY everything runs in sandbox mode: deterministic ids, no network. Sandbox payment methods
 * carry their outcome in the id (`…_decline` fails, bank debits stay `processing` until settled).
 */
import type Stripe from 'stripe';
import type { PaymentsProvider } from './payments.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';

export type DebitMethodType = 'card' | 'us_bank_account' | 'acss_debit' | 'bacs_debit' | 'sepa_debit' | 'au_becs_debit';

/** Methods offered for a currency: card everywhere, plus the local bank debit scheme. */
export function methodTypesFor(currency: string): DebitMethodType[] {
  const bank: Record<string, DebitMethodType> = { USD: 'us_bank_account', CAD: 'acss_debit', GBP: 'bacs_debit', EUR: 'sepa_debit', AUD: 'au_becs_debit' };
  const b = bank[currency.toUpperCase()];
  return b ? ['card', b] : ['card'];
}

export interface DebitResult { id: string; status: 'succeeded' | 'processing' | 'requires_action' | 'failed'; failureCode?: string | null; failureMessage?: string | null }

export interface ProviderPayout {
  id: string; currency: string; amountMinor: number; status: string; arrivalDate: string | null;
  transactions: Array<{ id: string; type: string; sourcePaymentIntent: string | null; sourceId: string | null; amountMinor: number; feeMinor: number; netMinor: number }>;
}

export interface CollectionAdapter {
  readonly mode: 'live' | 'sandbox';
  ensureCustomer(input: { accountId: string | null; name: string; email: string | null; metadata: Record<string, string>; idempotencyKey: string }): Promise<{ id: string }>;
  createSetupIntent(input: { accountId: string | null; customerId: string; methodType: DebitMethodType; currency: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<{ id: string; clientSecret: string | null }>;
  retrieveSetupIntent(input: { accountId: string | null; id: string }): Promise<{ status: string; paymentMethodId: string | null; display: { brand?: string | null; last4?: string | null; bankName?: string | null } }>;
  debit(input: { accountId: string | null; customerId: string; paymentMethodId: string; methodType: DebitMethodType; amountMinor: number; currency: string; metadata: Record<string, string>; idempotencyKey: string; description: string }): Promise<DebitResult>;
  /** Recent payouts of a connected account with their balance transactions (live mode only). */
  listPayouts(accountId: string, limit?: number): Promise<ProviderPayout[]>;
}

const isSandboxId = (id: string | null | undefined) => !id || id.includes('_sandbox_');

export function createCollectionAdapter(payments: PaymentsProvider): CollectionAdapter {
  const stripe = payments.mode === 'live' ? payments.client : null;
  const opts = (acct: string | null, idem?: string): Stripe.RequestOptions => ({ ...(acct ? { stripeAccount: acct } : {}), ...(idem ? { idempotencyKey: idem } : {}) });
  const fake = (prefix: string, seed: string) => `${prefix}_sandbox_${sha256(seed).slice(0, 14)}`;

  return {
    mode: stripe ? 'live' : 'sandbox',
    async ensureCustomer({ accountId, name, email, metadata, idempotencyKey }) {
      if (!stripe) return { id: fake('cus', idempotencyKey) };
      const c = await stripe.customers.create({ name, email: email ?? undefined, metadata }, opts(accountId, idempotencyKey));
      return { id: c.id };
    },
    async createSetupIntent({ accountId, customerId, methodType, currency, metadata, idempotencyKey }) {
      if (!stripe || isSandboxId(customerId)) {
        const id = `seti_sandbox_${randomToken(10)}`;
        return { id, clientSecret: `${id}_secret_sandbox` };
      }
      const options: Stripe.SetupIntentCreateParams.PaymentMethodOptions = {};
      if (methodType === 'acss_debit') options.acss_debit = { currency: currency.toLowerCase() as 'cad', mandate_options: { payment_schedule: 'sporadic', transaction_type: 'business' } };
      if (methodType === 'us_bank_account') options.us_bank_account = { verification_method: 'automatic' };
      const si = await stripe.setupIntents.create({ customer: customerId, usage: 'off_session', allowed_payment_method_types: [methodType as Stripe.SetupIntentCreateParams.AllowedPaymentMethodType], payment_method_options: options, metadata }, opts(accountId, idempotencyKey));
      return { id: si.id, clientSecret: si.client_secret };
    },
    async retrieveSetupIntent({ accountId, id }) {
      if (!stripe || isSandboxId(id)) return { status: 'requires_payment_method', paymentMethodId: null, display: {} };
      const si = await stripe.setupIntents.retrieve(id, { expand: ['payment_method'] }, opts(accountId));
      const pm = si.payment_method && typeof si.payment_method !== 'string' ? si.payment_method : null;
      const bank = pm?.us_bank_account ?? pm?.acss_debit ?? pm?.bacs_debit ?? pm?.sepa_debit ?? pm?.au_becs_debit ?? null;
      return {
        status: si.status,
        paymentMethodId: typeof si.payment_method === 'string' ? si.payment_method : pm?.id ?? null,
        display: { brand: pm?.card?.brand ?? null, last4: pm?.card?.last4 ?? (bank as { last4?: string } | null)?.last4 ?? null, bankName: (bank as { bank_name?: string } | null)?.bank_name ?? null },
      };
    },
    async debit(i) {
      if (!stripe || isSandboxId(i.customerId)) {
        const id = `pi_sandbox_${randomToken(12)}`;
        if (i.paymentMethodId.includes('decline')) return { id, status: 'failed', failureCode: i.methodType === 'card' ? 'card_declined' : 'insufficient_funds', failureMessage: 'The payment was declined (sandbox).' };
        return { id, status: i.methodType === 'card' ? 'succeeded' : 'processing' };
      }
      try {
        const pi = await stripe.paymentIntents.create({
          amount: i.amountMinor, currency: i.currency.toLowerCase(), customer: i.customerId, payment_method: i.paymentMethodId, allowed_payment_method_types: [i.methodType as Stripe.PaymentIntentCreateParams.AllowedPaymentMethodType],
          off_session: true, confirm: true, metadata: i.metadata, description: i.description,
        }, opts(i.accountId, i.idempotencyKey));
        const status = pi.status === 'succeeded' ? 'succeeded' : pi.status === 'processing' ? 'processing' : pi.status === 'requires_action' ? 'requires_action' : 'failed';
        return { id: pi.id, status, failureCode: pi.last_payment_error?.code ?? null, failureMessage: pi.last_payment_error?.message ?? null };
      } catch (err) {
        const e = err as { type?: string; code?: string; message?: string; raw?: { payment_intent?: { id?: string } } };
        if (e.type !== 'StripeCardError' && !e.raw?.payment_intent) throw err;
        return { id: e.raw?.payment_intent?.id ?? `pi_failed_${randomToken(8)}`, status: 'failed', failureCode: e.code ?? 'payment_failed', failureMessage: e.message ?? 'The payment failed' };
      }
    },
    async listPayouts(accountId, limit = 20) {
      if (!stripe || isSandboxId(accountId)) return [];
      const out: ProviderPayout[] = [];
      const payouts = await stripe.payouts.list({ limit }, opts(accountId));
      for (const po of payouts.data) {
        const txns = await stripe.balanceTransactions.list({ payout: po.id, limit: 100, expand: ['data.source'] }, opts(accountId));
        out.push({
          id: po.id, currency: po.currency.toUpperCase(), amountMinor: po.amount, status: po.status,
          arrivalDate: po.arrival_date ? new Date(po.arrival_date * 1000).toISOString().slice(0, 10) : null,
          transactions: txns.data.filter((t) => t.type !== 'payout').map((t) => {
            const src = t.source && typeof t.source !== 'string' ? (t.source as { id: string; object?: string; payment_intent?: string | { id: string } | null; charge?: string | { payment_intent?: string | { id: string } | null } | null }) : null;
            const piOf = (x: unknown) => (typeof x === 'string' ? x : (x as { id?: string } | null)?.id ?? null);
            const pi = src?.object === 'charge' ? piOf(src.payment_intent) : src?.object === 'refund' || src?.object === 'dispute' ? piOf(src.payment_intent) ?? piOf((src.charge as { payment_intent?: unknown } | null)?.payment_intent) : null;
            const type = ['charge', 'payment'].includes(t.type) ? 'charge' : ['refund', 'payment_refund', 'payment_failure_refund'].includes(t.type) ? 'refund'
              : t.reporting_category === 'dispute' || t.reporting_category === 'dispute_reversal' || t.type === 'adjustment' && src?.object === 'dispute' ? 'dispute'
                : ['stripe_fee', 'application_fee', 'tax_fee'].includes(t.type) ? 'fee' : t.type === 'adjustment' ? 'adjustment' : 'other';
            return { id: t.id, type, sourcePaymentIntent: pi, sourceId: src?.id ?? (typeof t.source === 'string' ? t.source : null), amountMinor: t.amount, feeMinor: t.fee, netMinor: t.net };
          }),
        });
      }
      return out;
    },
  };
}

import Stripe from 'stripe';
import type { Config } from '../config.ts';
import { randomToken } from '../lib/crypto.ts';

/**
 * Recurring membership billing: Stripe Billing subscriptions created on the location's connected account
 * (direct, like class payments). Without STRIPE_SECRET_KEY it runs in SANDBOX mode: fake ids and no
 * network calls; renewals are then produced by BranchHarbor's own lifecycle sweep (and can be simulated).
 *
 * Live flow: the first month is paid with a normal PaymentIntent at checkout; the subscription is then
 * created with `trial_end` = end of that first period so Stripe bills from month two. Outcomes arrive as
 * signed `invoice.paid` / `invoice.payment_failed` / `customer.subscription.deleted` webhooks.
 */
export interface StudioBilling {
  readonly mode: 'live' | 'sandbox';
  createSubscription(input: {
    connectedAccountId: string | null; email: string | null; name: string; amountMinor: number; currency: string; productName: string;
    firstBillingAt: Date; applicationFeePercent: number; metadata: Record<string, string>; idempotencyKey: string;
  }): Promise<{ customerId: string; subscriptionId: string }>;
  cancelSubscription(input: { subscriptionId: string; connectedAccountId: string | null; at: Date | 'now' }): Promise<void>;
  pauseCollection(input: { subscriptionId: string; connectedAccountId: string | null; resumesAt: Date | null }): Promise<void>;
}

const cache = new WeakMap<Config, StudioBilling>();

export function studioBilling(cfg: Config): StudioBilling {
  const hit = cache.get(cfg);
  if (hit) return hit;
  const live = !!cfg.STRIPE_SECRET_KEY;
  const stripe = live ? new Stripe(cfg.STRIPE_SECRET_KEY!, { maxNetworkRetries: 2, appInfo: { name: 'BranchHarbor' } }) : null;
  const opts = (acct: string | null, idem?: string): Stripe.RequestOptions => ({ ...(acct ? { stripeAccount: acct } : {}), ...(idem ? { idempotencyKey: idem } : {}) });
  const impl: StudioBilling = {
    mode: live ? 'live' : 'sandbox',
    async createSubscription(i) {
      if (!stripe) return { customerId: `cus_sandbox_${randomToken(8)}`, subscriptionId: `sub_sandbox_${randomToken(10)}` };
      const customer = await stripe.customers.create({ email: i.email ?? undefined, name: i.name, metadata: i.metadata }, opts(i.connectedAccountId, `${i.idempotencyKey}:customer`));
      const product = await stripe.products.create({ name: i.productName, metadata: i.metadata }, opts(i.connectedAccountId, `${i.idempotencyKey}:product`));
      const sub = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price_data: { currency: i.currency.toLowerCase(), product: product.id, unit_amount: i.amountMinor, recurring: { interval: 'month' } } }],
        trial_end: Math.floor(i.firstBillingAt.getTime() / 1000),
        payment_settings: { save_default_payment_method: 'on_subscription' },
        ...(i.connectedAccountId && i.applicationFeePercent > 0 ? { application_fee_percent: i.applicationFeePercent } : {}),
        metadata: i.metadata,
      }, opts(i.connectedAccountId, `${i.idempotencyKey}:subscription`));
      return { customerId: customer.id, subscriptionId: sub.id };
    },
    async cancelSubscription({ subscriptionId, connectedAccountId, at }) {
      if (!stripe || subscriptionId.startsWith('sub_sandbox_')) return;
      if (at === 'now') await stripe.subscriptions.cancel(subscriptionId, {}, opts(connectedAccountId));
      else await stripe.subscriptions.update(subscriptionId, { cancel_at: Math.floor(at.getTime() / 1000) }, opts(connectedAccountId));
    },
    async pauseCollection({ subscriptionId, connectedAccountId, resumesAt }) {
      if (!stripe || subscriptionId.startsWith('sub_sandbox_')) return;
      await stripe.subscriptions.update(subscriptionId, resumesAt ? { pause_collection: { behavior: 'void', resumes_at: Math.floor(resumesAt.getTime() / 1000) } } : { pause_collection: null }, opts(connectedAccountId));
    },
  };
  cache.set(cfg, impl);
  return impl;
}

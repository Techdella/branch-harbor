import type Stripe from 'stripe';
import type { Services } from '../context.ts';

/**
 * Recurring membership billing: Stripe Billing subscriptions created on the location's connected account
 * (direct, like class payments). Without STRIPE_SECRET_KEY it runs in SANDBOX mode: fake ids and no
 * network calls; renewals are then produced by BranchHarbor's own lifecycle sweep (and can be simulated).
 *
 * Live flow: the first month is paid with a normal PaymentIntent at checkout with `setup_future_usage`
 * (the member consents to renewals); the subscription is then created by services/payments-saved.ts with
 * the saved card as default and `trial_end` = end of that first period so Stripe bills from month two.
 * Outcomes arrive as signed Connect webhooks (`invoice.paid` / `invoice.payment_failed` /
 * `customer.subscription.updated|deleted`).
 */
export interface StudioBilling {
  readonly mode: 'live' | 'sandbox';
  cancelSubscription(input: { subscriptionId: string; connectedAccountId: string | null; at: Date | 'now' }): Promise<void>;
  pauseCollection(input: { subscriptionId: string; connectedAccountId: string | null; resumesAt: Date | null }): Promise<void>;
}

export function studioBilling(s: Pick<Services, 'payments'>): StudioBilling {
  const stripe: Stripe | null = s.payments.client;
  const opts = (acct: string | null): Stripe.RequestOptions => (acct ? { stripeAccount: acct } : {});
  return {
    mode: s.payments.mode,
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
}

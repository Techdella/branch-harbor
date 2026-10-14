/**
 * Recurring meal-plan billing on Stripe Billing (weekly subscriptions on the business's connected account).
 * Subscriptions are created by services/foods-mealplans.ts through the payments provider (shared Stripe Customer per
 * customer and account, one recurring price per plan/currency). This adapter covers the later lifecycle calls.
 * Without STRIPE_SECRET_KEY it runs in SANDBOX mode: no network calls; the sandbox "activate" endpoint feeds a
 * synthetic `invoice.paid` event through the normal webhook processor.
 */
import type Stripe from 'stripe';
import { randomToken } from '../lib/crypto.ts';
import type { Services } from '../context.ts';

export interface SubscriptionProvider {
  readonly mode: 'live' | 'sandbox';
  pause(id: string, connectedAccountId: string | null): Promise<void>;
  resume(id: string, connectedAccountId: string | null): Promise<void>;
  cancel(id: string, connectedAccountId: string | null): Promise<void>;
  /** A skipped week: credit the next invoice by one week's price (customer balance). */
  creditWeek(id: string, amountMinor: number, currency: string, connectedAccountId: string | null, idempotencyKey: string): Promise<{ creditId: string }>;
}

function create(stripe: Stripe | null): SubscriptionProvider {
  const sandboxId = (id: string) => id.startsWith('sub_sandbox_');
  const ro = (acct: string | null, idem?: string): Stripe.RequestOptions => ({ ...(acct ? { stripeAccount: acct } : {}), ...(idem ? { idempotencyKey: idem } : {}) });
  return {
    mode: stripe ? 'live' : 'sandbox',
    async pause(id, acct) { if (stripe && !sandboxId(id)) await stripe.subscriptions.update(id, { pause_collection: { behavior: 'void' } }, ro(acct)); },
    async resume(id, acct) { if (stripe && !sandboxId(id)) await stripe.subscriptions.update(id, { pause_collection: null }, ro(acct)); },
    async cancel(id, acct) { if (stripe && !sandboxId(id)) await stripe.subscriptions.cancel(id, {}, ro(acct)); },
    async creditWeek(id, amountMinor, currency, acct, idem) {
      if (!stripe || sandboxId(id)) return { creditId: `cbtxn_sandbox_${randomToken(8)}` };
      const sub = await stripe.subscriptions.retrieve(id, {}, ro(acct));
      const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const tx = await stripe.customers.createBalanceTransaction(customer, { amount: -amountMinor, currency: currency.toLowerCase(), description: 'Skipped week' }, ro(acct, idem));
      return { creditId: tx.id };
    },
  };
}

const cache = new WeakMap<object, SubscriptionProvider>();
let override: SubscriptionProvider | null = null;

/** Provider for this service container (tests may replace it with `setSubscriptionProvider`). */
export function subscriptionProvider(s: Pick<Services, 'payments'>): SubscriptionProvider {
  if (override) return override;
  let p = cache.get(s.payments);
  if (!p) {
    p = create(s.payments.client);
    cache.set(s.payments, p);
  }
  return p;
}

export function setSubscriptionProvider(p: SubscriptionProvider | null) {
  override = p;
}

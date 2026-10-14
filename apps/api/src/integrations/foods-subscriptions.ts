/**
 * Recurring meal-plan billing on Stripe Billing (weekly subscriptions on the business's connected account).
 * Without STRIPE_SECRET_KEY it runs in SANDBOX mode: fake `sub_sandbox_*` ids and no network calls; the
 * sandbox "activate" endpoint feeds a synthetic `invoice.paid` event through the normal webhook processor.
 */
import Stripe from 'stripe';
import { randomToken } from '../lib/crypto.ts';
import type { Services } from '../context.ts';

export interface SubscriptionProvider {
  readonly mode: 'live' | 'sandbox';
  create(input: { email: string; name: string; productName: string; amountMinor: number; currency: string; connectedAccountId: string | null; metadata: Record<string, string>; idempotencyKey: string }): Promise<{ id: string; clientSecret: string | null; status: string }>;
  pause(id: string, connectedAccountId: string | null): Promise<void>;
  resume(id: string, connectedAccountId: string | null): Promise<void>;
  cancel(id: string, connectedAccountId: string | null): Promise<void>;
  /** A skipped week: credit the next invoice by one week's price (customer balance). */
  creditWeek(id: string, amountMinor: number, currency: string, connectedAccountId: string | null, idempotencyKey: string): Promise<{ creditId: string }>;
}

function create(secret: string | undefined): SubscriptionProvider {
  if (!secret) {
    return {
      mode: 'sandbox',
      async create() { return { id: `sub_sandbox_${randomToken(10)}`, clientSecret: `seti_sandbox_${randomToken(8)}_secret`, status: 'incomplete' }; },
      async pause() {}, async resume() {}, async cancel() {},
      async creditWeek() { return { creditId: `cbtxn_sandbox_${randomToken(8)}` }; },
    };
  }
  const stripe = new Stripe(secret, { maxNetworkRetries: 2, appInfo: { name: 'BranchHarbor' } });
  const ro = (acct: string | null, idem?: string): Stripe.RequestOptions => ({ ...(acct ? { stripeAccount: acct } : {}), ...(idem ? { idempotencyKey: idem } : {}) });
  return {
    mode: 'live',
    async create(input) {
      const customer = await stripe.customers.create({ email: input.email, name: input.name, metadata: input.metadata }, ro(input.connectedAccountId, `${input.idempotencyKey}:customer`));
      const product = await stripe.products.create({ name: input.productName, metadata: input.metadata }, ro(input.connectedAccountId, `${input.idempotencyKey}:product`));
      const sub = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price_data: { currency: input.currency.toLowerCase(), product: product.id, recurring: { interval: 'week' }, unit_amount: input.amountMinor } }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        metadata: input.metadata,
        expand: ['latest_invoice.confirmation_secret'],
      }, ro(input.connectedAccountId, input.idempotencyKey));
      const inv = sub.latest_invoice && typeof sub.latest_invoice !== 'string' ? sub.latest_invoice : null;
      return { id: sub.id, clientSecret: inv?.confirmation_secret?.client_secret ?? null, status: sub.status };
    },
    async pause(id, acct) { await stripe.subscriptions.update(id, { pause_collection: { behavior: 'void' } }, ro(acct)); },
    async resume(id, acct) { await stripe.subscriptions.update(id, { pause_collection: null }, ro(acct)); },
    async cancel(id, acct) { await stripe.subscriptions.cancel(id, {}, ro(acct)); },
    async creditWeek(id, amountMinor, currency, acct, idem) {
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
export function subscriptionProvider(s: Pick<Services, 'cfg'>): SubscriptionProvider {
  if (override) return override;
  let p = cache.get(s.cfg);
  if (!p) {
    p = create(s.cfg.STRIPE_SECRET_KEY || undefined);
    cache.set(s.cfg, p);
  }
  return p;
}

export function setSubscriptionProvider(p: SubscriptionProvider | null) {
  override = p;
}

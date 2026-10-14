// iOS / Android: Stripe PaymentSheet for every customer payment (direct charges on the location's connected account).
import { initPaymentSheet, initStripe, presentPaymentSheet } from '@stripe/stripe-react-native';
import { env } from './env';
import { http } from './http';
import { paymentView, requiredConsent, RETURN_URL, sandboxPay, unavailable, waitForPayment, englishT, type PayablePayment, type PaymentView, type PayResult, type Translate } from './cardPayment.shared';

export * from './cardPayment.shared';

const MERCHANT_ID = process.env.EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER || 'merchant.com.branchharbor.app';

/** Point the SDK at the publishable key the API returned and the connected account of this payment. */
async function selectAccount(publishableKey: string, stripeAccount: string | null) {
  await initStripe({ publishableKey, ...(stripeAccount ? { stripeAccountId: stripeAccount } : {}), merchantIdentifier: MERCHANT_ID, urlScheme: 'branchharbor' });
}

async function sheet(view: Pick<PaymentView, 'publishableKey' | 'stripeAccount' | 'merchantDisplayName' | 'merchantCountry'>, secret: { paymentIntentClientSecret: string } | { setupIntentClientSecret: string }, t: Translate): Promise<PayResult> {
  const pk = view.publishableKey || env.stripePublishableKey;
  if (!pk?.startsWith('pk_')) unavailable(t);
  await selectAccount(pk, view.stripeAccount);
  const country = view.merchantCountry ?? 'US';
  const init = await initPaymentSheet({
    ...secret,
    merchantDisplayName: view.merchantDisplayName || 'BranchHarbor',
    returnURL: RETURN_URL,
    applePay: { merchantCountryCode: country },
    googlePay: { merchantCountryCode: country, testEnv: pk.startsWith('pk_test_') },
    allowsDelayedPaymentMethods: false,
  });
  if (init.error) return { ok: false, message: init.error.localizedMessage ?? init.error.message };
  const res = await presentPaymentSheet();
  if (res.error) return res.error.code === 'Canceled' ? { ok: false, cancelled: true, message: t('pay.cancelled') } : { ok: false, message: res.error.localizedMessage ?? res.error.message };
  return { ok: true };
}

/**
 * Pay a booking/order/purchase. Sandbox API → labelled simulation through the same webhook processor.
 * Live → PaymentSheet (cards, Apple Pay / Google Pay, 3-D Secure in the sheet); then wait for the server to
 * confirm from the signed webhook — the app never marks anything paid itself.
 */
export async function payPayment(p: PayablePayment, t: Translate = englishT): Promise<PayResult> {
  const view = await paymentView(p.id);
  if (view.state === 'succeeded') return { ok: true };
  if (view.mode === 'sandbox') return sandboxPay(view, t);
  if (!view.cardEntryAvailable || !p.clientSecret) unavailable(t);
  if (!(await requiredConsent(view, t))) return { ok: false, cancelled: true, message: t('pay.cancelled') };
  const r = await sheet(view, { paymentIntentClientSecret: p.clientSecret }, t);
  if (!r.ok) return r;
  return waitForPayment(p.id, t);
}

/** Native: card entry is available whenever the API is live (key from the API) — the web build is different. */
export const nativeCardEntry = true;

/** Add or update the saved card for a location (SetupIntent in PaymentSheet). */
export async function updateCard(locationId: string, consentText: string, t: Translate = englishT): Promise<PayResult> {
  const s = await http<{ setupIntentId: string; clientSecret: string | null; publishableKey: string | null; stripeAccount: string | null; merchantDisplayName: string; merchantCountry: string; sandbox: boolean; sandboxToken: string | null; paymentCustomerId: string }>('POST', '/me/payment-methods/setup', { locationId, purposes: ['save_card', 'renewals', 'fees'], text: consentText });
  if (s.sandbox) {
    await http('POST', `/public/payments/setup/${s.setupIntentId}/sandbox-complete`, { paymentCustomerId: s.paymentCustomerId, token: s.sandboxToken, card: 'ok' }, { auth: false });
    return { ok: true };
  }
  if (!s.clientSecret) unavailable(t);
  return sheet({ publishableKey: s.publishableKey, stripeAccount: s.stripeAccount, merchantDisplayName: s.merchantDisplayName, merchantCountry: s.merchantCountry }, { setupIntentClientSecret: s.clientSecret }, t);
}

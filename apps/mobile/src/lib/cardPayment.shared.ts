import { Alert } from 'react-native';
import { ApiError } from './errors';
import { http } from './http';
import en from '../i18n/en';

/** A payment as the API returns it when a booking/order/purchase needs paying. */
export interface PayablePayment { id: string; sandbox: boolean; clientSecret?: string | null; amount?: number; currency?: string }

/** GET /v1/public/payments/:id — state + card entry configuration (publishable key, connected account). Never a secret. */
export interface PaymentView {
  id: string; state: string; sandbox: boolean; mode: 'live' | 'sandbox'; amount: { amount: number; currency: string };
  publishableKey: string | null; stripeAccount: string | null; merchantDisplayName: string; merchantCountry: string | null; cardEntryAvailable: boolean;
  saveCard: { mode: 'required' | 'optional' | 'none'; purposes: string[]; consented: string[] };
}

export type PayResult = { ok: true } | { ok: false; cancelled?: boolean; pending?: boolean; message: string };
export type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** English fallback when a caller has no translator (feature APIs); screens pass the localized `t`. */
export const englishT: Translate = (key, opts = {}) => {
  let v: unknown = en;
  for (const part of key.split('.')) v = (v as Record<string, unknown> | undefined)?.[part];
  return typeof v === 'string' ? v.replace(/%\{(\w+)\}/g, (_, k: string) => String(opts[k] ?? '')) : key;
};

export const RETURN_URL = 'branchharbor://stripe-redirect';

export const paymentView = (id: string) => http<PaymentView>('GET', `/public/payments/${id}`, undefined, { auth: false });

/** The API only marks a payment succeeded after Stripe's signed webhook: poll it instead of trusting the device. */
export async function waitForPayment(id: string, t: Translate): Promise<PayResult> {
  for (let i = 0; i < 30; i++) {
    const v = await paymentView(id).catch(() => null);
    if (v?.state === 'succeeded') return { ok: true };
    if (v && (v.state === 'failed' || v.state === 'cancelled')) return { ok: false, message: t('pay.failedBody') };
    await new Promise((r) => setTimeout(r, i < 10 ? 1000 : 2000));
  }
  return { ok: false, pending: true, message: t('pay.pending') };
}

const ask = (title: string, body: string, agree: string, cancel: string) =>
  new Promise<boolean>((resolve) => Alert.alert(title, body, [{ text: cancel, style: 'cancel', onPress: () => resolve(false) }, { text: agree, onPress: () => resolve(true) }], { cancelable: true, onDismiss: () => resolve(false) }));

/**
 * Memberships and instalment plans keep the card for later charges: ask for explicit consent and record it
 * (attaches the Stripe Customer + setup_future_usage server side) before the payment sheet opens.
 */
export async function requiredConsent(view: PaymentView, t: Translate): Promise<boolean> {
  if (view.saveCard.mode !== 'required') return true;
  const todo = view.saveCard.purposes.filter((p) => !view.saveCard.consented.includes(p));
  if (!todo.length) return true;
  const business = view.merchantDisplayName;
  const text = todo.map((p) => (p === 'renewals' ? t('pay.consentRenewals', { business }) : t('pay.consentInstalments', { business }))).join(' ');
  const yes = await ask(t('pay.consentTitle'), text, t('pay.agree'), t('common.cancel'));
  if (!yes) return false;
  await http('POST', `/public/payments/${view.id}/save-card`, { purposes: todo, text, source: 'app' }, { auth: false });
  return true;
}

export async function sandboxPay(view: PaymentView, t: Translate): Promise<PayResult> {
  if (!(await requiredConsent(view, t))) return { ok: false, cancelled: true, message: t('pay.cancelled') };
  const r = await http<{ payment: { state: string } }>('POST', `/public/payments/${view.id}/sandbox-confirm`, { outcome: 'succeeded' }, { auth: false });
  return r.payment.state === 'succeeded' ? { ok: true } : { ok: false, message: t('pay.failedBody') };
}

export function unavailable(t: Translate): never {
  throw new ApiError(409, 'card_payments_unavailable', t('pay.unavailable'));
}

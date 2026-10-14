// Web build (Expo web preview): no native PaymentSheet. Sandbox payments are simulated; real card payments are
// done in the iOS/Android app or on the business's hosted website (Stripe Payment Element).
import { ApiError } from './errors';
import { http } from './http';
import { paymentView, sandboxPay, englishT, type PayablePayment, type PayResult, type Translate } from './cardPayment.shared';

export * from './cardPayment.shared';

export async function payPayment(p: PayablePayment, t: Translate = englishT): Promise<PayResult> {
  const view = await paymentView(p.id);
  if (view.state === 'succeeded') return { ok: true };
  if (view.mode === 'sandbox') return sandboxPay(view, t);
  throw new ApiError(409, 'card_payments_web', t('pay.webUseSite'));
}

export const nativeCardEntry = false;

export async function updateCard(locationId: string, consentText: string, t: Translate = englishT): Promise<PayResult> {
  const s = await http<{ setupIntentId: string; sandbox: boolean; sandboxToken: string | null; paymentCustomerId: string }>('POST', '/me/payment-methods/setup', { locationId, purposes: ['save_card', 'renewals', 'fees'], text: consentText });
  if (!s.sandbox) throw new ApiError(409, 'card_payments_web', t('pay.webUseSite'));
  await http('POST', `/public/payments/setup/${s.setupIntentId}/sandbox-complete`, { paymentCustomerId: s.paymentCustomerId, token: s.sandboxToken, card: 'ok' }, { auth: false });
  return { ok: true };
}

'use client';

import type { Stripe, StripeElementLocale } from '@stripe/stripe-js';
import { loadStripe } from '@stripe/stripe-js/pure';

/**
 * Stripe.js for a connected account (direct charges): `loadStripe(pk, { stripeAccount })`. The `pure` entry only
 * injects the script when card entry is actually shown. Resolves to null when Stripe.js can't load (offline, blocked
 * by an extension or network policy) so the UI can show "card payments unavailable" instead of hanging.
 */
const cache = new Map<string, Promise<Stripe | null>>();

const ELEMENT_LOCALES = ['ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'en-GB', 'es', 'es-419', 'et', 'fi', 'fil', 'fr', 'fr-CA', 'he', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'ms', 'mt', 'nb', 'nl', 'pl', 'pt', 'pt-BR', 'ro', 'ru', 'sk', 'sl', 'sv', 'th', 'tr', 'vi', 'zh', 'zh-HK', 'zh-TW'];

export function stripeLocale(locale: string): StripeElementLocale {
  if (ELEMENT_LOCALES.includes(locale)) return locale as StripeElementLocale;
  const base = locale.split('-')[0]!;
  return (ELEMENT_LOCALES.includes(base) ? base : 'auto') as StripeElementLocale;
}

export function getStripe(publishableKey: string, stripeAccount: string | null, locale: string, timeoutMs = 15_000): Promise<Stripe | null> {
  const key = `${publishableKey}|${stripeAccount ?? ''}|${locale}`;
  let p = cache.get(key);
  if (!p) {
    p = Promise.race([
      loadStripe(publishableKey, { ...(stripeAccount ? { stripeAccount } : {}), locale: stripeLocale(locale) }).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]).then((s) => {
      if (!s) cache.delete(key); // allow a retry later
      return s;
    });
    cache.set(key, p);
  }
  return p;
}

/** Map Stripe error codes to our translated messages (Stripe's own message is already localized as a fallback). */
export function paymentErrorKey(e: { type?: string; code?: string; decline_code?: string } | undefined | null): string {
  if (!e) return 'errors.generic';
  const code = e.decline_code ?? e.code ?? '';
  if (code === 'insufficient_funds') return 'errors.insufficient';
  if (code === 'expired_card') return 'errors.expired';
  if (code === 'incorrect_cvc' || code === 'invalid_cvc') return 'errors.cvc';
  if (code === 'processing_error') return 'errors.processing';
  if (code === 'payment_intent_authentication_failure' || code === 'setup_intent_authentication_failure' || code === 'authentication_required') return 'errors.authentication';
  if (code === 'card_declined' || e.type === 'card_error') return 'errors.declined';
  if (e.type === 'validation_error') return 'errors.validation';
  return 'errors.generic';
}

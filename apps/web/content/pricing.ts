import { PLAN_PRICE_KEYS, PRICE_BOOK, annualMonthlyPrice, type PricedCurrency } from '@bh/shared';
import { numberLocale } from '@/lib/intl';

/**
 * List prices come from the shared price book (packages/shared/src/pricing.ts, documented in docs/PRICING.md), so the
 * API subscription and this site always show the same numbers. The currency follows the visitor's location
 * (lib/geo.ts); the language follows the URL. Prices are set per market — not live exchange-rate conversions.
 */
export type PriceCurrency = PricedCurrency;

/** `solo` is one flat price for a single-location business; the others are per location. */
export const PLAN_KEYS = PLAN_PRICE_KEYS;
export type PlanKey = (typeof PLAN_KEYS)[number];

/** Monthly list price in whole units; annual billing includes two months (10 / 12). */
export function perLocationPrice(currency: PriceCurrency, plan: PlanKey, annual: boolean): number {
  const monthly = PRICE_BOOK[currency][plan];
  return annual ? annualMonthlyPrice(monthly) : monthly;
}

/** U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP DIRECTIONAL ISOLATE. */
const ltrIsolate = (s: string) => `⁦${s}⁩`;

/**
 * Formats a list price. The currency symbol is wrapped in a left-to-right isolate so symbols that mix
 * letters and punctuation (US$, A$, CA$) keep their shape inside right-to-left text instead of
 * rendering as "$US".
 */
export function formatPrice(amount: number, currency: PriceCurrency, locale: string): string {
  return new Intl.NumberFormat(numberLocale(locale), { style: 'currency', currency, maximumFractionDigits: 0, minimumFractionDigits: 0 })
    .formatToParts(amount)
    .map((p) => (p.type === 'currency' ? ltrIsolate(p.value) : p.value))
    .join('');
}

/** Localised currency name, e.g. "Nigerian naira" / "naira nigérian". */
export function currencyName(currency: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'currency' }).of(currency) ?? currency;
  } catch {
    return currency;
  }
}

/** Localised country name, e.g. "Germany" / "Allemagne". */
export function countryName(country: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(country) ?? country;
  } catch {
    return country;
  }
}

import { LIST_PRICES_MINOR, PRICED_CURRENCIES } from '@bh/shared';
import { numberLocale } from '@/lib/intl';

/**
 * Static list prices per currency. These are set per currency — not live exchange-rate conversions.
 * Proposed pricing, to be validated before general availability.
 */
export const PRICE_CURRENCIES = PRICED_CURRENCIES;
export type PriceCurrency = (typeof PRICE_CURRENCIES)[number];

/** `solo` is one flat price for a single-location business; the others are per location. */
export const PLAN_KEYS = ['solo', 'connector', 'hosted', 'network'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/**
 * Monthly list prices, whole currency units. Read from @bh/shared so the API subscription (Solo plan, network
 * per-location price) and this page always show the same numbers.
 */
export const LIST_PRICES: Record<PriceCurrency, Record<PlanKey, number>> = Object.fromEntries(
  PRICE_CURRENCIES.map((c) => [c, Object.fromEntries(PLAN_KEYS.map((k) => [k, LIST_PRICES_MINOR[c][k] / 100]))]),
) as Record<PriceCurrency, Record<PlanKey, number>>;

/** Annual billing: two months included (10 / 12), rounded to whole units per location. */
export function perLocationPrice(currency: PriceCurrency, plan: PlanKey, annual: boolean): number {
  const monthly = LIST_PRICES[currency][plan];
  return annual ? Math.round((monthly * 10) / 12) : monthly;
}

/** A sensible default display currency for a UI locale. Visitors can always change it. */
export function defaultCurrencyFor(locale: string): PriceCurrency {
  if (locale === 'en-GB') return 'GBP';
  if (['fr', 'de', 'es', 'nl', 'it'].includes(locale)) return 'EUR';
  return 'USD';
}

/** U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP DIRECTIONAL ISOLATE. */
const ltrIsolate = (s: string) => `\u2066${s}\u2069`;

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

/** The currency's symbol in this locale (e.g. "US$", "£"), isolated for bidi like formatPrice. */
export function currencySymbol(currency: PriceCurrency, locale: string): string {
  const sym = new Intl.NumberFormat(numberLocale(locale), { style: 'currency', currency, currencyDisplay: 'symbol' }).formatToParts(0).find((p) => p.type === 'currency')?.value;
  return sym ? ltrIsolate(sym) : currency;
}

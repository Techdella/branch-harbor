import { PLAN_PRICE_KEYS, PRICE_LISTS, annualMonthlyPrice, planQuote, priceListCurrency, type PriceItem, type PriceListKey, type PricedCurrency } from '@bh/shared';
import { numberLocale } from '@/lib/intl';

/**
 * List prices come from the shared price book (packages/shared/src/pricing.ts, documented in docs/PRICING.md), so the
 * API subscription, the app and this site always show the same numbers. The price list follows the visitor's
 * location (lib/geo.ts, regional tiers A–D); the language follows the URL. Prices are set per market — not live
 * exchange-rate conversions — and checkout locks them to the billing country.
 */
export type PriceCurrency = PricedCurrency;
export type { PriceListKey };

/** `solo` is one flat price for a single-location business; the others are per location (Network adds a platform fee). */
export const PLAN_KEYS = PLAN_PRICE_KEYS;
export type PlanKey = (typeof PLAN_KEYS)[number];

/** Monthly list price in major units; annual billing includes two months (10 / 12). */
export function listPrice(list: PriceListKey, item: PriceItem, annual = false): number {
  const monthly = PRICE_LISTS[list][item];
  return annual ? annualMonthlyPrice(monthly) : monthly;
}

/** Per-location (or Solo flat) price, monthly equivalent. */
export function perLocationPrice(list: PriceListKey, plan: PlanKey, annual: boolean): number {
  return listPrice(list, plan, annual);
}

/** Monthly-equivalent total for `count` locations in major units (Network: platform fee incl. 3 locations + the rest). */
export function planTotal(list: PriceListKey, plan: PlanKey, count: number, annual: boolean): number {
  const q = planQuote({ priceList: list, plan, locations: count });
  const major = q.totalMinor / (priceListCurrency(list) === 'JPY' ? 1 : 100);
  return annual ? annualMonthlyPrice(major) : major;
}

/** U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP DIRECTIONAL ISOLATE. */
const ltrIsolate = (s: string) => `⁦${s}⁩`;

/**
 * Formats a list price (whole amounts without decimals; fees such as 4.99 with two). The currency symbol is wrapped in a
 * left-to-right isolate so symbols that mix letters and punctuation (US$, A$, CA$) keep their shape inside
 * right-to-left text instead of rendering as "$US".
 */
export function formatPrice(amount: number, currency: PriceCurrency, locale: string): string {
  const digits = Number.isInteger(amount) || currency === 'JPY' ? 0 : 2;
  return new Intl.NumberFormat(numberLocale(locale), { style: 'currency', currency, maximumFractionDigits: digits, minimumFractionDigits: digits })
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

/**
 * Static list prices per currency. These are set per currency — not live exchange-rate conversions.
 * Proposed pricing, to be validated before general availability.
 */
export const PRICE_CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'AUD'] as const;
export type PriceCurrency = (typeof PRICE_CURRENCIES)[number];

export const PLAN_KEYS = ['connector', 'hosted', 'network'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/** Monthly price per location, whole currency units. */
export const LIST_PRICES: Record<PriceCurrency, Record<PlanKey, number>> = {
  USD: { connector: 29, hosted: 59, network: 89 },
  CAD: { connector: 39, hosted: 79, network: 119 },
  GBP: { connector: 23, hosted: 47, network: 71 },
  EUR: { connector: 27, hosted: 55, network: 83 },
  AUD: { connector: 45, hosted: 89, network: 135 },
};

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

export function formatPrice(amount: number, currency: PriceCurrency, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(amount);
}

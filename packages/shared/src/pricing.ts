import { minorUnitExponent, type Currency } from './money.ts';

/**
 * BranchHarbor price book — the single source of list prices for the marketing site and the API subscription.
 *
 * - One row per billing currency, one column per plan. Amounts are MONTHLY list prices in WHOLE currency units
 *   (major units); `LIST_PRICES_MINOR` derives the minor-unit amounts the API stores.
 * - Prices are set per market and adjusted for purchasing power (see docs/PRICING.md for the method and the
 *   reference exchange rates), then rounded to price points that look natural locally (…9, …99, round thousands).
 *   They are NOT live exchange-rate conversions.
 * - The currency a customer pays in follows their BILLING COUNTRY (`currencyForCountry`). The marketing site shows
 *   the visitor's local currency by location; checkout must charge the billing country's currency
 *   (`assertBillingCurrency`) so nobody can pick a cheaper market.
 * - Status: proposed — pending founder approval (docs/PRICING.md). Change numbers here only; both apps read them.
 */
export const PRICE_BOOK_VERSION = '2026-10';
export const PRICE_BOOK_STATUS = 'proposed' as const;

export const PLAN_PRICE_KEYS = ['solo', 'connector', 'hosted', 'network'] as const;
export type PlanPriceKey = (typeof PLAN_PRICE_KEYS)[number];

type Row = Record<PlanPriceKey, number>;
const row = (solo: number, connector: number, hosted: number, network: number): Row => ({ solo, connector, hosted, network });

/** Monthly list prices in major units. `solo` is a flat price for one location; the others are per location. */
export const PRICE_BOOK = {
  // Reference markets (unchanged from the original list prices)
  USD: row(39, 29, 59, 89),
  CAD: row(52, 39, 79, 119),
  GBP: row(31, 23, 47, 71),
  EUR: row(36, 27, 55, 83),
  AUD: row(59, 45, 89, 135),
  // High-income markets
  NZD: row(65, 49, 95, 145),
  CHF: row(39, 29, 59, 89),
  SEK: row(379, 279, 579, 849),
  NOK: row(429, 319, 649, 949),
  DKK: row(259, 189, 389, 589),
  JPY: row(4600, 3400, 7000, 10500),
  SGD: row(49, 36, 75, 109),
  HKD: row(279, 209, 419, 629),
  AED: row(129, 99, 199, 299),
  SAR: row(119, 89, 179, 269),
  // Upper-middle-income markets
  PLN: row(99, 69, 149, 219),
  CZK: row(590, 440, 890, 1340),
  MYR: row(89, 65, 129, 189),
  MXN: row(449, 329, 649, 999),
  BRL: row(99, 79, 159, 249),
  TRY: row(699, 529, 1049, 1599),
  ZAR: row(329, 249, 499, 749),
  // Lower-middle-income markets
  INR: row(1199, 899, 1799, 2699),
  PHP: row(899, 649, 1349, 1999),
  IDR: row(249000, 189000, 389000, 579000),
  EGP: row(599, 449, 899, 1299),
  NGN: row(18000, 13500, 27500, 41500),
  KES: row(1800, 1300, 2700, 4000),
  GHS: row(165, 120, 250, 375),
} as const satisfies Partial<Record<Currency, Row>>;

export type PricedCurrency = keyof typeof PRICE_BOOK;
/** Currencies with published list prices (set per market, not exchange-rate conversions). */
export const PRICED_CURRENCIES = Object.keys(PRICE_BOOK) as PricedCurrency[];

export function isPricedCurrency(c: unknown): c is PricedCurrency {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(PRICE_BOOK, c);
}

/** Monthly list prices in minor units (what the API stores on subscriptions). */
export const LIST_PRICES_MINOR = Object.fromEntries(
  PRICED_CURRENCIES.map((c) => [c, Object.fromEntries(PLAN_PRICE_KEYS.map((k) => [k, PRICE_BOOK[c][k] * 10 ** minorUnitExponent(c)]))]),
) as Record<PricedCurrency, Row>;

/** Solo: one location, hosted site and dashboard, flat monthly price in minor units per currency. */
export const SOLO_PLAN = {
  key: 'solo' as const,
  maxLocations: 1,
  interval: 'month' as const,
  priceMinor: Object.fromEntries(PRICED_CURRENCIES.map((c) => [c, LIST_PRICES_MINOR[c].solo])) as Record<PricedCurrency, number>,
};

/** Solo list price for a currency, or null when the currency has no list price (quote). */
export function soloPrice(currency: string): { amount: number; currency: PricedCurrency; interval: 'month' } | null {
  return isPricedCurrency(currency) ? { amount: SOLO_PLAN.priceMinor[currency], currency, interval: 'month' } : null;
}

/** Annual billing: two months included (10 / 12), rounded to whole units. */
export function annualMonthlyPrice(monthlyMajor: number): number {
  return Math.round((monthlyMajor * 10) / 12);
}

/* ------------------------------------------------------------------ */
/* Country → currency                                                  */
/* ------------------------------------------------------------------ */

/** Euro area (incl. Bulgaria from 2026) and countries/territories that use the euro. */
const EURO_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES',
  'AD', 'MC', 'SM', 'VA', 'ME', 'XK', 'GF', 'GP', 'MQ', 'RE', 'YT', 'PM', 'BL', 'MF', 'AX',
];

/** ISO 3166-1 alpha-2 → billing currency. Countries not listed are billed in USD. */
export const COUNTRY_CURRENCY: Readonly<Record<string, PricedCurrency>> = {
  ...Object.fromEntries(EURO_COUNTRIES.map((c) => [c, 'EUR' as const])),
  US: 'USD', PR: 'USD', GU: 'USD', VI: 'USD', AS: 'USD', MP: 'USD', UM: 'USD',
  CA: 'CAD',
  GB: 'GBP', IM: 'GBP', JE: 'GBP', GG: 'GBP',
  AU: 'AUD', CX: 'AUD', CC: 'AUD', NF: 'AUD',
  NZ: 'NZD', CK: 'NZD', NU: 'NZD',
  CH: 'CHF', LI: 'CHF',
  SE: 'SEK', NO: 'NOK', DK: 'DKK', GL: 'DKK', FO: 'DKK',
  JP: 'JPY', SG: 'SGD', HK: 'HKD', AE: 'AED', SA: 'SAR',
  PL: 'PLN', CZ: 'CZK', MY: 'MYR', MX: 'MXN', BR: 'BRL', TR: 'TRY', ZA: 'ZAR',
  IN: 'INR', PH: 'PHP', ID: 'IDR', EG: 'EGP', NG: 'NGN', KE: 'KES', GH: 'GHS',
};

export const FALLBACK_CURRENCY: PricedCurrency = 'USD';

/** Billing currency for an ISO country code; unknown or missing countries → USD. */
export function currencyForCountry(country: string | null | undefined): PricedCurrency {
  if (!country) return FALLBACK_CURRENCY;
  return COUNTRY_CURRENCY[country.trim().toUpperCase()] ?? FALLBACK_CURRENCY;
}

export type CountrySource = 'vercel' | 'cloudflare' | 'accept-language' | 'none';

/** Placeholder codes hosting providers send when they cannot locate a visitor (XX unknown, T1 Tor, A1/A2 proxies). */
const NOT_A_COUNTRY = new Set(['XX', 'T1', 'A1', 'A2', 'O1', 'ZZ', 'EU', 'AP']);
const asCountry = (v: string | null | undefined): string | null => {
  const c = v?.trim().toUpperCase();
  return c && /^[A-Z]{2}$/.test(c) && !NOT_A_COUNTRY.has(c) ? c : null;
};

/** First Accept-Language entry (by q-value) that carries a region, e.g. "pt-BR,pt;q=0.9" → "BR". */
export function regionFromAcceptLanguage(header: string | null | undefined): string | null {
  if (!header) return null;
  const tags = header
    .split(',')
    .map((part, i) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) || 0 : 1, i };
    })
    .filter((t) => t.tag && t.tag !== '*' && t.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of tags) {
    // language[-script][-region]; the region is the 2-letter subtag after the language (and optional script).
    const region = tag.split(/[-_]/).slice(1).find((s) => /^[A-Za-z]{2}$/.test(s));
    const c = asCountry(region);
    if (c) return c;
  }
  return null;
}

/**
 * Visitor country from request headers: Vercel (`x-vercel-ip-country`), then Cloudflare (`cf-ipcountry`), then the
 * region of the preferred Accept-Language tag. Returns null when none is usable (→ USD).
 */
export function countryFromHeaders(get: (name: string) => string | null | undefined): { country: string | null; source: CountrySource } {
  const vercel = asCountry(get('x-vercel-ip-country'));
  if (vercel) return { country: vercel, source: 'vercel' };
  const cf = asCountry(get('cf-ipcountry'));
  if (cf) return { country: cf, source: 'cloudflare' };
  const al = regionFromAcceptLanguage(get('accept-language'));
  if (al) return { country: al, source: 'accept-language' };
  return { country: null, source: 'none' };
}

/* ------------------------------------------------------------------ */
/* Checkout enforcement                                                */
/* ------------------------------------------------------------------ */

export type BillingCurrencyCheck =
  | { ok: true; currency: PricedCurrency }
  | { ok: false; expected: PricedCurrency; reason: 'currency_mismatch' | 'card_country_mismatch' };

/**
 * Checkout rule: a subscription is charged in the currency of the customer's billing country. Call it before
 * creating a subscription/checkout session (with the requested currency, if the client sent one) and again when
 * the payment provider reports the billing address and card country (e.g. Stripe `checkout.session.completed`).
 * A card issued in a country whose billing currency differs from the billing address's is refused too, so a
 * visitor cannot choose a cheaper market by entering a foreign address.
 */
export function assertBillingCurrency(input: { billingCountry: string | null | undefined; requestedCurrency?: string | null; cardCountry?: string | null }): BillingCurrencyCheck {
  const expected = currencyForCountry(input.billingCountry);
  if (input.requestedCurrency && input.requestedCurrency.toUpperCase() !== expected) return { ok: false, expected, reason: 'currency_mismatch' };
  if (input.cardCountry && currencyForCountry(input.cardCountry) !== expected) return { ok: false, expected, reason: 'card_country_mismatch' };
  return { ok: true, currency: expected };
}

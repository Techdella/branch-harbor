import { minorUnitExponent, type Currency } from './money.ts';

/**
 * BranchHarbor price book — the single source of list prices for the marketing site, the app and the API subscription.
 *
 * - Prices are grouped in REGIONAL TIERS (A/B/C/D, `REGION_TIERS`) with documented multipliers against the USD list
 *   price, then set as local price points per currency (…9, …99, round thousands). They are NOT live exchange-rate
 *   conversions. Status: PROPOSAL — to be validated with pricing tests (docs/PRICING.md).
 * - One price list per billing currency (`PRICE_BOOK`), plus tier variants for countries whose currency is shared with
 *   richer markets (`EUR@C` for euro countries in Central/Eastern Europe; `USD@B|C|D` for countries billed in USD).
 *   `priceListForCountry` picks the list from the BILLING COUNTRY.
 * - Amounts are MONTHLY list prices in major units; `listPriceMinor` gives the minor units the API charges.
 * - Network = a monthly HQ platform fee (includes `NETWORK_INCLUDED_LOCATIONS` locations) + the Network per-location
 *   fee for every further location, with unlimited users. Solo / Connector / Hosted are per-location plans.
 * - Every plan starts with a PAID 14-day trial (`trial`); the chosen plan then starts automatically unless the customer
 *   cancels first. There is no free plan and no free trial.
 * - Checkout locks the billing country, its currency and price list (`assertBillingCurrency`) so nobody can pick a
 *   cheaper market. Change numbers here only; the website, the app and the API read them.
 */
export const PRICE_BOOK_VERSION = '2026-11';
export const PRICE_BOOK_STATUS = 'proposal' as const;
export const PRICE_BOOK_STATUS_NOTE = 'Proposal: to be validated with pricing tests';

export const PLAN_PRICE_KEYS = ['solo', 'connector', 'hosted', 'network'] as const;
export type PlanPriceKey = (typeof PLAN_PRICE_KEYS)[number];
/** Fees that are not plans: the Network HQ platform fee, the paid trial, the royalty/fund collection fee and its monthly cap per location. */
export const FEE_PRICE_KEYS = ['platform', 'trial', 'collection', 'collectionCap'] as const;
export type FeePriceKey = (typeof FEE_PRICE_KEYS)[number];
export type PriceItem = PlanPriceKey | FeePriceKey;

/** Locations included in the Network platform fee; every further location pays the Network per-location fee. */
export const NETWORK_INCLUDED_LOCATIONS = 3;
/** Paid trial length and the reminder emails sent before it converts. */
export const TRIAL_DAYS = 14;
export const TRIAL_REMINDER_DAYS = [3, 1] as const;
/**
 * Application fee on online consumer payments (Stripe Connect), in basis points. The API default
 * (`STRIPE_APPLICATION_FEE_BPS`) uses it and the pricing page shows it. Stripe's own processing fee is separate.
 */
export const DEFAULT_PAYMENT_APPLICATION_FEE_BPS = 100;

/* ------------------------------------------------------------------ */
/* Regional tiers                                                      */
/* ------------------------------------------------------------------ */

export const REGION_TIERS = ['A', 'B', 'C', 'D'] as const;
export type RegionTier = (typeof REGION_TIERS)[number];

/**
 * Multiplier against the USD list price (local price ÷ reference rate ÷ USD price). `target` is what local price
 * points aim for; every price list of the tier stays within `min`–`max` (checked by pricing.test.ts).
 */
export const TIER_MULTIPLIERS: Readonly<Record<RegionTier, { target: number; min: number; max: number }>> = {
  A: { target: 1.0, min: 0.9, max: 1.12 },
  B: { target: 0.95, min: 0.85, max: 1.07 },
  C: { target: 0.68, min: 0.6, max: 0.75 },
  D: { target: 0.5, min: 0.45, max: 0.6 },
};

/** Approximate reference rates used to set the price points (1 USD = …, mid-2026). Documentation and tests only. */
export const REFERENCE_USD_RATES: Readonly<Record<string, number>> = {
  USD: 1, CAD: 1.37, GBP: 0.75, EUR: 0.88, AUD: 1.52, NZD: 1.68, CHF: 0.82, SEK: 9.6, NOK: 10.2, DKK: 6.6, JPY: 148, SGD: 1.3,
  HKD: 7.8, AED: 3.67, SAR: 3.75, PLN: 3.7, CZK: 21.5, MYR: 4.3, MXN: 18.5, BRL: 5.5, TRY: 40, ZAR: 18, INR: 85, PHP: 57,
  IDR: 16300, EGP: 49, NGN: 1550, KES: 129, GHS: 12,
};

const TIER_COUNTRIES: Record<RegionTier, string[]> = {
  // US, CA, UK, IE, AU, NZ, Nordics, CH (+ their territories)
  A: ['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'CA', 'GB', 'IM', 'JE', 'GG', 'IE', 'AU', 'CX', 'CC', 'NF', 'NZ', 'CK', 'NU', 'SE', 'NO', 'DK', 'GL', 'FO', 'FI', 'AX', 'IS', 'CH', 'LI'],
  // Rest of Western Europe, Gulf, Singapore, Hong Kong, Japan (+ Korea, Taiwan, Israel, Macao)
  B: [
    'AT', 'BE', 'FR', 'DE', 'NL', 'LU', 'IT', 'ES', 'PT', 'MT', 'CY', 'GR', 'AD', 'MC', 'SM', 'VA', 'GF', 'GP', 'MQ', 'RE', 'YT', 'PM', 'BL', 'MF',
    'AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'SG', 'HK', 'JP', 'KR', 'TW', 'IL', 'MO',
  ],
  // Central/Eastern Europe, Latin America, Türkiye, Malaysia
  C: [
    'PL', 'CZ', 'SK', 'SI', 'HR', 'HU', 'RO', 'BG', 'EE', 'LV', 'LT', 'RS', 'ME', 'XK', 'BA', 'MK', 'AL', 'MD', 'UA', 'GE', 'AM',
    'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'CR', 'PA', 'DO', 'EC', 'GT', 'PY', 'BO', 'SV', 'HN', 'NI', 'JM', 'TT', 'TR', 'MY',
  ],
  // India and South Asia, Southeast Asia, Africa, Egypt
  D: [
    'IN', 'PK', 'BD', 'LK', 'NP', 'PH', 'ID', 'VN', 'TH', 'KH', 'LA', 'MM', 'NG', 'KE', 'GH', 'ZA', 'EG', 'MA', 'TN', 'DZ', 'ET', 'UG', 'TZ', 'RW',
    'SN', 'CI', 'CM', 'ZM', 'ZW', 'BW', 'NA', 'MU',
  ],
};

/** ISO country → regional tier. Countries not listed are tier A. */
export const COUNTRY_TIER: Readonly<Record<string, RegionTier>> = Object.fromEntries(
  (Object.entries(TIER_COUNTRIES) as [RegionTier, string[]][]).flatMap(([tier, cs]) => cs.map((c) => [c, tier])),
);

export function tierForCountry(country: string | null | undefined): RegionTier {
  if (!country) return 'A';
  return COUNTRY_TIER[country.trim().toUpperCase()] ?? 'A';
}

/* ------------------------------------------------------------------ */
/* Price lists                                                         */
/* ------------------------------------------------------------------ */

type Row = Record<PriceItem, number>;
const row = (solo: number, connector: number, hosted: number, network: number, platform: number, trial: number, collection: number, collectionCap: number): Row => ({
  solo, connector, hosted, network, platform, trial, collection, collectionCap,
});

/**
 * Monthly list prices in major units, one row per billing currency, at the currency's home tier (`CURRENCY_TIER`).
 * Columns: Solo (flat, one location) · Connector / Hosted / Network per location · Network HQ platform fee (includes
 * 3 locations) · 14-day paid trial · royalty/fund collection fee per collection · its monthly cap per location.
 */
export const PRICE_BOOK = {
  // Tier A
  USD: row(39, 29, 59, 89, 299, 4.99, 1, 10),
  CAD: row(52, 39, 79, 119, 399, 6.99, 1.4, 14),
  GBP: row(31, 23, 47, 71, 239, 3.99, 0.8, 8),
  AUD: row(59, 45, 89, 135, 449, 7.99, 1.5, 15),
  NZD: row(65, 49, 95, 145, 489, 8.49, 1.7, 17),
  CHF: row(35, 25, 49, 75, 249, 3.9, 0.9, 9),
  SEK: row(379, 279, 579, 849, 2890, 49, 10, 100),
  NOK: row(429, 319, 649, 949, 3190, 55, 10, 100),
  DKK: row(259, 189, 389, 589, 1990, 35, 7, 70),
  // Euro area West: tier A (IE, FI) and tier B (rest of Western Europe) share one euro list
  EUR: row(36, 27, 55, 83, 279, 4.49, 0.9, 9),
  // Tier B
  JPY: row(5400, 4000, 8200, 12400, 41000, 700, 140, 1400),
  SGD: row(49, 36, 75, 109, 369, 6.49, 1.2, 12),
  HKD: row(279, 209, 419, 629, 2090, 39, 7, 70),
  AED: row(129, 99, 199, 299, 999, 18, 3.5, 35),
  SAR: row(139, 99, 209, 319, 1049, 18, 3.5, 35),
  // Tier C
  PLN: row(99, 69, 149, 219, 729, 14.99, 2.5, 25),
  CZK: row(590, 440, 890, 1340, 4490, 89, 15, 150),
  MYR: row(119, 85, 169, 259, 869, 14.9, 3, 30),
  MXN: row(449, 329, 669, 999, 3349, 69, 13, 130),
  BRL: row(139, 99, 209, 319, 1069, 17.9, 3.5, 35),
  TRY: row(949, 729, 1449, 2199, 7399, 129, 25, 250),
  // Tier D
  ZAR: row(329, 249, 499, 749, 2490, 49, 9, 90),
  INR: row(1699, 1249, 2499, 3799, 12999, 299, 45, 450),
  PHP: row(1099, 829, 1699, 2499, 8499, 149, 29, 290),
  IDR: row(319000, 239000, 479000, 729000, 2449000, 39000, 8000, 80000),
  EGP: row(899, 679, 1399, 2099, 6999, 119, 25, 250),
  NGN: row(28500, 21000, 43000, 65000, 219000, 2500, 750, 7500),
  KES: row(2400, 1800, 3650, 5500, 18500, 299, 60, 600),
  GHS: row(225, 165, 339, 509, 1719, 29, 6, 60),
} as const satisfies Partial<Record<Currency, Row>>;

export type PricedCurrency = keyof typeof PRICE_BOOK;
/** Currencies with published list prices (set per market, not exchange-rate conversions). */
export const PRICED_CURRENCIES = Object.keys(PRICE_BOOK) as PricedCurrency[];

/** Home tier of each currency's base price list (EUR serves tiers A and B). */
export const CURRENCY_TIER: Readonly<Record<PricedCurrency, RegionTier>> = {
  USD: 'A', CAD: 'A', GBP: 'A', AUD: 'A', NZD: 'A', CHF: 'A', SEK: 'A', NOK: 'A', DKK: 'A', EUR: 'B',
  JPY: 'B', SGD: 'B', HKD: 'B', AED: 'B', SAR: 'B',
  PLN: 'C', CZK: 'C', MYR: 'C', MXN: 'C', BRL: 'C', TRY: 'C',
  ZAR: 'D', INR: 'D', PHP: 'D', IDR: 'D', EGP: 'D', NGN: 'D', KES: 'D', GHS: 'D',
};

/** Tier variants for countries billed in a currency whose base list is set for a richer tier. */
export const TIER_PRICE_LISTS = {
  'EUR@C': row(25, 19, 37, 55, 189, 2.99, 0.6, 6),
  'USD@B': row(37, 27, 55, 85, 279, 4.99, 0.95, 9.5),
  'USD@C': row(27, 20, 41, 62, 209, 3.49, 0.7, 7),
  'USD@D': row(19, 14, 29, 44, 149, 2.49, 0.5, 5),
} as const satisfies Record<string, Row>;

export type PriceListKey = PricedCurrency | keyof typeof TIER_PRICE_LISTS;
export const PRICE_LISTS: Readonly<Record<PriceListKey, Row>> = { ...PRICE_BOOK, ...TIER_PRICE_LISTS };
export const PRICE_LIST_KEYS = Object.keys(PRICE_LISTS) as PriceListKey[];

export function isPricedCurrency(c: unknown): c is PricedCurrency {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(PRICE_BOOK, c);
}
export function isPriceListKey(k: unknown): k is PriceListKey {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(PRICE_LISTS, k);
}

/** Currency of a price list (`EUR@C` → EUR). */
export function priceListCurrency(key: PriceListKey): PricedCurrency {
  return key.split('@')[0] as PricedCurrency;
}
/** Tier a price list is set for. */
export function priceListTier(key: PriceListKey): RegionTier {
  const [c, t] = key.split('@');
  return (t as RegionTier | undefined) ?? CURRENCY_TIER[c as PricedCurrency];
}

const toMinor = (major: number, currency: PricedCurrency) => Math.round(major * 10 ** minorUnitExponent(currency));

/** List price of one item in minor units (what the API charges). */
export function listPriceMinor(key: PriceListKey, item: PriceItem): number {
  return toMinor(PRICE_LISTS[key][item], priceListCurrency(key));
}

/** Monthly prices in minor units for each base currency (plans and fees). */
export const LIST_PRICES_MINOR = Object.fromEntries(
  PRICED_CURRENCIES.map((c) => [c, Object.fromEntries([...PLAN_PRICE_KEYS, ...FEE_PRICE_KEYS].map((k) => [k, toMinor(PRICE_BOOK[c][k], c)]))]),
) as Record<PricedCurrency, Row>;

/** Solo: one location, hosted site and dashboard, flat monthly price in minor units per currency. */
export const SOLO_PLAN = {
  key: 'solo' as const,
  maxLocations: 1,
  interval: 'month' as const,
  priceMinor: Object.fromEntries(PRICED_CURRENCIES.map((c) => [c, LIST_PRICES_MINOR[c].solo])) as Record<PricedCurrency, number>,
};

/** Solo list price for a price list (or currency), or null when it has no list price (quote). */
export function soloPrice(list: string): { amount: number; currency: PricedCurrency; interval: 'month' } | null {
  return isPriceListKey(list) ? { amount: listPriceMinor(list, 'solo'), currency: priceListCurrency(list), interval: 'month' } : null;
}

/** Paid-trial fee for a price list (or currency), in minor units. */
export function trialPrice(list: string): { amount: number; currency: PricedCurrency; days: number } | null {
  return isPriceListKey(list) ? { amount: listPriceMinor(list, 'trial'), currency: priceListCurrency(list), days: TRIAL_DAYS } : null;
}

/** Annual billing: two months included (10 / 12), rounded to whole units. */
export function annualMonthlyPrice(monthlyMajor: number): number {
  return Math.round((monthlyMajor * 10) / 12);
}

export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export interface QuoteLine { kind: 'plan' | 'platform' | 'location'; quantity: number; unitMinor: number; amountMinor: number }
export interface PlanQuote {
  priceList: PriceListKey;
  currency: PricedCurrency;
  tier: RegionTier;
  plan: PlanPriceKey;
  interval: BillingInterval;
  locations: number;
  includedLocations: number;
  lines: QuoteLine[];
  /** Total per billing interval (a year = 10 months), minor units, before tax. */
  totalMinor: number;
  trialFeeMinor: number;
  trialDays: number;
}

/**
 * The plan price for a number of billed locations. Network: the platform fee (includes 3 locations) + the Network
 * per-location fee for each location beyond them. Solo: one flat price. Connector/Hosted: per location (min 1).
 * Annual: 10 × the monthly amount (two months included).
 */
export function planQuote(input: { priceList: PriceListKey; plan: PlanPriceKey; interval?: BillingInterval; locations?: number }): PlanQuote {
  const { priceList, plan } = input;
  const interval = input.interval ?? 'month';
  const months = interval === 'year' ? 10 : 1;
  const n = Math.max(plan === 'network' ? 0 : 1, Math.floor(input.locations ?? 1));
  const line = (kind: QuoteLine['kind'], quantity: number, monthlyMinor: number): QuoteLine => ({ kind, quantity, unitMinor: monthlyMinor * months, amountMinor: monthlyMinor * months * quantity });
  const lines: QuoteLine[] = [];
  let included = 0;
  if (plan === 'network') {
    included = NETWORK_INCLUDED_LOCATIONS;
    lines.push(line('platform', 1, listPriceMinor(priceList, 'platform')));
    const extra = Math.max(0, n - included);
    if (extra > 0) lines.push(line('location', extra, listPriceMinor(priceList, 'network')));
  } else if (plan === 'solo') {
    lines.push(line('plan', 1, listPriceMinor(priceList, 'solo')));
  } else {
    lines.push(line('location', n, listPriceMinor(priceList, plan)));
  }
  return {
    priceList, currency: priceListCurrency(priceList), tier: priceListTier(priceList), plan, interval, locations: plan === 'solo' ? 1 : n, includedLocations: included,
    lines, totalMinor: lines.reduce((s, l) => s + l.amountMinor, 0), trialFeeMinor: listPriceMinor(priceList, 'trial'), trialDays: TRIAL_DAYS,
  };
}

/** Royalty / marketing-fund collection fee: flat per collection, capped per location per month. Never a % of royalties. */
export function collectionFee(list: PriceListKey, collectionsThisMonth: number): { perCollectionMinor: number; capMinor: number; chargedMinor: number } {
  const per = listPriceMinor(list, 'collection');
  const cap = listPriceMinor(list, 'collectionCap');
  return { perCollectionMinor: per, capMinor: cap, chargedMinor: Math.min(cap, per * Math.max(0, Math.floor(collectionsThisMonth))) };
}

/* ------------------------------------------------------------------ */
/* Who pays a location's fee (Network)                                 */
/* ------------------------------------------------------------------ */

export const LOCATION_FEE_PAYERS = ['hq', 'franchisee', 'split'] as const;
export type LocationFeePayer = (typeof LOCATION_FEE_PAYERS)[number];

/** Split a location's fee between HQ and the franchisee. `franchiseePercent` applies to `split` only (0–100). */
export function splitLocationFee(amountMinor: number, payer: LocationFeePayer, franchiseePercent = 50): { hqMinor: number; franchiseeMinor: number } {
  const pct = payer === 'hq' ? 0 : payer === 'franchisee' ? 100 : Math.min(100, Math.max(0, Math.round(franchiseePercent)));
  const franchiseeMinor = Math.round((amountMinor * pct) / 100);
  return { hqMinor: amountMinor - franchiseeMinor, franchiseeMinor };
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

/**
 * Price list for a billing country: the currency's base list, or the tier variant when the country's tier is cheaper
 * than the list's home tier (e.g. Estonia → `EUR@C`, Vietnam → `USD@D`). Euro tier-A countries use the EUR list.
 */
export function priceListForCountry(country: string | null | undefined): { key: PriceListKey; currency: PricedCurrency; tier: RegionTier } {
  const currency = currencyForCountry(country);
  const tier = tierForCountry(country);
  const variant = `${currency}@${tier}`;
  const key: PriceListKey = isPriceListKey(variant) ? variant : currency;
  return { key, currency, tier: priceListTier(key) };
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
  | { ok: true; currency: PricedCurrency; priceList: PriceListKey; evidence: 'card' | 'tax_id' | 'none' }
  | { ok: false; expected: PricedCurrency; reason: 'currency_mismatch' | 'card_country_mismatch' | 'invalid_country' };

/**
 * Checkout rule: a subscription is charged in the currency and price list of the customer's BILLING COUNTRY.
 * Call it when the checkout starts (with the currency the client asked for, if any), when the payment method is
 * known (with the card's issuing country), and again in the Stripe webhook.
 * The card must be issued in the billing country — or the customer gives a tax ID from that country
 * (`taxIdCountry`). Otherwise it is refused, so a visitor cannot choose a cheaper market by typing a foreign address.
 */
export function assertBillingCurrency(input: { billingCountry: string | null | undefined; requestedCurrency?: string | null; cardCountry?: string | null; taxIdCountry?: string | null }): BillingCurrencyCheck {
  const billing = input.billingCountry?.trim().toUpperCase() ?? '';
  const expected = currencyForCountry(billing);
  if (input.billingCountry != null && !/^[A-Z]{2}$/.test(billing)) return { ok: false, expected, reason: 'invalid_country' };
  if (input.requestedCurrency && input.requestedCurrency.toUpperCase() !== expected) return { ok: false, expected, reason: 'currency_mismatch' };
  const { key } = priceListForCountry(billing);
  const taxOk = !!input.taxIdCountry && input.taxIdCountry.toUpperCase() === billing;
  if (input.cardCountry) {
    if (input.cardCountry.toUpperCase() === billing) return { ok: true, currency: expected, priceList: key, evidence: 'card' };
    if (taxOk) return { ok: true, currency: expected, priceList: key, evidence: 'tax_id' };
    return { ok: false, expected, reason: 'card_country_mismatch' };
  }
  return { ok: true, currency: expected, priceList: key, evidence: taxOk ? 'tax_id' : 'none' };
}

/** EU VAT prefixes that differ from the ISO country code. */
const VAT_PREFIX: Record<string, string> = { EL: 'GR', XI: 'GB' };
const EU_VAT = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
/** Light format checks for common business tax IDs (the payment provider verifies them in live mode). */
const TAX_ID_FORMAT: Record<string, RegExp> = {
  GB: /^(GB)?\d{9}(\d{3})?$/, AU: /^\d{11}$/, NZ: /^\d{8,9}$/, CA: /^\d{9}(RT\d{4})?$/, IN: /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/,
  NG: /^\d{8}-?\d{4}$/, ZA: /^4\d{9}$/, CH: /^CHE\d{9}(MWST|TVA|IVA)?$/, NO: /^\d{9}(MVA)?$/, BR: /^\d{14}$/, MX: /^[A-Z&Ñ]{3,4}\d{6}[A-Z\d]{3}$/,
  SG: /^[A-Z\d]{9,10}$/, JP: /^T?\d{13}$/, AE: /^\d{15}$/, SA: /^\d{15}$/, US: /^\d{2}-?\d{7}$/,
};

/**
 * Country a business tax ID belongs to, or null when it does not look valid for `claimedCountry`. EU VAT numbers carry
 * their country prefix (DE123…, EL… for Greece); other IDs are checked against the claimed country's format.
 */
export function taxIdCountry(value: string, claimedCountry: string): string | null {
  const v = value.replace(/[\s.\-/]/g, '').toUpperCase();
  const claimed = claimedCountry.trim().toUpperCase();
  if (v.length < 5 || v.length > 20) return null;
  const prefix = v.slice(0, 2);
  const prefCountry = VAT_PREFIX[prefix] ?? prefix;
  if (EU_VAT.has(prefCountry) && /^[A-Z]{2}[A-Z\d]{8,12}$/.test(v)) return prefCountry === claimed ? claimed : null;
  const fmt = TAX_ID_FORMAT[claimed];
  if (fmt) return fmt.test(v) ? claimed : null;
  return EU_VAT.has(claimed) ? null : /^[A-Z\d]{5,20}$/.test(v) ? claimed : null;
}

/* ------------------------------------------------------------------ */
/* AI assistant allowance                                              */
/* ------------------------------------------------------------------ */

/**
 * AI credits included each month (1 credit = US$0.01 of model usage, see `creditsFor` in ai.ts). `base` is per
 * organisation, `perLocation` per billable location. Usage above the allowance continues up to the fair-use ceiling
 * (`AI_FAIR_USE_MULTIPLIER` × allowance), then the assistant pauses until the next month. Same in every currency.
 */
export const AI_CREDIT_ALLOWANCE: Readonly<Record<PlanPriceKey, { base: number; perLocation: number }>> = {
  solo: { base: 500, perLocation: 0 },
  connector: { base: 200, perLocation: 150 },
  hosted: { base: 300, perLocation: 300 },
  network: { base: 2000, perLocation: 400 },
};

/** Monthly AI credits for a plan and number of billable locations. */
export function aiMonthlyAllowance(plan: PlanPriceKey, locations: number): number {
  const a = AI_CREDIT_ALLOWANCE[plan];
  return a.base + a.perLocation * Math.max(0, locations);
}

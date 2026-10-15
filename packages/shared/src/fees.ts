import { minorUnitExponent } from './money.ts';
import { PRICE_BOOK, isPricedCurrency, type PricedCurrency } from './pricing.ts';

/**
 * BranchHarbor fees outside the plan price (the price book in pricing.ts stays the single source of plan prices;
 * the billing workspace owns how prices are displayed).
 *
 * Royalty collection fee: a FLAT fee per successful-or-attempted royalty collection (bank debit or card) that
 * BranchHarbor runs for the franchisor, capped per location per calendar month. It is deliberately NOT a percentage
 * of royalties: the franchisor's royalty income is none of BranchHarbor's business, and a flat fee stays predictable.
 *
 * - Reference amount: USD 1.00 per collection, at most 5 charged collections per location per month.
 * - Other billing currencies follow the price book's market ratio (connector plan, per location), rounded to a
 *   natural amount — the same purchasing-power logic as plan prices, never a live exchange rate.
 * - The fee is paid by the franchisor (taken as the platform fee on the collection on their account), and printed on
 *   franchisee statements for transparency only; it never increases what the franchisee owes.
 */
export const ROYALTY_COLLECTION_FEE_USD_MINOR = 100;
export const ROYALTY_COLLECTION_FEE_CAP_PER_LOCATION_PER_MONTH = 5;

function niceMajor(v: number): number {
  if (v < 10) return Math.max(0.05, Math.round(v * 20) / 20);
  if (v < 100) return Math.round(v);
  const mag = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / mag) * mag;
}

/** Flat collection fee per price-book currency, in minor units. */
export const royaltyCollectionFee: Readonly<Record<PricedCurrency, number>> = Object.fromEntries(
  (Object.keys(PRICE_BOOK) as PricedCurrency[]).map((c) => {
    const major = c === 'USD' ? ROYALTY_COLLECTION_FEE_USD_MINOR / 100 : niceMajor((ROYALTY_COLLECTION_FEE_USD_MINOR / 100) * (PRICE_BOOK[c].connector / PRICE_BOOK.USD.connector));
    return [c, Math.round(major * 10 ** minorUnitExponent(c))];
  }),
) as Record<PricedCurrency, number>;

export interface CollectionFeeQuote {
  /** Fee in minor units of `currency` (0 once the monthly cap is reached). */
  amountMinor: number;
  currency: string;
  /** Collections already charged a fee this month for the location (before this one). */
  chargedThisMonth: number;
  cap: number;
  capped: boolean;
}

/**
 * The fee for one more collection at a location this month. Currencies outside the price book fall back to the USD
 * amount only when the collection itself is in USD; otherwise no fee is charged (never an invented conversion).
 */
export function quoteCollectionFee(currency: string, chargedThisMonth: number): CollectionFeeQuote {
  const c = currency.toUpperCase();
  const cap = ROYALTY_COLLECTION_FEE_CAP_PER_LOCATION_PER_MONTH;
  const capped = chargedThisMonth >= cap;
  const base = isPricedCurrency(c) ? royaltyCollectionFee[c] : 0;
  return { amountMinor: capped ? 0 : base, currency: c, chargedThisMonth, cap, capped };
}

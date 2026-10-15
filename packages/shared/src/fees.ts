import { LIST_PRICES_MINOR, PRICE_BOOK, isPricedCurrency, type PricedCurrency } from './pricing.ts';

/**
 * BranchHarbor fees outside the plan price (the price book in pricing.ts stays the single source of plan prices;
 * the billing workspace owns how prices are displayed).
 *
 * Royalty collection fee: a FLAT fee per successful-or-attempted royalty collection (bank debit or card) that
 * BranchHarbor runs for the franchisor, capped per location per calendar month. It is deliberately NOT a percentage
 * of royalties: the franchisor's royalty income is none of BranchHarbor's business, and a flat fee stays predictable.
 *
 * - Amounts come from the price book (`collection` and `collectionCap` rows in pricing.ts): USD 1.00 per
 *   collection, capped at USD 10 per location per month. Local amounts are set per currency there, never converted live.
 * - The fee is paid by the franchisor (taken as the platform fee on the collection on their account), and printed on
 *   franchisee statements for transparency only; it never increases what the franchisee owes.
 */
export const ROYALTY_COLLECTION_FEE_USD_MINOR = LIST_PRICES_MINOR.USD.collection;
/** Charged collections per location per month before the cap (cap ÷ per-collection fee in the price book). */
export const ROYALTY_COLLECTION_FEE_CAP_PER_LOCATION_PER_MONTH = Math.round(LIST_PRICES_MINOR.USD.collectionCap / LIST_PRICES_MINOR.USD.collection);

/** Flat collection fee per price-book currency, in minor units (from the price book's `collection` row). */
export const royaltyCollectionFee: Readonly<Record<PricedCurrency, number>> = Object.fromEntries(
  (Object.keys(PRICE_BOOK) as PricedCurrency[]).map((c) => [c, LIST_PRICES_MINOR[c].collection]),
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

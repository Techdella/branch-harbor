import { headers } from 'next/headers';
import { countryFromHeaders, priceListForCountry, type CountrySource, type PriceListKey, type PricedCurrency, type RegionTier } from '@bh/shared';

export interface VisitorPricing {
  /** ISO 3166-1 alpha-2, or null when the visitor could not be located. */
  country: string | null;
  currency: PricedCurrency;
  /** Price list for the visitor's country (regional tier variant when one applies, e.g. USD@D). */
  priceList: PriceListKey;
  tier: RegionTier;
  source: CountrySource;
}

/**
 * Display prices for this request, from the hosting provider's geolocation headers (Vercel `x-vercel-ip-country`,
 * Cloudflare `cf-ipcountry`), then the Accept-Language region, then USD. Reading headers makes the calling route
 * dynamic. This only chooses what is SHOWN; checkout recomputes and locks the price from the billing country
 * entered there, confirmed by the card (docs/PRICING.md).
 */
export async function visitorPricing(): Promise<VisitorPricing> {
  const h = await headers();
  const { country, source } = countryFromHeaders((name) => h.get(name));
  const list = priceListForCountry(country);
  return { country, currency: list.currency, priceList: list.key, tier: list.tier, source };
}

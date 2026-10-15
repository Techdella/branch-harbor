import { headers } from 'next/headers';
import { countryFromHeaders, currencyForCountry, type CountrySource, type PricedCurrency } from '@bh/shared';

export interface VisitorPricing {
  /** ISO 3166-1 alpha-2, or null when the visitor could not be located. */
  country: string | null;
  currency: PricedCurrency;
  source: CountrySource;
}

/**
 * Display currency for this request, from the hosting provider's geolocation headers (Vercel `x-vercel-ip-country`,
 * Cloudflare `cf-ipcountry`), then the Accept-Language region, then USD. Reading headers makes the calling route
 * dynamic. This only chooses what is SHOWN; checkout charges the billing country's currency (docs/PRICING.md).
 */
export async function visitorPricing(): Promise<VisitorPricing> {
  const h = await headers();
  const { country, source } = countryFromHeaders((name) => h.get(name));
  return { country, currency: currencyForCountry(country), source };
}

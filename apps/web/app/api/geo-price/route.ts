import { TRIAL_DAYS, countryFromHeaders, listPriceMinor, priceListForCountry } from '@bh/shared';

/**
 * The visitor's display price for the paid trial, from the hosting provider's geolocation headers (Vercel
 * `x-vercel-ip-country`, Cloudflare `cf-ipcountry`), then the Accept-Language region, then USD — the same rule as the
 * pricing page (lib/geo.ts). Static pages (the home page) read it from a small client island, so they stay static.
 *
 * Cached at the CDN per country (and per language for the Accept-Language fallback): the answer only depends on these
 * headers. Display only: checkout recomputes and locks the price from the billing country (docs/PRICING.md).
 */
export function GET(request: Request) {
  const { country, source } = countryFromHeaders((name) => request.headers.get(name));
  const list = priceListForCountry(country);
  return Response.json(
    { country, source, currency: list.currency, priceList: list.key, trialDays: TRIAL_DAYS, trialFeeMinor: listPriceMinor(list.key, 'trial') },
    {
      headers: {
        'cache-control': 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800',
        vary: 'x-vercel-ip-country, cf-ipcountry, accept-language',
      },
    },
  );
}

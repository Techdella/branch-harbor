import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';

/** Open Exchange Rates. Used only for clearly-labelled indicative conversions — never for report totals. */
export function createFx(cfg: Config, log: FastifyBaseLogger) {
  let cache: { at: number; rates: Record<string, number> } | null = null;
  if (!cfg.OPEN_EXCHANGE_RATES_APP_ID) log.info('[fx] OPEN_EXCHANGE_RATES_APP_ID not set — currency conversion disabled');
  return {
    enabled: !!cfg.OPEN_EXCHANGE_RATES_APP_ID,
    async rates(): Promise<{ base: 'USD'; rates: Record<string, number>; asOf: string } | null> {
      if (!cfg.OPEN_EXCHANGE_RATES_APP_ID) return null;
      if (!cache || Date.now() - cache.at > 3600_000) {
        const res = await fetch(`https://openexchangerates.org/api/latest.json?app_id=${cfg.OPEN_EXCHANGE_RATES_APP_ID}`);
        if (!res.ok) return null;
        const body = (await res.json()) as { rates: Record<string, number> };
        cache = { at: Date.now(), rates: body.rates };
      }
      return { base: 'USD', rates: cache.rates, asOf: new Date(cache.at).toISOString() };
    },
  };
}

/** Google Maps geocoding for the location finder. Disabled without a key (locations have no coordinates). */
export function createGeocoder(cfg: Config, log: FastifyBaseLogger) {
  if (!cfg.GOOGLE_MAPS_API_KEY) log.info('[maps] GOOGLE_MAPS_API_KEY not set — geocoding disabled');
  return {
    enabled: !!cfg.GOOGLE_MAPS_API_KEY,
    async geocode(address: string): Promise<{ lat: number; lng: number } | null> {
      if (!cfg.GOOGLE_MAPS_API_KEY) return null;
      try {
        const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${cfg.GOOGLE_MAPS_API_KEY}`);
        const body = (await res.json()) as { results?: Array<{ geometry: { location: { lat: number; lng: number } } }> };
        return body.results?.[0]?.geometry.location ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** Product analytics (PostHog). No-op without a key. Never sends customer PII. */
export function createAnalytics(cfg: Config) {
  return {
    enabled: !!cfg.POSTHOG_API_KEY,
    capture(distinctId: string, event: string, properties: Record<string, unknown> = {}) {
      if (!cfg.POSTHOG_API_KEY) return;
      void fetch(`${cfg.POSTHOG_HOST}/capture/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: cfg.POSTHOG_API_KEY, event, distinct_id: distinctId, properties }),
      }).catch(() => {});
    },
  };
}

/** Object storage (S3 / Cloudflare R2). Upload signing is not implemented yet — reported as sandbox. */
export function createStorage(cfg: Config, log: FastifyBaseLogger) {
  const configured = !!(cfg.S3_BUCKET && cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY);
  if (!configured) log.info('[storage] S3/R2 not configured — media uploads disabled');
  return { configured, publicUrl: cfg.S3_PUBLIC_URL ?? null };
}

/**
 * Server-side configuration. The browser never calls the API directly (it uses the same-origin /api proxy),
 * so the API URL is only needed on the server. NEXT_PUBLIC_API_URL is inlined at build time; API_URL, when set,
 * overrides it at runtime (useful when one build is deployed to several environments).
 */
export const API_URL = (process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
export const SITES_BASE_URL = (process.env.SITES_BASE_URL ?? 'http://localhost:3002').replace(/\/$/, '');

/** Hostnames served path-based (the included address). Everything else is a connected custom domain. */
export function includedHosts(): string[] {
  const base = new URL(SITES_BASE_URL).hostname.toLowerCase();
  const extra = (process.env.SITES_EXTRA_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...new Set([base, 'localhost', ...extra])];
}

/** First path segments that are not location slugs under /{brand}/… */
export const BRAND_RESERVED = new Set(['pages', 'sitemap.xml', 'robots.txt', 'properties', 'saved-search', 'f']);

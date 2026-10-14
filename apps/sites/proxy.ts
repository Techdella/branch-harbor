import { NextResponse, type NextRequest } from 'next/server';
import { API_URL, BRAND_RESERVED, includedHosts } from './lib/config';

/**
 * Routing for hosted customer sites.
 *
 * - Included address (SITES_BASE_URL host): path-based, /{brand}/{location}/…
 * - Any other Host: a connected custom domain. It is resolved through the public API (only domains in state
 *   `ready` resolve) and the request is rewritten onto the path-based routes. Lookups are cached in memory.
 *
 * The proxy also forwards the brand/location slugs and the requested language to server components via
 * request headers, and remembers an explicit `?lang=` choice in an essential preference cookie.
 */

type HostMapping = { brandSlug: string; locationSlug: string | null; primaryHost: string | null };
const cache = new Map<string, { value: HostMapping | null; expires: number }>();
const POSITIVE_TTL = 60_000;
const NEGATIVE_TTL = 30_000;

async function resolveHost(host: string): Promise<HostMapping | null | 'error'> {
  const hit = cache.get(host);
  if (hit && hit.expires > Date.now()) return hit.value;
  try {
    const res = await fetch(`${API_URL}/v1/public/sites/resolve-host?host=${encodeURIComponent(host)}`, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
    if (res.status === 404) {
      cache.set(host, { value: null, expires: Date.now() + NEGATIVE_TTL });
      return null;
    }
    if (!res.ok) return 'error';
    const body = (await res.json()) as HostMapping;
    const value = { brandSlug: body.brandSlug, locationSlug: body.locationSlug, primaryHost: body.primaryHost };
    if (cache.size > 5000) cache.clear();
    cache.set(host, { value, expires: Date.now() + POSITIVE_TTL });
    return value;
  } catch {
    return 'error';
  }
}

const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

export async function proxy(req: NextRequest) {
  const url = req.nextUrl;
  const rawHost = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').split(',')[0]!.trim().toLowerCase();
  const host = rawHost.replace(/:\d+$/, '').replace(/\.$/, '');

  const headers = new Headers(req.headers);
  // Never trust client-supplied routing headers.
  for (const h of ['x-bh-host', 'x-bh-host-location', 'x-bh-brand', 'x-bh-location', 'x-bh-lang', 'x-bh-path']) headers.delete(h);

  let pathname = url.pathname;
  let rewrite = false;

  if (host && !includedHosts().includes(host)) {
    const mapping = await resolveHost(host);
    if (mapping === 'error') return NextResponse.rewrite(new URL('/site-unavailable', req.url), { status: 503 });
    if (!mapping) return NextResponse.rewrite(new URL('/unknown-host', req.url), { status: 404 });
    const prefix = `/${mapping.brandSlug}`;
    if (pathname === '/robots.txt' || pathname === '/sitemap.xml') pathname = `${prefix}${pathname}`;
    else pathname = `${prefix}${mapping.locationSlug ? `/${mapping.locationSlug}` : ''}${pathname === '/' ? '' : pathname}`;
    headers.set('x-bh-host', host);
    headers.set('x-bh-host-location', mapping.locationSlug ?? '');
    rewrite = true;
  }

  const segs = pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  headers.set('x-bh-brand', segs[0] ?? '');
  headers.set('x-bh-location', segs[1] && !BRAND_RESERVED.has(segs[1]) ? segs[1] : '');
  headers.set('x-bh-path', pathname);
  const lang = url.searchParams.get('lang');
  if (lang && LANG_RE.test(lang)) headers.set('x-bh-lang', lang);

  const res = rewrite
    ? NextResponse.rewrite(new URL(`${pathname}${url.search}`, req.url), { request: { headers } })
    : NextResponse.next({ request: { headers } });
  if (lang && LANG_RE.test(lang)) {
    // Essential: remembers a language the visitor explicitly chose.
    res.cookies.set('bh_lang', lang, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
  }
  return res;
}

export const config = {
  matcher: ['/((?!_next/|api/|favicon.ico|unknown-host|site-unavailable).*)'],
};

export const dynamic = 'force-dynamic';

import { getBrandSite, isNotFound } from '@/lib/api';
import { MODULE_PATH } from '@/lib/modules';
import { searchListings } from '@/lib/realty';
import { getRouting, makeLinks } from '@/lib/site';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Per-brand sitemap using canonical URLs (custom primary domains when ready, else the included address). */
export async function GET(_req: Request, { params }: { params: Promise<{ brand: string }> }) {
  const { brand } = await params;
  let data;
  try {
    data = await getBrandSite(brand);
  } catch (err) {
    return new Response(isNotFound(err) ? 'Not found' : 'Unavailable', { status: isNotFound(err) ? 404 : 503 });
  }
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
  const urls: Array<{ loc: string; lastmod?: string | null }> = [];
  // Independent business: the brand address IS the location home (listed once, below).
  const single = data.site.singleLocationSlug ?? null;
  if (!single) urls.push({ loc: links.brandCanonical(), lastmod: data.pages.find((p) => p.slug === 'home')?.publishedAt });
  for (const p of data.pages.filter((x) => x.slug !== 'home')) urls.push({ loc: links.brandCanonical(`/pages/${p.slug}`), lastmod: p.publishedAt });
  const mod = MODULE_PATH[data.brand.industry];
  for (const l of data.locations) {
    urls.push({ loc: links.locationCanonical(l.slug, l.primaryHost), lastmod: l.pages.find((p) => p.slug === 'home')?.publishedAt });
    if (mod && l.status === 'operating') urls.push({ loc: links.locationCanonical(l.slug, l.primaryHost, mod) });
    for (const p of l.pages.filter((x) => x.slug !== 'home')) urls.push({ loc: links.locationCanonical(l.slug, l.primaryHost, `/${p.slug}`), lastmod: p.publishedAt });
  }
  if (data.brand.industry === 'realty') {
    // Real Estate: the property search and every public listing (coming soon / active / under offer).
    urls.push({ loc: links.brandCanonical('/properties') });
    const found = await searchListings(brand, new URLSearchParams({ limit: '60' })).catch(() => null);
    for (const l of found?.items ?? []) urls.push({ loc: links.brandCanonical(`/properties/${l.id}`), lastmod: l.publishedAt });
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`)
    .join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}

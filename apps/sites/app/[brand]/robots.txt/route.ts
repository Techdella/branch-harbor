export const dynamic = 'force-dynamic';

import { getBrandSite, isNotFound } from '@/lib/api';
import { SITES_BASE_URL } from '@/lib/config';
import { getRouting } from '@/lib/site';

/** Per-brand robots.txt; served at /robots.txt on the brand's custom domains. Token pages are never indexed. */
export async function GET(_req: Request, { params }: { params: Promise<{ brand: string }> }) {
  const { brand } = await params;
  try {
    await getBrandSite(brand);
  } catch (err) {
    return new Response(isNotFound(err) ? 'Not found' : 'Unavailable', { status: isNotFound(err) ? 404 : 503 });
  }
  const r = await getRouting();
  const sitemap = r.host ? `https://${r.host}/sitemap.xml` : `${SITES_BASE_URL}/${brand}/sitemap.xml`;
  const prefix = r.host ? '' : `/${brand}`;
  const body = [
    'User-agent: *',
    `Allow: ${prefix || '/'}`,
    `Disallow: ${prefix}/*/manage/`,
    `Disallow: ${prefix}/*/orders/`,
    `Disallow: ${prefix}/manage/`,
    `Disallow: ${prefix}/orders/`,
    'Disallow: /api/',
    '',
    `Sitemap: ${sitemap}`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

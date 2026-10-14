import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  return {
    // Social crawlers (e.g. Twitterbot) honour robots.txt when fetching card images, so /api/og stays allowed.
    rules: [{ userAgent: '*', allow: ['/', '/api/og/'], disallow: ['/api/'] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}

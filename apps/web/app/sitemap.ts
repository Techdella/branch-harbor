import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { PAGES, PAGE_IDS, SITE_URL, languageAlternates, localizedPath, type PageDef } from '@/lib/seo';

/** One entry per page per locale, each listing its hreflang alternates. */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return PAGE_IDS.filter((id) => !(PAGES[id] as PageDef).noindex).flatMap((id) => {
    const p: PageDef = PAGES[id];
    const languages = languageAlternates(p.path, true);
    return routing.locales.map((locale) => ({
      url: SITE_URL + localizedPath(locale, p.path),
      lastModified,
      changeFrequency: p.priority >= 0.8 ? ('weekly' as const) : ('monthly' as const),
      priority: p.priority,
      alternates: { languages },
    }));
  });
}

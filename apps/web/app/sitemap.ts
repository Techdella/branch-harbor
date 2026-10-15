import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { ARTICLE_KINDS, getArticles } from '@/lib/articles';
import { PAGES, PAGE_IDS, SITE_URL, languageAlternates, localizedPath, type PageDef } from '@/lib/seo';

/**
 * One entry per page per locale, each listing its hreflang alternates, plus one entry per blog post and guide.
 * Articles are English documents: only their English URL (the canonical) is listed.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const pages = PAGE_IDS.filter((id) => !(PAGES[id] as PageDef).noindex).flatMap((id) => {
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
  const articles = ARTICLE_KINDS.flatMap((kind) =>
    getArticles(kind).map((a) => ({
      url: SITE_URL + localizedPath('en', `/${kind}/${a.slug}`),
      lastModified: new Date(`${a.updated ?? a.date}T00:00:00Z`),
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
  );
  return [...pages, ...articles];
}

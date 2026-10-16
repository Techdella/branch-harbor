import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ASSISTANT_NAME, DEFAULT_LOCALE, type Locale } from '@bh/shared';
import { routing } from '@/i18n/routing';
import { INDUSTRY_KEYS, type IndustryKey } from '@/content/industries';
import { getArticle, type ArticleKind } from '@/lib/articles';

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/** OpenGraph locale codes (language_TERRITORY). */
export const OG_LOCALE: Record<Locale, string> = {
  en: 'en_US',
  'en-GB': 'en_GB',
  fr: 'fr_FR',
  es: 'es_ES',
  de: 'de_DE',
  'pt-BR': 'pt_BR',
  nl: 'nl_NL',
  it: 'it_IT',
  ar: 'ar_AR',
};

/**
 * Every indexable page, keyed by an id that is also used for its OpenGraph image
 * (/api/og/{locale}/{id}). `title`/`description`/`headline` are message keys.
 */
export type PageDef = { path: string; title: string; description: string; headline: string; absoluteTitle?: boolean; noindex?: boolean; priority: number };

const industryPages = Object.fromEntries(
  INDUSTRY_KEYS.map((k) => [
    k,
    { path: `/industries/${k}`, title: `industries.${k}.metaTitle`, description: `industries.${k}.intro`, headline: `industries.${k}.headline`, priority: 0.9 },
  ]),
) as Record<IndustryKey, PageDef>;

export const PAGES = {
  home: { path: '/', title: 'meta.title', description: 'meta.description', headline: 'footer.tagline', absoluteTitle: true, priority: 1 },
  ...industryPages,
  franchises: { path: '/solutions/franchises', title: 'solutions.franchises.metaTitle', description: 'solutions.franchises.intro', headline: 'solutions.franchises.headline', priority: 0.8 },
  independent: { path: '/solutions/independent-businesses', title: 'solutions.independent.metaTitle', description: 'solutions.independent.intro', headline: 'solutions.independent.headline', priority: 0.8 },
  wordpress: { path: '/wordpress', title: 'wordpress.metaTitle', description: 'wordpress.intro', headline: 'wordpress.headline', priority: 0.8 },
  integrations: { path: '/integrations', title: 'integrations.metaTitle', description: 'integrations.intro', headline: 'integrations.headline', priority: 0.8 },
  marina: { path: '/marina', title: 'marina.metaTitle', description: 'marina.intro', headline: 'marina.headline', priority: 0.8 },
  pricing: { path: '/pricing', title: 'pricing.metaTitle', description: 'pricing.intro', headline: 'pricing.headline', priority: 0.9 },
  demo: { path: '/demo', title: 'demo.metaTitle', description: 'demo.intro', headline: 'demo.headline', priority: 0.9 },
  blog: { path: '/blog', title: 'articles.blog.metaTitle', description: 'articles.blog.intro', headline: 'articles.blog.headline', priority: 0.7 },
  guides: { path: '/guides', title: 'articles.guides.metaTitle', description: 'articles.guides.intro', headline: 'articles.guides.headline', priority: 0.7 },
  resources: { path: '/resources', title: 'resources.metaTitle', description: 'resources.intro', headline: 'resources.headline', priority: 0.6 },
  docs: { path: '/docs', title: 'docs.metaTitle', description: 'docs.intro', headline: 'docs.headline', priority: 0.6 },
  support: { path: '/support', title: 'support.metaTitle', description: 'support.intro', headline: 'support.headline', priority: 0.6 },
  about: { path: '/about', title: 'about.metaTitle', description: 'about.intro', headline: 'about.headline', priority: 0.6 },
  privacy: { path: '/privacy', title: 'legal.privacy.metaTitle', description: 'legal.privacy.intro', headline: 'legal.privacy.title', priority: 0.3 },
  terms: { path: '/terms', title: 'legal.terms.metaTitle', description: 'legal.terms.intro', headline: 'legal.terms.title', priority: 0.3 },
  security: { path: '/security', title: 'legal.security.metaTitle', description: 'legal.security.intro', headline: 'legal.security.title', priority: 0.3 },
  'sign-in': { path: '/sign-in', title: 'signIn.metaTitle', description: 'signIn.body', headline: 'signIn.title', noindex: true, priority: 0.2 },
} satisfies Record<string, PageDef>;

export type PageId = keyof typeof PAGES;
export const PAGE_IDS = Object.keys(PAGES) as PageId[];

export function isPageId(v: string): v is PageId {
  return v in PAGES;
}

/** "/de" + "/pricing" → "/de/pricing"; the home page is "/de". */
export function localizedPath(locale: string, path: string): string {
  return `/${locale}${path === '/' ? '' : path}`;
}

/** hreflang alternates for one page in every locale, plus x-default (English). */
export function languageAlternates(path: string, absolute = false): Record<string, string> {
  const prefix = absolute ? SITE_URL : '';
  return {
    ...Object.fromEntries(routing.locales.map((l) => [l, prefix + localizedPath(l, path)])),
    'x-default': prefix + localizedPath(DEFAULT_LOCALE, path),
  };
}

/** Translated title, description and image headline for a page. */
export async function pageCopy(locale: string, id: PageId) {
  const t = await getTranslations({ locale });
  const p: PageDef = PAGES[id];
  // Every page may name the assistant; its name lives in one constant.
  const v = { name: ASSISTANT_NAME } as never;
  const title = t(p.title as never, v) as string;
  return {
    title,
    fullTitle: p.absoluteTitle ? title : t('meta.titleTemplate').replace('%s', title),
    description: t(p.description as never, v) as string,
    headline: t(p.headline as never, v) as string,
    siteName: 'BranchHarbor',
  };
}

/**
 * Page metadata: translated title/description, canonical + hreflang alternates for every locale,
 * and OpenGraph/Twitter cards with a generated, translated image.
 */
export async function buildMetadata(locale: string, id: PageId): Promise<Metadata> {
  const p: PageDef = PAGES[id];
  const copy = await pageCopy(locale, id);
  const url = localizedPath(locale, p.path);
  const image = { url: `/api/og/${locale}/${id}`, width: 1200, height: 630, alt: copy.headline };
  return {
    title: p.absoluteTitle ? { absolute: copy.title } : copy.title,
    description: copy.description,
    alternates: { canonical: url, languages: languageAlternates(p.path) },
    openGraph: {
      type: 'website',
      siteName: copy.siteName,
      title: copy.fullTitle,
      description: copy.description,
      url,
      locale: OG_LOCALE[locale as Locale] ?? 'en_US',
      alternateLocale: routing.locales.filter((l) => l !== locale).map((l) => OG_LOCALE[l]),
      images: [image],
    },
    twitter: { card: 'summary_large_image', title: copy.fullTitle, description: copy.description, images: [image] },
    ...(p.noindex ? { robots: { index: false, follow: true } } : {}),
  };
}

/**
 * Article metadata. Articles are written in English, so every locale's page points its canonical URL at the English
 * article (the translated chrome around it is not a separate document) and only English is listed as an alternate.
 */
export async function articleMetadata(locale: string, kind: ArticleKind, slug: string): Promise<Metadata> {
  const a = getArticle(kind, slug);
  if (!a) return {};
  const t = await getTranslations({ locale });
  const path = `/${kind}/${slug}`;
  const canonical = localizedPath('en', path);
  const fullTitle = t('meta.titleTemplate').replace('%s', a.title);
  const image = { url: `/api/og/article/${kind}/${slug}`, width: 1200, height: 630, alt: a.title };
  return {
    title: a.title,
    description: a.description,
    authors: [{ name: a.author }],
    keywords: a.tags,
    alternates: {
      canonical,
      languages: { en: canonical, 'x-default': canonical },
      types: kind === 'blog' ? { 'application/rss+xml': [{ url: '/blog/rss.xml', title: 'BranchHarbor blog' }] } : undefined,
    },
    openGraph: {
      type: 'article',
      siteName: 'BranchHarbor',
      title: fullTitle,
      description: a.description,
      url: localizedPath(locale, path),
      locale: 'en_US',
      publishedTime: a.date,
      modifiedTime: a.updated ?? a.date,
      authors: [a.author],
      tags: a.tags,
      images: [image],
    },
    twitter: { card: 'summary_large_image', title: fullTitle, description: a.description, images: [image] },
  };
}

import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { ArticlePage } from '@/components/articles/ArticlePage';
import { getArticles } from '@/lib/articles';
import { articleMetadata } from '@/lib/seo';

export const dynamicParams = false;

export function generateStaticParams() {
  return routing.locales.flatMap((locale) => getArticles('guides').map((a) => ({ locale, slug: a.slug })));
}

type Props = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  return articleMetadata(locale, 'guides', slug);
}

export default async function GuideArticle({ params }: Props) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  return <ArticlePage kind="guides" slug={slug} />;
}

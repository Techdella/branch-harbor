import { setRequestLocale } from 'next-intl/server';
import { ArticleIndexPage } from '@/components/articles/ArticleIndexPage';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };

export const generateMetadata = async ({ params }: Props) => buildMetadata((await params).locale, 'guides');

export default async function GuidesIndex({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <ArticleIndexPage kind="guides" />;
}

import { setRequestLocale } from 'next-intl/server';
import { SolutionPage } from '@/components/site/SolutionPage';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };

export const generateMetadata = async ({ params }: Props) => buildMetadata((await params).locale, 'franchises');

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <SolutionPage which="franchises" />;
}

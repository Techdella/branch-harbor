import { setRequestLocale } from 'next-intl/server';
import { LegalPage } from '@/components/site/LegalPage';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };
export const generateMetadata = async ({ params }: Props) => buildMetadata((await params).locale, 'terms');

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <LegalPage doc="terms" />;
}

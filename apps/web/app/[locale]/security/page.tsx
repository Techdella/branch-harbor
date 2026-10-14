import { setRequestLocale } from 'next-intl/server';
import { LegalPage } from '@/components/site/LegalPage';
import { pageMetadata } from '@/components/site/meta';

type Props = { params: Promise<{ locale: string }> };
export const generateMetadata = async ({ params }: Props) => pageMetadata((await params).locale, 'legal.security');

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <LegalPage doc="security" />;
}

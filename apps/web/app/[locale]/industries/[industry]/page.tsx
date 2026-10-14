import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { INDUSTRY_KEYS, isIndustryKey } from '@/content/industries';
import { IndustryTemplate } from '@/components/industry/IndustryTemplate';

export const dynamicParams = false;

export function generateStaticParams() {
  return routing.locales.flatMap((locale) => INDUSTRY_KEYS.map((industry) => ({ locale, industry })));
}

type Props = { params: Promise<{ locale: string; industry: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, industry } = await params;
  if (!isIndustryKey(industry)) return {};
  const t = await getTranslations({ locale, namespace: 'industries' });
  return { title: t(`${industry}.metaTitle`), description: t(`${industry}.intro`) };
}

export default async function IndustryPage({ params }: Props) {
  const { locale, industry } = await params;
  if (!isIndustryKey(industry)) notFound();
  setRequestLocale(locale);
  return <IndustryTemplate industry={industry} />;
}

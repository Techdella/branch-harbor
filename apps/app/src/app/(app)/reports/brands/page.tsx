import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BrandComparisonScreen } from '@/components/brands/BrandComparisonScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('brands'))('meta.compare') };
}
export default function Page() {
  return <BrandComparisonScreen />;
}

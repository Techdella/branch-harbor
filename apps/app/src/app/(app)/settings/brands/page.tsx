import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BrandsScreen } from '@/components/brands/BrandsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('brands'))('meta.settings') };
}
export default function Page() {
  return <BrandsScreen />;
}

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RebatesScreen } from '@/components/supply/RebatesScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('supply'))('rebates.title') };
}
export default function Page() {
  return <RebatesScreen />;
}

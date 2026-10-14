import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MarketingScreen } from '@/components/screens/SimpleScreens';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('marketing') };
}
export default function Page() {
  return <MarketingScreen />;
}

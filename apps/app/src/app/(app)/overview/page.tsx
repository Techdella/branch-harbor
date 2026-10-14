import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { OverviewScreen } from '@/components/screens/OverviewScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('overview') };
}
export default function Page() {
  return <OverviewScreen />;
}

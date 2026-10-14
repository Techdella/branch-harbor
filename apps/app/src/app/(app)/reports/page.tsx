import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ReportsScreen } from '@/components/screens/ReportsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('reports') };
}
export default function Page() {
  return (
    <ReportsScreen />
  );
}

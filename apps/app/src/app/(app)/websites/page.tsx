import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { WebsitesScreen } from '@/components/screens/WebsitesScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('websites') };
}
export default function Page() {
  return (
    <Suspense>
      <WebsitesScreen />
    </Suspense>
  );
}

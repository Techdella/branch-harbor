import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { ListingsScreen } from '@/components/local-marketing/ListingsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('lmk.listings'))('title') };
}
export default function Page() {
  return (
    <Suspense>
      <ListingsScreen />
    </Suspense>
  );
}

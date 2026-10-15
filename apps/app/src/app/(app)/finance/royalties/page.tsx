import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { RoyaltiesScreen } from '@/components/finance/RoyaltiesScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('finance'))('royalties.title') };
}
export default function Page() {
  return (
    <Suspense>
      <RoyaltiesScreen />
    </Suspense>
  );
}

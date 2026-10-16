import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { SuppliersScreen } from '@/components/supply/SuppliersScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('supply'))('title') };
}
export default function Page() {
  return (
    <Suspense>
      <SuppliersScreen />
    </Suspense>
  );
}

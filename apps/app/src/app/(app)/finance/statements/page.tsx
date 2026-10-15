import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { StatementsScreen } from '@/components/finance/StatementsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('finance'))('mine.title') };
}
export default function Page() {
  return (
    <Suspense>
      <StatementsScreen />
    </Suspense>
  );
}

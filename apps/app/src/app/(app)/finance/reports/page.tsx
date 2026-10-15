import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { FinanceReportsScreen } from '@/components/finance/PayoutsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('finance'))('reports.title') };
}
export default function Page() {
  return (
    <Suspense>
      <FinanceReportsScreen />
    </Suspense>
  );
}

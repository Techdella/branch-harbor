import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { PaymentsScreen } from '@/components/screens/PaymentsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('payments') };
}
export default function Page() {
  return (
    <Suspense>
      <PaymentsScreen />
    </Suspense>
  );
}

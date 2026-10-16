import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { SelfChecksScreen } from '@/components/supply/SelfChecksScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auditsPlus'))('self.title') };
}
export default function Page() {
  return (
    <Suspense>
      <SelfChecksScreen />
    </Suspense>
  );
}

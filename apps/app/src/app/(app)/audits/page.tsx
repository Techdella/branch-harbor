import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { AuditsScreen } from '@/components/quality/AuditsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('quality'))('audits.title') };
}
export default function Page() {
  return (
    <Suspense>
      <AuditsScreen />
    </Suspense>
  );
}

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { CallsScreen } from '@/components/local-marketing/CallsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('lmk.calls'))('title') };
}
export default function Page() {
  return (
    <Suspense>
      <CallsScreen />
    </Suspense>
  );
}

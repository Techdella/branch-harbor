import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { CalendarScreen } from '@/components/local-marketing/CalendarScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('lmk.calendar'))('title') };
}
export default function Page() {
  return (
    <Suspense>
      <CalendarScreen />
    </Suspense>
  );
}

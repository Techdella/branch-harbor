import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { HelpdeskScreen } from '@/components/helpdesk/HelpdeskScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('help') };
}
export default function Page() {
  return (
    <Suspense>
      <HelpdeskScreen />
    </Suspense>
  );
}

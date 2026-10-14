import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { Onboarding } from '@/components/onboarding/Onboarding';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('onboarding') };
}
export default function Page() {
  return (
    <Suspense>
      <Onboarding />
    </Suspense>
  );
}

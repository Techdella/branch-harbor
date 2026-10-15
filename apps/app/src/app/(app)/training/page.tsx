import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TrainingScreen } from '@/components/training/TrainingScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('training') };
}
export default function Page() {
  return (
    <Suspense>
      <TrainingScreen />
    </Suspense>
  );
}

import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CourseLeadsScreen } from '@/components/training/CourseLeadsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('training.leads'))('title') };
}
export default function Page() {
  return (
    <Suspense>
      <CourseLeadsScreen />
    </Suspense>
  );
}

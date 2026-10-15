import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { ASSISTANT_NAME } from '@bh/shared';
import { VisitBriefScreen } from '@/components/marina/VisitBriefScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('marina'))('meta.visit', { name: ASSISTANT_NAME }) };
}
export default function Page() {
  return (
    <Suspense>
      <VisitBriefScreen />
    </Suspense>
  );
}

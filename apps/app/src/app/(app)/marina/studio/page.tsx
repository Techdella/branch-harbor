import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { ASSISTANT_NAME } from '@bh/shared';
import { ContentStudio } from '@/components/marina/ContentStudio';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('marina'))('meta.studio', { name: ASSISTANT_NAME }) };
}
export default function Page() {
  return (
    <Suspense>
      <ContentStudio />
    </Suspense>
  );
}

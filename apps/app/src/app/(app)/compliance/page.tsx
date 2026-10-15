import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { ComplianceScreen } from '@/components/quality/ComplianceScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('quality'))('compliance.title') };
}
export default function Page() {
  return (
    <Suspense>
      <ComplianceScreen />
    </Suspense>
  );
}

import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Onboarding } from '@/components/onboarding/Onboarding';

export const metadata: Metadata = { title: 'Set up BranchHarbor' };
export default function Page() {
  return (
    <Suspense>
      <Onboarding />
    </Suspense>
  );
}

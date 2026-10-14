import type { Metadata } from 'next';
import { Suspense } from 'react';
import { WebsitesScreen } from '@/components/screens/WebsitesScreen';

export const metadata: Metadata = { title: 'Websites' };
export default function Page() {
  return (
    <Suspense>
      <WebsitesScreen />
    </Suspense>
  );
}

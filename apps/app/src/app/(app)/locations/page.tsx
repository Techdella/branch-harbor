import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { LocationsScreen } from '@/components/screens/LocationsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('locations') };
}
export default function Page() {
  return (
    <Suspense>
      <LocationsScreen />
    </Suspense>
  );
}

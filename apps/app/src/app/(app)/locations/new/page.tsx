import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NewLocationScreen } from '@/components/screens/NewLocationScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('addLocation') };
}
export default function Page() {
  return <NewLocationScreen />;
}

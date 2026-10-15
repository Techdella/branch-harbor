import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LaunchScreen } from '@/components/scale/LaunchScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('scale'))('launch.title') };
}
export default function Page() {
  return <LaunchScreen />;
}

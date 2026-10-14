import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CommunityScreen } from '@/components/screens/SimpleScreens';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('community') };
}
export default function Page() {
  return <CommunityScreen />;
}

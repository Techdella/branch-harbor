import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TeamScreen } from '@/components/screens/TeamScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('team') };
}
export default function Page() {
  return (
    <TeamScreen />
  );
}

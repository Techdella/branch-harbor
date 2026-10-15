import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ScheduleScreen } from '@/components/screens/TeamScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('access'))('nav.schedule') };
}
export default function Page() {
  return <ScheduleScreen />;
}

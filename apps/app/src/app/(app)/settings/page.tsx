import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SettingsScreen } from '@/components/screens/SettingsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('settings') };
}
export default function Page() {
  return (
    <SettingsScreen />
  );
}

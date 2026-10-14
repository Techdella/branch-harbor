import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ConnectionsScreen } from '@/components/screens/ConnectionsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('connections') };
}
export default function Page() {
  return (
    <ConnectionsScreen />
  );
}

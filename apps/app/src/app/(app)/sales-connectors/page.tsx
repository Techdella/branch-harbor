import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SalesConnectorsScreen } from '@/components/scale/SalesConnectorsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('scale'))('connectors.title') };
}
export default function Page() {
  return <SalesConnectorsScreen />;
}

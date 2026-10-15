import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LeadsScreen } from '@/components/marketing-comms/LeadsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('comms.meta'))('leads') };
}
export default function Page() {
  return <LeadsScreen />;
}

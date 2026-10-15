import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InboxScreen } from '@/components/marketing-comms/InboxScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('comms.meta'))('inbox') };
}
export default function Page() {
  return <InboxScreen />;
}

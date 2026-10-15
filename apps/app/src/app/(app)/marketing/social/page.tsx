import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SocialScreen } from '@/components/marketing-comms/SocialScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('comms.meta'))('social') };
}
export default function Page() {
  return <SocialScreen />;
}

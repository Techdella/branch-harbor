import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CampaignsScreen } from '@/components/marketing-comms/CampaignsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('comms.meta'))('campaigns') };
}
export default function Page() {
  return <CampaignsScreen />;
}

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ReconciliationScreen } from '@/components/scale/ReconciliationScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('scale'))('recon.title') };
}
export default function Page() {
  return <ReconciliationScreen />;
}

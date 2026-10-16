import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MasterScreen } from '@/components/fdev/MasterScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('fdev'))('master.splitsTitle') };
}
export default function Page() {
  return <MasterScreen initial="statements" />;
}

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ImportScreen } from '@/components/scale/ImportScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('scale'))('import.title') };
}
export default function Page() {
  return <ImportScreen />;
}

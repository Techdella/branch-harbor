import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BenchmarksScreen } from '@/components/scale/BenchmarksScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('scale'))('bench.title') };
}
export default function Page() {
  return <BenchmarksScreen />;
}

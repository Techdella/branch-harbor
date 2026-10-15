import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SelfCheckRunScreen } from '@/components/supply/SelfChecksScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auditsPlus'))('self.runTitle') };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SelfCheckRunScreen id={id} />;
}

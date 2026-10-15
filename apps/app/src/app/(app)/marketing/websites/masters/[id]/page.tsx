import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BuilderScreen } from '@/components/marketing/website/BuilderScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('mkt'))('meta.master') };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BuilderScreen masterId={id} />;
}

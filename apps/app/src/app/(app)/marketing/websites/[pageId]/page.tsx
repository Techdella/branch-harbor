import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BuilderScreen } from '@/components/marketing/website/BuilderScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('mkt'))('meta.builder') };
}
export default async function Page({ params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  return <BuilderScreen pageId={pageId} />;
}

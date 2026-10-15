import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FlowEditor } from '@/components/marketing/automations/FlowEditor';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('mkt'))('meta.automation') };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FlowEditor id={id} />;
}

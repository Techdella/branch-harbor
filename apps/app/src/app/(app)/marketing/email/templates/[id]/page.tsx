import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TemplateScreen } from '@/components/marketing/email/EmailScreens';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('mkt'))('meta.emailTemplate') };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TemplateScreen id={id} />;
}

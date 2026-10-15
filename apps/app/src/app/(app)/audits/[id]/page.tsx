import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuditScreen } from '@/components/quality/AuditScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('quality'))('audit.pageTitle') };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AuditScreen id={id} />;
}

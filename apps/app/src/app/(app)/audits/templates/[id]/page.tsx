import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TemplateEditor } from '@/components/quality/TemplateEditor';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('quality'))('editor.pageTitle') };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TemplateEditor id={id} />;
}

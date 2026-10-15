import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FormEditorScreen } from '@/components/marketing/forms/FormScreens';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('mkt'))('meta.form') };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FormEditorScreen id={id} />;
}

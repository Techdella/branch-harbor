import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FormsHub } from '@/components/marketing/forms/FormScreens';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('mkt'))('meta.forms') };
}
export default function Page() {
  return <FormsHub />;
}

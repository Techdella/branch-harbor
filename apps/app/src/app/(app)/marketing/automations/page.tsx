import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AutomationsHub } from '@/components/marketing/automations/AutomationsHub';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('mkt'))('meta.automations') };
}
export default function Page() {
  return <AutomationsHub />;
}

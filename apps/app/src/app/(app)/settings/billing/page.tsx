import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BillingScreen } from '@/components/screens/billing/BillingScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('billing'))('title') };
}
export default function Page() {
  return <BillingScreen />;
}

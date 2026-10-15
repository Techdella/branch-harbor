import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FranchiseeBillingScreen } from '@/components/screens/billing/FranchiseeBillingScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('billing.franchisee'))('title') };
}
export default function Page() {
  return <FranchiseeBillingScreen />;
}

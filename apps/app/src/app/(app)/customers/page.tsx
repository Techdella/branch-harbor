import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CustomersScreen } from '@/components/screens/SimpleScreens';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('customers') };
}
export default function Page() {
  return <CustomersScreen />;
}

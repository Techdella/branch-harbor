import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ApprovalsScreen } from '@/components/screens/ApprovalsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('approvals') };
}
export default function Page() {
  return <ApprovalsScreen />;
}

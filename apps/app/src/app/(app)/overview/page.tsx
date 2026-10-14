import type { Metadata } from 'next';
import { OverviewScreen } from '@/components/screens/OverviewScreen';

export const metadata: Metadata = { title: 'Overview' };
export default function Page() {
  return <OverviewScreen />;
}

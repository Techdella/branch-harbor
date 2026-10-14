import type { Metadata } from 'next';
import { MarketingScreen } from '@/components/screens/SimpleScreens';

export const metadata: Metadata = { title: 'Marketing' };
export default function Page() {
  return <MarketingScreen />;
}

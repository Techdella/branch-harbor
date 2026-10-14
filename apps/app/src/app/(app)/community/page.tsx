import type { Metadata } from 'next';
import { CommunityScreen } from '@/components/screens/SimpleScreens';

export const metadata: Metadata = { title: 'Community & resources' };
export default function Page() {
  return <CommunityScreen />;
}

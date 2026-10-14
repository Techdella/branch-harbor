import type { Metadata } from 'next';
import { ApprovalsScreen } from '@/components/screens/ApprovalsScreen';

export const metadata: Metadata = { title: 'Approvals' };
export default function Page() {
  return <ApprovalsScreen />;
}

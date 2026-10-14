import type { Metadata } from 'next';
import { ReportsScreen } from '@/components/screens/ReportsScreen';

export const metadata: Metadata = { title: 'Reports' };
export default function Page() {
  return (
    <ReportsScreen />
  );
}

import type { Metadata } from 'next';
import { TeamScreen } from '@/components/screens/TeamScreen';

export const metadata: Metadata = { title: 'Team' };
export default function Page() {
  return (
    <TeamScreen />
  );
}

import type { Metadata } from 'next';
import { ConnectionsScreen } from '@/components/screens/ConnectionsScreen';

export const metadata: Metadata = { title: 'Connections' };
export default function Page() {
  return (
    <ConnectionsScreen />
  );
}

import type { Metadata } from 'next';
import { NewLocationScreen } from '@/components/screens/NewLocationScreen';

export const metadata: Metadata = { title: 'Add location' };
export default function Page() {
  return <NewLocationScreen />;
}

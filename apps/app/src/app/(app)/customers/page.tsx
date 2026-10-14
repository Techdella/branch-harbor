import type { Metadata } from 'next';
import { CustomersScreen } from '@/components/screens/SimpleScreens';

export const metadata: Metadata = { title: 'Customers' };
export default function Page() {
  return <CustomersScreen />;
}

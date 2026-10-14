import { Stack } from 'expo-router';
import { color } from '@/theme';

/** Real Estate: buyer search/detail/saved, agent day and owner pulse. Reached from the customer, staff and owner experiences. */
export default function RealtyLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.canvas } }} />;
}

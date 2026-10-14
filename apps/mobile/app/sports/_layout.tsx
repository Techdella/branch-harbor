import { Redirect, Stack } from 'expo-router';
import { useSession } from '@/lib/session';
import { color } from '@/theme';

/** Sports area: guardian portal, coach attendance and the owner's enrolment pulse. */
export default function SportsLayout() {
  const { status } = useSession();
  if (status === 'signedOut') return <Redirect href="/" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.canvas } }} />;
}

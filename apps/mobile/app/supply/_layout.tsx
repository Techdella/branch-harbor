import { useEffect } from 'react';
import { Redirect, Stack } from 'expo-router';
import { useSession } from '@/lib/session';
import { startOfflineSync } from '@/features/quality/offline';
import { color } from '@/theme';

export default function SupplyLayout() {
  const { status } = useSession();
  // Self-checks use the audits' offline queue: keep it syncing while these screens are open.
  useEffect(() => { startOfflineSync(); }, []);
  if (status === 'signedOut') return <Redirect href="/" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.canvas } }} />;
}

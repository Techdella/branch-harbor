import { useEffect } from 'react';
import { Redirect, Stack } from 'expo-router';
import { useSession } from '@/lib/session';
import { startOfflineSync } from '@/features/quality/offline';
import { color } from '@/theme';

export default function QualityLayout() {
  const { status } = useSession();
  useEffect(() => { startOfflineSync(); }, []);
  if (status === 'signedOut') return <Redirect href="/" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.canvas } }} />;
}

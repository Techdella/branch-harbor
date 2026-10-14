import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/tabs';
import { TabBar, type IconName } from '@/components';
import { useI18n } from '@/i18n';
import { useCt } from '@/features/commerce/strings';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/useApi';

const ICONS: Record<string, IconName> = { pulse: 'activity', approvals: 'check-circle', locations: 'store', alerts: 'bell', utilisation: 'chart', sales: 'cart' };

export default function OwnerTabs() {
  const { t } = useI18n();
  const { ct } = useCt();
  const { status, me } = useSession();
  // A single independent business has one location: no locations list to switch between.
  const single = me?.business?.model === 'independent';
  const approvals = useApi(() => api.approvals(), [], { pollMs: 30_000 });
  if (status === 'signedOut') return <Redirect href="/" />;
  const pending = approvals.data?.filter((a) => a.status === 'pending').length ?? 0;
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(p) => <TabBar {...p} icons={ICONS} />}>
      <Tabs.Screen name="pulse" options={{ title: t('tabs.pulse') }} />
      <Tabs.Screen name="approvals" options={{ title: t('tabs.approvals'), tabBarBadge: pending || undefined }} />
      <Tabs.Screen name="locations" options={{ title: t('tabs.locations'), ...(single ? { href: null } : {}) }} />
      <Tabs.Screen name="alerts" options={{ title: t('tabs.alerts') }} />
      <Tabs.Screen name="utilisation" options={{ title: 'Utilisation' }} />
      <Tabs.Screen name="sales" options={{ title: ct('shopTitle') }} />
    </Tabs>
  );
}

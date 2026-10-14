import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/tabs';
import { TabBar, type IconName } from '@/components';
import { useI18n } from '@/i18n';
import { useCt } from '@/features/commerce/strings';
import { useSession } from '@/lib/session';

const ICONS: Record<string, IconName> = { today: 'home', checkin: 'check-circle', kitchen: 'chef', messages: 'message', cover: 'repeat', appointments: 'calendar', shopfloor: 'box' };

export default function StaffTabs() {
  const { t } = useI18n();
  const { ct } = useCt();
  const { status } = useSession();
  if (status === 'signedOut') return <Redirect href="/" />;
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(p) => <TabBar {...p} icons={ICONS} />}>
      <Tabs.Screen name="today" options={{ title: t('tabs.today') }} />
      <Tabs.Screen name="checkin" options={{ title: t('tabs.checkin') }} />
      <Tabs.Screen name="kitchen" options={{ title: t('tabs.kitchen') }} />
      <Tabs.Screen name="messages" options={{ title: t('tabs.messages') }} />
      <Tabs.Screen name="cover" options={{ title: t('tabs.cover') }} />
      <Tabs.Screen name="appointments" options={{ title: 'Appointments' }} />
      <Tabs.Screen name="shopfloor" options={{ title: ct('floorTitle') }} />
    </Tabs>
  );
}

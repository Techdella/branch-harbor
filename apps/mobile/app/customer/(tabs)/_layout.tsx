import { Tabs } from 'expo-router/tabs';
import { TabBar, type IconName } from '@/components';
import { useCatalog } from '@/features/customer/catalog';
import { useI18n } from '@/i18n';

const ICONS: Record<string, IconName> = { home: 'home', book: 'lotus', order: 'utensils', bookings: 'calendar', inbox: 'message', profile: 'user' };

export default function CustomerTabs() {
  const { t } = useI18n();
  const { brand } = useCatalog();
  const foods = brand?.industry === 'foods';
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(p) => <TabBar {...p} icons={ICONS} />}>
      <Tabs.Screen name="home" options={{ title: t('tabs.home') }} />
      {/* Book (studios) and Order (foods) are the brand's primary action; the other is hidden, never a dead tab. */}
      <Tabs.Screen name="book" options={{ title: t('tabs.book'), href: foods ? null : undefined }} />
      <Tabs.Screen name="order" options={{ title: t('tabs.order'), href: foods ? undefined : null }} />
      <Tabs.Screen name="bookings" options={{ title: foods ? t('bookings.orders') : t('tabs.bookings') }} />
      <Tabs.Screen name="inbox" options={{ title: t('tabs.inbox') }} />
      <Tabs.Screen name="profile" options={{ title: t('tabs.profile') }} />
    </Tabs>
  );
}

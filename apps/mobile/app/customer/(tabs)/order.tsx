import { Image, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Button, Card, DataStatus, EmptyState, MoneyText, Screen, ScreenHeader, SectionHeader, SkeletonCard, Tag, Text } from '@/components';
import { useCart } from '@/features/customer/cart';
import { useCatalog } from '@/features/customer/catalog';
import { useLocationScope } from '@/features/customer/useLocationScope';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { fmtMoney, fmtTime, fmtZone, localDateKey } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import type { MenuItem, PickupSlot } from '@/lib/types';
import { color, pastel } from '@/theme';

export default function Order() {
  const { t, intlLocale } = useI18n();
  const { brand, location } = useCatalog();
  const scope = useLocationScope(location, brand?.name);
  const cart = useCart();
  const slotsQ = useApi(() => (location ? api.pickupSlots(location.id, localDateKey(new Date(), location.timeZone)) : Promise.resolve([] as PickupSlot[])), [location?.id]);
  const menuQ = useApi(() => (location ? api.menu(location.id) : Promise.resolve([] as MenuItem[])), [location?.id]);

  if (!location) return <Screen><SkeletonCard /></Screen>;
  const slot = cart.locationId === location.id ? cart.slot : null;
  const lines = cart.locationId === location.id ? cart.lines : [];
  const count = lines.reduce((a, l) => a + l.quantity, 0);
  const categories = [...new Set((menuQ.data ?? []).map((m) => m.category))];

  return (
    <Screen
      onRefresh={() => { void slotsQ.refresh(); void menuQ.refresh(); }}
      refreshing={slotsQ.refreshing}
      footer={count > 0 && cart.estimate ? (
        <Button label={`${t('order.viewOrder')} · ${t('order.items', { count })} · ${fmtMoney(cart.estimate, intlLocale)}`} size="lg" iconEnd="arrow-right" onPress={() => router.push('/customer/checkout')} />
      ) : undefined}
    >
      <ScreenHeader title={t('order.pickupFrom', { location: location.name })} scope={scope} />
      <DataStatus q={slotsQ} />

      <SectionHeader title={t('order.chooseTime')} sub={`${t('common.today')} · ${t('common.timesIn', { zone: fmtZone(location.timeZone, intlLocale) })}`} />
      {slotsQ.loading ? <SkeletonCard lines={2} /> : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {(slotsQ.data ?? []).map((s) => (
            <Tag
              key={s.id}
              label={fmtTime(s.startsAt, location.timeZone, intlLocale)}
              sub={s.remaining === 0 ? t('order.slotFull') : t('order.slotLeft', { count: s.remaining })}
              selected={slot?.id === s.id}
              disabled={s.remaining === 0}
              onPress={() => cart.setSlot(location.id, s)}
            />
          ))}
        </ScrollView>
      )}

      {!slot ? (
        <EmptyState icon="clock" bg={pastel.blush} title={t('order.chooseTime')} body={t('order.chooseSlotFirst')} />
      ) : (
        <>
          <DataStatus q={menuQ} />
          {menuQ.loading ? <SkeletonCard /> : null}
          {categories.map((cat) => (
            <View key={cat} style={{ gap: 10 }}>
              <SectionHeader title={cat} />
              {(menuQ.data ?? []).filter((m) => m.category === cat).map((m) => (
                <Card key={m.id} padding={0} onPress={m.soldOut ? undefined : () => router.push({ pathname: '/customer/item/[id]', params: { id: m.id, locationId: location.id } })} accessibilityLabel={`${m.name}, ${fmtMoney(m.price, intlLocale)}${m.soldOut ? `, ${t('order.soldOut')}` : ''}`} style={{ overflow: 'hidden', opacity: m.soldOut ? 0.6 : 1 }}>
                  <Image source={{ uri: m.image }} style={{ width: '100%', height: 130 }} accessibilityIgnoresInvertColors />
                  <View style={{ padding: 14, gap: 6 }}>
                    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                      <View style={{ flex: 1 }}>
                        <Text variant="h3">{m.name}</Text>
                        <Text variant="small" tone="muted">{m.description}</Text>
                      </View>
                      <MoneyText value={m.price} weight={800} />
                    </View>
                    <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      {m.soldOut ? <Badge label={t('order.soldOut')} tone="neutral" icon="x" /> : null}
                      {m.dietary.map((d) => <Tag key={d} label={d} bg={pastel.lime} icon="leaf" />)}
                    </View>
                  </View>
                </Card>
              ))}
            </View>
          ))}
          <Text variant="small" tone="muted">{t('order.allergyNote')}</Text>
        </>
      )}
      {count > 0 ? <View style={{ height: 8, backgroundColor: color.canvas }} /> : null}
    </Screen>
  );
}

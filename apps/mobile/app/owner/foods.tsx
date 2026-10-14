import { View } from 'react-native';
import { Badge, Card, DataStatus, EmptyState, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text } from '@/components';
import { foodsApi } from '@/features/foods/api';
import { useI18n } from '@/i18n';
import { relativeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';

/** Owner pulse for Foods: live orders per location, overdue, sold out, low stock, catering and deliveries waiting. */
export default function FoodsPulse() {
  const { t, intlLocale } = useI18n();
  const q = useApi(() => foodsApi.pulse(), [], { pollMs: 30_000 });
  return (
    <Screen tabs={false} onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('foodsx.pulse')} back kicker={t('foodsx.pulseSub')} />
      <DataStatus q={q} />
      {q.data ? <Text variant="small" tone="muted">{t('common.lastUpdated', { time: relativeAgo(q.data.refreshedAt, intlLocale) })}</Text> : null}
      {q.loading ? <SkeletonCard lines={4} /> : null}
      {q.data && !q.data.orgs.length ? <EmptyState icon="utensils" title={t('common.unavailable')} /> : null}
      {q.data?.orgs.map((o) => (
        <View key={o.orgId} style={{ gap: 8 }}>
          <SectionHeader title={o.name} />
          {o.locations.map((l) => {
            const inKitchen = (l.orders.accepted ?? 0) + (l.orders.preparing ?? 0);
            return (
              <Card key={l.locationId}>
                <Text variant="h3">{l.name}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <Badge tone={l.orders.awaiting_acceptance ? 'warning' : 'neutral'} icon="clock" label={t('foodsx.awaitingN', { count: l.orders.awaiting_acceptance ?? 0 })} />
                  <Badge tone="info" icon="chef" label={t('foodsx.inKitchen', { count: inKitchen })} />
                  {l.overdue ? <Badge tone="danger" icon="alert" label={t('foodsx.overdueN', { count: l.overdue })} /> : null}
                  {l.deliveries.ordersAwaitingDispatch ? <Badge tone="warning" icon="truck" label={t('foodsx.toDispatch', { count: l.deliveries.ordersAwaitingDispatch })} /> : null}
                  {l.catering.new ? <Badge tone="info" icon="gift" label={t('foodsx.cateringNew', { count: l.catering.new })} /> : null}
                </View>
                {Object.keys(l.byChannel).length ? <Text variant="small" tone="muted">{t('foodsx.channels')}: {Object.entries(l.byChannel).map(([k, v]) => `${t(`foodsx.channel.${k}`)} ${v}`).join(' · ')}</Text> : null}
                {l.soldOut.length ? <Text variant="small">{t('foodsx.soldOut', { list: l.soldOut.map((x) => x.name).join(', ') })}</Text> : null}
                {l.lowStock.length ? <Text variant="small">{t('foodsx.lowStock', { list: l.lowStock.map((x) => x.name).join(', ') })}</Text> : null}
              </Card>
            );
          })}
        </View>
      ))}
    </Screen>
  );
}

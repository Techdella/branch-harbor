import { useState } from 'react';
import { Linking, View } from 'react-native';
import { Badge, Banner, Button, Card, DataStatus, EmptyState, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { foodsApi } from '@/features/foods/api';
import { useI18n } from '@/i18n';
import { ApiError } from '@/lib/errors';
import { fmtTime, fmtZone } from '@/lib/format';
import { useOnline } from '@/lib/network';
import { useApi } from '@/lib/useApi';

/** Driver view: deliveries assigned to me, picked up → delivered (server-acknowledged). */
export default function Deliveries() {
  const { t, intlLocale } = useI18n();
  const online = useOnline();
  const q = useApi(() => foodsApi.myDeliveries(), [], { pollMs: 20_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = async (id: string, status: 'picked_up' | 'delivered' | 'failed') => {
    setBusy(id + status); setErr(null);
    try { await foodsApi.setDeliveryStatus(id, status, status === 'failed' ? 'Driver reported a problem' : undefined); await q.refresh(); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(null); }
  };
  const list = (q.data ?? []).sort((a, b) => (['delivered', 'cancelled', 'failed'].includes(a.status) ? 1 : 0) - (['delivered', 'cancelled', 'failed'].includes(b.status) ? 1 : 0));
  return (
    <Screen tabs={false} onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('foodsx.deliveries')} back />
      <DataStatus q={q} />
      {err ? <Banner tone="danger" title={err} /> : null}
      {q.loading ? <SkeletonCard lines={4} /> : null}
      {!q.loading && list.length === 0 ? <EmptyState icon="truck" title={t('foodsx.deliveriesEmpty')} /> : null}
      {list.map((d) => (
        <Card key={d.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text variant="h3">#{d.order.orderNumber} · {d.order.customerName}</Text>
            <Badge tone={d.status === 'delivered' ? 'success' : d.status === 'failed' ? 'danger' : 'info'} label={t(`foodsx.dstatus.${d.status}`)} />
          </View>
          {d.order.address ? <Text>{d.order.address.line1}, {d.order.address.city} {d.order.address.postalCode}{d.order.address.instructions ? `\n${d.order.address.instructions}` : ''}</Text> : null}
          <Text tone="muted">{d.location.name}{d.order.promisedAt ? ` · ${t('foodsx.due', { time: `${fmtTime(d.order.promisedAt, d.location.timeZone, intlLocale)} ${fmtZone(d.location.timeZone, intlLocale)}` })}` : ''}</Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {['assigned', 'pending'].includes(d.status) ? <Button label={t('foodsx.pickedUp')} disabled={!online} loading={busy === `${d.id}picked_up`} onPress={() => set(d.id, 'picked_up')} /> : null}
            {d.status === 'picked_up' ? <Button label={t('foodsx.delivered')} disabled={!online} loading={busy === `${d.id}delivered`} onPress={() => set(d.id, 'delivered')} /> : null}
            {['assigned', 'picked_up'].includes(d.status) ? <Button label={t('foodsx.failed')} variant="ghost" disabled={!online} onPress={() => set(d.id, 'failed')} /> : null}
            {d.order.customerPhone ? <Button label={t('foodsx.callCustomer')} variant="secondary" icon="phone" onPress={() => void Linking.openURL(`tel:${d.order.customerPhone}`)} /> : null}
          </View>
        </Card>
      ))}
    </Screen>
  );
}

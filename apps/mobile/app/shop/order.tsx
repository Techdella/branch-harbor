import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Badge, Banner, Button, Card, DataStatus, MoneyText, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { commerce } from '@/features/commerce/api';
import { useCt } from '@/features/commerce/strings';
import { useApi } from '@/lib/useApi';

/** Track a shop order; pay if still pending; request a return within the window. */
export default function ShopOrder() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { ct } = useCt();
  const q = useApi(() => commerce.order(String(id)), [id], { pollMs: 10_000 });
  const [sent, setSent] = useState(false);
  const o = q.data;
  if (!o) return <Screen tabs={false}><ScreenHeader title="" back /><DataStatus q={q} /><SkeletonCard lines={4} /></Screen>;
  const done = o.fulfilmentStatus === 'fulfilled';
  return (
    <Screen tabs={false} onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={ct('order', { number: o.number })} back scope={{ label: o.fulfilmentLocationName ?? o.locationName ?? '', icon: 'store' }} />
      <DataStatus q={q} />
      <Card>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }} accessibilityLiveRegion="polite">
          <Badge label={ct(`ps.${o.paymentStatus}`)} tone={o.paymentStatus === 'paid' ? 'success' : o.paymentStatus === 'pending' ? 'warning' : 'neutral'} />
          <Badge label={ct(`fs.${o.fulfilmentStatus}`)} tone={done ? 'success' : o.fulfilmentStatus === 'ready_for_pickup' ? 'success' : 'info'} />
        </View>
        {o.lines.map((l) => <View key={l.variantId} style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text>{l.quantity} × {l.name}</Text><MoneyText value={l.lineTotal} /></View>)}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text weight={700}>{ct('total')}</Text><MoneyText value={o.total} weight={700} /></View>
      </Card>
      {o.status === 'pending_payment' && o.payment?.sandbox ? <Button label={ct('pay', { amount: '' })} icon="card" onPress={async () => { await commerce.pay(o.payment!.id, o.id); q.refresh(); }} /> : null}
      {(o.returns ?? []).map((r) => <Text key={r.id}>{ct('returns')}: {r.rmaNumber} · {r.status}</Text>)}
      {sent ? <Banner tone="success" title={ct('returnSent')} /> : (o.returnable ?? []).length > 0 && o.returnPolicy?.open ? (
        <Button variant="secondary" label={ct('requestReturn')} icon="undo" onPress={async () => { await commerce.requestReturn(o.id, o.returnable!.map((l) => ({ variantId: l.variantId, quantity: 1 }))); setSent(true); q.refresh(); }} />
      ) : null}
    </Screen>
  );
}

import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Badge, Banner, Button, Card, DataStatus, EmptyState, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text } from '@/components';
import { commerce, type CountDetail } from '@/features/commerce/api';
import { useCt } from '@/features/commerce/strings';
import { useApi } from '@/lib/useApi';
import { color, radius } from '@/theme';

/** Store associate: pick & pack orders, receive/ship transfers, count stock. */
export default function ShopFloor() {
  const { ct } = useCt();
  const stores = useApi(() => commerce.staffStores(), []);
  const [loc, setLoc] = useState<string | null>(null);
  const cur = loc ?? stores.data?.[0]?.id ?? null;
  const q = useApi(() => (cur ? commerce.queue(cur) : Promise.resolve(null)), [cur], { pollMs: 30_000 });
  const [count, setCount] = useState<CountDetail | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await q.refresh(); } catch (e) { setErr((e as Error).message); } };
  const d = q.data;
  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={ct('floorTitle')} scope={d ? { label: d.location.name, icon: 'store' } : undefined} />
      {(stores.data?.length ?? 0) > 1 ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{stores.data!.map((s) => <Button key={s.id} size="sm" variant={s.id === cur ? 'primary' : 'soft'} label={s.name} onPress={() => setLoc(s.id)} />)}</View> : null}
      <DataStatus q={q} />
      {err ? <Banner tone="danger" title={err} /> : null}
      {q.loading ? <SkeletonCard /> : null}
      <SectionHeader title={ct('toPick')} />
      {d && !d.orders.length ? <EmptyState icon="check-circle" title={ct('nothingToPick')} /> : null}
      {(d?.orders ?? []).map((o) => {
        const f = o.fulfilments.find((x) => !['collected', 'shipped', 'delivered', 'cancelled'].includes(x.status));
        return (
          <Card key={o.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><Text variant="h3">{o.number}</Text><Badge label={ct(`fs.${o.fulfilmentStatus}`)} tone="info" /></View>
            <Text tone="muted">{o.customer.name ?? ''}</Text>
            {o.lines.map((l) => <Text key={l.variantId}>{l.quantity} × {l.name}</Text>)}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {!f && o.fulfilmentStatus !== 'awaiting_transfer' ? <Button size="sm" label={ct('startPicking')} icon="box" onPress={() => run(() => commerce.startPicking(o.id))} /> : null}
              {f && f.status === 'picking' && f.lines.some((l) => l.picked < l.quantity) ? <Button size="sm" variant="soft" label={ct('pickedAll')} icon="check" onPress={() => run(() => commerce.pickAll(f))} /> : null}
              {f && f.next.filter((n) => !(f.status === 'picking' && f.lines.some((l) => l.picked < l.quantity))).map((n) => <Button key={n} size="sm" label={ct(`to.${n}`)} onPress={() => run(() => commerce.advance(f, n, n === 'shipped' ? `MOB-${Date.now()}` : undefined))} />)}
            </View>
          </Card>
        );
      })}
      <SectionHeader title={ct('transfersIn')} />
      {(d?.transfersToReceive ?? []).map((tr) => (
        <Card key={tr.id}>
          <Text variant="h3">{tr.number} · {tr.fromLocationName} →</Text>
          {tr.lines.map((l) => <Text key={l.variantId}>{l.shipped} × {l.name}</Text>)}
          <Button size="sm" label={ct('receive')} icon="check" onPress={() => run(() => commerce.receiveTransfer(tr, {}))} />
        </Card>
      ))}
      {(d?.transfersToShip ?? []).length ? <SectionHeader title={ct('transfersOut')} /> : null}
      {(d?.transfersToShip ?? []).map((tr) => <Card key={tr.id}><Text variant="h3">{tr.number} → {tr.toLocationName}</Text>{tr.lines.map((l) => <Text key={l.variantId}>{l.quantity} × {l.name}</Text>)}<Button size="sm" label={ct('ship')} icon="send" onPress={() => run(() => commerce.shipTransfer(tr.id))} /></Card>)}
      <SectionHeader title={ct('counts')} />
      {(d?.countsInProgress ?? []).map((c) => <Button key={c.id} variant="soft" label={`${ct('count')}: ${c.name}`} onPress={async () => { setVals({}); setCount(await commerce.count(c.id)); }} />)}
      {count ? (
        <Card>
          <Text variant="h3">{count.name}</Text>
          {count.lines.map((l) => (
            <View key={l.variantId} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ flex: 1 }}>{l.name}</Text>
              <TextInput accessibilityLabel={`${ct('counted')} ${l.name}`} keyboardType="number-pad" value={vals[l.variantId] ?? (l.countedQty !== null ? String(l.countedQty) : '')} onChangeText={(v) => setVals({ ...vals, [l.variantId]: v.replace(/\D/g, '') })} style={{ width: 70, minHeight: 44, borderWidth: 1.5, borderColor: color.lineSoft, borderRadius: radius.sm, textAlign: 'right', paddingHorizontal: 8 }} />
            </View>
          ))}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button size="sm" variant="soft" label={ct('saveCount')} onPress={() => run(async () => { await commerce.saveCount(count.id, Object.entries(vals).filter(([, v]) => v !== '').map(([variantId, v]) => ({ variantId, countedQty: Number(v) })), false); setCount(await commerce.count(count.id)); })} />
            <Button size="sm" label={ct('submitCount')} onPress={() => run(async () => { await commerce.saveCount(count.id, Object.entries(vals).filter(([, v]) => v !== '').map(([variantId, v]) => ({ variantId, countedQty: Number(v) })), true); setCount(null); })} />
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}

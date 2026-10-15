import { useState } from 'react';
import { View } from 'react-native';
import { Badge, Button, Card, DataStatus, EmptyState, Screen, ScreenHeader, SkeletonCard, Text, useToast } from '@/components';
import { hospApi, hospitalityLive } from '@/features/hospitality/api';
import { useHospStrings } from '@/features/hospitality/strings';
import { fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';

/** Guest: stays booked on this device or linked to the account; cancel with the fee shown first. */
export default function MyStays() {
  const { s, dict, intlLocale } = useHospStrings();
  const toast = useToast();
  const q = useApi(() => (hospitalityLive ? hospApi.myStays() : Promise.resolve([])), []);
  const [busy, setBusy] = useState<string | null>(null);
  if (!hospitalityLive) return <Screen tabs={false}><ScreenHeader title={s('myStays')} back /><EmptyState icon="plug" title={s('liveOnly')} body={s('liveOnlyBody')} /></Screen>;
  return (
    <Screen tabs={false} onRefresh={() => void q.refresh()} refreshing={q.refreshing}>
      <ScreenHeader title={s('myStays')} back />
      <DataStatus q={q} />
      {q.loading ? <SkeletonCard /> : null}
      {!q.loading && !(q.data ?? []).length ? <EmptyState icon="bed" title={s('noStays')} /> : null}
      {(q.data ?? []).map((x) => {
        const r = x.reservation;
        return (
          <Card key={r.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text variant="h3" style={{ flex: 1 }}>{x.property.name}</Text>
              <Badge label={dict.status[r.status] ?? r.status} tone={r.status === 'confirmed' || r.status === 'checked_in' ? 'success' : r.status === 'hold' ? 'warning' : 'neutral'} />
            </View>
            <Text>{r.arrival} → {r.departure} · {s('nights', { n: r.nights })}</Text>
            <Text tone="muted">{r.code} · {fmtMoney(r.total as never, intlLocale)}</Text>
            {x.balance.amount > 0 && x.token ? <Text variant="small">{s('dueAtProperty', { amount: fmtMoney(x.balance as never, intlLocale) })}</Text> : null}
            {x.canCancel && x.token && x.cancellation ? (
              <Button
                label={x.cancellation.free ? s('cancelFree') : s('cancelFee', { fee: fmtMoney(x.cancellation.fee as never, intlLocale) })}
                variant="secondary" icon="x" loading={busy === r.id}
                onPress={async () => { setBusy(r.id); try { await hospApi.cancel(r.id, x.token!); toast(s('cancelled')); await q.refresh(); } catch (e) { toast((e as Error).message); } finally { setBusy(null); } }}
              />
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}

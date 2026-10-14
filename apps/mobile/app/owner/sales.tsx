import { View } from 'react-native';
import { Card, DataStatus, MoneyText, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text } from '@/components';
import { commerce } from '@/features/commerce/api';
import { useCt } from '@/features/commerce/strings';
import { useApi } from '@/lib/useApi';
import { pastel } from '@/theme';

const BG = [pastel.butter, pastel.aqua, pastel.lilac, pastel.sage];

/** Owner: shop sales pulse per currency (never combined), orders needing action and stock warnings. */
export default function Sales() {
  const { ct } = useCt();
  const q = useApi(() => commerce.pulse(), [], { pollMs: 60_000 });
  const p = q.data;
  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={ct('salesTitle')} />
      <DataStatus q={q} />
      {q.loading ? <SkeletonCard lines={3} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(p?.revenueByCurrency ?? []).map((r, i) => (
          <Card key={r.currency} bg={BG[i % BG.length]} padding={14} style={{ flexGrow: 1, flexBasis: '45%' }}>
            <Text variant="label">{r.currency}</Text>
            <Text variant="small" tone="muted">{ct('today')}</Text>
            <MoneyText value={r.today} variant="h2" />
            <Text variant="small" tone="muted">{ct('last7')} · {ct('orders7', { n: r.orders7 })}</Text>
            <MoneyText value={r.last7Days} weight={700} />
          </Card>
        ))}
      </View>
      <Text variant="small" tone="muted">{ct('notCombined')}</Text>
      {p ? (
        <Card>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
            {([['toFulfil', p.orders.toFulfil], ['ready', p.orders.readyForPickup], ['attention', p.orders.needsAttention], ['lowStock2', p.stock.low], ['out', p.stock.out]] as const).map(([k, v]) => (
              <View key={k} style={{ minWidth: 90 }}><Text variant="small" tone="muted">{ct(k)}</Text><Text variant="h3" tabular>{v}</Text></View>
            ))}
          </View>
        </Card>
      ) : null}
      {p?.sales ? <SectionHeader title={ct('byStore')} /> : null}
      {(p?.sales ?? []).map((s) => (
        <Card key={s.locationId}>
          <Text variant="h3">{s.locationName}</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text tone="muted">{ct('today')} ({s.today.orders})</Text><MoneyText value={s.today.gross} weight={700} /></View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text tone="muted">{ct('last7')} ({s.last7Days.orders})</Text><MoneyText value={s.last7Days.gross} weight={700} /></View>
        </Card>
      ))}
    </Screen>
  );
}

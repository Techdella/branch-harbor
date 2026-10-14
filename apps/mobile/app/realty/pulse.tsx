import { View } from 'react-native';
import { Card, DataStatus, EmptyState, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { realtyApi, type RVolume } from '@/features/realty/api';
import { useRealtyStrings } from '@/features/realty/strings';
import { fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';

/** Owner/HQ: real-estate funnel pulse. Volumes per currency, never combined; missing values read "Unavailable". */
export default function RealtyPulse() {
  const { s, intlLocale } = useRealtyStrings();
  const q = useApi(() => realtyApi.pulse(), []);
  const n = q.data?.network;
  const vol = (rows: RVolume[]) => (rows.length ? rows.map((r) => <Text key={r.currency} variant="bodyL" weight={800} tabular>{fmtMoney({ amount: r.volumeMinor, currency: r.currency } as never, intlLocale)} · {r.count}</Text>) : <Text tone="muted">{s('unavailable')}</Text>);
  return (
    <Screen tabs={false} onRefresh={() => void q.refresh()} refreshing={q.refreshing}>
      <ScreenHeader title={s('pulseTitle')} back />
      <DataStatus q={q} />
      {q.loading ? <SkeletonCard /> : null}
      {!q.loading && q.data && !n ? <EmptyState icon="chart" title={s('unavailable')} /> : null}
      {n ? (
        <>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <Card style={{ flex: 1 }}><Text variant="label">{s('active')}</Text><Text variant="display" tabular>{n.listings.active}</Text></Card>
            <Card style={{ flex: 1 }}><Text variant="label">{s('dom')}</Text><Text variant="display" tabular>{n.daysOnMarket.liveMedian ?? '—'}</Text>{n.daysOnMarket.liveMedian == null ? <Text tone="muted">{s('unavailable')}</Text> : null}</Card>
          </View>
          <Card><Text variant="label">{s('funnel')}</Text><Text variant="h1" tabular>{n.funnel.enquiries} → {n.funnel.viewings} → {n.funnel.offers}</Text></Card>
          <Card><Text variant="label">{s('soldVolume')}</Text>{vol(n.sold)}<Text variant="label">{s('letVolume')}</Text>{vol(n.let)}<Text variant="small" tone="muted">{s('perCurrency')}</Text></Card>
          <Card><Text variant="label">{s('awaiting')}</Text><Text variant="h1" tabular>{n.listings.awaitingApproval}</Text></Card>
        </>
      ) : null}
    </Screen>
  );
}

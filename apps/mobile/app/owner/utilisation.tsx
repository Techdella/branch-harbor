import { View } from 'react-native';
import { Card, EmptyState, ErrorState, ScreenHeader, Screen, SkeletonCard, Text } from '@/components';
import { wellnessApi } from '@/features/wellness/api';
import { useWT } from '@/features/wellness/strings';
import { useApi } from '@/lib/useApi';
import { color } from '@/theme';

/** Owner pulse for wellness: practitioner and room utilisation per location (last 7 days). Missing hours = "Unavailable". */
export default function OwnerUtilisation() {
  const { t, locale } = useWT();
  const q = useApi(() => wellnessApi.utilisation(), []);
  const pct = (r: number | null) => (r == null ? t('unavailable') : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(r));
  const Bar = ({ r }: { r: number | null }) => (
    <View style={{ height: 6, width: 80, borderRadius: 3, backgroundColor: color.canvas, overflow: 'hidden' }} accessibilityElementsHidden>
      <View style={{ height: 6, width: `${Math.min(100, (r ?? 0) * 100)}%`, backgroundColor: color.ink }} />
    </View>
  );
  return (
    <Screen onRefresh={() => void q.refresh()} refreshing={q.refreshing}>
      <ScreenHeader title={t('utilisation')} kicker={t('last7')} />
      {q.loading && !q.data ? <SkeletonCard /> : q.error && !q.data ? <ErrorState title={t('error')} body={q.error.message} retryLabel={t('retry')} onRetry={() => void q.refresh()} /> : !q.data?.length ? (
        <EmptyState icon="activity" title={t('unavailable')} />
      ) : q.data.map((l) => (
        <Card key={l.locationId}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text weight={700}>{l.locationName}</Text>
            <Text weight={700} tabular>{t('avg')} {pct(l.avgRate)}</Text>
          </View>
          <Text variant="small" tone="muted">{l.orgName} · {l.currency}</Text>
          <Text variant="label" tone="muted">{t('practitioners')}</Text>
          {l.practitioners.map((p) => (
            <View key={p.name} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <Text style={{ flex: 1 }}>{p.name}</Text><Bar r={p.rate} /><Text tabular style={{ width: 90, textAlign: 'right' }}>{pct(p.rate)}</Text>
            </View>
          ))}
          <Text variant="label" tone="muted">{t('rooms')}</Text>
          {l.rooms.map((r) => (
            <View key={r.name} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <Text style={{ flex: 1 }}>{r.name}</Text><Bar r={r.rate} /><Text tabular style={{ width: 90, textAlign: 'right' }}>{pct(r.rate)}</Text>
            </View>
          ))}
        </Card>
      ))}
    </Screen>
  );
}

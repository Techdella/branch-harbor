import { View } from 'react-native';
import { Card, DataStatus, EmptyState, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { hospApi, hospitalityLive, type HPulse } from '@/features/hospitality/api';
import { useHospStrings } from '@/features/hospitality/strings';
import { fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';

/** Owner: occupancy pulse tonight per property; ADR and RevPAR in each property's own currency (never combined). */
export default function HospitalityPulse() {
  const { s, intlLocale } = useHospStrings();
  const q = useApi(() => (hospitalityLive ? hospApi.pulse() : Promise.resolve([] as HPulse[])), [], { pollMs: 120_000 });
  if (!hospitalityLive) return <Screen tabs={false}><ScreenHeader title={s('pulseTitle')} back /><EmptyState icon="plug" title={s('liveOnly')} body={s('liveOnlyBody')} /></Screen>;
  const pct = (v: number | null) => (v === null ? s('unavailable') : new Intl.NumberFormat(intlLocale, { style: 'percent', maximumFractionDigits: 0 }).format(v));
  const m = (v: HPulse['adr']) => (v ? fmtMoney(v as never, intlLocale) : s('unavailable'));
  return (
    <Screen tabs={false} onRefresh={() => void q.refresh()} refreshing={q.refreshing}>
      <ScreenHeader title={s('pulseTitle')} kicker={s('pulseSub')} back />
      <DataStatus q={q} />
      {q.loading ? <SkeletonCard /> : null}
      {(q.data ?? []).map((p) => (
        <Card key={p.locationId}>
          <Text variant="h3">{p.name} · {p.currency}</Text>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}><Text variant="label">{s('occupancy')}</Text><Text variant="h1" tabular>{pct(p.occupancy)}</Text><Text variant="small" tone="muted">{p.roomNightsSold}/{p.roomNightsAvailable}</Text></View>
            <View style={{ flex: 1 }}><Text variant="label">{s('adr')}</Text><Text variant="h3" tabular>{m(p.adr)}</Text></View>
            <View style={{ flex: 1 }}><Text variant="label">{s('revpar')}</Text><Text variant="h3" tabular>{m(p.revpar)}</Text></View>
          </View>
          <Text variant="small" tone="muted">{s('arrivalsN', { n: p.arrivals })} · {s('inHouse', { n: p.inHouse })} · {s('dirty', { n: p.dirtyRooms })}</Text>
        </Card>
      ))}
      <Text variant="small" tone="muted">{s('perCurrency')}</Text>
    </Screen>
  );
}

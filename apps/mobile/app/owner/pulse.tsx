import type { ReactNode } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Card, DataStatus, ListItem, MoneyText, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text, type Tone } from '@/components';
import { RealtyEntry } from '@/features/realty/RealtyEntry';
import { ExperienceSwitch } from '@/features/shared/ExperienceSwitch';
import { regionName } from '@/features/customer/useLocationScope';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { fmtTime, fmtZone, relativeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { totalsByCurrency } from '@bh/shared';
import type { PulseLocation } from '@/lib/types';
import { color, pastel } from '@/theme';

const TILE_BG = [pastel.lilac, pastel.butter, pastel.aqua, pastel.sage, pastel.blush, pastel.sand];

export default function Pulse() {
  const { t, intlLocale } = useI18n();
  const q = useApi(() => api.pulse(), [], { pollMs: 60_000 });
  const p = q.data;
  // Per-currency totals only. Never a combined figure across currencies.
  const totals = p ? totalsByCurrency(p.locations.flatMap((l) => (l.sales ? [l.sales] : []))) : [];
  // Independent business: the pulse IS its one location — no "all locations" scope, aggregation or list.
  const single = p?.singleLocation && p.locations.length <= 1 ? p.locations[0] ?? null : null;
  if (p?.singleLocation) {
    return (
      <Screen onRefresh={q.refresh} refreshing={q.refreshing}>
        <ScreenHeader
          title={t('owner.businessPulseTitle')}
          right={<ExperienceSwitch />}
          scope={{ label: p.singleLocation.businessName, sub: single ? `${single.city}, ${regionName(single.country, intlLocale)} · ${p.range}` : p.range, icon: 'store' }}
        />
        <DataStatus q={q} />
        <Text variant="small" tone="muted">{t('common.lastUpdated', { time: relativeAgo(p.updatedAt, intlLocale) })}</Text>
        {single ? <LocationPulse l={single} /> : <Text tone="muted">{t('owner.noLocationYet')}</Text>}
      </Screen>
    );
  }

  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader
        title={t('owner.pulseTitle')}
        right={<ExperienceSwitch />}
        scope={{ label: t('owner.allLocations'), sub: p ? `${p.scopeLabel} · ${p.range}` : undefined, icon: 'building' }}
      />
      <DataStatus q={q} />
      <ListItem icon="trophy" iconBg={pastel.lime} title={t('sports.pulseEntry')} chevron onPress={() => router.push('/sports/pulse')} />
      {p ? <Text variant="small" tone="muted">{t('common.lastUpdated', { time: relativeAgo(p.updatedAt, intlLocale) })}</Text> : null}

      <SectionHeader title={t('owner.salesByCurrency')} sub={p?.range ?? t('owner.thisWeek')} />
      {q.loading ? <SkeletonCard lines={2} /> : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {totals.map((m, i) => (
            <Card key={m.currency} bg={TILE_BG[i % TILE_BG.length]} padding={14} style={{ flexGrow: 1, flexBasis: '45%' }}>
              <Text variant="label">{t('owner.sales')} · {m.currency}</Text>
              <MoneyText value={m} variant="h2" />
            </Card>
          ))}
        </View>
      )}
      <Text variant="small" tone="muted">{t('owner.notCombined')}</Text>

      <SectionHeader title={t('owner.locationsTitle')} />
      {q.loading ? <><SkeletonCard /><SkeletonCard /></> : null}
      {(p?.locations ?? []).map((l) => <LocationPulse key={l.locationId} l={l} />)}
      <RealtyEntry kind="owner" />
    </Screen>
  );
}

function LocationPulse({ l }: { l: PulseLocation }) {
  const { t, intlLocale } = useI18n();
  const sync: Record<PulseLocation['sync'], { label: string; tone: Tone }> = {
    healthy: { label: t('owner.operating'), tone: 'success' },
    degraded: { label: t('owner.syncDegraded'), tone: 'warning' },
    not_connected: { label: t('common.notConnected'), tone: 'neutral' },
  };
  const s = sync[l.sync];
  const n = (v: number | null, suffix = '') => (v === null ? <Text tone="muted" weight={700}>{t('common.unavailable')}</Text> : <Text variant="h3" tabular>{new Intl.NumberFormat(intlLocale).format(v)}{suffix}</Text>);
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Text variant="h3">{l.name}</Text>
          <Text variant="small" tone="muted">{l.city}, {regionName(l.country, intlLocale)} · {fmtTime(new Date().toISOString(), l.timeZone, intlLocale)} {fmtZone(l.timeZone, intlLocale)}</Text>
        </View>
        <Badge label={s.label} tone={s.tone} icon={l.sync === 'degraded' ? 'refresh' : l.sync === 'not_connected' ? 'plug' : 'check-circle'} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        <Metric label={`${t('owner.sales')} · ${l.currency}`}><MoneyText value={l.sales} variant="h3" weight={l.sales ? 700 : 700} /></Metric>
        <Metric label={t('owner.bookings')}>{n(l.bookings)}</Metric>
        <Metric label={t('owner.occupancy')}>{n(l.occupancyPct, '%')}</Metric>
      </View>
      <Text variant="small" color={color.stone}>{t('owner.source', { source: l.source })}</Text>
    </Card>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ minWidth: 92, flexGrow: 1, gap: 2 }}>
      <Text variant="small" tone="muted">{label}</Text>
      {children}
    </View>
  );
}

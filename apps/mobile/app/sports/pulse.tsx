import { View } from 'react-native';
import { Badge, Card, DataStatus, EmptyState, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text } from '@/components';
import { sportsApi } from '@/features/sports/api';
import { useI18n } from '@/i18n';
import { fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { color, pastel } from '@/theme';

/** Owner: enrolment vs capacity, work waiting, attendance and balances per currency (never combined). */
export default function SportsPulse() {
  const { t, intlLocale } = useI18n();
  const q = useApi(() => sportsApi.pulse(), [], { pollMs: 120_000 });
  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing} tabs={false}>
      <ScreenHeader back title={t('sports.pulseTitle')} />
      <DataStatus q={q} />
      {q.loading ? <><SkeletonCard /><SkeletonCard /></> : null}
      {q.data && !q.data.length ? <EmptyState icon="chart" title={t('sports.noPulse')} /> : null}
      {(q.data ?? []).map((o) => (
        <View key={o.orgId} style={{ gap: 10 }}>
          <SectionHeader title={o.name} />
          {o.work ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {([['needsReview', o.work.awaitingReview], ['disputes', o.work.openDisputes], ['selections', o.work.pendingSelections]] as const).map(([k, v]) => (
                <Card key={k} bg={pastel.lilac} padding={12} style={{ flexGrow: 1, flexBasis: '30%' }}><Text variant="label">{t(`sports.${k}`)}</Text><Text variant="h2">{v}</Text></Card>
              ))}
            </View>
          ) : null}
          {o.balances.map((b) => (
            <Card key={b.currency} bg={pastel.butter} padding={12}>
              <Text variant="label">{t('sports.outstanding', { currency: b.currency })}</Text>
              <Text variant="h2">{fmtMoney({ amount: b.outstanding, currency: b.currency as 'CAD' }, intlLocale)}</Text>
              <Text variant="small" tone="muted">{t('sports.overdue', { amount: fmtMoney({ amount: b.overdue, currency: b.currency as 'CAD' }, intlLocale) })} · {t('sports.collected', { amount: fmtMoney({ amount: b.collected, currency: b.currency as 'CAD' }, intlLocale) })}</Text>
            </Card>
          ))}
          <Text variant="small" tone="muted">{t('sports.notCombined')}</Text>
          <SectionHeader title={t('sports.enrolment')} />
          {o.enrolment.map((e) => (
            <Card key={e.programme} padding={12}>
              <Text weight={700}>{e.programme}</Text>
              <View style={{ height: 8, borderRadius: 4, backgroundColor: color.canvas, overflow: 'hidden' }}>
                <View style={{ width: `${Math.min(100, e.fillRate ?? 0)}%`, height: 8, backgroundColor: color.ink }} />
              </View>
              <Text variant="small" tone="muted">{e.accepted}/{e.capacity ?? '∞'} · {e.fillRate === null ? t('sports.noCapacity') : t('sports.fill', { rate: e.fillRate })}{e.awaitingReview ? ` · ${e.awaitingReview} ${t('sports.needsReview')}` : ''}</Text>
            </Card>
          ))}
          <SectionHeader title={t('sports.attendance')} />
          {o.attendance.map((a) => (
            <View key={a.team} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text>{a.team}</Text>
              {a.rate === null ? <Badge tone="neutral" icon="info" label={t('sports.unavailable')} /> : <Text weight={700}>{a.rate}%</Text>}
            </View>
          ))}
        </View>
      ))}
    </Screen>
  );
}

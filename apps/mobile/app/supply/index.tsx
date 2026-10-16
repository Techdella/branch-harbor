import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Banner, Card, DataStatus, EmptyState, Icon, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text } from '@/components';
import { listSelfChecks, prepareSelfChecksOffline, syncAll, useSyncState, type SelfCheckDraft } from '@/features/quality/offline';
import { useOnline } from '@/lib/network';
import { holdsSelfChecks, holdsSuppliers, supplyApi, supplyOrgs, type PoSummary, type RunSummary } from '@/features/supply/api';
import { useST } from '@/features/supply/strings';
import { useApi } from '@/lib/useApi';

/** Today at the location: the self-checks to run and the supplier deliveries to receive. */
export default function SupplyHome() {
  const { t, locale } = useST();
  const orgs = useApi(() => supplyOrgs(), []);
  const org = orgs.data?.[0] ?? null;
  const orgId = org?.id ?? null;
  const checksOn = holdsSelfChecks(org?.caps);
  const deliveriesOn = holdsSuppliers(org?.caps);
  const checks = useApi(() => (orgId && checksOn ? supplyApi.today(orgId) : Promise.resolve([] as RunSummary[])), [orgId, checksOn]);
  const deliveries = useApi(() => (orgId && deliveriesOn ? supplyApi.deliveries(orgId) : Promise.resolve([] as PoSummary[])), [orgId, deliveriesOn]);
  const online = useOnline();
  const sync = useSyncState();
  const [saved, setSaved] = useState<SelfCheckDraft[]>([]);
  useEffect(() => { void listSelfChecks().then(setSaved); }, [sync, online]);
  // Today's checks are kept on the phone, so they open (and can be filled in) without a connection.
  useEffect(() => { if (orgId && checks.data?.length) void prepareSelfChecksOffline(orgId, checks.data.filter((r) => r.status !== 'completed' && r.status !== 'missed').map((r) => r.id)).then(() => listSelfChecks().then(setSaved)); }, [orgId, checks.data]);
  const offlineChecks = !online && !checks.data?.length ? saved.filter((d) => !d.done) : [];
  const waiting = saved.reduce((n, d) => n + d.dirty.length + d.photos.length + (d.complete ? 1 : 0), 0);
  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const date = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  return (
    <Screen tabs={false} onRefresh={async () => { await syncAll(); await Promise.all([checks.refresh(), deliveries.refresh()]); }} refreshing={checks.refreshing}>
      <ScreenHeader title={t('title')} kicker={org?.name ?? t('kicker')} back />
      {!online ? <Banner tone="warning" icon="wifi-off" title={t('offline')} /> : null}
      {waiting > 0 ? <Banner tone={sync === 'error' ? 'danger' : 'info'} title={sync === 'syncing' ? t('syncing') : t('pendingSync', { n: waiting })} body={sync === 'error' ? t('syncError') : undefined} /> : null}
      {offlineChecks.length ? <SectionHeader title={t('savedHere')} /> : null}
      {offlineChecks.map((d) => (
        <Card key={d.runId} onPress={() => router.push(`/supply/check/${d.runId}?org=${d.orgId}`)} accessibilityLabel={`${d.run.scheduleName} ${d.run.locationName ?? ''}`}>
          <Text variant="h3">{d.run.scheduleName}</Text>
          <Text variant="small" tone="muted">{d.run.locationName}</Text>
          {d.dirty.length || d.photos.length || d.complete ? <Badge label={d.complete ? t('submitQueued') : t('pendingSync', { n: d.dirty.length + d.photos.length })} tone="info" /> : null}
        </Card>
      ))}
      <DataStatus q={orgs} />
      {!orgs.loading && !org ? <EmptyState icon="truck" title={t('noAccess')} /> : null}
      {checksOn ? (
        <>
          <SectionHeader title={t('checks')} />
          {checks.loading && !checks.data ? <SkeletonCard /> : null}
          {!checks.loading && !(checks.data ?? []).length ? <Text tone="muted">{t('noChecks')}</Text> : null}
          {(checks.data ?? []).map((r) => (
            <Card key={r.id} onPress={() => router.push(`/supply/check/${r.id}?org=${orgId}`)} accessibilityLabel={`${r.scheduleName} ${r.locationName ?? ''}`}>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {r.status === 'completed' ? <Badge label={r.passed ? t('passed') : t('failed')} tone={r.passed ? 'success' : 'danger'} /> : r.status === 'missed' ? <Badge label={t('missed')} tone="danger" /> : r.late ? <Badge label={t('late')} tone="danger" /> : <Badge label={t('due', { time: time(r.dueAt) })} tone="info" icon="clock" />}
              </View>
              <Text variant="h3">{r.scheduleName}</Text>
              <Text variant="small" tone="muted">{r.locationName}{r.status === 'completed' && r.completedBy?.name ? ` · ${t('doneBy', { name: r.completedBy.name })}` : ` · ${t('progress', { done: r.answered, total: r.questionCount })}`}</Text>
            </Card>
          ))}
        </>
      ) : null}
      {deliveriesOn ? (
        <>
          <SectionHeader title={t('deliveries')} />
          {deliveries.loading && !deliveries.data ? <SkeletonCard /> : null}
          {!deliveries.loading && !(deliveries.data ?? []).length ? <Text tone="muted">{t('noDeliveries')}</Text> : null}
          {(deliveries.data ?? []).map((p) => (
            <Card key={p.id} onPress={() => router.push(`/supply/receive/${p.id}?org=${orgId}`)} accessibilityLabel={`${t('receive')} ${p.number}`}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text weight={700}>{p.supplierName}</Text>
                  <Text variant="small" tone="muted">{p.number} · {p.locationName}</Text>
                  <Text variant="small">{p.expectedDeliveryDate ? t('expected', { date: date(p.expectedDeliveryDate) }) : ''} · {t('packs', { received: p.packs.received, ordered: p.packs.ordered })}</Text>
                </View>
                {p.late ? <Badge label={t('late')} tone="danger" /> : null}
                <Icon name="chevron-right" size={18} />
              </View>
            </Card>
          ))}
        </>
      ) : null}
    </Screen>
  );
}

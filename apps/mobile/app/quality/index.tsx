import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Banner, Card, DataStatus, EmptyState, Icon, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text } from '@/components';
import { holdsAudits, holdsCompliance, qualityApi, qualityOrgs, type AuditSummary } from '@/features/quality/api';
import { listDrafts, pendingCount, prepareOffline, syncAll, useSyncState, type Draft } from '@/features/quality/offline';
import { useQT } from '@/features/quality/strings';
import { useOnline } from '@/lib/network';
import { useApi } from '@/lib/useApi';
import { color, pastel } from '@/theme';

/** Audits on the go: audits assigned to me (works offline once opened), corrective actions to fix, recent reports. */
export default function QualityHome() {
  const { t, locale } = useQT();
  const online = useOnline();
  const sync = useSyncState();
  const orgs = useApi(() => qualityOrgs(), []);
  const org = orgs.data?.[0] ?? null;
  const orgId = org?.id ?? null;
  const audits = holdsAudits(org?.caps);
  const mine = useApi(() => (orgId && audits ? qualityApi.audits(orgId, '?status=open&mine=true') : Promise.resolve([] as AuditSummary[])), [orgId, audits]);
  const recent = useApi(() => (orgId && audits ? qualityApi.audits(orgId, '?status=completed&limit=10') : Promise.resolve([] as AuditSummary[])), [orgId, audits]);
  const actions = useApi(() => (orgId && audits ? qualityApi.actions(orgId) : Promise.resolve([])), [orgId, audits]);
  const [pending, setPending] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  useEffect(() => { void pendingCount().then(setPending); void listDrafts().then(setDrafts); }, [sync, online]);
  // Audits assigned to me are kept on the phone, so they open at the location without a connection.
  useEffect(() => { if (orgId && mine.data?.length) void prepareOffline(orgId, mine.data.map((a) => a.id)).then(() => listDrafts().then(setDrafts)); }, [orgId, mine.data]);
  const offlineList = !online && !mine.data?.length ? drafts : [];
  const date = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  const refresh = async () => { await syncAll(); await Promise.all([mine.refresh(), recent.refresh(), actions.refresh()]); };

  return (
    <Screen tabs={false} onRefresh={refresh} refreshing={mine.refreshing}>
      <ScreenHeader title={t('title')} kicker={org?.name ?? t('kicker')} back />
      {!online ? <Banner tone="warning" icon="wifi-off" title={t('offline')} /> : null}
      {pending > 0 ? <Banner tone={sync === 'error' ? 'danger' : 'info'} title={sync === 'syncing' ? t('syncing') : t('pendingSync', { n: pending })} body={sync === 'error' ? t('syncError') : undefined} /> : null}
      <DataStatus q={orgs} />
      {!orgs.loading && !org && online ? <EmptyState icon="check-circle" title={t('noAccess')} /> : null}
      {offlineList.length ? <SectionHeader title={t('savedHere')} /> : null}
      {offlineList.map((d) => (
        <Card key={d.auditId} onPress={() => router.push(`/quality/audit/${d.auditId}?org=${d.orgId}`)} accessibilityLabel={`${d.audit.locationName} ${d.audit.name}`}>
          <Text variant="h3">{d.audit.locationName}</Text>
          <Text variant="small" tone="muted">{d.audit.name} · {t('due', { date: date(d.audit.dueDate) })}</Text>
          {d.dirty.length || d.photos.length ? <Badge label={t('pendingSync', { n: d.dirty.length + d.photos.length })} tone="info" /> : null}
        </Card>
      ))}
      {orgId && audits ? (
        <>
          <SectionHeader title={t('myAudits')} />
          {mine.loading && !mine.data ? <SkeletonCard /> : null}
          {!mine.loading && !(mine.data ?? []).length ? <Text tone="muted">{t('noMine')}</Text> : null}
          {(mine.data ?? []).map((a) => (
            <Card key={a.id} onPress={() => router.push(`/quality/audit/${a.id}?org=${orgId}`)} accessibilityLabel={`${a.locationName} ${a.name}`}>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <Badge label={t(a.status === 'in_progress' ? 'in_progress' : 'scheduled')} tone={a.status === 'in_progress' ? 'warning' : 'info'} />
                {a.overdue ? <Badge label={t('overdue')} tone="danger" /> : null}
              </View>
              <Text variant="h3">{a.locationName}</Text>
              <Text variant="small" tone="muted">{a.name} · {t('due', { date: date(a.dueDate) })}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text weight={700}>{a.status === 'in_progress' ? t('resume') : t('start')}</Text>
                <Icon name="chevron-right" size={16} />
              </View>
            </Card>
          ))}

          <SectionHeader title={t('actions')} />
          {!actions.loading && !(actions.data ?? []).length ? <Text tone="muted">{t('noActions')}</Text> : null}
          {(actions.data ?? []).map((x) => (
            <Card key={x.id} onPress={() => router.push(`/quality/audit/${x.auditId}?org=${orgId}`)} accessibilityLabel={x.title}>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <Badge label={t(x.status)} tone={x.status === 'submitted' ? 'info' : 'warning'} />
                {x.critical ? <Badge label={t('critical')} tone="danger" icon="alert" /> : null}
                {x.overdue ? <Badge label={t('overdue')} tone="danger" /> : null}
              </View>
              <Text weight={700}>{x.title}</Text>
              <Text variant="small" tone="muted">{x.locationName} · {t('due', { date: date(x.dueDate) })}</Text>
            </Card>
          ))}

          <SectionHeader title={t('recent')} />
          {!recent.loading && !(recent.data ?? []).length ? <Text tone="muted">{t('noRecent')}</Text> : null}
          {(recent.data ?? []).map((a) => (
            <Card key={a.id} onPress={() => router.push(`/quality/audit/${a.id}?org=${orgId}`)} accessibilityLabel={`${a.locationName} ${a.name}`}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text weight={700}>{a.locationName}</Text>
                  <Text variant="small" tone="muted">{a.name}{a.completedAt ? ` · ${date(a.completedAt.slice(0, 10))}` : ''}</Text>
                </View>
                <Badge label={a.scorePct === null ? '—' : `${a.scorePct}%`} tone={a.passed ? 'success' : 'danger'} />
              </View>
            </Card>
          ))}
        </>
      ) : null}
      {orgId && holdsCompliance(org?.caps) ? (
        <Card bg={pastel.aqua} onPress={() => router.push(`/quality/compliance?org=${orgId}`)} accessibilityLabel={t('compliance')}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center' }}><Icon name="shield" size={20} /></View>
            <View style={{ flex: 1 }}>
              <Text weight={700}>{t('compliance')}</Text>
              <Text variant="small" color={color.graphite}>{t('complianceSub')}</Text>
            </View>
            <Icon name="chevron-right" size={18} />
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}

import { useState } from 'react';
import { Linking, View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Banner, Button, Card, DataStatus, EmptyState, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text } from '@/components';
import { netApi, type Announcement } from '@/features/network/api';
import { useNT } from '@/features/network/strings';
import { useNetOrg } from '@/features/network/useNetOrg';
import { useApi } from '@/lib/useApi';
import { color } from '@/theme';

/** Community on the go: required reads first, HQ announcements, my training and a way to ask HQ for help. */
export default function NetworkHome() {
  const { t, locale } = useNT();
  const { org, q: orgQ } = useNetOrg();
  const orgId = org?.id ?? null;
  const me = useApi(() => (orgId ? netApi.me(orgId) : Promise.resolve(null)), [orgId]);
  const feed = useApi(() => (orgId ? netApi.announcements(orgId) : Promise.resolve([] as Announcement[])), [orgId], { pollMs: 60_000 });
  const training = useApi(() => (orgId ? netApi.training(orgId) : Promise.resolve(null)), [orgId]);
  const refresh = async () => { await Promise.all([me.refresh(), feed.refresh(), training.refresh()]); };
  const items = feed.data ?? [];
  const required = items.filter((a) => a.requiredRead && !a.acknowledgedAt);
  const rest = items.filter((a) => !(a.requiredRead && !a.acknowledgedAt));
  const active = (training.data?.enrolments ?? []).filter((e) => e.status === 'active' || e.status === 'expired');

  return (
    <Screen tabs={false} onRefresh={refresh} refreshing={feed.refreshing}>
      <ScreenHeader title={t('title')} kicker={org?.name} back />
      <DataStatus q={orgQ} />
      {!orgQ.loading && !org && <EmptyState icon="users" title={t('noNetwork')} />}
      {orgId && (
        <>
          {me.data?.accountManagers[0] && (
            <Card dark>
              <Text variant="small" tone="inverse">{t('contact')}</Text>
              <Text variant="h3" tone="inverse">{me.data.accountManagers[0].name}</Text>
              {me.data.accountManagers[0].bookingUrl && <Button label={t('bookCall')} variant="signal" size="sm" icon="calendar" onPress={() => void Linking.openURL(me.data!.accountManagers[0]!.bookingUrl!)} />}
            </Card>
          )}
          {required.length > 0 && <Banner tone="warning" title={t('pendingReads', { n: required.length })} />}
          <DataStatus q={feed} />
          {feed.loading && !feed.data ? <SkeletonCard /> : null}
          {required.map((a) => <AnnouncementCard key={a.id} a={a} orgId={orgId} locale={locale} onChanged={() => void refresh()} />)}

          <SectionHeader title={t('training')} />
          {training.loading && !training.data ? <SkeletonCard /> : null}
          {!training.loading && !active.length && <Text tone="muted">{t('noTraining')}</Text>}
          {active.map((e) => (
            <Card key={e.id} onPress={() => router.push(`/network/course/${e.course.id}`)} accessibilityLabel={e.course.title}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text weight={700} style={{ flex: 1 }}>{e.course.title}</Text>
                {e.overdue ? <Badge label={t('overdue')} tone="danger" /> : null}
              </View>
              <View style={{ height: 6, borderRadius: 3, backgroundColor: color.canvas, overflow: 'hidden' }}><View style={{ width: `${e.progressPct}%`, height: 6, backgroundColor: color.ink }} /></View>
              <Text variant="small" tone="muted">{t('progress', { n: e.progressPct })}</Text>
            </Card>
          ))}

          <SectionHeader title={t('help')} />
          <Button label={t('raise')} icon="help" variant="secondary" onPress={() => router.push('/network/help')} />

          <SectionHeader title={t('feed')} />
          {!feed.loading && !items.length && <Text tone="muted">{t('noNews')}</Text>}
          {rest.map((a) => <AnnouncementCard key={a.id} a={a} orgId={orgId} locale={locale} onChanged={() => void refresh()} />)}
        </>
      )}
    </Screen>
  );
}

function AnnouncementCard({ a, orgId, locale, onChanged }: { a: Announcement; orgId: string; locale: string; onChanged: () => void }) {
  const { t } = useNT();
  const [open, setOpen] = useState(a.requiredRead && !a.acknowledgedAt);
  const [busy, setBusy] = useState(false);
  return (
    <Card onPress={() => { setOpen(!open); if (!a.readAt) void netApi.read(orgId, a.id).catch(() => {}); }} accessibilityLabel={a.title}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {a.requiredRead ? <Badge label={a.acknowledgedAt ? t('confirmed') : a.overdue ? t('overdue') : t('required')} tone={a.acknowledgedAt ? 'success' : a.overdue ? 'danger' : 'warning'} /> : null}
      </View>
      <Text variant="h3">{a.title}</Text>
      {a.author ? <Text variant="small" tone="muted">{a.author.name}</Text> : null}
      {a.requiredRead && a.dueAt && !a.acknowledgedAt ? <Text variant="small" tone="muted">{t('due', { date: new Date(a.dueAt).toLocaleDateString(locale) })}</Text> : null}
      {open ? <Text>{a.body}</Text> : null}
      {a.requiredRead && !a.acknowledgedAt ? (
        <Button label={t('acknowledge')} icon="check" loading={busy} onPress={async () => {
          setBusy(true);
          try { await netApi.acknowledge(orgId, a.id); onChanged(); } finally { setBusy(false); }
        }} />
      ) : null}
    </Card>
  );
}

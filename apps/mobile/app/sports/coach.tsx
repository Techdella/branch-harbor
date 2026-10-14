import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Badge, Banner, Card, DataStatus, EmptyState, Screen, ScreenHeader, SkeletonCard, Tag, Text } from '@/components';
import { sportsApi, type RosterRow } from '@/features/sports/api';
import { useI18n } from '@/i18n';
import { fmtTime } from '@/lib/format';
import { announce } from '@/lib/motion';
import { useApi } from '@/lib/useApi';
import { MIN_TARGET, color, radius, status as S } from '@/theme';

const MARKS = ['present', 'late', 'absent', 'excused'] as const;

/** Coach/staff: today's sessions for their groups, authorised roster and one-tap attendance. */
export default function CoachScreen() {
  const { t, intlLocale } = useI18n();
  const sessions = useApi(() => sportsApi.coachSessions(), []);
  const [key, setKey] = useState<string | null>(null);
  const current = sessions.data?.find((s) => s.key === key) ?? sessions.data?.find((s) => s.status !== 'cancelled');
  const roster = useApi(() => (current ? sportsApi.roster(current.orgId, current.id) : Promise.resolve([] as RosterRow[])), [current?.key]);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const mark = async (r: RosterRow, status: string) => {
    if (!current) return;
    setPending(r.id);
    setFailed(null);
    try {
      const res = await sportsApi.mark(current.orgId, current.id, r.id, status);
      roster.setData((d) => d?.map((x) => (x.id === r.id ? { ...x, attendance: status, reportedBy: 'coach' } : x)));
      announce(res.notifiedGuardians ? t('sports.notified') : t('sports.saved'));
    } catch {
      setFailed(r.id);
    } finally {
      setPending(null);
    }
  };
  const list = roster.data ?? [];
  return (
    <Screen onRefresh={roster.refresh} refreshing={roster.refreshing} tabs={false}>
      <ScreenHeader back title={t('sports.coachTitle')} scope={current ? { label: current.team, sub: `${fmtTime(current.startsAt, current.timeZone, intlLocale)} · ${current.venue ?? ''} · ${current.location}`, icon: 'calendar' } : undefined} />
      <DataStatus q={sessions} />
      {sessions.loading ? <SkeletonCard /> : null}
      {!sessions.loading && !sessions.data?.length ? <EmptyState icon="calendar" title={t('sports.noCoachSessions')} /> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {(sessions.data ?? []).map((s) => <Tag key={s.key} label={s.team} sub={fmtTime(s.startsAt, s.timeZone, intlLocale)} selected={s.key === current?.key} onPress={() => setKey(s.key)} />)}
      </ScrollView>
      <Banner tone="info" icon="lock" title={t('sports.privacy')} />
      {list.length ? <Text variant="h3" accessibilityLiveRegion="polite">{t('sports.checkedIn', { count: list.filter((r) => r.attendance).length, total: list.length })}</Text> : null}
      {roster.loading ? <SkeletonCard lines={4} /> : null}
      {list.map((r) => (
        <Card key={r.id} padding={12}>
          <Text weight={700}>{r.name}</Text>
          {r.reportedBy === 'guardian' ? <Badge tone="info" icon="message" label={t('sports.guardianReported', { reason: r.absenceReason ? t(`sports.reason.${r.absenceReason}`) : '' })} /> : null}
          {r.care.emergencyContact ? <Text variant="small" tone="muted">{t('sports.emergency', { name: r.care.emergencyContact.name, phone: r.care.emergencyContact.phone ?? '' })}</Text> : null}
          {r.care.actionPlan ? <Text variant="small">{t('sports.actionPlan', { plan: r.care.actionPlan })}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }} accessibilityRole="radiogroup" accessibilityLabel={r.name}>
            {MARKS.map((m) => {
              const on = r.attendance === m;
              const tone = m === 'present' ? S.success : m === 'absent' ? S.danger : m === 'late' ? S.warning : S.info;
              return (
                <Pressable key={m} accessibilityRole="radio" accessibilityState={{ checked: on, busy: pending === r.id }} onPress={() => void mark(r, m)}
                  style={{ minHeight: MIN_TARGET, paddingHorizontal: 14, borderRadius: radius.pill, justifyContent: 'center', backgroundColor: on ? tone.bg : color.canvas, borderWidth: 1.5, borderColor: on ? tone.fg : 'transparent', opacity: pending === r.id ? 0.6 : 1 }}>
                  <Text weight={700} color={on ? tone.fg : color.ink}>{t(`sports.${m}`)}</Text>
                </Pressable>
              );
            })}
          </View>
          {failed === r.id ? <Text variant="small" weight={700} color={S.danger.fg}>{t('sports.saveFailed')}</Text> : null}
        </Card>
      ))}
    </Screen>
  );
}

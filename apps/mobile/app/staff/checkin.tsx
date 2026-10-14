import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Banner, Button, Card, DataStatus, EmptyState, Icon, Screen, ScreenHeader, SkeletonCard, Tag, Text } from '@/components';
import { useLocations } from '@/features/shared/useLocations';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { fmtTime } from '@/lib/format';
import { announce } from '@/lib/motion';
import { useApi } from '@/lib/useApi';
import type { AttendanceStatus, RosterEntry } from '@/lib/types';
import { color, radius, status as S, MIN_TARGET } from '@/theme';
import { Pressable } from 'react-native';

export default function CheckIn() {
  const { t, intlLocale } = useI18n();
  const params = useLocalSearchParams<{ session?: string }>();
  const { byId } = useLocations();
  const sessionsQ = useApi(() => api.mySessions(), []);
  const [sessionId, setSessionId] = useState<string | undefined>(params.session);
  useEffect(() => {
    if (params.session) setSessionId(params.session);
  }, [params.session]);
  const current = sessionsQ.data?.find((s) => s.id === sessionId) ?? sessionsQ.data?.[0];
  const rosterQ = useApi(() => (current ? api.roster(current.id) : Promise.resolve([] as RosterEntry[])), [current?.id]);
  const [pending, setPending] = useState<Record<string, AttendanceStatus>>({});
  const [failed, setFailed] = useState<Record<string, AttendanceStatus>>({});

  const mark = async (r: RosterEntry, status: AttendanceStatus) => {
    if (!current) return;
    setPending((p) => ({ ...p, [r.id]: status }));
    setFailed((f) => {
      const { [r.id]: _, ...rest } = f;
      return rest;
    });
    try {
      const upd = await api.markAttendance(current.id, r.id, status);
      rosterQ.setData((d) => d?.map((x) => (x.id === upd.id ? upd : x)));
    } catch {
      setFailed((f) => ({ ...f, [r.id]: status }));
      announce(t('staff.saveFailed'));
    } finally {
      setPending((p) => {
        const { [r.id]: _, ...rest } = p;
        return rest;
      });
    }
  };

  const roster = rosterQ.data ?? [];
  const present = roster.filter((r) => r.status === 'present').length;
  const tz = current ? byId(current.locationId)?.timeZone ?? 'UTC' : 'UTC';

  return (
    <Screen onRefresh={rosterQ.refresh} refreshing={rosterQ.refreshing}>
      <ScreenHeader title={t('tabs.checkin')} scope={current ? { label: current.name, sub: `${fmtTime(current.startsAt, tz, intlLocale)} · ${current.room} · ${byId(current.locationId)?.name ?? ''}`, icon: 'calendar' } : undefined} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {(sessionsQ.data ?? []).map((s) => (
          <Tag key={s.id} label={s.name} sub={fmtTime(s.startsAt, tz, intlLocale)} selected={s.id === current?.id} onPress={() => setSessionId(s.id)} />
        ))}
      </ScrollView>
      <DataStatus q={rosterQ} />
      <Banner tone="info" icon="lock" title={t('staff.privacy')} />
      {rosterQ.loading ? <SkeletonCard lines={5} /> : null}
      {!rosterQ.loading && roster.length === 0 ? <EmptyState icon="users" title={t('staff.noSessions')} /> : null}
      {roster.length ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <Text variant="h3" accessibilityLiveRegion="polite">{t('staff.checkedIn', { count: present, total: roster.length })}</Text>
          <Button label={t('staff.markAll')} size="sm" variant="secondary" icon="check" disabled={roster.every((r) => r.status !== 'unmarked')} onPress={() => roster.filter((r) => r.status === 'unmarked').forEach((r) => void mark(r, 'present'))} />
        </View>
      ) : null}
      {roster.map((r) => {
        const p = pending[r.id];
        const f = failed[r.id];
        const shown = p ?? r.status;
        return (
          <Card key={r.id} padding={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text weight={700}>{r.displayName}</Text>
                <Text variant="small" tone="muted">{r.note}</Text>
              </View>
              <Text variant="small" weight={700} tone="muted">{p ? t('staff.saving') : shown === 'present' ? t('staff.present') : shown === 'absent' ? t('staff.absent') : t('staff.notMarked')}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }} accessibilityRole="radiogroup" accessibilityLabel={r.displayName}>
              <Choice label={t('staff.present')} icon="check" on={shown === 'present'} busy={p === 'present'} tone="success" onPress={() => mark(r, 'present')} />
              <Choice label={t('staff.absent')} icon="x" on={shown === 'absent'} busy={p === 'absent'} tone="danger" onPress={() => mark(r, 'absent')} />
            </View>
            {f ? (
              <Pressable onPress={() => mark(r, f)} accessibilityRole="button" style={{ minHeight: MIN_TARGET, justifyContent: 'center' }}>
                <Text variant="small" weight={700} color={S.danger.fg}>{t('staff.saveFailed')}</Text>
              </Pressable>
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}

function Choice({ label, icon, on, busy, tone, onPress }: { label: string; icon: 'check' | 'x'; on: boolean; busy: boolean; tone: 'success' | 'danger'; onPress: () => void }) {
  const s = S[tone];
  return (
    <Pressable
      onPress={busy ? undefined : onPress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: on, busy }}
      style={({ pressed }) => ({
        flex: 1, minHeight: MIN_TARGET + 4, borderRadius: radius.pill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
        backgroundColor: on ? s.bg : color.canvas, borderWidth: 1.5, borderColor: on ? s.fg : 'transparent', opacity: busy ? 0.6 : pressed ? 0.85 : 1,
      })}
    >
      <Icon name={icon} size={16} color={on ? s.fg : color.ink} strokeWidth={2.4} />
      <Text weight={700} color={on ? s.fg : color.ink}>{label}</Text>
    </Pressable>
  );
}

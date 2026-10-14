import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Avatar, Badge, Button, Card, DataStatus, EmptyState, ListItem, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text, useToast } from '@/components';
import { RealtyEntry } from '@/features/realty/RealtyEntry';
import { ExperienceSwitch } from '@/features/shared/ExperienceSwitch';
import { useLocations } from '@/features/shared/useLocations';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { fmtTime, fmtZone } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/useApi';
import { color, pastel } from '@/theme';

export default function Today() {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const { me } = useSession();
  const { byId } = useLocations();
  const shiftsQ = useApi(() => api.myShifts(), []);
  const sessionsQ = useApi(() => api.mySessions(), []);
  const [clocking, setClocking] = useState<string | null>(null);

  return (
    <Screen onRefresh={() => { void shiftsQ.refresh(); void sessionsQ.refresh(); }} refreshing={shiftsQ.refreshing}>
      <ScreenHeader title={t('staff.hello', { name: me?.user.name ?? '' })} kicker={t('common.today')} right={<ExperienceSwitch />} />
      <DataStatus q={shiftsQ} />
      <ListItem icon="whistle" iconBg={pastel.lime} title={t('sports.coachEntry')} chevron onPress={() => router.push('/sports/coach')} />

      <SectionHeader title={t('staff.shift')} />
      {shiftsQ.loading ? <SkeletonCard /> : null}
      {!shiftsQ.loading && (shiftsQ.data ?? []).length === 0 ? <EmptyState icon="clock" title={t('staff.noShift')} /> : null}
      {(shiftsQ.data ?? []).map((s) => {
        const l = byId(s.locationId);
        const tz = s.timeZone ?? l?.timeZone ?? 'UTC';
        const where = l ? `${l.name} · ${l.address}` : [s.locationName, s.organizationName].filter(Boolean).join(' · ');
        const clock = async (kind: 'in' | 'out') => {
          setClocking(s.id);
          try {
            const upd = kind === 'in' ? await api.clockIn(s.id) : await api.clockOut(s.id);
            shiftsQ.setData((d) => d?.map((x) => (x.id === upd.id ? upd : x)));
            toast(kind === 'in' ? t('staff.clockedIn', { time: fmtTime(upd.clockedInAt ?? new Date().toISOString(), tz, intlLocale) }) : t('staff.clockedOut', { time: fmtTime(upd.clockedOutAt ?? new Date().toISOString(), tz, intlLocale) }));
          } catch (e) {
            toast((e as ApiError).message);
          } finally {
            setClocking(null);
          }
        };
        return (
          <Card key={s.id} dark>
            <Text variant="label" color={color.lime}>{s.role}</Text>
            <Text variant="h2" tone="inverse" tabular>
              {fmtTime(s.startsAt, tz, intlLocale)} – {fmtTime(s.endsAt, tz, intlLocale)} {fmtZone(tz, intlLocale)}
            </Text>
            <Text variant="small" color="#C9C9C3">{where}</Text>
            {s.clockedInAt && s.clockedOutAt ? (
              <Badge label={t('staff.worked', { from: fmtTime(s.clockedInAt, tz, intlLocale), to: fmtTime(s.clockedOutAt, tz, intlLocale) })} tone="neutral" icon="check" />
            ) : s.clockedInAt ? (
              <View style={{ gap: 8 }}>
                <Badge label={t('staff.clockedIn', { time: fmtTime(s.clockedInAt, tz, intlLocale) })} tone="success" />
                <Button label={t('staff.clockOut')} variant="secondary" icon="clock" loading={clocking === s.id} loadingLabel={t('staff.waitingServer')} style={{ alignSelf: 'flex-start' }} onPress={() => clock('out')} />
              </View>
            ) : (
              <Button
                label={t('staff.clockIn')}
                variant="signal"
                icon="clock"
                loading={clocking === s.id}
                loadingLabel={t('staff.waitingServer')}
                style={{ alignSelf: 'flex-start' }}
                onPress={() => clock('in')}
              />
            )}
          </Card>
        );
      })}

      <SectionHeader title={t('staff.sessions')} />
      {sessionsQ.loading ? <SkeletonCard /> : null}
      {!sessionsQ.loading && (sessionsQ.data ?? []).length === 0 ? <EmptyState icon="calendar" title={t('staff.noSessions')} /> : null}
      {(sessionsQ.data ?? []).map((s) => {
        const l = byId(s.locationId);
        const tz = l?.timeZone ?? 'UTC';
        return (
          <ListItem
            key={s.id}
            leading={<View style={{ width: 56, alignItems: 'center' }}><Text variant="h3" tabular>{fmtTime(s.startsAt, tz, intlLocale)}</Text></View>}
            title={s.name}
            subtitle={`${s.room} · ${t('book.minutes', { count: s.durationMin })} · ${t('staff.roster')}: ${s.rosterCount}`}
            chevron
            onPress={() => router.push({ pathname: '/staff/checkin', params: { session: s.id } })}
          />
        );
      })}
      <Card bg={pastel.butter} padding={12}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <Avatar name={me?.user.name ?? ''} uri={me?.user.avatar} size={32} />
          <Text variant="small" style={{ flex: 1 }}>{t('staff.privacy')}</Text>
        </View>
      </Card>
      <RealtyEntry kind="agent" />
    </Screen>
  );
}

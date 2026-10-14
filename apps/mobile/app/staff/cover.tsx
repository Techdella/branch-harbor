import { useState } from 'react';
import { Badge, Button, Card, DataStatus, ListItem, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text, useToast } from '@/components';
import { useLocations } from '@/features/shared/useLocations';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { fmtDateTime, fmtTime, fmtZone } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import type { CoverRequest } from '@/lib/types';
import { pastel } from '@/theme';

export default function Cover() {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const { byId } = useLocations();
  const sessionsQ = useApi(() => api.mySessions(), []);
  const q = useApi(() => api.coverRequests(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const mine = (q.data ?? []).filter((c) => c.mine);
  const open = (q.data ?? []).filter((c) => !c.mine);

  const badge = (c: CoverRequest) =>
    c.status === 'open' ? <Badge label={t('staff.open')} tone="info" icon="clock" /> : c.status === 'accepted_pending_manager' ? <Badge label={t('staff.awaitingManager')} tone="warning" icon="shield" /> : <Badge label={t('common.approved')} tone="success" />;

  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('staff.coverTitle')} />
      <DataStatus q={q} />
      <SectionHeader title={t('staff.requestCover')} />
      {sessionsQ.loading ? <SkeletonCard /> : null}
      {(sessionsQ.data ?? []).map((s) => {
        const tz = byId(s.locationId)?.timeZone ?? 'UTC';
        const requested = mine.some((c) => c.sessionName === s.name);
        return (
          <ListItem
            key={s.id}
            title={s.name}
            subtitle={`${fmtTime(s.startsAt, tz, intlLocale)} ${fmtZone(tz, intlLocale)} · ${s.room}`}
            trailing={
              requested ? <Badge label={t('staff.open')} tone="info" icon="clock" /> : (
                <Button
                  label={t('staff.requestCover')}
                  size="sm"
                  variant="secondary"
                  loading={busy === s.id}
                  accessibilityLabel={t('staff.requestCoverFor', { session: s.name })}
                  onPress={async () => {
                    setBusy(s.id);
                    try {
                      const c = await api.requestCover(s.id);
                      q.setData((d) => [c, ...(d ?? [])]);
                      toast(t('staff.coverRequested'));
                    } catch (e) {
                      toast((e as ApiError).message);
                    } finally {
                      setBusy(null);
                    }
                  }}
                />
              )
            }
          />
        );
      })}

      {mine.length ? <SectionHeader title={t('staff.yourRequests')} /> : null}
      {mine.map((c) => {
        const tz = byId(c.locationId)?.timeZone ?? 'UTC';
        return <ListItem key={c.id} icon="repeat" iconBg={pastel.aqua} title={c.sessionName} subtitle={`${fmtDateTime(c.startsAt, tz, intlLocale)} ${fmtZone(tz, intlLocale)}`} trailing={badge(c)} />;
      })}

      <SectionHeader title={t('staff.openRequests')} />
      {q.loading ? <SkeletonCard /> : null}
      {open.map((c) => {
        const l = byId(c.locationId);
        const tz = l?.timeZone ?? 'UTC';
        return (
          <Card key={c.id}>
            <Text variant="h3">{c.sessionName}</Text>
            <Text variant="small" tone="muted">{fmtDateTime(c.startsAt, tz, intlLocale)} {fmtZone(tz, intlLocale)} · {l?.name}</Text>
            <Text variant="small" tone="muted">{c.requestedBy}</Text>
            {c.status === 'open' ? (
              <Button
                label={t('staff.acceptCover')}
                icon="check"
                loading={busy === c.id}
                loadingLabel={t('staff.waitingServer')}
                style={{ alignSelf: 'flex-start' }}
                onPress={async () => {
                  setBusy(c.id);
                  try {
                    const upd = await api.acceptCover(c.id);
                    q.setData((d) => d?.map((x) => (x.id === upd.id ? upd : x)));
                    toast(t('staff.coverAccepted'));
                  } catch (e) {
                    toast((e as ApiError).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              />
            ) : badge(c)}
          </Card>
        );
      })}
    </Screen>
  );
}

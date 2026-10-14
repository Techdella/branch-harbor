import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Badge, Banner, Button, Card, ConfirmSheet, EmptyState, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text, ToggleRow } from '@/components';
import { useLocations } from '@/features/shared/useLocations';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { env } from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { fmtTime, fmtZone } from '@/lib/format';
import { announce } from '@/lib/motion';
import { network, useOnline, useSimulatedOffline } from '@/lib/network';
import { useApi } from '@/lib/useApi';
import type { FoodOrderStatus, KitchenOrder } from '@/lib/types';
import { color, pastel, radius, status as S } from '@/theme';

const KITCHEN_LOCATION = 'me-bl';

const NEXT: Partial<Record<FoodOrderStatus, { to: FoodOrderStatus; key: string }>> = {
  awaiting_acceptance: { to: 'accepted', key: 'staff.accept' },
  accepted: { to: 'preparing', key: 'staff.startPreparing' },
  preparing: { to: 'ready', key: 'staff.markReady' },
  ready: { to: 'collected', key: 'staff.markCollected' },
};

export default function Kitchen() {
  const { t, intlLocale } = useI18n();
  const online = useOnline();
  const simOffline = useSimulatedOffline();
  const { byId } = useLocations();
  const loc = byId(KITCHEN_LOCATION);
  const tz = loc?.timeZone ?? 'America/Los_Angeles';
  const q = useApi(() => api.kitchenOrders(KITCHEN_LOCATION), [], { pollMs: 10_000 });
  // Pending = sent to server, waiting for acknowledgement. The card keeps its server state until ack.
  const [pending, setPending] = useState<Record<string, FoodOrderStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<KitchenOrder | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (online) void q.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const stale = !online || q.stale;
  const lastRefresh = q.updatedAt ? `${fmtTime(q.updatedAt.toISOString(), tz, intlLocale)} ${fmtZone(tz, intlLocale)}` : '—';

  const act = async (o: KitchenOrder, to: FoodOrderStatus) => {
    setPending((p) => ({ ...p, [o.id]: to }));
    setErrors(({ [o.id]: _, ...rest }) => rest);
    try {
      const upd = await api.setKitchenStatus(o.id, to);
      q.setData((d) => (['collected', 'rejected'].includes(upd.status) ? d?.filter((x) => x.id !== upd.id) : d?.map((x) => (x.id === upd.id ? upd : x))));
      announce(`${o.number}: ${t(`staff.kitchenStatus.${upd.status}`)}`);
    } catch (e) {
      const label = t(`staff.kitchenStatus.${o.status}`);
      setErrors((er) => ({ ...er, [o.id]: (e as ApiError).isNetwork ? t('staff.actionFailed', { status: label }) : (e as ApiError).message }));
    } finally {
      setPending(({ [o.id]: _, ...rest }) => rest);
    }
  };

  const orders = [...(q.data ?? [])].sort((a, b) => a.promisedAt.localeCompare(b.promisedAt));
  const groups: [string, KitchenOrder[]][] = [
    [t('staff.newOrders'), orders.filter((o) => o.status === 'awaiting_acceptance')],
    [t('staff.inProgress'), orders.filter((o) => o.status === 'accepted' || o.status === 'preparing')],
    [t('staff.readyOrders'), orders.filter((o) => o.status === 'ready')],
  ];

  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('staff.kitchenTitle', { location: loc ? `Maple & Ember ${loc.name}` : '' })} scope={{ label: t('common.lastUpdated', { time: lastRefresh }), icon: 'refresh', sub: loc?.address }} />

      {stale ? (
        <Banner
          tone="warning"
          icon="wifi-off"
          title={!online ? t('common.offlineTitle') : q.error?.message ?? t('common.errorTitle')}
          body={t('common.offlineBody', { time: lastRefresh })}
          action={t('common.retry')}
          onAction={q.refresh}
        />
      ) : null}
      {env.useMocks ? (
        <Card padding={10} bg={pastel.sand}>
          <ToggleRow label={t('staff.simulateOffline')} sub={t('common.sampleData')} value={simOffline} onChange={(v) => network.setSimulatedOffline(v)} icon="wifi-off" />
        </Card>
      ) : null}

      {q.loading ? <><SkeletonCard lines={4} /><SkeletonCard lines={4} /></> : null}
      {!q.loading && orders.length === 0 && !q.error ? <EmptyState icon="chef" title={t('staff.noOrders')} body={t('staff.noOrdersSub')} /> : null}
      {q.error && !q.data ? <EmptyState icon="alert" title={t('common.errorTitle')} body={q.error.message} action={t('common.retry')} onAction={q.refresh} /> : null}

      {groups.map(([title, list]) =>
        list.length ? (
          <View key={title} style={{ gap: 10, opacity: stale ? 0.55 : 1 }}>
            <SectionHeader title={`${title} · ${list.length}`} />
            {list.map((o) => {
              const overdueMin = Math.floor((now - new Date(o.promisedAt).getTime()) / 60000);
              const next = NEXT[o.status];
              const p = pending[o.id];
              const allergy = o.notes && /allerg/i.test(o.notes);
              return (
                <Card key={o.id} padding={16} style={{ borderWidth: overdueMin > 0 ? 2 : 0, borderColor: S.danger.fg }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                    <View style={{ flex: 1 }}>
                      <Text variant="display" tabular>{o.number}</Text>
                      <Text variant="h3">{o.firstName}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 6 }}>
                      {overdueMin > 0 ? <Badge label={t('staff.overdue', { minutes: overdueMin })} tone="danger" icon="alert" /> : <Badge label={t('staff.dueAt', { time: fmtTime(o.promisedAt, tz, intlLocale) })} tone="neutral" icon="clock" />}
                      <Badge label={t(`staff.kitchenStatus.${o.status}`)} tone={o.status === 'awaiting_acceptance' ? 'warning' : o.status === 'ready' ? 'success' : 'info'} />
                    </View>
                  </View>
                  {o.lines.map((l, i) => (
                    <View key={i}>
                      <Text variant="h2">{l.quantity}× {l.name}</Text>
                      {l.options.length ? <Text variant="bodyL" color={color.graphite}>{l.options.join(' · ')}</Text> : null}
                    </View>
                  ))}
                  {o.notes ? (
                    <View style={{ backgroundColor: allergy ? S.danger.bg : pastel.butter, borderRadius: radius.sm, padding: 10 }}>
                      <Text weight={800} color={allergy ? S.danger.fg : color.ink}>{o.notes}</Text>
                    </View>
                  ) : null}
                  {errors[o.id] ? <Text variant="small" weight={700} color={S.danger.fg} accessibilityRole="alert">{errors[o.id]}</Text> : null}
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {o.status === 'awaiting_acceptance' ? (
                      <Button label={t('staff.rejectOrder')} variant="secondary" size="lg" disabled={!!p || !online} onPress={() => setRejecting(o)} style={{ flex: 1 }} />
                    ) : null}
                    {next ? (
                      <Button
                        label={t(next.key)}
                        size="lg"
                        variant={o.status === 'awaiting_acceptance' ? 'signal' : 'primary'}
                        loading={!!p && p === next.to}
                        loadingLabel={t('staff.waitingServer')}
                        disabled={(!!p && p !== next.to) || !online}
                        onPress={() => act(o, next.to)}
                        style={{ flex: 2 }}
                      />
                    ) : null}
                  </View>
                </Card>
              );
            })}
          </View>
        ) : null,
      )}

      <ConfirmSheet
        visible={!!rejecting}
        title={t('staff.rejectTitle', { number: rejecting?.number ?? '' })}
        body={t('staff.rejectBody')}
        confirmLabel={t('staff.rejectOrder')}
        confirmVariant="danger"
        onCancel={() => setRejecting(null)}
        onConfirm={async () => {
          const o = rejecting!;
          setRejecting(null);
          await act(o, 'rejected');
        }}
      />
    </Screen>
  );
}

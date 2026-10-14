import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Badge, Banner, Button, Card, DataStatus, EmptyState, Screen, ScreenHeader, SkeletonCard, Text, ToggleRow } from '@/components';
import { foodsApi, type KdsFeed } from '@/features/foods/api';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { fmtTime } from '@/lib/format';
import { announce } from '@/lib/motion';
import { useOnline } from '@/lib/network';
import { useApi } from '@/lib/useApi';
import { color, radius, status as S } from '@/theme';

/** Kitchen display by station: tickets routed by item station, bump/recall acknowledged by the server, overdue markers. */
export default function Kds() {
  const { t, intlLocale } = useI18n();
  const online = useOnline();
  const kitchenQ = useApi(() => api.kitchenLocationId(), []);
  const lid = kitchenQ.data;
  const [stationId, setStationId] = useState<string | null>(null);
  const [sound, setSound] = useState(true);
  const q = useApi<KdsFeed>(() => (lid ? foodsApi.kds(lid, stationId) : new Promise<KdsFeed>(() => {})), [lid, stationId], { pollMs: 10_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const ids = [...(q.data?.tickets ?? []).map((x) => x.id), ...(q.data?.orders ?? []).map((x) => x.id)];
    const fresh = ids.filter((x) => !seen.current.has(x));
    if (seen.current.size && fresh.length && sound) announce(t('foodsx.kdsTitle'));
    ids.forEach((x) => seen.current.add(x));
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const stale = !online || q.stale;
  const tz = q.data?.location.timeZone ?? 'UTC';
  const act = async (fn: () => Promise<unknown>, id: string) => {
    setBusy(id); setErr(null);
    try { await fn(); await q.refresh(); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(null); }
  };

  return (
    <Screen tabs={false} onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('foodsx.kdsTitle')} back kicker={q.data?.location.name} />
      <DataStatus q={q} />
      {stale ? <Banner tone="danger" title={t('foodsx.stale', { time: q.updatedAt ? fmtTime(q.updatedAt.toISOString(), tz, intlLocale) : '—' })} /> : null}
      {err ? <Banner tone="danger" title={err} /> : null}
      <ToggleRow label={t('foodsx.sound')} value={sound} onChange={setSound} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="tablist">
        {[{ id: null as string | null, name: t('foodsx.expo') }, ...(q.data?.stations.filter((s) => !s.isExpo).map((s) => ({ id: s.id as string | null, name: `${s.name} (${s.open})` })) ?? [])].map((s) => (
          <Pressable key={s.id ?? 'expo'} accessibilityRole="tab" accessibilityState={{ selected: stationId === s.id }} onPress={() => setStationId(s.id)}
            style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: stationId === s.id ? color.ink : color.surface }}>
            <Text weight={700} color={stationId === s.id ? color.surface : color.ink}>{s.name}</Text>
          </Pressable>
        ))}
      </View>
      <Text variant="small" tone="muted">{t('foodsx.stationsHint')}</Text>
      {q.loading ? <SkeletonCard lines={4} /> : null}
      {q.data?.view === 'station' && q.data.tickets.length === 0 ? <EmptyState icon="chef" title={t('foodsx.empty')} /> : null}
      {q.data?.view === 'expo' && q.data.orders.length === 0 ? <EmptyState icon="chef" title={t('foodsx.emptyExpo')} /> : null}
      {q.data?.view === 'station' && q.data.tickets.map((tk) => (
        <Card key={tk.id} style={{ borderWidth: 3, borderColor: tk.overdue ? S.danger.fg : 'transparent' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text variant="h2">#{tk.orderNumber.split('-').pop()} · {tk.firstName}{tk.tableLabel ? ` · ${tk.tableLabel}` : ''}</Text>
            <Text weight={700}>{t('foodsx.target', { time: fmtTime(tk.targetAt, tz, intlLocale) })}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 6 }}><Badge label={t(`foodsx.channel.${tk.channel}`)} />{tk.overdue ? <Badge tone="danger" icon="alert" label={t('foodsx.overdue', { min: tk.overdueMinutes })} /> : null}</View>
          {tk.lines.map((l, i) => <Text key={i} variant="h3">{l.quantity}× {l.name}{l.modifiers.length ? `\n   + ${l.modifiers.join('\n   + ')}` : ''}</Text>)}
          {tk.orderNotes ? <Text weight={700} color={S.warning.fg}>“{tk.orderNotes}”</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {tk.status === 'queued' ? <Button label={t('foodsx.start')} variant="secondary" disabled={stale} loading={busy === `${tk.id}s`} onPress={() => act(() => foodsApi.ticket(lid!, tk.id, 'start', tk.status), `${tk.id}s`)} /> : null}
            {tk.status !== 'done' ? <Button label={t('foodsx.bump')} size="lg" disabled={stale} loading={busy === tk.id} loadingLabel={t('foodsx.waiting')} onPress={() => act(() => foodsApi.ticket(lid!, tk.id, 'bump', tk.status), tk.id)} />
              : <Button label={t('foodsx.recall')} variant="secondary" disabled={stale} loading={busy === tk.id} onPress={() => act(() => foodsApi.ticket(lid!, tk.id, 'recall', 'done'), tk.id)} />}
          </View>
        </Card>
      ))}
      {q.data?.view === 'expo' && q.data.orders.map((o) => (
        <Card key={o.id} style={{ borderWidth: 3, borderColor: o.overdue ? S.danger.fg : o.status === 'ready' ? S.success.fg : 'transparent' }}>
          <Text variant="h2">#{o.orderNumber.split('-').pop()} · {o.firstName}</Text>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            <Badge label={t(`foodsx.channel.${o.channel}`)} />
            {o.stations.map((s, i) => <Badge key={i} tone={s.status === 'done' ? 'success' : 'neutral'} label={`${s.name}: ${s.status.replace('_', ' ')}`} />)}
            {o.overdue ? <Badge tone="danger" icon="alert" label={t('foodsx.overdue', { min: o.overdueMinutes })} /> : null}
          </View>
          {o.lines.map((l, i) => <Text key={i}>{l.quantity}× {l.name}</Text>)}
          {o.allStationsDone && o.status === 'preparing' ? <Button label={t('foodsx.markReady')} disabled={stale} loading={busy === o.id} onPress={() => act(() => foodsApi.advanceOrder(lid!, o.id, 'ready', o.status), o.id)} /> : null}
        </Card>
      ))}
    </Screen>
  );
}

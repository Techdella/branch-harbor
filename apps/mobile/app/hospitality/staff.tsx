import { useState } from 'react';
import { View } from 'react-native';
import { Badge, Button, Card, DataStatus, EmptyState, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text, useToast } from '@/components';
import { hospApi, hospitalityLive, type HArrival, type HTask } from '@/features/hospitality/api';
import { useHospStrings } from '@/features/hospitality/strings';
import { useApi } from '@/lib/useApi';

/** Staff: my housekeeping tasks today (start / done) and today's arrivals for the front desk. */
export default function HospitalityStaff() {
  const { s, dict } = useHospStrings();
  const toast = useToast();
  const tasks = useApi(() => (hospitalityLive ? hospApi.myTasks() : Promise.resolve([] as HTask[])), [], { pollMs: 60_000 });
  const arrivals = useApi(() => (hospitalityLive ? hospApi.arrivals() : Promise.resolve([] as HArrival[])), [], { pollMs: 120_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const set = async (t: HTask, status: 'in_progress' | 'done') => {
    setBusy(t.id);
    try { await hospApi.setTask(t.id, status); if (status === 'done') toast(s('taskDone')); await tasks.refresh(); } catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  };
  if (!hospitalityLive) return <Screen tabs={false}><ScreenHeader title={s('staffTitle')} back /><EmptyState icon="plug" title={s('liveOnly')} body={s('liveOnlyBody')} /></Screen>;
  const open = (tasks.data ?? []).filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  return (
    <Screen tabs={false} onRefresh={() => { void tasks.refresh(); void arrivals.refresh(); }} refreshing={tasks.refreshing}>
      <ScreenHeader title={s('staffTitle')} back />
      <DataStatus q={tasks} />
      <SectionHeader title={s('tasks')} />
      {tasks.loading ? <SkeletonCard /> : null}
      {!tasks.loading && !open.length ? <EmptyState icon="check-circle" title={s('noTasks')} /> : null}
      {open.map((t) => (
        <Card key={t.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text variant="h2">{s('room', { n: t.roomNumber })}</Text>
            <Badge label={dict.taskKinds[t.kind] ?? t.kind} tone={t.kind === 'maintenance' ? 'danger' : t.kind === 'departure_clean' ? 'warning' : 'neutral'} />
          </View>
          <Text tone="muted">{t.locationName}{t.mine ? ` · ${s('mine')}` : ''}</Text>
          {t.notes ? <Text variant="small">{t.notes}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {t.status === 'todo' ? <Button label={s('start')} variant="secondary" loading={busy === t.id} onPress={() => set(t, 'in_progress')} /> : null}
            <Button label={s('done')} icon="check" loading={busy === t.id} onPress={() => set(t, 'done')} />
          </View>
        </Card>
      ))}
      <SectionHeader title={s('arrivals')} />
      {!arrivals.loading && !(arrivals.data ?? []).length ? <EmptyState icon="calendar" title={s('noArrivals')} /> : null}
      {(arrivals.data ?? []).map((a) => (
        <Card key={a.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text weight={700} style={{ flex: 1 }}>{a.guestName}</Text>
            <Badge label={dict.status[a.status] ?? a.status} tone={a.status === 'checked_in' ? 'success' : 'neutral'} />
          </View>
          <Text tone="muted">{a.code} · {a.locationName}</Text>
          <Text variant="small">{(a.rooms ?? []).map((r) => (r.roomNumber ? `${r.roomTypeName} · ${s('room', { n: r.roomNumber })}` : `${r.roomTypeName} · ${s('unassigned')}`)).join(' / ')}</Text>
        </Card>
      ))}
    </Screen>
  );
}

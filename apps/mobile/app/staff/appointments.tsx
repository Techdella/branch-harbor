import { useState } from 'react';
import { View } from 'react-native';
import { Badge, Banner, Button, Card, EmptyState, ErrorState, ScreenHeader, Screen, SkeletonCard, Text, TextField, ToggleRow } from '@/components';
import { wellnessApi, type DayItem } from '@/features/wellness/api';
import { useWT } from '@/features/wellness/strings';
import { ApiError } from '@/lib/errors';
import { fmtTime, fmtZone } from '@/lib/format';
import { useApi } from '@/lib/useApi';

/** Practitioner day: today's appointments (all their locations), check-in and administrative notes. */
export default function StaffAppointments() {
  const { t, locale } = useWT();
  const q = useApi(() => wellnessApi.myDay(), [], { pollMs: 60_000 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Screen onRefresh={() => void q.refresh()} refreshing={q.refreshing}>
      <ScreenHeader title={t('today')} />
      {q.loading && !q.data ? <SkeletonCard /> : q.error && !q.data ? <ErrorState title={t('error')} body={q.error.message} retryLabel={t('retry')} onRetry={() => void q.refresh()} /> : !q.data?.length ? (
        <EmptyState icon="calendar" title={t('nothingToday')} />
      ) : (
        q.data.map((a) => <DayCard key={a.id} a={a} locale={locale} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} onChanged={() => void q.refresh()} />)
      )}
    </Screen>
  );
}

function DayCard({ a, locale, open, onToggle, onChanged }: { a: DayItem; locale: string; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const { t } = useWT();
  const tz = a.location.timeZone;
  const [note, setNote] = useState('');
  const [confidential, setConfidential] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  return (
    <Card onPress={onToggle} accessibilityLabel={`${fmtTime(a.startsAt, tz, locale)} ${a.serviceName} ${a.clientName}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text weight={700}>{fmtTime(a.startsAt, tz, locale)}–{fmtTime(a.endsAt, tz, locale)}</Text>
        {a.checkedInAt ? <Badge label={t('checkedIn')} tone="success" /> : a.status !== 'confirmed' ? <Badge label={a.status} tone="neutral" /> : null}
      </View>
      <Text>{a.serviceName} · {a.clientName}</Text>
      <Text variant="small" tone="muted">{a.location.name} · {fmtZone(tz, locale)}</Text>
      {open && (
        <View style={{ gap: 10, marginTop: 8 }}>
          {msg ? <Banner tone={msg.tone} title={msg.text} /> : null}
          {a.status === 'confirmed' && !a.checkedInAt && <Button label={t('checkIn')} icon="check-circle" onPress={async () => { try { await wellnessApi.checkIn(a.orgId, a.id); onChanged(); } catch (e) { setMsg({ tone: 'danger', text: (e as ApiError).message }); } }} />}
          <TextField label={t('addNote')} placeholder={t('notePlaceholder')} value={note} onChangeText={setNote} multiline />
          <ToggleRow label={t('confidential')} value={confidential} onChange={setConfidential} />
          <Button size="sm" variant="secondary" label={t('saveNote')} disabled={!note.trim()} onPress={async () => { try { await wellnessApi.addNote(a.orgId, a.customerId, a.location.id, note.trim(), confidential); setNote(''); setMsg({ tone: 'success', text: t('noteSaved') }); } catch (e) { setMsg({ tone: 'danger', text: (e as ApiError).message }); } }} />
        </View>
      )}
    </Card>
  );
}

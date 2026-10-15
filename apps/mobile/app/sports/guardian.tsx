import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Badge, Button, Card, DataStatus, EmptyState, Screen, ScreenHeader, SectionHeader, SkeletonCard, Tag, Text, TextField, useToast } from '@/components';
import { sportsApi, type GSession } from '@/features/sports/api';
import { useI18n } from '@/i18n';
import { fmtDateTime, fmtMoney, fmtZone } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { MIN_TARGET, color, pastel } from '@/theme';

const REASONS = ['illness', 'injury', 'family', 'school', 'travel', 'other'] as const;
type Tab = 'schedule' | 'balances' | 'messages';

/** Guardian: participants' schedule (report absences), balances (pay instalments), messages with the club. */
export default function GuardianScreen() {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const q = useApi(() => sportsApi.guardian(), []);
  const [tab, setTab] = useState<Tab>('schedule');
  const d = q.data;
  const money = (amount: number, currency: string) => fmtMoney({ amount, currency: currency as 'CAD' }, intlLocale);
  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing} tabs={false}>
      <ScreenHeader back title={t('sports.guardianTitle')} />
      <DataStatus q={q} />
      {q.loading ? <SkeletonCard lines={4} /> : null}
      {d && d.pendingRelationships > 0 ? <Text variant="small" tone="muted">{t('sports.pendingRelationships', { count: d.pendingRelationships })}</Text> : null}
      {d && d.participants.length === 0 ? <EmptyState icon="users" title={t('sports.noParticipants')} body={t('sports.noParticipantsBody')} /> : null}
      {d && d.balances.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {d.balances.map((b) => (
            <Card key={b.currency} bg={pastel.butter} padding={14} style={{ flexGrow: 1, flexBasis: '45%' }}>
              <Text variant="label">{t('sports.balanceIn', { currency: b.currency })}</Text>
              <Text variant="h2">{money(b.outstanding, b.currency)}</Text>
              {b.overdue > 0 ? <Badge tone="danger" label={t('sports.overdue', { amount: money(b.overdue, b.currency) })} /> : null}
            </Card>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 6 }} accessibilityRole="tablist">
        {(['schedule', 'balances', 'messages'] as Tab[]).map((k) => <Tag key={k} tab label={t(`sports.tab${k[0]!.toUpperCase()}${k.slice(1)}`)} selected={tab === k} onPress={() => setTab(k)} />)}
      </View>
      {d && tab === 'schedule' ? <Schedule sessions={d.schedule} onDone={() => { toast(t('sports.absenceSaved')); void q.refresh(); }} /> : null}
      {d && tab === 'balances' ? (
        d.participants.flatMap((p) => p.registrations.filter((r) => r.instalments.length).map((r) => (
          <Card key={r.id} padding={14}>
            <Text weight={700}>{p.name} · {r.programme.name}</Text>
            {r.instalments.map((i) => (
              <View key={i.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: MIN_TARGET }}>
                <View style={{ flex: 1 }}>
                  <Text variant="small">{t('sports.instalment', { seq: i.seq, date: i.dueOn })} · {money(i.amount.amount, i.amount.currency)}</Text>
                  <Badge tone={i.state === 'paid' ? 'success' : i.state === 'overdue' ? 'danger' : i.state === 'due' ? 'warning' : 'neutral'} label={t(`sports.inst.${i.state}`)} />
                </View>
                {i.status === 'scheduled' && i.amount.amount > 0 ? <PayButton id={i.id} label={t('sports.pay')} onDone={(ok) => { toast(ok ? t('sports.payDone') : t('sports.payUnavailable')); void q.refresh(); }} /> : null}
              </View>
            ))}
          </Card>
        )))
      ) : null}
      {d && tab === 'balances' ? <Text variant="small" tone="muted">{t('sports.notCombined')}</Text> : null}
      {d && tab === 'messages' ? <Messages locationId={d.locations[0]?.id} /> : null}
      {d && d.notifications.length ? (
        <>
          <SectionHeader title={t('sports.notifications')} />
          {d.notifications.slice(0, 5).map((n) => (
            <Card key={n.id} padding={12}><Text weight={700}>{n.subject}</Text><Text variant="small" tone="muted">{n.body}</Text></Card>
          ))}
        </>
      ) : null}
    </Screen>
  );
}

function PayButton({ id, label, onDone }: { id: string; label: string; onDone: (ok: boolean) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return <Button size="sm" label={label} loading={busy} onPress={async () => { setBusy(true); try { const r = await sportsApi.payInstalment(id, t); onDone(r.ok); } catch { onDone(false); } finally { setBusy(false); } }} />;
}

function Schedule({ sessions, onDone }: { sessions: GSession[]; onDone: () => void }) {
  const { t, intlLocale } = useI18n();
  const [open, setOpen] = useState<{ sid: string; pid: string } | null>(null);
  const upcoming = sessions.filter((s) => Date.parse(s.endsAt) > Date.now());
  if (!upcoming.length) return <EmptyState icon="calendar" title={t('sports.noSessions')} />;
  return (
    <>
      {upcoming.map((s) => (
        <Card key={s.id} padding={14}>
          <Text weight={700}>{s.team.name}{s.opponent ? ` ${t('sports.vs')} ${s.opponent}` : ''}</Text>
          <Text variant="small" tone="muted">{fmtDateTime(s.startsAt, s.location.timeZone, intlLocale)} {fmtZone(s.location.timeZone, intlLocale)} · {s.venue ?? t('sports.venueTbc')}</Text>
          {s.status === 'cancelled' ? <Badge tone="danger" icon="x" label={`${t('sports.cancelled')}${s.cancelReason ? ` · ${s.cancelReason}` : ''}`} /> : null}
          {s.participants.map((p) => (
            <View key={p.id} style={{ gap: 6 }}>
              {p.attendance ? <Text variant="small">{p.name}: {t('sports.absenceReported', { reason: p.attendance.reason ? t(`sports.reason.${p.attendance.reason}`) : p.attendance.status })}</Text>
                : s.status !== 'cancelled' ? (
                  <Pressable accessibilityRole="button" onPress={() => setOpen({ sid: s.id, pid: p.id })} style={{ minHeight: MIN_TARGET, justifyContent: 'center' }}>
                    <Text variant="small" weight={700} color={color.ink}>{p.name} · {t('sports.reportAbsence')}</Text>
                  </Pressable>
                ) : null}
              {open?.sid === s.id && open.pid === p.id ? (
                <View style={{ gap: 6 }}>
                  <Text variant="small" tone="muted">{t('sports.chooseReason')}</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {REASONS.map((r) => <Tag key={r} label={t(`sports.reason.${r}`)} onPress={async () => { await sportsApi.reportAbsence(p.id, s.id, r); setOpen(null); onDone(); }} />)}
                  </View>
                </View>
              ) : null}
            </View>
          ))}
        </Card>
      ))}
    </>
  );
}

function Messages({ locationId }: { locationId: string | undefined }) {
  const { t, intlLocale } = useI18n();
  const q = useApi(() => sportsApi.messages(), []);
  const [body, setBody] = useState('');
  if (!locationId) return <EmptyState icon="message" title={t('sports.noMessages')} />;
  const list = (q.data ?? []).filter((m) => m.locationId === locationId);
  return (
    <Card padding={14}>
      {list.length === 0 && !q.loading ? <Text tone="muted">{t('sports.noMessages')}</Text> : null}
      {list.map((m) => (
        <View key={m.id} style={{ alignSelf: m.direction === 'inbound' ? 'flex-end' : 'flex-start', backgroundColor: m.direction === 'inbound' ? color.ink : color.canvas, borderRadius: 14, padding: 10, maxWidth: '85%' }}>
          <Text color={m.direction === 'inbound' ? '#FFFFFF' : color.ink}>{m.body}</Text>
          <Text variant="small" color={m.direction === 'inbound' ? '#B9B9B3' : undefined} tone={m.direction === 'inbound' ? undefined : 'muted'}>{fmtDateTime(m.createdAt, 'UTC', intlLocale)}</Text>
        </View>
      ))}
      <TextField label={t('sports.writeMessage')} value={body} onChangeText={setBody} />
      <Button label={t('sports.send')} disabled={!body.trim()} onPress={async () => { await sportsApi.sendMessage(locationId, body.trim()); setBody(''); void q.refresh(); }} />
    </Card>
  );
}

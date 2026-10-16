import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { scoreAudit, type AuditAnswer, type AuditQuestion } from '@bh/shared';
import { Badge, Banner, Button, Card, DataStatus, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text, TextField } from '@/components';
import { supplyApi, type RunDetail } from '@/features/supply/api';
import { useST } from '@/features/supply/strings';
import { useOnline } from '@/lib/network';
import { useApi } from '@/lib/useApi';
import { color, status as S } from '@/theme';

/** Run today's self-check (opening, closing, temperature log): big answer buttons, autosave, submit. */
export default function SelfCheckScreen() {
  const { id, org } = useLocalSearchParams<{ id: string; org: string }>();
  const { t } = useST();
  const q = useApi(() => supplyApi.run(org!, id!), [id, org]);
  return (
    <Screen tabs={false} onRefresh={q.refresh}>
      {q.data ? <Run r={q.data} orgId={org!} onDone={q.refresh} /> : (
        <>
          <ScreenHeader title={t('checks')} back />
          <DataStatus q={q} />
          {q.loading ? <SkeletonCard /> : null}
        </>
      )}
    </Screen>
  );
}

function Run({ r, orgId, onDone }: { r: RunDetail; orgId: string; onDone: () => void }) {
  const { t } = useST();
  const online = useOnline();
  const [answers, setAnswers] = useState<Record<string, AuditAnswer>>(r.answers);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = useRef<Record<string, AuditAnswer>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const editable = r.canFill && r.status !== 'completed';
  const score = useMemo(() => scoreAudit(r.checklist, answers), [r.checklist, answers]);
  const total = score.results.length;
  const done = total - score.unanswered.length;
  const set = (qid: string, a: AuditAnswer) => {
    setAnswers((x) => ({ ...x, [qid]: a }));
    dirty.current[qid] = a;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const batch = dirty.current;
      dirty.current = {};
      void supplyApi.saveRun(orgId, r.id, batch).catch(() => { dirty.current = { ...batch, ...dirty.current }; });
    }, 800);
  };
  return (
    <>
      <ScreenHeader title={r.scheduleName} kicker={r.locationName ?? undefined} back />
      {editable ? (
        <Card dark>
          <Text tone="inverse" weight={700}>{t('progress', { done, total })}</Text>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.2)', overflow: 'hidden' }}><View style={{ width: `${total ? (done / total) * 100 : 0}%`, height: 6, backgroundColor: color.lime }} /></View>
        </Card>
      ) : (
        <Card bg={r.passed ? S.success.bg : S.danger.bg}>
          <Text variant="h3">{r.status === 'missed' ? t('missed') : r.passed ? t('passed') : t('failed')}</Text>
          {r.completedBy?.name ? <Text variant="small">{t('doneBy', { name: r.completedBy.name })}</Text> : null}
          {r.failedItems.length ? <Text variant="small">{t('failedItems', { items: r.failedItems.map((f) => f.text).join(', ') })}</Text> : null}
        </Card>
      )}
      {editable && score.criticalFailed ? <Banner tone="danger" icon="alert" title={t('criticalLive')} /> : null}
      {r.checklist.sections.map((s) => (
        <View key={s.id} style={{ gap: 10 }}>
          <SectionHeader title={s.title} />
          {s.questions.map((qq) => <Question key={qq.id} q={qq} a={answers[qq.id]} editable={editable} failed={!!score.results.find((x) => x.questionId === qq.id)?.failed} onChange={(a) => set(qq.id, a)} />)}
        </View>
      ))}
      {editable ? (
        <>
          {err ? <Banner tone="danger" title={err} /> : null}
          {!online ? <Text variant="small" tone="muted">{t('needsConnection')}</Text> : null}
          <Button label={t('submit')} icon="check" variant="signal" size="lg" disabled={score.unanswered.length > 0 || !online} loading={busy} onPress={async () => {
            setBusy(true); setErr(null);
            if (timer.current) clearTimeout(timer.current);
            dirty.current = {};
            try { await supplyApi.completeRun(orgId, r.id, answers); onDone(); } catch (e) { setErr(e instanceof Error ? e.message : t('error')); } finally { setBusy(false); }
          }} />
          {score.unanswered.length ? <Text variant="small" tone="muted">{t('answerAll')}</Text> : null}
        </>
      ) : <Button label={t('back')} variant="ghost" icon="arrow-left" onPress={() => router.back()} />}
    </>
  );
}

function Question({ q, a, editable, failed, onChange }: { q: AuditQuestion; a: AuditAnswer | undefined; editable: boolean; failed: boolean; onChange: (a: AuditAnswer) => void }) {
  const { t } = useST();
  const [noteOpen, setNoteOpen] = useState(!!a?.note);
  const choice = (label: string, active: boolean, tone: 'ok' | 'bad' | 'neutral', onPress: () => void) => (
    <Pressable key={label} disabled={!editable} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active, disabled: !editable }} accessibilityLabel={`${q.text}: ${label}`}
      style={{ minHeight: 52, minWidth: 72, paddingHorizontal: 18, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? (tone === 'ok' ? S.success.fg : tone === 'bad' ? S.danger.fg : color.ink) : color.canvas }}>
      <Text weight={800} color={active ? color.surface : color.ink}>{label}</Text>
    </Pressable>
  );
  const range = q.min !== undefined && q.max !== undefined ? t('range', { min: q.min, max: q.max }) : q.max !== undefined ? t('max', { max: q.max }) : q.min !== undefined ? t('min', { min: q.min }) : '';
  return (
    <Card style={{ borderWidth: 1.5, borderColor: failed ? S.danger.border : a ? S.success.border : color.lineSoft }}>
      {q.critical ? <Badge label={t('critical')} tone="danger" icon="alert" /> : null}
      <Text weight={700}>{q.text}</Text>
      {q.type === 'yes_no' ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {choice(t('yes'), a?.value === 'yes' && !a?.na, 'ok', () => onChange({ ...a, value: 'yes', na: false }))}
          {choice(t('no'), a?.value === 'no' && !a?.na, 'bad', () => onChange({ ...a, value: 'no', na: false }))}
          {choice(t('na'), !!a?.na, 'neutral', () => onChange({ ...a, na: !a?.na, value: null }))}
        </View>
      ) : null}
      {q.type === 'scale' ? <View style={{ flexDirection: 'row', gap: 8 }}>{[1, 2, 3, 4, 5].map((n) => choice(String(n), a?.value === n, n <= 2 ? 'bad' : 'ok', () => onChange({ ...a, value: n, na: false })))}</View> : null}
      {q.type === 'number' ? (
        <TextField label={`${q.unit ? `${q.unit} · ` : ''}${range}`} keyboardType="numbers-and-punctuation" editable={editable} value={typeof a?.value === 'number' ? String(a.value) : ''}
          onChangeText={(v) => onChange({ ...a, value: v.trim() === '' || v.trim() === '-' ? null : Number(v.replace(',', '.')), na: false })} />
      ) : null}
      {q.type === 'text' ? <TextField label={q.text} multiline editable={editable} value={typeof a?.value === 'string' ? a.value : ''} onChangeText={(v) => onChange({ ...a, value: v })} /> : null}
      {editable && !noteOpen && failed ? <Button label={t('addNote')} size="sm" variant="ghost" onPress={() => setNoteOpen(true)} /> : null}
      {noteOpen ? <TextField label={t('note')} placeholder={t('notePlaceholder')} editable={editable} value={a?.note ?? ''} onChangeText={(v) => onChange({ ...a, note: v })} /> : null}
    </Card>
  );
}

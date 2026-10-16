import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { scoreAudit, type AuditAnswer, type AuditQuestion } from '@bh/shared';
import { Badge, Banner, Button, Card, EmptyState, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text, TextField } from '@/components';
import { supplyApi, type RunDetail } from '@/features/supply/api';
import { useST } from '@/features/supply/strings';
import { takePhoto } from '@/features/quality/capture';
import {
  addSelfCheckPhoto, discardSelfCheck, loadSelfCheck, openSelfCheck, queueSelfCheckComplete, setSelfCheckAnswer, useSelfCheckDraft, useSyncState, type SelfCheckDraft,
} from '@/features/quality/offline';
import { useOnline } from '@/lib/network';
import { color, radius, status as S } from '@/theme';

/**
 * Run today's self-check (opening, closing, temperature log): big answer buttons, saved on the phone first and synced
 * through the same offline queue as audits — answers, photos and the submit all wait for the connection when needed.
 */
export default function SelfCheckScreen() {
  const { id, org } = useLocalSearchParams<{ id: string; org: string }>();
  const { t } = useST();
  const online = useOnline();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await supplyApi.run(org!, id!);
        if (!live) return;
        if (r.canFill && r.status !== 'completed' && r.status !== 'missed') await openSelfCheck(org!, r);
        else if (r.status === 'completed') await discardSelfCheck(r.id);
        setRun(r);
      } catch {
        // Offline (or the server is unreachable): open the copy kept on this phone.
        const d = await loadSelfCheck(id!);
        if (!live) return;
        if (d) setRun(d.done ?? d.run);
        else setFailed(true);
      }
    })();
    return () => { live = false; };
  }, [id, org, reload]);
  if (!run) {
    return (
      <Screen tabs={false}>
        <ScreenHeader title={t('checks')} back />
        {failed ? <EmptyState icon="wifi-off" title={online ? t('error') : t('offline')} action={t('retry')} onAction={() => { setFailed(false); setReload((x) => x + 1); }} /> : <SkeletonCard />}
      </Screen>
    );
  }
  return (
    <Screen tabs={false} onRefresh={() => setReload((x) => x + 1)}>
      <Run r={run} onDone={(r) => setRun(r)} />
    </Screen>
  );
}

function Run({ r, onDone }: { r: RunDetail; onDone: (r: RunDetail) => void }) {
  const { t } = useST();
  const online = useOnline();
  const sync = useSyncState();
  const draft = useSelfCheckDraft(r.id);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // The submit went through (now or after reconnecting): show the result the server returned.
  useEffect(() => { if (draft?.done && draft.done.status === 'completed' && r.status !== 'completed') onDone(draft.done); }, [draft?.done, r.status, onDone]);
  const editable = r.canFill && r.status !== 'completed' && r.status !== 'missed';
  const answers = (editable ? draft?.answers : undefined) ?? r.answers;
  const score = useMemo(() => scoreAudit(r.checklist, answers), [r.checklist, answers]);
  const total = score.results.length;
  const done = total - score.unanswered.length;
  const pending = (draft?.dirty.length ?? 0) + (draft?.photos.length ?? 0);
  const statusLine = !online ? t('offline') : sync === 'syncing' ? t('syncing') : sync === 'error' ? t('syncError') : pending ? t('pendingSync', { n: pending }) : t('synced');
  const photoUri = (pid: string, d: SelfCheckDraft | null) => {
    const local = d?.photos.find((p) => p.localId === pid);
    if (local) return `data:${local.mime};base64,${local.base64}`;
    return d?.photoUrls[d.uploaded[pid] ?? pid] ?? null;
  };
  return (
    <>
      <ScreenHeader title={r.scheduleName} kicker={r.locationName ?? undefined} back />
      {editable ? (
        <Card dark>
          <Text tone="inverse" weight={700}>{t('progress', { done, total })}</Text>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.2)', overflow: 'hidden' }}><View style={{ width: `${total ? (done / total) * 100 : 0}%`, height: 6, backgroundColor: color.lime }} /></View>
          <Text tone="inverse" variant="small" accessibilityLiveRegion="polite">{statusLine}</Text>
        </Card>
      ) : (
        <Card bg={r.passed ? S.success.bg : S.danger.bg}>
          <Text variant="h3">{r.status === 'missed' ? t('missed') : r.passed ? t('passed') : t('failed')}</Text>
          {r.completedBy?.name ? <Text variant="small">{t('doneBy', { name: r.completedBy.name })}</Text> : null}
          {r.failedItems.length ? <Text variant="small">{t('failedItems', { items: r.failedItems.map((f) => f.text).join(', ') })}</Text> : null}
        </Card>
      )}
      {editable && score.criticalFailed ? <Banner tone="danger" icon="alert" title={t('criticalLive')} /> : null}
      {editable && draft?.lastError ? <Banner tone="danger" title={t('syncError')} body={draft.lastError} /> : null}
      {r.checklist.sections.map((s) => (
        <View key={s.id} style={{ gap: 10 }}>
          <SectionHeader title={s.title} />
          {s.questions.map((qq) => (
            <Question key={qq.id} q={qq} a={answers[qq.id]} editable={editable} failed={!!score.results.find((x) => x.questionId === qq.id)?.failed}
              photoUri={(pid) => photoUri(pid, draft)} onChange={(a) => void setSelfCheckAnswer(r.id, qq.id, a)}
              onPhoto={async () => { const ph = await takePhoto(); if (ph) await addSelfCheckPhoto(r.id, qq.id, ph.base64, ph.mime); }} />
          ))}
        </View>
      ))}
      {editable ? (
        <>
          <TextField label={t('note')} placeholder={t('notePlaceholder')} value={note} onChangeText={setNote} multiline maxLength={2000} />
          {draft?.complete ? <Banner tone="info" title={t('submitQueued')} /> : null}
          <Button label={t('submit')} icon="check" variant="signal" size="lg" disabled={score.unanswered.length > 0 || !!draft?.complete || !draft} loading={busy} onPress={async () => {
            setBusy(true);
            try { await queueSelfCheckComplete(r.id, note.trim() || null); } finally { setBusy(false); }
          }} />
          {score.unanswered.length ? <Text variant="small" tone="muted">{t('answerAll')}</Text> : null}
        </>
      ) : <Button label={t('back')} variant="ghost" icon="arrow-left" onPress={() => router.back()} />}
    </>
  );
}

function Question({ q, a, editable, failed, photoUri, onChange, onPhoto }: { q: AuditQuestion; a: AuditAnswer | undefined; editable: boolean; failed: boolean; photoUri: (id: string) => string | null; onChange: (a: AuditAnswer) => void; onPhoto: () => Promise<void> }) {
  const { t } = useST();
  const [noteOpen, setNoteOpen] = useState(!!a?.note);
  const [busy, setBusy] = useState(false);
  const needsPhoto = q.photoRequired || q.type === 'photo';
  const choice = (label: string, active: boolean, tone: 'ok' | 'bad' | 'neutral', onPress: () => void) => (
    <Pressable key={label} disabled={!editable} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active, disabled: !editable }} accessibilityLabel={`${q.text}: ${label}`}
      style={{ minHeight: 52, minWidth: 72, paddingHorizontal: 18, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? (tone === 'ok' ? S.success.fg : tone === 'bad' ? S.danger.fg : color.ink) : color.canvas }}>
      <Text weight={800} color={active ? color.surface : color.ink}>{label}</Text>
    </Pressable>
  );
  const range = q.min !== undefined && q.max !== undefined ? t('range', { min: q.min, max: q.max }) : q.max !== undefined ? t('max', { max: q.max }) : q.min !== undefined ? t('min', { min: q.min }) : '';
  return (
    <Card style={{ borderWidth: 1.5, borderColor: failed ? S.danger.border : a ? S.success.border : color.lineSoft }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {q.critical ? <Badge label={t('critical')} tone="danger" icon="alert" /> : null}
        {needsPhoto ? <Badge label={t('photoRequired')} tone="info" icon="image" /> : null}
      </View>
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
      {(a?.photoIds ?? []).length || (editable && needsPhoto) ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {(a?.photoIds ?? []).map((pid) => {
            const uri = photoUri(pid);
            return uri ? <Image key={pid} source={{ uri }} accessibilityLabel={q.text} style={{ width: 64, height: 64, borderRadius: radius.sm }} /> : <Badge key={pid} label={t('photoPending')} tone="info" />;
          })}
          {editable && needsPhoto ? <Button label={t('addPhoto')} icon="image" size="sm" variant={(a?.photoIds ?? []).length ? 'secondary' : 'signal'} loading={busy} onPress={async () => { setBusy(true); try { await onPhoto(); } finally { setBusy(false); } }} /> : null}
        </View>
      ) : null}
      {editable && !noteOpen && failed ? <Button label={t('addNote')} size="sm" variant="ghost" onPress={() => setNoteOpen(true)} /> : null}
      {noteOpen ? <TextField label={t('note')} placeholder={t('notePlaceholder')} editable={editable} value={a?.note ?? ''} onChangeText={(v) => onChange({ ...a, note: v })} /> : null}
    </Card>
  );
}

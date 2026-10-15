import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { scoreAudit, type AuditAnswer, type AuditQuestion } from '@bh/shared';
import { Badge, Banner, Button, Card, EmptyState, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text, TextField } from '@/components';
import { qualityApi, type ActionItem, type AuditDetail, type FileRef } from '@/features/quality/api';
import { takePhoto } from '@/features/quality/capture';
import { addPhoto, discardDraft, loadDraft, openDraft, queueComplete, setAnswer, useDraft, useSyncState, type Draft } from '@/features/quality/offline';
import { useQT } from '@/features/quality/strings';
import { useOnline } from '@/lib/network';
import { color, radius, status as S } from '@/theme';

/** One audit: conduct it (works offline, syncs when back online) or read the report and work the corrective actions. */
export default function AuditScreen() {
  const { id, org } = useLocalSearchParams<{ id: string; org: string }>();
  const { t } = useQT();
  const online = useOnline();
  const [audit, setAudit] = useState<AuditDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const a = await qualityApi.audit(org!, id!);
        if (!live) return;
        if (a.permissions.conduct) await openDraft(org!, a);
        else if (a.status === 'completed') await discardDraft(a.id);
        setAudit(a);
      } catch {
        // Offline (or the server is unreachable): open the copy kept on this phone.
        const d = await loadDraft(id!);
        if (!live) return;
        if (d) setAudit(d.audit);
        else setFailed(true);
      }
    })();
    return () => { live = false; };
  }, [id, org, reload]);
  if (!audit) {
    return (
      <Screen tabs={false}>
        <ScreenHeader title={t('title')} back />
        {failed ? <EmptyState icon="wifi-off" title={online ? t('error') : t('offline')} action={t('retry')} onAction={() => { setFailed(false); setReload((x) => x + 1); }} /> : <SkeletonCard />}
      </Screen>
    );
  }
  return audit.permissions.conduct && audit.status !== 'completed' && audit.status !== 'cancelled'
    ? <Conduct audit={audit} orgId={org!} onCompleted={(a) => setAudit(a)} />
    : <Report audit={audit} orgId={org!} onChanged={() => setReload((x) => x + 1)} />;
}

function Conduct({ audit, orgId, onCompleted }: { audit: AuditDetail; orgId: string; onCompleted: (a: AuditDetail) => void }) {
  const { t, locale } = useQT();
  const online = useOnline();
  const sync = useSyncState();
  const draft = useDraft(audit.id);
  const [summary, setSummary] = useState('');
  const [completing, setCompleting] = useState(false);
  const answers = draft?.answers ?? {};
  const score = useMemo(() => scoreAudit(audit.checklist, answers), [audit.checklist, answers]);
  const total = score.results.length;
  const done = total - score.unanswered.length;
  const photoUri = (pid: string, d: Draft | null) => {
    const local = d?.photos.find((p) => p.localId === pid);
    if (local) return `data:${local.mime};base64,${local.base64}`;
    const serverId = d?.uploaded[pid] ?? pid;
    return Object.values(d?.audit.answers ?? audit.answers).flatMap((a) => a.photos ?? []).find((p) => p.id === serverId)?.url ?? null;
  };
  const pendingChanges = (draft?.dirty.length ?? 0) + (draft?.photos.length ?? 0);
  const statusLine = !online ? t('offline') : sync === 'syncing' ? t('syncing') : sync === 'error' ? t('syncError') : pendingChanges ? t('pendingSync', { n: pendingChanges }) : t('synced');
  return (
    <Screen tabs={false}>
      <ScreenHeader title={audit.locationName ?? t('title')} kicker={`${audit.name} · ${t('due', { date: new Date(`${audit.dueDate}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short' }) })}`} back />
      <Card dark>
        <Text tone="inverse" weight={700}>{t('progress', { done, total })}</Text>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.2)', overflow: 'hidden' }}><View style={{ width: `${total ? (done / total) * 100 : 0}%`, height: 6, backgroundColor: color.lime }} /></View>
        <Text tone="inverse" variant="small">{t('score', { pct: score.scorePct === null ? '—' : `${score.scorePct}%` })} · {t('passMark', { pct: audit.checklist.passThreshold })}</Text>
        <Text tone="inverse" variant="small" accessibilityLiveRegion="polite">{statusLine}</Text>
      </Card>
      {score.criticalFailed ? <Banner tone="danger" icon="alert" title={t('failedCritical')} /> : null}
      {draft?.lastError ? <Banner tone="danger" title={t('syncError')} body={draft.lastError} /> : null}
      {audit.checklist.sections.map((s) => (
        <View key={s.id} style={{ gap: 10 }}>
          <SectionHeader title={s.title} />
          {s.questions.map((q) => (
            <QuestionCard key={q.id} q={q} a={answers[q.id]} failed={!!score.results.find((r) => r.questionId === q.id)?.failed} photoUri={(pid) => photoUri(pid, draft)}
              onChange={(p) => void setAnswer(audit.id, q.id, p)}
              onPhoto={async () => { const ph = await takePhoto(); if (ph) await addPhoto(audit.id, q.id, ph.base64, ph.mime); }} />
          ))}
        </View>
      ))}
      <SectionHeader title={t('complete')} />
      <TextField label={t('summary')} value={summary} onChangeText={setSummary} multiline maxLength={4000} />
      {draft?.complete ? <Banner tone="info" title={t('completeQueued')} /> : null}
      <Button label={t('complete')} variant="signal" icon="check" disabled={score.unanswered.length > 0 || !!draft?.complete} loading={completing} onPress={async () => {
        setCompleting(true);
        try {
          await queueComplete(audit.id, summary || null);
          if (online) {
            const fresh = await qualityApi.audit(orgId, audit.id).catch(() => null);
            if (fresh && fresh.status === 'completed') onCompleted(fresh);
          }
        } finally { setCompleting(false); }
      }} />
      {score.unanswered.length > 0 ? <Text variant="small" tone="muted">{t('answerAll')}</Text> : null}
    </Screen>
  );
}

function QuestionCard({ q, a, failed, photoUri, onChange, onPhoto }: { q: AuditQuestion; a: AuditAnswer | undefined; failed: boolean; photoUri: (id: string) => string | null; onChange: (p: Partial<AuditAnswer>) => void; onPhoto: () => Promise<void> }) {
  const { t } = useQT();
  const [noteOpen, setNoteOpen] = useState(!!a?.note);
  const [busy, setBusy] = useState(false);
  const needsPhoto = q.photoRequired || q.type === 'photo';
  const choice = (label: string, active: boolean, tone: 'ok' | 'bad' | 'neutral', onPress: () => void) => (
    <Pressable key={label} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`${q.text}: ${label}`}
      style={{ minHeight: 44, minWidth: 56, paddingHorizontal: 14, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? (tone === 'ok' ? S.success.fg : tone === 'bad' ? S.danger.fg : color.ink) : color.canvas }}>
      <Text weight={700} color={active ? color.surface : color.ink}>{label}</Text>
    </Pressable>
  );
  return (
    <Card style={{ borderWidth: 1.5, borderColor: failed ? S.danger.border : a ? S.success.border : color.lineSoft }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {q.critical ? <Badge label={t('critical')} tone="danger" icon="alert" /> : null}
        {needsPhoto ? <Badge label={t('photoRequired')} tone="info" icon="image" /> : null}
      </View>
      <Text weight={700}>{q.text}</Text>
      {q.guidance ? <Text variant="small" tone="muted">{q.guidance}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {q.type === 'yes_no' ? [choice(t('yes'), a?.value === 'yes' && !a?.na, 'ok', () => onChange({ value: 'yes', na: false })), choice(t('no'), a?.value === 'no' && !a?.na, 'bad', () => onChange({ value: 'no', na: false }))] : null}
        {q.type === 'scale' ? [1, 2, 3, 4, 5].map((n) => choice(String(n), a?.value === n && !a?.na, n <= 2 ? 'bad' : 'ok', () => onChange({ value: n, na: false }))) : null}
        {q.type !== 'text' && q.type !== 'photo' ? choice(t('na'), !!a?.na, 'neutral', () => onChange({ na: !a?.na })) : null}
      </View>
      {q.type === 'number' ? <TextField label={q.unit ? `${q.text} (${q.unit})` : q.text} keyboardType="decimal-pad" value={typeof a?.value === 'number' ? String(a.value) : ''} onChangeText={(v) => onChange({ value: v.trim() === '' ? null : Number(v.replace(',', '.')), na: false })} /> : null}
      {q.type === 'text' ? <TextField label={q.text} multiline value={typeof a?.value === 'string' ? a.value : ''} onChangeText={(v) => onChange({ value: v })} /> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {(a?.photoIds ?? []).map((pid) => {
          const uri = photoUri(pid);
          return uri ? <Image key={pid} source={{ uri }} accessibilityLabel={q.text} style={{ width: 64, height: 64, borderRadius: radius.sm }} /> : <Badge key={pid} label={t('photoPending')} tone="info" />;
        })}
        <Button label={t('addPhoto')} icon="image" size="sm" variant={needsPhoto && !(a?.photoIds ?? []).length ? 'signal' : 'secondary'} loading={busy} onPress={async () => { setBusy(true); try { await onPhoto(); } finally { setBusy(false); } }} />
        {!noteOpen ? <Button label={t('addNote')} size="sm" variant="ghost" onPress={() => setNoteOpen(true)} /> : null}
      </View>
      {noteOpen ? <TextField label={t('note')} placeholder={t('notePlaceholder')} multiline value={a?.note ?? ''} onChangeText={(v) => onChange({ note: v })} /> : null}
    </Card>
  );
}

function Report({ audit, orgId, onChanged }: { audit: AuditDetail; orgId: string; onChanged: () => void }) {
  const { t, locale } = useQT();
  const date = (ymd: string | null) => (ymd ? new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  return (
    <Screen tabs={false} onRefresh={onChanged}>
      <ScreenHeader title={audit.locationName ?? t('title')} kicker={audit.name} back />
      {audit.status === 'completed' ? (
        <Card bg={audit.passed ? S.success.bg : S.danger.bg}>
          <Text variant="label">{audit.passed ? t('passed') : t('failed')}</Text>
          <Text variant="display" tabular>{audit.scorePct === null ? '—' : `${audit.scorePct}%`}</Text>
          <Text variant="small">{t('completedOn', { date: date(audit.completedAt) })} · {t('passMark', { pct: audit.passThreshold })}</Text>
          {audit.criticalFailed ? <Badge label={t('failedCritical')} tone="danger" icon="alert" /> : null}
          {audit.reauditDueDate ? <Text variant="small" weight={700}>{t('reaudit', { date: date(audit.reauditDueDate) })}</Text> : null}
        </Card>
      ) : (
        <Card><Badge label={t(audit.status)} tone="info" /><Text>{t('due', { date: date(audit.dueDate) })}</Text></Card>
      )}
      {audit.summary ? <Card><Text weight={700}>{t('summary')}</Text><Text>{audit.summary}</Text></Card> : null}
      <SectionHeader title={t('actions')} />
      {!audit.actions.length ? <Text tone="muted">{t('noActionsReport')}</Text> : null}
      {audit.actions.map((x) => <ActionCard key={x.id} x={x} audit={audit} orgId={orgId} onChanged={onChanged} />)}
      <Button label={t('back')} variant="ghost" icon="arrow-left" onPress={() => router.back()} />
    </Screen>
  );
}

function ActionCard({ x, audit, orgId, onChanged }: { x: ActionItem; audit: AuditDetail; orgId: string; onChanged: () => void }) {
  const { t, locale } = useQT();
  const online = useOnline();
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState<FileRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); onChanged(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const canRespond = audit.permissions.respond && x.status === 'open';
  const canVerify = audit.permissions.verify && x.status === 'submitted';
  return (
    <Card style={{ borderWidth: 1.5, borderColor: x.overdue ? S.danger.border : color.lineSoft }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Badge label={t(x.status)} tone={x.status === 'verified' ? 'success' : x.status === 'submitted' ? 'info' : 'warning'} />
        {x.critical ? <Badge label={t('critical')} tone="danger" icon="alert" /> : null}
        {x.overdue ? <Badge label={t('overdue')} tone="danger" /> : null}
      </View>
      <Text weight={700}>{x.title}</Text>
      <Text variant="small" tone="muted">{x.sectionTitle} · {t('due', { date: new Date(`${x.dueDate}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short' }) })}</Text>
      {x.auditorNote ? <Text variant="small">{x.auditorNote}</Text> : null}
      {x.reviewNote && x.status === 'open' ? <Banner tone="warning" title={t('reopened', { note: x.reviewNote })} /> : null}
      {x.responseNote ? <Text variant="small">{x.responseNote}</Text> : null}
      {x.evidence.length ? <View style={{ flexDirection: 'row', gap: 8 }}>{x.evidence.map((p) => <Image key={p.id} source={{ uri: p.url }} accessibilityLabel={x.title} style={{ width: 64, height: 64, borderRadius: radius.sm }} />)}</View> : null}
      {err ? <Banner tone="danger" title={err} /> : null}
      {canRespond ? (
        <View style={{ gap: 8 }}>
          {!online ? <Text variant="small" tone="muted">{t('needsConnection')}</Text> : null}
          <TextField label={t('whatFixed')} value={note} onChangeText={setNote} multiline />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {evidence.map((p) => <Image key={p.id} source={{ uri: p.url }} accessibilityLabel={x.title} style={{ width: 56, height: 56, borderRadius: radius.sm }} />)}
            <Button label={t('addEvidence')} icon="image" size="sm" variant="secondary" disabled={!online} loading={busy} onPress={() => run(async () => {
              const ph = await takePhoto();
              if (!ph) return;
              const up = await qualityApi.uploadEvidence(orgId, x.id, { filename: ph.name, contentType: ph.mime, dataBase64: ph.base64 });
              setEvidence((e) => [...e, up]);
            })} />
          </View>
          <Button label={t('markDone')} icon="check" disabled={!evidence.length || !online} loading={busy} onPress={() => run(() => qualityApi.submitAction(orgId, x.id, note, evidence.map((p) => p.id)))} />
          {!evidence.length ? <Text variant="small" tone="muted">{t('evidenceNeeded')}</Text> : null}
        </View>
      ) : null}
      {canVerify ? (
        <View style={{ gap: 8 }}>
          <TextField label={t('reviewNote')} value={note} onChangeText={setNote} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label={t('reopen')} variant="secondary" icon="undo" size="sm" disabled={!note || !online} loading={busy} onPress={() => run(() => qualityApi.verifyAction(orgId, x.id, 'reopen', note))} />
            <Button label={t('verify')} icon="check-circle" size="sm" disabled={!online} loading={busy} onPress={() => run(() => qualityApi.verifyAction(orgId, x.id, 'verify', note || undefined))} />
          </View>
        </View>
      ) : null}
    </Card>
  );
}

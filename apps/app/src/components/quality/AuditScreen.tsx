'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Icon, Input, Textarea, cx } from '@bh/ui';
import { scoreAudit, type AuditAnswer, type AuditQuestion } from '@bh/shared';
import { ApiError } from '@/lib/errors';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, LoadingBlock, SectionCard } from '../ui/States';
import { qualityApi, readUpload, useQuality, useQualityAction, type ActionVM, type AuditDetailVM, type FileRef } from './api';
import { ActionError, ScoreBadge, StatusBadge, Tiles, useQFmt } from './ui';

/** One audit: conduct it (assigned auditor or HQ) with autosave, or read the report and work the corrective actions. */
export function AuditScreen({ id }: { id: string }) {
  const app = useApp();
  const res = useQuality(() => qualityApi.audit(id), [app.org.id, id]);
  if (!app.hasModule('operations.audits')) return <DeniedState />;
  return (
    <Async res={res} loading={<LoadingBlock variant="detail" />}>
      {(a) => (a.permissions.conduct ? <Conduct audit={a} onDone={res.reload} /> : <Report audit={a} onChanged={res.reload} />)}
    </Async>
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'error';
const draftKey = (id: string) => `bh_audit_draft_${id}`;
const readDraft = (id: string): Record<string, AuditAnswer> => {
  try { return JSON.parse(localStorage.getItem(draftKey(id)) ?? '{}') as Record<string, AuditAnswer>; } catch { return {}; }
};
const writeDraft = (id: string, d: Record<string, AuditAnswer>) => {
  try { if (Object.keys(d).length) localStorage.setItem(draftKey(id), JSON.stringify(d)); else localStorage.removeItem(draftKey(id)); } catch { /* storage unavailable */ }
};

function Conduct({ audit, onDone }: { audit: AuditDetailVM; onDone: () => void }) {
  const t = useTranslations('quality');
  const f = useQFmt();
  const strip = (x: Record<string, AuditAnswer & { photos?: FileRef[] }>) => Object.fromEntries(Object.entries(x).map(([k, { photos: _p, ...v }]) => [k, v]));
  const [answers, setAnswers] = useState<Record<string, AuditAnswer>>(() => ({ ...strip(audit.answers), ...(typeof window === 'undefined' ? {} : readDraft(audit.id)) }));
  const [photos, setPhotos] = useState<Record<string, string>>(() => Object.fromEntries(Object.values(audit.answers).flatMap((v) => (v.photos ?? []).map((p) => [p.id, p.url]))));
  const [save, setSave] = useState<{ state: SaveState; at?: string }>({ state: 'idle' });
  const [summary, setSummary] = useState('');
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const dirty = useRef<Set<string>>(new Set(Object.keys(typeof window === 'undefined' ? {} : readDraft(audit.id))));
  const latest = useRef(answers);
  latest.current = answers;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const act = useQualityAction();

  const flush = useCallback(async () => {
    if (!dirty.current.size) return true;
    if (typeof navigator !== 'undefined' && !navigator.onLine) { setSave({ state: 'offline' }); return false; }
    const keys = [...dirty.current];
    const batch = Object.fromEntries(keys.map((k) => [k, latest.current[k]!]));
    setSave({ state: 'saving' });
    try {
      const r = await qualityApi.saveAnswers(audit.id, batch);
      for (const k of keys) if (latest.current[k] === batch[k]) dirty.current.delete(k);
      writeDraft(audit.id, Object.fromEntries([...dirty.current].map((k) => [k, latest.current[k]!])));
      setSave({ state: 'saved', at: r.savedAt });
      return true;
    } catch (e) {
      const offline = e instanceof ApiError && (e.code === 'network_error' || e.status === 0);
      setSave({ state: offline ? 'offline' : 'error' });
      if (offline) timer.current = setTimeout(() => void flush(), 5000);
      return false;
    }
  }, [audit.id]);

  useEffect(() => {
    const on = () => void flush();
    window.addEventListener('online', on);
    if (dirty.current.size) void flush();
    return () => { window.removeEventListener('online', on); if (timer.current) clearTimeout(timer.current); };
  }, [flush]);

  const setAnswer = (qid: string, patch: Partial<AuditAnswer>) => {
    setAnswers((prev) => {
      const next = { ...prev, [qid]: { ...prev[qid], ...patch } };
      latest.current = next;
      dirty.current.add(qid);
      writeDraft(audit.id, Object.fromEntries([...dirty.current].map((k) => [k, next[k]!])));
      return next;
    });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 800);
  };

  const addPhoto = async (qid: string, file: File) => {
    setUploading(qid);
    setUploadError(null);
    try {
      const up = await qualityApi.uploadPhoto(audit.id, await readUpload(file, { shrinkImages: true }));
      setPhotos((p) => ({ ...p, [up.id]: up.url }));
      setAnswer(qid, { photoIds: [...(latest.current[qid]?.photoIds ?? []), up.id] });
    } catch (e) {
      setUploadError(e instanceof ApiError && e.code === 'network_error' ? t('conduct.photoOffline') : e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(null);
    }
  };

  const score = scoreAudit(audit.checklist, answers);
  const total = score.results.length;
  const done = total - score.unanswered.length;
  return (
    <>
      <PageHeader icon="check-circle" title={`${audit.locationName ?? ''} · ${audit.name}`} description={t('conduct.description', { date: f.date(audit.dueDate) })} scope={false}
        actions={<Link href="/audits?tab=audits" className="inline-flex h-10 items-center gap-2 rounded-full bg-canvas px-4 text-sm font-bold hover:bg-line-soft"><Icon name="arrow-left" size={15} />{t('audit.back')}</Link>}
      />
      <div className="sticky top-2 z-10 flex flex-wrap items-center gap-3 rounded-xl bg-ink px-4 py-3 text-white shadow-lg" data-testid="conduct-bar">
        <span className="text-[13px] font-bold">{t('conduct.progress', { done, total })}</span>
        <span className="h-1.5 min-w-[80px] flex-1 overflow-hidden rounded-full bg-white/20" aria-hidden="true"><span className="block h-full bg-lime" style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></span>
        <span className="text-[13px]">{t('conduct.liveScore')} <strong className="tabular">{f.pct(score.scorePct)}</strong></span>
        {score.criticalFailed && <Badge tone="danger" icon="alert">{t('audit.criticalFail')}</Badge>}
        <span role="status" className="text-xs opacity-80">
          {save.state === 'saving' ? t('conduct.saving') : save.state === 'saved' ? t('conduct.saved') : save.state === 'offline' ? t('conduct.offline') : save.state === 'error' ? t('conduct.saveError') : t('conduct.autosave')}
        </span>
      </div>
      {uploadError && <Banner tone="danger" live="assertive">{uploadError}</Banner>}
      {audit.checklist.sections.map((s) => (
        <SectionCard key={s.id} title={s.title} aside={<span className="text-xs text-stone">{t('conduct.sectionProgress', { done: s.questions.filter((q) => !score.unanswered.includes(q.id)).length, total: s.questions.length })}</span>}>
          <ol className="flex flex-col gap-3">
            {s.questions.map((q) => (
              <QuestionCard key={q.id} q={q} a={answers[q.id]} photos={photos} result={score.results.find((r) => r.questionId === q.id)!} uploading={uploading === q.id}
                onChange={(p) => setAnswer(q.id, p)} onPhoto={(file) => void addPhoto(q.id, file)} />
            ))}
          </ol>
        </SectionCard>
      ))}
      <SectionCard title={t('conduct.finish')}>
        <div className="flex flex-col gap-3">
          <Tiles items={[
            { label: t('conduct.liveScore'), value: f.pct(score.scorePct), sub: t('conduct.passMark', { pct: audit.checklist.passThreshold }) },
            { label: t('conduct.failedItems'), value: f.num(score.failedItems.length), sub: t('conduct.becomeActions') },
            { label: t('conduct.unanswered'), value: f.num(score.unanswered.length), tone: score.unanswered.length ? 'danger' : undefined },
          ]} />
          {score.criticalFailed && <Banner tone="danger" icon="alert">{t('conduct.criticalBanner')}</Banner>}
          <Field label={t('conduct.summary')} optional>{(x) => <Textarea id={x.id} value={summary} maxLength={4000} onChange={(e) => setSummary(e.target.value)} />}</Field>
          <ActionError error={act.error} />
          <Button variant="signal" icon="check" className="self-start" disabled={score.unanswered.length > 0} loading={act.pending} onClick={async () => {
            const pending = Object.fromEntries([...dirty.current].map((k) => [k, latest.current[k]!]));
            const r = await act.run(() => qualityApi.complete(audit.id, summary || undefined, pending));
            if (r) { dirty.current.clear(); writeDraft(audit.id, {}); onDone(); }
          }}>{t('conduct.complete')}</Button>
          {score.unanswered.length > 0 && <p className="text-xs text-stone">{t('conduct.answerAll')}</p>}
        </div>
      </SectionCard>
    </>
  );
}

function QuestionCard({ q, a, photos, result, uploading, onChange, onPhoto }: {
  q: AuditQuestion; a: AuditAnswer | undefined; photos: Record<string, string>; result: { failed: boolean; answered: boolean; reason: string | null }; uploading: boolean;
  onChange: (p: Partial<AuditAnswer>) => void; onPhoto: (f: File) => void;
}) {
  const t = useTranslations('quality');
  const [noteOpen, setNoteOpen] = useState(!!a?.note);
  const seg = (active: boolean, tone: 'ok' | 'bad' | 'neutral') => cx('h-11 min-w-[64px] rounded-full px-4 text-[13px] font-bold transition', active ? (tone === 'ok' ? 'bg-success text-white' : tone === 'bad' ? 'bg-danger text-white' : 'bg-ink text-white') : 'bg-canvas hover:bg-line-soft');
  const needsPhoto = q.photoRequired || q.type === 'photo';
  return (
    <li className={cx('flex flex-col gap-2.5 rounded-lg border-[1.5px] p-3.5', result.failed ? 'border-danger/50' : result.answered ? 'border-success/40' : 'border-line-soft')} data-question={q.id}>
      <div className="flex flex-wrap items-start gap-2">
        <span className="min-w-0 flex-1 text-[14px] font-bold">{q.text}</span>
        {q.critical && <Badge tone="danger" icon="alert">{t('audit.critical')}</Badge>}
        {needsPhoto && <Badge tone="info" icon="image">{t('audit.photoRequired')}</Badge>}
      </div>
      {q.guidance && <p className="text-xs text-stone">{q.guidance}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {q.type === 'yes_no' && (<>
          <button type="button" aria-pressed={a?.value === 'yes'} className={seg(a?.value === 'yes' && !a?.na, 'ok')} onClick={() => onChange({ value: 'yes', na: false })}>{t('answer.yes')}</button>
          <button type="button" aria-pressed={a?.value === 'no'} className={seg(a?.value === 'no' && !a?.na, 'bad')} onClick={() => onChange({ value: 'no', na: false })}>{t('answer.no')}</button>
        </>)}
        {q.type === 'scale' && [1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" aria-pressed={a?.value === n} aria-label={t('answer.scaleN', { n })} className={seg(a?.value === n && !a?.na, n <= 2 ? 'bad' : 'ok')} onClick={() => onChange({ value: n, na: false })}>{n}</button>
        ))}
        {q.type === 'number' && (
          <span className="flex items-center gap-2">
            <Input type="number" inputMode="decimal" aria-label={q.text} className="w-32" value={typeof a?.value === 'number' ? a.value : ''} onChange={(e) => onChange({ value: e.target.value === '' ? null : Number(e.target.value), na: false })} />
            {q.unit && <span className="text-sm font-bold">{q.unit}</span>}
            {(q.min !== undefined || q.max !== undefined) && <span className="text-xs text-stone">{q.min !== undefined && q.max !== undefined ? t('answer.range', { min: q.min, max: q.max }) : q.min !== undefined ? t('answer.atLeast', { min: q.min }) : t('answer.atMost', { max: q.max! })}</span>}
          </span>
        )}
        {q.type === 'text' && <Textarea aria-label={q.text} className="min-h-16" value={typeof a?.value === 'string' ? a.value : ''} maxLength={4000} onChange={(e) => onChange({ value: e.target.value, na: false })} />}
        {q.type !== 'text' && q.type !== 'photo' && <button type="button" aria-pressed={!!a?.na} className={seg(!!a?.na, 'neutral')} onClick={() => onChange({ na: !a?.na })}>{t('answer.na')}</button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(a?.photoIds ?? []).map((pid) => photos[pid] ? (
          <span key={pid} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photos[pid]} alt={t('audit.photoOf', { item: q.text })} className="h-16 w-16 rounded-md object-cover" />
            <button type="button" aria-label={t('conduct.removePhoto')} className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-ink text-white" onClick={() => onChange({ photoIds: (a?.photoIds ?? []).filter((x) => x !== pid) })}><Icon name="x" size={12} /></button>
          </span>
        ) : null)}
        <label className={cx('inline-flex h-10 cursor-pointer items-center gap-2 rounded-full px-4 text-[13px] font-bold', needsPhoto && !(a?.photoIds ?? []).length ? 'bg-lime' : 'bg-canvas hover:bg-line-soft')}>
          <Icon name="image" size={15} />{uploading ? t('conduct.uploading') : t('conduct.addPhoto')}
          <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={uploading} onChange={(e) => { const file = e.target.files?.[0]; if (file) onPhoto(file); e.target.value = ''; }} />
        </label>
        {!noteOpen && <button type="button" className="text-[13px] font-bold underline" onClick={() => setNoteOpen(true)}>{t('conduct.addNote')}</button>}
      </div>
      {noteOpen && <Textarea aria-label={t('conduct.note')} placeholder={t('conduct.notePlaceholder')} className="min-h-14" value={a?.note ?? ''} maxLength={2000} onChange={(e) => onChange({ note: e.target.value })} />}
      {result.failed && <p className="text-xs font-bold text-danger">{t(`reason.${result.reason ?? 'no'}` as 'reason.no')} · {t('conduct.willCreateAction')}</p>}
    </li>
  );
}

function answerText(t: ReturnType<typeof useTranslations>, q: AuditQuestion, a: AuditAnswer | undefined): string {
  if (!a) return '—';
  if (a.na) return t('answer.na');
  if (q.type === 'yes_no') return a.value === 'yes' ? t('answer.yes') : a.value === 'no' ? t('answer.no') : '—';
  if (q.type === 'scale') return typeof a.value === 'number' ? t('answer.scaleOf', { n: a.value }) : '—';
  if (q.type === 'number') return typeof a.value === 'number' ? `${a.value}${q.unit ? ` ${q.unit}` : ''}` : '—';
  if (q.type === 'text') return typeof a.value === 'string' && a.value ? a.value : '—';
  return (a.photoIds ?? []).length ? t('answer.photoTaken') : '—';
}

/** The finished report (or the scheduled audit for people who don't conduct it), with corrective actions. */
function Report({ audit, onChanged }: { audit: AuditDetailVM; onChanged: () => void }) {
  const t = useTranslations('quality');
  const f = useQFmt();
  const failed = new Map((audit.breakdown?.failed ?? []).map((x) => [x.questionId, x]));
  return (
    <>
      <PageHeader icon="check-circle" title={`${audit.locationName ?? ''} · ${audit.name}`} description={audit.status === 'completed' ? t('report.completedOn', { date: f.date(audit.completedAt), auditor: audit.auditor?.name ?? '—' }) : t('report.scheduledFor', { date: f.date(audit.dueDate) })} scope={false}
        actions={<Link href="/audits?tab=audits" className="inline-flex h-10 items-center gap-2 rounded-full bg-canvas px-4 text-sm font-bold hover:bg-line-soft"><Icon name="arrow-left" size={15} />{t('audit.back')}</Link>}
      />
      {audit.status !== 'completed' ? (
        <SectionCard>
          <div className="flex flex-wrap items-center gap-2 text-sm"><StatusBadge kind="audit" status={audit.status} /><span>{t('report.notYet', { auditor: audit.auditor?.name ?? t('audit.noAuditor') })}</span></div>
        </SectionCard>
      ) : (
        <>
          <section className="grid gap-3 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]" data-testid="audit-report">
            <div className={cx('flex flex-col justify-center gap-1 rounded-xl p-5', audit.passed ? 'bg-success-bg' : 'bg-danger-bg')}>
              <span className="text-xs font-bold uppercase tracking-[0.06em]">{audit.passed ? t('report.passed') : t('report.failed')}</span>
              <span className="tabular text-[44px] font-extrabold leading-none">{f.pct(audit.scorePct)}</span>
              <span className="text-xs">{t('conduct.passMark', { pct: audit.passThreshold })}</span>
              {audit.criticalFailed && <Badge tone="danger" icon="alert" className="mt-1 self-start">{t('audit.criticalFail')}</Badge>}
              {audit.parent && <span className="mt-1 text-xs">{t('report.previous', { score: f.pct(audit.parent.scorePct) })}</span>}
            </div>
            <div className="rounded-xl bg-surface p-5">
              <h2 className="mb-2 text-lg font-bold">{t('report.bySection')}</h2>
              <ul className="flex flex-col gap-2">
                {(audit.breakdown?.sections ?? []).map((s) => (
                  <li key={s.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-[13px]">
                    <span className="font-bold">{s.title}</span><span className="tabular">{f.pct(s.scorePct)}</span>
                    <span className="col-span-2 h-2 overflow-hidden rounded-full bg-canvas"><span className={cx('block h-full', (s.scorePct ?? 100) >= audit.passThreshold ? 'bg-success' : 'bg-danger')} style={{ width: `${s.scorePct ?? 0}%` }} /></span>
                  </li>
                ))}
              </ul>
              {audit.reauditDueDate && <Banner tone="warning" icon="calendar">{audit.reaudit ? <Link className="underline" href={`/audits/${audit.reaudit.id}`}>{t('report.reaudit', { date: f.date(audit.reauditDueDate) })}</Link> : t('report.reaudit', { date: f.date(audit.reauditDueDate) })}</Banner>}
            </div>
          </section>
          {audit.summary && <SectionCard title={t('conduct.summary')}><p className="whitespace-pre-wrap text-sm">{audit.summary}</p></SectionCard>}
          <SectionCard title={t('report.actions', { count: audit.actions.length })}>
            {audit.actions.length ? (
              <ul className="flex flex-col gap-3" data-testid="corrective-actions">
                {audit.actions.map((x) => <ActionCard key={x.id} x={x} audit={audit} onChanged={onChanged} />)}
              </ul>
            ) : <p className="text-sm text-stone">{t('report.noActions')}</p>}
          </SectionCard>
          {audit.checklist.sections.map((s) => (
            <SectionCard key={s.id} title={s.title}>
              <ul className="flex flex-col divide-y divide-line-soft">
                {s.questions.map((q) => {
                  const a = audit.answers[q.id];
                  const fail = failed.get(q.id);
                  return (
                    <li key={q.id} className="flex flex-col gap-1.5 py-2.5 text-[13px]">
                      <div className="flex flex-wrap items-start gap-2">
                        <span className="min-w-0 flex-1 font-bold">{q.text}</span>
                        {q.critical && <Badge tone="danger" icon="alert">{t('audit.critical')}</Badge>}
                        <Badge tone={fail ? 'danger' : a?.na ? 'neutral' : 'success'}>{answerText(t, q, a)}</Badge>
                      </div>
                      {a?.note && <p className="text-stone">{a.note}</p>}
                      {!!a?.photos?.length && <span className="flex flex-wrap gap-2">{a.photos.map((p) => (
                        <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={p.url} alt={t('audit.photoOf', { item: q.text })} className="h-20 w-20 rounded-md object-cover" />
                        </a>
                      ))}</span>}
                    </li>
                  );
                })}
              </ul>
            </SectionCard>
          ))}
        </>
      )}
    </>
  );
}

function ActionCard({ x, audit, onChanged }: { x: ActionVM; audit: AuditDetailVM; onChanged: () => void }) {
  const t = useTranslations('quality');
  const f = useQFmt();
  const act = useQualityAction();
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState<FileRef[]>([]);
  const [review, setReview] = useState('');
  const canRespond = audit.permissions.respond && x.status === 'open';
  const canVerify = audit.permissions.verify && x.status === 'submitted';
  return (
    <li id={`action-${x.id}`} className={cx('flex flex-col gap-2 rounded-lg border-[1.5px] p-3.5', x.overdue ? 'border-danger' : 'border-line-soft')}>
      <div className="flex flex-wrap items-start gap-2">
        <span className="min-w-0 flex-1"><strong className="text-[14px]">{x.title}</strong><span className="block text-xs text-stone">{x.sectionTitle} · {t(`reason.${x.reason}` as 'reason.no')}</span></span>
        {x.critical && <Badge tone="danger" icon="alert">{t('audit.critical')}</Badge>}
        <StatusBadge kind="action" status={x.status} />
        <Badge tone={x.overdue ? 'danger' : 'neutral'} icon="calendar">{t('actions.due', { date: f.shortDate(x.dueDate) })}</Badge>
      </div>
      {x.auditorNote && <p className="text-[13px]"><span className="font-bold">{t('actions.auditorNote')}</span> {x.auditorNote}</p>}
      {x.reviewNote && x.status === 'open' && <Banner tone="warning">{t('actions.reopened', { note: x.reviewNote })}</Banner>}
      {x.responseNote && <p className="text-[13px]"><span className="font-bold">{t('actions.fix')}</span> {x.responseNote}{x.submittedBy?.name ? ` · ${x.submittedBy.name}` : ''}</p>}
      {!!x.evidence.length && <span className="flex flex-wrap gap-2">{x.evidence.map((p) => (
        <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.url} alt={t('actions.evidenceOf', { item: x.title })} className="h-16 w-16 rounded-md object-cover" />
        </a>
      ))}</span>}
      {x.status === 'verified' && <span className="text-xs text-success">{t('actions.verifiedBy', { name: x.verifiedBy?.name ?? '—', date: f.date(x.verifiedAt) })}</span>}
      <ActionError error={act.error} />
      {canRespond && (
        <div className="flex flex-col gap-2 rounded-md bg-canvas-raised p-3">
          <Field label={t('actions.whatFixed')}>{(fx) => <Textarea id={fx.id} className="min-h-14" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />}</Field>
          <span className="flex flex-wrap items-center gap-2">
            {evidence.map((p) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={p.id} src={p.url} alt={t('actions.evidenceOf', { item: x.title })} className="h-14 w-14 rounded-md object-cover" />
            ))}
            <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full bg-canvas px-4 text-[13px] font-bold hover:bg-line-soft">
              <Icon name="image" size={15} />{t('actions.addEvidence')}
              <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                const up = await act.run(async () => qualityApi.uploadEvidence(x.id, await readUpload(file, { shrinkImages: true })));
                if (up) setEvidence((ev) => [...ev, up]);
              }} />
            </label>
          </span>
          <Button icon="check" className="self-start" disabled={!evidence.length} loading={act.pending} onClick={async () => { if (await act.run(() => qualityApi.submitAction(x.id, note, evidence.map((p) => p.id)))) onChanged(); }}>{t('actions.markDone')}</Button>
          {!evidence.length && <p className="text-xs text-stone">{t('actions.evidenceNeeded')}</p>}
        </div>
      )}
      {canVerify && (
        <div className="flex flex-wrap items-end gap-2 rounded-md bg-canvas-raised p-3">
          <div className="min-w-[200px] flex-1"><Field label={t('actions.reviewNote')} optional>{(fx) => <Input id={fx.id} value={review} maxLength={2000} onChange={(e) => setReview(e.target.value)} />}</Field></div>
          <Button variant="secondary" icon="undo" loading={act.pending} disabled={!review} onClick={async () => { if (await act.run(() => qualityApi.verifyAction(x.id, 'reopen', review))) onChanged(); }}>{t('actions.reopen')}</Button>
          <Button icon="check-circle" loading={act.pending} onClick={async () => { if (await act.run(() => qualityApi.verifyAction(x.id, 'verify', review || undefined))) onChanged(); }}>{t('actions.verify')}</Button>
        </div>
      )}
    </li>
  );
}

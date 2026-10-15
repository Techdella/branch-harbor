'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Icon, Input, Select, Textarea, Toggle } from '@bh/ui';
import { ErrorNote, Panel, useNet, useNetAction, type NetMe } from '../community/net';
import { LoadingBlock } from '../ui/States';
import type { CourseT, TrainingHome } from './TrainingScreen';
import { LESSON_ICON } from './CoursePlayer';

interface QuizQ { id: string; prompt: string; options: string[]; correct: number[] }
interface EditorLesson { id: string; title: string; kind: string; minutes: number | null; body?: string | null; videoUrl?: string | null; quiz?: QuizQ[] | null; passMark?: number | null }
interface EditorDetail { course: CourseT & { canReview: boolean }; outline: { id: string; title: string; lessons: EditorLesson[] }[] }

const STATUS_TONE: Record<string, 'neutral' | 'warning' | 'success' | 'info'> = { draft: 'neutral', pending_approval: 'warning', published: 'success', archived: 'info' };

export function Authoring({ home, onEdit, onChanged }: { home: TrainingHome; onEdit: (id: string) => void; onChanged: () => void }) {
  const t = useTranslations('training.author');
  const act = useNetAction();
  const [title, setTitle] = useState('');
  const pending = useNet<{ items: CourseT[] }>(home.can.manage ? '/training/courses?status=pending_approval' : null);
  const [comment, setComment] = useState<Record<string, string>>({});
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Panel title={t('myCourses')}>
        <form className="flex flex-wrap gap-2" onSubmit={async (e) => {
          e.preventDefault();
          const r = await act.run<CourseT>('post', '/training/courses', { title });
          if (r) { setTitle(''); onChanged(); onEdit(r.id); }
        }}>
          <Input aria-label={t('newCourseTitle')} placeholder={t('newCourseTitle')} value={title} onChange={(e) => setTitle(e.target.value)} className="max-w-sm" />
          <Button type="submit" size="sm" icon="plus" disabled={!title.trim()} loading={act.pending}>{t('create')}</Button>
        </form>
        <ErrorNote error={act.error} />
        <ul className="flex flex-col divide-y divide-line-soft">
          {home.authoring.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <button type="button" className="font-semibold underline-offset-2 hover:underline" onClick={() => onEdit(c.id)}>{c.title}</button>
              <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{t(`status.${c.status}`)}</Badge>
              {c.visibility === 'public' && <Badge tone="info" icon="globe">{t('public')}</Badge>}
              {c.reviewComment && c.status === 'draft' && <span className="w-full text-[13px] text-warning">{t('changesRequested', { comment: c.reviewComment })}</span>}
            </li>
          ))}
          {!home.authoring.length && <li className="py-4 text-sm text-stone">{t('none')}</li>}
        </ul>
      </Panel>
      {home.can.manage && (
        <Panel title={t('reviewQueue')}>
          <ErrorNote error={pending.error} />
          {pending.loading && !pending.data && <LoadingBlock variant="table" rows={2} />}
          <ul className="flex flex-col gap-2">
            {(pending.data?.items ?? []).map((c) => (
              <li key={c.id} className="flex flex-col gap-2 rounded-lg border-[1.5px] border-line-soft p-3">
                <div className="flex flex-wrap items-center gap-2"><button type="button" className="font-bold underline-offset-2 hover:underline" onClick={() => onEdit(c.id)}>{c.title}</button>{c.authorName && <span className="text-[13px] text-stone">{t('by', { name: c.authorName })}</span>}</div>
                <Input aria-label={t('comment')} placeholder={t('comment')} value={comment[c.id] ?? ''} onChange={(e) => setComment({ ...comment, [c.id]: e.target.value })} />
                <div className="flex gap-2">
                  <Button size="sm" icon="check" onClick={async () => { if (await act.run('post', `/training/courses/${c.id}/review`, { decision: 'approve', comment: comment[c.id] || undefined })) { void pending.reload(); onChanged(); } }}>{t('approve')}</Button>
                  <Button size="sm" variant="secondary" disabled={!comment[c.id]} onClick={async () => { if (await act.run('post', `/training/courses/${c.id}/review`, { decision: 'reject', comment: comment[c.id] })) { void pending.reload(); onChanged(); } }}>{t('requestChanges')}</Button>
                </div>
              </li>
            ))}
            {!pending.loading && !(pending.data?.items ?? []).length && <li className="text-sm text-stone">{t('nothingToReview')}</li>}
          </ul>
        </Panel>
      )}
    </div>
  );
}

export function CourseEditor({ id, me, catalogue, onBack }: { id: string; me: NetMe; catalogue: CourseT[]; onBack: () => void }) {
  const t = useTranslations('training.author');
  const res = useNet<EditorDetail>(`/training/courses/${id}`, [id]);
  const act = useNetAction();
  const [form, setForm] = useState<Partial<CourseT> & { priceText?: string }>({});
  const [saved, setSaved] = useState(false);
  const [moduleTitle, setModuleTitle] = useState('');
  const c = res.data?.course;
  useEffect(() => { if (c) setForm({ ...c, priceText: c.price ? (c.price.amount / 100).toFixed(2) : '' }); }, [c]);
  if (!res.data || !c) return <>{res.error ? <ErrorNote error={res.error} /> : <LoadingBlock variant="detail" />}</>;
  const set = (patch: Partial<typeof form>) => { setSaved(false); setForm({ ...form, ...patch }); };
  const save = async () => {
    const price = form.priceText ? Math.round(Number(form.priceText.replace(',', '.')) * 100) : null;
    const r = await act.run('patch', `/training/courses/${id}`, {
      title: form.title, summary: form.summary || null, description: form.description || null, category: form.category || null, passMark: Number(form.passMark), estimatedMinutes: form.estimatedMinutes ? Number(form.estimatedMinutes) : null,
      validityMonths: form.validityMonths ? Number(form.validityMonths) : null, certificateEnabled: form.certificateEnabled, visibility: form.visibility, prerequisiteIds: form.prerequisiteIds ?? [],
      ...(form.visibility === 'public' ? { priceMinor: price, currency: form.price?.currency ?? (form as { currency?: string }).currency ?? null, saleLocationId: form.saleLocationId || null, seats: form.seats ? Number(form.seats) : null, startsOn: form.startsOn || null, scheduleNote: form.scheduleNote || null } : {}),
    });
    if (r) { setSaved(true); void res.reload(); }
  };
  const f = act.error?.fields ?? {};
  const locations = me.directory?.locations ?? [];
  return (
    <div className="flex flex-col gap-3">
      <Button size="sm" variant="ghost" icon="arrow-left" className="self-start" onClick={onBack}>{t('back')}</Button>
      <ErrorNote error={act.error && !Object.keys(f).length ? act.error : res.error} />
      <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
        <Panel title={t('details')} actions={<Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{t(`status.${c.status}`)}</Badge>}>
          {c.reviewComment && <p className="rounded-md bg-warning-bg px-3 py-2 text-[13px] text-warning">{t('changesRequested', { comment: c.reviewComment })}</p>}
          <Field label={t('titleLabel')} error={f.title}>{(p) => <Input id={p.id} value={form.title ?? ''} onChange={(e) => set({ title: e.target.value })} />}</Field>
          <Field label={t('summary')} optional>{(p) => <Input id={p.id} value={form.summary ?? ''} onChange={(e) => set({ summary: e.target.value })} />}</Field>
          <Field label={t('description')} optional>{(p) => <Textarea id={p.id} rows={3} value={form.description ?? ''} onChange={(e) => set({ description: e.target.value })} />}</Field>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label={t('category')} optional>{(p) => <Input id={p.id} value={form.category ?? ''} onChange={(e) => set({ category: e.target.value })} />}</Field>
            <Field label={t('passMark')} error={f.passMark}>{(p) => <Input id={p.id} type="number" min={0} max={100} value={form.passMark ?? 80} onChange={(e) => set({ passMark: Number(e.target.value) })} />}</Field>
            <Field label={t('recertMonths')} hint={t('recertHint')} optional>{(p) => <Input id={p.id} type="number" min={1} max={120} value={form.validityMonths ?? ''} onChange={(e) => set({ validityMonths: e.target.value ? Number(e.target.value) : null })} />}</Field>
          </div>
          <Field label={t('minutes')} optional>{(p) => <Input id={p.id} type="number" min={1} value={form.estimatedMinutes ?? ''} onChange={(e) => set({ estimatedMinutes: e.target.value ? Number(e.target.value) : null })} />}</Field>
          <Field label={t('prerequisites')} optional>{(p) => (
            <Select id={p.id} multiple className="h-28" value={form.prerequisiteIds ?? []} onChange={(e) => set({ prerequisiteIds: [...e.target.selectedOptions].map((o) => o.value) })}>
              {catalogue.filter((x) => x.id !== id).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </Select>
          )}</Field>
          <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{t('certificate')}</span><Toggle checked={!!form.certificateEnabled} onChange={(v) => set({ certificateEnabled: v })} label={t('certificate')} /></div>
          <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{t('sellPublic')}</span><Toggle checked={form.visibility === 'public'} onChange={(v) => set({ visibility: v ? 'public' : 'internal' })} label={t('sellPublic')} /></div>
          {form.visibility === 'public' && (
            <div className="grid gap-2 rounded-lg bg-canvas p-3 sm:grid-cols-2">
              <Field label={t('saleLocation')} error={f.saleLocationId} hint={t('saleLocationHint')}>{(p) => <Select id={p.id} value={form.saleLocationId ?? ''} onChange={(e) => set({ saleLocationId: e.target.value })}><option value="">{t('choose')}</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
              <Field label={t('price')} error={f.priceMinor ?? f.currency}>{(p) => <Input id={p.id} inputMode="decimal" value={form.priceText ?? ''} onChange={(e) => set({ priceText: e.target.value })} />}</Field>
              <Field label={t('currency')} error={f.currency}>{(p) => <Input id={p.id} maxLength={3} value={form.price?.currency ?? (form as { currency?: string }).currency ?? ''} onChange={(e) => set({ price: { amount: form.price?.amount ?? 0, currency: e.target.value.toUpperCase() } })} />}</Field>
              <Field label={t('seats')} optional>{(p) => <Input id={p.id} type="number" min={1} value={form.seats ?? ''} onChange={(e) => set({ seats: e.target.value ? Number(e.target.value) : null })} />}</Field>
              <Field label={t('startsOn')} optional>{(p) => <Input id={p.id} type="date" value={form.startsOn ?? ''} onChange={(e) => set({ startsOn: e.target.value })} />}</Field>
              <Field label={t('schedule')} optional>{(p) => <Input id={p.id} value={form.scheduleNote ?? ''} onChange={(e) => set({ scheduleNote: e.target.value })} />}</Field>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save} loading={act.pending}>{t('save')}</Button>
            {c.status === 'draft' && <Button variant="signal" icon="send" onClick={async () => { await save(); if (await act.run('post', `/training/courses/${id}/submit`)) void res.reload(); }}>{c.canReview ? t('submitOrPublish') : t('submit')}</Button>}
            {c.canReview && c.status !== 'published' && <Button variant="secondary" icon="check" onClick={async () => { if (await act.run('post', `/training/courses/${id}/review`, { decision: 'approve' })) void res.reload(); }}>{t('publishNow')}</Button>}
            {saved && <Badge tone="success">{t('saved')}</Badge>}
          </div>
        </Panel>
        <Panel title={t('content')}>
          {res.data.outline.map((m) => <ModuleEditor key={m.id} module={m} onChanged={() => void res.reload()} />)}
          <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (await act.run('post', `/training/courses/${id}/modules`, { title: moduleTitle })) { setModuleTitle(''); void res.reload(); } }}>
            <Input aria-label={t('moduleTitle')} placeholder={t('moduleTitle')} value={moduleTitle} onChange={(e) => setModuleTitle(e.target.value)} />
            <Button type="submit" size="sm" icon="plus" disabled={!moduleTitle.trim()}>{t('addModule')}</Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}

function ModuleEditor({ module, onChanged }: { module: EditorDetail['outline'][number]; onChanged: () => void }) {
  const t = useTranslations('training.author');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EditorLesson | null>(null);
  return (
    <div className="flex flex-col gap-2 rounded-lg border-[1.5px] border-line-soft p-3">
      <h3 className="font-bold">{module.title}</h3>
      <ul className="flex flex-col gap-1">
        {module.lessons.map((l) => (
          <li key={l.id} className="flex items-center gap-2 text-sm">
            <Icon name={LESSON_ICON[l.kind] ?? 'file'} size={15} />
            <span className="flex-1">{l.title}</span>
            {l.kind === 'quiz' && <Badge tone="neutral">{t('questions', { count: l.quiz?.length ?? 0 })}</Badge>}
            <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(l)}>{t('editLesson')}</Button>
          </li>
        ))}
      </ul>
      {(adding || editing) ? <LessonForm moduleId={module.id} lesson={editing} onDone={() => { setAdding(false); setEditing(null); onChanged(); }} onCancel={() => { setAdding(false); setEditing(null); }} />
        : <Button size="sm" variant="secondary" icon="plus" className="self-start" onClick={() => setAdding(true)}>{t('addLesson')}</Button>}
    </div>
  );
}

function LessonForm({ moduleId, lesson, onDone, onCancel }: { moduleId: string; lesson: EditorLesson | null; onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('training.author');
  const act = useNetAction();
  const [title, setTitle] = useState(lesson?.title ?? '');
  const [kind, setKind] = useState(lesson?.kind ?? 'text');
  const [body, setBody] = useState(lesson?.body ?? '');
  const [videoUrl, setVideoUrl] = useState(lesson?.videoUrl ?? '');
  const [fileName, setFileName] = useState('');
  const [fileUrl, setFileUrl] = useState('');
  const [minutes, setMinutes] = useState(lesson?.minutes ? String(lesson.minutes) : '');
  const [passMark, setPassMark] = useState(lesson?.passMark ? String(lesson.passMark) : '');
  const [quiz, setQuiz] = useState<QuizQ[]>(lesson?.quiz ?? []);
  const f = act.error?.fields ?? {};
  const setQ = (i: number, patch: Partial<QuizQ>) => setQuiz(quiz.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  return (
    <form className="flex flex-col gap-2 rounded-lg bg-canvas p-3" onSubmit={async (e) => {
      e.preventDefault();
      const payload = { title, kind, body: body || null, videoUrl: kind === 'video' ? videoUrl || null : null, minutes: minutes ? Number(minutes) : null, quiz: kind === 'quiz' ? quiz : null, passMark: kind === 'quiz' && passMark ? Number(passMark) : null, ...(fileName && fileUrl ? { attachments: [{ name: fileName, url: fileUrl }] } : {}) };
      const r = lesson ? await act.run('patch', `/training/lessons/${lesson.id}`, payload) : await act.run('post', `/training/modules/${moduleId}/lessons`, payload);
      if (r) onDone();
    }}>
      <ErrorNote error={act.error && !Object.keys(f).length ? act.error : null} />
      <div className="grid gap-2 sm:grid-cols-[1fr_160px_100px]">
        <Field label={t('lessonTitle')} error={f.title}>{(p) => <Input id={p.id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label={t('lessonKind')}>{(p) => <Select id={p.id} value={kind} onChange={(e) => setKind(e.target.value)}>{(['text', 'video', 'file', 'quiz'] as const).map((k) => <option key={k} value={k}>{t(`kinds.${k}`)}</option>)}</Select>}</Field>
        <Field label={t('minutes')} optional>{(p) => <Input id={p.id} type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} />}</Field>
      </div>
      {kind === 'video' && <Field label={t('videoUrl')} hint={t('videoHint')} error={f.videoUrl}>{(p) => <Input id={p.id} type="url" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} />}</Field>}
      <Field label={t('lessonText')} optional>{(p) => <Textarea id={p.id} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
      {kind === 'file' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('fileName')} optional>{(p) => <Input id={p.id} value={fileName} onChange={(e) => setFileName(e.target.value)} />}</Field>
          <Field label={t('fileUrl')} optional>{(p) => <Input id={p.id} type="url" value={fileUrl} onChange={(e) => setFileUrl(e.target.value)} />}</Field>
        </div>
      )}
      {kind === 'quiz' && (
        <div className="flex flex-col gap-2">
          <Field label={t('quizPassMark')} hint={t('quizPassMarkHint')} optional>{(p) => <Input id={p.id} type="number" min={0} max={100} value={passMark} onChange={(e) => setPassMark(e.target.value)} />}</Field>
          {quiz.map((q, i) => (
            <fieldset key={q.id} className="flex flex-col gap-1.5 rounded-lg bg-surface p-2.5">
              <legend className="text-xs font-bold">{t('questionN', { n: i + 1 })}</legend>
              <Input aria-label={t('prompt')} placeholder={t('prompt')} value={q.prompt} onChange={(e) => setQ(i, { prompt: e.target.value })} />
              {q.options.map((o, oi) => (
                <div key={oi} className="flex items-center gap-2">
                  <input type="checkbox" aria-label={t('markCorrect')} className="size-5" checked={q.correct.includes(oi)} onChange={(e) => setQ(i, { correct: e.target.checked ? [...q.correct, oi] : q.correct.filter((x) => x !== oi) })} />
                  <Input aria-label={t('option', { n: oi + 1 })} value={o} onChange={(e) => setQ(i, { options: q.options.map((x, k) => (k === oi ? e.target.value : x)) })} />
                </div>
              ))}
              <div className="flex gap-2">
                {q.options.length < 8 && <Button type="button" size="sm" variant="ghost" icon="plus" onClick={() => setQ(i, { options: [...q.options, ''] })}>{t('addOption')}</Button>}
                <Button type="button" size="sm" variant="ghost" icon="x" onClick={() => setQuiz(quiz.filter((_, j) => j !== i))}>{t('removeQuestion')}</Button>
              </div>
            </fieldset>
          ))}
          <Button type="button" size="sm" variant="secondary" icon="plus" className="self-start" onClick={() => setQuiz([...quiz, { id: `q${Date.now().toString(36)}`, prompt: '', options: ['', ''], correct: [0] }])}>{t('addQuestion')}</Button>
          {f.quiz && <p className="text-xs font-bold text-danger">{f.quiz}</p>}
        </div>
      )}
      <div className="flex gap-2"><Button type="submit" size="sm" loading={act.pending} disabled={!title.trim()}>{t('saveLesson')}</Button><Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t('cancel')}</Button></div>
    </form>
  );
}

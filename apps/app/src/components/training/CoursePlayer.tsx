'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, cx } from '@bh/ui';
import type { IconName } from '@bh/icons';
import { ErrorNote, Panel, useNet, useNetAction } from '../community/net';
import { Attachments, type Attachment } from '../community/Announcements';
import { LoadingBlock } from '../ui/States';
import { useCertificateDownload, type CourseT } from './TrainingScreen';

interface Outline { id: string; title: string; lessons: { id: string; title: string; kind: string; minutes: number | null; completed: boolean; score: number | null }[] }
interface CourseDetail { course: CourseT & { canReview: boolean; trainers: { id: string; name: string }[] }; outline: Outline[]; enrolment: { id: string; status: string; progressPct: number; dueAt: string | null; completedAt: string | null; expiresAt: string | null } | null; missingPrerequisites: { id: string; title: string }[] }
interface LessonT { id: string; courseId: string; courseTitle: string; title: string; kind: string; body: string | null; videoUrl: string | null; attachments: Attachment[]; minutes: number | null; quiz: { id: string; prompt: string; options: string[]; multiple: boolean }[] | null; passMark: number | null; completed: boolean; score: number | null; attempts: { score: number; passed: boolean; at: string }[]; previousId: string | null; nextId: string | null; enrolment: { id: string; status: string; progressPct: number } | null }
interface QuizResult { score: number; passed: boolean; passMark: number; results: { questionId: string; correct: boolean; explanation: string | null }[]; enrolment: { status: string; progressPct: number }; certificate: { id: string; code: string } | null }

export const LESSON_ICON: Record<string, IconName> = { text: 'file', video: 'play', file: 'download', quiz: 'check-circle' };

export function CourseView({ id, onLesson, onBack, onEdit, onChanged }: { id: string; onLesson: (id: string) => void; onBack: () => void; onEdit: (id: string) => void; onChanged: () => void }) {
  const t = useTranslations('training.course');
  const locale = useLocale();
  const res = useNet<CourseDetail>(`/training/courses/${id}`, [id]);
  const act = useNetAction();
  const certs = useNet<{ certificates: { id: string; code: string; courseTitle: string }[] }>('/training/home');
  const download = useCertificateDownload();
  const d = res.data;
  const flat = d?.outline.flatMap((m) => m.lessons) ?? [];
  const next = flat.find((l) => !l.completed) ?? flat[0];
  const cert = certs.data?.certificates.find((c) => c.courseTitle === d?.course.title);
  return (
    <div className="flex flex-col gap-3">
      <Button size="sm" variant="ghost" icon="arrow-left" className="self-start" onClick={onBack}>{t('back')}</Button>
      <ErrorNote error={res.error ?? act.error} />
      {!d ? <LoadingBlock variant="detail" /> : (
        <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
          <Panel>
            <div className="flex flex-wrap gap-1.5">
              {d.course.category && <Badge tone="neutral">{d.course.category}</Badge>}
              {d.course.status !== 'published' && <Badge tone="warning">{t(`status.${d.course.status}`)}</Badge>}
              {d.course.visibility === 'public' && <Badge tone="info" icon="globe">{t('public')}</Badge>}
            </div>
            <h2 className="text-2xl font-bold">{d.course.title}</h2>
            {d.course.summary && <p className="text-sm text-stone">{d.course.summary}</p>}
            {d.course.trainers.length > 0 && <p className="text-[13px]">{t('trainers', { names: d.course.trainers.map((x) => x.name).join(', ') })}</p>}
            {d.missingPrerequisites.length > 0 && <p className="rounded-md bg-warning-bg px-3 py-2 text-[13px] font-semibold text-warning">{t('prerequisites', { courses: d.missingPrerequisites.map((m) => m.title).join(', ') })}</p>}
            <ol className="flex flex-col gap-3">
              {d.outline.map((m, mi) => (
                <li key={m.id} className="flex flex-col gap-1.5">
                  <h3 className="text-sm font-bold">{t('module', { n: mi + 1, title: m.title })}</h3>
                  <ul className="flex flex-col gap-1">
                    {m.lessons.map((l) => (
                      <li key={l.id}>
                        <button type="button" disabled={!d.enrolment && !d.course.canEdit} onClick={() => onLesson(l.id)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm hover:bg-canvas disabled:opacity-60">
                          <span className={cx('flex h-7 w-7 items-center justify-center rounded-full', l.completed ? 'bg-success-bg text-success' : 'bg-canvas')}><Icon name={l.completed ? 'check' : LESSON_ICON[l.kind] ?? 'file'} size={14} /></span>
                          <span className="flex-1">{l.title}</span>
                          {l.kind === 'quiz' && l.score !== null && <Badge tone="success">{t('score', { score: l.score })}</Badge>}
                          {l.minutes && <span className="text-xs text-stone">{t('minutes', { count: l.minutes })}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </Panel>
          <Panel>
            {d.enrolment ? (
              <>
                <p className="text-sm font-bold">{d.enrolment.status === 'completed' ? t('completedOn', { date: new Date(d.enrolment.completedAt!).toLocaleDateString(locale) }) : t('progress', { pct: d.enrolment.progressPct })}</p>
                <span className="h-2 overflow-hidden rounded-full bg-canvas"><span className="block h-full bg-ink" style={{ width: `${d.enrolment.progressPct}%` }} /></span>
                {d.enrolment.dueAt && d.enrolment.status === 'active' && <p className="text-[13px] text-stone">{t('due', { date: new Date(d.enrolment.dueAt).toLocaleDateString(locale) })}</p>}
                {d.enrolment.expiresAt && <p className="text-[13px] text-stone">{t('validUntil', { date: new Date(d.enrolment.expiresAt).toLocaleDateString(locale) })}</p>}
                {d.enrolment.status !== 'completed' && next && <Button icon="play" onClick={() => onLesson(next.id)}>{d.enrolment.progressPct ? t('continue') : t('begin')}</Button>}
                {d.enrolment.status === 'completed' && cert && <Button variant="signal" icon="download" onClick={() => download(cert.id, cert.code)}>{t('certificate')}</Button>}
              </>
            ) : (
              <Button icon="play" loading={act.pending} disabled={d.missingPrerequisites.length > 0} onClick={async () => {
                if (await act.run('post', `/training/courses/${d.course.id}/start`)) { void res.reload(); onChanged(); }
              }}>{t('start')}</Button>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
              <dt className="text-stone">{t('passMark')}</dt><dd className="font-semibold">{d.course.passMark}%</dd>
              {d.course.estimatedMinutes && <><dt className="text-stone">{t('length')}</dt><dd className="font-semibold">{t('minutes', { count: d.course.estimatedMinutes })}</dd></>}
              {d.course.validityMonths && <><dt className="text-stone">{t('recert')}</dt><dd className="font-semibold">{t('months', { count: d.course.validityMonths })}</dd></>}
            </dl>
            {d.course.canEdit && <Button variant="secondary" icon="edit" onClick={() => onEdit(d.course.id)}>{t('edit')}</Button>}
          </Panel>
        </div>
      )}
    </div>
  );
}

/** YouTube / Vimeo links become embeds; anything else opens in a new tab. */
function embedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com') && u.searchParams.get('v')) return `https://www.youtube-nocookie.com/embed/${u.searchParams.get('v')}`;
    if (u.hostname === 'youtu.be') return `https://www.youtube-nocookie.com/embed${u.pathname}`;
    if (u.hostname.includes('vimeo.com') && /^\/\d+/.test(u.pathname)) return `https://player.vimeo.com/video${u.pathname}`;
    if (u.hostname.includes('loom.com') && u.pathname.startsWith('/share/')) return url.replace('/share/', '/embed/');
  } catch { /* not a URL */ }
  return null;
}

export function LessonPlayer({ id, onOpen, onCourse }: { id: string; onOpen: (id: string) => void; onCourse: (courseId: string) => void }) {
  const t = useTranslations('training.lesson');
  const res = useNet<LessonT>(`/training/lessons/${id}`, [id]);
  const act = useNetAction();
  const download = useCertificateDownload();
  const [answers, setAnswers] = useState<Record<string, number[]>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const l = res.data;
  const embed = l?.videoUrl ? embedUrl(l.videoUrl) : null;
  const finished = l?.enrolment?.status === 'completed' || result?.enrolment.status === 'completed';
  return (
    <div className="flex flex-col gap-3">
      {l && <Button size="sm" variant="ghost" icon="arrow-left" className="self-start" onClick={() => onCourse(l.courseId)}>{l.courseTitle}</Button>}
      <ErrorNote error={res.error ?? act.error} />
      {!l ? <LoadingBlock variant="detail" /> : (
        <Panel>
          <div className="flex flex-wrap items-center gap-2"><Badge tone="neutral" icon={LESSON_ICON[l.kind] ?? 'file'}>{t(`kinds.${l.kind}`)}</Badge>{l.completed && <Badge tone="success">{t('done')}</Badge>}</div>
          <h2 className="text-xl font-bold">{l.title}</h2>
          {embed && <div className="aspect-video overflow-hidden rounded-lg bg-ink"><iframe src={embed} title={l.title} className="h-full w-full" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen /></div>}
          {l.videoUrl && !embed && <a href={l.videoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 self-start rounded-full bg-ink px-4 py-2 text-sm font-bold text-white"><Icon name="play" size={15} />{t('watch')}</a>}
          {l.body && <div className="whitespace-pre-line text-sm leading-relaxed">{l.body}</div>}
          <Attachments items={l.attachments} />

          {l.kind === 'quiz' && l.quiz && (
            <form className="flex flex-col gap-4" onSubmit={async (e) => {
              e.preventDefault();
              const r = await act.run<QuizResult>('post', `/training/lessons/${l.id}/quiz`, { answers });
              if (r) { setResult(r); if (r.passed) void res.reload(); }
            }}>
              <p className="text-[13px] text-stone">{t('passMark', { mark: l.passMark ?? 0 })}{l.attempts.length ? ` · ${t('attempts', { count: l.attempts.length })}` : ''}</p>
              {l.quiz.map((q, qi) => {
                const r = result?.results.find((x) => x.questionId === q.id);
                return (
                  <fieldset key={q.id} className={cx('flex flex-col gap-2 rounded-lg border-[1.5px] p-3', r ? (r.correct ? 'border-success' : 'border-danger') : 'border-line-soft')}>
                    <legend className="px-1 text-sm font-bold">{t('question', { n: qi + 1, prompt: q.prompt })}</legend>
                    {q.multiple && <p className="text-xs text-stone">{t('chooseAll')}</p>}
                    {q.options.map((o, oi) => (
                      <label key={oi} className="flex items-center gap-2.5 text-sm">
                        <input type={q.multiple ? 'checkbox' : 'radio'} name={q.id} className="size-5 accent-[var(--color-ink)]" checked={(answers[q.id] ?? []).includes(oi)} onChange={(e) => {
                          const cur = answers[q.id] ?? [];
                          setAnswers({ ...answers, [q.id]: q.multiple ? (e.target.checked ? [...cur, oi] : cur.filter((x) => x !== oi)) : [oi] });
                        }} />
                        {o}
                      </label>
                    ))}
                    {r && <p className={cx('text-[13px] font-semibold', r.correct ? 'text-success' : 'text-danger')}>{r.correct ? t('correct') : t('incorrect')}{r.explanation ? ` — ${r.explanation}` : ''}</p>}
                  </fieldset>
                );
              })}
              {result && <p role="status" className={cx('rounded-md px-3 py-2 text-sm font-bold', result.passed ? 'bg-success-bg text-success' : 'bg-warning-bg text-warning')}>{result.passed ? t('passed', { score: result.score }) : t('failed', { score: result.score, mark: result.passMark })}</p>}
              {!(result?.passed || l.completed) && <Button type="submit" className="self-start" loading={act.pending} disabled={l.quiz.some((q) => !(answers[q.id] ?? []).length)}>{t('submit')}</Button>}
            </form>
          )}

          {finished && (
            <div className="flex flex-col gap-2 rounded-lg bg-lime p-4">
              <p className="text-base font-extrabold">{t('courseComplete')}</p>
              {result?.certificate && <Button variant="primary" icon="download" className="self-start" onClick={() => download(result.certificate!.id, result.certificate!.code)}>{t('certificate')}</Button>}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
            {l.previousId && <Button variant="ghost" icon="arrow-left" onClick={() => { setResult(null); setAnswers({}); onOpen(l.previousId!); }}>{t('previous')}</Button>}
            {l.kind !== 'quiz' && !l.completed && l.enrolment?.status === 'active' && (
              <Button icon="check" loading={act.pending} onClick={async () => { if (await act.run('post', `/training/lessons/${l.id}/complete`)) { void res.reload(); if (l.nextId) onOpen(l.nextId); } }}>{l.nextId ? t('completeNext') : t('complete')}</Button>
            )}
            {l.nextId && (l.completed || l.kind === 'quiz') && <Button variant="secondary" iconRight="arrow-right" onClick={() => { setResult(null); setAnswers({}); onOpen(l.nextId!); }}>{t('next')}</Button>}
          </div>
        </Panel>
      )}
    </div>
  );
}

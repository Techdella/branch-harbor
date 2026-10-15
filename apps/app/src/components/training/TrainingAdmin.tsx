'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, cx } from '@bh/ui';
import { relativeTime } from '@/lib/format';
import { AudiencePicker, ErrorNote, Panel, useAudienceText, useNet, useNetAction, type Audience, type NetMe } from '../community/net';
import { LoadingBlock } from '../ui/States';
import type { TrainingHome } from './TrainingScreen';

interface Assignment { id: string; targetType: string; targetId: string; title: string; audience: Audience; dueAt: string | null; dueInDays: number | null; source: string; createdAt: string }
interface LocRow { locationId: string; locationName: string; people: number; assigned: number; completed: number; inProgress: number; overdue: number; expired: number; completionRate: number | null; averageScore: number | null }
interface PersonRow { userId: string; name: string; roles: string[]; courses: { courseId: string; title: string; status: string; progressPct: number; overdue: boolean; dueAt: string | null }[] }

export function AssignPanel({ me, home }: { me: NetMe; home: TrainingHome }) {
  const t = useTranslations('training.assign');
  const audienceText = useAudienceText(me.directory);
  const list = useNet<{ items: Assignment[] }>('/training/assignments');
  const paths = useNet<{ items: { id: string; title: string }[] }>('/training/paths');
  const act = useNetAction();
  const [target, setTarget] = useState('');
  const [audience, setAudience] = useState<Audience>({});
  const [days, setDays] = useState('14');
  const [done, setDone] = useState<string | null>(null);
  const courses = [...home.catalogue, ...home.enrolments.map((e) => ({ id: e.course.id, title: e.course.title }))].filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i);
  return (
    <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
      <Panel title={t('new')}>
        <form className="flex flex-col gap-3" onSubmit={async (e) => {
          e.preventDefault();
          const [targetType, targetId] = target.split(':');
          const r = await act.run<{ people: number; enrolled: number }>('post', '/training/assignments', { targetType, targetId, audience, dueInDays: days ? Number(days) : null });
          if (r) { setDone(t('assigned', { count: r.enrolled })); void list.reload(); }
        }}>
          <Field label={t('what')}>{(p) => (
            <Select id={p.id} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">{t('choose')}</option>
              <optgroup label={t('paths')}>{(paths.data?.items ?? []).map((x) => <option key={x.id} value={`path:${x.id}`}>{x.title}</option>)}</optgroup>
              <optgroup label={t('courses')}>{courses.map((x) => <option key={x.id} value={`course:${x.id}`}>{x.title}</option>)}</optgroup>
            </Select>
          )}</Field>
          <span className="text-[13px] font-bold">{t('who')}</span>
          <AudiencePicker value={audience} onChange={setAudience} directory={me.directory} allowEveryone={me.hq} />
          <Field label={t('dueInDays')} optional>{(p) => <Input id={p.id} type="number" min={1} max={730} value={days} onChange={(e) => setDays(e.target.value)} />}</Field>
          <ErrorNote error={act.error} />
          {done && <p role="status" className="rounded-md bg-success-bg px-3 py-2 text-[13px] font-semibold text-success">{done}</p>}
          <Button type="submit" className="self-start" disabled={!target} loading={act.pending}>{t('assign')}</Button>
        </form>
      </Panel>
      <Panel title={t('current')}>
        <ErrorNote error={list.error} />
        <ul className="flex flex-col divide-y divide-line-soft">
          {(list.data?.items ?? []).map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="font-semibold">{a.title}</span>
              <Badge tone="neutral">{t(`type.${a.targetType}`)}</Badge>
              {a.source === 'onboarding' && <Badge tone="info">{t('onboarding')}</Badge>}
              <span className="w-full text-xs text-stone">{audienceText(a.audience)}{a.dueInDays ? ` · ${t('dueAfter', { days: a.dueInDays })}` : ''}</span>
              <Button size="sm" variant="ghost" onClick={async () => { if (await act.run('del', `/training/assignments/${a.id}`)) void list.reload(); }}>{t('remove')}</Button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

export function ReportsPanel({ home }: { home: TrainingHome }) {
  const t = useTranslations('training.reports');
  const locale = useLocale();
  const [courseId, setCourseId] = useState('');
  const [locationId, setLocationId] = useState<string | null>(null);
  const rows = useNet<{ items: LocRow[] }>(`/training/reports/completion${courseId ? `?courseId=${courseId}` : ''}`, [courseId]);
  const people = useNet<{ items: PersonRow[] }>(locationId ? `/training/reports/people?locationId=${locationId}${courseId ? `&courseId=${courseId}` : ''}` : null, [locationId, courseId]);
  const courses = [...home.catalogue, ...home.authoring].filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i);
  void locale;
  return (
    <div className="flex flex-col gap-3">
      <Select aria-label={t('course')} value={courseId} onChange={(e) => setCourseId(e.target.value)} className="max-w-sm">
        <option value="">{t('allCourses')}</option>
        {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
      </Select>
      <ErrorNote error={rows.error} />
      {rows.loading && !rows.data ? <LoadingBlock variant="table" rows={3} /> : (
        <div className="overflow-x-auto rounded-xl bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-xs text-stone">{(['location', 'people', 'completion', 'completed', 'inProgress', 'overdue', 'expired', 'score'] as const).map((h) => <th key={h} className="px-4 py-3 font-bold">{t(`cols.${h}`)}</th>)}</tr></thead>
            <tbody>
              {(rows.data?.items ?? []).map((r) => (
                <tr key={r.locationId} className={cx('cursor-pointer border-t border-line-soft hover:bg-canvas', locationId === r.locationId && 'bg-canvas')} onClick={() => setLocationId(r.locationId)}>
                  <td className="px-4 py-2.5 font-semibold">{r.locationName}</td>
                  <td className="px-4 py-2.5">{r.people}</td>
                  <td className="px-4 py-2.5">{r.completionRate === null ? '—' : <span className="inline-flex items-center gap-2"><span className="h-2 w-16 overflow-hidden rounded-full bg-canvas"><span className="block h-full bg-ink" style={{ width: `${r.completionRate}%` }} /></span>{r.completionRate}%</span>}</td>
                  <td className="px-4 py-2.5">{r.completed}/{r.assigned}</td>
                  <td className="px-4 py-2.5">{r.inProgress}</td>
                  <td className={cx('px-4 py-2.5', r.overdue > 0 && 'font-bold text-danger')}>{r.overdue}</td>
                  <td className="px-4 py-2.5">{r.expired}</td>
                  <td className="px-4 py-2.5">{r.averageScore === null ? '—' : `${r.averageScore}%`}</td>
                </tr>
              ))}
              {!(rows.data?.items ?? []).length && <tr><td colSpan={8} className="px-4 py-6 text-stone">{t('empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {locationId && (
        <Panel title={t('people')}>
          <ErrorNote error={people.error} />
          <ul className="flex flex-col divide-y divide-line-soft">
            {(people.data?.items ?? []).map((p) => (
              <li key={p.userId} className="flex flex-col gap-1 py-2 text-sm">
                <span className="font-semibold">{p.name}</span>
                <span className="flex flex-wrap gap-1.5">{p.courses.map((c) => <Badge key={c.courseId} tone={c.status === 'completed' ? 'success' : c.overdue ? 'danger' : c.status === 'expired' ? 'warning' : 'neutral'}>{c.title} · {c.status === 'completed' ? t('done') : `${c.progressPct}%`}</Badge>)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

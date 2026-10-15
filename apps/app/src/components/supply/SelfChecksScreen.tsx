'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Input, Select, Textarea, Toggle, cx } from '@bh/ui';
import { SELF_CHECK_KINDS, scoreAudit, type AuditAnswer, type AuditQuestion, type SelfCheckScheduleBody } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { ActionError, PillTabs, Tiles, useQFmt } from '../quality/ui';
import { downloadFile, programmesApi, readUpload, useAction, useLoad, type RunDetailVM, type RunVM, type ScheduleTarget, type SelfScheduleVM } from './api';

type Tab = 'today' | 'results' | 'schedules';
const RUN_TONE = { due: 'info', in_progress: 'warning', completed: 'success', missed: 'danger' } as const;

export function RunBadge({ r }: { r: Pick<RunVM, 'status' | 'passed' | 'late'> }) {
  const t = useTranslations('auditsPlus');
  if (r.status === 'completed') return <Badge tone={r.passed ? 'success' : 'danger'}>{r.passed ? t('self.passed') : t('self.failed')}</Badge>;
  return <Badge tone={r.late && r.status !== 'missed' ? 'danger' : RUN_TONE[r.status]}>{r.late && r.status !== 'missed' ? t('self.late') : t(`runStatus.${r.status}`)}</Badge>;
}

/**
 * Operations → Self-checks: checklists a location runs itself (opening, closing, temperature logs). The team sees
 * today's checks; managers and HQ see completion and pass rates and failures, kept apart from HQ audits.
 */
export function SelfChecksScreen() {
  const t = useTranslations('auditsPlus');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'today';
  if (!app.hasModule('operations.self_checks')) return <DeniedState />;
  return (
    <>
      <PageHeader icon="list" title={t('self.title')} description={t('self.description')} scope={false} />
      <PillTabs items={[['today', t('self.tab.today')], ['results', t('self.tab.results')], ['schedules', t('self.tab.schedules')]]} value={tab} onChange={(k) => router.replace(`?tab=${k}`, { scroll: false })} />
      {tab === 'results' ? <Results /> : tab === 'schedules' ? <Schedules /> : <Today />}
    </>
  );
}

function Today() {
  const t = useTranslations('auditsPlus');
  const app = useApp();
  const locale = useLocale();
  const res = useLoad(() => programmesApi.today(), [app.org.id]);
  return (
    <Async res={res} loading={<LoadingBlock variant="cards" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="list" title={t('self.noneToday')} body={t('self.noneTodayBody')} />}>
      {(d) => (
        <ul className="grid gap-2 md:grid-cols-2" data-testid="self-today">
          {d.items.map((r) => (
            <li key={r.id}>
              <Link href={`/self-checks/${r.id}`} className={cx('flex items-center gap-3 rounded-xl bg-surface p-4 hover:bg-line-soft', r.late && r.status !== 'completed' && 'border-[1.5px] border-danger')}>
                <span className="min-w-0 flex-1">
                  <strong className="block text-[15px]">{r.scheduleName}</strong>
                  <span className="text-[13px] text-stone">{r.locationName} · {r.date === d.today ? t('self.dueAt', { time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(r.dueAt)) }) : t('self.yesterday')}</span>
                  {r.status !== 'completed' && <span className="block text-xs text-stone">{t('self.progress', { done: r.answered, total: r.questionCount })}</span>}
                  {r.completedBy?.name && <span className="block text-xs text-stone">{t('self.doneBy', { name: r.completedBy.name })}</span>}
                </span>
                <RunBadge r={r} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Async>
  );
}

function Results() {
  const t = useTranslations('auditsPlus');
  const app = useApp();
  const f = useQFmt();
  const [days, setDays] = useState(14);
  const res = useLoad(() => programmesApi.selfDashboard(days), [app.org.id, days]);
  return (
    <Async res={res} loading={<LoadingBlock variant="cards" />}>
      {(d) => (
        <div className="flex flex-col gap-3" data-testid="self-results">
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label={t('trends.period')} className="w-40" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 14, 30].map((n) => <option key={n} value={n}>{t('self.lastDays', { count: n })}</option>)}</Select>
            <span className="flex-1" />
            {d.can.export && <Button variant="ghost" size="sm" icon="download" onClick={() => void downloadFile('/self-checks/export', 'self-checks.csv', { from: d.since })}>{t('common.exportCsv')}</Button>}
          </div>
          <Tiles items={[
            { label: t('self.completion'), value: f.pct(d.totals.completionPct), sub: t('self.completedOf', { completed: d.totals.completed, runs: d.totals.runs }) },
            { label: t('self.passRate'), value: f.pct(d.totals.passPct) },
            { label: t('self.missed'), value: f.num(d.totals.missed), tone: d.totals.missed ? 'danger' : undefined },
            { label: t('self.failedTile'), value: f.num(d.totals.failed), tone: d.totals.failed ? 'danger' : undefined },
          ]} />
          <SectionCard title={t('self.byDay')}>
            <div className="flex h-24 items-end gap-1" role="img" aria-label={t('self.byDay')}>
              {d.byDay.map((x) => {
                const total = x.completed + x.missed + x.open || 1;
                return (
                  <span key={x.date} className="flex flex-1 flex-col-reverse overflow-hidden rounded-sm" style={{ height: '100%' }} title={`${f.shortDate(x.date)}: ${x.completed} / ${x.missed} / ${x.failed}`}>
                    <span className="bg-ink" style={{ height: `${((x.completed - x.failed) / total) * 100}%` }} />
                    <span className="bg-warning" style={{ height: `${(x.failed / total) * 100}%` }} />
                    <span className="bg-danger" style={{ height: `${(x.missed / total) * 100}%` }} />
                    <span className="bg-line-soft" style={{ height: `${(x.open / total) * 100}%` }} />
                  </span>
                );
              })}
            </div>
            <span className="flex flex-wrap gap-3 text-xs text-stone"><span>■ {t('self.legend.passed')}</span><span className="text-warning">■ {t('self.legend.failed')}</span><span className="text-danger">■ {t('self.legend.missed')}</span></span>
          </SectionCard>
          <div className="grid gap-3 lg:grid-cols-2">
            <SectionCard title={t('self.byLocation')}>
              {d.locations.length ? (
                <DataTable rows={d.locations} rowKey={(l) => l.locationId} rowLabel={(l) => l.name} columns={[
                  { key: 'n', header: t('self.location'), render: (l) => <strong>{l.name}</strong> },
                  { key: 'c', header: t('self.completion'), render: (l) => f.pct(l.completionPct) },
                  { key: 'p', header: t('self.passRate'), render: (l) => f.pct(l.passPct) },
                  { key: 'm', header: t('self.missed'), render: (l) => (l.missed ? <Badge tone="danger">{l.missed}</Badge> : '0') },
                  { key: 'x', header: t('self.critical'), render: (l) => (l.criticalFails ? <Badge tone="danger" icon="alert">{l.criticalFails}</Badge> : '0') },
                ]} />
              ) : <p className="text-sm text-stone">{t('self.noResults')}</p>}
            </SectionCard>
            <SectionCard title={t('self.failures')}>
              {d.failures.length ? (
                <ul className="flex flex-col gap-1.5">
                  {d.failures.map((r) => (
                    <li key={r.id}><Link href={`/self-checks/${r.id}`} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised px-3 py-2 text-[13px] hover:bg-line-soft">
                      <span className="min-w-0 flex-1"><strong>{r.locationName}</strong> · {r.scheduleName}<span className="block text-xs text-stone">{r.failedItems.map((x) => x.text).join(' · ')}</span></span>
                      {r.criticalFailed && <Badge tone="danger" icon="alert">{t('self.critical')}</Badge>}
                      <span className="text-xs text-stone">{f.shortDate(r.date)}</span>
                    </Link></li>
                  ))}
                </ul>
              ) : <p className="text-sm text-stone">{t('self.noFailures')}</p>}
            </SectionCard>
          </div>
        </div>
      )}
    </Async>
  );
}

function Schedules() {
  const t = useTranslations('auditsPlus');
  const app = useApp();
  const res = useLoad(() => programmesApi.selfSchedules(), [app.org.id]);
  const [editing, setEditing] = useState<SelfScheduleVM | 'new' | null>(null);
  return (
    <>
      {res.data?.can.manage && <Button icon="plus" className="self-start" onClick={() => setEditing('new')}>{t('self.addSchedule')}</Button>}
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="list" title={t('self.noSchedules')} />}>
        {(d) => (
          <section className="rounded-xl bg-surface p-3.5">
            <DataTable<SelfScheduleVM> rows={d.items} rowKey={(x) => x.id} rowLabel={(x) => x.name} onRowClick={d.can.manage ? (x) => setEditing(x) : undefined} columns={[
              { key: 'n', header: t('schedules.name'), render: (x) => <span><strong>{x.name}</strong><span className="block text-xs text-stone">{x.templateName} · {t(`kind.${x.kind}`)}</span></span> },
              { key: 'w', header: t('self.when'), render: (x) => t('self.whenText', { days: x.weekdays.length === 7 ? t('self.daily') : x.weekdays.map((w) => t(`weekday.${w}`)).join(', '), time: x.dueTime }) },
              { key: 'l', header: t('schedules.where'), render: (x) => t('schedules.locations', { count: x.locationCount }) },
              { key: 'a', header: '', render: (x) => (!x.active ? <Badge tone="neutral">{t('schedules.paused')}</Badge> : null) },
            ]} />
          </section>
        )}
      </Async>
      {editing && <SelfScheduleDrawer x={editing === 'new' ? null : editing} manageAll={!!res.data?.can.manageAll} onClose={() => setEditing(null)} onDone={() => { setEditing(null); res.reload(); }} />}
    </>
  );
}

function SelfScheduleDrawer({ x, manageAll, onClose, onDone }: { x: SelfScheduleVM | null; manageAll: boolean; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('auditsPlus');
  const app = useApp();
  const act = useAction();
  const templates = useLoad(() => programmesApi.selfTemplates(), [app.org.id]);
  const starters = useLoad(() => programmesApi.selfStarters(), [app.org.id]);
  const [v, setV] = useState<SelfCheckScheduleBody>(x ?? { name: '', templateId: '', kind: 'opening', target: manageAll ? { kind: 'all', ids: [] } : { kind: 'locations', ids: app.locations.map((l) => l.id) }, weekdays: [0, 1, 2, 3, 4, 5, 6], dueTime: '09:00', remindMinutesBefore: 30, active: true });
  const setTarget = (target: ScheduleTarget) => setV({ ...v, target });
  const unused = (starters.data?.items ?? []).filter((s) => !(templates.data?.items ?? []).some((tp) => tp.starterKey === s.key));
  return (
    <Drawer open onClose={onClose} title={x ? x.name : t('self.addSchedule')} footer={
      <div className="flex gap-2">
        {x && <Button variant="ghost" icon="x" loading={act.pending} onClick={async () => { if (await act.run(() => programmesApi.deleteSelfSchedule(x.id))) onDone(); }}>{t('schedules.delete')}</Button>}
        <Button icon="check" disabled={!v.name || !v.templateId || (v.target.kind !== 'all' && !v.target.ids.length)} loading={act.pending} onClick={async () => { if (await act.run(() => (x ? programmesApi.saveSelfSchedule(x.id, v) : programmesApi.createSelfSchedule(v)))) onDone(); }}>{t('schedules.save')}</Button>
      </div>
    }>
      <div className="flex flex-col gap-3">
        <ActionError error={act.error} />
        <Field label={t('schedules.name')}>{(fx) => <Input id={fx.id} value={v.name} maxLength={160} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label={t('schedules.checklist')}>{(fx) => <Select id={fx.id} value={v.templateId} onChange={(e) => setV({ ...v, templateId: e.target.value })}><option value="">{t('common.choose')}</option>{(templates.data?.items ?? []).map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}</Select>}</Field>
        {manageAll && !!unused.length && (
          <div className="flex flex-wrap gap-1.5">
            {unused.map((s) => <Button key={s.key} size="sm" variant="ghost" icon="plus" onClick={async () => { const r = await act.run(() => programmesApi.selfTemplateFromStarter(s.key)); if (r) { templates.reload(); setV({ ...v, templateId: r.id, name: v.name || s.name, kind: s.kind as SelfCheckScheduleBody['kind'], dueTime: s.dueTime }); } }}>{t('self.fromStarter', { name: s.name })}</Button>)}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('self.kind')}>{(fx) => <Select id={fx.id} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as SelfCheckScheduleBody['kind'] })}>{SELF_CHECK_KINDS.map((k) => <option key={k} value={k}>{t(`kind.${k}`)}</option>)}</Select>}</Field>
          <Field label={t('self.dueTime')}>{(fx) => <Input id={fx.id} type="time" value={v.dueTime} onChange={(e) => setV({ ...v, dueTime: e.target.value })} />}</Field>
        </div>
        <fieldset className="flex flex-col gap-1.5"><legend className="text-[13px] font-bold">{t('self.days')}</legend>
          <span className="flex flex-wrap gap-1.5">{[1, 2, 3, 4, 5, 6, 0].map((w) => { const on = v.weekdays.includes(w); return <button key={w} type="button" aria-pressed={on} onClick={() => setV({ ...v, weekdays: on ? v.weekdays.filter((x2) => x2 !== w) : [...v.weekdays, w] })} className={cx('h-9 w-12 rounded-full text-[13px] font-bold', on ? 'bg-ink text-white' : 'bg-canvas-raised')}>{t(`weekday.${w}`)}</button>; })}</span>
        </fieldset>
        <Field label={t('schedules.where')}>{(fx) => (
          <Select id={fx.id} value={v.target.kind} onChange={(e) => setTarget({ kind: e.target.value as ScheduleTarget['kind'], ids: e.target.value === 'locations' ? app.locations.map((l) => l.id) : [] })}>
            {manageAll && <option value="all">{t('target.all')}</option>}<option value="locations">{t('target.locations')}</option>
          </Select>
        )}</Field>
        {v.target.kind === 'locations' && (
          <ul className="flex flex-wrap gap-1.5">
            {app.locations.map((l) => { const on = v.target.ids.includes(l.id); return <li key={l.id}><button type="button" aria-pressed={on} onClick={() => setTarget({ kind: 'locations', ids: on ? v.target.ids.filter((i) => i !== l.id) : [...v.target.ids, l.id] })} className={cx('rounded-full px-3 py-1.5 text-[13px] font-bold', on ? 'bg-ink text-white' : 'bg-canvas-raised')}>{l.name}</button></li>; })}
          </ul>
        )}
        <Field label={t('self.remind')}>{(fx) => <Input id={fx.id} type="number" min={0} max={720} value={v.remindMinutesBefore} onChange={(e) => setV({ ...v, remindMinutesBefore: Math.max(0, Math.min(720, Number(e.target.value) || 0)) })} />}</Field>
        <label className="flex items-center gap-2 text-[13px] font-bold"><Toggle checked={v.active} label={t('schedules.active')} onChange={(a) => setV({ ...v, active: a })} />{t('schedules.active')}</label>
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* One run (phone-friendly)                                            */
/* ------------------------------------------------------------------ */

export function SelfCheckRunScreen({ id }: { id: string }) {
  const app = useApp();
  const res = useLoad(() => programmesApi.run(id), [app.org.id, id]);
  if (!app.hasModule('operations.self_checks')) return <DeniedState />;
  return <Async res={res} loading={<LoadingBlock variant="detail" />}>{(r) => <Run r={r} reload={res.reload} />}</Async>;
}

function Run({ r, reload }: { r: RunDetailVM; reload: () => void }) {
  const t = useTranslations('auditsPlus');
  const f = useQFmt();
  const act = useAction();
  const [answers, setAnswers] = useState<Record<string, AuditAnswer>>(r.answers);
  const [note, setNote] = useState(r.note ?? '');
  const dirty = useRef<Record<string, AuditAnswer>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editable = r.canFill && r.status !== 'completed';
  const flush = async () => {
    const batch = dirty.current;
    dirty.current = {};
    if (Object.keys(batch).length) await programmesApi.saveRun(r.id, batch).catch(() => { dirty.current = { ...batch, ...dirty.current }; });
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const set = (qid: string, a: AuditAnswer) => {
    setAnswers((x) => ({ ...x, [qid]: a }));
    dirty.current[qid] = a;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 800);
  };
  const live = scoreAudit(r.checklist, answers);
  const total = r.checklist.sections.reduce((n, s) => n + s.questions.length, 0);
  const done = total - live.unanswered.length;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3" data-testid="self-run">
      <Link href="/self-checks" className="self-start text-[13px] font-bold underline">{t('self.back')}</Link>
      <section className="flex flex-col gap-1 rounded-xl bg-surface p-4">
        <span className="text-xs font-bold uppercase text-stone">{r.locationName} · {f.date(r.date)}</span>
        <h1 className="text-[20px] font-extrabold">{r.scheduleName}</h1>
        <span className="flex flex-wrap items-center gap-2"><RunBadge r={r} />{editable && <span className="text-[13px] text-stone">{t('self.progress', { done, total })}</span>}{r.status === 'completed' && r.completedBy?.name && <span className="text-[13px] text-stone">{t('self.doneBy', { name: r.completedBy.name })}</span>}</span>
        {editable && <span className="mt-1 flex h-2 overflow-hidden rounded-full bg-line-soft"><span className="bg-ink" style={{ width: `${(done / Math.max(1, total)) * 100}%` }} /></span>}
      </section>
      {r.status === 'completed' && !r.passed && <Banner tone="danger" title={t('self.failedTitle')}>{r.failedItems.map((x) => x.text).join(' · ')}</Banner>}
      {r.status === 'missed' && <Banner tone="warning">{t('self.missedBanner')}</Banner>}
      {live.criticalFailed && editable && <Banner tone="danger">{t('self.criticalLive')}</Banner>}
      {r.checklist.sections.map((s) => (
        <SectionCard key={s.id} title={s.title}>
          <ul className="flex flex-col gap-2">
            {s.questions.map((q) => <RunQuestion key={q.id} q={q} a={answers[q.id]} editable={editable} runId={r.id} failed={live.failedItems.some((x) => x.questionId === q.id)} onChange={(a) => set(q.id, a)} />)}
          </ul>
        </SectionCard>
      ))}
      {editable && (
        <section className="flex flex-col gap-2 rounded-xl bg-surface p-4">
          <ActionError error={act.error} />
          <Field label={t('self.note')} optional>{(x) => <Textarea id={x.id} className="min-h-14" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />}</Field>
          <Button size="lg" icon="check" disabled={!!live.unanswered.length} loading={act.pending} onClick={async () => { if (timer.current) clearTimeout(timer.current); dirty.current = {}; if (await act.run(() => programmesApi.completeRun(r.id, answers, note || undefined))) reload(); }}>{t('self.complete')}</Button>
          {!!live.unanswered.length && <p className="text-xs text-stone">{t('self.answerAll')}</p>}
        </section>
      )}
      {r.status === 'completed' && r.note && <SectionCard title={t('self.note')}><p className="text-[13px]">{r.note}</p></SectionCard>}
    </div>
  );
}

function RunQuestion({ q, a, editable, runId, failed, onChange }: { q: AuditQuestion; a: AuditAnswer | undefined; editable: boolean; runId: string; failed: boolean; onChange: (a: AuditAnswer) => void }) {
  const t = useTranslations('auditsPlus');
  const act = useAction();
  const big = 'h-12 min-w-16 rounded-full px-5 text-[15px] font-extrabold';
  return (
    <li className={cx('flex flex-col gap-2 rounded-lg border-[1.5px] p-3', failed ? 'border-danger bg-danger-bg/30' : 'border-line-soft')}>
      <span className="text-[14px] font-bold">{q.text}{q.critical && <Badge tone="danger" icon="alert" className="ml-2">{t('self.critical')}</Badge>}</span>
      {q.guidance && <span className="text-xs text-stone">{q.guidance}</span>}
      {q.type === 'yes_no' && (
        <span className="flex gap-2">
          {(['yes', 'no'] as const).map((v) => <button key={v} type="button" disabled={!editable} aria-pressed={a?.value === v} onClick={() => onChange({ ...a, value: v, na: false })} className={cx(big, a?.value === v ? (v === 'yes' ? 'bg-success text-white' : 'bg-danger text-white') : 'bg-canvas-raised')}>{t(`answer.${v}`)}</button>)}
          <button type="button" disabled={!editable} aria-pressed={!!a?.na} onClick={() => onChange({ ...a, na: true, value: null })} className={cx(big, a?.na ? 'bg-ink text-white' : 'bg-canvas-raised')}>{t('answer.na')}</button>
        </span>
      )}
      {q.type === 'number' && (
        <span className="flex items-center gap-2">
          <Input aria-label={q.text} type="number" inputMode="decimal" step="0.1" disabled={!editable} className="h-12 w-28 text-[18px] font-extrabold" value={typeof a?.value === 'number' ? a.value : ''} onChange={(e) => onChange({ ...a, value: e.target.value === '' ? null : Number(e.target.value), na: false })} />
          {q.unit && <span className="text-[15px] font-bold">{q.unit}</span>}
          <span className="text-xs text-stone">{q.min !== undefined && q.max !== undefined ? t('answer.range', { min: q.min, max: q.max }) : q.max !== undefined ? t('answer.max', { max: q.max }) : q.min !== undefined ? t('answer.min', { min: q.min }) : ''}</span>
        </span>
      )}
      {q.type === 'scale' && (
        <span className="flex gap-1.5">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" disabled={!editable} aria-pressed={a?.value === n} onClick={() => onChange({ ...a, value: n, na: false })} className={cx('h-12 w-12 rounded-full text-[15px] font-extrabold', a?.value === n ? 'bg-ink text-white' : 'bg-canvas-raised')}>{n}</button>)}</span>
      )}
      {q.type === 'text' && <Textarea aria-label={q.text} disabled={!editable} value={typeof a?.value === 'string' ? a.value : ''} onChange={(e) => onChange({ ...a, value: e.target.value })} />}
      {(q.type === 'photo' || q.photoRequired) && editable && (
        <label className="inline-flex h-10 cursor-pointer items-center gap-2 self-start rounded-full bg-canvas-raised px-4 text-[13px] font-bold">
          {t('answer.photo', { count: a?.photoIds?.length ?? 0 })}
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            const up = await act.run(async () => programmesApi.runPhoto(runId, await readUpload(file, { shrinkImages: true })));
            if (up) onChange({ ...a, photoIds: [...(a?.photoIds ?? []), up.id] });
          }} />
        </label>
      )}
      <ActionError error={act.error} />
      {editable && (failed || a?.note) && <Input aria-label={t('answer.note')} placeholder={t('answer.notePlaceholder')} value={a?.note ?? ''} maxLength={2000} onChange={(e) => onChange({ ...a, note: e.target.value })} />}
      {!editable && a?.note && <span className="text-[13px] text-stone">{a.note}</span>}
    </li>
  );
}

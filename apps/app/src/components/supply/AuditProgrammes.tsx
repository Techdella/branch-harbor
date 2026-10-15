'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Input, Select, Toggle, cx } from '@bh/ui';
import { AUDIT_FREQUENCIES, type AuditQuestion, type AuditScheduleBody } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { Async, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { ActionError, PillTabs, Tiles, Trend, useQFmt } from '../quality/ui';
import { qualityApi, type ActionVM, type AuditDetailVM } from '../quality/api';
import { programmesApi, useAction, useLoad, type ScheduleVM, type ScheduleTarget, type VisitStop } from './api';

/* ------------------------------------------------------------------ */
/* Trends                                                              */
/* ------------------------------------------------------------------ */

/** Score trends per location, region and checklist section, and the items that fail most across the network. */
export function AuditTrends() {
  const t = useTranslations('auditsPlus');
  const app = useApp();
  const f = useQFmt();
  const [months, setMonths] = useState(6);
  const [view, setView] = useState<'locations' | 'regions' | 'sections'>('sections');
  const res = useLoad(() => programmesApi.trends({ months }), [app.org.id, months]);
  return (
    <Async res={res} loading={<LoadingBlock variant="cards" />}>
      {(d) => {
        const labels = d.months.map(f.month);
        const rows = view === 'locations' ? d.locations.map((l) => ({ key: l.locationId, name: l.name, byMonth: l.byMonth, avg: l.averageScorePct, n: l.audits, change: l.change }))
          : view === 'regions' ? d.regions.map((r) => ({ key: r.regionId, name: r.name, byMonth: r.byMonth, avg: r.averageScorePct, n: r.audits, change: null as number | null }))
            : d.sections.map((s) => ({ key: s.title, name: s.title, byMonth: s.byMonth, avg: s.averageScorePct, n: s.audits, change: null as number | null }));
        return (
          <div className="flex flex-col gap-3" data-testid="audit-trends">
            <div className="flex flex-wrap items-center gap-2">
              <PillTabs items={[['sections', t('trends.bySection')], ['locations', t('trends.byLocation')], ['regions', t('trends.byRegion')]]} value={view} onChange={setView} />
              <span className="flex-1" />
              <Select aria-label={t('trends.period')} className="w-40" value={months} onChange={(e) => setMonths(Number(e.target.value))}>{[3, 6, 12].map((m) => <option key={m} value={m}>{t('trends.months', { count: m })}</option>)}</Select>
            </div>
            <Tiles items={[
              { label: t('trends.average'), value: f.pct(d.totals.averageScorePct), sub: t('trends.audits', { count: d.totals.audits }) },
              { label: t('trends.passRate'), value: f.pct(d.totals.passRatePct) },
              { label: t('trends.network'), value: <Trend values={d.network.map((n) => n.averageScorePct)} labels={labels} /> },
            ]} />
            <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <SectionCard title={t(`trends.title.${view}`)}>
                {rows.length ? (
                  <ul className="flex flex-col gap-2">
                    {rows.map((r) => (
                      <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-[13px]">
                        <span className="min-w-0"><strong className="block truncate">{r.name}</strong><span className="text-xs text-stone">{t('trends.audits', { count: r.n })}{r.change !== null ? ` · ${r.change >= 0 ? '+' : ''}${f.num(r.change, 1)}` : ''}</span></span>
                        <TrendBars values={r.byMonth} labels={labels} />
                        <Badge tone={r.avg === null ? 'neutral' : r.avg >= 85 ? 'success' : r.avg >= 70 ? 'warning' : 'danger'}>{f.pct(r.avg)}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : <Empty icon="chart" title={t('trends.empty')} />}
              </SectionCard>
              <SectionCard title={t('trends.mostFailed')}>
                {d.mostFailed.length ? (
                  <ol className="flex flex-col gap-1.5">
                    {d.mostFailed.map((m, i) => (
                      <li key={`${m.questionId}-${i}`} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised px-3 py-2 text-[13px]">
                        <span className="w-5 font-extrabold text-stone">{i + 1}</span>
                        <span className="min-w-0 flex-1"><strong>{m.title}</strong><span className="block text-xs text-stone">{m.sectionTitle} · {t('trends.failRate', { fails: m.fails, asked: m.asked, pct: f.pct(m.failRatePct) })} · {t('trends.locations', { count: m.locations })}</span></span>
                        {m.critical && <Badge tone="danger" icon="alert">{t('trends.critical')}</Badge>}
                        {m.trainingCourseId && <Badge tone="info" icon="book">{t('trends.retraining')}</Badge>}
                      </li>
                    ))}
                  </ol>
                ) : <p className="text-sm text-stone">{t('trends.noFails')}</p>}
              </SectionCard>
            </div>
          </div>
        );
      }}
    </Async>
  );
}

/** Wider month bars with the score inside the tooltip; empty months show a gap. */
function TrendBars({ values, labels }: { values: Array<number | null>; labels: string[] }) {
  return (
    <span className="inline-flex h-9 items-end gap-1" role="img" aria-label={values.map((v, i) => `${labels[i]}: ${v ?? '—'}`).join(', ')}>
      {values.map((v, i) => <span key={i} title={`${labels[i]}: ${v ?? '—'}`} className={cx('w-3 rounded-sm', v === null ? 'bg-line-soft' : v < 70 ? 'bg-danger' : v < 85 ? 'bg-warning' : 'bg-ink')} style={{ height: v === null ? 4 : Math.max(4, Math.round((v / 100) * 36)) }} />)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Visit planner                                                       */
/* ------------------------------------------------------------------ */

/** A consultant's upcoming visits per day, in nearest-neighbour route order from a start point. */
export function VisitPlanner() {
  const t = useTranslations('auditsPlus');
  const app = useApp();
  const f = useQFmt();
  const [who, setWho] = useState('');
  const [start, setStart] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const res = useLoad(() => programmesApi.visits({ ...(who ? { auditorUserId: who } : {}), ...(start ? start : {}) }), [app.org.id, who, start?.lat, start?.lng]);
  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition((p) => { setStart({ lat: p.coords.latitude, lng: p.coords.longitude }); setLocating(false); }, () => setLocating(false), { timeout: 8000 });
  };
  const mapsUrl = (stops: VisitStop[]) => {
    const pts = stops.filter((s) => s.geo).map((s) => `${s.geo!.lat},${s.geo!.lng}`);
    return pts.length ? `https://www.google.com/maps/dir/${[...(start ? [`${start.lat},${start.lng}`] : []), ...pts].join('/')}` : null;
  };
  return (
    <Async res={res} loading={<LoadingBlock variant="calendar" />}>
      {(d) => (
        <div className="flex flex-col gap-3" data-testid="visit-planner">
          <div className="flex flex-wrap items-center gap-2">
            {d.auditors && (
              <Select aria-label={t('visits.consultant')} className="w-56" value={who || d.auditorUserId} onChange={(e) => setWho(e.target.value)}>
                {!d.auditors.some((a) => a.id === d.auditorUserId) && <option value={d.auditorUserId}>{t('visits.me')}</option>}
                {d.auditors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            )}
            <Button variant="secondary" size="sm" icon="pin" loading={locating} onClick={useMyLocation}>{start ? t('visits.fromHere') : t('visits.useLocation')}</Button>
            <span className="flex-1" />
            <span className="text-[13px] text-stone">{t('visits.summary', { visits: d.visits, from: f.shortDate(d.from), to: f.shortDate(d.to) })}</span>
          </div>
          <p className="text-xs text-stone">{t('visits.how')}</p>
          {!!d.overdue.length && <DayCard title={t('visits.overdue')} tone="danger" stops={d.overdue} km={d.overdueKm} maps={mapsUrl(d.overdue)} />}
          {d.days.map((day) => <DayCard key={day.date} title={f.date(day.date)} stops={day.stops} km={day.totalKm} maps={mapsUrl(day.stops)} />)}
          {!d.days.length && !d.overdue.length && <Empty icon="calendar" title={t('visits.empty')} body={t('visits.emptyBody')} />}
          {d.withoutLocation > 0 && <p className="text-xs text-stone">{t('visits.noGeo', { count: d.withoutLocation })}</p>}
        </div>
      )}
    </Async>
  );
}

function DayCard({ title, stops, km, maps, tone }: { title: string; stops: VisitStop[]; km: number; maps: string | null; tone?: 'danger' }) {
  const t = useTranslations('auditsPlus');
  const f = useQFmt();
  return (
    <SectionCard title={<span className={cx(tone === 'danger' && 'text-danger')}>{title}</span>} aside={<span className="flex items-center gap-2 text-[13px]"><Badge tone="neutral" icon="map">{t('visits.km', { km: f.num(km, 1) })}</Badge>{maps && <a href={maps} target="_blank" rel="noreferrer" className="font-bold underline">{t('visits.openMap')}</a>}</span>}>
      <ol className="flex flex-col gap-1.5">
        {stops.map((s) => (
          <li key={s.auditId}>
            <Link href={`/audits/${s.auditId}`} className="flex flex-wrap items-center gap-3 rounded-md bg-canvas-raised px-3 py-2 text-[13px] hover:bg-line-soft">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-[12px] font-extrabold text-white">{s.order}</span>
              <span className="min-w-0 flex-1"><strong>{s.locationName}</strong> · {s.name}<span className="block text-xs text-stone">{[s.address?.line1, s.address?.city].filter(Boolean).join(', ')}</span></span>
              {s.overdue && <Badge tone="danger">{t('visits.due', { date: f.shortDate(s.dueDate) })}</Badge>}
              {s.legKm !== null && <span className="text-xs text-stone">{t('visits.leg', { km: f.num(s.legKm, 1) })}</span>}
              {s.status === 'in_progress' && <Badge tone="warning">{t('visits.inProgress')}</Badge>}
            </Link>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Recurring schedules                                                 */
/* ------------------------------------------------------------------ */

export function AuditSchedules() {
  const t = useTranslations('auditsPlus');
  const app = useApp();
  const f = useQFmt();
  const res = useLoad(() => programmesApi.schedules(), [app.org.id]);
  const [editing, setEditing] = useState<ScheduleVM | 'new' | null>(null);
  const act = useAction();
  const [ran, setRan] = useState<string | null>(null);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-[13px] text-stone">{t('schedules.hint')}</p>
        <Button icon="plus" onClick={() => setEditing('new')}>{t('schedules.add')}</Button>
      </div>
      <ActionError error={act.error} />
      {ran && <p className="text-[13px] font-bold text-success" role="status">{ran}</p>}
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="repeat" title={t('schedules.empty')} body={t('schedules.emptyBody')} />}>
        {(d) => (
          <section className="rounded-xl bg-surface p-3.5" data-testid="audit-schedules">
            <DataTable<ScheduleVM> rows={d.items} rowKey={(x) => x.id} rowLabel={(x) => x.name} onRowClick={(x) => setEditing(x)} columns={[
              { key: 'n', header: t('schedules.name'), render: (x) => <span><strong>{x.name}</strong><span className="block text-xs text-stone">{x.templateName}</span></span> },
              { key: 'f', header: t('schedules.every'), render: (x) => t(`schedules.freq.${x.frequency}`, { n: x.interval }) },
              { key: 'l', header: t('schedules.where'), render: (x) => t('schedules.locations', { count: x.locationCount }) },
              { key: 'a', header: t('schedules.auditor'), render: (x) => (x.auditorRule === 'field_consultant' ? t('schedules.consultant') : x.auditor?.name ?? '—') },
              { key: 'd', header: t('schedules.nextDue'), render: (x) => (x.active ? f.date(x.nextDue) : <Badge tone="neutral">{t('schedules.paused')}</Badge>) },
              { key: 'r', header: '', render: (x) => <Button size="sm" variant="ghost" icon="refresh" loading={act.pending} onClick={async (e) => { e.stopPropagation(); const r = await act.run(() => programmesApi.runSchedule(x.id)); if (r) setRan(t('schedules.ran', { count: r.created })); }}>{t('schedules.runNow')}</Button> },
            ]} />
          </section>
        )}
      </Async>
      {editing && <ScheduleDrawer x={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); res.reload(); }} />}
    </>
  );
}

function ScheduleDrawer({ x, onClose, onDone }: { x: ScheduleVM | null; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('auditsPlus');
  const app = useApp();
  const act = useAction();
  const templates = useLoad(() => qualityApi.templates(), [app.org.id]);
  const regions = useLoad(() => qualityApi.regions(), [app.org.id]);
  const [v, setV] = useState<AuditScheduleBody>(x ?? { name: '', templateId: '', target: { kind: 'all', ids: [] }, frequency: 'monthly', interval: 1, anchorDate: new Date().toISOString().slice(0, 10), leadDays: 14, auditorRule: 'field_consultant', auditorUserId: null, active: true });
  const preview = useLoad(() => (x ? programmesApi.preview(x.id) : Promise.resolve(null)), [app.org.id, x?.id]);
  const setTarget = (target: ScheduleTarget) => setV({ ...v, target });
  return (
    <Drawer open onClose={onClose} title={x ? x.name : t('schedules.add')} footer={
      <div className="flex gap-2">
        {x && <Button variant="ghost" icon="x" loading={act.pending} onClick={async () => { if (await act.run(() => programmesApi.deleteSchedule(x.id))) onDone(); }}>{t('schedules.delete')}</Button>}
        <Button icon="check" disabled={!v.name || !v.templateId || (v.target.kind !== 'all' && !v.target.ids.length)} loading={act.pending} onClick={async () => { if (await act.run(() => (x ? programmesApi.saveSchedule(x.id, v) : programmesApi.createSchedule(v)))) onDone(); }}>{t('schedules.save')}</Button>
      </div>
    }>
      <div className="flex flex-col gap-3">
        <ActionError error={act.error} />
        <Field label={t('schedules.name')}>{(fx) => <Input id={fx.id} value={v.name} maxLength={160} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label={t('schedules.checklist')}>{(fx) => <Select id={fx.id} value={v.templateId} onChange={(e) => setV({ ...v, templateId: e.target.value })}><option value="">{t('common.choose')}</option>{(templates.data?.items ?? []).map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}</Select>}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('schedules.where')}>{(fx) => (
            <Select id={fx.id} value={v.target.kind} onChange={(e) => setTarget({ kind: e.target.value as ScheduleTarget['kind'], ids: [] })}>
              <option value="all">{t('target.all')}</option><option value="region">{t('target.region')}</option><option value="locations">{t('target.locations')}</option>
            </Select>
          )}</Field>
          {v.target.kind === 'region' && <Field label={t('target.region')}>{(fx) => <Select id={fx.id} value={v.target.ids[0] ?? ''} onChange={(e) => setTarget({ kind: 'region', ids: e.target.value ? [e.target.value] : [] })}><option value="">{t('common.choose')}</option>{(regions.data?.items ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>}
        </div>
        {v.target.kind === 'locations' && (
          <ul className="flex flex-wrap gap-1.5">
            {app.locations.map((l) => {
              const on = v.target.ids.includes(l.id);
              return <li key={l.id}><button type="button" aria-pressed={on} onClick={() => setTarget({ kind: 'locations', ids: on ? v.target.ids.filter((i) => i !== l.id) : [...v.target.ids, l.id] })} className={cx('rounded-full px-3 py-1.5 text-[13px] font-bold', on ? 'bg-ink text-white' : 'bg-canvas-raised')}>{l.name}</button></li>;
            })}
          </ul>
        )}
        <div className="grid grid-cols-3 gap-2">
          <Field label={t('schedules.every')}>{(fx) => <Select id={fx.id} value={v.frequency} onChange={(e) => setV({ ...v, frequency: e.target.value as AuditScheduleBody['frequency'] })}>{AUDIT_FREQUENCIES.map((fr) => <option key={fr} value={fr}>{t(`schedules.freqName.${fr}`)}</option>)}</Select>}</Field>
          <Field label={t('schedules.interval')}>{(fx) => <Input id={fx.id} type="number" min={1} max={12} value={v.interval} onChange={(e) => setV({ ...v, interval: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })} />}</Field>
          <Field label={t('schedules.lead')} hint={t('schedules.leadHint')}>{(fx) => <Input id={fx.id} type="number" min={0} max={60} value={v.leadDays} onChange={(e) => setV({ ...v, leadDays: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })} />}</Field>
        </div>
        <Field label={t('schedules.firstDue')}>{(fx) => <Input id={fx.id} type="date" value={v.anchorDate} onChange={(e) => setV({ ...v, anchorDate: e.target.value })} />}</Field>
        <Field label={t('schedules.auditor')} hint={t('schedules.auditorHint')}>{(fx) => (
          <Select id={fx.id} value={v.auditorRule} onChange={(e) => setV({ ...v, auditorRule: e.target.value as AuditScheduleBody['auditorRule'] })}>
            <option value="field_consultant">{t('schedules.consultant')}</option><option value="user">{t('schedules.named')}</option>
          </Select>
        )}</Field>
        <label className="flex items-center gap-2 text-[13px] font-bold"><Toggle checked={v.active} label={t('schedules.active')} onChange={(a) => setV({ ...v, active: a })} />{t('schedules.active')}</label>
        {preview.data && (
          <div className="rounded-md bg-canvas-raised p-3 text-[13px]">
            <strong>{t('schedules.preview')}</strong>
            <p className="text-xs text-stone">{preview.data.dates.join(' · ')}</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {preview.data.locations.map((l) => <li key={l.locationId} className="flex justify-between gap-2"><span>{l.name}</span><span className={cx(!l.auditorName && 'text-danger')}>{l.auditorName ?? t('schedules.unassigned')}</span></li>)}
            </ul>
          </div>
        )}
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Retraining loop                                                     */
/* ------------------------------------------------------------------ */

let coursesCache: Promise<Array<{ id: string; title: string }>> | null = null;
const loadCourses = () => (coursesCache ??= programmesApi.courses().then((r) => r.items, () => { coursesCache = null; return []; }));

/** Template editor: the academy course a failed item recommends, and whether it is assigned automatically. */
export function QuestionTraining({ q, onChange }: { q: AuditQuestion; onChange: (patch: Partial<AuditQuestion>) => void }) {
  const t = useTranslations('auditsPlus');
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);
  useEffect(() => { void loadCourses().then(setCourses); }, []);
  if (q.type === 'text' || (!courses.length && !q.trainingCourseId)) return null;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[220px] flex-1"><Field label={t('training.recommend')} hint={t('training.recommendHint')} optional>{(x) => (
        <Select id={x.id} value={q.trainingCourseId ?? ''} onChange={(e) => onChange({ trainingCourseId: e.target.value || undefined, ...(e.target.value ? {} : { trainingAutoAssign: undefined }) })}>
          <option value="">{t('training.none')}</option>
          {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </Select>
      )}</Field></div>
      {q.trainingCourseId && <label className="flex items-center gap-2 pb-2 text-[13px] font-bold"><Toggle checked={!!q.trainingAutoAssign} label={t('training.auto')} onChange={(v) => onChange({ trainingAutoAssign: v || undefined })} />{t('training.auto')}</label>}
    </div>
  );
}

/** Corrective action: the recommended course, the team's progress, or a button to assign it. */
export function RetrainingRow({ x, audit, onChanged }: { x: ActionVM; audit: AuditDetailVM; onChanged: () => void }) {
  const t = useTranslations('auditsPlus');
  const act = useAction();
  const tr = x.training;
  const q = audit.checklist.sections.flatMap((s) => s.questions).find((qq) => qq.id === x.questionId);
  const courseId = tr?.courseId ?? q?.trainingCourseId;
  if (!courseId) return null;
  const canAssign = (audit.permissions.manage || audit.permissions.verify) && !tr?.assigned && x.status !== 'verified';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-info-bg/50 px-3 py-2 text-[13px]" data-testid="retraining">
      <Badge tone="info" icon="book">{t('training.label')}</Badge>
      <span className="min-w-0 flex-1">{tr?.courseTitle ?? t('training.course')}{tr?.assigned ? ` · ${t('training.progress', { completed: tr.completed, enrolled: tr.enrolled })}` : ` · ${t('training.recommended')}`}</span>
      <ActionError error={act.error} />
      {canAssign && <Button size="sm" variant="secondary" icon="send" loading={act.pending} onClick={async () => { if (await act.run(() => programmesApi.assignTraining(x.id, courseId))) onChanged(); }}>{t('training.assign')}</Button>}
    </div>
  );
}

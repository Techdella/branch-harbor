'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Input, Select, Tabs } from '@bh/ui';
import { dateInZone, fmtDateTime, fmtTime, fmtDay, zonedToUtc } from '@/lib/format';
import { useWellness, useWellnessAction } from '@/lib/wellness/api';
import { useErrorText } from '@/lib/useErrorText';
import type { ImpactItem, RebookAction, RebookResult, WException, WPractitioner, WService, Window } from '@/lib/wellness/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, LoadingBlock } from '../../ui/States';
import { Loadable, WEEKDAYS, weekdayName, useScopeLocations } from './shared';

type Tab = 'templates' | 'exceptions';

export function PractitionersView() {
  const t = useTranslations('wellnessFull.practitioners');
  const locale = useLocale();
  const app = useApp();
  const locs = useScopeLocations();
  const [tab, setTab] = useState<Tab>('templates');
  const [editing, setEditing] = useState<{ p: WPractitioner; locationId: string } | null>(null);
  const [newEx, setNewEx] = useState(false);
  const [openEx, setOpenEx] = useState<WException | null>(null);
  const res = useWellness(app.locations, async (api) => ({ pracs: await api.practitioners(), services: await api.services(), exceptions: await api.exceptions() }), [app.role, app.scopeId]);
  const canWrite = app.can('operations.write');
  const locName = (id: string | null) => (id ? app.locations.find((l) => l.id === id)?.name ?? id : t('allLocations'));
  return (
    <>
      <PageHeader icon="user" title={t('title')} description={t('description')} actions={canWrite && tab === 'exceptions' ? <Button icon="plus" onClick={() => setNewEx(true)}>{t('addException')}</Button> : null} />
      <section className="flex flex-col gap-3 rounded-xl bg-surface p-3.5">
        <Tabs items={[{ key: 'templates', label: t('tabTemplates') }, { key: 'exceptions', label: t('tabExceptions'), count: res.status === 'ready' ? res.data.exceptions.length : undefined }]} value={tab} onChange={(k) => setTab(k as Tab)} />
        <Loadable res={res} loading={<LoadingBlock variant="table" />}>
          {({ pracs, services, exceptions }) => {
            const ids = new Set(locs.map((l) => l.id));
            const visible = pracs.filter((p) => p.locations.some((x) => ids.has(x.locationId)));
            if (tab === 'templates') return !visible.length ? <Empty icon="user" title={t('empty')} /> : (
              <div className="flex flex-col gap-2.5">
                {visible.map((p) => <PractitionerCard key={p.id} p={p} services={services} locName={locName} onEdit={canWrite ? (locationId) => setEditing({ p, locationId }) : undefined} />)}
              </div>
            );
            const exs = exceptions.filter((e) => visible.some((p) => p.id === e.practitionerId));
            return !exs.length ? <Empty icon="calendar" title={t('noExceptions')} body={t('noExceptionsBody')} /> : (
              <ul className="flex flex-col gap-2">
                {exs.map((e) => {
                  const tz = app.locations.find((l) => l.id === (e.locationId ?? pracs.find((p) => p.id === e.practitionerId)?.locationId))?.timeZone ?? 'UTC';
                  return (
                    <li key={e.id}>
                      <button type="button" onClick={() => setOpenEx(e)} className="grid w-full grid-cols-[1fr_auto] items-center gap-3 rounded-md border border-line-soft p-3.5 text-left hover:bg-canvas-raised">
                        <span><span className="block text-sm font-bold">{e.practitionerName} · {t(`kind.${e.kind}`)}</span><span className="block text-xs text-stone">{fmtDateTime(e.startsAt, tz, locale)} → {fmtDateTime(e.endsAt, tz, locale)} · {locName(e.locationId)}{e.reason ? ` · ${e.reason}` : ''}</span></span>
                        {e.affected > 0 ? <Badge tone="warning" icon="alert">{t('affected', { n: e.affected })}</Badge> : <Badge tone="success" icon="check">{t('noneAffected')}</Badge>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            );
          }}
        </Loadable>
      </section>
      {editing && <TemplateEditor p={editing.p} locationId={editing.locationId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); res.reload(); }} />}
      {newEx && res.status === 'ready' && <NewException pracs={res.data.pracs.filter((p) => p.locations.some((x) => locs.some((l) => l.id === x.locationId)))} onClose={() => setNewEx(false)} onCreated={(id) => { setNewEx(false); res.reload(); setTab('exceptions'); setOpenEx({ id } as WException); }} />}
      {openEx && <ImpactDrawer exceptionId={openEx.id} onClose={() => { setOpenEx(null); res.reload(); }} />}
    </>
  );
}

function PractitionerCard({ p, services, locName, onEdit }: { p: WPractitioner; services: WService[]; locName: (id: string) => string; onEdit?: (locationId: string) => void }) {
  const t = useTranslations('wellnessFull.practitioners');
  const locale = useLocale();
  const app = useApp();
  const unused = app.locations.filter((l) => !p.locations.some((x) => x.locationId === l.id));
  const [add, setAdd] = useState('');
  return (
    <article className="flex flex-col gap-2.5 rounded-lg border border-line-soft p-4">
      <div className="flex flex-wrap items-center gap-2"><h3 className="text-[15px] font-bold">{p.name}</h3>{!p.active && <Badge tone="neutral" icon="x">{t('inactive')}</Badge>}{p.userId && <Badge tone="info" icon="user">{t('hasLogin')}</Badge>}</div>
      <p className="text-xs text-stone">{t('offers')}: {services.filter((s) => p.serviceIds.includes(s.id)).map((s) => s.name).join(', ') || t('nothing')}</p>
      <div className="grid gap-2 md:grid-cols-2">
        {p.locations.map((l) => (
          <div key={l.locationId} className="rounded-md bg-canvas p-3 text-[13px]">
            <div className="mb-1.5 flex items-center justify-between gap-2"><strong>{locName(l.locationId)}{l.home ? ` · ${t('home')}` : ''}</strong>{onEdit && <Button size="sm" variant="ghost" icon="edit" onClick={() => onEdit(l.locationId)}>{t('edit')}</Button>}</div>
            {l.availability.length ? (
              <ul className="grid grid-cols-[48px_1fr] gap-x-2 gap-y-0.5">
                {WEEKDAYS.map((wd) => { const ws = l.availability.filter((w) => w.weekday === wd); return ws.length ? <li key={wd} className="contents"><span className="font-bold">{weekdayName(wd, locale)}</span><span className="tabular">{ws.map((w) => `${w.start}–${w.end}`).join(', ')}</span></li> : null; })}
              </ul>
            ) : <span className="text-stone">{t('noHours')}</span>}
          </div>
        ))}
      </div>
      {onEdit && unused.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <Select aria-label={t('addLocation')} value={add} onChange={(e) => setAdd(e.target.value)} className="!h-9 max-w-xs !text-[13px]"><option value="">{t('addLocation')}</option>{unused.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
          <Button size="sm" variant="secondary" disabled={!add} onClick={() => onEdit(add)}>{t('setHours')}</Button>
          <span className="text-xs text-stone">{t('multiHint')}</span>
        </div>
      )}
    </article>
  );
}

function TemplateEditor({ p, locationId, onClose, onSaved }: { p: WPractitioner; locationId: string; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('wellnessFull.practitioners');
  const locale = useLocale();
  const app = useApp();
  const action = useWellnessAction(app.locations);
  const existing = p.locations.find((l) => l.locationId === locationId)?.availability ?? [];
  const [rows, setRows] = useState<Record<number, { on: boolean; start: string; end: string }>>(() => Object.fromEntries(WEEKDAYS.map((wd) => { const w = existing.find((x) => x.weekday === wd); return [wd, { on: !!w, start: w?.start ?? '09:00', end: w?.end ?? '17:00' }]; })));
  const loc = app.locations.find((l) => l.id === locationId);
  const save = async () => {
    const availability: Window[] = WEEKDAYS.filter((wd) => rows[wd]!.on).map((wd) => ({ weekday: wd, start: rows[wd]!.start, end: rows[wd]!.end }));
    const ok = await action.run(async (api) => { await api.saveTemplate(p.id, locationId, availability); return true; });
    if (ok) onSaved();
  };
  const home = p.locationId === locationId;
  return (
    <Drawer open onClose={onClose} kicker={`${p.name} · ${loc?.name ?? ''}`} title={t('weeklyHours')} footer={<div className="flex flex-wrap gap-2"><Button onClick={save} disabled={action.pending}>{t('save')}</Button>{!home && p.locations.some((l) => l.locationId === locationId) && <Button variant="danger" disabled={action.pending} onClick={async () => { const ok = await action.run(async (api) => { await api.removeTemplate(p.id, locationId); return true; }); if (ok) onSaved(); }}>{t('removeLocation')}</Button>}<Button variant="secondary" onClick={onClose}>{t('close')}</Button></div>}>
      <div className="flex flex-col gap-2.5">
        <p className="text-xs text-stone">{t('localTime', { zone: loc?.timeZone ?? '' })}</p>
        {action.error && <Banner tone="danger" live="assertive" title={action.error.code === 'schedule_overlap' ? t('overlapTitle') : t('saveFailed')}>{action.error.message}</Banner>}
        {WEEKDAYS.map((wd) => (
          <div key={wd} className="grid grid-cols-[110px_1fr_1fr] items-center gap-2">
            <label className="flex items-center gap-2 text-[13px] font-bold"><input type="checkbox" className="h-4 w-4 accent-ink" checked={rows[wd]!.on} onChange={(e) => setRows({ ...rows, [wd]: { ...rows[wd]!, on: e.target.checked } })} />{weekdayName(wd, locale, 'long')}</label>
            <Input aria-label={t('start', { day: weekdayName(wd, locale, 'long') })} type="time" step={900} disabled={!rows[wd]!.on} value={rows[wd]!.start} onChange={(e) => setRows({ ...rows, [wd]: { ...rows[wd]!, start: e.target.value } })} className="!h-9" />
            <Input aria-label={t('end', { day: weekdayName(wd, locale, 'long') })} type="time" step={900} disabled={!rows[wd]!.on} value={rows[wd]!.end} onChange={(e) => setRows({ ...rows, [wd]: { ...rows[wd]!, end: e.target.value } })} className="!h-9" />
          </div>
        ))}
        <p className="text-xs text-stone">{t('overlapRule')}</p>
      </div>
    </Drawer>
  );
}

function NewException({ pracs, onClose, onCreated }: { pracs: WPractitioner[]; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations('wellnessFull.practitioners');
  const app = useApp();
  const action = useWellnessAction(app.locations);
  const [pid, setPid] = useState(pracs[0]?.id ?? '');
  const p = pracs.find((x) => x.id === pid);
  const tz = app.locations.find((l) => l.id === p?.locationId)?.timeZone ?? 'UTC';
  const today = dateInZone(new Date(), tz);
  const [f, setF] = useState({ from: today, fromTime: '00:00', to: today, toTime: '23:59', kind: 'leave', reason: '', scope: '' });
  const create = async () => {
    const r = await action.run((api) => api.createException({ practitionerId: pid, locationId: f.scope || null, startsAt: zonedToUtc(f.from, f.fromTime, tz), endsAt: zonedToUtc(f.to, f.toTime, tz), kind: f.kind, reason: f.reason || undefined }));
    if (r) onCreated(r.exceptionId);
  };
  return (
    <Drawer open onClose={onClose} kicker={t('tabExceptions')} title={t('addException')}>
      <div className="flex flex-col gap-3">
        <Field label={t('practitioner')}>{({ id }) => <Select id={id} value={pid} onChange={(e) => setPid(e.target.value)}>{pracs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        <Field label={t('kindLabel')}>{({ id }) => <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['leave', 'absence', 'training', 'other'].map((k) => <option key={k} value={k}>{t(`kind.${k}`)}</option>)}</Select>}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('from')}>{({ id }) => <Input id={id} type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />}</Field>
          <Field label={t('fromTime')}>{({ id }) => <Input id={id} type="time" value={f.fromTime} onChange={(e) => setF({ ...f, fromTime: e.target.value })} />}</Field>
          <Field label={t('to')}>{({ id }) => <Input id={id} type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}</Field>
          <Field label={t('toTime')}>{({ id }) => <Input id={id} type="time" value={f.toTime} onChange={(e) => setF({ ...f, toTime: e.target.value })} />}</Field>
        </div>
        {p && p.locations.length > 1 && <Field label={t('scope')}>{({ id }) => <Select id={id} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="">{t('allLocations')}</option>{p.locations.map((l) => <option key={l.locationId} value={l.locationId}>{app.locations.find((x) => x.id === l.locationId)?.name}</option>)}</Select>}</Field>}
        <Field label={t('reason')} hint={t('reasonHint')} optional>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
        <p className="text-xs text-stone">{t('timesInZone', { zone: tz })}</p>
        {action.error && <Banner tone="danger" live="assertive">{action.error.message}</Banner>}
        <Button disabled={!pid || action.pending} onClick={create}>{t('createAndReview')}</Button>
      </div>
    </Drawer>
  );
}

function ImpactDrawer({ exceptionId, onClose }: { exceptionId: string; onClose: () => void }) {
  const t = useTranslations('wellnessFull.practitioners');
  const errorText = useErrorText();
  const locale = useLocale();
  const app = useApp();
  const res = useWellness(app.locations, (api) => api.impact(exceptionId), [exceptionId]);
  const action = useWellnessAction(app.locations);
  const [choice, setChoice] = useState<Record<string, { action: 'reassign' | 'reschedule' | 'cancel' | 'skip'; practitionerId?: string; date?: string; time?: string }>>({});
  const [result, setResult] = useState<RebookResult | null>(null);
  const run = async (items: ImpactItem[]) => {
    const actions: RebookAction[] = items.flatMap((i): RebookAction[] => {
      const c = choice[i.appointment.id] ?? { action: i.alternatives.length ? 'reassign' : 'skip' };
      if (c.action === 'skip') return [];
      if (c.action === 'reassign') return [{ appointmentId: i.appointment.id, action: 'reassign' as const, practitionerId: c.practitionerId ?? i.alternatives[0]?.id }];
      if (c.action === 'reschedule') return c.date && c.time ? [{ appointmentId: i.appointment.id, action: 'reschedule' as const, startsAt: zonedToUtc(c.date, c.time, i.location.timeZone) }] : [];
      return [{ appointmentId: i.appointment.id, action: 'cancel' as const, notify: true }];
    });
    if (!actions.length) return;
    const r = await action.run((api) => api.rebook(exceptionId, actions));
    if (r) { setResult(r); res.reload(); }
  };
  return (
    <Drawer open onClose={onClose} kicker={t('impactKicker')} title={t('impactTitle')}>
      <Loadable res={res}>
        {(items) => (
          <div className="flex flex-col gap-3">
            {result && <Banner tone={result.failed ? 'warning' : 'success'} live="polite" title={t('rebookResult', { done: result.done, failed: result.failed })}>{result.results.filter((r) => r.status === 'failed').map((r) => errorText(r.error)).join(' · ')}</Banner>}
            {!items.length ? <Empty icon="check-circle" title={t('nothingAffected')} body={t('nothingAffectedBody')} /> : (
              <>
                <p className="text-[13px] text-stone">{t('impactIntro', { n: items.length })}</p>
                {items.map((i) => {
                  const tz = i.location.timeZone;
                  const c = choice[i.appointment.id] ?? { action: i.alternatives.length ? 'reassign' : 'skip' };
                  return (
                    <div key={i.appointment.id} className="flex flex-col gap-2 rounded-lg border border-line-soft p-3 text-[13px]">
                      <div><strong>{fmtDay(i.appointment.startsAt, tz, locale)} {fmtTime(i.appointment.startsAt, tz, locale)}</strong> · {i.serviceName} · {i.clientName} <span className="text-stone">· {i.location.name}</span></div>
                      <Select aria-label={t('actionFor', { client: i.clientName })} value={c.action} onChange={(e) => setChoice({ ...choice, [i.appointment.id]: { ...c, action: e.target.value as 'reassign' } })} className="!h-9 !text-[13px]">
                        <option value="reassign" disabled={!i.alternatives.length}>{i.alternatives.length ? t('reassign') : t('noAlternative')}</option>
                        <option value="reschedule">{t('reschedule')}</option>
                        <option value="cancel">{t('cancelRefund')}</option>
                        <option value="skip">{t('skip')}</option>
                      </Select>
                      {c.action === 'reassign' && i.alternatives.length > 1 && <Select aria-label={t('practitioner')} value={c.practitionerId ?? i.alternatives[0]!.id} onChange={(e) => setChoice({ ...choice, [i.appointment.id]: { ...c, practitionerId: e.target.value } })} className="!h-9 !text-[13px]">{i.alternatives.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}
                      {c.action === 'reschedule' && <div className="grid grid-cols-2 gap-2"><Input aria-label={t('from')} type="date" value={c.date ?? ''} onChange={(e) => setChoice({ ...choice, [i.appointment.id]: { ...c, date: e.target.value } })} className="!h-9" /><Input aria-label={t('fromTime')} type="time" step={900} value={c.time ?? ''} onChange={(e) => setChoice({ ...choice, [i.appointment.id]: { ...c, time: e.target.value } })} className="!h-9" /></div>}
                    </div>
                  );
                })}
                {action.error && <Banner tone="danger" live="assertive">{action.error.message}</Banner>}
                <Button disabled={action.pending} onClick={() => run(items)}>{action.pending ? t('applying') : t('applyActions')}</Button>
                <p className="text-xs text-stone">{t('rebookRule')}</p>
              </>
            )}
            {app.can('operations.write') && <Button variant="ghost" icon="undo" onClick={async () => { const ok = await action.run(async (api) => { await api.withdrawException(exceptionId); return true; }); if (ok) onClose(); }}>{t('withdraw')}</Button>}
          </div>
        )}
      </Loadable>
    </Drawer>
  );
}

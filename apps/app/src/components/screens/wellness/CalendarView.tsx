'use client';

import { useMemo, useState, type DragEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Input, Select, Tabs, Toggle, cx } from '@bh/ui';
import { addDays, cityOfZone, dateInZone, fmtDay, fmtTime, fmtYmd, hhmmIn, zoneLabel, zonedToUtc } from '@/lib/format';
import { useWellness, useWellnessAction } from '@/lib/wellness/api';
import type { CalAppointment, CalendarDay, CancellationPreview, MoveResult, WService } from '@/lib/wellness/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, LoadingBlock } from '../../ui/States';
import { Loadable, LocationSelect, Money, PolicyPreview, StatusBadge, pct, useLocationChoice } from './shared';

type View = 'practitioners' | 'rooms' | 'list';
const PPM = 1.15; // pixels per minute
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function CalendarView() {
  const t = useTranslations('wellnessFull.calendar');
  const tw = useTranslations('wellnessFull');
  const locale = useLocale();
  const app = useApp();
  const { locations, location, setLocationId } = useLocationChoice();
  const tz = location?.timeZone ?? 'UTC';
  const [date, setDate] = useState(() => dateInZone(new Date(), tz));
  const [view, setView] = useState<View>('practitioners');
  const [open, setOpen] = useState<CalAppointment | null>(null);
  const [booking, setBooking] = useState<{ practitionerId?: string; time?: string } | null>(null);
  const [pendingMove, setPendingMove] = useState<{ appt: CalAppointment; startsAt: string; practitionerId?: string; resourceId?: string } | null>(null);
  const res = useWellness(locations, (api) => api.calendar(location!.id, date), [location?.id, date, app.role], !!location);
  const waitlist = useWellness(locations, (api) => api.waitlist(), [location?.id, app.role], !!location);

  if (!location) return <Empty icon="pin" title={t('noLocation')} />;
  const canWrite = app.can('operations.write');

  return (
    <>
      <PageHeader icon="calendar" title={t('title')} description={t('description')} actions={canWrite ? <Button icon="plus" onClick={() => setBooking({})}>{t('newBooking')}</Button> : null} />
      <section className="rounded-xl bg-surface p-3.5">
        <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
          <LocationSelect locations={locations} value={location.id} onChange={(id) => { setLocationId(id); const l = locations.find((x) => x.id === id); if (l) setDate(dateInZone(new Date(), l.timeZone)); }} label={tw('location')} />
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" icon="chevron-left" aria-label={t('prevDay')} onClick={() => setDate(addDays(date, -1))} />
            <Button size="sm" variant="secondary" onClick={() => setDate(dateInZone(new Date(), tz))}>{t('today')}</Button>
            <Button size="sm" variant="ghost" icon="chevron-right" aria-label={t('nextDay')} onClick={() => setDate(addDays(date, 1))} />
            <Input type="date" aria-label={t('pickDate')} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="!h-9 !w-[150px] !text-[13px]" />
          </div>
          <strong className="text-[15px]">{fmtYmd(date, locale, { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
          <span className="text-xs text-stone">{t('timesIn', { zone: `${cityOfZone(tz)} (${zoneLabel(tz, locale)})` })}</span>
          <Tabs className="ml-auto" items={(['practitioners', 'rooms', 'list'] as const).map((k) => ({ key: k, label: t(`view.${k}`) }))} value={view} onChange={(v) => setView(v as View)} />
        </div>
        {waitlist.status === 'ready' && waitlist.data.filter((w) => w.locationId === location.id).length > 0 && (
          <div className="mb-3"><Banner tone="info" icon="clock" title={t('waitlistTitle', { n: waitlist.data.filter((w) => w.locationId === location.id).length })}>
            {waitlist.data.filter((w) => w.locationId === location.id).slice(0, 3).map((w) => `${w.serviceName ?? ''} · ${fmtDay(w.windowStart, tz, locale)} ${fmtTime(w.windowStart, tz, locale)}–${fmtTime(w.windowEnd, tz, locale)} · ${tw(`status.${w.status}`)}`).join('  ·  ')}
          </Banner></div>
        )}
        <Loadable res={res} loading={<LoadingBlock variant="calendar" />}>
          {(d) => view === 'list' ? <ListView d={d} onOpen={setOpen} /> : (
            <Grid d={d} view={view} canWrite={canWrite} onOpen={setOpen} onEmpty={(practitionerId, time) => canWrite && setBooking({ practitionerId, time })}
              onDrop={(appt, colId, minute) => setPendingMove({ appt, startsAt: zonedToUtc(date, toHhmm(minute), tz), ...(view === 'rooms' ? { resourceId: colId } : { practitionerId: colId }) })} />
          )}
        </Loadable>
        <p className="px-1 pt-3 text-xs text-stone">{t('dragHint')}</p>
      </section>
      {open && res.status === 'ready' && <AppointmentDrawer appt={open} day={res.data} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); res.reload(); waitlist.reload(); }} />}
      {booking && res.status === 'ready' && <BookingDrawer day={res.data} preset={booking} onClose={() => setBooking(null)} onBooked={() => { setBooking(null); res.reload(); }} />}
      {pendingMove && <MoveConfirm move={pendingMove} tz={tz} onClose={() => setPendingMove(null)} onMoved={() => { setPendingMove(null); res.reload(); }} />}
    </>
  );
}

function Grid({ d, view, canWrite, onOpen, onEmpty, onDrop }: { d: CalendarDay; view: View; canWrite: boolean; onOpen: (a: CalAppointment) => void; onEmpty: (practitionerId: string, time: string) => void; onDrop: (a: CalAppointment, colId: string, minute: number) => void }) {
  const t = useTranslations('wellnessFull.calendar');
  const locale = useLocale();
  const tz = d.location.timeZone;
  const cols = view === 'rooms' ? d.rooms.map((r) => ({ id: r.id, name: r.name, sub: r.kind === 'equipment' ? t('equipment') : t('room'), util: r.utilisation, windows: [] as { start: string; end: string }[], exceptions: [] as CalendarDay['practitioners'][number]['exceptions'] })) : d.practitioners.map((p) => ({ id: p.id, name: p.name, sub: p.home ? '' : t('visiting'), util: p.utilisation, windows: p.windows, exceptions: p.exceptions }));
  const live = d.appointments.filter((a) => a.status !== 'cancelled');
  const mins = [...live.flatMap((a) => [toMin(hhmmIn(a.startsAt, tz)), toMin(hhmmIn(a.endsAt, tz))]), ...d.practitioners.flatMap((p) => p.windows.flatMap((w) => [toMin(w.start), toMin(w.end === '24:00' ? '23:59' : w.end)]))];
  const start = Math.max(0, Math.floor(Math.min(8 * 60, ...mins) / 60) * 60);
  const end = Math.min(24 * 60, Math.ceil(Math.max(19 * 60, ...mins) / 60) * 60);
  const height = (end - start) * PPM;
  const [dragId, setDragId] = useState<string | null>(null);
  const inCol = (a: CalAppointment, colId: string) => (view === 'rooms' ? a.roomId === colId || a.equipment.some((e) => e.id === colId) : a.practitionerId === colId);
  const minuteAt = (e: DragEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    return start + Math.round((e.clientY - rect.top) / PPM / 15) * 15;
  };
  if (!cols.length) return <Empty icon="user" title={t('noColumns')} />;
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[720px] gap-2" style={{ gridTemplateColumns: `56px repeat(${cols.length}, minmax(170px, 1fr))` }}>
        <div />
        {cols.map((c) => (
          <div key={c.id} className="flex flex-col gap-1 rounded-[14px] bg-canvas p-2.5">
            <span className="text-[13px] font-bold">{c.name} {c.sub && <span className="text-[11px] font-medium text-stone">· {c.sub}</span>}</span>
            <span className="flex items-center gap-2 text-[11px] text-stone">
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-white" aria-hidden><span className="block h-full bg-ink" style={{ width: `${Math.min(100, (c.util.rate ?? 0) * 100)}%` }} /></span>
              {c.util.rate == null ? t('noHours') : t('utilisation', { rate: pct(c.util.rate, locale) ?? '' })}
            </span>
          </div>
        ))}
        <div className="relative" style={{ height }}>
          {Array.from({ length: (end - start) / 60 + 1 }, (_, i) => (
            <span key={i} className="tabular absolute right-1 -translate-y-1/2 text-[11px] font-bold text-stone" style={{ top: i * 60 * PPM }}>{toHhmm(start + i * 60)}</span>
          ))}
        </div>
        {cols.map((c) => (
          <div key={c.id} className={cx('relative rounded-md border border-line-soft', view === 'practitioners' ? 'bg-[repeating-linear-gradient(45deg,#F6F5F1,#F6F5F1_6px,#FBFAF7_6px,#FBFAF7_12px)]' : 'bg-[#FAFAF7]')} style={{ height }}
            onDragOver={(e) => { if (dragId) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); const a = live.find((x) => x.id === dragId); setDragId(null); if (a) onDrop(a, c.id, minuteAt(e)); }}
            onDoubleClick={(e) => { if (view === 'practitioners') onEmpty(c.id, toHhmm(minuteAt(e as unknown as DragEvent<HTMLDivElement>))); }}
          >
            {c.windows.map((w, i) => (
              <div key={i} aria-hidden className="absolute inset-x-0 bg-white" style={{ top: (toMin(w.start) - start) * PPM, height: (toMin(w.end === '24:00' ? '24:00' : w.end) - toMin(w.start)) * PPM }} />
            ))}
            {c.exceptions.map((x) => {
              const s = Math.max(start, toMin(hhmmIn(x.startsAt, tz)) * (dateInZone(new Date(x.startsAt), tz) < d.date ? 0 : 1));
              const e = dateInZone(new Date(x.endsAt), tz) > d.date ? end : toMin(hhmmIn(x.endsAt, tz));
              return (
                <div key={x.id} className="absolute inset-x-0 flex items-start justify-center bg-[repeating-linear-gradient(-45deg,#F8D6D8,#F8D6D8_8px,#FBE9EA_8px,#FBE9EA_16px)] pt-2 text-[11px] font-bold text-danger" style={{ top: (s - start) * PPM, height: Math.max(20, (e - s) * PPM) }}>
                  <Badge tone="danger" icon="alert">{t(`exception.${x.kind}`)}{x.reason ? ` · ${x.reason}` : ''}</Badge>
                </div>
              );
            })}
            {live.filter((a) => inCol(a, c.id)).map((a) => {
              const top = (toMin(hhmmIn(a.startsAt, tz)) - start) * PPM;
              const h = Math.max(30, ((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60000) * PPM);
              return (
                <button key={a.id} type="button" draggable={canWrite && a.status === 'confirmed'} onDragStart={(e) => { setDragId(a.id); e.dataTransfer.setData('text/plain', a.id); }} onDragEnd={() => setDragId(null)} onClick={() => onOpen(a)}
                  aria-label={`${fmtTime(a.startsAt, tz, locale)} ${a.serviceName} ${a.clientName ?? t('clientHidden')}`}
                  className={cx('absolute inset-x-1 flex flex-col gap-0.5 overflow-hidden rounded-md p-2 text-left shadow-sm outline-ink hover:outline hover:outline-1 focus-visible:outline focus-visible:outline-2', a.status === 'completed' ? 'bg-canvas' : a.status === 'no_show' ? 'bg-warning-bg' : a.groupId ? 'bg-lilac' : a.mine ? 'bg-butter' : 'bg-mint', dragId === a.id && 'opacity-50')}
                  style={{ top, height: h }}>
                  <span className="text-[12px] font-bold leading-tight">{a.serviceName}{a.variantName ? ` · ${a.variantName}` : ''}</span>
                  <span className="text-[11px] text-graphite">{fmtTime(a.startsAt, tz, locale)} · {a.clientName ?? t('clientHidden')}</span>
                  <span className="text-[11px] text-graphite">{view === 'rooms' ? a.practitionerName : a.roomName ?? ''}{a.groupId ? ` · ${t('couples')}` : ''}{a.checkedInAt && a.status === 'confirmed' ? ` · ${t('checkedIn')}` : ''}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function ListView({ d, onOpen }: { d: CalendarDay; onOpen: (a: CalAppointment) => void }) {
  const t = useTranslations('wellnessFull.calendar');
  const locale = useLocale();
  const tz = d.location.timeZone;
  if (!d.appointments.length) return <Empty icon="calendar" title={t('empty')} body={t('emptyBody')} />;
  return (
    <ul className="flex flex-col gap-1.5">
      {[...d.appointments].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map((a) => (
        <li key={a.id}>
          <button type="button" onClick={() => onOpen(a)} className="grid w-full grid-cols-[72px_1fr_auto] items-center gap-3 rounded-md bg-canvas-raised px-3.5 py-3 text-left hover:outline hover:outline-1">
            <span className="tabular text-[13px] font-bold">{fmtTime(a.startsAt, tz, locale)}</span>
            <span>
              <span className="block text-sm font-bold">{a.serviceName}{a.variantName ? ` · ${a.variantName}` : ''}</span>
              <span className="block text-xs text-stone">{a.clientName ?? t('clientHidden')} · {a.practitionerName}{a.roomName ? ` · ${a.roomName}` : ''}</span>
            </span>
            <StatusBadge status={a.status} checkedIn={!!a.checkedInAt} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function MoveConfirm({ move, tz, onClose, onMoved }: { move: { appt: CalAppointment; startsAt: string; practitionerId?: string; resourceId?: string }; tz: string; onClose: () => void; onMoved: () => void }) {
  const t = useTranslations('wellnessFull.calendar');
  const locale = useLocale();
  const app = useApp();
  const action = useWellnessAction(app.locations);
  const check = useWellness(app.locations, (api) => api.move(move.appt.id, { startsAt: move.startsAt, practitionerId: move.practitionerId, resourceId: move.resourceId, dryRun: true }), [move.appt.id, move.startsAt, move.practitionerId, move.resourceId]);
  const [result, setResult] = useState<MoveResult | null>(null);
  const confirm = async () => {
    const r = await action.run((api) => api.move(move.appt.id, { startsAt: move.startsAt, practitionerId: move.practitionerId, resourceId: move.resourceId, dryRun: false }));
    if (r?.ok) onMoved(); else if (r) setResult(r);
  };
  return (
    <Drawer open onClose={onClose} kicker={t('moveKicker')} title={`${move.appt.serviceName} → ${fmtDay(move.startsAt, tz, locale)} ${fmtTime(move.startsAt, tz, locale)}`}>
      <div className="flex flex-col gap-3">
        <p className="text-[13px]">{t('moveFrom', { time: `${fmtDay(move.appt.startsAt, tz, locale)} ${fmtTime(move.appt.startsAt, tz, locale)}`, practitioner: move.appt.practitionerName })}</p>
        {check.status === 'loading' && <Banner tone="info" icon="refresh" live="polite">{t('checking')}</Banner>}
        {check.status === 'ready' && (check.data.ok ? <Banner tone="success" title={t('noConflicts')}>{t('noConflictsBody')}</Banner> : (
          <Banner tone="danger" title={t('conflicts')} live="assertive">
            <ul className="list-disc pl-4">{check.data.conflicts.map((c, i) => <li key={i}>{c.message}</li>)}{!check.data.conflicts.length && check.data.error && <li>{check.data.error.message}</li>}</ul>
          </Banner>
        ))}
        {result && !result.ok && <Banner tone="danger" title={t('moveFailed')} live="assertive">{result.error?.message}</Banner>}
        {action.error && <Banner tone="danger" title={t('moveFailed')} live="assertive">{action.error.message}</Banner>}
        <p className="text-xs text-stone">{t('moveAtomic')}</p>
        <div className="flex gap-2">
          <Button onClick={confirm} disabled={check.status !== 'ready' || !check.data.ok || action.pending}>{action.pending ? t('moving') : t('confirmMove')}</Button>
          <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
        </div>
      </div>
    </Drawer>
  );
}

function AppointmentDrawer({ appt, day, onClose, onChanged }: { appt: CalAppointment; day: CalendarDay; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations('wellnessFull.calendar');
  const locale = useLocale();
  const app = useApp();
  const tz = day.location.timeZone;
  const action = useWellnessAction(app.locations);
  const [mode, setMode] = useState<null | 'cancel' | 'no_show' | 'move' | 'voucher'>(null);
  const [preview, setPreview] = useState<CancellationPreview | null>(null);
  const [byBusiness, setByBusiness] = useState(false);
  const [waive, setWaive] = useState(false);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [mv, setMv] = useState({ date: dateInZone(new Date(appt.startsAt), tz), time: hhmmIn(appt.startsAt, tz), practitionerId: appt.practitionerId, resourceId: appt.roomId ?? '' });
  const [mvCheck, setMvCheck] = useState<MoveResult | null>(null);
  const canWrite = app.can('operations.write');
  const started = Date.parse(appt.startsAt) <= Date.now();
  const isToday = dateInZone(new Date(), tz) === dateInZone(new Date(appt.startsAt), tz);
  const active = appt.status === 'confirmed';

  const loadPreview = async (m: 'auto' | 'business' | 'no_show', w = waive) => {
    const p = await action.run((api) => api.cancelPreview(appt.id, m));
    if (p) setPreview(w ? { ...p, fee: { ...p.fee, amount: 0 }, outstanding: { ...p.outstanding, amount: 0 }, deposit: { ...p.deposit, retained: 0, refund: p.deposit.paid } } : p);
  };
  const doIt = async (fn: Parameters<typeof action.run>[0], message?: string) => {
    const r = await action.run(fn);
    if (r !== undefined) { if (message) setNote(message); onChanged(); }
  };

  return (
    <Drawer open onClose={onClose} kicker={t('appointment')} title={`${appt.serviceName}${appt.variantName ? ` · ${appt.variantName}` : ''}`}>
      <div className="flex flex-col gap-3.5 text-[13px]">
        <div className="flex flex-wrap items-center gap-2"><StatusBadge status={appt.status} checkedIn={!!appt.checkedInAt} />{appt.groupId && <Badge tone="info" icon="users">{t('couples')}</Badge>}{appt.clientPackageId && <Badge tone="neutral" icon="gift">{t('packageSession')}</Badge>}</div>
        <dl className="grid grid-cols-[120px_1fr] gap-y-1.5">
          <dt className="text-stone">{t('when')}</dt><dd>{fmtDay(appt.startsAt, tz, locale)} {fmtTime(appt.startsAt, tz, locale)}–{fmtTime(appt.endsAt, tz, locale)} ({zoneLabel(tz, locale)})</dd>
          <dt className="text-stone">{t('client')}</dt><dd>{appt.clientName ?? <span className="text-stone">{t('clientHiddenLong')}</span>}</dd>
          <dt className="text-stone">{t('practitioner')}</dt><dd>{appt.practitionerName}</dd>
          <dt className="text-stone">{t('room')}</dt><dd>{appt.roomName ?? '—'}{appt.equipment.length ? ` · ${appt.equipment.map((e) => e.name).join(', ')}` : ''}</dd>
          <dt className="text-stone">{t('price')}</dt><dd><Money m={appt.price} /></dd>
          <dt className="text-stone">{t('deposit')}</dt><dd>{appt.deposit.amount ? <><Money m={appt.deposit} /> · {appt.paymentId ? t('depositPaid') : t('depositDue')}</> : t('noDeposit')}</dd>
          {appt.voucherApplied.amount > 0 && (<><dt className="text-stone">{t('voucher')}</dt><dd><Money m={appt.voucherApplied} /></dd></>)}
        </dl>
        {note && <Banner tone="success" live="polite">{note}</Banner>}
        {action.error && <Banner tone="danger" live="assertive" title={t('actionFailed')}>{action.error.message}</Banner>}
        {canWrite && active && mode === null && (
          <div className="flex flex-wrap gap-2">
            {isToday && !appt.checkedInAt && <Button size="sm" icon="check-circle" onClick={() => doIt((api) => api.checkIn(appt.id), t('checkedInDone'))}>{t('checkIn')}</Button>}
            {started && <Button size="sm" variant="secondary" icon="check" onClick={() => doIt((api) => api.complete(appt.id))}>{t('complete')}</Button>}
            {started && <Button size="sm" variant="secondary" icon="alert" onClick={() => { setMode('no_show'); void loadPreview('no_show'); }}>{t('noShow')}</Button>}
            {!started && <Button size="sm" variant="secondary" icon="repeat" onClick={() => setMode('move')}>{t('move')}</Button>}
            <Button size="sm" variant="secondary" icon="gift" onClick={() => setMode('voucher')}>{t('applyVoucher')}</Button>
            {!started && <Button size="sm" variant="danger" icon="x" onClick={() => { setMode('cancel'); void loadPreview('auto'); }}>{t('cancelAppt')}</Button>}
          </div>
        )}
        {mode === 'cancel' && (
          <div className="flex flex-col gap-2.5 rounded-lg border border-line-soft p-3">
            <label className="flex items-center justify-between gap-2"><span>{t('byBusiness')}</span><Toggle checked={byBusiness} label={t('byBusiness')} onChange={(v) => { setByBusiness(v); void loadPreview(v ? 'business' : 'auto'); }} /></label>
            {!byBusiness && <label className="flex items-center justify-between gap-2"><span>{t('waiveFee')}</span><Toggle checked={waive} label={t('waiveFee')} onChange={(v) => { setWaive(v); void loadPreview('auto', v); }} /></label>}
            {preview && <PolicyPreview p={preview} />}
            <Field label={t('reason')} optional>{({ id }) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
            <div className="flex gap-2"><Button variant="danger" disabled={action.pending || !preview} onClick={() => doIt((api) => api.cancel(appt.id, { byBusiness, waiveFee: waive, reason: reason || undefined }), t('cancelledDone'))}>{t('confirmCancel')}</Button><Button variant="secondary" onClick={() => setMode(null)}>{t('back')}</Button></div>
          </div>
        )}
        {mode === 'no_show' && (
          <div className="flex flex-col gap-2.5 rounded-lg border border-line-soft p-3">
            <label className="flex items-center justify-between gap-2"><span>{t('waiveFee')}</span><Toggle checked={waive} label={t('waiveFee')} onChange={(v) => { setWaive(v); void loadPreview('no_show', v); }} /></label>
            {preview && <PolicyPreview p={preview} />}
            <div className="flex gap-2"><Button variant="danger" disabled={action.pending} onClick={() => doIt((api) => api.noShow(appt.id, waive), t('noShowDone'))}>{t('confirmNoShow')}</Button><Button variant="secondary" onClick={() => setMode(null)}>{t('back')}</Button></div>
          </div>
        )}
        {mode === 'voucher' && (
          <div className="flex flex-col gap-2.5 rounded-lg border border-line-soft p-3">
            <Field label={t('voucherCode')} hint={t('voucherHint', { currency: appt.price.currency })}>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={code} onChange={(e) => setCode(e.target.value)} placeholder="GV-XXXX-XXXX" />}</Field>
            <div className="flex gap-2"><Button disabled={!code || action.pending} onClick={async () => { const r = await action.run((api) => api.applyVoucher(appt.id, code)); if (r) { setNote(t('voucherApplied', { amount: new Intl.NumberFormat(locale, { style: 'currency', currency: r.applied.currency }).format(r.applied.amount / 100) })); onChanged(); } }}>{t('apply')}</Button><Button variant="secondary" onClick={() => setMode(null)}>{t('back')}</Button></div>
          </div>
        )}
        {mode === 'move' && (
          <div className="flex flex-col gap-2.5 rounded-lg border border-line-soft p-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('date')}>{({ id }) => <Input id={id} type="date" value={mv.date} onChange={(e) => (setMv({ ...mv, date: e.target.value }), setMvCheck(null))} />}</Field>
              <Field label={t('time')}>{({ id }) => <Input id={id} type="time" step={900} value={mv.time} onChange={(e) => (setMv({ ...mv, time: e.target.value }), setMvCheck(null))} />}</Field>
            </div>
            <Field label={t('practitioner')}>{({ id }) => <Select id={id} value={mv.practitionerId} onChange={(e) => (setMv({ ...mv, practitionerId: e.target.value }), setMvCheck(null))}>{day.practitioners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
            <Field label={t('room')}>{({ id }) => <Select id={id} value={mv.resourceId} onChange={(e) => (setMv({ ...mv, resourceId: e.target.value }), setMvCheck(null))}><option value="">{t('anyRoom')}</option>{day.rooms.filter((r) => r.kind === 'room').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>
            {mvCheck && (mvCheck.ok ? <Banner tone="success">{t('noConflictsBody')}</Banner> : <Banner tone="danger" title={t('conflicts')}><ul className="list-disc pl-4">{mvCheck.conflicts.map((c, i) => <li key={i}>{c.message}</li>)}{!mvCheck.conflicts.length && mvCheck.error && <li>{mvCheck.error.message}</li>}</ul></Banner>)}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={action.pending} onClick={async () => setMvCheck((await action.run((api) => api.move(appt.id, { startsAt: zonedToUtc(mv.date, mv.time, tz), practitionerId: mv.practitionerId, resourceId: mv.resourceId || undefined, dryRun: true }))) ?? null)}>{t('checkConflicts')}</Button>
              <Button disabled={!mvCheck?.ok || action.pending} onClick={async () => { const r = await action.run((api) => api.move(appt.id, { startsAt: zonedToUtc(mv.date, mv.time, tz), practitionerId: mv.practitionerId, resourceId: mv.resourceId || undefined, dryRun: false })); if (r?.ok) onChanged(); else if (r) setMvCheck(r); }}>{t('confirmMove')}</Button>
              <Button variant="ghost" onClick={() => setMode(null)}>{t('back')}</Button>
            </div>
            <p className="text-xs text-stone">{t('moveAtomic')}</p>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function BookingDrawer({ day, preset, onClose, onBooked }: { day: CalendarDay; preset: { practitionerId?: string; time?: string }; onClose: () => void; onBooked: () => void }) {
  const t = useTranslations('wellnessFull.calendar');
  const locale = useLocale();
  const app = useApp();
  const tz = day.location.timeZone;
  const services = useWellness(app.locations, (api) => api.services(), []);
  const clients = useWellness(app.locations, (api) => api.clients(''), [], app.can('customers.read'));
  const action = useWellnessAction(app.locations);
  const [serviceId, setServiceId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [practitionerId, setPractitionerId] = useState(preset.practitionerId ?? '');
  const [date, setDate] = useState(day.date);
  const [time, setTime] = useState(preset.time ?? '');
  const [customerId, setCustomerId] = useState('');
  const [contact, setContact] = useState({ name: '', email: '' });
  const [partner, setPartner] = useState({ name: '', email: '' });
  const [voucherCode, setVoucherCode] = useState('');
  const [outside, setOutside] = useState(false);
  const menu = useMemo(() => (services.status === 'ready' ? services.data.filter((s) => s.active && (!s.locationId || s.locationId === day.location.id) && (s.variants.length ? s.variants.some((v) => v.prices.some((p) => p.locationId === day.location.id)) : s.currency === day.location.currency)) : []), [services, day.location]);
  const svc: WService | undefined = menu.find((s) => s.id === serviceId);
  const slots = useWellness(app.locations, (api) => api.slots(day.location.id, serviceId, date, variantId || undefined, practitionerId || undefined), [serviceId, variantId, date, practitionerId], !!serviceId);
  const submit = async () => {
    const r = await action.run((api) => api.book({ locationId: day.location.id, serviceId, variantId: variantId || undefined, practitionerId: practitionerId || undefined, startsAt: zonedToUtc(date, time, tz), customerId: customerId || undefined, contact: customerId ? undefined : contact, partner: svc?.practitionersRequired === 2 && partner.email ? partner : undefined, voucherCode: voucherCode || undefined, outsideAvailability: outside }));
    if (r) onBooked();
  };
  return (
    <Drawer open onClose={onClose} kicker={`${t('newBooking')} · ${day.location.name}`} title={t('newBookingTitle')}>
      <div className="flex flex-col gap-3">
        <Field label={t('service')}>{({ id }) => <Select id={id} value={serviceId} onChange={(e) => { setServiceId(e.target.value); setVariantId(''); setTime(''); }}><option value="">{t('chooseService')}</option>{menu.map((s) => <option key={s.id} value={s.id}>{s.name}{s.practitionersRequired > 1 ? ` (${t('couples')})` : ''}</option>)}</Select>}</Field>
        {svc && svc.variants.length > 0 && <Field label={t('option')}>{({ id }) => <Select id={id} value={variantId} onChange={(e) => setVariantId(e.target.value)}><option value="">{t('defaultOption')}</option>{svc.variants.filter((v) => v.prices.some((p) => p.locationId === day.location.id)).map((v) => { const p = v.prices.find((x) => x.locationId === day.location.id)!; return <option key={v.id} value={v.id}>{v.name} · {new Intl.NumberFormat(locale, { style: 'currency', currency: p.currency }).format(p.priceMinor / 100)}</option>; })}</Select>}</Field>}
        <Field label={t('practitioner')}>{({ id }) => <Select id={id} value={practitionerId} onChange={(e) => setPractitionerId(e.target.value)}><option value="">{t('anyAvailable')}</option>{day.practitioners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('date')}>{({ id }) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label={t('time')} hint={t('timeHint', { zone: zoneLabel(tz, locale) })}>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
        </div>
        {serviceId && slots.status === 'ready' && (
          <div className="flex flex-wrap gap-1.5" aria-label={t('openSlots')}>
            {slots.data.length ? slots.data.slice(0, 16).map((s) => { const hh = hhmmIn(s.startsAt, tz); return <button key={s.startsAt} type="button" onClick={() => setTime(hh)} className={cx('h-9 rounded-full border px-3 text-xs font-bold', time === hh ? 'border-ink bg-ink text-white' : 'border-line-soft')}>{fmtTime(s.startsAt, tz, locale)}</button>; }) : <span className="text-xs text-stone">{t('noSlots')}</span>}
          </div>
        )}
        {clients.status === 'ready' && <Field label={t('existingClient')} optional>{({ id }) => <Select id={id} value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">{t('newClient')}</option>{clients.data.map((c) => <option key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ''}</option>)}</Select>}</Field>}
        {!customerId && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('clientName')}>{({ id }) => <Input id={id} value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />}</Field>
            <Field label={t('clientEmail')}>{({ id }) => <Input id={id} type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />}</Field>
          </div>
        )}
        {svc?.practitionersRequired === 2 && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('partnerName')} optional>{({ id }) => <Input id={id} value={partner.name} onChange={(e) => setPartner({ ...partner, name: e.target.value })} />}</Field>
            <Field label={t('partnerEmail')} optional>{({ id }) => <Input id={id} type="email" value={partner.email} onChange={(e) => setPartner({ ...partner, email: e.target.value })} />}</Field>
          </div>
        )}
        <Field label={t('voucherCode')} optional>{({ id }) => <Input id={id} value={voucherCode} onChange={(e) => setVoucherCode(e.target.value)} placeholder="GV-XXXX-XXXX" />}</Field>
        <label className="flex items-center justify-between gap-2 text-[13px]"><span>{t('outsideHours')}</span><Toggle checked={outside} label={t('outsideHours')} onChange={setOutside} /></label>
        {action.error && <Banner tone="danger" live="assertive" title={t('bookFailed')}>{action.error.message}</Banner>}
        <Button disabled={!serviceId || !time || action.pending || (!customerId && (!contact.name || !contact.email))} onClick={submit}>{action.pending ? t('securing') : t('book')}</Button>
        <p className="text-xs text-stone">{t('bookAtomic')}</p>
      </div>
    </Drawer>
  );
}


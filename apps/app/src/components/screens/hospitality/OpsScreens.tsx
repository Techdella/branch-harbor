'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, Toggle, cx } from '@bh/ui';
import { fmtYmd } from '@/lib/format';
import { hosp, useHosp, useHospAction, type HkTask, type Property, type RateSetup } from '@/lib/hospitality/api';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty } from '../../ui/States';
import { HAsync, HkStatus, M, WithProperty, addDaysYmd, toMajor, toMinor } from './common';

// ───────────────────────── Rates & availability ─────────────────────────

export function RatesScreen() {
  const tOps = useTranslations('ops.hospitality.rates');
  return (
    <>
      <PageHeader icon="sliders" title={tOps('title')} description={tOps('description')} />
      <WithProperty>{(p, picker) => <RatesBody p={p} picker={picker} />}</WithProperty>
    </>
  );
}

function RatesBody({ p, picker }: { p: Property; picker: React.ReactNode }) {
  const t = useTranslations('hosp');
  const locale = useLocale();
  const [from, setFrom] = useState(p.today);
  const grid = useHosp(() => hosp.ratesGrid(p.locationId, from, 14), [p.locationId, from]);
  const setup = useHosp(() => hosp.rateSetup(p.locationId), [p.locationId]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        {picker}
        <Button size="sm" variant="secondary" icon="chevron-left" onClick={() => setFrom(addDaysYmd(from, -14))}>{t('grid.prev')}</Button>
        <Button size="sm" variant="secondary" iconRight="chevron-right" onClick={() => setFrom(addDaysYmd(from, 14))}>{t('grid.next')}</Button>
      </div>
      <HAsync res={grid} variant="calendar">
        {(g) => (
          <div className="overflow-x-auto rounded-xl bg-surface p-2" tabIndex={0} data-testid="rates-grid">
            <table className="w-full min-w-[960px] text-xs">
              <thead><tr><th className="p-2 text-start">{t('rates.roomAndPlan')}</th>{g.dates.map((d) => <th key={d} className="p-1 text-center">{fmtYmd(d, locale, { weekday: 'short', day: 'numeric' })}</th>)}</tr></thead>
              <tbody>
                {g.roomTypes.map((rt) => [
                  <tr key={rt.id} className="bg-canvas"><th className="p-2 text-start font-bold">{rt.name}</th>{rt.inventory.map((i) => <td key={i.date} className={cx('p-1 text-center font-semibold', i.available === 0 && 'text-danger')}>{t('rates.left', { count: i.available })}</td>)}</tr>,
                  ...rt.plans.map((pl) => (
                    <tr key={`${rt.id}${pl.ratePlanId}`} className="border-t border-line-soft">
                      <th className="p-2 text-start font-normal">{pl.name}{pl.derived && <span className="text-stone"> · {t('rates.derived')}</span>}</th>
                      {pl.days.map((d) => (
                        <td key={d.date} className={cx('p-1 text-center', d.closed && 'bg-danger-bg')}>
                          <div className="font-semibold"><M value={d.price} /></div>
                          <div className="flex flex-wrap justify-center gap-0.5 text-[10px] text-stone">
                            {d.minStay && <span>{t('rates.minShort', { count: d.minStay })}</span>}
                            {d.closedToArrival && <span>{t('rates.cta')}</span>}
                            {d.closedToDeparture && <span>{t('rates.ctd')}</span>}
                            {d.closed && <span className="text-danger">{t('rates.closed')}</span>}
                          </div>
                        </td>
                      ))}
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
            <p className="mt-2 px-2 text-xs text-stone">{t('rates.legend', { currency: g.currency })}</p>
          </div>
        )}
      </HAsync>
      <HAsync res={setup} variant="detail">
        {(s) => (
          <div className="grid gap-3 lg:grid-cols-2">
            <BulkEditor p={p} plans={s.plans} roomTypes={s.roomTypes} onSaved={grid.reload} />
            <BasePrices p={p} setup={s} onSaved={() => { grid.reload(); setup.reload(); }} />
          </div>
        )}
      </HAsync>
    </div>
  );
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

function BulkEditor({ p, plans, roomTypes, onSaved }: { p: Property; plans: Array<{ id: string; name: string; derivedFromId: string | null }>; roomTypes: Array<{ id: string; name: string }>; onSaved: () => void }) {
  const t = useTranslations('hosp');
  const locale = useLocale();
  const act = useHospAction();
  const [planId, setPlanId] = useState(plans[0]?.id ?? '');
  const [types, setTypes] = useState<string[]>(roomTypes.map((x) => x.id));
  const [from, setFrom] = useState(p.today);
  const [to, setTo] = useState(addDaysYmd(p.today, 6));
  const [days, setDays] = useState<number[]>([]);
  const [price, setPrice] = useState('');
  const [minStay, setMinStay] = useState('');
  const [flags, setFlags] = useState<{ closed?: boolean; closedToArrival?: boolean; closedToDeparture?: boolean }>({});
  const [done, setDone] = useState<number | null>(null);
  const weekday = (d: number) => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + d)));
  return (
    <form className="flex flex-col gap-2 rounded-xl bg-surface p-4" onSubmit={async (e) => {
      e.preventDefault();
      const set: Record<string, unknown> = { ...flags };
      if (price) set.amountMinor = toMinor(price, p.currency);
      if (minStay) set.minStay = Number(minStay);
      const out = await act.run(() => hosp.setDaily({ ratePlanId: planId, roomTypeIds: types, from, to, weekdays: days.length ? days : undefined, set }));
      if (out) { setDone(out.updated); onSaved(); }
    }}>
      <h2 className="text-sm font-bold">{t('rates.bulkTitle')}</h2>
      <Field label={t('rates.plan')}>{({ id }) => <Select id={id} value={planId} onChange={(e) => setPlanId(e.target.value)}>{plans.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
      <fieldset className="flex flex-wrap gap-2"><legend className="mb-1 text-[13px] font-bold">{t('rates.roomTypes')}</legend>{roomTypes.map((x) => <label key={x.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={types.includes(x.id)} onChange={(e) => setTypes(e.target.checked ? [...types, x.id] : types.filter((y) => y !== x.id))} />{x.name}</label>)}</fieldset>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('reports.from')}>{({ id }) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('reports.to')}>{({ id }) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <fieldset className="flex flex-wrap gap-2"><legend className="mb-1 text-[13px] font-bold">{t('rates.weekdays')}</legend>{WEEKDAYS.map((d) => <label key={d} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={days.includes(d)} onChange={(e) => setDays(e.target.checked ? [...days, d] : days.filter((x) => x !== d))} />{weekday(d)}</label>)}</fieldset>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('rates.price', { currency: p.currency })} optional hint={t('rates.priceHint')}>{({ id }) => <Input id={id} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
        <Field label={t('rates.minStay')} optional>{({ id }) => <Input id={id} type="number" min={1} value={minStay} onChange={(e) => setMinStay(e.target.value)} />}</Field>
      </div>
      <div className="flex flex-wrap gap-4">
        {(['closed', 'closedToArrival', 'closedToDeparture'] as const).map((k) => <span key={k} className="flex items-center gap-2 text-sm"><Toggle checked={!!flags[k]} onChange={(v) => setFlags({ ...flags, [k]: v })} label={t(`rates.flag.${k}`)} />{t(`rates.flag.${k}`)}</span>)}
      </div>
      {act.error && <Banner tone="danger" icon="alert">{act.error.message}</Banner>}
      {done !== null && <Banner tone="success" icon="check">{t('rates.updated', { count: done })}</Banner>}
      <Button type="submit" size="sm" loading={act.pending} disabled={!types.length}>{t('rates.apply')}</Button>
    </form>
  );
}

function BasePrices({ p, setup, onSaved }: { p: Property; setup: RateSetup; onSaved: () => void }) {
  const t = useTranslations('hosp');
  const act = useHospAction();
  const own = setup.plans.filter((x) => !x.derivedFromId);
  const [planId, setPlanId] = useState(own[0]?.id ?? '');
  const base = (rt: string) => setup.prices.find((x) => x.ratePlanId === planId && x.roomTypeId === rt && x.seasonId === null);
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <form className="flex flex-col gap-2 rounded-xl bg-surface p-4" onSubmit={async (e) => {
      e.preventDefault();
      const prices = Object.entries(values).filter(([, v]) => v !== '').map(([roomTypeId, v]) => ({ roomTypeId, seasonId: null, amountMinor: toMinor(v, p.currency), weekdayAmounts: base(roomTypeId)?.weekdayAmounts ?? {}, currency: p.currency }));
      if (prices.length && (await act.run(() => hosp.setPrices(planId, prices)))) { setValues({}); onSaved(); }
    }}>
      <h2 className="text-sm font-bold">{t('rates.baseTitle')}</h2>
      <p className="text-xs text-stone">{t('rates.baseNote', { currency: p.currency })}</p>
      <Field label={t('rates.plan')}>{({ id }) => <Select id={id} value={planId} onChange={(e) => { setPlanId(e.target.value); setValues({}); }}>{own.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
      {setup.roomTypes.filter((x) => x.active).map((rt) => (
        <Field key={rt.id} label={rt.name} hint={base(rt.id) ? t('rates.current', { amount: toMajor(base(rt.id)!.amountMinor, p.currency) }) : t('rates.noPrice')}>
          {({ id }) => <Input id={id} inputMode="decimal" value={values[rt.id] ?? ''} onChange={(e) => setValues({ ...values, [rt.id]: e.target.value })} />}
        </Field>
      ))}
      <div className="text-xs text-stone">{t('rates.derivedNote')} {setup.plans.filter((x) => x.derivedFromId).map((x) => `${x.name} (${(x.adjustmentBps ?? 0) / 100}%)`).join(', ')}</div>
      {act.error && <Banner tone="danger" icon="alert">{act.error.message}</Banner>}
      <Button type="submit" size="sm" loading={act.pending}>{t('rates.saveBase')}</Button>
    </form>
  );
}

// ───────────────────────── Housekeeping ─────────────────────────

export function HousekeepingScreen() {
  const tOps = useTranslations('ops.hospitality.housekeeping');
  return (
    <>
      <PageHeader icon="check-circle" title={tOps('title')} description={tOps('description')} />
      <WithProperty>{(p, picker) => <HkBody p={p} picker={picker} />}</WithProperty>
    </>
  );
}

const COLS = ['todo', 'in_progress', 'done'] as const;

function HkBody({ p, picker }: { p: Property; picker: React.ReactNode }) {
  const t = useTranslations('hosp');
  const [date, setDate] = useState(p.today);
  const res = useHosp(() => hosp.housekeeping(p.locationId, date), [p.locationId, date]);
  const act = useHospAction();
  const [ooo, setOoo] = useState<{ roomId: string; reason: string; until: string } | null>(null);
  const move = async (task: HkTask, status: string) => { if (await act.run(() => hosp.updateTask(task.id, { status }))) res.reload(); };
  const assign = async (task: HkTask, userId: string) => { if (await act.run(() => hosp.updateTask(task.id, { assigneeUserId: userId || null }))) res.reload(); };
  const setStatus = async (roomId: string, status: string, extra: { reason?: string; until?: string } = {}) => { if (await act.run(() => hosp.roomStatus(roomId, { status, ...extra }))) { setOoo(null); res.reload(); } };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        {picker}
        <Field label={t('hkb.date')}>{({ id }) => <Input id={id} type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />}</Field>
      </div>
      {act.error && <Banner tone="danger" icon="alert">{act.error.message}</Banner>}
      <HAsync res={res}>
        {(b) => (
          <>
            <div className="grid gap-3 md:grid-cols-3" data-testid="hk-board">
              {COLS.map((col) => (
                <section key={col} className="rounded-xl bg-surface p-3">
                  <h2 className="mb-2 text-sm font-bold">{t(`task.status.${col}`)} <span className="text-stone">({b.tasks.filter((x) => x.status === col).length})</span></h2>
                  <ul className="flex flex-col gap-2">
                    {b.tasks.filter((x) => x.status === col).map((task) => (
                      <li key={task.id} className="rounded-lg border border-line-soft p-2 text-sm">
                        <div className="flex items-center justify-between gap-2"><strong>{t('res.roomNo', { number: task.roomNumber })}</strong><Badge tone={task.kind === 'maintenance' ? 'danger' : task.kind === 'departure_clean' ? 'warning' : 'neutral'}>{t(`task.kind.${task.kind}` as 'task.kind.stayover')}</Badge></div>
                        {task.notes && <p className="text-xs text-stone">{task.notes}</p>}
                        <div className="mt-1 flex flex-wrap items-end gap-2">
                          <Select aria-label={t('hkb.assignee')} className="h-9 text-xs" value={task.assignee?.id ?? ''} onChange={(e) => assign(task, e.target.value)}>
                            <option value="">{t('hkb.unassigned')}</option>
                            {b.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </Select>
                          {col === 'todo' && <Button size="sm" variant="secondary" onClick={() => move(task, 'in_progress')}>{t('hkb.start')}</Button>}
                          {col !== 'done' && <Button size="sm" onClick={() => move(task, 'done')}>{t('hkb.done')}</Button>}
                          {col === 'done' && <Button size="sm" variant="ghost" onClick={() => move(task, 'todo')}>{t('hkb.reopen')}</Button>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            <section className="overflow-x-auto rounded-xl bg-surface p-3" tabIndex={0}>
              <h2 className="mb-2 text-sm font-bold">{t('hkb.rooms')}</h2>
              <table className="w-full min-w-[640px] text-sm">
                <tbody>
                  {b.rooms.map((r) => (
                    <tr key={r.id} className="border-t border-line-soft">
                      <td className="py-1.5 font-bold">{r.number}</td>
                      <td className="text-xs text-stone">{r.roomType}</td>
                      <td>{t(`occ.${r.occupancy}` as 'occ.vacant')}</td>
                      <td><HkStatus status={r.hkStatus} /></td>
                      <td className="flex flex-wrap justify-end gap-1 py-1">
                        {r.hkStatus === 'dirty' && <Button size="sm" variant="secondary" onClick={() => setStatus(r.id, 'clean')}>{t('hkb.markClean')}</Button>}
                        {r.hkStatus === 'clean' && <Button size="sm" variant="secondary" onClick={() => setStatus(r.id, 'inspected')}>{t('hkb.markInspected')}</Button>}
                        {(r.hkStatus === 'clean' || r.hkStatus === 'inspected') && <Button size="sm" variant="ghost" onClick={() => setStatus(r.id, 'dirty')}>{t('hkb.markDirty')}</Button>}
                        {r.hkStatus === 'out_of_order' ? <Button size="sm" variant="secondary" onClick={() => setStatus(r.id, 'dirty')}>{t('hkb.backInService')}</Button>
                          : <Button size="sm" variant="ghost" onClick={() => setOoo({ roomId: r.id, reason: '', until: addDaysYmd(p.today, 1) })}>{t('hkb.outOfOrder')}</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            {ooo && (
              <form className="flex flex-wrap items-end gap-2 rounded-xl bg-surface p-3" onSubmit={(e) => { e.preventDefault(); void setStatus(ooo.roomId, 'out_of_order', { reason: ooo.reason, until: ooo.until }); }}>
                <Field label={t('hkb.reason')}>{({ id }) => <Input id={id} required value={ooo.reason} onChange={(e) => setOoo({ ...ooo, reason: e.target.value })} />}</Field>
                <Field label={t('hkb.until')}>{({ id }) => <Input id={id} type="date" required value={ooo.until} onChange={(e) => setOoo({ ...ooo, until: e.target.value })} />}</Field>
                <Button type="submit" size="sm" variant="danger">{t('hkb.outOfOrder')}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setOoo(null)}>{t('common.close')}</Button>
              </form>
            )}
          </>
        )}
      </HAsync>
    </div>
  );
}

// ───────────────────────── Outlet ─────────────────────────

export function OutletScreen() {
  const tOps = useTranslations('ops.hospitality.outlet');
  return (
    <>
      <PageHeader icon="utensils" title={tOps('title')} description={tOps('description')} />
      <WithProperty>{(p, picker) => <OutletBody p={p} picker={picker} />}</WithProperty>
    </>
  );
}

function OutletBody({ p, picker }: { p: Property; picker: React.ReactNode }) {
  const t = useTranslations('hosp');
  const res = useHosp(() => (p.outletEnabled ? hosp.outlet(p.locationId) : Promise.resolve(null)), [p.locationId, p.outletEnabled]);
  const act = useHospAction();
  const [reservationId, setReservationId] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [done, setDone] = useState<string | null>(null);
  if (!p.outletEnabled) return <div className="flex flex-col gap-3">{picker}<Empty icon="utensils" title={t('outlet.offTitle')} body={t('outlet.offBody')} /></div>;
  return (
    <div className="flex flex-col gap-3">
      {picker}
      <HAsync res={res}>
        {(o) => o && (
          <form className="grid gap-3 lg:grid-cols-[2fr_1fr]" onSubmit={async (e) => {
            e.preventDefault();
            const lines = Object.entries(qty).filter(([, n]) => n > 0).map(([menuItemId, quantity]) => ({ menuItemId, quantity, modifierIds: [] }));
            const out = await act.run(() => hosp.chargeToRoom(p.locationId, { reservationId, lines }));
            if (out) { setDone(out.order.orderNumber); setQty({}); }
          }}>
            <section className="rounded-xl bg-surface p-4">
              <h2 className="mb-2 text-sm font-bold">{o.name}</h2>
              {o.items.length === 0 ? <p className="text-sm text-stone">{t('outlet.noMenu')}</p> : (
                <ul className="flex flex-col divide-y divide-line-soft">
                  {o.items.map((it) => (
                    <li key={it.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span>{it.name}<span className="block text-xs text-stone">{it.category}{!it.available && it.unavailableReason ? ` · ${it.unavailableReason}` : ''}</span></span>
                      <span className="flex items-center gap-2"><M value={it.price} /><Input aria-label={t('outlet.qty', { item: it.name })} className="w-16" type="number" min={0} max={50} disabled={!it.available} value={qty[it.id] ?? 0} onChange={(e) => setQty({ ...qty, [it.id]: Number(e.target.value) })} /></span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="flex flex-col gap-2 rounded-xl bg-surface p-4">
              <Field label={t('outlet.guest')}>{({ id }) => <Select id={id} required value={reservationId} onChange={(e) => setReservationId(e.target.value)}><option value="">{t('outlet.pickGuest')}</option>{o.inHouse.map((g) => <option key={g.reservationId} value={g.reservationId}>{g.roomNumber ? `${g.roomNumber} · ` : ''}{g.guestName} ({g.code})</option>)}</Select>}</Field>
              <p className="text-xs text-stone">{t('outlet.note')}</p>
              {act.error && <Banner tone="danger" icon="alert">{act.error.message}</Banner>}
              {done && <Banner tone="success" icon="check">{t('outlet.charged', { order: done })}</Banner>}
              <Button type="submit" size="sm" loading={act.pending} disabled={!reservationId || !Object.values(qty).some((n) => n > 0)}>{t('outlet.charge')}</Button>
            </section>
          </form>
        )}
      </HAsync>
    </div>
  );
}

// ───────────────────────── Setup & channels ─────────────────────────

export function SetupScreen() {
  const tOps = useTranslations('ops.hospitality.setup');
  return (
    <>
      <PageHeader icon="settings" title={tOps('title')} description={tOps('description')} />
      <WithProperty>{(p, picker) => <SetupBody p={p} picker={picker} />}</WithProperty>
    </>
  );
}

function SetupBody({ p, picker }: { p: Property; picker: React.ReactNode }) {
  const t = useTranslations('hosp');
  const setup = useHosp(() => hosp.rateSetup(p.locationId), [p.locationId]);
  const rooms = useHosp(() => hosp.rooms(p.locationId), [p.locationId]);
  const act = useHospAction();
  const [settings, setSettings] = useState({ checkInTime: p.checkInTime, checkOutTime: p.checkOutTime, requireInspected: p.requireInspected, outletEnabled: p.outletEnabled, preArrivalDays: p.preArrivalDays });
  const [saved, setSaved] = useState(false);
  const [room, setRoom] = useState({ roomTypeId: '', number: '', beds: 0 });
  const [tax, setTax] = useState({ name: '', kind: 'per_person_per_night', value: '' });
  return (
    <div className="flex flex-col gap-3">
      {picker}
      {act.error && <Banner tone="danger" icon="alert">{act.error.message}</Banner>}
      <form className="grid gap-2 rounded-xl bg-surface p-4 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); setSaved(false); if (await act.run(() => hosp.saveProperty(p.locationId, settings))) setSaved(true); }}>
        <h2 className="text-sm font-bold sm:col-span-2">{t('setup.property')}</h2>
        <Field label={t('setup.checkIn')}>{({ id }) => <Input id={id} type="time" value={settings.checkInTime} onChange={(e) => setSettings({ ...settings, checkInTime: e.target.value })} />}</Field>
        <Field label={t('setup.checkOut')}>{({ id }) => <Input id={id} type="time" value={settings.checkOutTime} onChange={(e) => setSettings({ ...settings, checkOutTime: e.target.value })} />}</Field>
        <Field label={t('setup.preArrival')}>{({ id }) => <Input id={id} type="number" min={0} max={30} value={settings.preArrivalDays} onChange={(e) => setSettings({ ...settings, preArrivalDays: Number(e.target.value) })} />}</Field>
        <div className="flex flex-col gap-2 pt-6">
          <span className="flex items-center gap-2 text-sm"><Toggle checked={settings.requireInspected} onChange={(v) => setSettings({ ...settings, requireInspected: v })} label={t('setup.requireInspected')} />{t('setup.requireInspected')}</span>
          <span className="flex items-center gap-2 text-sm"><Toggle checked={settings.outletEnabled} onChange={(v) => setSettings({ ...settings, outletEnabled: v })} label={t('setup.outlet')} />{t('setup.outlet')}</span>
        </div>
        {saved && <Banner tone="success" icon="check">{t('setup.saved')}</Banner>}
        <div className="sm:col-span-2"><Button type="submit" size="sm" loading={act.pending}>{t('setup.save')}</Button></div>
      </form>
      <HAsync res={setup} variant="detail">
        {(s) => (
          <div className="grid gap-3 lg:grid-cols-2">
            <section className="rounded-xl bg-surface p-4">
              <h2 className="mb-2 text-sm font-bold">{t('setup.roomTypes')}</h2>
              <ul className="flex flex-col gap-1 text-sm">{s.roomTypes.map((rt) => <li key={rt.id} className="flex justify-between gap-2"><span><strong>{rt.name}</strong> <span className="text-xs text-stone">{rt.code} · {t(`setup.kind.${rt.kind}` as 'setup.kind.room')}</span></span><span className="text-xs text-stone">{t('setup.occupancy', { base: rt.baseOccupancy, max: rt.maxOccupancy })}</span></li>)}</ul>
              <h3 className="mb-1 mt-3 text-sm font-bold">{t('setup.rooms')}</h3>
              <HAsync res={rooms}>{(rs) => <p className="text-sm">{rs.map((r) => r.number).join(', ') || t('setup.noRooms')}</p>}</HAsync>
              <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => hosp.addRoom({ locationId: p.locationId, roomTypeId: room.roomTypeId || s.roomTypes[0]!.id, number: room.number, beds: room.beds }))) { setRoom({ ...room, number: '' }); rooms.reload(); } }}>
                <Field label={t('setup.roomType')}>{({ id }) => <Select id={id} value={room.roomTypeId} onChange={(e) => setRoom({ ...room, roomTypeId: e.target.value })}>{s.roomTypes.map((rt) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}</Select>}</Field>
                <Field label={t('setup.number')}>{({ id }) => <Input id={id} className="w-24" required value={room.number} onChange={(e) => setRoom({ ...room, number: e.target.value })} />}</Field>
                {s.roomTypes.find((x) => x.id === (room.roomTypeId || s.roomTypes[0]?.id))?.kind === 'dorm' && <Field label={t('setup.beds')}>{({ id }) => <Input id={id} className="w-20" type="number" min={1} value={room.beds} onChange={(e) => setRoom({ ...room, beds: Number(e.target.value) })} />}</Field>}
                <Button type="submit" size="sm" variant="secondary" disabled={!s.roomTypes.length}>{t('setup.addRoom')}</Button>
              </form>
            </section>
            <section className="rounded-xl bg-surface p-4">
              <h2 className="mb-2 text-sm font-bold">{t('setup.taxes')}</h2>
              <p className="mb-2 text-xs text-stone">{t('setup.taxNote')}</p>
              <ul className="flex flex-col gap-1 text-sm">
                {s.taxes.map((x) => <li key={x.id} className={cx('flex justify-between gap-2', !x.active && 'opacity-60')}><span>{x.name} <span className="text-xs text-stone">{t(`tax.${x.kind}` as 'tax.percent')}{x.inclusive ? ` · ${t('tax.inclusive')}` : ''}</span></span><span className="tabular-nums">{x.kind === 'percent' ? `${(x.rateBps ?? 0) / 100}%` : <M value={{ amount: x.amountMinor ?? 0, currency: p.currency as 'EUR' }} />}</span></li>)}
                {!s.taxes.length && <li className="text-stone">{t('setup.noTaxes')}</li>}
              </ul>
              <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={async (e) => {
                e.preventDefault();
                const body = tax.kind === 'percent' ? { locationId: p.locationId, name: tax.name, kind: tax.kind, rateBps: Math.round(Number(tax.value) * 100) } : { locationId: p.locationId, name: tax.name, kind: tax.kind, amountMinor: toMinor(tax.value, p.currency) };
                if (await act.run(() => hosp.addTax(body))) { setTax({ ...tax, name: '', value: '' }); setup.reload(); }
              }}>
                <Field label={t('setup.taxName')}>{({ id }) => <Input id={id} required value={tax.name} onChange={(e) => setTax({ ...tax, name: e.target.value })} />}</Field>
                <Field label={t('setup.taxKind')}>{({ id }) => <Select id={id} value={tax.kind} onChange={(e) => setTax({ ...tax, kind: e.target.value })}>{['percent', 'per_night', 'per_person_per_night', 'per_stay'].map((k) => <option key={k} value={k}>{t(`tax.${k}` as 'tax.percent')}</option>)}</Select>}</Field>
                <Field label={tax.kind === 'percent' ? t('setup.taxRate') : t('setup.taxAmount', { currency: p.currency })}>{({ id }) => <Input id={id} className="w-24" required inputMode="decimal" value={tax.value} onChange={(e) => setTax({ ...tax, value: e.target.value })} />}</Field>
                <Button type="submit" size="sm" variant="secondary">{t('setup.addTax')}</Button>
              </form>
              <h2 className="mb-1 mt-4 text-sm font-bold">{t('setup.policies')}</h2>
              <ul className="flex flex-col gap-1 text-sm">{s.policies.map((x) => <li key={x.id}>{x.name}</li>)}</ul>
            </section>
          </div>
        )}
      </HAsync>
    </div>
  );
}

export function ChannelsScreen() {
  const tOps = useTranslations('ops.hospitality.channels');
  return (
    <>
      <PageHeader icon="plug" title={tOps('title')} description={tOps('description')} />
      <WithProperty>{(p, picker) => <ChannelsBody p={p} picker={picker} />}</WithProperty>
    </>
  );
}

function ChannelsBody({ p, picker }: { p: Property; picker: React.ReactNode }) {
  const t = useTranslations('hosp');
  const res = useHosp(() => hosp.channels(), []);
  const act = useHospAction();
  const [preview, setPreview] = useState<{ provider: string; days: number; payload: unknown } | null>(null);
  return (
    <div className="flex flex-col gap-3">
      {picker}
      <Banner tone="info" icon="info" title={t('channels.sandboxTitle')}>{t('channels.sandboxBody')}</Banner>
      <HAsync res={res}>
        {(c) => (
          <div className="grid gap-3 md:grid-cols-3">
            {c.providers.map((pr) => (
              <section key={pr.provider} className="flex flex-col gap-2 rounded-xl bg-surface p-4">
                <div className="flex items-center justify-between"><h2 className="text-sm font-bold">{pr.name}</h2><Badge tone="neutral">{t('channels.sandbox')}</Badge></div>
                <Button size="sm" variant="secondary" loading={act.pending} onClick={async () => { const out = await act.run(() => hosp.channelPreview(pr.provider, { locationId: p.locationId, from: p.today, nights: 7, record: true })); if (out) { setPreview({ provider: pr.name, days: out.days, payload: out.payload }); res.reload(); } }}>{t('channels.preview')}</Button>
                <p className="text-xs text-stone">{t('channels.exports', { count: c.exports.filter((e) => e.provider === pr.provider && e.locationId === p.locationId).length })}</p>
              </section>
            ))}
          </div>
        )}
      </HAsync>
      {act.error && <Banner tone="danger" icon="alert">{act.error.message}</Banner>}
      {preview && (
        <section className="rounded-xl bg-surface p-4">
          <h2 className="mb-2 text-sm font-bold">{t('channels.previewTitle', { provider: preview.provider, count: preview.days })}</h2>
          <pre className="max-h-96 overflow-auto rounded bg-canvas p-2 text-[11px]">{JSON.stringify(preview.payload, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}

'use client';

import { Fragment, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Input, Select, Tabs, cx } from '@bh/ui';
import { fmtYmd } from '@/lib/format';
import { hosp, useHosp, useHospAction, type AvailabilityRow, type Grid, type Property } from '@/lib/hospitality/api';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty } from '../../ui/States';
import { HAsync, HkStatus, M, ResStatus, WithProperty, addDaysYmd } from './common';
import { ReservationDrawer } from './ReservationDrawer';

const BAR: Record<string, string> = {
  hold: 'bg-warning-bg text-warning border-warning/40',
  confirmed: 'bg-info-bg text-info border-info/40',
  checked_in: 'bg-success-bg text-success border-success/40',
  checked_out: 'bg-canvas text-graphite border-line',
};

/** Rooms × nights: who sleeps where, unassigned stays, out-of-order blocks and per-type availability. */
export function GridScreen() {
  const tOps = useTranslations('ops.hospitality.grid');
  return (
    <>
      <PageHeader icon="calendar" title={tOps('title')} description={tOps('description')} />
      <WithProperty>{(p, picker) => <GridBody p={p} picker={picker} />}</WithProperty>
    </>
  );
}

function GridBody({ p, picker }: { p: Property; picker: React.ReactNode }) {
  const t = useTranslations('hosp');
  const locale = useLocale();
  const [from, setFrom] = useState(addDaysYmd(p.today, -1));
  const [nights, setNights] = useState(14);
  const [open, setOpen] = useState<string | null>(null);
  const res = useHosp(() => hosp.grid(p.locationId, from, nights), [p.locationId, from, nights]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        {picker}
        <Button size="sm" variant="secondary" icon="chevron-left" onClick={() => setFrom(addDaysYmd(from, -7))}>{t('grid.prev')}</Button>
        <Button size="sm" variant="secondary" onClick={() => setFrom(addDaysYmd(p.today, -1))}>{t('grid.today')}</Button>
        <Button size="sm" variant="secondary" iconRight="chevron-right" onClick={() => setFrom(addDaysYmd(from, 7))}>{t('grid.next')}</Button>
        <Field label={t('grid.nights')}>{({ id }) => <Select id={id} value={nights} onChange={(e) => setNights(Number(e.target.value))}>{[7, 14, 21, 28].map((n) => <option key={n} value={n}>{n}</option>)}</Select>}</Field>
      </div>
      <HAsync res={res} variant="calendar">{(g) => <GridTable g={g} locale={locale} onOpen={setOpen} />}</HAsync>
      {res.data && res.data.unassigned.length > 0 && (
        <section className="rounded-xl bg-surface p-4">
          <h2 className="mb-2 text-sm font-bold">{t('grid.unassigned', { count: res.data.unassigned.length })}</h2>
          <ul className="flex flex-col gap-1">
            {res.data.unassigned.map((u) => (
              <li key={u.reservationRoomId}>
                <button type="button" className="text-start text-sm underline-offset-2 hover:underline" onClick={() => setOpen(u.reservationId)}>
                  <strong>{u.code}</strong> · {u.guestName} · {res.data!.roomTypes.find((x) => x.id === u.roomTypeId)?.name} · {fmtYmd(u.arrival, locale, { day: 'numeric', month: 'short' })} → {fmtYmd(u.departure, locale, { day: 'numeric', month: 'short' })}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={res.reload} />
    </div>
  );
}

function GridTable({ g, locale, onOpen }: { g: Grid; locale: string; onOpen: (id: string) => void }) {
  const t = useTranslations('hosp');
  if (!g.rooms.length) return <Empty icon="bed" title={t('grid.noRoomsTitle')} body={t('grid.noRoomsBody')} />;
  const typeName = new Map(g.roomTypes.map((x) => [x.id, x.name]));
  return (
    <div className="overflow-x-auto rounded-xl bg-surface p-2" tabIndex={0} data-testid="room-grid">
      <table className="w-full min-w-[900px] border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-surface p-2 text-start">{t('grid.room')}</th>
            {g.dates.map((d) => (
              <th key={d} className={cx('min-w-[64px] p-1 text-center font-semibold', d === g.today && 'bg-lime/40')}>{fmtYmd(d, locale, { weekday: 'short', day: 'numeric' })}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {g.roomTypes.map((rt) => (
            <Fragment key={rt.id}>
              <tr className="bg-canvas">
                <th className="sticky left-0 z-10 bg-canvas p-2 text-start font-bold">{rt.name}</th>
                {rt.inventory.map((i) => <td key={i.date} className="p-1 text-center text-[11px] text-stone" title={t('grid.availTitle', { available: i.available, total: i.total })}>{i.available}/{i.total}</td>)}
              </tr>
              {g.rooms.filter((r) => r.roomTypeId === rt.id).map((room) => {
                const cells: React.ReactNode[] = [];
                for (let i = 0; i < g.dates.length; i += 1) {
                  const d = g.dates[i]!;
                  const block = room.blocks.find((b) => b.startDate <= d && d < b.endDate);
                  const stays = room.cells.filter((c) => c.date === d);
                  if (block) { cells.push(<td key={d} className="border-t border-line-soft p-0.5"><div className="truncate rounded bg-danger-bg px-1 py-1 text-danger" title={block.reason}>{t('hk.out_of_order')}</div></td>); continue; }
                  if (!stays.length) { cells.push(<td key={d} className="border-t border-line-soft p-0.5" />); continue; }
                  // One booking per room night (dorms show the first bed's guest and a count).
                  const c = stays[0]!;
                  let span = 1;
                  while (i + span < g.dates.length && room.cells.some((x) => x.date === g.dates[i + span] && x.reservationRoomId === c.reservationRoomId) && stays.length === 1) span += 1;
                  cells.push(
                    <td key={d} colSpan={span} className="border-t border-line-soft p-0.5">
                      <button type="button" onClick={() => onOpen(c.reservationId)} className={cx('w-full truncate rounded border px-1.5 py-1 text-start font-semibold', BAR[c.status] ?? 'bg-canvas')} title={`${c.code} · ${c.guestName}`} data-testid="grid-stay">
                        {c.guestName}{stays.length > 1 ? ` +${stays.length - 1}` : ''}
                      </button>
                    </td>,
                  );
                  i += span - 1;
                }
                return (
                  <tr key={room.id}>
                    <th className="sticky left-0 z-10 border-t border-line-soft bg-surface p-2 text-start font-semibold">
                      <div className="flex items-center gap-1.5">{room.number}<HkStatus status={room.hkStatus} /></div>
                      <div className="text-[11px] font-normal text-stone">{typeName.get(room.roomTypeId)}{room.beds.length ? ` · ${t('grid.beds', { count: room.beds.length })}` : ''}</div>
                    </th>
                    {cells}
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap gap-2 px-2 text-[11px]">
        {Object.keys(BAR).map((s) => <span key={s} className={cx('rounded border px-1.5 py-0.5', BAR[s])}>{t(`status.${s}` as 'status.hold')}</span>)}
      </div>
    </div>
  );
}

type View = 'arrivals' | 'in_house' | 'departures' | 'upcoming' | 'all';

/** Arrivals, in-house, departures and all reservations; detail with folio; new front-desk booking. */
export function ReservationsScreen() {
  const tOps = useTranslations('ops.hospitality.reservations');
  return (
    <>
      <PageHeader icon="list" title={tOps('title')} description={tOps('description')} />
      <WithProperty>{(p, picker) => <ReservationsBody p={p} picker={picker} />}</WithProperty>
    </>
  );
}

function ReservationsBody({ p, picker }: { p: Property; picker: React.ReactNode }) {
  const t = useTranslations('hosp');
  const locale = useLocale();
  const [view, setView] = useState<View>('arrivals');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const res = useHosp(() => hosp.reservations({ locationId: p.locationId, view, q: q || undefined }), [p.locationId, view, q]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {picker}
        <Button size="sm" icon="plus" onClick={() => setCreating(true)}>{t('book.new')}</Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Tabs<View> value={view} onChange={setView} items={(['arrivals', 'in_house', 'departures', 'upcoming', 'all'] as View[]).map((k) => ({ key: k, label: t(`list.${k}` as 'list.arrivals') }))} />
        <Field label={t('list.search')}>{({ id }) => <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
      </div>
      <HAsync res={res}>
        {(rows) => rows.length === 0 ? <Empty icon="list" title={t('list.emptyTitle')} body={t('list.emptyBody')} /> : (
          <div className="overflow-x-auto rounded-xl bg-surface p-2" tabIndex={0}>
            <table className="w-full min-w-[760px] text-sm" data-testid="reservations">
              <thead><tr className="text-xs text-stone"><th className="p-2 text-start">{t('list.code')}</th><th className="text-start">{t('list.guest')}</th><th className="text-start">{t('list.stay')}</th><th className="text-start">{t('res.rooms')}</th><th className="text-start">{t('list.status')}</th><th className="text-end">{t('res.total')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer border-t border-line-soft hover:bg-canvas" onClick={() => setOpen(r.id)}>
                    <td className="p-2 font-bold"><button type="button" className="underline-offset-2 hover:underline" onClick={() => setOpen(r.id)}>{r.code}</button></td>
                    <td>{r.guestName}{r.groupName && <div className="text-xs text-stone">{r.groupName}</div>}</td>
                    <td>{fmtYmd(r.arrival, locale, { day: 'numeric', month: 'short' })} → {fmtYmd(r.departure, locale, { day: 'numeric', month: 'short' })} <span className="text-xs text-stone">({t('list.nights', { count: r.nights })})</span></td>
                    <td className="text-xs">{(r.rooms ?? []).map((x, i) => <div key={i}>{x.roomTypeName}{x.roomNumber ? ` · ${x.roomNumber}` : ''}</div>)}</td>
                    <td><ResStatus status={r.status} /></td>
                    <td className="text-end"><M value={r.total} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </HAsync>
      <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={res.reload} />
      <Drawer open={creating} onClose={() => setCreating(false)} title={t('book.new')} kicker={p.name}>
        {creating && <NewBooking p={p} onCreated={(id) => { setCreating(false); res.reload(); setOpen(id); }} />}
      </Drawer>
    </div>
  );
}

function NewBooking({ p, onCreated }: { p: Property; onCreated: (id: string) => void }) {
  const t = useTranslations('hosp');
  const [arrival, setArrival] = useState(p.today);
  const [departure, setDeparture] = useState(addDaysYmd(p.today, 2));
  const [adults, setAdults] = useState(2);
  const [rooms, setRooms] = useState(1);
  const [results, setResults] = useState<AvailabilityRow[] | null>(null);
  const [choice, setChoice] = useState<{ roomTypeId: string; ratePlanId: string; units: number } | null>(null);
  const [guest, setGuest] = useState({ name: '', email: '', phone: '' });
  const [groupName, setGroupName] = useState('');
  const search = useHospAction();
  const create = useHospAction();
  return (
    <div className="flex flex-col gap-3 text-sm">
      <form className="grid grid-cols-2 gap-2" onSubmit={async (e) => { e.preventDefault(); setChoice(null); const r = await search.run(() => hosp.availability({ locationId: p.locationId, arrival, departure, adults, children: 0, rooms })); if (r) setResults(r); }}>
        <Field label={t('res.arrival')}>{({ id }) => <Input id={id} type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} />}</Field>
        <Field label={t('res.departure')}>{({ id }) => <Input id={id} type="date" value={departure} onChange={(e) => setDeparture(e.target.value)} />}</Field>
        <Field label={t('book.adults')}>{({ id }) => <Input id={id} type="number" min={1} max={40} value={adults} onChange={(e) => setAdults(Number(e.target.value))} />}</Field>
        <Field label={t('book.rooms')}>{({ id }) => <Input id={id} type="number" min={1} max={20} value={rooms} onChange={(e) => setRooms(Number(e.target.value))} />}</Field>
        <div className="col-span-2"><Button type="submit" size="sm" icon="search" loading={search.pending}>{t('book.search')}</Button></div>
      </form>
      {search.error && <Banner tone="danger" icon="alert">{search.error.message}</Banner>}
      {results && (
        <ul className="flex flex-col gap-2">
          {results.map((rt) => (
            <li key={rt.roomTypeId} className="rounded-lg border border-line-soft p-2">
              <div className="flex justify-between"><strong>{rt.name}</strong><Badge tone={rt.available >= rt.unitsNeeded ? 'success' : 'danger'}>{t('book.left', { count: rt.available })}</Badge></div>
              <div className="mt-1 flex flex-col gap-1">
                {rt.rates.map((r) => (
                  <label key={r.ratePlanId} className={cx('flex items-center justify-between gap-2 rounded px-2 py-1', r.ok && rt.available >= rt.unitsNeeded ? 'cursor-pointer hover:bg-canvas' : 'opacity-60')}>
                    <span className="flex items-center gap-2"><input type="radio" name="rate" disabled={!r.ok || rt.available < rt.unitsNeeded} checked={choice?.ratePlanId === r.ratePlanId && choice.roomTypeId === rt.roomTypeId} onChange={() => setChoice({ roomTypeId: rt.roomTypeId, ratePlanId: r.ratePlanId, units: rt.unitsNeeded })} />{r.name}</span>
                    <span>{r.ok ? <M value={r.total} /> : <span className="text-xs text-stone">{r.message}</span>}</span>
                  </label>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {choice && (
        <form className="flex flex-col gap-2" onSubmit={async (e) => {
          e.preventDefault();
          const rt = results!.find((x) => x.roomTypeId === choice.roomTypeId)!;
          const dorm = rt.kind === 'dorm';
          const per = Math.ceil(adults / (dorm ? choice.units : rooms));
          const roomsBody = Array.from({ length: choice.units }, () => ({ roomTypeId: choice.roomTypeId, ratePlanId: choice.ratePlanId, adults: dorm ? 1 : per, children: 0 }));
          const out = await create.run(() => hosp.createReservation({ locationId: p.locationId, arrival, departure, rooms: roomsBody, guest: { name: guest.name, email: guest.email, phone: guest.phone || null }, groupName: groupName || null, source: 'front_desk' }));
          if (out) onCreated(out.id);
        }}>
          <Field label={t('book.guestName')}>{({ id }) => <Input id={id} required value={guest.name} onChange={(e) => setGuest({ ...guest, name: e.target.value })} />}</Field>
          <Field label={t('book.email')}>{({ id }) => <Input id={id} type="email" required value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} />}</Field>
          <Field label={t('book.phone')} optional>{({ id }) => <Input id={id} value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} />}</Field>
          {choice.units > 1 && <Field label={t('book.groupName')} optional>{({ id }) => <Input id={id} value={groupName} onChange={(e) => setGroupName(e.target.value)} />}</Field>}
          {create.error && <Banner tone="danger" icon="alert">{create.error.message}</Banner>}
          <Button type="submit" size="sm" loading={create.pending}>{t('book.create')}</Button>
          <p className="text-xs text-stone">{t('book.depositNote')}</p>
        </form>
      )}
    </div>
  );
}


'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Input, Select } from '@bh/ui';
import { fmtDateTime, fmtYmd } from '@/lib/format';
import { hosp, useHosp, useHospAction, type ReservationFull, type Room } from '@/lib/hospitality/api';
import { Banner } from '../../ui/States';
import { HAsync, HkStatus, M, ResStatus, toMinor } from './common';

type Panel = null | 'checkin' | 'cancel' | 'modify' | 'charge' | 'payment';

/** Reservation detail: stay, rooms and assignment, folio, and the front-desk actions the server allows. */
export function ReservationDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged?: () => void }) {
  const t = useTranslations('hosp');
  const res = useHosp(() => (id ? hosp.reservation(id) : Promise.resolve(null)), [id]);
  return (
    <Drawer open={!!id} onClose={onClose} title={res.data?.code ?? t('res.title')} kicker={res.data?.guestName}>
      <HAsync res={res} variant="detail">
        {(r) => r && <Detail r={r} reload={() => { res.reload(); onChanged?.(); }} />}
      </HAsync>
    </Drawer>
  );
}

function Detail({ r, reload }: { r: ReservationFull; reload: () => void }) {
  const t = useTranslations('hosp');
  const locale = useLocale();
  const act = useHospAction();
  const [panel, setPanel] = useState<Panel>(null);
  const rooms = useHosp(() => hosp.rooms(r.locationId), [r.locationId]);
  const open = ['hold', 'confirmed'].includes(r.status);
  const run = async (fn: () => Promise<ReservationFull | unknown>) => {
    const out = await act.run(fn);
    if (out) { setPanel(null); reload(); }
  };
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="reservation-detail">
      <div className="flex flex-wrap items-center gap-2">
        <ResStatus status={r.status} />
        {r.groupName && <Badge tone="info" icon="users">{r.groupName}</Badge>}
        <span className="text-stone">{t('res.source', { source: t(`source.${r.source}` as 'source.website') })}</span>
      </div>
      <dl className="grid grid-cols-2 gap-2">
        <div><dt className="text-xs text-stone">{t('res.arrival')}</dt><dd className="font-bold">{fmtYmd(r.arrival, locale)}</dd></div>
        <div><dt className="text-xs text-stone">{t('res.departure')}</dt><dd className="font-bold">{fmtYmd(r.departure, locale)}</dd></div>
        <div><dt className="text-xs text-stone">{t('res.guests')}</dt><dd>{t('res.guestCount', { adults: r.adults, children: r.children })}</dd></div>
        <div><dt className="text-xs text-stone">{t('res.total')}</dt><dd className="font-bold"><M value={r.total} /></dd></div>
        <div><dt className="text-xs text-stone">{t('res.deposit')}</dt><dd><M value={r.depositPaid} /> / <M value={r.depositRequired} /></dd></div>
        {r.guestEmail && <div><dt className="text-xs text-stone">{t('res.contact')}</dt><dd className="break-all">{r.guestEmail}{r.guestPhone ? ` · ${r.guestPhone}` : ''}</dd></div>}
        {r.arrivalTime && <div><dt className="text-xs text-stone">{t('res.arrivalTime')}</dt><dd>{r.arrivalTime}</dd></div>}
      </dl>
      {r.specialRequests && <Banner tone="neutral" icon="message">{r.specialRequests}</Banner>}
      {r.holdExpiresAt && r.status === 'hold' && <Banner tone="warning" icon="clock">{t('res.holdUntil', { when: fmtDateTime(r.holdExpiresAt, r.property.timeZone, locale) })}</Banner>}

      <section>
        <h3 className="mb-2 font-bold">{t('res.rooms')}</h3>
        <ul className="flex flex-col gap-2">
          {r.rooms.map((rr) => (
            <li key={rr.id} className="rounded-lg border border-line-soft p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-bold">{rr.roomTypeName}</span>
                <span className="text-xs text-stone">{rr.ratePlanName}{rr.includesBreakfast ? ` · ${t('res.breakfast')}` : ''}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {rr.room ? <><Badge tone="success" icon="key">{t('res.roomNo', { number: rr.room.number })}{rr.bed ? ` · ${t('res.bed', { label: rr.bed.label })}` : ''}</Badge><HkStatus status={rr.room.hkStatus} /></> : <Badge tone="warning">{t('res.unassigned')}</Badge>}
              </div>
              {['confirmed', 'checked_in'].includes(r.status) && rooms.data && <Assign rr={rr} rooms={rooms.data} onDone={reload} />}
              <p className="mt-1 text-xs text-stone">{rr.nights.map((n) => fmtYmd(n.date, locale, { day: 'numeric', month: 'short' })).join(' · ')}</p>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="font-bold">{t('folio.title')}</h3>
          <span className="text-sm">{t('folio.balance')}: <strong><M value={r.folio.balance} /></strong></span>
        </div>
        {!r.folio.stayPosted && open && <p className="mb-2 text-xs text-stone">{t('folio.notPosted')} <M value={r.folio.expectedBalance} /></p>}
        <table className="w-full text-sm" data-testid="folio">
          <tbody>
            {r.folio.lines.map((l) => (
              <tr key={l.id} className="border-t border-line-soft">
                <td className="py-1.5">{l.description}<div className="text-xs text-stone">{t(`folio.kind.${l.kind}` as 'folio.kind.room')}{l.method ? ` · ${t(`folio.method.${l.method}` as 'folio.method.cash')}` : ''}</div></td>
                <td className="text-end"><M value={l.amount} /></td>
              </tr>
            ))}
            {r.folio.lines.length === 0 && <tr><td className="py-2 text-stone">{t('folio.empty')}</td></tr>}
          </tbody>
        </table>
      </section>

      {r.registrationFields.length > 0 && r.registration && (
        <section>
          <h3 className="mb-1 font-bold">{t('reg.title')}</h3>
          <dl className="grid grid-cols-2 gap-1 text-xs">{r.registrationFields.map((f) => <div key={f.key}><dt className="text-stone">{f.label}</dt><dd>{r.registration?.[f.key] || '—'}</dd></div>)}</dl>
        </section>
      )}

      {act.error && <Banner tone="danger" icon="alert">{act.error.message}</Banner>}

      <div className="flex flex-wrap gap-2">
        {r.status === 'confirmed' && <Button size="sm" icon="key" onClick={() => setPanel('checkin')}>{t('actions.checkIn')}</Button>}
        {r.status === 'checked_in' && <Button size="sm" icon="check-circle" loading={act.pending} onClick={() => run(() => hosp.checkOut(r.id))}>{t('actions.checkOut')}</Button>}
        {['confirmed', 'checked_in'].includes(r.status) && <Button size="sm" variant="secondary" icon="plus" onClick={() => setPanel('charge')}>{t('actions.addCharge')}</Button>}
        {['confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'].includes(r.status) && <Button size="sm" variant="secondary" icon="card" onClick={() => setPanel('payment')}>{t('actions.addPayment')}</Button>}
        {open && <Button size="sm" variant="secondary" icon="calendar" onClick={() => setPanel('modify')}>{t('actions.modify')}</Button>}
        {open && <Button size="sm" variant="ghost" icon="x" onClick={() => setPanel('cancel')}>{t('actions.cancel')}</Button>}
        {r.status === 'confirmed' && r.arrival <= r.property.today && <Button size="sm" variant="ghost" icon="alert" loading={act.pending} onClick={() => run(() => hosp.noShow(r.id))}>{t('actions.noShow')}</Button>}
      </div>

      {panel === 'checkin' && <CheckInPanel r={r} pending={act.pending} onSubmit={(reg) => run(() => hosp.checkIn(r.id, reg))} />}
      {panel === 'modify' && <ModifyPanel r={r} pending={act.pending} onSubmit={(b) => run(() => hosp.modify(r.id, b))} />}
      {panel === 'cancel' && <CancelPanel r={r} pending={act.pending} onSubmit={() => run(() => hosp.cancel(r.id, {}))} />}
      {(panel === 'charge' || panel === 'payment') && <FolioPanel kind={panel} currency={r.folio.currency} pending={act.pending} onSubmit={(b) => run(() => hosp.folio(r.id, b))} />}

      <section>
        <h3 className="mb-1 font-bold">{t('res.timeline')}</h3>
        <ul className="flex flex-col gap-1 text-xs text-stone">{r.timeline.map((e, i) => <li key={i}>{fmtDateTime(e.at, r.property.timeZone, locale)} · {t(`timeline.${e.action}` as 'timeline.confirmed')}{e.note ? ` · ${e.note}` : ''}</li>)}</ul>
      </section>
    </div>
  );
}

function Assign({ rr, rooms, onDone }: { rr: ReservationFull['rooms'][number]; rooms: Room[]; onDone: () => void }) {
  const t = useTranslations('hosp');
  const act = useHospAction();
  const options = rooms.filter((x) => x.roomTypeId === rr.roomTypeId && x.active);
  const [roomId, setRoomId] = useState(rr.room?.id ?? options[0]?.id ?? '');
  const room = options.find((x) => x.id === roomId);
  const [bedId, setBedId] = useState(rr.bed?.id ?? '');
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <Field label={t('res.room')}>{({ id }) => <Select id={id} value={roomId} onChange={(e) => setRoomId(e.target.value)}>{options.map((x) => <option key={x.id} value={x.id}>{x.number} · {t(`hk.${x.hkStatus}` as 'hk.clean')}</option>)}</Select>}</Field>
      {room && room.beds.length > 0 && <Field label={t('res.bedLabel')}>{({ id }) => <Select id={id} value={bedId} onChange={(e) => setBedId(e.target.value)}><option value="">—</option>{room.beds.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</Select>}</Field>}
      <Button size="sm" variant="secondary" loading={act.pending} onClick={async () => { if (await act.run(() => hosp.assign(rr.id, roomId, bedId || null))) onDone(); }}>{rr.room ? t('actions.move') : t('actions.assign')}</Button>
      {act.error && <p className="w-full text-xs font-bold text-danger">{act.error.message}</p>}
    </div>
  );
}

function CheckInPanel({ r, pending, onSubmit }: { r: ReservationFull; pending: boolean; onSubmit: (reg: Record<string, string>) => void }) {
  const t = useTranslations('hosp');
  const [reg, setReg] = useState<Record<string, string>>(r.registration ?? {});
  return (
    <form className="flex flex-col gap-2 rounded-lg bg-canvas p-3" onSubmit={(e) => { e.preventDefault(); onSubmit(reg); }}>
      <h3 className="font-bold">{t('reg.checkInTitle')}</h3>
      {r.registrationFields.length === 0 ? <p className="text-xs text-stone">{t('reg.none')}</p> : <p className="text-xs text-stone">{t('reg.why')}</p>}
      {r.registrationFields.map((f) => (
        <Field key={f.key} label={f.label} optional={!f.required}>
          {({ id }) => <Input id={id} type={f.kind === 'date' ? 'date' : 'text'} required={f.required} value={reg[f.key] ?? ''} onChange={(e) => setReg({ ...reg, [f.key]: e.target.value })} />}
        </Field>
      ))}
      <Button type="submit" size="sm" loading={pending}>{t('actions.confirmCheckIn')}</Button>
    </form>
  );
}

function ModifyPanel({ r, pending, onSubmit }: { r: ReservationFull; pending: boolean; onSubmit: (b: { arrival: string; departure: string }) => void }) {
  const t = useTranslations('hosp');
  const [arrival, setArrival] = useState(r.arrival);
  const [departure, setDeparture] = useState(r.departure);
  return (
    <form className="flex flex-col gap-2 rounded-lg bg-canvas p-3" onSubmit={(e) => { e.preventDefault(); onSubmit({ arrival, departure }); }}>
      <h3 className="font-bold">{t('modify.title')}</h3>
      <p className="text-xs text-stone">{t('modify.note')}</p>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('res.arrival')}>{({ id }) => <Input id={id} type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} />}</Field>
        <Field label={t('res.departure')}>{({ id }) => <Input id={id} type="date" value={departure} onChange={(e) => setDeparture(e.target.value)} />}</Field>
      </div>
      <Button type="submit" size="sm" loading={pending}>{t('modify.submit')}</Button>
    </form>
  );
}

function CancelPanel({ r, pending, onSubmit }: { r: ReservationFull; pending: boolean; onSubmit: () => void }) {
  const t = useTranslations('hosp');
  const q = useHosp(() => hosp.cancelQuote(r.id), [r.id]);
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-canvas p-3">
      <h3 className="font-bold">{t('cancel.title')}</h3>
      <HAsync res={q} variant="detail">
        {(c) => (
          <>
            <p>{c.free ? t('cancel.free') : c.reason === 'non_refundable' ? t('cancel.nonRefundable') : t('cancel.late')}</p>
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div><dt className="text-stone">{t('cancel.fee')}</dt><dd className="font-bold"><M value={c.fee} /></dd></div>
              <div><dt className="text-stone">{t('cancel.refund')}</dt><dd className="font-bold"><M value={c.refund} /></dd></div>
              <div><dt className="text-stone">{t('cancel.outstanding')}</dt><dd className="font-bold"><M value={c.outstanding} /></dd></div>
            </dl>
            <Button size="sm" variant="danger" loading={pending} onClick={onSubmit}>{t('cancel.confirm')}</Button>
          </>
        )}
      </HAsync>
    </div>
  );
}

function FolioPanel({ kind, currency, pending, onSubmit }: { kind: 'charge' | 'payment'; currency: string; pending: boolean; onSubmit: (b: { kind: string; description: string; amountMinor: number; method?: string | null }) => void }) {
  const t = useTranslations('hosp');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('card_terminal');
  return (
    <form className="flex flex-col gap-2 rounded-lg bg-canvas p-3" onSubmit={(e) => { e.preventDefault(); onSubmit({ kind: kind === 'charge' ? 'extra' : 'payment', description: description || t(kind === 'charge' ? 'folio.defaultCharge' : 'folio.defaultPayment'), amountMinor: toMinor(amount, currency), method: kind === 'payment' ? method : null }); }}>
      <h3 className="font-bold">{kind === 'charge' ? t('actions.addCharge') : t('actions.addPayment')}</h3>
      <Field label={t('folio.description')} optional>{({ id }) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Field label={t('folio.amount', { currency })}>{({ id }) => <Input id={id} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
      {kind === 'payment' && <Field label={t('folio.methodLabel')}>{({ id }) => <Select id={id} value={method} onChange={(e) => setMethod(e.target.value)}>{['card_terminal', 'cash', 'bank_transfer', 'other'].map((m) => <option key={m} value={m}>{t(`folio.method.${m}` as 'folio.method.cash')}</option>)}</Select>}</Field>}
      <Button type="submit" size="sm" loading={pending}>{t('folio.post')}</Button>
    </form>
  );
}

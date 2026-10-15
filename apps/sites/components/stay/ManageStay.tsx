'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { call } from '@/lib/client';
import { calendarLabel, money } from '@/lib/format';
import type { ManageStayView } from '@/lib/stay';
import { CardPayment, ErrorSummary, Field } from '@/components/forms';
import { usePolicyText } from './BookStay';

/** Manage a stay with the link from the confirmation: pay a pending deposit, change dates, cancel, pre-arrival registration. */
export function ManageStay({ initial, id, token }: { initial: ManageStayView; id: string; token: string }) {
  const t = useTranslations('stay');
  const locale = useLocale();
  const policyText = usePolicyText();
  const [v, setV] = useState(initial);
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dates, setDates] = useState({ arrival: v.reservation.arrival, departure: v.reservation.departure });
  const [reg, setReg] = useState<Record<string, string>>(v.registration);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const r = v.reservation;

  const refresh = async () => {
    const res = await call<ManageStayView>('GET', `/public/hospitality/reservations/${id}?token=${encodeURIComponent(token)}`);
    if (res.ok) setV(res.data);
  };
  const act = async <T,>(path: string, body: Record<string, unknown>, done: (d: T) => string) => {
    setBusy(true); setError(null); setNotice(null);
    const res = await call<T & ManageStayView>('POST', path, { token, ...body });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setV(res.data);
    setNotice(done(res.data));
  };

  return (
    <div className="mt-5 space-y-5">
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      {notice && <p role="status" className="rounded-2xl bg-success-bg p-4 text-sm font-semibold text-success">{notice}</p>}

      <section className="card p-6" data-testid="stay-summary">
        <p className="inline-flex rounded-full bg-canvas px-3 py-1 text-sm font-bold">{t(`status.${r.status}` as 'status.confirmed')}</p>
        <h2 className="mt-3 text-xl font-bold">{t('manage.code', { code: r.code })}</h2>
        <p className="mt-1">{calendarLabel(r.arrival, locale, { weekday: 'long', day: 'numeric', month: 'long' })} → {calendarLabel(r.departure, locale, { weekday: 'long', day: 'numeric', month: 'long' })} · {t('manage.nights', { count: r.nights })}</p>
        <p className="text-graphite">{v.property.name} · {t('guest.checkIn', { time: v.property.checkInTime })} · {t('manage.checkOut', { time: v.property.checkOutTime })}</p>
        <ul className="mt-3 space-y-1 text-sm">
          {v.rooms.map((x) => <li key={x.id}><strong>{x.roomTypeName}</strong> · {x.ratePlanName}{x.includesBreakfast ? ` · ${t('results.breakfast')}` : ''} · {money(x.total, locale)}</li>)}
        </ul>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          <div><dt className="text-graphite">{t('manage.total')}</dt><dd className="font-bold">{money(r.total, locale)}</dd></div>
          <div><dt className="text-graphite">{t('manage.depositPaid')}</dt><dd className="font-bold">{money(r.depositPaid, locale)}</dd></div>
          <div><dt className="text-graphite">{t('manage.dueAtProperty')}</dt><dd className="font-bold">{money(v.balance, locale)}</dd></div>
        </dl>
        <p className="mt-3 text-sm text-graphite">{policyText(r.cancellationPolicy)}</p>
        {v.houseRules && <p className="mt-2 text-sm text-graphite">{v.houseRules}</p>}
      </section>

      {r.status === 'hold' && v.payment && v.payment.state !== 'succeeded' && (
        <section className="card space-y-3 p-6">
          <h2 className="text-xl font-extrabold">{t('pay.title')}</h2>
          <p>{t('pay.depositToday', { amount: money(r.depositRequired, locale), total: money(r.total, locale) })}</p>
          <CardPayment payment={{ id: v.payment.id, sandbox: v.payment.sandbox }} label={t('pay.cta', { amount: money(r.depositRequired, locale) })} onDone={(res) => (res.ok ? void refresh() : setError({ message: res.message ?? t('pay.failed') }))} />
        </section>
      )}

      {v.registrationFields.length > 0 && ['confirmed', 'checked_in'].includes(r.status) && (
        <form className="card space-y-3 p-6" onSubmit={(e) => { e.preventDefault(); void act(`/public/hospitality/reservations/${id}/registration`, { fields: reg }, () => t('reg.saved')); }}>
          <h2 className="text-xl font-extrabold">{t('reg.title')}</h2>
          <p className="text-sm text-graphite">{t('reg.why')}</p>
          {v.registrationFields.map((f) => <Field key={f.key} label={f.label} optional={!f.required} type={f.kind === 'date' ? 'date' : 'text'} value={reg[f.key] ?? ''} error={error?.fields?.[f.key]} onChange={(e) => setReg({ ...reg, [f.key]: e.target.value })} />)}
          <button type="submit" className="btn btn-secondary" disabled={busy}>{t('reg.save')}</button>
        </form>
      )}

      {v.canModify && (
        <form className="card space-y-3 p-6" onSubmit={(e) => { e.preventDefault(); void act<{ priceDifference: { amount: number; currency: string } }>(`/public/hospitality/reservations/${id}/modify`, dates, (d) => (d.priceDifference.amount === 0 ? t('manage.changedSame') : t('manage.changed', { difference: money({ amount: Math.abs(d.priceDifference.amount), currency: d.priceDifference.currency }, locale), direction: d.priceDifference.amount > 0 ? 'more' : 'less' }))); }}>
          <h2 className="text-xl font-extrabold">{t('manage.changeTitle')}</h2>
          <p className="text-sm text-graphite">{t('manage.changeNote')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('search.arrival')} type="date" min={v.property.today} value={dates.arrival} onChange={(e) => setDates({ ...dates, arrival: e.target.value })} />
            <Field label={t('search.departure')} type="date" min={dates.arrival} value={dates.departure} onChange={(e) => setDates({ ...dates, departure: e.target.value })} />
          </div>
          <button type="submit" className="btn btn-secondary" disabled={busy}>{t('manage.changeCta')}</button>
        </form>
      )}

      {v.canCancel && v.cancellation && (
        <section className="card space-y-3 p-6">
          <h2 className="text-xl font-extrabold">{t('manage.cancelTitle')}</h2>
          <p>{v.cancellation.free ? t('manage.cancelFree', { refund: money(v.cancellation.refund, locale) }) : t('manage.cancelFee', { fee: money(v.cancellation.fee, locale), refund: money(v.cancellation.refund, locale) })}</p>
          {v.cancellation.outstanding.amount > 0 && <p className="text-sm text-graphite">{t('manage.cancelOutstanding', { amount: money(v.cancellation.outstanding, locale) })}</p>}
          {!confirmCancel ? <button type="button" className="btn btn-secondary" onClick={() => setConfirmCancel(true)}>{t('manage.cancelCta')}</button> : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(`/public/hospitality/reservations/${id}/cancel`, {}, () => t('manage.cancelled'))}>{t('manage.cancelConfirm')}</button>
          )}
        </section>
      )}
    </div>
  );
}

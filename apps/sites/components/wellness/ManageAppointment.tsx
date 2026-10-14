'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { call } from '@/lib/client';
import { addDays, calendarLabel, money, time } from '@/lib/format';
import type { Money } from '@/lib/types';
import { ErrorSummary } from '@/components/forms';

export interface Preview { window: 'free' | 'late' | 'no_show' | 'business'; hoursBeforeStart: number; price: Money; fee: Money; deposit: { paid: number; refund: number; retained: number; currency: string }; voucher: { applied: number; returned: number; retained: number; currency: string }; packageSession: 'returned' | 'forfeited' | null; outstanding: Money }
export interface ManageView {
  appointment: { id: string; price: Money; serviceId: string; variantId: string | null; practitionerId: string };
  status: string; startsAt: string; endsAt: string;
  service: { id: string; name: string; variantName: string | null; cancellationPolicy: string | null };
  practitioners: { id: string; name: string }[]; location: { id: string; name: string; timeZone: string }; guests: number;
  cancellation: Preview | null; canCancel: boolean; canReschedule: boolean; rescheduleBlockedReason: string | null;
}

/** Customer self-service: see what cancelling costs under the policy, cancel, or move to another time. */
export function ManageAppointment({ view, token, today }: { view: ManageView; token: string; today: string }) {
  const t = useTranslations('wellnessPro');
  const tm = useTranslations('manage');
  const locale = useLocale();
  const tz = view.location.timeZone;
  const [mode, setMode] = useState<null | 'cancel' | 'move'>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [date, setDate] = useState(today);
  const [slots, setSlots] = useState<{ startsAt: string }[] | null>(null);
  const p = view.cancellation;
  const m = (amount: number, currency: string) => money({ amount, currency }, locale);

  useEffect(() => {
    if (mode !== 'move') return;
    let live = true;
    setSlots(null);
    const q = new URLSearchParams({ serviceId: view.appointment.serviceId, date, ...(view.appointment.variantId ? { variantId: view.appointment.variantId } : {}) });
    call<{ slots: { startsAt: string }[] }>('GET', `/public/wellness/${view.location.id}/availability?${q}`).then((r) => { if (live) setSlots(r.ok ? r.data.slots : []); });
    return () => { live = false; };
  }, [mode, date, view]);

  if (done) return <p role="status" className="mt-5 rounded-2xl bg-success-bg p-4 font-semibold text-success">{done}</p>;
  return (
    <div className="mt-5 space-y-4">
      {p && (
        <div className="rounded-2xl bg-canvas p-4 text-sm">
          <p className="font-bold">{p.window === 'free' ? t('freeNow') : t('lateNow', { fee: money(p.fee, locale) })}</p>
          <ul className="mt-1 list-disc ps-5 text-graphite">
            {p.deposit.paid > 0 && <li>{t('depositOutcome', { refund: m(p.deposit.refund, p.deposit.currency), kept: m(p.deposit.retained, p.deposit.currency) })}</li>}
            {p.voucher.applied > 0 && <li>{t('voucherOutcome', { amount: m(p.voucher.returned, p.voucher.currency) })}</li>}
            {p.packageSession && <li>{p.packageSession === 'returned' ? t('sessionReturned') : t('sessionForfeited')}</li>}
            {p.outstanding.amount > 0 && <li>{t('outstanding', { amount: money(p.outstanding, locale) })}</li>}
          </ul>
        </div>
      )}
      <ErrorSummary message={err} />
      {mode === null && (
        <div className="flex flex-wrap gap-2">
          {view.canReschedule && <button type="button" className="btn btn-primary" onClick={() => setMode('move')}>{t('reschedule')}</button>}
          {view.canCancel && <button type="button" className="btn btn-secondary" onClick={() => setMode('cancel')}>{tm('cancelAppointment')}</button>}
        </div>
      )}
      {view.rescheduleBlockedReason && view.status === 'confirmed' && <p className="text-sm text-graphite">{view.rescheduleBlockedReason}</p>}
      {mode === 'cancel' && (
        <div className="space-y-3 rounded-2xl border border-line p-4" role="group" aria-label={tm('cancelAppointment')}>
          <p className="font-semibold">{p && p.fee.amount > 0 ? t('confirmLate', { fee: money(p.fee, locale) }) : tm('cancelQuestion')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => {
              setBusy(true);
              const r = await call<{ payment?: { action?: string; amount?: number } }>('POST', `/public/wellness/appointments/${view.appointment.id}/cancel`, { manageToken: token, acceptPolicy: true });
              setBusy(false);
              if (!r.ok) { setErr(r.error.message); return; }
              const a = r.data.payment?.action;
              setDone(a === 'refunded' ? tm('cancelledRefund') : a === 'voided' ? tm('cancelledVoid') : a === 'retained' ? t('cancelledRetained') : tm('cancelledNone'));
              setTimeout(() => window.location.reload(), 2500);
            }}>{tm('confirmCancel')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setMode(null)}>{tm('keep')}</button>
          </div>
        </div>
      )}
      {mode === 'move' && (
        <div className="space-y-3 rounded-2xl border border-line p-4">
          <p className="font-semibold">{t('moveIntro')}</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {Array.from({ length: 21 }, (_, i) => addDays(today, i)).map((d) => (
              <button key={d} type="button" aria-pressed={d === date} onClick={() => setDate(d)} className={`min-h-12 min-w-16 shrink-0 rounded-2xl border px-2 text-sm font-bold ${d === date ? 'border-ink bg-ink text-white' : 'border-line bg-white'}`}>{calendarLabel(d, locale)}</button>
            ))}
          </div>
          {slots === null ? <p className="text-sm text-graphite">…</p> : slots.length === 0 ? <p className="text-sm text-graphite">{t('noTimes')}</p> : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {slots.map((s) => (
                <button key={s.startsAt} type="button" disabled={busy} className="min-h-11 rounded-xl border border-line bg-white text-sm font-bold tabular" onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  const r = await call<{ appointment: { id: string } }>('POST', `/public/wellness/appointments/${view.appointment.id}/reschedule`, { manageToken: token, startsAt: s.startsAt });
                  setBusy(false);
                  if (!r.ok) { setErr(r.error.code === 'slot_unavailable' ? t('moveTaken') : r.error.message); return; }
                  setDone(t('moved'));
                  setTimeout(() => window.location.assign(window.location.pathname.replace(view.appointment.id, r.data.appointment.id) + window.location.search), 1800);
                }}>{time(s.startsAt, tz, locale)}</button>
              ))}
            </div>
          )}
          <p className="text-xs text-graphite">{t('moveSafe')}</p>
          <button type="button" className="btn btn-secondary" onClick={() => setMode(null)}>{tm('keep')}</button>
        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { addDays, calendarLabel, dateLong, money, time, zone } from '@/lib/format';
import type { Money } from '@/lib/types';
import { Checkbox, EMAIL_RE, ErrorSummary, Field, PayButton, type PaymentInfo } from '@/components/forms';

export interface Service { id: string; name: string; description: string | null; durationMinutes: number; price: Money; deposit: Money; cancellationPolicy: string | null; practitioners: Array<{ id: string; name: string }> }
type SlotT = { startsAt: string; endsAt: string; practitionerIds: string[] };
type Booked = { appointment: { id: string; startsAt: string; practitionerId: string }; manageToken: string; payment: PaymentInfo | null };

/** Wellness booking: service → practitioner (or any) → date → slot → terms → details → book (→ deposit). */
export function BookAppointment(props: { locationId: string; timeZone: string; today: string; services: Service[]; brandName: string; manageBase: string }) {
  const t = useTranslations('wellness');
  const tb = useTranslations('booking');
  const tc = useTranslations('common');
  const locale = useLocale();
  const tz = props.timeZone;
  const [svc, setSvc] = useState<Service | null>(null);
  const [prac, setPrac] = useState<string>('');
  const [date, setDate] = useState(props.today);
  const [slots, setSlots] = useState<SlotT[] | null>(null);
  const [slot, setSlot] = useState<SlotT | null>(null);
  const [terms, setTerms] = useState(false);
  const [c, setC] = useState({ name: '', email: '', phone: '', consent: false });
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<Booked | null>(null);
  const [paid, setPaid] = useState(false);
  const doneRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!svc) return;
    let live = true;
    setSlots(null);
    setSlot(null);
    call<{ slots: SlotT[] }>('GET', `/public/wellness/${props.locationId}/availability?serviceId=${svc.id}&date=${date}${prac ? `&practitionerId=${prac}` : ''}`).then((r) => {
      if (!live) return;
      if (r.ok) setSlots(r.data.slots); else { setSlots([]); setError({ message: r.error.message }); }
    });
    return () => { live = false; };
  }, [svc, prac, date, props.locationId]);
  useEffect(() => { if (booked && (paid || !booked.payment)) doneRef.current?.focus(); }, [booked, paid]);

  const pracName = (id: string) => svc?.practitioners.find((p) => p.id === id)?.name ?? '';
  const days = Array.from({ length: 14 }, (_, i) => addDays(props.today, i));

  async function book(e: React.FormEvent) {
    e.preventDefault();
    if (!svc || !slot) return;
    const fe: Record<string, string> = {};
    if (!c.name.trim()) fe.name = tc('required', { field: tb('name') });
    if (!EMAIL_RE.test(c.email)) fe.email = tc('invalidEmail');
    if (!terms) fe.terms = t('acceptTerms');
    if (Object.keys(fe).length) { setError({ message: tb('yourDetails'), fields: fe }); return; }
    setBusy(true);
    setError(null);
    const r = await call<Booked>('POST', `/public/wellness/${props.locationId}/appointments`, {
      serviceId: svc.id, ...(prac ? { practitionerId: prac } : {}), startsAt: slot.startsAt,
      contact: { name: c.name.trim(), email: c.email.trim(), ...(c.phone.trim() ? { phone: c.phone.trim() } : {}), marketingConsent: c.consent },
    });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 409) { setError({ message: t('slotTaken') }); setSlot(null); setDate((d) => d); setSvc({ ...svc }); return; }
      setError({ message: r.error.message, fields: r.error.fields });
      return;
    }
    setBooked(r.data);
  }

  if (booked && (paid || !booked.payment)) {
    return (
      <section role="status" className="card mt-6 p-6 text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-full bg-success-bg text-success" aria-hidden><Icon name="check" size={28} stroke={2.4} /></span>
        <h2 ref={doneRef} tabIndex={-1} className="mt-4 text-2xl font-extrabold outline-none">{t('bookedTitle')}</h2>
        <p className="mt-2 text-graphite">{t('bookedBody', { service: svc!.name, practitioner: pracName(booked.appointment.practitionerId), when: `${dateLong(booked.appointment.startsAt, tz, locale)} ${time(booked.appointment.startsAt, tz, locale)} ${zone(tz, locale, booked.appointment.startsAt)}` })}</p>
        <a href={`${props.manageBase}/appointment/${booked.appointment.id}?token=${encodeURIComponent(booked.manageToken)}`} className="btn btn-secondary mt-5">{t('manage')}</a>
      </section>
    );
  }
  if (booked?.payment) {
    return (
      <section className="card mt-6 space-y-4 p-6">
        <h2 className="text-xl font-extrabold">{t('terms')}</h2>
        <p>{t('depositToday', { amount: money(svc!.deposit, locale) })}</p>
        <ErrorSummary message={error?.message ?? null} />
        <PayButton payment={booked.payment} label={tb('payCta', { amount: money(svc!.deposit, locale) })} onDone={(r) => (r.ok ? setPaid(true) : setError({ message: r.message ?? tb('paymentFailed') }))} />
      </section>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      <fieldset>
        <legend className="text-xl font-extrabold">{t('chooseService')}</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {props.services.map((s) => (
            <label key={s.id} className={`card flex cursor-pointer gap-3 p-4 ${svc?.id === s.id ? 'outline outline-2 outline-ink' : ''}`}>
              <input type="radio" name="service" className="mt-1 size-5 accent-[var(--site-brand)]" checked={svc?.id === s.id} onChange={() => { setSvc(s); setPrac(''); setError(null); }} />
              <span>
                <span className="block font-bold">{s.name}</span>
                <span className="block text-sm text-graphite">{t('minutes', { n: s.durationMinutes })} · {money(s.price, locale)}{s.deposit.amount > 0 ? ` · ${t('deposit', { amount: money(s.deposit, locale) })}` : ''}</span>
                {s.description && <span className="mt-1 block text-sm text-graphite">{s.description}</span>}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {svc && (
        <>
          <div>
            <label htmlFor="prac" className="mb-1 block font-bold">{t('practitioner')}</label>
            <select id="prac" className="field max-w-xs" value={prac} onChange={(e) => setPrac(e.target.value)}>
              <option value="">{t('anyPractitioner')}</option>
              {svc.practitioners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <fieldset>
            <legend className="font-bold">{t('date')}</legend>
            <p className="text-sm text-graphite">{tc('timesIn', { zone: `${zone(tz, locale)} (${tz})` })}</p>
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {days.map((d) => (
                <button key={d} type="button" aria-pressed={d === date} onClick={() => setDate(d)} className={`min-h-14 min-w-16 shrink-0 rounded-2xl border px-2 text-sm font-bold ${d === date ? 'border-ink bg-ink text-white' : 'border-line bg-white'}`}>
                  {calendarLabel(d, locale)}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset aria-busy={slots === null}>
            <legend className="font-bold">{t('slots')}</legend>
            {slots === null ? <p className="mt-2 text-sm text-graphite">{tc('loading')}</p> : slots.length === 0 ? <p className="mt-2 text-sm text-graphite">{t('noSlots')}</p> : (
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
                {slots.map((s) => (
                  <button key={s.startsAt} type="button" aria-pressed={slot?.startsAt === s.startsAt} onClick={() => setSlot(s)} className={`min-h-11 rounded-xl border text-sm font-bold tabular ${slot?.startsAt === s.startsAt ? 'border-ink bg-ink text-white' : 'border-line bg-white'}`}>
                    {time(s.startsAt, tz, locale)}
                  </button>
                ))}
              </div>
            )}
          </fieldset>
        </>
      )}

      {svc && slot && (
        <form onSubmit={book} noValidate className="card space-y-4 p-6">
          <h2 className="text-xl font-extrabold">{t('terms')}</h2>
          <p className="text-sm">{svc.deposit.amount > 0 ? t('depositToday', { amount: money(svc.deposit, locale) }) : t('noDeposit')}</p>
          {svc.cancellationPolicy && <p className="text-sm text-graphite">{svc.cancellationPolicy}</p>}
          <Checkbox label={t('acceptTerms')} checked={terms} onChange={setTerms} error={error?.fields?.terms} />
          <h2 className="pt-2 text-xl font-extrabold">{tb('yourDetails')}</h2>
          <p className="text-xs text-graphite">{t('adminOnly')}</p>
          <Field label={tb('name')} autoComplete="name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} error={error?.fields?.name} />
          <Field label={tb('email')} type="email" autoComplete="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} error={error?.fields?.email} />
          <Field label={tb('phone')} type="tel" autoComplete="tel" optional value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} />
          <Checkbox label={tb('marketing', { brand: props.brandName })} checked={c.consent} onChange={(v) => setC({ ...c, consent: v })} />
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>{svc.deposit.amount > 0 ? t('bookAndPay', { amount: money(svc.deposit, locale) }) : t('book')}</button>
        </form>
      )}
    </div>
  );
}

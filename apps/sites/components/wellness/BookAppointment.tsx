'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { addDays, calendarLabel, dateLong, money, time, zone } from '@/lib/format';
import type { Money } from '@/lib/types';
import { Checkbox, EMAIL_RE, ErrorSummary, Field, PayButton, type PaymentInfo } from '@/components/forms';

export interface Variant { id: string; name: string; durationMinutes: number; price: Money; deposit: Money }
export interface Policy { freeCancelHours: number; lateCancelFeePercent: number; noShowFeePercent: number; depositRefundable: boolean }
export interface Service { id: string; name: string; description: string | null; category?: string | null; durationMinutes: number; price: Money; deposit: Money; cancellationPolicy: string | null; policy?: Policy; practitionersRequired?: number; variants?: Variant[]; practitioners: Array<{ id: string; name: string }> }
type SlotT = { startsAt: string; endsAt: string; practitionerIds: string[] };
type Summary = { price: Money; voucherApplied: Money; packageSessionUsed: boolean; depositDue: Money; dueAtVisit: Money; variantName: string | null; durationMinutes: number };
type Booked = { appointment: { id: string; startsAt: string; practitionerId: string }; appointments?: Array<{ practitionerId: string }>; manageToken: string; payment: PaymentInfo | null; summary?: Summary };

/**
 * Wellness booking: service → option (30/60/90) → practitioner or any → date → slot → deposit & cancellation terms →
 * details (+ second guest for couples, voucher or package) → book → deposit. When a day is full: join the waitlist.
 */
export function BookAppointment(props: { locationId: string; timeZone: string; today: string; services: Service[]; brandName: string; manageBase: string; packagesHref?: string }) {
  const t = useTranslations('wellness');
  const tw = useTranslations('wellnessPro');
  const tb = useTranslations('booking');
  const tc = useTranslations('common');
  const locale = useLocale();
  const tz = props.timeZone;
  const [svc, setSvc] = useState<Service | null>(null);
  const [variantId, setVariantId] = useState('');
  const [prac, setPrac] = useState<string>('');
  const [date, setDate] = useState(props.today);
  const [slots, setSlots] = useState<SlotT[] | null>(null);
  const [slot, setSlot] = useState<SlotT | null>(null);
  const [terms, setTerms] = useState(false);
  const [c, setC] = useState({ name: '', email: '', phone: '', consent: false, sms: false });
  const [partner, setPartner] = useState({ name: '', email: '' });
  const [pay, setPay] = useState<{ kind: 'none' | 'voucher' | 'package'; code: string }>({ kind: 'none', code: '' });
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<Booked | null>(null);
  const [paid, setPaid] = useState(false);
  const [waitlist, setWaitlist] = useState<null | 'form' | { id: string; token: string }>(null);
  const [wl, setWl] = useState({ from: '09:00', to: '18:00' });
  const doneRef = useRef<HTMLHeadingElement>(null);
  const variant = svc?.variants?.find((v) => v.id === variantId) ?? null;
  const price = variant?.price ?? svc?.price;
  const deposit = variant?.deposit ?? svc?.deposit;
  const couples = (svc?.practitionersRequired ?? 1) > 1;
  const categories = useMemo(() => [...new Set(props.services.map((s) => s.category ?? ''))], [props.services]);

  useEffect(() => {
    if (!svc) return;
    let live = true;
    setSlots(null);
    setSlot(null);
    const q = new URLSearchParams({ serviceId: svc.id, date, ...(variantId ? { variantId } : {}), ...(prac ? { practitionerId: prac } : {}) });
    call<{ slots: SlotT[] }>('GET', `/public/wellness/${props.locationId}/availability?${q}`).then((r) => {
      if (!live) return;
      if (r.ok) setSlots(r.data.slots); else { setSlots([]); setError({ message: r.error.message }); }
    });
    return () => { live = false; };
  }, [svc, variantId, prac, date, props.locationId]);
  useEffect(() => { if (booked && (paid || !booked.payment)) doneRef.current?.focus(); }, [booked, paid]);

  const pracName = (id: string) => svc?.practitioners.find((p) => p.id === id)?.name ?? '';
  const days = Array.from({ length: 21 }, (_, i) => addDays(props.today, i));
  const hhmmToIso = (hhmm: string) => {
    // Local wall-clock → UTC for the location (DST-aware by probing the zone offset at that time).
    const guess = new Date(`${date}T${hhmm}:00Z`);
    const local = new Date(guess.toLocaleString('en-US', { timeZone: tz }));
    const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
    return new Date(guess.getTime() - (local.getTime() - utc.getTime())).toISOString();
  };

  async function book(e: React.FormEvent) {
    e.preventDefault();
    if (!svc || !slot) return;
    const fe: Record<string, string> = {};
    if (!c.name.trim()) fe.name = tc('required', { field: tb('name') });
    if (!EMAIL_RE.test(c.email)) fe.email = tc('invalidEmail');
    if (couples && partner.email && !EMAIL_RE.test(partner.email)) fe.partnerEmail = tc('invalidEmail');
    if (pay.kind !== 'none' && !pay.code.trim()) fe.code = tw('codeRequired');
    if (!terms) fe.terms = t('acceptTerms');
    if (Object.keys(fe).length) { setError({ message: tb('yourDetails'), fields: fe }); return; }
    setBusy(true);
    setError(null);
    const r = await call<Booked>('POST', `/public/wellness/${props.locationId}/appointments`, {
      serviceId: svc.id, ...(variantId ? { variantId } : {}), ...(prac ? { practitionerId: prac } : {}), startsAt: slot.startsAt,
      contact: { name: c.name.trim(), email: c.email.trim(), ...(c.phone.trim() ? { phone: c.phone.trim() } : {}), marketingConsent: c.consent },
      ...(couples && partner.name.trim() && partner.email.trim() ? { partner: { name: partner.name.trim(), email: partner.email.trim() } } : {}),
      ...(pay.kind === 'voucher' ? { voucherCode: pay.code.trim() } : pay.kind === 'package' ? { packageId: pay.code.trim() } : {}),
      consents: { smsReminders: c.sms },
    });
    setBusy(false);
    if (!r.ok) {
      if (r.error.code === 'slot_unavailable') { setError({ message: t('slotTaken') }); setSlot(null); setSvc({ ...svc }); return; }
      setError({ message: r.error.message, fields: r.error.fields });
      return;
    }
    setBooked(r.data);
  }

  async function joinWaitlist(e: React.FormEvent) {
    e.preventDefault();
    if (!svc) return;
    if (!c.name.trim() || !EMAIL_RE.test(c.email)) { setError({ message: tb('yourDetails'), fields: { name: c.name.trim() ? '' : tc('required', { field: tb('name') }), email: EMAIL_RE.test(c.email) ? '' : tc('invalidEmail') } }); return; }
    setBusy(true);
    const r = await call<{ entry: { id: string }; manageToken: string }>('POST', `/public/wellness/${props.locationId}/waitlist`, { serviceId: svc.id, ...(variantId ? { variantId } : {}), ...(prac ? { practitionerId: prac } : {}), windowStart: hhmmToIso(wl.from), windowEnd: hhmmToIso(wl.to), contact: { name: c.name.trim(), email: c.email.trim(), marketingConsent: false } });
    setBusy(false);
    if (!r.ok) { setError({ message: r.error.message, fields: r.error.fields }); return; }
    setWaitlist({ id: r.data.entry.id, token: r.data.manageToken });
  }

  if (waitlist && typeof waitlist === 'object') {
    return (
      <section role="status" className="card mt-6 p-6 text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-full bg-info-bg text-info" aria-hidden><Icon name="clock" size={28} /></span>
        <h2 className="mt-4 text-2xl font-extrabold">{tw('waitlistJoined')}</h2>
        <p className="mt-2 text-graphite">{tw('waitlistJoinedBody', { day: calendarLabel(date, locale, { weekday: 'long', day: 'numeric', month: 'long' }), from: wl.from, to: wl.to })}</p>
        <a href={`${props.manageBase}/wellness-waitlist/${waitlist.id}?token=${encodeURIComponent(waitlist.token)}`} className="btn btn-secondary mt-5">{tw('manageWaitlist')}</a>
      </section>
    );
  }
  if (booked && (paid || !booked.payment)) {
    const s = booked.summary;
    const names = (booked.appointments ?? [booked.appointment]).map((a) => pracName(a.practitionerId)).filter(Boolean).join(' & ');
    return (
      <section role="status" className="card mt-6 p-6 text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-full bg-success-bg text-success" aria-hidden><Icon name="check" size={28} stroke={2.4} /></span>
        <h2 ref={doneRef} tabIndex={-1} className="mt-4 text-2xl font-extrabold outline-none">{t('bookedTitle')}</h2>
        <p className="mt-2 text-graphite">{t('bookedBody', { service: `${svc!.name}${s?.variantName ? ` (${s.variantName})` : ''}`, practitioner: names, when: `${dateLong(booked.appointment.startsAt, tz, locale)} ${time(booked.appointment.startsAt, tz, locale)} ${zone(tz, locale, booked.appointment.startsAt)}` })}</p>
        {s && (
          <dl className="mx-auto mt-4 grid max-w-sm grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-start text-sm">
            <dt>{tw('total')}</dt><dd className="text-end">{money(s.price, locale)}</dd>
            {s.voucherApplied.amount > 0 && <><dt>{tw('voucherApplied')}</dt><dd className="text-end">−{money(s.voucherApplied, locale)}</dd></>}
            {s.packageSessionUsed && <><dt>{tw('packageUsed')}</dt><dd className="text-end">✓</dd></>}
            {s.depositDue.amount > 0 && <><dt>{tw('depositPaid')}</dt><dd className="text-end">{money(s.depositDue, locale)}</dd></>}
            <dt className="font-bold">{tw('dueAtVisit')}</dt><dd className="text-end font-bold">{money(s.dueAtVisit, locale)}</dd>
          </dl>
        )}
        <a href={`${props.manageBase}/appointment/${booked.appointment.id}?token=${encodeURIComponent(booked.manageToken)}`} className="btn btn-secondary mt-5">{t('manage')}</a>
      </section>
    );
  }
  if (booked?.payment) {
    const amount = booked.summary?.depositDue ?? { amount: booked.payment.amount ?? 0, currency: booked.payment.currency ?? 'USD' };
    return (
      <section className="card mt-6 space-y-4 p-6">
        <h2 className="text-xl font-extrabold">{t('terms')}</h2>
        <p>{t('depositToday', { amount: money(amount, locale) })}</p>
        <ErrorSummary message={error?.message ?? null} />
        <PayButton payment={booked.payment} label={tb('payCta', { amount: money(amount, locale) })} onDone={(r) => (r.ok ? setPaid(true) : setError({ message: r.message ?? tb('paymentFailed') }))} />
      </section>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      <fieldset>
        <legend className="text-xl font-extrabold">{t('chooseService')}</legend>
        {props.packagesHref && <p className="mt-1 text-sm text-graphite">{tw('packagesTeaser')} <a className="font-bold underline" href={props.packagesHref}>{tw('packagesLink')}</a></p>}
        {categories.map((cat) => (
          <div key={cat || 'all'} className="mt-3">
            {cat && <h3 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-graphite">{cat}</h3>}
            <div className="grid gap-3 sm:grid-cols-2">
              {props.services.filter((s) => (s.category ?? '') === cat).map((s) => (
                <label key={s.id} className={`card flex cursor-pointer gap-3 p-4 ${svc?.id === s.id ? 'outline outline-2 outline-ink' : ''}`}>
                  <input type="radio" name="service" className="mt-1 size-5 accent-[var(--site-brand)]" checked={svc?.id === s.id} onChange={() => { setSvc(s); setVariantId(s.variants?.[0]?.id ?? ''); setPrac(''); setError(null); setWaitlist(null); }} />
                  <span>
                    <span className="block font-bold">{s.name}{(s.practitionersRequired ?? 1) > 1 ? ` · ${tw('forTwo')}` : ''}</span>
                    <span className="block text-sm text-graphite">
                      {s.variants?.length ? s.variants.map((v) => `${v.name} ${money(v.price, locale)}`).join(' · ') : `${t('minutes', { n: s.durationMinutes })} · ${money(s.price, locale)}`}
                      {s.deposit.amount > 0 ? ` · ${tw('depositFrom')}` : ''}
                    </span>
                    {s.description && <span className="mt-1 block text-sm text-graphite">{s.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </fieldset>

      {svc && (
        <>
          {svc.variants && svc.variants.length > 1 && (
            <fieldset>
              <legend className="font-bold">{tw('option')}</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {svc.variants.map((v) => (
                  <button key={v.id} type="button" aria-pressed={variantId === v.id} onClick={() => setVariantId(v.id)} className={`min-h-11 rounded-xl border px-4 text-sm font-bold ${variantId === v.id ? 'border-ink bg-ink text-white' : 'border-line bg-white'}`}>
                    {v.name} · {money(v.price, locale)}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <div>
            <label htmlFor="prac" className="mb-1 block font-bold">{couples ? tw('practitionersCouples') : t('practitioner')}</label>
            {couples ? <p className="text-sm text-graphite">{tw('couplesNote')}</p> : (
              <select id="prac" className="field max-w-xs" value={prac} onChange={(e) => setPrac(e.target.value)}>
                <option value="">{t('anyPractitioner')}</option>
                {svc.practitioners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
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
            {slots === null ? <p className="mt-2 text-sm text-graphite">{tc('loading')}</p> : slots.length === 0 ? (
              <div className="mt-2 space-y-2">
                <p className="text-sm text-graphite">{t('noSlots')}</p>
                {waitlist === null && <button type="button" className="btn btn-secondary" onClick={() => setWaitlist('form')}>{tw('joinWaitlist')}</button>}
              </div>
            ) : (
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
                {slots.map((s) => (
                  <button key={s.startsAt} type="button" aria-pressed={slot?.startsAt === s.startsAt} onClick={() => setSlot(s)} className={`min-h-11 rounded-xl border text-sm font-bold tabular ${slot?.startsAt === s.startsAt ? 'border-ink bg-ink text-white' : 'border-line bg-white'}`}>
                    {time(s.startsAt, tz, locale)}
                  </button>
                ))}
              </div>
            )}
            {slots && slots.length > 0 && waitlist === null && <button type="button" className="mt-2 text-sm font-bold underline" onClick={() => setWaitlist('form')}>{tw('preferAnotherTime')}</button>}
          </fieldset>
          {waitlist === 'form' && (
            <form onSubmit={joinWaitlist} noValidate className="card space-y-3 p-5">
              <h2 className="text-lg font-extrabold">{tw('waitlistTitle')}</h2>
              <p className="text-sm text-graphite">{tw('waitlistBody')}</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label={tw('from')} type="time" step={900} value={wl.from} onChange={(e) => setWl({ ...wl, from: e.target.value })} />
                <Field label={tw('to')} type="time" step={900} value={wl.to} onChange={(e) => setWl({ ...wl, to: e.target.value })} />
              </div>
              <Field label={tb('name')} autoComplete="name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} error={error?.fields?.name || undefined} />
              <Field label={tb('email')} type="email" autoComplete="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} error={error?.fields?.email || undefined} />
              <button type="submit" className="btn btn-primary" disabled={busy}>{tw('joinWaitlist')}</button>
            </form>
          )}
        </>
      )}

      {svc && slot && (
        <form onSubmit={book} noValidate className="card space-y-4 p-6">
          <h2 className="text-xl font-extrabold">{t('terms')}</h2>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            <dt>{svc.name}{variant ? ` · ${variant.name}` : ''}{couples ? ` · ${tw('perGuest')}` : ''}</dt><dd className="text-end">{money(price, locale)}</dd>
            <dt>{tw('when')}</dt><dd className="text-end">{dateLong(slot.startsAt, tz, locale)} {time(slot.startsAt, tz, locale)} {zone(tz, locale, slot.startsAt)}</dd>
          </dl>
          <p className="text-sm">{deposit && deposit.amount > 0 ? t('depositToday', { amount: money(couples ? { ...deposit, amount: deposit.amount * 2 } : deposit, locale) }) : t('noDeposit')}</p>
          {svc.policy && <p className="rounded-xl bg-canvas p-3 text-sm">{tw('policyPreview', { hours: svc.policy.freeCancelHours, late: svc.policy.lateCancelFeePercent, noShow: svc.policy.noShowFeePercent })}</p>}
          {svc.cancellationPolicy && <p className="text-sm text-graphite">{svc.cancellationPolicy}</p>}
          <Checkbox label={t('acceptTerms')} checked={terms} onChange={setTerms} error={error?.fields?.terms} />
          <h2 className="pt-2 text-xl font-extrabold">{tb('yourDetails')}</h2>
          <p className="text-xs text-graphite">{t('adminOnly')}</p>
          <Field label={tb('name')} autoComplete="name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} error={error?.fields?.name} />
          <Field label={tb('email')} type="email" autoComplete="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} error={error?.fields?.email} />
          <Field label={tb('phone')} type="tel" autoComplete="tel" optional value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} />
          {couples && (
            <fieldset className="space-y-3">
              <legend className="font-bold">{tw('secondGuest')}</legend>
              <Field label={tb('name')} optional value={partner.name} onChange={(e) => setPartner({ ...partner, name: e.target.value })} />
              <Field label={tb('email')} type="email" optional value={partner.email} onChange={(e) => setPartner({ ...partner, email: e.target.value })} error={error?.fields?.partnerEmail} />
            </fieldset>
          )}
          <fieldset>
            <legend className="font-bold">{tw('payWith')}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {(['none', 'voucher', 'package'] as const).map((k) => (
                <button key={k} type="button" aria-pressed={pay.kind === k} onClick={() => setPay({ kind: k, code: '' })} className={`min-h-11 rounded-xl border px-4 text-sm font-bold ${pay.kind === k ? 'border-ink bg-ink text-white' : 'border-line bg-white'}`}>{tw(`pay.${k}`)}</button>
              ))}
            </div>
            {pay.kind !== 'none' && <div className="mt-3"><Field label={pay.kind === 'voucher' ? tw('voucherCode') : tw('packageRef')} hint={pay.kind === 'voucher' ? tw('voucherHint') : tw('packageHint')} value={pay.code} onChange={(e) => setPay({ ...pay, code: e.target.value })} error={error?.fields?.code} /></div>}
          </fieldset>
          <Checkbox label={tw('smsReminders')} checked={c.sms} onChange={(v) => setC({ ...c, sms: v })} />
          <Checkbox label={tb('marketing', { brand: props.brandName })} checked={c.consent} onChange={(v) => setC({ ...c, consent: v })} />
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>{deposit && deposit.amount > 0 && pay.kind === 'none' ? t('bookAndPay', { amount: money(couples ? { ...deposit, amount: deposit.amount * 2 } : deposit, locale) }) : t('book')}</button>
        </form>
      )}
    </div>
  );
}

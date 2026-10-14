'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { addDays, calendarLabel, dateLong, time, zone } from '@/lib/format';
import { Checkbox, EMAIL_RE, ErrorSummary, Field } from '@/components/forms';

type Slot = { startsAt: string; endsAt: string; agentId: string; agentName: string };
type Booked = { viewing: { id: string; startsAt: string; agentName: string | null }; manageToken: string };

/** Book a viewing: date → free slot (listing agents' availability, office time zone) → details → request. The agent confirms. */
export function BookViewing(props: { listingId: string; timeZone: string; today: string; manageBase: string; comingSoon: boolean }) {
  const t = useTranslations('realty');
  const tc = useTranslations('common');
  const locale = useLocale();
  const tz = props.timeZone;
  const [date, setDate] = useState(addDays(props.today, 1));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [kind, setKind] = useState<'in_person' | 'virtual'>('in_person');
  const [c, setC] = useState({ name: '', email: '', phone: '', message: '', consent: false });
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<Booked | null>(null);
  const [reload, setReload] = useState(0);
  const doneRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (props.comingSoon) return;
    let live = true;
    setSlots(null);
    setSlot(null);
    call<{ slots: Slot[] }>('GET', `/public/realty/listings/${props.listingId}/viewing-slots?date=${date}`).then((r) => {
      if (!live) return;
      if (r.ok) setSlots(r.data.slots); else { setSlots([]); setError({ message: r.error.message }); }
    });
    return () => { live = false; };
  }, [date, props.listingId, props.comingSoon, reload]);
  useEffect(() => { if (booked) doneRef.current?.focus(); }, [booked]);

  if (props.comingSoon) return <p className="rounded-2xl bg-canvas p-4 text-sm">{t('book.comingSoon')}</p>;

  if (booked) {
    return (
      <section role="status" className="rounded-2xl bg-success-bg p-5 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-white text-success" aria-hidden><Icon name="check" size={24} /></span>
        <h3 ref={doneRef} tabIndex={-1} className="mt-3 text-xl font-extrabold outline-none">{t('book.requestedTitle')}</h3>
        <p className="mt-1 text-sm">{t('book.requestedBody', { agent: booked.viewing.agentName ?? t('book.anAgent'), when: `${dateLong(booked.viewing.startsAt, tz, locale)} ${time(booked.viewing.startsAt, tz, locale)} ${zone(tz, locale, booked.viewing.startsAt)}` })}</p>
        <a href={`${props.manageBase}/viewing/${booked.viewing.id}?token=${encodeURIComponent(booked.manageToken)}`} className="btn btn-secondary mt-4">{t('book.manage')}</a>
      </section>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!slot) return;
    const fe: Record<string, string> = {};
    if (!c.name.trim()) fe.name = tc('required', { field: t('form.name') });
    if (!EMAIL_RE.test(c.email)) fe.email = tc('invalidEmail');
    if (Object.keys(fe).length) { setError({ message: t('form.check'), fields: fe }); return; }
    setBusy(true);
    setError(null);
    const r = await call<Booked>('POST', `/public/realty/listings/${props.listingId}/viewings`, {
      startsAt: slot.startsAt, agentId: slot.agentId, kind, contact: { name: c.name.trim(), email: c.email.trim(), ...(c.phone.trim() ? { phone: c.phone.trim() } : {}) },
      ...(c.message.trim() ? { message: c.message.trim() } : {}), marketingConsent: c.consent,
    });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 409) { setError({ message: t('book.slotTaken') }); setReload((n) => n + 1); return; }
      setError({ message: r.error.message, fields: r.error.fields });
      return;
    }
    setBooked(r.data);
  }

  const days = Array.from({ length: 14 }, (_, i) => addDays(props.today, i + 1));
  return (
    <div className="space-y-4">
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      <div>
        <p className="mb-2 text-sm font-semibold">{t('book.chooseDay')}</p>
        <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t('book.chooseDay')}>
          {days.map((d) => (
            <button key={d} type="button" aria-pressed={d === date} onClick={() => setDate(d)} className={`h-11 shrink-0 rounded-full border px-3 text-sm font-semibold ${d === date ? 'border-brand bg-brand text-on-brand' : 'border-line bg-white'}`}>{calendarLabel(d, locale)}</button>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-semibold">{t('book.chooseTime')} <span className="font-normal text-graphite">· {t('book.timesIn', { zone: zone(tz, locale) })}</span></p>
        {slots === null ? <p className="text-sm text-graphite" role="status">{tc('loading')}</p> : slots.length === 0 ? <p className="text-sm text-graphite">{t('book.noSlots')}</p> : (
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('book.chooseTime')}>
            {slots.map((s) => (
              <button key={s.startsAt} type="button" role="radio" aria-checked={slot?.startsAt === s.startsAt} onClick={() => setSlot(s)} className={`h-11 rounded-full border px-4 text-sm font-semibold ${slot?.startsAt === s.startsAt ? 'border-brand bg-brand text-on-brand' : 'border-line bg-white'}`}>{time(s.startsAt, tz, locale)}</button>
            ))}
          </div>
        )}
      </div>
      {slot && (
        <form onSubmit={submit} className="space-y-3" noValidate>
          <fieldset className="flex gap-4 text-sm">
            <legend className="mb-1 font-semibold">{t('book.kind')}</legend>
            <label className="flex items-center gap-2"><input type="radio" name="kind" checked={kind === 'in_person'} onChange={() => setKind('in_person')} />{t('book.inPerson')}</label>
            <label className="flex items-center gap-2"><input type="radio" name="kind" checked={kind === 'virtual'} onChange={() => setKind('virtual')} />{t('book.virtual')}</label>
          </fieldset>
          <Field label={t('form.name')} autoComplete="name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} error={error?.fields?.name} />
          <Field label={t('form.email')} type="email" autoComplete="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} error={error?.fields?.email} />
          <Field label={t('form.phone')} type="tel" autoComplete="tel" optional value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} />
          <Field label={t('form.message')} optional value={c.message} onChange={(e) => setC({ ...c, message: e.target.value })} />
          <Checkbox label={t('form.marketingConsent')} checked={c.consent} onChange={(v) => setC({ ...c, consent: v })} />
          <p className="text-xs text-graphite">{t('book.policy')}</p>
          <button type="submit" className="btn btn-primary w-full" disabled={busy}>{busy ? tc('loading') : t('book.request', { time: time(slot.startsAt, tz, locale) })}</button>
        </form>
      )}
    </div>
  );
}

/** Make an enquiry about a listing (or an office): routed to the listing agent, round-robin or the office pool. */
export function EnquiryForm(props: { brand: string; listingId?: string; officeSlug?: string; kinds?: Array<'buyer' | 'tenant' | 'valuation' | 'general'> }) {
  const t = useTranslations('realty');
  const tc = useTranslations('common');
  const [c, setC] = useState({ name: '', email: '', phone: '', message: '', consent: false, kind: props.kinds?.[0] ?? 'buyer' });
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (done) return <p role="status" className="rounded-2xl bg-success-bg p-4 font-semibold text-success">{t('enquiry.sent')}</p>;
  return (
    <form className="space-y-3" noValidate onSubmit={async (e) => {
      e.preventDefault();
      const fe: Record<string, string> = {};
      if (!c.name.trim()) fe.name = tc('required', { field: t('form.name') });
      if (!EMAIL_RE.test(c.email)) fe.email = tc('invalidEmail');
      if (Object.keys(fe).length) { setError({ message: t('form.check'), fields: fe }); return; }
      setBusy(true);
      const r = await call('POST', `/public/realty/${props.brand}/enquiries`, {
        ...(props.listingId ? { listingId: props.listingId } : {}), ...(props.officeSlug ? { officeSlug: props.officeSlug } : {}), kind: c.kind,
        contact: { name: c.name.trim(), email: c.email.trim(), ...(c.phone.trim() ? { phone: c.phone.trim() } : {}) }, ...(c.message.trim() ? { message: c.message.trim() } : {}), marketingConsent: c.consent,
      });
      setBusy(false);
      if (!r.ok) { setError({ message: r.error.message, fields: r.error.fields }); return; }
      setDone(true);
    }}>
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      {props.kinds && props.kinds.length > 1 && (
        <div><label htmlFor="enq-kind" className="mb-1 block text-sm font-semibold">{t('enquiry.kind')}</label>
          <select id="enq-kind" className="field" value={c.kind} onChange={(e) => setC({ ...c, kind: e.target.value as 'buyer' })}>{props.kinds.map((k) => <option key={k} value={k}>{t(`enquiry.kinds.${k}`)}</option>)}</select></div>
      )}
      <Field label={t('form.name')} autoComplete="name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} error={error?.fields?.name} />
      <Field label={t('form.email')} type="email" autoComplete="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} error={error?.fields?.email} />
      <Field label={t('form.phone')} type="tel" autoComplete="tel" optional value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} />
      <div><label htmlFor="enq-msg" className="mb-1 block text-sm font-semibold">{t('form.message')}</label>
        <textarea id="enq-msg" className="field min-h-24" value={c.message} onChange={(e) => setC({ ...c, message: e.target.value })} /></div>
      <Checkbox label={t('form.marketingConsent')} checked={c.consent} onChange={(v) => setC({ ...c, consent: v })} />
      <p className="text-xs text-graphite">{t('enquiry.privacy')}</p>
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tc('loading') : t('enquiry.send')}</button>
    </form>
  );
}

/** Save the current search and opt into email alerts (explicit consent; unsubscribe link in every alert). */
export function SaveSearch(props: { brand: string; criteria: Record<string, unknown>; summary: string }) {
  const t = useTranslations('realty');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ email: '', name: '', frequency: 'weekly', consent: false });
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (done) return <p role="status" className="rounded-2xl bg-success-bg p-4 text-sm font-semibold text-success">{done}</p>;
  if (!open) return <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}><Icon name="bell" size={16} />{t('save.open')}</button>;
  return (
    <form className="card space-y-3 p-4" noValidate onSubmit={async (e) => {
      e.preventDefault();
      if (!EMAIL_RE.test(f.email)) { setError({ message: tc('invalidEmail'), fields: { email: tc('invalidEmail') } }); return; }
      const r = await call<{ id: string; alerts: string }>('POST', `/public/realty/${props.brand}/saved-searches`, { email: f.email.trim(), name: f.name.trim() || undefined, criteria: props.criteria, frequency: f.frequency, alertsConsent: f.consent, locale });
      if (!r.ok) { setError({ message: r.error.message, fields: r.error.fields }); return; }
      setDone(r.data.alerts === 'off' ? t('save.savedNoAlerts') : t('save.saved'));
    }}>
      <p className="text-sm"><strong>{t('save.title')}</strong> · {props.summary}</p>
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      <Field label={t('form.email')} type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={error?.fields?.email} />
      <Field label={t('save.name')} optional value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <div><label htmlFor="ss-freq" className="mb-1 block text-sm font-semibold">{t('save.frequency')}</label>
        <select id="ss-freq" className="field" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>{['instant', 'daily', 'weekly'].map((x) => <option key={x} value={x}>{t(`save.freq.${x}`)}</option>)}</select></div>
      <Checkbox label={t('save.consent')} checked={f.consent} onChange={(v) => setF({ ...f, consent: v })} />
      <p className="text-xs text-graphite">{t('save.fairHousing')}</p>
      <button type="submit" className="btn btn-primary">{t('save.submit')}</button>
    </form>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call, sleep } from '@/lib/client';
import { Checkbox, EMAIL_RE, ErrorSummary, Field, CardPayment, type PaymentInfo } from '@/components/forms';
import { FeeConsent } from '@/components/payments/FeeConsent';

type Held = { outcome: 'held'; bookingId: string; manageToken: string; holdExpiresAt: string | null; payment: (PaymentInfo & { amount: number; currency: string }) | null };
type BookResult =
  | Held
  | { outcome: 'confirmed'; bookingId: string; manageToken: string; holdExpiresAt: string | null; payment: null }
  | { outcome: 'waitlisted'; waitlistEntryId: string; position: number; manageToken?: string };

type Phase = { kind: 'form' } | { kind: 'held'; r: Held } | { kind: 'confirmed'; bookingId: string; token: string } | { kind: 'waitlisted'; id: string; position: number; token?: string } | { kind: 'expired' };

/**
 * Studio booking: details → (paid) seat hold with countdown → pay → confirmed. A full class offers the
 * waitlist instead. Errors keep the entered details.
 */
export function BookClass(props: { occurrenceId: string; full: boolean; paid: boolean; priceLabel: string; className: string; whenLabel: string; locationName: string; brandName: string; manageBase: string }) {
  const t = useTranslations('booking');
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [full, setFull] = useState(props.full);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [now, setNow] = useState(() => Date.now());
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (phase.kind !== 'held') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase.kind]);
  useEffect(() => { heading.current?.focus(); }, [phase.kind]);

  const fieldErrors: Record<string, string> = {};
  if (error?.fields) Object.assign(fieldErrors, error.fields);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!name.trim()) fe['contact.name'] = tc('required', { field: t('name') });
    if (!EMAIL_RE.test(email)) fe['contact.email'] = tc('invalidEmail');
    if (Object.keys(fe).length) { setError({ message: t('yourDetails'), fields: fe }); return; }
    setBusy(true);
    setError(null);
    const r = await call<BookResult>('POST', `/public/studios/occurrences/${props.occurrenceId}/bookings`, {
      contact: { name: name.trim(), email: email.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}), marketingConsent: consent },
      joinWaitlist: full,
    });
    setBusy(false);
    if (!r.ok) {
      if (r.error.code === 'class_full') { setFull(true); setError({ message: t('fullNotice') }); return; }
      const msg = r.error.code === 'duplicate_booking' ? t('duplicate') : r.error.code === 'class_started' ? t('classStarted') : r.error.message;
      setError({ message: msg, fields: r.error.fields });
      return;
    }
    const d = r.data;
    if (d.outcome === 'waitlisted') setPhase({ kind: 'waitlisted', id: d.waitlistEntryId, position: d.position, token: d.manageToken });
    else if (d.outcome === 'confirmed') setPhase({ kind: 'confirmed', bookingId: d.bookingId, token: d.manageToken });
    else setPhase({ kind: 'held', r: d });
  }

  async function afterPayment(res: { ok: boolean; message?: string }, held: Held) {
    if (!res.ok) { setError({ message: res.message ?? t('paymentFailed') }); return; }
    // The booking is confirmed by the payment webhook; poll its status rather than assuming success.
    for (let i = 0; i < 15; i++) {
      const s = await call<{ status: string }>('GET', `/public/sites/manage/class-bookings/${held.bookingId}?token=${encodeURIComponent(held.manageToken)}`);
      if (s.ok && s.data.status === 'confirmed') { setPhase({ kind: 'confirmed', bookingId: held.bookingId, token: held.manageToken }); return; }
      if (s.ok && ['expired', 'cancelled'].includes(s.data.status)) { setPhase({ kind: 'expired' }); return; }
      await sleep(1000);
    }
    setError({ message: t('paying') });
  }

  if (phase.kind === 'confirmed' || phase.kind === 'waitlisted') {
    const ok = phase.kind === 'confirmed';
    const href = ok ? `${props.manageBase}/booking/${phase.bookingId}?token=${encodeURIComponent(phase.token)}` : phase.token ? `${props.manageBase}/waitlist/${phase.id}?token=${encodeURIComponent(phase.token)}` : null;
    return (
      <section role="status" className="card mt-5 p-6 text-center">
        <span className={`mx-auto grid size-14 place-items-center rounded-full ${ok ? 'bg-success-bg text-success' : 'bg-warning-bg text-warning'}`} aria-hidden>
          <Icon name={ok ? 'check' : 'clock'} size={28} stroke={2.4} />
        </span>
        <h2 ref={heading} tabIndex={-1} className="mt-4 text-2xl font-extrabold outline-none">{ok ? t('confirmedTitle') : t('waitlistedTitle')}</h2>
        <p className="mt-2 text-graphite">
          {ok ? t('confirmedBody', { name: props.className, when: props.whenLabel, location: props.locationName }) : t('waitlistedBody', { position: phase.position, name: props.className })}
        </p>
        {phase.kind === 'confirmed' && <FeeConsent targetType="class_booking" targetId={phase.bookingId} manageToken={phase.token} />}
        {href && <a href={href} className="btn btn-secondary mt-5">{ok ? t('manage') : t('manageWaitlist')}</a>}
      </section>
    );
  }

  if (phase.kind === 'expired') {
    return (
      <section role="alert" className="card mt-5 p-6">
        <p>{t('holdExpired')}</p>
        <button type="button" className="btn btn-secondary mt-4" onClick={() => window.location.reload()}>{t('checkAgain')}</button>
      </section>
    );
  }

  if (phase.kind === 'held') {
    const left = Math.max(0, Math.floor((new Date(phase.r.holdExpiresAt ?? 0).getTime() - now) / 1000));
    const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (left === 0) return (
      <section role="alert" className="card mt-5 p-6">
        <p>{t('holdExpired')}</p>
        <button type="button" className="btn btn-secondary mt-4" onClick={() => window.location.reload()}>{t('checkAgain')}</button>
      </section>
    );
    return (
      <section className="card mt-5 space-y-4 p-6">
        <h2 ref={heading} tabIndex={-1} className="text-xl font-extrabold outline-none">{t('holdTitle')}</h2>
        <p>{t.rich('holdBody', { time: mmss, b: (c) => <span className="rounded-full bg-canvas px-2 py-0.5 font-bold tabular">{c}</span> })}</p>
        <ErrorSummary message={error?.message ?? null} />
        {phase.r.payment && <CardPayment payment={phase.r.payment} returnUrl={`${props.manageBase}/booking/${phase.r.bookingId}?token=${encodeURIComponent(phase.r.manageToken)}`} label={t('payCta', { amount: props.priceLabel })} onDone={(res) => afterPayment(res, phase.r)} />}
      </section>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="card mt-5 space-y-4 p-6">
      <h2 className="text-xl font-extrabold">{t('yourDetails')}</h2>
      {full && <p className="rounded-2xl bg-warning-bg p-4 text-sm text-warning">{t('fullNotice')}</p>}
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      <Field label={t('name')} autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} error={fieldErrors['contact.name']} />
      <Field label={t('email')} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={fieldErrors['contact.email']} />
      <Field label={t('phone')} type="tel" autoComplete="tel" optional value={phone} onChange={(e) => setPhone(e.target.value)} error={fieldErrors['contact.phone']} />
      <Checkbox label={t('marketing', { brand: props.brandName })} checked={consent} onChange={setConsent} />
      <button type="submit" className="btn btn-primary w-full sm:w-auto" disabled={busy} aria-busy={busy}>
        {full ? t('waitlistCta') : props.paid ? t('bookCta') : t('bookFreeCta')}
      </button>
    </form>
  );
}

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import type { Programme } from '@/lib/types';
import { Checkbox, EMAIL_RE, ErrorSummary, Field, PayButton, type PaymentInfo } from '@/components/forms';

type Result = { registration: { id: string; status: string }; payment: PaymentInfo | null; nextStep: string };

/** Guardian registers a participant. Payment never implies selection when review is required. */
export function RegisterProgramme({ programme, feeLabel, brandName }: { programme: Programme; feeLabel: string; brandName: string }) {
  const t = useTranslations('sports');
  const tb = useTranslations('booking');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ child: '', dob: '', rel: 'parent', name: '', email: '', phone: '', policy: false, consent: false });
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [paid, setPaid] = useState(false);

  if (res && (paid || !res.payment)) {
    const st = res.registration.status;
    return (
      <div role="status" className="mt-4 rounded-2xl bg-success-bg p-4">
        <p className="flex items-center gap-2 font-bold text-success"><Icon name="check" size={18} />{t('submittedTitle')}</p>
        <p className="mt-1 text-sm">{st === 'waitlisted' ? t('waitlistedBody') : st === 'accepted' ? t('acceptedBody') : t('pendingBody')}</p>
      </div>
    );
  }
  if (res?.payment) {
    return (
      <div className="mt-4 space-y-3">
        <p className="text-sm">{t('reviewNote')}</p>
        <ErrorSummary message={error?.message ?? null} />
        <PayButton payment={res.payment} label={tb('payCta', { amount: feeLabel })} onDone={(r) => (r.ok ? setPaid(true) : setError({ message: r.message ?? tb('paymentFailed') }))} />
      </div>
    );
  }
  if (!open) return <button type="button" className="btn btn-primary mt-4" onClick={() => setOpen(true)} aria-expanded={false}>{t('register')}</button>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!f.child.trim()) fe['participant.name'] = tc('required', { field: t('participantName') });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.dob)) fe['participant.dateOfBirth'] = tc('required', { field: t('dob') });
    if (!f.name.trim()) fe['guardian.name'] = tc('required', { field: tb('name') });
    if (!EMAIL_RE.test(f.email)) fe['guardian.email'] = tc('invalidEmail');
    if (!f.policy) fe.acceptRefundPolicy = t('acceptPolicy');
    if (Object.keys(fe).length) { setError({ message: tb('yourDetails'), fields: fe }); return; }
    setBusy(true);
    setError(null);
    const r = await call<Result>('POST', `/public/sports/programmes/${programme.id}/registrations`, {
      guardian: { name: f.name.trim(), email: f.email.trim(), ...(f.phone.trim() ? { phone: f.phone.trim() } : {}), marketingConsent: f.consent },
      participant: { name: f.child.trim(), dateOfBirth: f.dob }, relationship: f.rel, acceptRefundPolicy: true,
    });
    setBusy(false);
    if (!r.ok) { setError({ message: r.error.message, fields: r.error.fields }); return; }
    setRes(r.data);
  }

  const fe = error?.fields ?? {};
  return (
    <form onSubmit={submit} noValidate className="mt-4 space-y-4 border-t border-line-soft pt-4">
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      <fieldset className="space-y-3">
        <legend className="font-bold">{t('participant')}</legend>
        <Field label={t('participantName')} value={f.child} onChange={(e) => setF({ ...f, child: e.target.value })} error={fe['participant.name']} />
        <Field label={t('dob')} type="date" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} error={fe['participant.dateOfBirth']} />
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="font-bold">{t('guardian')}</legend>
        <div>
          <label htmlFor={`rel-${programme.id}`} className="mb-1 block text-sm font-semibold">{t('relationship')}</label>
          <select id={`rel-${programme.id}`} className="field" value={f.rel} onChange={(e) => setF({ ...f, rel: e.target.value })}>
            <option value="parent">{t('rel.parent')}</option>
            <option value="guardian">{t('rel.guardian')}</option>
            <option value="other">{t('rel.other')}</option>
          </select>
        </div>
        <Field label={tb('name')} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={fe['guardian.name']} />
        <Field label={tb('email')} type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={fe['guardian.email']} />
        <Field label={tb('phone')} type="tel" autoComplete="tel" optional value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      </fieldset>
      {programme.refundPolicy && <div className="rounded-2xl bg-canvas p-4 text-sm"><p className="font-bold">{t('refundPolicy')}</p><p>{programme.refundPolicy}</p></div>}
      <Checkbox label={t('acceptPolicy')} checked={f.policy} onChange={(v) => setF({ ...f, policy: v })} error={fe.acceptRefundPolicy} />
      <Checkbox label={tb('marketing', { brand: brandName })} checked={f.consent} onChange={(v) => setF({ ...f, consent: v })} />
      <p className="text-sm text-graphite">{t('reviewNote')}</p>
      <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>{programme.fee.amount ? t('submitPay', { amount: feeLabel }) : t('submit')}</button>
    </form>
  );
}

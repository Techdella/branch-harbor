'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { calendarLabel, money } from '@/lib/format';
import type { Programme } from '@/lib/types';
import { Checkbox, EMAIL_RE, ErrorSummary, Field, PayButton, type PaymentInfo } from '@/components/forms';

type Result = { registration: { id: string; status: string; totalFee: { amount: number; currency: string } }; payment: PaymentInfo | null; nextStep: string; manageToken: string; ageGroup: string; instalments: { seq: number; dueOn: string; amount: { amount: number; currency: string } }[] };

/**
 * Guardian registers a participant: participant + guardian relationship → forms (medical/emergency kept
 * restricted) → payment option (full or instalments) → refund policy → pay the first amount →
 * review-pending confirmation. Payment never implies selection when review is required.
 */
export function RegisterProgramme({ programme, feeLabel, brandName, timeZone, portalHref }: { programme: Programme; feeLabel: string; brandName: string; timeZone: string; portalHref: string }) {
  const t = useTranslations('sports');
  const tb = useTranslations('booking');
  const tc = useTranslations('common');
  const locale = useLocale();
  void timeZone;
  const questions = programme.questions ?? [];
  const options = programme.paymentOptions ?? [];
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ child: '', dob: '', rel: 'parent', name: '', email: '', phone: '', policy: false, consent: false, alerts: true, plan: options[0]?.id ?? '' });
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [paid, setPaid] = useState(false);
  const [payment, setPayment] = useState<PaymentInfo | null>(null);
  const fmt = (amount: number, currency: string) => money({ amount, currency: currency as 'CAD' }, locale);
  const day = (d: string) => calendarLabel(d, locale, { day: 'numeric', month: 'short', year: 'numeric' });

  if (res && (paid || !payment)) {
    const st = res.registration.status;
    const awaiting = st === 'submitted';
    return (
      <div role="status" className="mt-4 rounded-2xl bg-success-bg p-4">
        <p className="flex items-center gap-2 font-bold text-success"><Icon name="check" size={18} />{t('submittedTitle')}</p>
        <p className="mt-1 text-sm">{st === 'waitlisted' ? t('waitlistedBody') : st === 'accepted' ? t('acceptedBody') : awaiting && !paid ? t('paymentPendingBody') : t('pendingBody')}</p>
        {paid && programme.requiresApproval && <p className="mt-1 text-sm font-semibold">{t('paidNotSelected')}</p>}
        {res.instalments.length > 1 && <p className="mt-2 text-sm">{t('nextInstalments', { list: res.instalments.slice(1).map((i) => `${day(i.dueOn)} · ${fmt(i.amount.amount, i.amount.currency)}`).join(' — ') })}</p>}
        <a href={portalHref} className="mt-3 inline-block text-sm font-bold underline">{t('portalLink')}</a>
      </div>
    );
  }
  if (res && payment) {
    return (
      <div className="mt-4 space-y-3">
        <p className="text-sm">{t('reviewNote')}</p>
        <ErrorSummary message={error?.message ?? null} />
        <PayButton payment={payment} label={tb('payCta', { amount: fmt(payment.amount ?? 0, payment.currency ?? programme.fee.currency) })} onDone={async (r) => {
          if (r.ok) { setPaid(true); setRes({ ...res, registration: { ...res.registration, status: programme.requiresApproval ? 'awaiting_review' : 'accepted' } }); return; }
          setError({ message: r.message ?? tb('paymentFailed') });
          // Retry: a new payment attempt; capacity is re-checked by the server (may move to the waitlist).
          const again = await call<{ status: string; payment: PaymentInfo | null }>('POST', `/public/sports/registrations/${res.registration.id}/pay`, { manageToken: res.manageToken });
          if (again.ok) {
            if (again.data.status === 'waitlisted') { setPayment(null); setRes({ ...res, registration: { ...res.registration, status: 'waitlisted' } }); }
            else setPayment(again.data.payment);
          }
        }} />
        <p className="text-xs text-graphite">{t('retryNote')}</p>
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
    for (const q of questions) if (q.required && (answers[q.key] === undefined || answers[q.key] === '')) fe[`answers.${q.key}`] = tc('required', { field: q.label });
    if (programme.refundPolicy && !f.policy) fe.acceptRefundPolicy = t('acceptPolicy');
    if (Object.keys(fe).length) { setError({ message: tb('yourDetails'), fields: fe }); return; }
    setBusy(true);
    setError(null);
    const r = await call<Result>('POST', `/public/sports/programmes/${programme.id}/registrations`, {
      guardian: { name: f.name.trim(), email: f.email.trim(), ...(f.phone.trim() ? { phone: f.phone.trim() } : {}), marketingConsent: f.consent },
      participant: { name: f.child.trim(), dateOfBirth: f.dob }, relationship: f.rel, answers, acceptRefundPolicy: true, absenceAlerts: f.alerts,
      ...(f.plan ? { feePlanId: f.plan } : {}),
    });
    setBusy(false);
    if (!r.ok) { setError({ message: r.error.message, fields: r.error.fields }); return; }
    setRes(r.data);
    setPayment(r.data.payment);
  }

  const fe = error?.fields ?? {};
  const general = questions.filter((q) => !q.restricted && q.category !== 'consent');
  const restricted = questions.filter((q) => q.restricted);
  const consent = questions.filter((q) => q.category === 'consent');
  const qField = (q: (typeof questions)[number]) => {
    const err = fe[`answers.${q.key}`];
    if (q.type === 'yes_no' || q.type === 'consent') return <Checkbox key={q.key} label={q.label} checked={answers[q.key] === true} onChange={(v) => setAnswers({ ...answers, [q.key]: v })} error={err} />;
    if (q.type === 'select') return (
      <div key={q.key}><label htmlFor={`q-${programme.id}-${q.key}`} className="mb-1 block text-sm font-semibold">{q.label}{!q.required && <span className="font-normal text-graphite"> ({tc('optional')})</span>}</label>
        <select id={`q-${programme.id}-${q.key}`} className="field" value={String(answers[q.key] ?? '')} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} aria-invalid={err ? true : undefined}><option value="">—</option>{(q.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
        {err && <p className="mt-1 text-sm font-semibold text-danger">{err}</p>}</div>
    );
    if (q.type === 'textarea') return (
      <div key={q.key}><label htmlFor={`q-${programme.id}-${q.key}`} className="mb-1 block text-sm font-semibold">{q.label}{!q.required && <span className="font-normal text-graphite"> ({tc('optional')})</span>}</label>
        <textarea id={`q-${programme.id}-${q.key}`} className="field min-h-24 py-2" value={String(answers[q.key] ?? '')} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} />
        {q.help && <p className="mt-1 text-xs text-graphite">{q.help}</p>}</div>
    );
    return <Field key={q.key} label={q.label} optional={!q.required} type={q.type === 'phone' ? 'tel' : q.type === 'date' ? 'date' : 'text'} value={String(answers[q.key] ?? '')} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} error={err} hint={q.help ?? undefined} />;
  };

  return (
    <form onSubmit={submit} noValidate className="mt-4 space-y-5 border-t border-line-soft pt-4">
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      <fieldset className="space-y-3">
        <legend className="font-bold">{t('participant')}</legend>
        <Field label={t('participantName')} value={f.child} onChange={(e) => setF({ ...f, child: e.target.value })} error={fe['participant.name']} />
        <Field label={t('dob')} type="date" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} error={fe['participant.dateOfBirth']} hint={programme.age ? t('dobHint') : undefined} />
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="font-bold">{t('guardian')}</legend>
        <div>
          <label htmlFor={`rel-${programme.id}`} className="mb-1 block text-sm font-semibold">{t('relationship')}</label>
          <select id={`rel-${programme.id}`} className="field" value={f.rel} onChange={(e) => setF({ ...f, rel: e.target.value })}>
            <option value="parent">{t('rel.parent')}</option><option value="guardian">{t('rel.guardian')}</option><option value="other">{t('rel.other')}</option>
          </select>
        </div>
        <Field label={tb('name')} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={fe['guardian.name']} />
        <Field label={tb('email')} type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={fe['guardian.email']} />
        <Field label={tb('phone')} type="tel" autoComplete="tel" optional value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <p className="text-xs text-graphite">{t('secondGuardianNote')}</p>
      </fieldset>
      {general.length > 0 && <fieldset className="space-y-3"><legend className="font-bold">{t('aboutParticipant')}</legend>{general.map(qField)}</fieldset>}
      {restricted.length > 0 && (
        <fieldset className="space-y-3 rounded-2xl border border-line-soft p-4">
          <legend className="flex items-center gap-1.5 px-1 font-bold"><Icon name="lock" size={16} />{t('careInfo')}</legend>
          <p className="text-xs text-graphite">{t('careInfoNote')}</p>
          {restricted.map(qField)}
        </fieldset>
      )}
      {consent.length > 0 && <fieldset className="space-y-3"><legend className="font-bold">{t('consents')}</legend>{consent.map(qField)}</fieldset>}
      {programme.fee.amount > 0 && options.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="font-bold">{t('paymentOption')}</legend>
          {options.map((o) => (
            <label key={o.id} className="flex items-start gap-3 rounded-2xl border border-line-soft p-3 text-sm">
              <input type="radio" name={`plan-${programme.id}`} className="mt-1 size-5" checked={f.plan === o.id} onChange={() => setF({ ...f, plan: o.id })} />
              <span><strong>{o.name}</strong><br />
                {o.instalments.map((i) => `${i.seq === 1 ? t('today') : day(i.dueOn)}: ${fmt(i.amountMinor, programme.fee.currency)}`).join(' · ')}</span>
            </label>
          ))}
          {!!programme.siblingDiscountPercent && <p className="text-xs text-graphite">{t('siblingNote', { pct: programme.siblingDiscountPercent })}</p>}
        </fieldset>
      )}
      {programme.refundPolicy && <div className="rounded-2xl bg-canvas p-4 text-sm"><p className="font-bold">{t('refundPolicy')}</p><p>{programme.refundPolicy}</p></div>}
      {programme.refundPolicy && <Checkbox label={t('acceptPolicy')} checked={f.policy} onChange={(v) => setF({ ...f, policy: v })} error={fe.acceptRefundPolicy} />}
      <Checkbox label={t('absenceAlerts')} checked={f.alerts} onChange={(v) => setF({ ...f, alerts: v })} />
      <Checkbox label={tb('marketing', { brand: brandName })} checked={f.consent} onChange={(v) => setF({ ...f, consent: v })} />
      <p className="text-sm text-graphite">{programme.requiresApproval ? t('reviewNote') : t('noReviewNote')}</p>
      <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>{programme.fee.amount ? t('submitPay', { amount: (() => { const o = options.find((x) => x.id === f.plan); return o ? fmt(o.instalments[0]?.amountMinor ?? programme.fee.amount, programme.fee.currency) : feeLabel; })() }) : t('submit')}</button>
    </form>
  );
}

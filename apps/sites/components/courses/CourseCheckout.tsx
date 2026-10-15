'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { call } from '@/lib/client';
import { money } from '@/lib/format';
import type { Money } from '@/lib/types';
import { CardPayment, Checkbox, EMAIL_RE, ErrorSummary, Field, type PaymentInfo } from '@/components/forms';

type Mode = 'enrol' | 'enquire';
const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'] as const;

/** Reads utm_* from the landing URL (ad campaigns) so leads and enrolments are attributed. */
function useUtm() {
  const [utm, setUtm] = useState<Record<string, string>>({});
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const out: Record<string, string> = {};
    for (const k of UTM_KEYS) { const v = p.get(`utm_${k}`); if (v) out[k] = v.slice(0, 150); }
    setUtm(out);
  }, []);
  return utm;
}

export function CourseCheckout({ brand, slug, title, price, purchasable }: { brand: string; slug: string; title: string; price: Money | null; purchasable: boolean }) {
  const t = useTranslations('courses');
  const locale = useLocale();
  const utm = useUtm();
  const [mode, setMode] = useState<Mode>(purchasable ? 'enrol' : 'enquire');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [terms, setTerms] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [payment, setPayment] = useState<(PaymentInfo & { enrolmentId: string; token: string }) | null>(null);
  const [done, setDone] = useState<'enrolled' | 'enquired' | null>(null);

  if (done) return <p role="status" className="mt-4 rounded-2xl bg-success-bg p-4 text-sm font-semibold text-success">{done === 'enrolled' ? t('enrolled', { course: title }) : t('enquired')}</p>;
  if (payment && price) {
    return (
      <div className="mt-4 space-y-3">
        <p className="text-sm">{t('payFor', { course: title })}</p>
        <ErrorSummary message={error?.message ?? null} />
        <CardPayment payment={payment} label={t('payCta', { amount: money(price, locale) })} onDone={(r) => (r.ok ? setDone('enrolled') : setError({ message: r.message ?? t('paymentFailed') }))} />
      </div>
    );
  }

  const submit = async () => {
    const fields: Record<string, string> = {};
    if (!name.trim()) fields.name = t('required');
    if (!EMAIL_RE.test(email)) fields.email = t('invalidEmail');
    if (mode === 'enrol' && !terms) fields.acceptTerms = t('acceptRequired');
    if (Object.keys(fields).length) { setError({ message: t('fixFields'), fields }); return; }
    setBusy(true);
    setError(null);
    const contact = { name: name.trim(), email: email.trim(), phone: phone.trim() || null, utm };
    if (mode === 'enquire') {
      const r = await call('POST', `/public/courses/${encodeURIComponent(brand)}/${encodeURIComponent(slug)}/leads`, { ...contact, message: message.trim() || null, marketingConsent: consent });
      setBusy(false);
      if (r.ok) setDone('enquired'); else setError({ message: r.error.message, fields: r.error.fields });
      return;
    }
    const r = await call<{ enrolmentId: string; accessToken: string; payment: PaymentInfo & { id: string } }>('POST', `/public/courses/${encodeURIComponent(brand)}/${encodeURIComponent(slug)}/enrol`, { ...contact, acceptTerms: true });
    setBusy(false);
    if (r.ok) setPayment({ ...r.data.payment, enrolmentId: r.data.enrolmentId, token: r.data.accessToken });
    else setError({ message: r.error.message, fields: r.error.fields });
  };

  return (
    <form className="mt-4 space-y-3" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {purchasable && (
        <div role="tablist" className="grid grid-cols-2 gap-1 rounded-full bg-canvas p-1 text-sm font-bold">
          {(['enrol', 'enquire'] as const).map((m) => <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setError(null); }} className={`rounded-full px-3 py-2 ${mode === m ? 'bg-white shadow-sm' : ''}`}>{t(`mode.${m}`)}</button>)}
        </div>
      )}
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      <Field label={t('name')} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" error={error?.fields?.name} />
      <Field label={t('email')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" error={error?.fields?.email} />
      <Field label={t('phone')} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" optional />
      {mode === 'enquire' && (
        <div>
          <label htmlFor="course-msg" className="mb-1 block text-sm font-semibold">{t('message')}</label>
          <textarea id="course-msg" className="field min-h-24" value={message} onChange={(e) => setMessage(e.target.value)} />
        </div>
      )}
      {mode === 'enrol' ? <Checkbox label={t('terms')} checked={terms} onChange={setTerms} error={error?.fields?.acceptTerms} /> : <Checkbox label={t('consent')} checked={consent} onChange={setConsent} />}
      <button type="submit" className="btn btn-primary w-full" disabled={busy} aria-busy={busy} data-testid={mode === 'enrol' ? 'course-enrol' : 'course-enquire'}>
        {mode === 'enrol' && price ? t('enrolCta', { amount: money(price, locale) }) : t('enquireCta')}
      </button>
    </form>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { call } from '@/lib/client';
import { money } from '@/lib/format';
import { CardPayment, type PaymentView } from './CardPayment';

/** Loads the signed payment link and lets the customer confirm the payment (3-D Secure) with the Payment Element. */
export function CompletePayment({ paymentId, token }: { paymentId: string | null; token: string | null }) {
  const t = useTranslations('payment');
  const locale = useLocale();
  const [data, setData] = useState<(PaymentView & { clientSecret: string | null }) | null | 'invalid'>(null);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!paymentId || !token) { setData('invalid'); return; }
    void call<PaymentView & { clientSecret: string | null }>('GET', `/public/payments/${paymentId}/action?token=${encodeURIComponent(token)}`).then((r) => setData(r.ok ? r.data : 'invalid'));
  }, [paymentId, token]);
  if (data === null) return <p role="status" className="mt-4 text-graphite">{t('loading')}</p>;
  if (data === 'invalid') return <p role="alert" className="card mt-5 p-6">{t('complete.invalid')}</p>;
  if (done || data.state === 'succeeded') return <p role="status" className="card mt-5 p-6 font-semibold text-success">{t('complete.done')}</p>;
  if (!data.clientSecret) return <p role="status" className="card mt-5 p-6">{t('complete.nothing')}</p>;
  return (
    <section className="card mt-5 space-y-4 p-6">
      <p>{t('complete.intro', { amount: money(data.amount, locale) })}</p>
      {err && <p role="alert" className="text-sm font-semibold text-danger">{err}</p>}
      <CardPayment payment={{ id: data.id, sandbox: data.sandbox, clientSecret: data.clientSecret }} label={t('complete.cta')} onDone={(r) => (r.ok ? setDone(true) : setErr(r.message ?? t('errors.generic')))} />
    </section>
  );
}

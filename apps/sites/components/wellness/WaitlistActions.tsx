'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { call } from '@/lib/client';
import { ErrorSummary, CardPayment, type PaymentInfo } from '@/components/forms';

/** Claim an offered slot (it may have been taken meanwhile) or leave the waitlist. */
export function WaitlistActions({ id, token, status }: { id: string; token: string; status: string }) {
  const t = useTranslations('wellnessPro');
  const tb = useTranslations('booking');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentInfo | null>(null);
  if (done) return <p role="status" className="rounded-2xl bg-success-bg p-4 font-semibold text-success">{done}</p>;
  if (payment) return <CardPayment payment={payment} label={tb('payCta', { amount: '' }).trim()} onDone={(r) => (r.ok ? setDone(t('claimed')) : setErr(r.message ?? tb('paymentFailed')))} />;
  if (!['waiting', 'offered'].includes(status)) return null;
  return (
    <div className="space-y-3 pt-2">
      <ErrorSummary message={err} />
      <div className="flex flex-wrap gap-2">
        {status === 'offered' && <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => {
          setBusy(true);
          const r = await call<{ payment: PaymentInfo | null }>('POST', `/public/wellness/waitlist/${id}/claim`, { manageToken: token });
          setBusy(false);
          if (!r.ok) { setErr(r.error.code === 'slot_unavailable' ? t('offerGone') : r.error.message); return; }
          if (r.data.payment) setPayment(r.data.payment); else setDone(t('claimed'));
        }}>{t('claim')}</button>}
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={async () => {
          setBusy(true);
          const r = await call('POST', `/public/wellness/waitlist/${id}/leave`, { manageToken: token });
          setBusy(false);
          if (!r.ok) { setErr(r.error.message); return; }
          setDone(t('left'));
        }}>{t('leave')}</button>
      </div>
    </div>
  );
}

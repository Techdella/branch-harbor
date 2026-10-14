'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { call } from '@/lib/client';
import { ErrorSummary } from '@/components/forms';

/**
 * Confirmed destructive action (cancel booking / appointment, leave waitlist) via the manage token.
 * The outcome reported comes from the server response, including what happened to the payment.
 */
export function ManageAction({ path, token, label, question }: { path: string; token: string; label: string; question: string }) {
  const t = useTranslations('manage');
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (done) return <p role="status" className="rounded-2xl bg-success-bg p-4 font-semibold text-success">{done}</p>;
  if (!ask) return <button type="button" className="btn btn-secondary" onClick={() => setAsk(true)}>{label}</button>;
  return (
    <div className="space-y-3 rounded-2xl border border-line p-4" role="group" aria-label={label}>
      <p className="font-semibold">{question}</p>
      <ErrorSummary message={err} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await call<{ payment?: { action?: string }; status?: string }>('POST', path, { manageToken: token });
            setBusy(false);
            if (!r.ok) { setErr(r.error.message); return; }
            const action = r.data.payment?.action;
            setDone(action === 'refunded' ? t('cancelledRefund') : action === 'voided' ? t('cancelledVoid') : r.data.status === 'left' ? t('status.left') : t('cancelledNone'));
            setTimeout(() => window.location.reload(), 2500);
          }}
        >
          {t('confirmCancel')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setAsk(false)}>{t('keep')}</button>
      </div>
    </div>
  );
}

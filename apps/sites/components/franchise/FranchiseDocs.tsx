'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { Checkbox, ErrorSummary, Field } from '@/components/forms';

const fmt = (iso: string, locale: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));
const fmtDay = (iso: string, locale: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso));

/** Disclosure e-receipt: typed name + acknowledgement. Records time and IP on the server; it is not an agreement. */
export function ReceiptForm({ token, signedAt: initial, signedName }: { token: string; signedAt: string | null; signedName: string | null }) {
  const t = useTranslations('franchiseSite');
  const locale = useLocale();
  const [name, setName] = useState('');
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ at: string; earliest: string | null } | null>(initial ? { at: initial, earliest: null } : null);
  if (done) {
    return (
      <div role="status" className="card flex flex-col gap-2 p-5">
        <p className="flex items-center gap-2 font-bold text-success"><Icon name="check-circle" size={18} />{t('receiptSigned', { date: fmt(done.at, locale), name: signedName ?? name })}</p>
        {done.earliest && <p className="text-sm text-graphite">{t('waitingNote', { date: fmtDay(done.earliest, locale) })}</p>}
      </div>
    );
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2 || !ack) { setErr(t('errReceipt')); return; }
    setBusy(true);
    const r = await call<{ receiptSignedAt: string; earliestSigningAt: string | null }>('POST', `/public/franchise/disclosures/${encodeURIComponent(token)}/receipt`, { name: name.trim(), acknowledge: true });
    setBusy(false);
    if (!r.ok) { setErr(r.error.message); return; }
    setDone({ at: r.data.receiptSignedAt, earliest: r.data.earliestSigningAt });
  };
  return (
    <form onSubmit={submit} noValidate className="card flex flex-col gap-4 p-5">
      <ErrorSummary message={err} />
      <Field label={t('typedName')} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
      <Checkbox label={t('acknowledge')} checked={ack} onChange={setAck} />
      <p className="text-xs text-graphite">{t('receiptNotAgreement')}</p>
      <button type="submit" className="btn btn-primary self-start" disabled={busy}>{busy ? t('sending') : t('signReceipt')}</button>
    </form>
  );
}

/** Built-in agreement e-signature. The server refuses while a waiting period or registration is outstanding. */
export function SignForm({ token, canSign, waitingUntil, otherwiseBlocked, status, signedAt }: { token: string; canSign: boolean; waitingUntil: string | null; otherwiseBlocked: boolean; status: string; signedAt: string | null }) {
  const t = useTranslations('franchiseSite');
  const locale = useLocale();
  const [name, setName] = useState('');
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ at: string; coolingOff: string | null } | null>(status === 'signed' && signedAt ? { at: signedAt, coolingOff: null } : null);
  if (done) {
    return (
      <div role="status" className="card flex flex-col gap-2 p-5">
        <p className="flex items-center gap-2 font-bold text-success"><Icon name="check-circle" size={18} />{t('signedDone', { date: fmt(done.at, locale) })}</p>
        {done.coolingOff && <p className="text-sm text-graphite">{t('coolingOff', { date: fmtDay(done.coolingOff, locale) })}</p>}
      </div>
    );
  }
  if (status !== 'sent') return <p className="card p-5">{t('notAvailable')}</p>;
  if (!canSign) {
    return (
      <div role="status" className="card flex items-start gap-3 p-5">
        <Icon name="clock" size={20} className="mt-0.5 shrink-0" />
        <p>{waitingUntil && !otherwiseBlocked ? t('canSignFrom', { date: fmtDay(waitingUntil, locale) }) : t('cannotSignYet')}</p>
      </div>
    );
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2 || !ack) { setErr(t('errSign')); return; }
    setBusy(true);
    const r = await call<{ signedAt: string; coolingOffEndsAt: string | null }>('POST', `/public/franchise/agreements/${encodeURIComponent(token)}/sign`, { name: name.trim(), accept: true });
    setBusy(false);
    if (!r.ok) { setErr(r.error.message); return; }
    setDone({ at: r.data.signedAt, coolingOff: r.data.coolingOffEndsAt });
  };
  return (
    <form onSubmit={submit} noValidate className="card flex flex-col gap-4 p-5">
      <ErrorSummary message={err} />
      <Field label={t('typedName')} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
      <Checkbox label={t('accept')} checked={ack} onChange={setAck} />
      <p className="text-xs text-graphite">{t('esignNote')}</p>
      <button type="submit" className="btn btn-primary self-start" disabled={busy}>{busy ? t('sending') : t('sign')}</button>
    </form>
  );
}

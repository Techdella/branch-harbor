'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { dateLong, money } from '@/lib/format';
import type { Money } from '@/lib/types';
import { Checkbox, EMAIL_RE, ErrorSummary, Field, PayButton, type PaymentInfo } from '@/components/forms';

export interface PlanT { id: string; name: string; description: string | null; serviceName: string; sessions: number; price: Money; perSession: Money; validityDays: number; sharing: string; maxSharedWith: number }
type Bought = { kind: 'package' | 'voucher'; id: string; token: string; payment: PaymentInfo; amount: Money };

/** Buy a package or a gift voucher (sandbox payment), and check a voucher balance. */
export function PackagesShop(props: { locationId: string; plans: PlanT[]; vouchers: { currency: string; minMinor: number; maxMinor: number; validityDays: number }; paymentsEnabled: boolean; manageBase: string; bookHref: string; brandName: string }) {
  const t = useTranslations('wellnessPro');
  const tb = useTranslations('booking');
  const tc = useTranslations('common');
  const locale = useLocale();
  const cur = props.vouchers.currency;
  const [plan, setPlan] = useState<PlanT | null>(null);
  const [voucher, setVoucher] = useState(false);
  const [amount, setAmount] = useState('100');
  const [recipient, setRecipient] = useState({ name: '', email: '', message: '' });
  const [c, setC] = useState({ name: '', email: '', consent: false });
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [bought, setBought] = useState<Bought | null>(null);
  const [paid, setPaid] = useState(false);
  const [check, setCheck] = useState('');
  const [balance, setBalance] = useState<{ status: string; balance: Money; expiresAt: string; usableHere: boolean; note: string | null } | null>(null);
  const [checkErr, setCheckErr] = useState<string | null>(null);

  async function buy(e: React.FormEvent) {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!c.name.trim()) fe.name = tc('required', { field: tb('name') });
    if (!EMAIL_RE.test(c.email)) fe.email = tc('invalidEmail');
    const minor = Math.round(Number(amount) * 100);
    if (voucher && (!minor || minor < props.vouchers.minMinor || minor > props.vouchers.maxMinor)) fe.amount = t('amountRange', { min: money({ amount: props.vouchers.minMinor, currency: cur }, locale), max: money({ amount: props.vouchers.maxMinor, currency: cur }, locale) });
    if (Object.keys(fe).length) { setError({ message: tb('yourDetails'), fields: fe }); return; }
    setBusy(true);
    setError(null);
    const contact = { name: c.name.trim(), email: c.email.trim(), marketingConsent: c.consent };
    if (voucher) {
      const r = await call<{ voucher: { id: string }; manageToken: string; payment: PaymentInfo }>('POST', `/public/wellness/${props.locationId}/vouchers`, { amountMinor: minor, contact, ...(recipient.name ? { recipientName: recipient.name } : {}), ...(EMAIL_RE.test(recipient.email) ? { recipientEmail: recipient.email } : {}), ...(recipient.message ? { message: recipient.message } : {}) });
      setBusy(false);
      if (!r.ok) { setError({ message: r.error.message, fields: r.error.fields }); return; }
      setBought({ kind: 'voucher', id: r.data.voucher.id, token: r.data.manageToken, payment: r.data.payment, amount: { amount: minor, currency: cur } });
    } else if (plan) {
      const r = await call<{ clientPackage: { id: string }; manageToken: string; payment: PaymentInfo }>('POST', `/public/wellness/${props.locationId}/packages`, { planId: plan.id, contact });
      setBusy(false);
      if (!r.ok) { setError({ message: r.error.message, fields: r.error.fields }); return; }
      setBought({ kind: 'package', id: r.data.clientPackage.id, token: r.data.manageToken, payment: r.data.payment, amount: plan.price });
    }
  }

  if (bought && paid) {
    const href = `${props.manageBase}/${bought.kind}/${bought.id}?token=${encodeURIComponent(bought.token)}`;
    return (
      <section role="status" className="card mt-6 p-6 text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-full bg-success-bg text-success" aria-hidden><Icon name="check" size={28} stroke={2.4} /></span>
        <h2 className="mt-4 text-2xl font-extrabold">{bought.kind === 'voucher' ? t('voucherBought') : t('packageBought')}</h2>
        <p className="mt-2 text-graphite">{bought.kind === 'voucher' ? t('voucherBoughtBody') : t('packageBoughtBody')}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2"><a href={href} className="btn btn-primary">{bought.kind === 'voucher' ? t('viewVoucher') : t('viewPackage')}</a><a href={props.bookHref} className="btn btn-secondary">{t('bookNow')}</a></div>
      </section>
    );
  }
  if (bought) {
    return (
      <section className="card mt-6 space-y-4 p-6">
        <h2 className="text-xl font-extrabold">{t('payNow')}</h2>
        <p>{money(bought.amount, locale)}</p>
        <ErrorSummary message={error?.message ?? null} />
        <PayButton payment={bought.payment} label={tb('payCta', { amount: money(bought.amount, locale) })} onDone={(r) => (r.ok ? setPaid(true) : setError({ message: r.message ?? tb('paymentFailed') }))} />
      </section>
    );
  }

  return (
    <div className="mt-6 space-y-8">
      {!props.paymentsEnabled && <p className="rounded-2xl bg-warning-bg p-4 text-sm text-warning">{t('noOnlinePayments')}</p>}
      <section aria-labelledby="pk">
        <h2 id="pk" className="text-xl font-extrabold">{t('packages')}</h2>
        {props.plans.length === 0 ? <p className="mt-2 text-sm text-graphite">{t('noPackages')}</p> : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {props.plans.map((p) => (
              <label key={p.id} className={`card flex cursor-pointer gap-3 p-4 ${plan?.id === p.id && !voucher ? 'outline outline-2 outline-ink' : ''}`}>
                <input type="radio" name="buy" className="mt-1 size-5 accent-[var(--site-brand)]" checked={plan?.id === p.id && !voucher} onChange={() => { setPlan(p); setVoucher(false); setError(null); }} disabled={!props.paymentsEnabled} />
                <span>
                  <span className="block font-bold">{p.name}</span>
                  <span className="block text-sm text-graphite">{money(p.price, locale)} · {t('perSession', { amount: money(p.perSession, locale) })}</span>
                  <span className="block text-sm text-graphite">{t('validFor', { days: p.validityDays })}{p.sharing === 'shareable' ? ` · ${t('shareableWith', { n: p.maxSharedWith })}` : ` · ${t('personal')}`}</span>
                  {p.description && <span className="mt-1 block text-sm text-graphite">{p.description}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="gv">
        <h2 id="gv" className="text-xl font-extrabold">{t('giftVouchers')}</h2>
        <p className="mt-1 text-sm text-graphite">{t('voucherIntro', { currency: cur, days: props.vouchers.validityDays })}</p>
        <label className={`card mt-3 flex cursor-pointer gap-3 p-4 ${voucher ? 'outline outline-2 outline-ink' : ''}`}>
          <input type="radio" name="buy" className="mt-1 size-5 accent-[var(--site-brand)]" checked={voucher} onChange={() => { setVoucher(true); setPlan(null); setError(null); }} disabled={!props.paymentsEnabled} />
          <span className="font-bold">{t('buyVoucher')}</span>
        </label>
      </section>
      {(plan || voucher) && (
        <form onSubmit={buy} noValidate className="card space-y-4 p-6">
          <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
          {voucher && (
            <>
              <Field label={t('voucherAmount', { currency: cur })} type="number" min={props.vouchers.minMinor / 100} max={props.vouchers.maxMinor / 100} step="1" value={amount} onChange={(e) => setAmount(e.target.value)} error={error?.fields?.amount} />
              <Field label={t('recipientName')} optional value={recipient.name} onChange={(e) => setRecipient({ ...recipient, name: e.target.value })} />
              <Field label={t('recipientEmail')} type="email" optional value={recipient.email} onChange={(e) => setRecipient({ ...recipient, email: e.target.value })} />
              <Field label={t('message')} optional value={recipient.message} onChange={(e) => setRecipient({ ...recipient, message: e.target.value })} />
            </>
          )}
          <h3 className="text-lg font-extrabold">{tb('yourDetails')}</h3>
          <Field label={tb('name')} autoComplete="name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} error={error?.fields?.name} />
          <Field label={tb('email')} type="email" autoComplete="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} error={error?.fields?.email} />
          <Checkbox label={tb('marketing', { brand: props.brandName })} checked={c.consent} onChange={(v) => setC({ ...c, consent: v })} />
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>{t('continueToPay')}</button>
        </form>
      )}
      <section aria-labelledby="bal" className="card space-y-3 p-5">
        <h2 id="bal" className="text-lg font-extrabold">{t('checkBalance')}</h2>
        <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); setCheckErr(null); setBalance(null); const r = await call<typeof balance & object>('POST', `/public/wellness/${props.locationId}/vouchers/check`, { code: check }); if (r.ok) setBalance(r.data); else setCheckErr(r.status === 404 ? t('voucherUnknown') : r.error.message); }}>
          <div className="min-w-[220px] flex-1"><Field label={t('voucherCode')} value={check} onChange={(e) => setCheck(e.target.value)} /></div>
          <button type="submit" className="btn btn-secondary" disabled={check.trim().length < 4}>{t('check')}</button>
        </form>
        {checkErr && <p role="alert" className="text-sm font-bold text-danger">{checkErr}</p>}
        {balance && <p role="status" className="text-sm"><strong>{money(balance.balance, locale)}</strong> · {t(`voucherStatus.${balance.status}` as 'voucherStatus.active')} · {t('expiresOn', { date: dateLong(balance.expiresAt, 'UTC', locale) })}{balance.note ? ` · ${balance.note}` : ''}</p>}
      </section>
    </div>
  );
}

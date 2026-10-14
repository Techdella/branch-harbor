'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { EMAIL_RE, ErrorSummary, Field, CardPayment } from '@/components/forms';
import { sleep } from '@/lib/client';
import { dateTime, money } from '@/lib/format';
import { getSession, pcall, setSession, type Account as AccountT } from '@/lib/portal';
import { SavedCard, type CardOnFile, type SetupStart } from '@/components/payments/SavedCard';

/** Email sign-in (magic link → session) used by the account, pricing and online pages. */
export function SignIn({ brand, locationId, returnPath, compact }: { brand: string; locationId: string; returnPath: string; compact?: boolean }) {
  const t = useTranslations('studio');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [state, setState] = useState<{ sent: boolean; devCode?: string; error?: string; busy?: boolean }>({ sent: false });
  return (
    <form className={`card space-y-3 ${compact ? 'p-4' : 'p-6'}`} noValidate onSubmit={async (e) => {
      e.preventDefault();
      if (!EMAIL_RE.test(email)) { setState({ sent: false, error: t('invalidEmail') }); return; }
      setState({ sent: false, busy: true });
      const r = await pcall<{ sent: boolean; devCode?: string }>(brand, 'POST', '/public/studios/account/link', { locationId, email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}), returnUrl: `${window.location.origin}${returnPath}` });
      setState(r.ok ? { sent: true, devCode: r.data.devCode } : { sent: false, error: r.error.message });
    }}>
      <h2 className="text-xl font-extrabold">{t('signInTitle')}</h2>
      <p className="text-sm text-graphite">{t('signInBody')}</p>
      {state.sent ? (
        <div role="status" className="rounded-2xl bg-success-bg p-4 text-sm text-success">
          <p className="font-bold">{t('linkSent')}</p>
          {state.devCode && <a className="link mt-1 block font-semibold" href={`${returnPath}?code=${encodeURIComponent(state.devCode)}`}>{t('devLink')}</a>}
        </div>
      ) : (
        <>
          <ErrorSummary message={state.error ?? null} />
          <Field label={t('email')} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Field label={t('name')} autoComplete="name" optional hint={t('nameHint')} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={state.busy}>{t('sendLink')}</button>
        </>
      )}
    </form>
  );
}

/** Exchanges ?code= from the email link for a session, then removes it from the address bar. */
export function useStudioSession(brand: string) {
  const [session, setS] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      if (code) {
        url.searchParams.delete('code');
        window.history.replaceState(null, '', url.toString());
        const r = await pcall<{ session: string }>(brand, 'POST', '/public/studios/account/session', { code });
        if (r.ok) setSession(brand, r.data.session);
        else setError(r.error.message);
      }
      setS(getSession(brand));
    })();
  }, [brand]);
  const signOut = useCallback(async () => { await pcall(brand, 'POST', '/public/studios/account/sign-out', {}); setSession(brand, null); setS(null); }, [brand]);
  return { session, error, signOut, refresh: () => setS(getSession(brand)) };
}

export function AccountView({ brand, locationId, accountPath, pricingPath, onlinePath, timeZone }: { brand: string; locationId: string; accountPath: string; pricingPath: string; onlinePath: string; timeZone: string }) {
  const t = useTranslations('studio');
  const locale = useLocale();
  const { session, error, signOut } = useStudioSession(brand);
  const [acct, setAcct] = useState<AccountT | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [feePay, setFeePay] = useState<{ feeId: string; payment: { id: string; sandbox: boolean; amount: number; currency: string }; purchaseId: string } | null>(null);
  const load = useCallback(async () => {
    const r = await pcall<AccountT>(brand, 'GET', '/public/studios/account');
    if (r.ok) setAcct(r.data);
    else if (r.status !== 401) setMsg({ ok: false, text: r.error.message });
    else setAcct(null);
  }, [brand]);
  useEffect(() => { if (session) void load(); }, [session, load]);

  if (session === undefined) return <p className="text-graphite">{t('loading')}</p>;
  if (!session) return (<>{error && <ErrorSummary message={error} />}<SignIn brand={brand} locationId={locationId} returnPath={accountPath} /></>);
  if (!acct) return <p className="text-graphite">{t('loading')}</p>;
  const act = async (path: string, ok: string, body: unknown = {}) => {
    const r = await pcall<{ lateCancel?: boolean; creditReturned?: boolean | null; fee?: Money | null }>(brand, 'POST', path, body);
    if (!r.ok) { setMsg({ ok: false, text: r.error.message }); return; }
    const d = r.data;
    setMsg({ ok: true, text: [ok, d.lateCancel ? t('lateCancelled') : '', d.creditReturned === true ? t('creditBack') : d.creditReturned === false ? t('creditKept') : '', d.fee ? t('feeAdded', { amount: money(d.fee, locale) }) : ''].filter(Boolean).join(' ') });
    await load();
  };
  type Money = { amount: number; currency: string };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-graphite">{t('signedInAs', { name: acct.customer.name, email: acct.customer.email ?? '' })}</p>
        <button type="button" className="btn btn-secondary" onClick={signOut}>{t('signOut')}</button>
      </div>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`rounded-2xl p-4 text-sm ${msg.ok ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger'}`}>{msg.text}</p>}

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="card p-5">
          <h2 className="font-extrabold">{t('membership')}</h2>
          {acct.memberships.length === 0 ? <p className="mt-1 text-sm text-graphite">{t('noMembership')} <a className="link" href={pricingPath}>{t('seePricing')}</a></p> : acct.memberships.map((m) => (
            <div key={m.id} className="mt-2 text-sm">
              <p className="font-bold">{m.name} · <span className="font-semibold">{t(`state.${m.state}`)}</span></p>
              {m.usage && m.usage.limit !== null && <p>{t('usage', { used: m.usage.used, limit: m.usage.limit })}</p>}
              {m.state === 'grace' && m.graceUntil && <p className="text-warning">{t('graceBody', { date: dateTime(m.graceUntil, timeZone, locale) })}</p>}
              {m.state === 'suspended' && <p className="text-danger">{t('suspendedBody')}</p>}
              {m.cancelAt && <p>{t('endsOn', { date: dateTime(m.cancelAt, timeZone, locale) })}</p>}
              {m.pausedUntil && <p>{t('pausedUntil', { date: dateTime(m.pausedUntil, timeZone, locale) })}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {['grace', 'suspended'].includes(m.state) && <button type="button" className="btn btn-primary" onClick={() => act(`/public/studios/account/memberships/${m.id}/retry-payment`, t('retried'))}>{t('retry')}</button>}
                {['active', 'grace', 'paused'].includes(m.state) && <button type="button" className="btn btn-secondary" onClick={() => { if (window.confirm(t('cancelConfirm'))) void act(`/public/studios/account/memberships/${m.id}/cancel`, t('cancelScheduled')); }}>{t('cancelMembership')}</button>}
              </div>
            </div>
          ))}
        </div>
        <div className="card p-5">
          <h2 className="font-extrabold">{t('credits')}</h2>
          <p className="mt-1 text-3xl font-extrabold tabular">{acct.credits.available}</p>
          <ul className="mt-2 space-y-1 text-sm">
            {acct.packs.map((p) => <li key={p.id}>{p.name}: {t('packLine', { left: p.creditsRemaining, total: p.creditsTotal })}{p.expiresAt ? ` · ${p.status === 'expired' ? t('expired') : t('expires', { date: dateTime(p.expiresAt, timeZone, locale) })}` : ''}</li>)}
          </ul>
          <a className="link mt-2 inline-block text-sm font-semibold" href={pricingPath}>{t('buyMore')}</a>
        </div>
      </section>

      {acct.fees.length > 0 && (
        <section className="card p-5">
          <h2 className="font-extrabold">{t('fees')}</h2>
          {acct.fees.map((f) => (
            <div key={f.id} className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              <span className="flex-1">{t(`feeKind.${f.kind}`)} · <strong>{money(f.amount, locale)}</strong></span>
              {feePay?.feeId === f.id ? (
                <CardPayment payment={feePay.payment} label={t('payAmount', { amount: money(f.amount, locale) })} onDone={async (r) => {
                  if (!r.ok) { setMsg({ ok: false, text: r.message ?? t('payFailed') }); return; }
                  for (let i = 0; i < 10; i++) { const s = await pcall<{ status: string }>(brand, 'GET', `/public/studios/account/purchases/${feePay.purchaseId}`); if (s.ok && s.data.status === 'paid') break; await sleep(800); }
                  setFeePay(null); setMsg({ ok: true, text: t('feePaid') }); await load();
                }} />
              ) : (
                <button type="button" className="btn btn-secondary" onClick={async () => {
                  const r = await pcall<{ purchase: { id: string }; payment: { id: string; sandbox: boolean; amount: number; currency: string } | null }>(brand, 'POST', '/public/studios/account/purchases', { locationId: f.locationId, kind: 'fee', productId: f.id });
                  if (!r.ok) setMsg({ ok: false, text: r.error.message });
                  else if (r.data.payment) setFeePay({ feeId: f.id, payment: r.data.payment, purchaseId: r.data.purchase.id });
                }}>{t('payFee')}</button>
              )}
            </div>
          ))}
        </section>
      )}

      <SavedCard
        returnUrl={accountPath}
        load={() => pcall<CardOnFile>(brand, 'GET', `/public/studios/account/payment-method?locationId=${locationId}`)}
        start={(text, loc) => pcall<SetupStart>(brand, 'POST', '/public/studios/account/payment-method/setup', { locationId, purposes: ['save_card', 'renewals', 'fees'], text, locale: loc })}
        remove={() => pcall(brand, 'POST', '/public/studios/account/payment-method/remove', { locationId })}
      />

      <section className="card p-5">
        <h2 className="font-extrabold">{t('upcoming')}</h2>
        {acct.upcoming.length === 0 ? <p className="mt-1 text-sm text-graphite">{t('noUpcoming')}</p> : (
          <ul className="mt-2 divide-y divide-line-soft">
            {acct.upcoming.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="flex-1"><strong>{b.className}</strong> · {dateTime(b.startsAt, b.location.timeZone, locale)} · {b.location.name}<span className="block text-xs text-graphite">{t(`method.${b.paymentMethod}`)}{b.online ? ` · ${t('online')}` : ''}</span></span>
                <button type="button" className="btn btn-secondary" onClick={() => { if (window.confirm(t('cancelBookingConfirm'))) void act(`/public/studios/account/bookings/${b.id}/cancel`, t('bookingCancelled')); }}>{t('cancel')}</button>
              </li>
            ))}
          </ul>
        )}
        {acct.waitlist.length > 0 && <p className="mt-2 text-sm text-graphite">{t('waitlisted', { n: acct.waitlist.length })}</p>}
        <a className="link mt-2 inline-block text-sm font-semibold" href={onlinePath}>{t('onlineLink')}</a>
      </section>

      <section className="card p-5">
        <h2 className="font-extrabold">{t('history')}</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {acct.history.slice(0, 15).map((b) => <li key={b.id}>{dateTime(b.startsAt, b.location.timeZone, locale)} · {b.className} · <span className="font-semibold">{t(`bookingStatus.${b.status}`)}</span>{b.lateCancel ? ` (${t('late')})` : ''}</li>)}
        </ul>
      </section>

      {acct.preferences && (
        <section className="card space-y-2 p-5">
          <h2 className="font-extrabold">{t('preferences')}</h2>
          {([['class_updates_email', acct.preferences.classUpdatesEmail], ['class_updates_sms', acct.preferences.classUpdatesSms], ['marketing_email', !!acct.preferences.marketingEmail], ['marketing_sms', !!acct.preferences.marketingSms]] as const).map(([purpose, on]) => (
            <label key={purpose} className="flex items-center gap-3 text-sm">
              <input type="checkbox" className="size-5 accent-[var(--site-brand)]" checked={on} onChange={(e) => act('/public/studios/account/consents', t('saved'), { purpose, granted: e.target.checked })} />
              {t(`pref.${purpose}`)}
            </label>
          ))}
          <p className="flex items-center gap-1.5 text-xs text-graphite"><Icon name="info" size={14} />{t('prefNote')}</p>
        </section>
      )}
    </div>
  );
}

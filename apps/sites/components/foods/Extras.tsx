'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { calendarLabel, dateTime, money } from '@/lib/format';
import type { CateringEnquiryX, CateringPackageX, MealPlanX, SubscriptionX, TabX } from '@/lib/foods-ext';
import { Checkbox, EMAIL_RE, ErrorSummary, Field, CardPayment, type PaymentInfo } from '@/components/forms';
import { SavedCard, type CardOnFile, type SetupStart } from '@/components/payments/SavedCard';

/* ───────── Table tab ───────── */

/** The guest's open tab at this table (token kept on this device): items, total and paying the whole tab with an optional tip. */
export function TabPanel({ storageKey, tipsBps }: { storageKey: string; tipsBps: number[] }) {
  const t = useTranslations('foodsite');
  const locale = useLocale();
  const [tab, setTab] = useState<TabX | null>(null);
  const [cred, setCred] = useState<{ id: string; token: string } | null>(null);
  const [tip, setTip] = useState(0);
  const [payment, setPayment] = useState<PaymentInfo | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    try {
      const token = window.localStorage.getItem(storageKey);
      const id = window.localStorage.getItem(`${storageKey}:id`);
      if (token && id) setCred({ id, token });
    } catch { /* storage unavailable */ }
  }, [storageKey]);
  useEffect(() => {
    if (!cred) return;
    void call<TabX>('GET', `/public/foods/tabs/${cred.id}?token=${encodeURIComponent(cred.token)}`).then((r) => {
      if (r.ok) setTab(r.data);
      else { try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ } setCred(null); }
    });
  }, [cred, storageKey]);
  if (!tab || !cred) return null;
  if (tab.status !== 'open') return <p className="card mt-6 p-5" role="status">{t('tabPaid')}</p>;
  const tipMinor = Math.round((tab.subtotal.amount * tip) / 10_000);
  return (
    <section aria-labelledby="h-tab" className="card mt-6 max-w-xl p-5">
      <h2 id="h-tab" className="text-lg font-extrabold">{t('yourTab', { table: tab.tableLabel ?? '' })}</h2>
      <ul className="mt-2 space-y-1 text-sm">{tab.orders.map((o) => <li key={o.id} className="flex justify-between"><span>{o.orderNumber}</span><span className="tabular">{money(o.total, locale)}</span></li>)}</ul>
      <p className="mt-2 flex justify-between border-t border-line-soft pt-2 font-bold"><span>{t('amountDue')}</span><span className="tabular">{money(tab.amountDue, locale)}</span></p>
      {tipsBps.length > 0 && (
        <fieldset className="mt-3"><legend className="text-sm font-bold">{t('tipOptional')}</legend>
          <div className="mt-1 flex flex-wrap gap-2">{[0, ...tipsBps].map((b) => <button key={b} type="button" aria-pressed={tip === b} onClick={() => setTip(b)} className={`min-h-10 rounded-full border px-3 text-sm font-bold ${tip === b ? 'border-ink bg-ink text-white' : 'border-line'}`}>{b ? `${b / 100}%` : t('noTip')}</button>)}</div>
        </fieldset>
      )}
      {msg && <p role="alert" className="mt-2 text-sm font-bold text-danger">{msg}</p>}
      {!payment ? (
        <button type="button" className="btn btn-primary mt-4" onClick={async () => { const r = await call<{ payment: PaymentInfo }>('POST', `/public/foods/tabs/${tab.id}/pay`, { token: cred.token, tipMinor }); if (r.ok) setPayment(r.data.payment); else setMsg(r.error.message); }}>
          <Icon name="card" size={18} />{t('payTab', { amount: money({ amount: tab.amountDue.amount + tipMinor, currency: tab.amountDue.currency }, locale) })}
        </button>
      ) : (
        <div className="mt-4"><CardPayment payment={payment} label={t('confirmPayment')} onDone={(r) => { if (r.ok) setTab({ ...tab, status: 'paid' }); else setMsg(r.message ?? ''); }} /></div>
      )}
      <p className="mt-2 text-xs text-graphite">{t('tabCounter')}</p>
    </section>
  );
}

/* ───────── Catering ───────── */

export function CateringEnquiryForm({ locationId, brandName, packages, currency, earliestDate, manageBase }: { locationId: string; brandName: string; packages: CateringPackageX[]; currency: string; earliestDate: string; manageBase: string }) {
  const t = useTranslations('foodsite');
  const tb = useTranslations('booking');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [f, setF] = useState({ name: '', email: '', phone: '', date: earliestDate, time: '12:30', guests: '20', packageId: packages[0]?.id ?? '', fulfilment: 'pickup', line1: '', city: '', postalCode: '', notes: '', dietary: '', consent: false });
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const pkg = packages.find((p) => p.id === f.packageId);
  const guests = Number(f.guests) || 0;
  return (
    <form noValidate className="card mt-6 max-w-2xl space-y-4 p-6" onSubmit={async (e) => {
      e.preventDefault();
      const fe: Record<string, string> = {};
      if (!f.name.trim()) fe.name = tc('required', { field: tb('name') });
      if (!EMAIL_RE.test(f.email)) fe.email = tc('invalidEmail');
      if (Object.keys(fe).length) { setError({ message: tb('yourDetails'), fields: fe }); return; }
      setBusy(true); setError(null);
      const r = await call<{ enquiry: { id: string }; manageToken: string }>('POST', `/public/foods/${locationId}/catering/enquiries`, {
        contact: { name: f.name.trim(), email: f.email.trim(), ...(f.phone ? { phone: f.phone } : {}), marketingConsent: f.consent }, eventDate: f.date, eventTime: f.time, guests, ...(f.packageId ? { packageId: f.packageId } : {}),
        fulfilment: f.fulfilment, ...(f.fulfilment !== 'pickup' ? { address: { line1: f.line1, city: f.city, postalCode: f.postalCode } } : {}), ...(f.notes ? { notes: f.notes } : {}), ...(f.dietary ? { dietaryNotes: f.dietary } : {}),
      });
      setBusy(false);
      if (!r.ok) { setError({ message: r.error.message, fields: r.error.fields ? Object.fromEntries(Object.entries(r.error.fields).map(([k, v]) => [k.split('.').pop()!, v])) : undefined }); return; }
      window.location.assign(`${manageBase}/${r.data.enquiry.id}?token=${encodeURIComponent(r.data.manageToken)}`);
    }}>
      <h2 className="text-xl font-extrabold">{t('cateringForm')}</h2>
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      {packages.length > 0 && (
        <fieldset><legend className="text-sm font-bold">{t('package')}</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {packages.map((p) => (
              <label key={p.id} className={`card flex cursor-pointer gap-3 p-4 ${f.packageId === p.id ? 'ring-2 ring-ink' : ''}`}>
                <input type="radio" name="pkg" checked={f.packageId === p.id} onChange={() => setF({ ...f, packageId: p.id })} />
                <span><span className="block font-bold">{p.name}</span><span className="block text-sm text-graphite">{p.description}</span>
                  <span className="block text-sm font-semibold">{p.pricePerGuest ? t('perGuest', { amount: money(p.pricePerGuest, locale) }) : t('priceOnRequest')}</span>
                  <span className="block text-xs text-graphite">{t('pkgRules', { min: p.minGuests, days: p.leadDays })}</span>
                  <span className="block text-xs text-graphite">{p.allergenStatus === 'declared' ? t('pkgAllergens', { list: p.allergens.join(', ') || t('noneDeclared') }) : t('allergensNotProvided')}</span>
                </span>
              </label>
            ))}
            <label className={`card flex cursor-pointer gap-3 p-4 ${!f.packageId ? 'ring-2 ring-ink' : ''}`}><input type="radio" name="pkg" checked={!f.packageId} onChange={() => setF({ ...f, packageId: '' })} /><span className="font-bold">{t('custom')}</span></label>
          </div>
        </fieldset>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('eventDate')} type="date" min={earliestDate} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} error={error?.fields?.eventDate} />
        <Field label={t('eventTime')} type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
        <Field label={t('guests')} inputMode="numeric" value={f.guests} onChange={(e) => setF({ ...f, guests: e.target.value })} error={error?.fields?.guests} />
      </div>
      {pkg?.pricePerGuest && guests > 0 && <p className="text-sm">{t('estimate', { amount: money({ amount: pkg.pricePerGuest.amount * guests, currency }, locale) })}</p>}
      <fieldset><legend className="text-sm font-bold">{t('fulfilmentQ')}</legend>
        <div className="mt-2 flex flex-wrap gap-2">{['pickup', 'delivery', 'onsite'].map((k) => <label key={k} className="flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-sm"><input type="radio" name="ful" checked={f.fulfilment === k} onChange={() => setF({ ...f, fulfilment: k })} />{t(`fulfil.${k}`)}</label>)}</div>
      </fieldset>
      {f.fulfilment !== 'pickup' && <div className="grid gap-3 sm:grid-cols-3"><Field label={t('address')} value={f.line1} onChange={(e) => setF({ ...f, line1: e.target.value })} /><Field label={t('city')} value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /><Field label={t('postcode')} value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} /></div>}
      <div><label htmlFor="cn" className="mb-1 block text-sm font-semibold">{t('eventNotes')}</label><textarea id="cn" rows={2} maxLength={2000} className="field" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
      <div><label htmlFor="cd" className="mb-1 block text-sm font-semibold">{t('dietaryNeeds')}</label><textarea id="cd" rows={2} maxLength={1000} className="field" value={f.dietary} onChange={(e) => setF({ ...f, dietary: e.target.value })} /><p className="mt-1 text-xs text-graphite">{t('dietaryNeedsHint', { brand: brandName })}</p></div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={tb('name')} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={error?.fields?.name} />
        <Field label={tb('email')} type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={error?.fields?.email} />
        <Field label={tb('phone')} type="tel" optional value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      </div>
      <Checkbox label={tb('marketing', { brand: brandName })} checked={f.consent} onChange={(v) => setF({ ...f, consent: v })} />
      <p className="text-sm text-graphite">{t('nothingBooked')}</p>
      <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>{t('sendEnquiry')}</button>
    </form>
  );
}

export function CateringQuoteView({ initial, token, timeZone }: { initial: CateringEnquiryX; token: string; timeZone: string }) {
  const t = useTranslations('foodsite');
  const locale = useLocale();
  const [e, setE] = useState(initial);
  const [payment, setPayment] = useState<PaymentInfo | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = async () => { const r = await call<CateringEnquiryX>('GET', `/public/foods/catering/enquiries/${e.id}?token=${encodeURIComponent(token)}`); if (r.ok) setE(r.data); };
  return (
    <div className="space-y-5">
      <section role="status" aria-live="polite" className={`rounded-3xl p-6 ${e.status === 'quoted' ? 'border-2 border-dashed border-warning bg-warning-bg' : ['declined', 'cancelled', 'expired'].includes(e.status) ? 'bg-danger-bg' : 'bg-success-bg'}`}>
        <p className="text-xs font-bold uppercase tracking-wider">{t(`cstatus.${e.status}`)}</p>
        <h1 className="text-2xl font-extrabold">{t(`cstatusBody.${e.status}`)}</h1>
        <p className="mt-2 text-sm">{e.reference} · {calendarLabel(e.eventDate, locale, { weekday: 'long', day: 'numeric', month: 'long' })} {e.eventTime ?? ''} · {t('guestsN', { n: e.guests })}{e.packageName ? ` · ${e.packageName}` : ''}</p>
      </section>
      {e.quote && (
        <section className="card p-5">
          <h2 className="text-lg font-extrabold">{t('quoteV', { v: e.quote.version })}</h2>
          <dl className="mt-2 space-y-1 text-sm">
            {e.quote.lines.map((l, i) => <div key={i} className="flex justify-between gap-2"><dt>{l.quantity} × {l.description}</dt><dd className="tabular">{money(l.total, locale)}</dd></div>)}
            <div className="flex justify-between border-t border-line-soft pt-2"><dt>{t('subtotal')}</dt><dd className="tabular">{money(e.quote.subtotal, locale)}</dd></div>
            {e.quote.serviceCharge && <div className="flex justify-between"><dt>{t('serviceCharge')}</dt><dd className="tabular">{money(e.quote.serviceCharge, locale)}</dd></div>}
            {e.quote.deliveryFee && <div className="flex justify-between"><dt>{t('deliveryFee')}</dt><dd className="tabular">{money(e.quote.deliveryFee, locale)}</dd></div>}
            {e.quote.tax ? <div className="flex justify-between"><dt>{t('tax')}</dt><dd className="tabular">{money(e.quote.tax, locale)}</dd></div> : <p className="text-xs text-graphite">{t('noTaxConfigured')}</p>}
            <div className="flex justify-between font-extrabold"><dt>{t('total')}</dt><dd className="tabular">{money(e.quote.total, locale)}</dd></div>
            <div className="flex justify-between"><dt>{t('depositToday')}</dt><dd className="tabular">{money(e.quote.deposit, locale)}</dd></div>
          </dl>
          {e.quote.terms && <p className="mt-2 text-xs text-graphite">{e.quote.terms}</p>}
          <p className="mt-1 text-xs text-graphite" suppressHydrationWarning>{t('validUntil', { when: dateTime(e.quote.validUntil, timeZone, locale) })}</p>
          {msg && <p role="alert" className="mt-2 text-sm font-bold text-danger">{msg}</p>}
          {e.status === 'quoted' && !payment && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary" onClick={async () => { const r = await call<{ enquiry: CateringEnquiryX; payment: PaymentInfo | null }>('POST', `/public/foods/catering/enquiries/${e.id}/accept`, { token, quoteVersion: e.quote!.version }); if (!r.ok) { setMsg(r.error.message); await refresh(); return; } setE({ ...e, ...r.data.enquiry }); setPayment(r.data.payment); }}>{t('acceptQuote')}</button>
              <button type="button" className="btn btn-secondary" onClick={async () => { const r = await call<CateringEnquiryX>('POST', `/public/foods/catering/enquiries/${e.id}/decline`, { token }); if (r.ok) setE({ ...e, ...r.data }); }}>{t('declineQuote')}</button>
            </div>
          )}
          {payment && e.status === 'accepted' && <div className="mt-4"><CardPayment payment={payment} label={t('payDeposit', { amount: money(e.quote.deposit, locale) })} onDone={async (r) => { if (r.ok) await refresh(); else setMsg(r.message ?? ''); }} /></div>}
        </section>
      )}
    </div>
  );
}

/* ───────── Meal plans ───────── */

export function MealPlanSubscribe({ locationId, brandName, plans, timeZone, manageBase }: { locationId: string; brandName: string; plans: MealPlanX[]; timeZone: string; manageBase: string }) {
  const t = useTranslations('foodsite');
  const tb = useTranslations('booking');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [planId, setPlanId] = useState(plans[0]?.id ?? '');
  const [f, setF] = useState({ name: '', email: '', line1: '', city: '', postalCode: '', consent: false });
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [renewals, setRenewals] = useState(false);
  const [live, setLive] = useState<{ id: string; token: string; payment: { clientSecret: string | null; sandbox: boolean; publishableKey: string | null; stripeAccount: string | null; merchantDisplayName: string; mode: 'live' | 'sandbox' } } | null>(null);
  const tp = useTranslations('payment');
  const plan = plans.find((p) => p.id === planId);
  if (live) {
    const manage = `${manageBase}/${live.id}?token=${encodeURIComponent(live.token)}`;
    return (
      <section className="card mt-6 max-w-xl space-y-4 p-6">
        <h2 className="text-xl font-extrabold">{tp('title')}</h2>
        <ErrorSummary message={error?.message ?? null} />
        <CardPayment payment={{ sandbox: false, clientSecret: live.payment.clientSecret }} config={live.payment} returnUrl={manage} label={t('subscribe')} onDone={(r) => { if (r.ok) window.location.assign(manage); else setError({ message: r.message ?? tb('paymentFailed') }); }} />
      </section>
    );
  }
  return (
    <form noValidate className="mt-6 space-y-5" onSubmit={async (e) => {
      e.preventDefault();
      if (!f.name.trim() || !EMAIL_RE.test(f.email)) { setError({ message: tb('yourDetails'), fields: { ...(!f.name.trim() ? { name: tc('required', { field: tb('name') }) } : {}), ...(!EMAIL_RE.test(f.email) ? { email: tc('invalidEmail') } : {}) } }); return; }
      if (!renewals) { setError({ message: tp('consentRequired'), fields: { renewalConsent: tp('consentRequired') } }); return; }
      setBusy(true); setError(null);
      const r = await call<{ subscription: { id: string }; manageToken: string; payment: { sandbox: boolean; clientSecret: string | null; publishableKey: string | null; stripeAccount: string | null; merchantDisplayName: string; mode: 'live' | 'sandbox' } }>('POST', `/public/foods/${locationId}/meal-plans/subscriptions`, { planId, contact: { name: f.name.trim(), email: f.email.trim(), marketingConsent: f.consent }, ...(plan?.fulfilment === 'delivery' ? { address: { line1: f.line1, city: f.city, postalCode: f.postalCode } } : {}), renewalConsent: { text: tp('consentRenewals', { business: brandName }), locale } });
      if (!r.ok) { setBusy(false); setError({ message: r.error.message }); return; }
      if (!r.data.payment.sandbox) { setBusy(false); setLive({ id: r.data.subscription.id, token: r.data.manageToken, payment: r.data.payment }); return; }
      await call('POST', `/public/foods/meal-plans/subscriptions/${r.data.subscription.id}/sandbox-activate`, { token: r.data.manageToken });
      window.location.assign(`${manageBase}/${r.data.subscription.id}?token=${encodeURIComponent(r.data.manageToken)}`);
    }}>
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      <fieldset className="grid gap-3 sm:grid-cols-2"><legend className="sr-only">{t('choosePlan')}</legend>
        {plans.map((p) => (
          <label key={p.id} className={`card flex cursor-pointer gap-3 p-5 ${planId === p.id ? 'ring-2 ring-ink' : ''}`}>
            <input type="radio" name="plan" checked={planId === p.id} onChange={() => setPlanId(p.id)} />
            <span><span className="block text-lg font-extrabold">{p.name}</span><span className="block text-sm text-graphite">{p.description}</span>
              <span className="mt-1 block font-bold">{p.price ? t('perWeek', { amount: money(p.price, locale) }) : t('priceOnRequest')}</span>
              <span className="block text-xs text-graphite" suppressHydrationWarning>{t('planFirst', { date: calendarLabel(p.firstFulfilmentDate, locale, { weekday: 'long', day: 'numeric', month: 'long' }), cutoff: dateTime(p.firstCutoffAt, timeZone, locale) })}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="card max-w-xl space-y-3 p-5">
        <Field label={tb('name')} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={error?.fields?.name} />
        <Field label={tb('email')} type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={error?.fields?.email} />
        {plan?.fulfilment === 'delivery' && <div className="grid gap-3 sm:grid-cols-3"><Field label={t('address')} value={f.line1} onChange={(e) => setF({ ...f, line1: e.target.value })} /><Field label={t('city')} value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /><Field label={t('postcode')} value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} /></div>}
        <Checkbox label={tb('marketing', { brand: brandName })} checked={f.consent} onChange={(v) => setF({ ...f, consent: v })} />
        <p className="text-xs text-graphite">{t('subscriptionNote')}</p>
        <Checkbox label={tp('consentRenewals', { business: brandName })} checked={renewals} onChange={setRenewals} error={error?.fields?.renewalConsent} />
        <button type="submit" className="btn btn-primary" disabled={busy || !plan?.price} aria-busy={busy}>{t('subscribe')}</button>
      </div>
    </form>
  );
}

export function MealPlanManage({ initial, token, timeZone }: { initial: SubscriptionX; token: string; timeZone: string }) {
  const t = useTranslations('foodsite');
  const locale = useLocale();
  const [s, setS] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const skip = async (weekStart: string, val: boolean) => {
    const r = await call<{ subscription: SubscriptionX }>('POST', `/public/foods/meal-plans/subscriptions/${s.id}/skip`, { token, weekStart, skip: val });
    if (r.ok) { setS(r.data.subscription); setMsg(val ? t('skipped') : t('unskipped')); } else setMsg(r.error.message);
  };
  const status = async (to: 'paused' | 'active' | 'cancelled') => {
    if (to === 'cancelled' && !window.confirm(t('cancelConfirm'))) return;
    const r = await call<SubscriptionX>('POST', `/public/foods/meal-plans/subscriptions/${s.id}/status`, { token, to });
    if (r.ok) setS(r.data); else setMsg(r.error.message);
  };
  return (
    <div className="space-y-5">
      <section className="card p-6">
        <p className="text-xs font-bold uppercase tracking-wider">{t(`sstatus.${s.status}`)}</p>
        <h1 className="text-2xl font-extrabold">{s.planName}</h1>
        <p className="text-sm text-graphite">{s.locationName} · {t('perWeek', { amount: money(s.price, locale) })}{s.sandbox ? ` · ${t('testMode')}` : ''}</p>
      </section>
      {msg && <p role="status" className="rounded-2xl bg-canvas p-3 text-sm font-semibold">{msg}</p>}
      <section className="card p-5">
        <h2 className="text-lg font-extrabold">{t('upcoming')}</h2>
        <ul className="mt-2 divide-y divide-line-soft">
          {s.upcoming.map((w) => (
            <li key={w.weekStart} className="flex flex-wrap items-center gap-3 py-3">
              <span className="min-w-48 font-bold">{calendarLabel(w.fulfilmentDate, locale, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
              <span className="text-sm">{w.skipped ? <span className="font-bold text-warning">{t('weekSkipped')}</span> : t('weekScheduled')}</span>
              <span className="text-xs text-graphite">{w.canChange ? t('changeBy', { when: dateTime(w.cutoffAt, timeZone, locale) }) : t('weekLocked')}</span>
              {w.canChange && <button type="button" className="btn btn-secondary ms-auto h-10 min-h-10" onClick={() => skip(w.weekStart, !w.skipped)}>{w.skipped ? t('unskip') : t('skipWeek')}</button>}
            </li>
          ))}
        </ul>
      </section>
      {s.status !== 'cancelled' && (
        <SavedCard
          load={() => call<CardOnFile>('POST', `/public/foods/meal-plans/subscriptions/${s.id}/payment-method`, { token })}
          start={(text, loc) => call<SetupStart>('POST', `/public/foods/meal-plans/subscriptions/${s.id}/payment-method/setup`, { token, purposes: ['renewals'], text, locale: loc })}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {s.status === 'active' && <button type="button" className="btn btn-secondary" onClick={() => status('paused')}>{t('pause')}</button>}
        {s.status === 'paused' && <button type="button" className="btn btn-primary" onClick={() => status('active')}>{t('resume')}</button>}
        {s.status !== 'cancelled' && <button type="button" className="btn btn-secondary" onClick={() => status('cancelled')}>{t('cancelSub')}</button>}
      </div>
    </div>
  );
}

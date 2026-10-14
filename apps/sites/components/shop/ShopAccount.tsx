'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { EMAIL_RE, ErrorSummary, Field } from '@/components/forms';
import { dateTime, money } from '@/lib/format';
import type { Money } from '@/lib/types';
import { shop, type PublicOrder } from '@/lib/shop';

type MyOrder = PublicOrder & { brand: { name: string; slug: string }; locationName: string | null; timeZone: string | null };
const KEY = 'bh_shop_token';

/** Customer account: sign in with a BranchHarbor account to see orders (all stores of this brand) and store credit per currency. */
export function ShopAccount({ brand }: { brand: string }) {
  const t = useTranslations('storefront');
  const locale = useLocale();
  const [token, setToken] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<MyOrder[] | null>(null);
  const [credit, setCredit] = useState<{ totals: Money[] } | null>(null);
  useEffect(() => { try { setToken(sessionStorage.getItem(KEY)); } catch { /* storage blocked */ } }, []);
  useEffect(() => {
    if (!token) return;
    void (async () => {
      const [o, c] = await Promise.all([shop<{ items: MyOrder[] }>('GET', '/me/commerce/orders', undefined, { token }), shop<{ totals: Money[] }>('GET', '/me/commerce/credit', undefined, { token })]);
      if (!o.ok && o.status === 401) { sessionStorage.removeItem(KEY); setToken(null); setError(t('sessionEnded')); return; }
      if (o.ok) setOrders(o.data.items.filter((x) => x.brand.slug === brand));
      if (c.ok) setCredit(c.data);
    })();
  }, [token, brand, t]);

  if (!token) {
    return (
      <form className="card mt-6 max-w-md space-y-4 p-6" noValidate onSubmit={async (e) => {
        e.preventDefault();
        if (!EMAIL_RE.test(form.email) || !form.password) { setError(t('signInInvalid')); return; }
        const r = await shop<{ accessToken: string }>('POST', '/auth/login', { email: form.email, password: form.password });
        if (!r.ok) { setError(r.error.message); return; }
        try { sessionStorage.setItem(KEY, r.data.accessToken); } catch { /* storage blocked */ }
        setError(null); setToken(r.data.accessToken);
      }}>
        <p className="text-sm text-graphite">{t('signInHint')}</p>
        <ErrorSummary message={error} />
        <Field label={t('email')} type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <Field label={t('password')} type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <button type="submit" className="btn btn-primary">{t('signIn')}</button>
        <p className="text-xs text-graphite">{t('guestNote')}</p>
      </form>
    );
  }
  return (
    <div className="mt-6 space-y-6">
      <div className="flex justify-end"><button type="button" className="text-sm underline" onClick={() => { sessionStorage.removeItem(KEY); setToken(null); setOrders(null); }}>{t('signOut')}</button></div>
      <section className="card p-5">
        <h2 className="text-lg font-bold">{t('storeCredit')}</h2>
        {credit && credit.totals.length ? <ul className="mt-1 flex flex-wrap gap-4">{credit.totals.map((m) => <li key={m.currency} className="text-lg font-bold tabular">{money(m, locale)}</li>)}</ul> : <p className="text-sm text-graphite">{t('noCredit')}</p>}
        <p className="mt-1 text-xs text-graphite">{t('creditPerCurrency')}</p>
      </section>
      <section className="card p-5">
        <h2 className="text-lg font-bold">{t('myOrders')}</h2>
        {!orders ? <p className="text-sm text-graphite">…</p> : !orders.length ? <p className="text-sm text-graphite">{t('noOrders')}</p> : (
          <ul className="mt-2 divide-y divide-line-soft text-sm">
            {orders.map((o) => <li key={o.id} className="flex flex-wrap justify-between gap-2 py-2"><span><strong>{o.number}</strong> · {o.locationName} · {dateTime(o.createdAt, o.timeZone ?? 'UTC', locale)}</span><span>{money(o.total, locale)} · {t(`fstate.${o.fulfilmentStatus}`)}</span></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}

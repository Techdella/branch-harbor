'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { ErrorSummary, PayButton } from '@/components/forms';
import { dateTime, money } from '@/lib/format';
import { shop, type PublicOrder } from '@/lib/shop';

const STEPS = ['placed', 'paid', 'preparing', 'ready', 'done'] as const;

function step(o: PublicOrder): number {
  if (o.paymentStatus !== 'paid' && o.paymentStatus !== 'partially_refunded' && o.paymentStatus !== 'refunded' && o.paymentStatus !== 'not_required') return 0;
  if (o.fulfilmentStatus === 'fulfilled') return 4;
  if (['ready_for_pickup', 'out_for_delivery'].includes(o.fulfilmentStatus) || o.fulfilments.some((f) => f.status === 'shipped')) return 3;
  if (['picking', 'packed', 'awaiting_transfer', 'partially_fulfilled', 'backordered'].includes(o.fulfilmentStatus)) return 2;
  return 1;
}

/** Live order status: polls while open; pay (if pending), cancel unpaid, request a return within the window. */
export function OrderTracker({ initial, token }: { initial: PublicOrder; token: string }) {
  const t = useTranslations('storefront');
  const locale = useLocale();
  const [o, setO] = useState(initial);
  const [ret, setRet] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tz = o.store.timeZone;
  const refresh = async () => { const r = await shop<PublicOrder>('GET', `/public/commerce/orders/${o.id}?token=${encodeURIComponent(token)}`); if (r.ok) setO(r.data); };
  useEffect(() => {
    if (['fulfilled', 'cancelled'].includes(o.fulfilmentStatus)) return;
    const h = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.fulfilmentStatus]);
  const s = step(o);
  const closed = o.status === 'expired' || o.status === 'cancelled';

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm text-graphite">{o.brand.name} · {o.locationName}</p>
        <h1 className="text-3xl font-extrabold tracking-tight">{t('orderNumber', { number: o.number })}</h1>
        <p className="mt-1 text-graphite">{t('placedOn', { when: dateTime(o.createdAt, tz, locale) })}</p>
      </header>
      <div role="status" aria-live="polite" className={`card p-5 ${closed ? 'bg-canvas' : ''}`}>
        <p className="flex items-center gap-2 text-lg font-bold"><Icon name={closed ? 'x' : s >= 4 ? 'check-circle' : s >= 1 ? 'clock' : 'card'} size={20} />{closed ? t(`state.${o.status}`) : o.fulfilmentStatus === 'stock_conflict' ? t('state.stock_conflict') : t(`state.step${s}`, { method: t(`method.${o.fulfilmentMethod}`) })}</p>
        {o.fulfilmentStatus === 'awaiting_transfer' && <p className="mt-1 text-sm">{t('state.transfer', { store: o.fulfilmentLocationName ?? '' })}</p>}
        {o.fulfilmentStatus === 'backordered' && <p className="mt-1 text-sm">{t('state.backordered')}</p>}
        {!closed && (
          <ol className="mt-4 grid grid-cols-5 gap-1 text-center text-xs font-semibold" aria-label={t('progress')}>
            {STEPS.map((k, i) => <li key={k} aria-current={i === s ? 'step' : undefined} className={`rounded-full px-1 py-1.5 ${i <= s ? 'bg-ink text-white' : 'bg-canvas text-graphite'}`}>{t(`steps.${k}`)}</li>)}
          </ol>
        )}
      </div>
      {o.status === 'pending_payment' && o.payment && (
        <section className="card space-y-3 p-5">
          <h2 className="text-lg font-bold">{t('completePayment')}</h2>
          {o.reservationExpiresAt && <p className="text-sm">{t('heldUntilTime', { time: dateTime(o.reservationExpiresAt, tz, locale) })}</p>}
          <PayButton payment={{ id: o.payment.id, sandbox: o.payment.sandbox }} label={t('payCta', { amount: money(o.amountDue, locale) })} onDone={async (r) => { if (!r.ok) setError(r.message ?? t('paymentFailed')); await refresh(); }} />
          {o.cancellable && <button type="button" className="text-sm underline" onClick={async () => { const r = await shop<PublicOrder>('POST', `/public/commerce/orders/${o.id}/cancel?token=${encodeURIComponent(token)}`, {}); if (r.ok) setO(r.data); else setError(r.error.message); }}>{t('cancelOrder')}</button>}
        </section>
      )}
      <ErrorSummary message={error} />
      {notice && <p role="status" className="rounded-2xl bg-success-bg p-4 text-sm text-success">{notice}</p>}
      <section className="card p-5">
        <h2 className="text-lg font-bold">{t('items')}</h2>
        <ul className="mt-2 divide-y divide-line-soft text-sm">{o.lines.map((l) => <li key={l.variantId} className="flex justify-between gap-3 py-2"><span>{l.quantity} × {l.name}{(l.backordered ?? 0) > 0 && <span className="ms-1 text-warning">({t('backorderedN', { n: l.backordered ?? 0 })})</span>}</span><span className="tabular">{money(l.lineTotal, locale)}</span></li>)}</ul>
        <dl className="mt-2 space-y-1 border-t border-line-soft pt-2 text-sm">
          <div className="flex justify-between"><dt>{t('subtotal')}</dt><dd className="tabular">{money(o.subtotal, locale)}</dd></div>
          {o.fulfilmentFee.amount > 0 && <div className="flex justify-between"><dt>{t(`method.${o.fulfilmentMethod}`)}</dt><dd className="tabular">{money(o.fulfilmentFee, locale)}</dd></div>}
          {o.taxLines.map((x) => <div key={x.name} className="flex justify-between"><dt>{x.inclusive ? t('taxIncluded', { name: x.name, rate: x.rateBps / 100 }) : t('tax', { name: x.name, rate: x.rateBps / 100 })}</dt><dd className="tabular">{money(x.amount, locale)}</dd></div>)}
          <div className="flex justify-between font-extrabold"><dt>{t('total')}</dt><dd className="tabular">{money(o.total, locale)}</dd></div>
          {o.creditApplied.amount > 0 && <div className="flex justify-between"><dt>{t('creditUsed')}</dt><dd className="tabular">−{money(o.creditApplied, locale)}</dd></div>}
          {o.refunded.amount > 0 && <div className="flex justify-between"><dt>{t('refunded')}</dt><dd className="tabular">{money(o.refunded, locale)}</dd></div>}
        </dl>
      </section>
      <section className="card p-5 text-sm">
        <h2 className="text-lg font-bold">{o.fulfilmentMethod === 'pickup' ? t('pickupAt', { store: o.store.name }) : t(`method.${o.fulfilmentMethod}`)}</h2>
        {o.fulfilmentMethod === 'pickup' && <p className="mt-1">{o.store.address.line1}, {o.store.address.city}{o.store.pickupInstructions ? ` · ${o.store.pickupInstructions}` : ''}</p>}
        {o.fulfilments.filter((f) => f.trackingNumber).map((f) => <p key={f.id} className="mt-1">{t('tracking', { carrier: f.carrier ?? '', number: f.trackingNumber ?? '' })}</p>)}
      </section>
      {(o.returns.length > 0 || o.returnable.length > 0) && (
        <section className="card space-y-3 p-5 text-sm">
          <h2 className="text-lg font-bold">{t('returns')}</h2>
          {o.returns.map((r) => <p key={r.id}><strong>{r.rmaNumber}</strong> · {t(`returnState.${r.status}`)}{r.resolution ? ` · ${t(`resolution.${r.resolution}`)}` : ''}</p>)}
          {o.returnPolicy.open && o.returnable.length > 0 && (
            <form className="space-y-2" onSubmit={async (e) => {
              e.preventDefault();
              const lines = Object.entries(ret).filter(([, n]) => n > 0).map(([variantId, quantity]) => ({ variantId, quantity }));
              if (!lines.length) { setError(t('chooseReturn')); return; }
              const r = await shop('POST', `/public/commerce/orders/${o.id}/returns?token=${encodeURIComponent(token)}`, { lines, reason: reason || undefined });
              if (!r.ok) { setError(r.error.message); return; }
              setError(null); setRet({}); setReason(''); setNotice(t('returnRequested')); await refresh();
            }}>
              <p className="text-graphite">{t('returnWindow', { date: dateTime(o.returnPolicy.endsAt, tz, locale) })}</p>
              {o.returnable.map((l) => (
                <label key={l.variantId} className="flex items-center justify-between gap-2"><span>{l.name}</span>
                  <select className="field w-20" value={ret[l.variantId] ?? 0} onChange={(e) => setRet({ ...ret, [l.variantId]: Number(e.target.value) })} aria-label={t('returnQty', { name: l.name })}>{Array.from({ length: l.max + 1 }, (_, i) => <option key={i}>{i}</option>)}</select>
                </label>
              ))}
              <label className="block"><span className="mb-1 block font-semibold">{t('returnReason')}</span><input className="field" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
              <button type="submit" className="btn btn-secondary">{t('requestReturn')}</button>
            </form>
          )}
          {!o.returnPolicy.open && o.paymentStatus === 'paid' && <p className="text-graphite">{t('returnClosed')}</p>}
        </section>
      )}
    </div>
  );
}

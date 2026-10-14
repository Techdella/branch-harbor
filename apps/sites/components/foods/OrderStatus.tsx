'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { dateLong, money, time, zone } from '@/lib/format';
import type { FoodOrder } from '@/lib/foods';

const FLOW = ['awaiting_acceptance', 'accepted', 'preparing', 'ready', 'collected'] as const;
const FINAL = new Set(['collected', 'rejected', 'cancelled']);

/**
 * Live order status. "Awaiting acceptance" is visibly different from "accepted". Polls every 5s; on a lost
 * connection it says so and shows when the status was last confirmed, instead of presenting stale data as current.
 */
export function OrderStatus({ initial, token, locationName, timeZone }: { initial: FoodOrder; token: string; locationName: string; timeZone: string }) {
  const t = useTranslations('order');
  const locale = useLocale();
  const [order, setOrder] = useState(initial);
  const [checkedAt, setCheckedAt] = useState(() => new Date());
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (FINAL.has(order.status)) return;
    const id = setInterval(async () => {
      const r = await call<FoodOrder>('GET', `/public/foods/orders/${order.id}?token=${encodeURIComponent(token)}`);
      if (r.ok) { setOrder(r.data); setCheckedAt(new Date()); setLost(false); } else setLost(true);
    }, 5000);
    return () => clearInterval(id);
  }, [order.id, order.status, token]);

  const awaiting = order.status === 'awaiting_acceptance';
  const bad = order.status === 'rejected' || order.status === 'cancelled';
  const idx = FLOW.indexOf(order.status as (typeof FLOW)[number]);
  const clockLabel = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(checkedAt);

  return (
    <div>
      <p className="text-sm font-semibold text-graphite">{t('statusTitle', { number: order.orderNumber })}</p>
      <section role="status" aria-live="polite" className={`mt-3 rounded-3xl p-6 ${awaiting ? 'border-2 border-dashed border-warning bg-warning-bg' : bad ? 'bg-danger-bg' : 'bg-success-bg'}`}>
        <div className="flex items-center gap-3">
          <span className={`grid size-12 shrink-0 place-items-center rounded-full bg-white ${awaiting ? 'text-warning' : bad ? 'text-danger' : 'text-success'}`} aria-hidden>
            <Icon name={awaiting ? 'clock' : bad ? 'x' : 'check'} size={24} stroke={2.4} />
          </span>
          <div>
            <p className="text-xs font-bold uppercase tracking-wider">{t(`status.${order.status}` as 'status.accepted')}</p>
            <h1 className="text-2xl font-extrabold tracking-tight">
              {awaiting ? t('awaitingTitle', { location: locationName }) : t(`statusBody.${order.status}` as 'statusBody.accepted', { location: locationName })}
            </h1>
          </div>
        </div>
        {awaiting && <p className="mt-3">{t('awaitingBody')}</p>}
        {order.status === 'rejected' && order.rejectionReason && <p className="mt-3">{t('reason', { reason: order.rejectionReason })}</p>}
        <p className="mt-3 text-sm font-semibold">{t(`paymentStatus.${order.paymentStatus}` as 'paymentStatus.paid')}</p>
      </section>

      {!bad && (
        <ol className="mt-5 grid grid-cols-5 gap-1 text-center text-xs font-semibold">
          {FLOW.map((s, i) => (
            <li key={s} aria-current={i === idx ? 'step' : undefined} className={`rounded-lg px-1 py-2 ${i < idx ? 'bg-success-bg text-success' : i === idx ? 'bg-ink text-white' : 'bg-canvas text-graphite'}`}>
              {t(`status.${s}`)}
            </li>
          ))}
        </ol>
      )}

      <p className={`mt-3 text-xs ${lost ? 'font-bold text-danger' : 'text-graphite'}`}>
        {lost ? t('connectionLost', { time: clockLabel }) : t('lastUpdated', { time: clockLabel })}
      </p>

      <section className="card mt-5 p-5">
        {order.promisedAt && (
          <p className="font-semibold">
            {t('pickupAt', { when: `${dateLong(order.promisedAt, timeZone, locale)} ${time(order.promisedAt, timeZone, locale)} ${zone(timeZone, locale, order.promisedAt)}` })} · {locationName}
          </p>
        )}
        <h2 className="mt-3 text-sm font-bold uppercase tracking-wider text-graphite">{t('items')}</h2>
        <ul className="mt-1 space-y-1 text-sm">
          {order.lines.map((l, i) => (
            <li key={i} className="flex justify-between gap-2">
              <span>{l.quantity} × {l.name}{l.modifiers.length ? ` (${l.modifiers.map((m) => m.name).join(', ')})` : ''}</span>
              <span className="tabular">{money({ amount: l.lineTotalMinor, currency: order.total.currency }, locale)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1 border-t border-line-soft pt-2 text-sm">
          <div className="flex justify-between"><dt>{t('subtotal')}</dt><dd className="tabular">{money(order.subtotal, locale)}</dd></div>
          {order.tax.amount > 0 && <div className="flex justify-between"><dt>{t('taxPlain')}</dt><dd className="tabular">{money(order.tax, locale)}</dd></div>}
          <div className="flex justify-between font-extrabold"><dt>{t('total')}</dt><dd className="tabular">{money(order.total, locale)}</dd></div>
        </dl>
      </section>
    </div>
  );
}

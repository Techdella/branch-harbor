'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Badge, Button, Drawer, Icon, Input, Select, Tabs, cx } from '@bh/ui';
import { cx as call, useAction, useCommerce } from '@/lib/commerce/client';
import type { Fulfilment, SalesOrder } from '@/lib/commerce/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, SectionCard } from '../../ui/States';
import { ActionError, History, Money, MoneyInput, NumberInput, StatusBadge, View, When, useCt } from './kit';

type Filter = 'action' | 'payment' | 'ready' | 'backordered' | 'attention' | 'all';
const FILTERS: Record<Filter, (o: SalesOrder) => boolean> = {
  action: (o) => ['paid', 'external', 'not_required', 'partially_refunded'].includes(o.paymentStatus) && ['unfulfilled', 'picking', 'packed', 'partially_fulfilled', 'awaiting_transfer'].includes(o.fulfilmentStatus),
  payment: (o) => o.status === 'pending_payment',
  ready: (o) => o.fulfilmentStatus === 'ready_for_pickup',
  backordered: (o) => o.fulfilmentStatus === 'backordered',
  attention: (o) => !!o.attention,
  all: () => true,
};

/** Orders & fulfilment: payment and fulfilment states, picking/packing, partial fulfilment, backorders, recovery, refunds. */
export function OrderDeskScreen() {
  const t = useCt();
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const [filter, setFilter] = useState<Filter>('action');
  const [q, setQ] = useState('');
  const res = useCommerce(() => call<{ items: SalesOrder[] }>('GET', '/sales-orders'), [app.org.id, app.apiMode]);
  const ids = app.scope.locationIds;
  const scoped = (res.data?.items ?? []).filter((o) => !ids.length || ids.includes(o.locationId) || ids.includes(o.fulfilmentLocationId));
  const rows = scoped.filter(FILTERS[filter]).filter((o) => !q || `${o.number} ${o.customer.name ?? ''} ${o.customer.email ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const openId = params.get('open');
  const setOpen = (id: string | null) => router.replace(id ? `?open=${id}` : '?', { scroll: false });

  return (
    <>
      <PageHeader icon="receipt" title={t('orders.title')} description={t('orders.description')} />
      <SectionCard>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Tabs value={filter} onChange={setFilter} items={(Object.keys(FILTERS) as Filter[]).map((k) => ({ key: k, label: t(`orders.filter.${k}`), count: scoped.filter(FILTERS[k]).length }))} />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('orders.search')} aria-label={t('orders.search')} className="h-10 max-w-xs" />
        </div>
        <View res={res} isEmpty={() => !rows.length} empty={<Empty icon="receipt" title={t('orders.empty')} />}>
          {() => (
            <ul className="flex flex-col gap-1">
              {rows.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => setOpen(o.id)} className={cx('grid w-full grid-cols-2 items-center gap-2 rounded-md px-3.5 py-3 text-left text-sm hover:outline hover:outline-1 hover:outline-ink xl:grid-cols-[110px_minmax(160px,1.4fr)_120px_150px_170px_24px]', openId === o.id ? 'bg-canvas' : 'bg-canvas-raised')}>
                    <span className="font-extrabold">{o.number}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{o.lines.map((l) => (l.quantity > 1 ? `${l.name} ×${l.quantity}` : l.name)).join(', ')}</span>
                      <span className="block truncate text-xs text-stone">{o.customer.name ?? '—'} · {o.locationName}{o.crossLocation ? ` → ${o.fulfilmentLocationName}` : ''} · {t(`orders.method.${o.fulfilmentMethod}`)}</span>
                    </span>
                    <Money m={o.total} className="font-bold" />
                    <span className="flex flex-wrap gap-1"><StatusBadge kind="payment" value={o.paymentStatus} />{o.source !== 'native' && <Badge tone="neutral" icon="plug">{o.source}</Badge>}</span>
                    <StatusBadge kind="fulfilment" value={o.fulfilmentStatus} className="justify-self-start" />
                    <Icon name="chevron-right" size={16} className="hidden xl:block" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </View>
      </SectionCard>
      {openId && <OrderDrawer id={openId} onClose={() => setOpen(null)} onChanged={() => res.reload()} />}
    </>
  );
}

function OrderDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useCt();
  const app = useApp();
  const res = useCommerce(() => call<SalesOrder>('GET', `/sales-orders/${id}`), [id]);
  const act = useAction(async (method: 'POST', path: string, body?: unknown) => { const r = await call<{ order?: SalesOrder } & Partial<SalesOrder>>(method, path, body); onChanged(); res.reload(); return r; });
  const [refund, setRefund] = useState<number | null>(null);
  const [recoverFrom, setRecoverFrom] = useState('');
  const canWrite = app.can('operations.write');
  const manager = canWrite && app.can('locations.read');

  return (
    <Drawer open onClose={onClose} kicker={t('orders.order')} title={res.data ? `${res.data.number} · ${res.data.customer.name ?? ''}` : t('orders.order')} footer={<a href={`?open=${id}`} className="inline-flex items-center gap-1.5 text-[13px] font-bold underline"><Icon name="link" size={14} />{t('orders.share')}</a>}>
      <View res={res}>
        {(o) => (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-wrap gap-1.5">
              <StatusBadge kind="payment" value={o.paymentStatus} />
              <StatusBadge kind="fulfilment" value={o.fulfilmentStatus} />
              <Badge tone="neutral">{t(`orders.method.${o.fulfilmentMethod}`)}</Badge>
              <Badge tone="neutral">{o.locationName}{o.crossLocation ? ` → ${o.fulfilmentLocationName}` : ''}</Badge>
            </div>
            <Banner tone="neutral" icon="info">{o.authoritativeSystem === 'branchharbor' ? t('orders.authBh') : t('orders.authExternal', { provider: o.authoritativeSystem })}</Banner>
            {o.reservationExpiresAt && o.status === 'pending_payment' && <Banner tone="warning" icon="clock">{t('orders.reserved')} <When iso={o.reservationExpiresAt} tz={o.timeZone} /></Banner>}
            {o.attention && (
              <Banner tone="danger" title={t(`orders.attention.${o.attention}`)}>
                {t('orders.recoveryHelp')}
                {manager && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => act.run('POST', `/sales-orders/${o.id}/recover`, { kind: 'retry_allocation' })}>{t('orders.retryAllocation')}</Button>
                    <Button size="sm" variant="secondary" onClick={() => act.run('POST', `/sales-orders/${o.id}/recover`, { kind: 'backorder' })}>{t('orders.acceptBackorder')}</Button>
                    <Select value={recoverFrom} onChange={(e) => setRecoverFrom(e.target.value)} className="h-9 w-48" aria-label={t('orders.transferFrom')}>
                      <option value="">{t('orders.transferFrom')}</option>
                      {app.locations.filter((l) => l.id !== o.locationId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </Select>
                    <Button size="sm" variant="secondary" disabled={!recoverFrom} onClick={() => act.run('POST', `/sales-orders/${o.id}/recover`, { kind: 'transfer_from', fromLocationId: recoverFrom })}>{t('orders.transfer')}</Button>
                  </div>
                )}
              </Banner>
            )}
            <ul className="flex flex-col gap-1.5">
              {o.lines.map((l) => (
                <li key={l.variantId + l.sku} className="flex items-center gap-2.5 rounded-[14px] bg-canvas-raised px-3 py-2.5 text-[13px]">
                  <span className="flex-1">{l.name} ×{l.quantity}{(l.backordered ?? 0) > 0 && <span className="ms-2 text-xs font-bold text-warning">{t('orders.lineBackordered', { n: l.backordered ?? 0 })}</span>}{l.unmapped && <span className="ms-2 text-xs font-bold text-warning">{t('orders.unmapped')}</span>}</span>
                  <Money m={l.lineTotal} className="font-bold" />
                </li>
              ))}
            </ul>
            <dl className="grid grid-cols-[1fr_auto] gap-1 px-1 text-[13px]">
              <dt className="text-stone">{t('orders.subtotal')}</dt><dd className="text-right"><Money m={o.subtotal} /></dd>
              {o.fulfilmentFee.amount > 0 && <><dt className="text-stone">{t(`orders.fee.${o.fulfilmentMethod}`)}</dt><dd className="text-right"><Money m={o.fulfilmentFee} /></dd></>}
              {o.taxLines.map((tx) => <div key={tx.name} className="contents"><dt className="text-stone">{tx.inclusive ? t('orders.taxIncl', { name: tx.name, rate: tx.rateBps / 100 }) : t('orders.tax', { name: tx.name, rate: tx.rateBps / 100 })}</dt><dd className="text-right"><Money m={tx.amount} /></dd></div>)}
              {!o.taxLines.length && <><dt className="text-stone">{t('orders.taxNone')}</dt><dd /></>}
              <dt className="font-bold">{t('orders.total')}</dt><dd className="text-right font-bold"><Money m={o.total} /></dd>
              {o.creditApplied.amount > 0 && <><dt className="text-stone">{t('orders.credit')}</dt><dd className="text-right">−<Money m={o.creditApplied} /></dd></>}
              {o.refunded.amount > 0 && <><dt className="text-stone">{t('orders.refunded')}</dt><dd className="text-right"><Money m={o.refunded} /></dd></>}
            </dl>
            {o.transfer && <Banner tone="info" icon="truck">{t('orders.transferLinked', { number: o.transfer.number })} <StatusBadge kind="transfer" value={o.transfer.status} /></Banner>}

            <div>
              <h3 className="mb-1.5 text-[13px] font-bold">{t('orders.fulfilment')}</h3>
              {o.fulfilments.map((f) => <FulfilmentCard key={f.id} f={f} canWrite={canWrite} onAct={(path, body) => act.run('POST', path, body)} />)}
              {canWrite && o.authoritativeSystem === 'branchharbor' && ['unfulfilled', 'partially_fulfilled', 'backordered'].includes(o.fulfilmentStatus) && ['paid', 'not_required', 'partially_refunded'].includes(o.paymentStatus) && (
                <Button size="sm" icon="box" onClick={() => act.run('POST', `/sales-orders/${o.id}/fulfilments`, {})}>{t('orders.startPicking')}</Button>
              )}
              {canWrite && o.lines.some((l) => (l.backordered ?? 0) > 0) && <Button size="sm" variant="secondary" className="ms-2" onClick={() => act.run('POST', `/sales-orders/${o.id}/allocate-backorders`)}>{t('orders.allocateBackorders')}</Button>}
            </div>
            <ActionError error={act.error} />

            {app.can('payments.refund') && o.paymentStatus !== 'pending' && o.refunded.amount < o.total.amount && o.status !== 'pending_payment' && (
              <div className="rounded-lg bg-canvas-raised p-3">
                <div className="mb-1 font-bold">{t('orders.partialRefund')}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <MoneyInput minor={refund} currency={o.currency} label={t('orders.refundAmount')} onChange={setRefund} />
                  <Button size="sm" variant="danger" disabled={!refund || refund > o.total.amount - o.refunded.amount} onClick={async () => { if (await act.run('POST', `/orders/${o.id}/refunds`, { amountMinor: refund, reason: 'Staff refund' })) setRefund(null); }}>{t('orders.refund')}</Button>
                </div>
                <p className="mt-1 text-xs text-stone">{o.authoritativeSystem === 'branchharbor' ? t('orders.refundNote') : t('orders.refundExternal', { provider: o.authoritativeSystem })}</p>
              </div>
            )}
            {o.status === 'pending_payment' && canWrite && <Button variant="secondary" icon="x" onClick={() => act.run('POST', `/sales-orders/${o.id}/cancel`, {})}>{t('orders.cancelUnpaid')}</Button>}
            {(o.returns ?? []).length > 0 && <div><h3 className="mb-1 text-[13px] font-bold">{t('orders.returns')}</h3>{o.returns!.map((r) => <div key={r.id} className="flex gap-2"><span>{r.rmaNumber}</span><StatusBadge kind="return" value={r.status} /></div>)}</div>}
            <div><h3 className="mb-1.5 text-[13px] font-bold">{t('orders.timeline')}</h3><History items={o.history} tz={o.timeZone} /></div>
          </div>
        )}
      </View>
    </Drawer>
  );
}

function FulfilmentCard({ f, canWrite, onAct }: { f: Fulfilment; canWrite: boolean; onAct: (path: string, body?: unknown) => void }) {
  const t = useCt();
  const [picked, setPicked] = useState<Record<string, number>>(Object.fromEntries(f.lines.map((l) => [l.variantId, l.picked])));
  const [tracking, setTracking] = useState('');
  return (
    <div className="mb-2 rounded-lg border border-line-soft p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2"><StatusBadge kind="fulfilment" value={f.status === 'ready' ? 'ready_for_pickup' : ['shipped', 'collected', 'delivered'].includes(f.status) ? 'fulfilled' : f.status} /><span className="text-xs text-stone">{t(`orders.fstatus.${f.status}`)}</span>{f.trackingNumber && <span className="text-xs">{f.carrier} · {f.trackingNumber}</span>}</div>
      <ul className="flex flex-col gap-1">
        {f.lines.map((l) => (
          <li key={l.variantId} className="flex items-center gap-2 text-[13px]">
            <span className="flex-1">{l.name}</span>
            {f.status === 'picking' && canWrite ? <><NumberInput value={picked[l.variantId] ?? 0} onChange={(n) => setPicked((p) => ({ ...p, [l.variantId]: n }))} label={t('orders.picked', { name: l.name })} /><span className="text-xs text-stone">/ {l.quantity}</span></> : <span>{l.picked}/{l.quantity}</span>}
          </li>
        ))}
      </ul>
      {canWrite && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {f.status === 'picking' && <Button size="sm" variant="secondary" icon="check" onClick={() => onAct(`/fulfilments/${f.id}/pick`, { lines: f.lines.map((l) => ({ variantId: l.variantId, picked: Math.min(l.quantity, picked[l.variantId] ?? 0) })) })}>{t('orders.savePicks')}</Button>}
          {f.next.includes('shipped') && <Input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder={t('orders.tracking')} aria-label={t('orders.tracking')} className="h-9 w-40" />}
          {f.next.map((n) => <Button key={n} size="sm" onClick={() => onAct(`/fulfilments/${f.id}/status`, { to: n, ...(n === 'shipped' ? { trackingNumber: tracking, carrier: 'Carrier' } : {}) })}>{t(`orders.to.${n}`)}</Button>)}
        </div>
      )}
    </div>
  );
}

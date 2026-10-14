'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Icon, Tag, cx, type Tone } from '@bh/ui';
import type { CommerceOrder } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { fmtDateTime, fmtTime, moneyWithCode, relativeTime } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock } from '../../ui/States';
import { Timeline } from '../Timeline';

const payTone: Record<CommerceOrder['payment'], Tone> = { succeeded: 'success', failed: 'danger', processing: 'info', not_imported: 'warning' };
const fulTone: Record<CommerceOrder['fulfilment'], Tone> = { to_fulfil: 'info', fulfilled: 'success', on_hold: 'neutral', store_disconnected: 'warning' };
const refTone: Record<CommerceOrder['refund'], Tone> = { none: 'neutral', pending: 'warning', partial: 'info', complete: 'info', failed: 'danger' };

export function CommerceOrdersScreen() {
  const t = useTranslations('corders');
  const tOps = useTranslations('ops.commerce.orders');
  const locale = useLocale();
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const res = useApi((api) => api.commerce.orders(app.ctx), [app.role, app.scopeId]);
  const openId = params.get('open');
  const setOpen = (id: string | null) => router.replace(id ? `?open=${id}` : '?', { scroll: false });
  const locName = (id: string) => app.locations.find((l) => l.id === id)?.name ?? id;
  const open = res.status === 'ready' ? res.data.find((o) => o.id === openId) : undefined;

  return (
    <>
      <PageHeader icon="receipt" title={tOps('title')} description={tOps('description')} />
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.length === 0} empty={<Empty icon="receipt" title={t('empty')} />}>
        {(orders) => (
          <section className="rounded-xl bg-surface p-2.5">
            <ul className="flex flex-col gap-1">
              {orders.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => setOpen(o.id)} className={cx('grid w-full grid-cols-2 items-center gap-2 rounded-md px-3.5 py-3 text-left text-sm hover:outline hover:outline-1 hover:outline-ink md:grid-cols-[minmax(90px,.6fr)_minmax(160px,1.4fr)_minmax(110px,.8fr)_minmax(120px,.8fr)_minmax(130px,.9fr)_24px]', openId === o.id ? 'bg-canvas' : 'bg-[#FAFAF7]')}>
                    <span className="font-extrabold">#{o.number}</span>
                    <span className="min-w-0 md:order-none">
                      <span className="block truncate font-semibold">{o.lines.map((l) => (l.qty > 1 ? `${l.name} ×${l.qty}` : l.name)).join(', ')}</span>
                      <span className="block truncate text-xs text-stone">
                        {o.customer} · {locName(o.locationId)}
                      </span>
                    </span>
                    <span className="tabular font-bold">{o.payment === 'not_imported' ? '—' : moneyWithCode(o.total, locale)}</span>
                    <span>
                      <Badge tone={payTone[o.payment]}>{t(`payment.${o.payment}`)}</Badge>
                      {o.refund !== 'none' && <Badge tone={refTone[o.refund]} className="ml-1">{t(`refund.${o.refund}`)}</Badge>}
                    </span>
                    <Badge tone={fulTone[o.fulfilment]} className="justify-self-start">{t(`fulfilment.${o.fulfilment}`)}</Badge>
                    <Icon name="chevron-right" size={16} className="hidden md:block" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </Async>
      {open && <OrderDrawer o={open} locName={locName(open.locationId)} onClose={() => setOpen(null)} onUpdate={(u) => res.status === 'ready' && res.setData(res.data.map((x) => (x.id === u.id ? u : x)))} />}
    </>
  );
}

function OrderDrawer({ o, locName, onClose, onUpdate }: { o: CommerceOrder; locName: string; onClose: () => void; onUpdate: (o: CommerceOrder) => void }) {
  const t = useTranslations('corders');
  const locale = useLocale();
  const app = useApp();
  const [picking, setPicking] = useState(false);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const refund = useMutation((api, ids: string[]) => api.commerce.refund(o.id, ids));
  const tz = app.locations.find((l) => l.id === o.locationId)?.timeZone ?? 'UTC';
  const selected = o.lines.filter((l) => sel[l.id] && !l.refunded);
  const amt = { amount: selected.reduce((s, l) => s + l.unit.amount * l.qty, 0), currency: o.total.currency };
  const canRefund = o.payment === 'succeeded' && app.can('operations.write') && app.role !== 'staff' && o.lines.some((l) => !l.refunded);

  return (
    <Drawer
      open
      onClose={onClose}
      kicker={t('order')}
      title={`#${o.number} · ${o.customer}`}
      footer={
        <a href={`?open=${o.id}`} className="inline-flex items-center gap-1.5 text-[13px] font-bold underline">
          <Icon name="link" size={14} />
          {t('shareLink')}
        </a>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div className="flex flex-wrap gap-1.5">
          <Tag>{t('source', { source: o.source })}</Tag>
          <Tag>{locName}</Tag>
          <Tag>{fmtDateTime(o.placedAt, tz, locale)}</Tag>
          <Badge tone={refTone[refund.pending ? 'pending' : o.refund]}>{t(`refund.${refund.pending ? 'pending' : o.refund}`)}</Badge>
        </div>
        <Banner tone="neutral" icon="info">
          {t('authoritative')}
        </Banner>
        <ul className="flex flex-col gap-1.5">
          {o.lines.map((l) => (
            <li key={l.id}>
              <label className="flex items-center gap-2.5 rounded-[14px] bg-canvas-raised px-3 py-2.5 text-[13px]">
                {picking && !l.refunded && <input type="checkbox" checked={!!sel[l.id]} onChange={(e) => setSel((s) => ({ ...s, [l.id]: e.target.checked }))} className="h-[18px] w-[18px] accent-ink" />}
                <span className="flex-1">
                  {l.name} {l.qty > 1 && `×${l.qty}`}
                  {l.refunded && <span className="ml-2 text-xs font-bold text-info">{t('lineRefunded')}</span>}
                </span>
                <strong className="tabular">{moneyWithCode({ amount: l.unit.amount * l.qty, currency: l.unit.currency }, locale)}</strong>
              </label>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-[1fr_auto] gap-1 px-1 text-[13px]">
          <dt className="text-stone">{o.tax.label}</dt>
          <dd className="tabular text-right">{o.tax.amount ? moneyWithCode(o.tax.amount, locale) : '—'}</dd>
          <dt className="font-bold">{t('total')}</dt>
          <dd className="tabular text-right font-bold">{moneyWithCode(o.total, locale)}</dd>
        </dl>
        <div>
          <h3 className="mb-1.5 text-[13px] font-bold">{t('syncTimeline')}</h3>
          <Timeline events={o.timeline} tz={tz} />
        </div>
        {canRefund && !picking && !refund.pending && (
          <Button variant="secondary" icon="undo" onClick={() => setPicking(true)}>
            {t('partialRefund')}
          </Button>
        )}
        {!canRefund && o.payment === 'succeeded' && app.role === 'staff' && <Banner tone="neutral" icon="lock">{t('noRefundPermission')}</Banner>}
        {picking && (
          <div className="rounded-lg bg-danger-bg p-3.5 text-[13px] leading-normal text-[#5C1414]">
            <strong>{t('refundConfirm', { amount: moneyWithCode(amt, locale) })}</strong>
            <div>{t('refundTo', { location: locName })}</div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="danger"
                disabled={selected.length === 0}
                loading={refund.pending}
                onClick={async () => {
                  const r = await refund.run(selected.map((l) => l.id));
                  if (r) {
                    onUpdate(r);
                    setPicking(false);
                    setSel({});
                  }
                }}
              >
                {t('refundButton', { amount: moneyWithCode(amt, locale) })}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setPicking(false)}>
                {t('cancel')}
              </Button>
            </div>
            {selected.length === 0 && <p className="mt-2 text-xs">{t('selectLines')}</p>}
          </div>
        )}
        {refund.pending && <Banner tone="info" icon="refresh" live="polite">{t('refundPending')}</Banner>}
        {refund.error && <Banner tone="danger" live="assertive">{refund.error.message}</Banner>}
        {o.refund === 'partial' && !refund.pending && <Banner tone="success" live="polite">{t('refundRecorded')}</Banner>}
        <p className="text-xs text-stone">{t('lastUpdated', { time: relativeTime(o.timeline[o.timeline.length - 1]!.at, locale), local: fmtTime(o.timeline[o.timeline.length - 1]!.at, tz, locale) })}</p>
      </div>
    </Drawer>
  );
}

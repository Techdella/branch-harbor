'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Icon, Toggle, cx } from '@bh/ui';
import type { FoodOrder } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { fmtTime, relativeTime } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock } from '../../ui/States';
import { useOrderActions } from './FoodOrdersScreen';

export function KitchenScreen() {
  const t = useTranslations('kitchen');
  const tOps = useTranslations('ops.foods.kitchen');
  const tf = useTranslations('forders');
  const locale = useLocale();
  const app = useApp();
  const locs = app.locations.filter((l) => app.scope.locationIds.includes(l.id) && l.site === 'live');
  const [locId, setLocId] = useState(locs[0]?.id ?? '');
  const [sound, setSound] = useState(true);
  const [simulateOffline, setSimulateOffline] = useState(false);
  const [full, setFull] = useState(false);
  const [, tick] = useState(0);
  const res = useApi((api) => api.foods.kitchen({ ...app.ctx, scopeId: `loc:${locId}` }), [app.role, locId]);
  const act = useOrderActions(() => res.reload());

  useEffect(() => {
    const h = setInterval(() => {
      tick((x) => x + 1);
      if (!simulateOffline) res.reload();
    }, 15000);
    return () => clearInterval(h);
  }, [simulateOffline, locId]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = (
    <Async res={res} loading={<LoadingBlock variant="cards" rows={4} />}>
      {(k) => {
        const stale = !k.connected || simulateOffline;
        const orders = [...k.orders].sort((a, b) => a.pickupAt.localeCompare(b.pickupAt));
        return (
          <>
            {stale ? (
              <Banner tone="danger" icon="wifi-off" title={t('staleTitle')} live="assertive">
                {t('staleBody', { time: fmtTime(simulateOffline ? new Date(Date.now() - 4 * 60000).toISOString() : k.lastRefreshed, k.timeZone, locale), ago: relativeTime(simulateOffline ? new Date(Date.now() - 4 * 60000).toISOString() : k.lastRefreshed, locale) })}
              </Banner>
            ) : (
              <p className="flex items-center gap-1.5 text-xs font-semibold text-success" role="status">
                <Icon name="check-circle" size={13} />
                {t('live', { time: fmtTime(k.lastRefreshed, k.timeZone, locale) })}
              </p>
            )}
            {orders.length === 0 ? (
              <Empty icon="chef" title={t('empty')} />
            ) : (
              <div className={cx('grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]', stale && 'opacity-60 grayscale')} aria-disabled={stale || undefined}>
                {orders.map((o) => (
                  <KitchenCard key={o.id} o={o} tz={k.timeZone} stale={stale} busy={act.pendingId === o.id} onAdvance={(s) => act.run(o, s)} tf={tf} />
                ))}
              </div>
            )}
            {act.error && <Banner tone="danger" live="assertive" title={tf('notSaved')}>{act.error.message}</Banner>}
          </>
        );
      }}
    </Async>
  );

  const controls = (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-4 py-3">
      <label className="flex h-10 items-center gap-2 rounded-full border border-line-soft px-3 text-[13px]">
        <Icon name="pin" size={14} />
        <span className="sr-only">{t('location')}</span>
        <select value={locId} onChange={(e) => setLocId(e.target.value)} className="bg-transparent font-bold focus:outline-none">
          {locs.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <span className="flex items-center gap-2 text-[13px] font-semibold">
        <Icon name={sound ? 'volume' : 'volume-off'} size={16} />
        {t('sound')}
        <Toggle checked={sound} onChange={setSound} label={t('sound')} />
      </span>
      <span className="flex items-center gap-2 text-[13px] font-semibold text-stone">
        {t('simulateOffline')}
        <Toggle checked={simulateOffline} onChange={setSimulateOffline} label={t('simulateOffline')} />
      </span>
      <Button size="sm" variant="secondary" icon={full ? 'x' : 'arrow-up-right'} className="ml-auto" onClick={() => setFull((f) => !f)}>
        {full ? t('exitFull') : t('fullScreen')}
      </Button>
    </div>
  );

  if (full)
    return (
      <div className="fixed inset-0 z-50 flex flex-col gap-3 overflow-y-auto bg-canvas p-3" role="dialog" aria-modal="true" aria-label={tOps('title')}>
        {controls}
        {body}
      </div>
    );
  return (
    <>
      <PageHeader icon="chef" title={tOps('title')} description={tOps('description')} />
      {controls}
      {body}
    </>
  );
}

function KitchenCard({ o, tz, stale, busy, onAdvance, tf }: { o: FoodOrder; tz: string; stale: boolean; busy: boolean; onAdvance: (s: FoodOrder['status']) => void; tf: ReturnType<typeof useTranslations> }) {
  const t = useTranslations('kitchen');
  const locale = useLocale();
  const overdue = Math.floor((Date.now() - new Date(o.pickupAt).getTime()) / 60000);
  const next = o.status === 'awaiting_acceptance' ? 'accepted' : o.status === 'accepted' ? 'preparing' : o.status === 'preparing' ? 'ready' : o.status === 'ready' ? 'collected' : null;
  return (
    <article className={cx('flex flex-col gap-3 rounded-xl border-[3px] bg-surface p-5', overdue > 0 && o.status !== 'ready' ? 'border-danger' : o.status === 'ready' ? 'border-success' : 'border-transparent')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[34px] font-extrabold leading-none tracking-tight">#{o.number}</div>
          <div className="mt-1 text-sm font-semibold text-stone">{o.customerFirstName}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-stone">{t('promised')}</div>
          <div className="tabular text-2xl font-extrabold">{fmtTime(o.pickupAt, tz, locale)}</div>
        </div>
      </div>
      {overdue > 0 && o.status !== 'ready' && (
        <div className="flex items-center gap-2 rounded-md bg-danger px-3 py-2 text-base font-extrabold text-white">
          <Icon name="alert" size={20} />
          {t('overdue', { min: overdue })}
        </div>
      )}
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-sm font-bold">{tf(`status.${o.status}`)}</div>
      <ul className="flex flex-col gap-1.5 text-lg">
        {o.items.map((it, i) => (
          <li key={i} className="leading-snug">
            <strong>{it.qty}×</strong> {it.name}
            {it.modifiers.map((m) => (
              <span key={m} className="block pl-7 text-base font-semibold text-graphite">
                + {m}
              </span>
            ))}
          </li>
        ))}
      </ul>
      {o.notes && <p className="rounded-md bg-butter px-3 py-2 text-base font-bold">{o.notes}</p>}
      {next && (
        <button type="button" disabled={stale || busy} onClick={() => onAdvance(next)} className="mt-auto h-14 rounded-full bg-ink text-lg font-extrabold text-white disabled:opacity-40">
          {busy ? tf('waitingAck') : tf(`action.${next}`)}
        </button>
      )}
    </article>
  );
}

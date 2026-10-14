'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, Textarea, cx } from '@bh/ui';
import type { FoodOrder, FoodOrderStatus } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { fmtTime, moneyWithCode } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../ui/States';

const NEXT: Partial<Record<FoodOrderStatus, FoodOrderStatus>> = { awaiting_acceptance: 'accepted', accepted: 'preparing', preparing: 'ready', ready: 'collected' };
const COLUMNS: FoodOrderStatus[] = ['awaiting_acceptance', 'accepted', 'preparing', 'ready'];

export function useOrderActions(onUpdated: (o: FoodOrder) => void) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const m = useMutation((api, id: string, status: FoodOrderStatus, reason?: string) => api.foods.setOrderStatus(id, status, reason));
  const run = async (o: FoodOrder, status: FoodOrderStatus, reason?: string) => {
    setPendingId(o.id);
    const r = await m.run(o.id, status, reason);
    setPendingId(null);
    if (r) onUpdated(r);
    return r;
  };
  return { run, pendingId, error: m.error };
}

export function FoodOrdersScreen() {
  const t = useTranslations('forders');
  const tOps = useTranslations('ops.foods.orders');
  const locale = useLocale();
  const app = useApp();
  const res = useApi((api) => api.foods.orders(app.ctx), [app.role, app.scopeId]);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const update = (o: FoodOrder) => res.status === 'ready' && res.setData(res.data.map((x) => (x.id === o.id ? o : x)));
  const act = useOrderActions(update);
  const locOf = (id: string) => app.locations.find((l) => l.id === id) ?? { name: '', timeZone: app.org.defaultTimeZone };

  return (
    <>
      <PageHeader icon="receipt" title={tOps('title')} description={tOps('description')} />
      {act.error && <Banner tone="danger" live="assertive" title={t('notSaved')}>{act.error.message}</Banner>}
      <Async res={res} loading={<LoadingBlock variant="calendar" />}>
        {(orders) => (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {COLUMNS.map((col) => {
                const list = orders.filter((o) => o.status === col).sort((a, b) => a.pickupAt.localeCompare(b.pickupAt));
                return (
                  <section key={col} aria-label={t(`status.${col}`)} className="flex flex-col gap-2 rounded-xl bg-surface p-3">
                    <h2 className="flex items-center justify-between px-1 text-sm font-bold">
                      {t(`status.${col}`)}
                      <span className="rounded-full bg-canvas px-2 py-0.5 text-xs">{list.length}</span>
                    </h2>
                    {list.length === 0 && <p className="rounded-md bg-canvas-raised p-3 text-xs text-stone">{t('none')}</p>}
                    {list.map((o) => {
                      const l = locOf(o.locationId);
                      const overdueMin = Math.floor((Date.now() - new Date(o.pickupAt).getTime()) / 60000);
                      const busy = act.pendingId === o.id;
                      const next = NEXT[o.status];
                      return (
                        <article key={o.id} className={cx('flex flex-col gap-2 rounded-lg border-[1.5px] p-3', overdueMin > 0 && o.status !== 'ready' ? 'border-danger bg-danger-bg/40' : 'border-line-soft')}>
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-[15px] font-extrabold">
                                #{o.number} · {o.customerFirstName}
                              </div>
                              <div className="text-xs text-stone">
                                {l.name} · {t('pickup', { time: fmtTime(o.pickupAt, l.timeZone, locale) })}
                              </div>
                            </div>
                            <span className="tabular text-sm font-bold">{moneyWithCode(o.total, locale)}</span>
                          </div>
                          {overdueMin > 0 && o.status !== 'ready' && <Badge tone="danger">{t('overdue', { min: overdueMin })}</Badge>}
                          <ul className="text-[13px]">
                            {o.items.map((it, i) => (
                              <li key={i}>
                                <strong>{it.qty}×</strong> {it.name}
                                {it.modifiers.length > 0 && <span className="text-stone"> · {it.modifiers.join(', ')}</span>}
                              </li>
                            ))}
                          </ul>
                          {o.notes && <p className="rounded-sm bg-butter px-2 py-1 text-xs font-semibold">{o.notes}</p>}
                          <div className="flex items-center gap-1.5 text-xs text-success">
                            <Icon name="check-circle" size={12} />
                            {t('paid')}
                          </div>
                          {app.can('operations.write') && (
                            <div className="flex flex-wrap gap-1.5">
                              {next && (
                                <Button size="sm" loading={busy} onClick={() => act.run(o, next)}>
                                  {t(`action.${next}`)}
                                </Button>
                              )}
                              {o.status === 'awaiting_acceptance' && (
                                <Button size="sm" variant="secondary" disabled={busy} onClick={() => (setRejecting(o.id), setReason(''))}>
                                  {t('reject')}
                                </Button>
                              )}
                            </div>
                          )}
                          {busy && <p role="status" className="text-xs text-stone">{t('waitingAck')}</p>}
                          {rejecting === o.id && (
                            <div className="flex flex-col gap-1.5 rounded-md bg-danger-bg p-2.5">
                              <label htmlFor={`rej-${o.id}`} className="text-xs font-bold text-danger">
                                {t('rejectReason')}
                              </label>
                              <Textarea id={`rej-${o.id}`} value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-16" />
                              <p className="text-[11px] text-danger">{t('rejectConsequence', { amount: moneyWithCode(o.total, locale) })}</p>
                              <div className="flex gap-1.5">
                                <Button size="sm" variant="danger" disabled={!reason.trim()} onClick={async () => (await act.run(o, 'rejected', reason)) && setRejecting(null)}>
                                  {t('confirmReject')}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>
                                  {t('cancel')}
                                </Button>
                              </div>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </section>
                );
              })}
            </div>
            <p className="text-xs text-stone">{t('ackNote')}</p>
          </>
        )}
      </Async>
    </>
  );
}

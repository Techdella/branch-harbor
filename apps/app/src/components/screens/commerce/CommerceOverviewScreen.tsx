'use client';

import Link from 'next/link';
import { Button, Icon } from '@bh/ui';
import { cx as call, orgPath, useAction, useCommerce } from '@/lib/commerce/client';
import type { Overview } from '@/lib/commerce/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, SectionCard } from '../../ui/States';
import { ActionError, Money, Stat, StatusBadge, View, When, useCt } from './kit';

/** Commerce overview: orders needing action, stock warnings, revenue by currency and sync health. */
export function CommerceOverviewScreen() {
  const t = useCt();
  const app = useApp();
  const res = useCommerce(() => call<Overview>('GET', '/overview'), [app.org.id, app.apiMode]);
  const sync = useAction((connectionId: string) => call<{ created: number; updated: number; unchanged: number; errors: unknown[] }>('POST', orgPath(`/commerce/connections/${connectionId}/sync-orders`)));
  const ids = app.scope.locationIds;
  const inScope = (lid: string | null) => !lid || !ids.length || ids.includes(lid);

  return (
    <>
      <PageHeader icon="activity" title={t('overview.title')} description={t('overview.description')} />
      <View res={res}>
        {(d) => (
          <div className="flex flex-col gap-4">
            <SectionCard title={t('overview.ordersTitle')} aside={<Link href="/ops/orders" className="text-sm font-bold underline">{t('overview.openOrders')}</Link>}>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <Stat label={t('overview.toFulfil')} value={d.orders.toFulfil} />
                <Stat label={t('overview.ready')} value={d.orders.readyForPickup} />
                <Stat label={t('overview.backordered')} value={d.orders.backordered} tone={d.orders.backordered ? 'warning' : undefined} />
                <Stat label={t('overview.awaitingTransfer')} value={d.orders.awaitingTransfer} />
                <Stat label={t('overview.needsAttention')} value={d.orders.needsAttention} tone={d.orders.needsAttention ? 'danger' : undefined} hint={t('overview.needsAttentionHint')} />
                <Stat label={t('overview.awaitingPayment')} value={d.orders.awaitingPayment} hint={t('overview.awaitingPaymentHint')} />
              </div>
            </SectionCard>

            <SectionCard title={t('overview.revenueTitle')} aside={<span className="text-xs text-stone">{t('overview.revenueSource')}</span>}>
              {d.sales === null ? (
                <Banner tone="neutral" icon="lock">{d.salesUnavailableReason ?? t('common.unavailable')}</Banner>
              ) : (
                <>
                  <div className="mb-3 grid gap-3 md:grid-cols-3">
                    {d.revenueByCurrency.map((r) => (
                      <div key={r.currency} className="rounded-lg bg-canvas-raised p-4">
                        <div className="text-xs font-bold text-stone">{r.currency}</div>
                        <div className="mt-1 flex flex-wrap items-baseline gap-x-3"><span className="text-xs text-stone">{t('overview.today')}</span><Money m={r.today} className="text-lg font-bold" /></div>
                        <div className="flex flex-wrap items-baseline gap-x-3"><span className="text-xs text-stone">{t('overview.last7')}</span><Money m={r.last7Days} className="font-bold" /><span className="text-xs text-stone">{t('overview.ordersCount', { n: r.orders7 })}</span></div>
                      </div>
                    ))}
                  </div>
                  <p className="mb-3 flex items-center gap-1.5 text-xs text-stone"><Icon name="info" size={14} />{t('overview.noCombined')}</p>
                  <div className="max-w-full overflow-x-auto" tabIndex={0}><table className="w-full text-sm">
                    <thead><tr className="border-b border-line-soft text-left text-xs uppercase text-stone"><th className="py-2">{t('common.store')}</th><th className="py-2 text-right">{t('overview.today')}</th><th className="py-2 text-right">{t('overview.last7')}</th><th className="hidden py-2 text-right md:table-cell">{t('overview.refunds7')}</th></tr></thead>
                    <tbody>
                      {d.sales.filter((s) => inScope(s.locationId)).map((s) => (
                        <tr key={s.locationId} className="border-b border-line-soft last:border-0">
                          <td className="py-2.5 font-semibold">{s.locationName}</td>
                          <td className="py-2.5 text-right"><Money m={s.today.gross} /> <span className="text-xs text-stone">({s.today.orders})</span></td>
                          <td className="py-2.5 text-right"><Money m={s.last7Days.gross} /> <span className="text-xs text-stone">({s.last7Days.orders})</span></td>
                          <td className="hidden py-2.5 text-right md:table-cell"><Money m={s.last7Days.refunds} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                </>
              )}
            </SectionCard>

            <div className="grid gap-4 lg:grid-cols-2">
              <SectionCard title={t('overview.stockTitle')} aside={<Link href="/ops/inventory" className="text-sm font-bold underline">{t('overview.openInventory')}</Link>}>
                <div className="mb-3 grid grid-cols-2 gap-3">
                  <Stat label={t('overview.lowStock')} value={d.stock.low} tone={d.stock.low ? 'warning' : undefined} />
                  <Stat label={t('overview.outOfStock')} value={d.stock.out} tone={d.stock.out ? 'danger' : undefined} />
                </div>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {d.stock.top.filter((a) => inScope(a.locationId)).map((a) => (
                    <li key={`${a.locationId}:${a.variantId}`} className="flex items-center justify-between gap-2 rounded-md bg-canvas-raised px-3 py-2">
                      <span className="min-w-0"><span className="block truncate font-semibold">{a.name}</span><span className="text-xs text-stone">{a.locationName} · {t('overview.availableOf', { n: a.available, point: a.reorderPoint ?? '—' })}</span></span>
                      <span className={cx2(a.severity === 'out' ? 'text-danger' : 'text-warning', 'text-xs font-bold')}>{a.severity === 'out' ? t('overview.out') : t('overview.low')}</span>
                    </li>
                  ))}
                  {!d.stock.top.length && <li className="text-stone">{t('overview.noStockWarnings')}</li>}
                </ul>
              </SectionCard>
              <SectionCard title={t('overview.opsTitle')}>
                <div className="grid grid-cols-2 gap-3">
                  <Stat label={t('overview.transfersRequested')} value={d.transfers.requested} />
                  <Stat label={t('overview.transfersToShip')} value={d.transfers.toShip} />
                  <Stat label={t('overview.inTransit')} value={d.transfers.inTransit} />
                  <Stat label={t('overview.openReturns')} value={d.returns.open} hint={d.returns.awaitingApproval ? t('overview.awaitingApproval', { n: d.returns.awaitingApproval }) : undefined} />
                </div>
              </SectionCard>
            </div>

            <SectionCard title={t('overview.syncTitle')}>
              {!d.connections.length && <p className="text-sm text-stone">{t('overview.noConnections')}</p>}
              <ul className="flex flex-col gap-2">
                {d.connections.filter((c) => inScope(c.locationId)).map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-md bg-canvas-raised px-4 py-3 text-sm">
                    <Icon name="plug" size={18} />
                    <span className="font-bold capitalize">{c.provider}</span>
                    <StatusBadge kind="connection" value={c.state} />
                    <span className="text-xs text-stone">{c.authoritative === 'external' ? t('overview.authoritativeExternal', { provider: c.provider }) : t('overview.authoritativeBh')}</span>
                    <span className="text-xs text-stone">{t('overview.lastSync')} <When iso={c.lastSuccessAt} /></span>
                    {c.lastError && <span className="text-xs font-bold text-warning">{c.lastError}</span>}
                    {c.provider === 'woocommerce' && app.can('connections.manage') && (
                      <Button size="sm" variant="secondary" icon="refresh" className="ms-auto" loading={sync.pending} onClick={async () => { const r = await sync.run(c.id); if (r) res.reload(); }}>{t('overview.syncOrders')}</Button>
                    )}
                  </li>
                ))}
              </ul>
              {sync.error && <div className="mt-2"><ActionError error={sync.error} /></div>}
            </SectionCard>
          </div>
        )}
      </View>
    </>
  );
}

const cx2 = (...c: string[]) => c.join(' ');

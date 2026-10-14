'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Icon, cx, type Tone } from '@bh/ui';
import { totalsByCurrency } from '@bh/shared';
import type { PaymentState, ReconciliationItem, RefundState, Transaction } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { FIXTURES } from '@/lib/mock/orgs';
import { fmtDateTime, moneyWithCode } from '@/lib/format';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { useScopeLabel } from '../shell/ScopePicker';
import { Async, Banner, DeniedState, Empty, LoadingBlock } from '../ui/States';
import { Timeline } from './Timeline';

type Tab = 'transactions' | 'reconciliation' | 'setup';
const payTone: Record<PaymentState, Tone> = { created: 'neutral', requires_action: 'warning', processing: 'info', succeeded: 'success', failed: 'danger', cancelled: 'neutral' };
const refTone: Record<RefundState, Tone> = { none: 'neutral', requested: 'warning', pending: 'warning', partial: 'info', complete: 'info', failed: 'danger' };
const CURRENCY_PASTEL = ['#E2F5A6', '#CDEEEE', '#E9DDF8', '#F7EDA8', '#F8D6D8', '#D4E6D9'];

export function PaymentsScreen() {
  const t = useTranslations('payments');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'transactions';
  const recRes = useApi((api) => api.payments.reconciliation(app.ctx), [app.industry, app.role, app.scopeId], app.can('payments.read'));
  if (!app.can('payments.read')) return <DeniedState permission="payments.read" detail={t('denied')} />;
  const open = recRes.status === 'ready' ? recRes.data.filter((r) => r.status !== 'resolved').length : 0;
  const tabs: [Tab, string, number][] = [
    ['transactions', t('tab.transactions'), 0],
    ['reconciliation', t('tab.reconciliation'), open],
    ['setup', t('tab.setup'), 0],
  ];
  return (
    <>
      <PageHeader icon="card" title={t('title')} description={t('description')} />
      <div role="tablist" className="flex flex-wrap gap-1.5">
        {tabs.map(([k, label, badge]) => (
          <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => router.replace(`?tab=${k}`, { scroll: false })} className={cx('flex h-[42px] items-center gap-1.5 rounded-full px-4 text-[13px] font-bold', tab === k ? 'bg-ink text-white' : 'bg-surface')}>
            {label}
            {badge > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[11px] text-white" aria-label={t('needsAction', { count: badge })}>
                {badge}
              </span>
            )}
          </button>
        ))}
      </div>
      {tab === 'reconciliation' ? <Reconciliation res={recRes} /> : tab === 'setup' ? <Setup /> : <Transactions />}
    </>
  );
}

function Transactions() {
  const t = useTranslations('payments');
  const locale = useLocale();
  const app = useApp();
  const scopeLabel = useScopeLabel();
  const router = useRouter();
  const params = useSearchParams();
  const res = useApi((api) => api.payments.transactions(app.ctx), [app.industry, app.role, app.scopeId]);
  const locs = FIXTURES[app.industry].locations;
  const loc = (id: string) => locs.find((l) => l.id === id)!;
  const openId = params.get('tx');
  const setOpen = (id: string | null) => router.replace(id ? `?tab=transactions&tx=${id}` : '?tab=transactions', { scroll: false });

  return (
    <Async res={res} permission="payments.read" loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.length === 0} empty={<Empty icon="card" title={t('emptyTx')} body={t('emptyTxBody')} />}>
      {(txs) => {
        const succeeded = txs.filter((x) => x.payment === 'succeeded');
        const totals = totalsByCurrency(succeeded.map((x) => x.amount));
        const open = txs.find((x) => x.id === openId);
        return (
          <>
            <section aria-label={t('totals')} className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
              {totals.map((m, i) => {
                const where = [...new Set(succeeded.filter((x) => x.amount.currency === m.currency).map((x) => loc(x.locationId).address.city))];
                return (
                  <div key={m.currency} className="rounded-lg p-4" style={{ background: CURRENCY_PASTEL[i % CURRENCY_PASTEL.length] }}>
                    <div className="text-xs font-semibold">{t('succeededIn', { currency: m.currency })}</div>
                    <div className="tabular text-[26px] font-extrabold">{moneyWithCode(m, locale)}</div>
                    <div className="text-[11px]">{t('totalSource', { where: where.join(', ') })}</div>
                  </div>
                );
              })}
              <div className="rounded-lg bg-surface p-4">
                <div className="text-xs font-semibold">{t('combined')}</div>
                <div className="text-xl font-extrabold">{totals.length > 1 ? t('notShown') : totals[0] ? moneyWithCode(totals[0], locale) : '—'}</div>
                <div className="text-[11px] text-stone">{totals.length > 1 ? t('noConversion', { currencies: totals.map((x) => x.currency).join(' + ') }) : t('singleCurrency')}</div>
              </div>
            </section>
            <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
              <p className="px-1 pb-2 text-xs text-stone">{t('txScope', { count: txs.length, scope: scopeLabel })}</p>
              <DataTable<Transaction>
                rows={txs}
                rowKey={(x) => x.id}
                onRowClick={(x) => setOpen(x.id)}
                columns={[
                  { key: 'ref', header: t('col.ref'), render: (x) => <span><strong className="font-mono text-[13px]">{x.externalRef}</strong><span className="block text-xs text-stone">{fmtDateTime(x.createdAt, loc(x.locationId).timeZone, locale)}</span></span> },
                  { key: 'what', header: t('col.what'), render: (x) => <span>{x.description}<span className="block text-xs text-stone">{loc(x.locationId).name}</span></span> },
                  { key: 'amt', header: t('col.amount'), align: 'right', render: (x) => <strong>{moneyWithCode(x.amount, locale)}</strong> },
                  { key: 'pay', header: t('col.payment'), render: (x) => <Badge tone={payTone[x.payment]}>{t(`payState.${x.payment}`)}</Badge> },
                  { key: 'ref2', header: t('col.refund'), render: (x) => <Badge tone={refTone[x.refund]} icon={x.refund === 'none' ? 'minus' : undefined}>{t(`refundState.${x.refund}`)}</Badge> },
                ]}
              />
            </section>
            <p className="text-xs text-stone">{t('settlementNote')}</p>
            <Drawer open={!!open} onClose={() => setOpen(null)} kicker={t('detail')} title={open ? `${open.externalRef} · ${moneyWithCode(open.amount, locale)}` : ''}>
              {open && (
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {[
                      [t('col.what'), open.description],
                      [t('location'), loc(open.locationId).name],
                      [t('provider'), open.provider],
                      [t('linked'), open.linkedRecord ?? t('missing')],
                      [t('col.payment'), t(`payState.${open.payment}`)],
                      [t('col.refund'), t(`refundState.${open.refund}`)],
                    ].map(([k, v]) => (
                      <div key={k} className="rounded-[14px] bg-canvas p-2.5">
                        <div className="text-stone">{k}</div>
                        <strong className="text-[13px]">{v}</strong>
                      </div>
                    ))}
                  </div>
                  <h3 className="text-[13px] font-bold">{t('timeline')}</h3>
                  <Timeline events={open.timeline} tz={loc(open.locationId).timeZone} />
                  <p className="text-xs text-stone">{t('signedEvents')}</p>
                  <Button variant="secondary" size="sm" icon="receipt" className="self-start" disabled title={t('receiptLater')}>
                    {t('receipt')}
                  </Button>
                </div>
              )}
            </Drawer>
          </>
        );
      }}
    </Async>
  );
}

function Reconciliation({ res }: { res: ReturnType<typeof useApi<ReconciliationItem[]>> }) {
  const t = useTranslations('payments');
  const locale = useLocale();
  const app = useApp();
  const [selId, setSelId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [ack, setAck] = useState(false);
  const recreate = useMutation((api, id: string) => api.payments.recreateOrder(id));
  const refund = useMutation((api, id: string, amount: number, currency: string) => api.payments.refund(id, { amount, currency }));
  const locs = FIXTURES[app.industry].locations;
  const loc = (id: string) => locs.find((l) => l.id === id)!;
  const canRefund = app.can('payments.refund');
  const canRecreate = app.can('operations.write') || app.role === 'hq';

  const update = (r: ReconciliationItem | undefined) => {
    if (r && res.status === 'ready') res.setData(res.data.map((x) => (x.id === r.id ? r : x)));
    setConfirming(false);
    setAck(false);
  };
  const icon = { paid_without_record: 'card', unpaid_confirmed: 'receipt', amount_mismatch: 'alert' } as const;

  return (
    <Async res={res} permission="payments.read" loading={<LoadingBlock variant="detail" />} isEmpty={(d) => d.length === 0} empty={<Empty icon="check-circle" title={t('recEmpty')} />}>
      {(items) => {
        const sel = items.find((x) => x.id === selId) ?? items.find((x) => x.status === 'needs_action') ?? items[0]!;
        const l = loc(sel.locationId);
        const busy = recreate.pending || refund.pending;
        return (
          <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr))]">
            <section className="flex flex-col gap-1.5 rounded-xl bg-surface p-3" aria-label={t('queue')}>
              {items.map((r) => (
                <button key={r.id} type="button" aria-pressed={r.id === sel.id} onClick={() => (setSelId(r.id), setConfirming(false))} className={cx('flex w-full items-center gap-3 rounded-[18px] border-[1.5px] p-3.5 text-left', r.id === sel.id ? 'border-ink bg-[#FAFAF7]' : 'border-line-soft')}>
                  <span className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-md', r.status === 'needs_action' ? 'bg-blush' : 'bg-canvas')}>
                    <Icon name={icon[r.type]} size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold">{t(`recType.${r.type}`)}</div>
                    <div className="truncate text-xs text-stone">
                      {r.transactionRef} · {moneyWithCode(r.amount, locale)} · {loc(r.locationId).name}
                    </div>
                  </div>
                  <Badge tone={r.status === 'resolved' ? 'success' : r.status === 'reviewing' ? 'warning' : 'danger'}>{t(`recStatus.${r.status}`)}</Badge>
                </button>
              ))}
            </section>
            <section className="flex flex-col gap-3.5 rounded-xl bg-surface p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs text-stone">{t(`recType.${sel.type}`)}</div>
                  <h2 className="text-xl font-bold">
                    {sel.transactionRef} · {moneyWithCode(sel.amount, locale)}
                  </h2>
                </div>
                <Badge tone={sel.status === 'resolved' ? 'success' : 'danger'}>{t(`recStatus.${sel.status}`)}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {[
                  [t('location'), l.name],
                  [t('customer'), sel.customer],
                  [t('col.payment'), sel.type === 'unpaid_confirmed' ? t('payState.created') : t('payState.succeeded')],
                  [t('recordState'), sel.orderState],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-[14px] bg-canvas p-2.5">
                    <div className="text-stone">{k}</div>
                    <strong className="text-[13px]">{v}</strong>
                  </div>
                ))}
              </div>
              <div>
                <h3 className="mb-1.5 text-[13px] font-bold">{t('timeline')}</h3>
                <Timeline events={sel.timeline} tz={l.timeZone} />
              </div>
              {sel.status === 'needs_action' && !confirming && !busy && (
                <div className="flex flex-wrap gap-2">
                  <Button icon="refresh" disabled={!canRecreate} onClick={async () => update(await recreate.run(sel.id))}>
                    {t('recreate')}
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirming(true)}>
                    {t('refundInstead')}
                  </Button>
                </div>
              )}
              {confirming && (
                <div className="rounded-lg bg-danger-bg p-4 text-[13px] leading-normal text-[#5C1414]">
                  <strong className="text-sm">{t('refundConfirm', { amount: moneyWithCode(sel.amount, locale), customer: sel.customer })}</strong>
                  <p>{t('refundWhere', { location: l.name })}</p>
                  {!canRefund ? (
                    <p className="mt-2 flex items-center gap-1.5 font-bold">
                      <Icon name="lock" size={14} />
                      {t('needsFinance')}
                    </p>
                  ) : (
                    <label className="mt-2 flex items-start gap-2">
                      <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 h-4 w-4 accent-danger" />
                      {t('ackAmount', { amount: moneyWithCode(sel.amount, locale) })}
                    </label>
                  )}
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="danger" disabled={!canRefund || !ack} onClick={async () => update(await refund.run(sel.id, sel.amount.amount, sel.amount.currency))}>
                      {t('refundButton', { amount: moneyWithCode(sel.amount, locale) })}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => (setConfirming(false), setAck(false))}>
                      {t('back')}
                    </Button>
                  </div>
                </div>
              )}
              {busy && (
                <Banner tone="info" icon="refresh" live="polite">
                  {recreate.pending ? t('recreating') : t('refunding')}
                </Banner>
              )}
              {(recreate.error || refund.error) && <Banner tone="danger" live="assertive">{(recreate.error ?? refund.error)!.message}</Banner>}
              {sel.status === 'resolved' && sel.resolution && <Banner tone="success" live="polite">{t('resolved', { resolution: sel.resolution })}</Banner>}
            </section>
          </div>
        );
      }}
    </Async>
  );
}

function Setup() {
  const t = useTranslations('payments');
  const app = useApp();
  const res = useApi((api) => api.payments.accounts(app.ctx), [app.industry, app.role]);
  const locs = FIXTURES[app.industry].locations;
  return (
    <Async res={res} permission="payments.read" loading={<LoadingBlock variant="cards" rows={4} />}>
      {(accts) => (
        <>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]">
            {accts.map((a) => {
              const l = locs.find((x) => x.id === a.locationId)!;
              return (
                <div key={a.locationId} className="flex flex-col gap-2 rounded-lg bg-surface p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-[15px] font-bold">
                      <Icon name="card" size={17} />
                      {l.name}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone={a.status === 'enabled' ? 'success' : a.status === 'pending_verification' ? 'warning' : 'danger'}>{t(`acctStatus.${a.status}`)}</Badge>
                    <Badge tone="neutral" icon={null}>{a.arrangement === 'own' ? t('ownAccount') : t('sharedAccount')}</Badge>
                    <Badge tone="neutral" icon={null}>{l.currency}</Badge>
                  </div>
                  <p className="text-xs text-stone">
                    {a.provider} · {a.arrangement === 'own' ? t('ownDetail') : t('sharedDetail')}
                  </p>
                  {a.capabilities.length > 0 && <p className="text-xs">{a.capabilities.join(' · ')}</p>}
                  {a.status !== 'enabled' && <p className="text-xs font-semibold text-warning">{t('notPurchasable')}</p>}
                </div>
              );
            })}
          </div>
          <Banner tone="neutral">{t('subscriptionNote')}</Banner>
        </>
      )}
    </Async>
  );
}


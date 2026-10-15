'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Field, Input, Select } from '@bh/ui';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { downloadFile, financeApi, useFinance, useFinanceAction, type PayoutVM, type ReconRowVM, type RevenueRowVM } from './api';
import { ActionError, CurrencyTiles, InvoiceBadge, PillTabs, SandboxNote, StatementBadge, useDate, useMoney, usePeriodLabel } from './FinanceUi';

type Tab = 'payouts' | 'reconciliation' | 'exports';

/** Payouts per location (fees, refunds, chargebacks), reconciliation against payments and royalties, accounting exports. */
export function PayoutsScreen() {
  const t = useTranslations('finance');
  const app = useApp();
  const [tab, setTab] = useState<Tab>('payouts');
  if (!app.hasModule('finance.payouts')) return <DeniedState />;
  return (
    <>
      <PageHeader icon="wallet" title={t('payouts.title')} description={t('payouts.description')} scope={false} />
      <PillTabs items={[['payouts', t('payouts.tab.payouts')], ['reconciliation', t('payouts.tab.reconciliation')], ['exports', t('payouts.tab.exports')]]} value={tab} onChange={setTab} />
      {tab === 'reconciliation' ? <Reconciliation /> : tab === 'exports' ? <Exports /> : <Payouts />}
    </>
  );
}

function Payouts() {
  const t = useTranslations('finance');
  const app = useApp();
  const money = useMoney();
  const date = useDate();
  const res = useFinance(() => financeApi.payouts(), [app.org.id]);
  const [msg, setMsg] = useState('');
  const sync = useFinanceAction(async () => {
    const r = await financeApi.syncPayouts();
    setMsg(t('payouts.synced', { count: r.payouts }));
    res.reload();
  });
  return (
    <Async res={res} loading={<LoadingBlock variant="table" />}>
      {(d) => {
        const sum = (f: (p: PayoutVM) => number) => {
          const m = new Map<string, number>();
          for (const p of d.items) m.set(p.currency, (m.get(p.currency) ?? 0) + f(p));
          return [...m.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor }));
        };
        return (
          <>
            {d.mode === 'sandbox' && <SandboxNote />}
            <div className="flex flex-wrap gap-2">
              {app.capabilities.has('finance.payouts:edit') && <Button variant="secondary" icon="refresh" loading={sync.pending} onClick={() => void sync.run()} data-testid="sync-payouts">{t('payouts.sync')}</Button>}
            </div>
            <ActionError error={sync.error} />
            {msg && <Banner tone="success" live="polite">{msg}</Banner>}
            <CurrencyTiles items={sum((p) => p.amountMinor)} label={(c) => t('payouts.netIn', { currency: c })} sub={(c) => t('payouts.feesSub', { fees: money(sum((p) => p.feesMinor).find((x) => x.currency === c)?.amountMinor ?? 0, c), chargebacks: money(sum((p) => p.chargebacksMinor).find((x) => x.currency === c)?.amountMinor ?? 0, c) })} />
            {d.items.length === 0 ? <Empty icon="wallet" title={t('payouts.empty')} body={t('payouts.emptyBody')} /> : (
              <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
                <DataTable<PayoutVM>
                  rows={d.items}
                  rowKey={(p) => p.id}
                  columns={[
                    { key: 'when', header: t('payouts.arrives'), render: (p) => <span><strong>{date(p.arrivalDate)}</strong><span className="block font-mono text-xs text-stone">{p.externalId}</span></span> },
                    { key: 'loc', header: t('col.location'), render: (p) => p.location.name },
                    { key: 'gross', header: t('col.grossSales'), align: 'right', render: (p) => money(p.grossMinor, p.currency) },
                    { key: 'fees', header: t('payouts.fees'), align: 'right', render: (p) => money(-p.feesMinor, p.currency) },
                    { key: 'ref', header: t('col.refunds'), align: 'right', render: (p) => money(-p.refundsMinor, p.currency) },
                    { key: 'cb', header: t('payouts.chargebacks'), align: 'right', render: (p) => money(-p.chargebacksMinor, p.currency) },
                    { key: 'net', header: t('payouts.net'), align: 'right', render: (p) => <strong>{money(p.amountMinor, p.currency)}</strong> },
                    { key: 'st', header: t('col.status'), render: (p) => <Badge tone={p.status === 'paid' ? 'success' : p.status === 'failed' ? 'danger' : 'info'}>{t(`payoutStatus.${p.status}`)}</Badge> },
                  ]}
                />
              </section>
            )}
          </>
        );
      }}
    </Async>
  );
}

function Reconciliation() {
  const t = useTranslations('finance');
  const app = useApp();
  const money = useMoney();
  const period = usePeriodLabel();
  const periods = useFinance(() => financeApi.periods(), [app.org.id]);
  const [periodId, setPeriodId] = useState('');
  const selected = periodId || periods.data?.items[0]?.id || '';
  const res = useFinance(() => financeApi.reconciliation(selected), [selected], !!selected);
  return (
    <Async res={periods} loading={<LoadingBlock />} isEmpty={(p) => p.items.length === 0} empty={<Empty icon="receipt" title={t('royalties.noPeriods')} body={t('royalties.noPeriodsBody')} />}>
      {(p) => (
        <>
          <p className="text-sm text-stone">{t('recon.hint')}</p>
          <Field label={t('royalties.period')}>{(f) => (
            <Select id={f.id} value={selected} onChange={(e) => setPeriodId(e.target.value)}>
              {p.items.map((x) => <option key={x.id} value={x.id}>{period(x)}</option>)}
            </Select>
          )}</Field>
          <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="check-circle" title={t('recon.empty')} />}>
            {(d) => (
              <section className="overflow-x-auto rounded-xl bg-surface p-3.5" data-testid="reconciliation">
                <DataTable<ReconRowVM>
                  rows={d.items}
                  rowKey={(r) => r.locationId}
                  columns={[
                    { key: 'loc', header: t('col.location'), render: (r) => <strong>{r.location.name}</strong> },
                    { key: 'pay', header: t('recon.payments'), align: 'right', render: (r) => <span>{money(r.paymentsMinor, r.currency)}<span className="block text-xs text-stone">{t('recon.count', { count: r.paymentCount })}</span></span> },
                    { key: 'out', header: t('recon.paidOut'), align: 'right', render: (r) => money(r.paidOutMinor, r.currency) },
                    { key: 'fees', header: t('payouts.fees'), align: 'right', render: (r) => money(-r.feesMinor, r.currency) },
                    { key: 'st', header: t('recon.statement'), render: (r) => (r.statement ? <span className="flex flex-col gap-1"><StatementBadge status={r.statement.status} /><span className="text-xs">{money(r.statement.totalMinor, r.currency)}</span></span> : '—') },
                    { key: 'inv', header: t('col.invoice'), render: (r) => (r.invoice ? <span className="flex flex-col gap-1"><InvoiceBadge state={r.invoice.status} /><span className="font-mono text-xs">{r.invoice.number}</span></span> : '—') },
                    { key: 'iss', header: t('recon.issues'), render: (r) => (r.issues.length ? <span className="flex flex-col gap-1">{r.issues.map((i) => <Badge key={i.kind} tone="warning" icon="alert">{t(`recon.issue.${i.kind}`)}{i.amountMinor ? ` · ${money(i.amountMinor, r.currency)}` : ''}</Badge>)}</span> : <Badge tone="success">{t('recon.ok')}</Badge>) },
                  ]}
                />
              </section>
            )}
          </Async>
        </>
      )}
    </Async>
  );
}

function Exports() {
  const t = useTranslations('finance');
  const year = new Date().getUTCFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year + 1}-01-01`);
  const [currency, setCurrency] = useState('');
  const dl = useFinanceAction((dataset: string, format: string) => downloadFile(`/exports/${dataset}`, `${dataset}_${format}_${from}_${to}.csv`, { format, from, to, currency: currency || undefined }));
  const rows: Array<[string, string[]]> = [['statements', ['csv']], ['invoices', ['csv', 'xero', 'quickbooks']], ['payouts', ['csv', 'xero', 'quickbooks']], ['fund', ['csv']]];
  return (
    <SectionCard title={t('exports.title')}>
      <p className="mb-3 text-sm text-stone">{t('exports.hint')}</p>
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Field label={t('exports.from')}>{(p) => <Input id={p.id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('exports.to')}>{(p) => <Input id={p.id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label={t('exports.currency')} hint={t('exports.currencyHint')} optional>{(p) => <Input id={p.id} maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />}</Field>
      </div>
      <ActionError error={dl.error} />
      <div className="flex flex-col gap-2">
        {rows.map(([ds, formats]) => (
          <div key={ds} className="flex flex-wrap items-center gap-2 border-b border-line py-2">
            <span className="min-w-40 font-bold">{t(`exports.dataset.${ds}`)}</span>
            {formats.map((f) => <Button key={f} size="sm" variant="secondary" icon="download" loading={dl.pending} onClick={() => void dl.run(ds, f)}>{t(`exports.format.${f}`)}</Button>)}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

/** Finance reports: royalty revenue by location and region, collection rate, arrears ageing, fund balance — per currency. */
export function FinanceReportsScreen() {
  const t = useTranslations('finance');
  const app = useApp();
  const money = useMoney();
  const thisYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(thisYear);
  const res = useFinance(() => financeApi.reports(`${year}-01-01`, `${year + 1}-01-01`), [year, app.org.id], app.hasModule('finance.royalties'));
  if (!app.hasModule('finance.royalties')) return <DeniedState />;
  const revenueCols = (first: string) => [
    { key: 'n', header: first, render: (r: RevenueRowVM) => <strong>{r.name ?? t('reports.noRegion')}</strong> },
    { key: 'c', header: t('terms.currency'), render: (r: RevenueRowVM) => r.currency },
    { key: 'b', header: t('col.basis'), align: 'right' as const, render: (r: RevenueRowVM) => money(r.basisMinor, r.currency) },
    { key: 'r', header: t('col.royalty'), align: 'right' as const, render: (r: RevenueRowVM) => money(r.royaltyMinor, r.currency) },
    { key: 'f', header: t('col.fund'), align: 'right' as const, render: (r: RevenueRowVM) => money(r.marketingFundMinor, r.currency) },
    { key: 't', header: t('col.total'), align: 'right' as const, render: (r: RevenueRowVM) => <strong>{money(r.totalMinor, r.currency)}</strong> },
  ];
  return (
    <>
      <PageHeader icon="chart" title={t('reports.title')} description={t('reports.description')} scope={false} />
      <Field label={t('fund.year')}>{(p) => (
        <Select id={p.id} value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>
      )}</Field>
      <Async res={res} loading={<LoadingBlock />}>
        {(d) => (
          <>
            <CurrencyTiles items={d.collectionRate.map((c) => ({ currency: c.currency, amountMinor: c.collectedMinor }))} label={(c) => t('reports.collectedIn', { currency: c })} sub={(c) => { const r = d.collectionRate.find((x) => x.currency === c)!; return t('reports.collectionSub', { rate: Math.round(r.rate * 100), invoiced: money(r.invoicedMinor, c), onTime: r.paidOnTime, paid: r.paidInvoices }); }} />
            <SectionCard title={t('reports.byLocation')}>
              {d.royaltyByLocation.length ? <div className="overflow-x-auto"><DataTable<RevenueRowVM> rows={d.royaltyByLocation} rowKey={(r) => `${r.key}${r.currency}`} columns={revenueCols(t('col.location'))} /></div> : <p className="text-sm text-stone">{t('reports.none')}</p>}
            </SectionCard>
            <SectionCard title={t('reports.byRegion')}>
              {d.royaltyByRegion.length ? <div className="overflow-x-auto"><DataTable<RevenueRowVM> rows={d.royaltyByRegion} rowKey={(r) => `${r.key}${r.currency}`} columns={revenueCols(t('reports.region'))} /></div> : <p className="text-sm text-stone">{t('reports.none')}</p>}
            </SectionCard>
            <SectionCard title={t('reports.ageing')}>
              {d.arrearsAgeing.length ? (
                <div className="overflow-x-auto">
                  <DataTable<ReportsAgeing>
                    rows={d.arrearsAgeing}
                    rowKey={(r) => r.currency}
                    columns={[
                      { key: 'c', header: t('terms.currency'), render: (r) => <strong>{r.currency}</strong> },
                      ...(['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const).map((b) => ({ key: b, header: t(`reports.bucket.${b}`), align: 'right' as const, render: (r: ReportsAgeing) => money(r[b], r.currency) })),
                      { key: 'tot', header: t('col.total'), align: 'right', render: (r) => <strong>{money(r.totalMinor, r.currency)}</strong> },
                    ]}
                  />
                </div>
              ) : <p className="text-sm text-stone">{t('reports.noArrears')}</p>}
            </SectionCard>
            <CurrencyTiles items={d.fundBalance.map((f) => ({ currency: f.currency, amountMinor: f.balanceMinor }))} label={(c) => t('fund.balanceIn', { currency: c })} />
          </>
        )}
      </Async>
    </>
  );
}
type ReportsAgeing = { currency: string; totalMinor: number; invoices: number; current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number };

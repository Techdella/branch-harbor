'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, cx } from '@bh/ui';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock } from '../ui/States';
import { downloadCsv, scaleApi, useScale, type ReconRow } from './api';
import { Tiles, VendorMark, useQFmt } from './ui';

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const lastMonth = (now = new Date()) => ({ from: ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))), to: ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))) });
const FLAG_TONE: Record<string, 'danger' | 'warning' | 'neutral' | 'info'> = { variance: 'danger', missing_days: 'warning', no_report: 'warning', foreign_currency: 'warning', sandbox: 'neutral', branchharbor_payments_ignored: 'info', connector_not_source: 'info' };

/**
 * Network → Connections → Reconciliation: for each location in scope, BranchHarbor payments, every connector and the
 * self-reported periods side by side, with the source of record, variance against connector data and gaps flagged.
 * Amounts stay in each location's currency.
 */
export function ReconciliationScreen() {
  const t = useTranslations('scale');
  const app = useApp();
  const [range, setRange] = useState(lastMonth());
  const res = useScale(() => scaleApi.reconciliation(range), [app.org.id, range.from, range.to], app.hasModule('network.sales_connectors'));
  if (!app.hasModule('network.sales_connectors')) return <DeniedState />;
  return (
    <>
      <PageHeader icon="scale" title={t('recon.title')} description={t('recon.description')} scope={false}
        actions={<>
          <Link href="/sales-connectors"><Button variant="ghost" size="sm" icon="arrow-left">{t('connectors.title')}</Button></Link>
          {res.data?.can.export && <Button variant="secondary" size="sm" icon="download" onClick={() => void downloadCsv('/sales-connectors/reconciliation/export', `sales-reconciliation-${range.from}-${range.to}.csv`, range)}>{t('common.exportCsv')}</Button>}
        </>} />
      <section className="flex flex-wrap items-end gap-2 rounded-xl bg-surface p-4" aria-label={t('recon.filters')}>
        <div className="w-40"><Field label={t('common.from')}>{(x) => <Input id={x.id} type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />}</Field></div>
        <div className="w-40"><Field label={t('common.to')}>{(x) => <Input id={x.id} type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />}</Field></div>
      </section>
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.rows.length} empty={<Empty icon="scale" title={t('recon.empty')} />}>
        {(d) => {
          const flagged = d.rows.filter((r) => r.flags.includes('variance')).length;
          return (
            <>
              <Tiles items={[
                { label: t('recon.tiles.locations'), value: d.rows.length },
                { label: t('recon.tiles.connectorSource'), value: d.rows.filter((r) => r.source.source === 'connector').length },
                { label: t('recon.tiles.selfReported'), value: d.rows.filter((r) => r.source.source === 'self_reported').length },
                { label: t('recon.tiles.variances'), value: flagged, tone: flagged ? 'danger' : undefined },
              ]} />
              {flagged > 0 && <Banner tone="danger" icon="alert">{t('recon.varianceBanner', { count: flagged })}</Banner>}
              <div className="flex flex-col gap-3" data-testid="reconciliation">
                {d.rows.map((r) => <ReconCard key={r.location.id} r={r} />)}
              </div>
            </>
          );
        }}
      </Async>
    </>
  );
}

function ReconCard({ r }: { r: ReconRow }) {
  const t = useTranslations('scale');
  const f = useQFmt();
  const cur = r.location.currency;
  const isSource = (kind: string, id?: string) => r.source.source === kind && (kind !== 'connector' || r.source.connectionId === id);
  const rows: Array<{ key: string; label: React.ReactNode; gross: number; refunds: number; tax: number; net: number | null; extra: React.ReactNode; source: boolean }> = [
    { key: 'bh', label: <span className="font-bold">{t('source.branchharbor')}</span>, gross: r.branchharbor.grossMinor, refunds: r.branchharbor.refundsMinor, tax: r.branchharbor.taxMinor, net: r.branchharbor.netMinor, extra: t('recon.payments', { count: r.branchharbor.payments }), source: isSource('branchharbor') },
    ...r.connectors.map((c) => ({
      key: c.connectionId, label: <span className="inline-flex items-center gap-2 font-bold"><VendorMark provider={c.provider} size={24} />{t(`provider.${c.provider}` as 'provider.square')}</span>,
      gross: c.grossMinor, refunds: c.refundsMinor, tax: c.taxMinor, net: c.netMinor,
      extra: <span className="inline-flex flex-wrap gap-1">{c.missingDays ? <Badge tone="warning">{t('recon.missingDays', { count: c.missingDays })}</Badge> : <Badge tone="success">{t('recon.complete')}</Badge>}{c.sandbox && <Badge tone="neutral">{t('mode.sandbox')}</Badge>}</span>,
      source: isSource('connector', c.connectionId),
    })),
    ...r.selfReported.map((p) => ({
      key: p.id, label: <span className="font-bold">{t('recon.selfReportedPeriod', { from: f.shortDate(p.periodStart), to: f.shortDate(p.periodEnd) })}</span>,
      gross: p.grossMinor, refunds: p.refundsMinor, tax: p.taxMinor, net: p.grossMinor - p.refundsMinor - p.taxMinor,
      extra: p.comparison ? (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Badge tone={p.comparison.variance.flagged ? 'danger' : 'success'} icon={p.comparison.variance.flagged ? 'alert' : 'check'}>
            {p.comparison.variance.pct === null ? t('recon.varianceNa') : t('recon.variance', { pct: `${p.comparison.variance.pct > 0 ? '+' : ''}${f.num(p.comparison.variance.pct, 1)}` })}
          </Badge>
          <span className="text-xs text-stone">{t('recon.vsObserved', { amount: f.money(p.comparison.observedMinor, cur), provider: t(`provider.${p.comparison.provider}` as 'provider.square') })}</span>
        </span>
      ) : <Badge tone="neutral">{t(`reportStatus.${p.status}` as 'reportStatus.submitted')}</Badge>,
      source: r.source.source === 'self_reported',
    })),
  ];
  return (
    <section className="rounded-xl bg-surface p-4" aria-label={r.location.name}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-[17px] font-bold">{r.location.name}</h2>
        <span className="text-xs text-stone">{r.location.code} · {cur}{r.location.ownerGroupName ? ` · ${r.location.ownerGroupName}` : ''}</span>
        <span className="ml-auto flex flex-wrap gap-1">{r.flags.map((fl) => <Badge key={fl} tone={FLAG_TONE[fl] ?? 'neutral'}>{t(`flag.${fl}` as 'flag.variance')}</Badge>)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line-soft text-left text-xs font-extrabold uppercase tracking-[0.06em] text-stone">
              <th scope="col" className="px-2 py-2">{t('recon.col.data')}</th>
              <th scope="col" className="px-2 py-2 text-right">{t('recon.col.gross')}</th>
              <th scope="col" className="px-2 py-2 text-right">{t('recon.col.refunds')}</th>
              <th scope="col" className="px-2 py-2 text-right">{t('recon.col.tax')}</th>
              <th scope="col" className="px-2 py-2 text-right">{t('recon.col.net')}</th>
              <th scope="col" className="px-2 py-2">{t('recon.col.check')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.key} className={cx('border-b border-line-soft last:border-0', x.source && 'bg-lime/25')}>
                <td className="px-2 py-2.5">{x.label}{x.source && <span className="ml-2"><Badge tone="signal">{t('source.ofRecord')}</Badge></span>}</td>
                <td className="tabular px-2 py-2.5 text-right">{f.money(x.gross, cur)}</td>
                <td className="tabular px-2 py-2.5 text-right">{f.money(x.refunds, cur)}</td>
                <td className="tabular px-2 py-2.5 text-right">{f.money(x.tax, cur)}</td>
                <td className="tabular px-2 py-2.5 text-right font-bold">{x.net === null ? '—' : f.money(x.net, cur)}</td>
                <td className="px-2 py-2.5">{x.extra}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

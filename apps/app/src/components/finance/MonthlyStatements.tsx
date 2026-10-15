'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Select } from '@bh/ui';
import { http } from '@/lib/http/client';
import { orgId } from '@/lib/http/workspace';
import { useApp } from '../shell/AppContext';
import { Async, Banner, Empty, LoadingBlock } from '../ui/States';
import { downloadFile, financeApi, useFinance, useFinanceAction } from './api';
import { ActionError, useDate, useMoney, usePeriodLabel } from './FinanceUi';

interface Line {
  locationId: string; locationName: string; salesSource: 'branchharbor' | 'external_pos' | 'mixed' | 'none'; grossSalesMinor: number; basisMinor: number; royaltyRateBps: number | null; royaltyMinor: number;
  marketingFundRateBps: number | null; marketingFundMinor: number; technologyFeeMinor: number; adjustmentsMinor: number; taxMinor: number; lateFeeMinor: number; totalMinor: number;
  invoiceNumber: string | null; invoiceStatus: string | null; dueDate: string | null; collectionMethod: string | null; collectionStatus: string | null; collectionDate: string | null; collectedMinor: number; collectionFeeMinor: number;
}
interface StatementVM {
  id: string; number: string; period: { startDate: string; endDate: string; frequency: string } | null; ownerGroup: { id: string; name: string | null; legalName: string | null }; currency: string; lines: Line[];
  grossSalesMinor: number; royaltyMinor: number; marketingFundMinor: number; adjustmentsMinor: number; feesMinor: number; taxMinor: number; totalMinor: number; collectedMinor: number; collectionFeeMinor: number;
  paymentMethod: { methodType: string; last4?: string | null; bankName?: string | null } | null; issuedAt: string; emailedAt: string | null; emailedTo: number;
}

const base = (p: string) => `/orgs/${orgId()}/finance${p}`;
const api = {
  list: () => http.get<{ items: StatementVM[] }>(base('/franchisee-statements')),
  issue: (periodId: string) => http.post<{ items: StatementVM[]; emailed: number }>(base(`/periods/${periodId}/franchisee-statements`)),
};

/**
 * Monthly royalty statements per franchisee: per-location lines (gross sales and their source, rate, royalty, fund,
 * adjustments, fees and tax, amount, collection method, status and date) with the PDF. HQ issues them per period (the
 * franchise owners are emailed); franchise owners see only their own.
 */
export function MonthlyStatements() {
  const t = useTranslations('royaltyDebit.statements');
  const app = useApp();
  const money = useMoney();
  const period = usePeriodLabel();
  const params = useSearchParams();
  const res = useFinance(() => api.list(), [app.org.id]);
  const hq = app.capabilities.has('finance.royalties:publish');
  const periods = useFinance(() => financeApi.periods(), [app.org.id], hq);
  const [periodId, setPeriodId] = useState('');
  const [open, setOpen] = useState<string | null>(params.get('statement'));
  const [msg, setMsg] = useState<string | null>(null);
  const issue = useFinanceAction(async () => { const r = await api.issue(periodId); setMsg(t('issued', { n: r.items.length, emailed: r.emailed })); res.reload(); });
  useEffect(() => { if (!periodId && periods.data?.items[0]) setPeriodId(periods.data.items[0].id); }, [periods.data, periodId]);
  return (
    <>
      {hq && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl bg-surface p-4">
          <Field label={t('period')}>{(p) => (
            <Select id={p.id} value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
              {(periods.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{period(x)}</option>)}
            </Select>
          )}</Field>
          <Button icon="send" loading={issue.pending} disabled={!periodId} onClick={() => void issue.run()}>{t('issue')}</Button>
          <p className="basis-full text-xs text-stone">{t('issueHint')}</p>
        </div>
      )}
      <ActionError error={issue.error} />
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="file" title={t('empty')} body={t('emptyBody')} />}>
        {(d) => (
          <>
            <section className="overflow-x-auto rounded-xl bg-surface p-3.5" data-testid="monthly-statements">
              <DataTable<StatementVM>
                rows={d.items}
                rowKey={(s) => s.id}
                onRowClick={(s) => setOpen(s.id)}
                rowLabel={(s) => s.number}
                columns={[
                  { key: 'p', header: t('period'), render: (s) => <span><strong>{period(s.period)}</strong><span className="block font-mono text-xs text-stone">{s.number}</span></span> },
                  { key: 'g', header: t('franchisee'), render: (s) => s.ownerGroup.name },
                  { key: 'gross', header: t('gross'), align: 'right', render: (s) => money(s.grossSalesMinor, s.currency) },
                  { key: 'total', header: t('total'), align: 'right', render: (s) => <strong>{money(s.totalMinor, s.currency)}</strong> },
                  { key: 'col', header: t('collected'), align: 'right', render: (s) => <span className="inline-flex items-center gap-2">{money(s.collectedMinor, s.currency)}<Badge tone={s.collectedMinor >= s.totalMinor ? 'success' : 'warning'}>{s.collectedMinor >= s.totalMinor ? t('paid') : t('outstanding')}</Badge></span> },
                ]}
              />
            </section>
            <StatementDetail s={d.items.find((x) => x.id === open) ?? null} onClose={() => setOpen(null)} />
          </>
        )}
      </Async>
    </>
  );
}

function StatementDetail({ s, onClose }: { s: StatementVM | null; onClose: () => void }) {
  const t = useTranslations('royaltyDebit.statements');
  const td = useTranslations('royaltyDebit');
  const money = useMoney();
  const date = useDate();
  const period = usePeriodLabel();
  const [pending, setPending] = useState(false);
  const pct = (bps: number | null) => (bps === null ? '—' : `${(bps / 100).toFixed(2)}%`);
  return (
    <Drawer open={!!s} onClose={onClose} title={s ? `${period(s.period)} · ${s.ownerGroup.name ?? ''}` : ''} kicker={s?.number}
      footer={s ? <Button variant="secondary" icon="download" loading={pending} onClick={async () => { setPending(true); try { await downloadFile(`/franchisee-statements/${s.id}/pdf`, `${s.number}.pdf`); } finally { setPending(false); } }}>{t('pdf')}</Button> : undefined}>
      {s && (
        <div className="flex flex-col gap-4" data-testid="statement-detail">
          {s.lines.map((l) => (
            <section key={l.locationId} className="rounded-lg bg-canvas p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><strong>{l.locationName}</strong><Badge tone="neutral">{t(`source.${l.salesSource}`)}</Badge></div>
              <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
                <dt>{t('gross')}</dt><dd className="tabular text-right">{money(l.grossSalesMinor, s.currency)}</dd>
                <dt>{t('royaltyAt', { rate: pct(l.royaltyRateBps) })}</dt><dd className="tabular text-right">{money(l.royaltyMinor, s.currency)}</dd>
                <dt>{t('fundAt', { rate: pct(l.marketingFundRateBps) })}</dt><dd className="tabular text-right">{money(l.marketingFundMinor, s.currency)}</dd>
                <dt>{t('adjustments')}</dt><dd className="tabular text-right">{money(l.adjustmentsMinor, s.currency)}</dd>
                <dt>{t('feesTax')}</dt><dd className="tabular text-right">{money(l.technologyFeeMinor + l.lateFeeMinor + l.taxMinor, s.currency)}</dd>
                <dt className="font-bold">{t('amount')}</dt><dd className="tabular text-right font-bold">{money(l.totalMinor, s.currency)}</dd>
                <dt>{t('collection')}</dt>
                <dd className="text-right">{l.collectionStatus ? `${l.collectionMethod ? td(`type.${l.collectionMethod}`) : ''} · ${t(`status.${l.collectionStatus}`)}${l.collectionDate ? ` · ${date(l.collectionDate)}` : ''}` : t('notCollected')}</dd>
                <dt className="text-stone">{t('collectionFee')}</dt><dd className="tabular text-right text-stone">{money(l.collectionFeeMinor, s.currency)}</dd>
              </dl>
              {l.invoiceNumber && <p className="mt-2 text-xs text-stone">{t('invoice', { number: l.invoiceNumber, due: date(l.dueDate) })}</p>}
            </section>
          ))}
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            <dt>{t('royalty')}</dt><dd className="tabular text-right">{money(s.royaltyMinor, s.currency)}</dd>
            <dt>{t('fund')}</dt><dd className="tabular text-right">{money(s.marketingFundMinor, s.currency)}</dd>
            <dt>{t('adjustments')}</dt><dd className="tabular text-right">{money(s.adjustmentsMinor, s.currency)}</dd>
            <dt>{t('feesTax')}</dt><dd className="tabular text-right">{money(s.feesMinor + s.taxMinor, s.currency)}</dd>
            <dt className="font-bold">{t('total')}</dt><dd className="tabular text-right font-bold">{money(s.totalMinor, s.currency)}</dd>
            <dt>{t('collected')}</dt><dd className="tabular text-right">{money(s.collectedMinor, s.currency)}</dd>
          </dl>
          <Banner tone="neutral" icon="info">{t('feeNote', { fee: money(s.collectionFeeMinor, s.currency) })}</Banner>
          {s.paymentMethod && <p className="text-xs text-stone">{t('method', { method: td(`type.${s.paymentMethod.methodType}`), last4: s.paymentMethod.last4 ?? '••••' })}</p>}
          <p className="text-xs text-stone">{s.emailedAt ? t('emailed', { n: s.emailedTo, at: date(s.emailedAt) }) : t('notEmailed')}</p>
        </div>
      )}
    </Drawer>
  );
}

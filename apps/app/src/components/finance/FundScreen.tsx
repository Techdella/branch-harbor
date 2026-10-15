'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Field, Input, Select } from '@bh/ui';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { downloadFile, financeApi, readUpload, useFinance, useFinanceAction, type FundEntryVM } from './api';
import { ActionError, CurrencyTiles, PillTabs, toMinor, useDate, useMoney } from './FinanceUi';

type Tab = 'report' | 'ledger' | 'spend';

/** Marketing fund: transparency report (franchisees with access), the ledger, and HQ spend with receipts. */
export function FundScreen() {
  const t = useTranslations('finance');
  const app = useApp();
  const [tab, setTab] = useState<Tab>('report');
  if (!app.hasModule('finance.marketing_fund')) return <DeniedState />;
  const hqEdit = app.capabilities.has('finance.marketing_fund:edit') && app.capabilities.has('finance.royalties:view');
  const tabs: Array<[Tab, string]> = [['report', t('fund.tab.report')], ['ledger', t('fund.tab.ledger')], ...(hqEdit ? ([['spend', t('fund.tab.spend')]] as Array<[Tab, string]>) : [])];
  return (
    <>
      <PageHeader icon="megaphone" title={t('fund.title')} description={t('fund.description')} scope={false} />
      <PillTabs items={tabs} value={tab} onChange={setTab} />
      {tab === 'ledger' ? <Ledger /> : tab === 'spend' && hqEdit ? <Spend /> : <Transparency />}
    </>
  );
}

function Transparency() {
  const t = useTranslations('finance');
  const money = useMoney();
  const thisYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(thisYear);
  const res = useFinance(() => financeApi.transparency(year), [year]);
  const dl = useFinanceAction(() => downloadFile('/fund/annual-statement', `marketing_fund_${year}.csv`, { year }));
  return (
    <>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('fund.year')}>{(p) => (
          <Select id={p.id} value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}
          </Select>
        )}</Field>
        <Button variant="secondary" size="sm" icon="download" loading={dl.pending} onClick={() => void dl.run()}>{t('fund.annualStatement')}</Button>
      </div>
      <ActionError error={dl.error} />
      <Async res={res} loading={<LoadingBlock />} isEmpty={(d) => d.currencies.length === 0} empty={<Empty icon="megaphone" title={t('fund.empty')} />}>
        {(d) => (
          <div className="grid gap-3 lg:grid-cols-2" data-testid="fund-report">
            {d.currencies.map((c) => (
              <SectionCard key={c.currency} title={t('fund.reportTitle', { currency: c.currency, year: d.year })}>
                <dl className="grid grid-cols-2 gap-y-1 text-sm">
                  <dt className="text-stone">{t('fund.opening')}</dt><dd className="text-right">{money(c.openingBalanceMinor, c.currency)}</dd>
                  <dt className="text-stone">{t('fund.contributions', { count: c.contributorCount })}</dt><dd className="text-right">{money(c.contributionsMinor, c.currency)}</dd>
                  <dt className="text-stone">{t('fund.spend')}</dt><dd className="text-right">{money(-c.spendMinor, c.currency)}</dd>
                  {c.adjustmentsMinor !== 0 && <><dt className="text-stone">{t('fund.adjustments')}</dt><dd className="text-right">{money(c.adjustmentsMinor, c.currency)}</dd></>}
                  <dt className="font-bold">{t('fund.closing')}</dt><dd className="text-right font-bold">{money(c.closingBalanceMinor, c.currency)}</dd>
                  <dt className="text-stone">{t('fund.yours')}</dt><dd className="text-right">{money(c.yourContributionsMinor, c.currency)}</dd>
                </dl>
                {c.spendByCampaign.length > 0 && (
                  <div className="mt-3">
                    <h3 className="text-sm font-bold">{t('fund.byCampaign')}</h3>
                    {c.spendByCampaign.map((x) => (
                      <div key={x.campaignId ?? 'none'} className="flex justify-between border-b border-line py-1 text-sm"><span>{x.name ?? t('fund.unallocated')}</span><span>{money(x.amountMinor, c.currency)}</span></div>
                    ))}
                  </div>
                )}
              </SectionCard>
            ))}
          </div>
        )}
      </Async>
    </>
  );
}

function Ledger() {
  const t = useTranslations('finance');
  const money = useMoney();
  const date = useDate();
  const res = useFinance(() => financeApi.ledger(), []);
  return (
    <Async res={res} loading={<LoadingBlock variant="table" />}>
      {(d) => (
        <>
          <CurrencyTiles items={d.balances.map((b) => ({ currency: b.currency, amountMinor: b.balanceMinor }))} label={(c) => t('fund.balanceIn', { currency: c })} />
          {d.items.length === 0 ? <Empty icon="megaphone" title={t('fund.empty')} /> : (
            <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
              <DataTable<FundEntryVM>
                rows={d.items}
                rowKey={(e) => e.id}
                columns={[
                  { key: 'd', header: t('col.date'), render: (e) => date(e.occurredOn) },
                  { key: 'k', header: t('col.kind'), render: (e) => <Badge tone={e.kind === 'contribution' ? 'success' : e.kind === 'spend' ? 'info' : 'neutral'}>{t(`fund.kind.${e.kind}`)}</Badge> },
                  { key: 'w', header: t('col.description'), render: (e) => <span>{e.kind === 'contribution' ? t('fund.contributionFrom', { who: e.ownerGroup?.name ?? e.location?.name ?? '' }) : e.description}{e.campaign && <span className="block text-xs text-stone">{e.campaign.name}{e.vendor ? ` · ${e.vendor}` : ''}</span>}</span> },
                  { key: 'a', header: t('col.amount'), align: 'right', render: (e) => <strong>{money(e.amountMinor, e.currency)}</strong> },
                  { key: 'r', header: t('col.receipt'), render: (e) => (e.receiptDocumentId ? <Button size="sm" variant="ghost" icon="download" onClick={() => void downloadFile(`/documents/${e.receiptDocumentId}`, `receipt-${e.occurredOn}.pdf`)}>{t('fund.receipt')}</Button> : '') },
                ]}
              />
            </section>
          )}
        </>
      )}
    </Async>
  );
}

function Spend() {
  const t = useTranslations('finance');
  const app = useApp();
  const campaigns = useFinance(() => financeApi.campaigns(), []);
  const [currency, setCurrency] = useState(app.org.defaultCurrency as string);
  const [amount, setAmount] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [desc, setDesc] = useState('');
  const [vendor, setVendor] = useState('');
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState('');
  const spend = useFinanceAction(async () => {
    await financeApi.recordSpend({ currency, amountMinor: toMinor(amount) ?? 0, campaignId: campaignId || campaigns.data!.items[0]!.id, description: desc, vendor, occurredOn: on, receipt: await readUpload(file!) });
    setMsg(t('fund.spendRecorded'));
    setAmount('');
    setDesc('');
    setFile(null);
  });
  return (
    <>
      <SectionCard title={t('fund.spendTitle')}>
        <p className="mb-3 text-sm text-stone">{t('fund.spendHint')} {t('fund.campaignsFromMarketing')}</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('fund.campaign')}>{(p) => (
            <Select id={p.id} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              {(campaigns.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}</Field>
          <Field label={t('terms.currency')}>{(p) => <Input id={p.id} maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />}</Field>
          <Field label={t('col.amount')}>{(p) => <Input id={p.id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label={t('col.description')}>{(p) => <Input id={p.id} value={desc} onChange={(e) => setDesc(e.target.value)} />}</Field>
          <Field label={t('fund.vendor')} optional>{(p) => <Input id={p.id} value={vendor} onChange={(e) => setVendor(e.target.value)} />}</Field>
          <Field label={t('col.date')}>{(p) => <Input id={p.id} type="date" value={on} onChange={(e) => setOn(e.target.value)} />}</Field>
          <Field label={t('fund.receiptFile')} hint={t('sales.evidenceHint')}>{(p) => <Input id={p.id} type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</Field>
        </div>
        <ActionError error={spend.error} />
        {msg && <Banner tone="success" live="polite">{msg}</Banner>}
        <div className="mt-3"><Button loading={spend.pending} disabled={!file || !toMinor(amount) || desc.trim().length < 2 || !(campaigns.data?.items.length)} onClick={() => void spend.run()}>{t('fund.recordSpend')}</Button></div>
      </SectionCard>
    </>
  );
}

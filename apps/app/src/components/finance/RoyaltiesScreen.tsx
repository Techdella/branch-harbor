'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Field, Input, Select, Toggle } from '@bh/ui';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { downloadFile, financeApi, useFinance, useFinanceAction, type ExternalSalesVM, type InvoiceVM, type SettingsVM, type StatementVM, type TermsInput, type TermsVM } from './api';
import { InvoiceDrawer, StatementDrawer } from './Drawers';
import { ActionError, CurrencyTiles, InvoiceBadge, PillTabs, SandboxNote, StatementBadge, toMinor, useDate, useMoney, usePeriodLabel } from './FinanceUi';

type Tab = 'statements' | 'invoices' | 'sales' | 'terms' | 'settings';

/** HQ royalties: period close, statements, approval, invoicing and collection, sales reports, terms and settings. */
export function RoyaltiesScreen() {
  const t = useTranslations('finance');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'statements';
  if (!app.hasModule('finance.royalties')) return <DeniedState />;
  const edit = app.capabilities.has('finance.royalties:edit');
  const tabs: Array<[Tab, string]> = [
    ['statements', t('royalties.tab.statements')],
    ['invoices', t('royalties.tab.invoices')],
    ['sales', t('royalties.tab.sales')],
    ['terms', t('royalties.tab.terms')],
    ...(edit ? [['settings', t('royalties.tab.settings')] as [Tab, string]] : []),
  ];
  return (
    <>
      <PageHeader icon="receipt" title={t('royalties.title')} description={t('royalties.description')} scope={false} />
      <PillTabs items={tabs} value={tab} onChange={(k) => router.replace(`?tab=${k}`, { scroll: false })} />
      {tab === 'invoices' ? <InvoicesTab /> : tab === 'sales' ? <SalesReviewTab /> : tab === 'terms' ? <TermsTab /> : tab === 'settings' && edit ? <SettingsTab /> : <StatementsTab />}
    </>
  );
}

function StatementsTab() {
  const t = useTranslations('finance');
  const app = useApp();
  const money = useMoney();
  const period = usePeriodLabel();
  const edit = app.capabilities.has('finance.royalties:edit');
  const publish = app.capabilities.has('finance.royalties:publish');
  const periods = useFinance(() => financeApi.periods(), [app.org.id]);
  const [periodId, setPeriodId] = useState<string>('');
  const [closeDate, setCloseDate] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const selected = periodId || periods.data?.items[0]?.id || '';
  const list = useFinance(() => financeApi.statements({ periodId: selected }), [selected], !!selected);
  const act = useFinanceAction(async (fn: () => Promise<string>) => {
    setMessage(await fn());
    periods.reload();
    list.reload();
  });
  const close = () => act.run(async () => {
    const r = await financeApi.closePeriod(closeDate || periods.data!.suggestedClose.startDate);
    setPeriodId(r.period.id);
    return r.missingTerms.length ? t('royalties.closedMissing', { count: r.statements, missing: r.missingTerms.length }) : t('royalties.closed', { count: r.statements });
  });
  return (
    <Async res={periods} loading={<LoadingBlock variant="table" />}>
      {(p) => (
        <>
          {edit && (
            <SectionCard title={t('royalties.closeTitle')}>
              <p className="mb-3 text-sm text-stone">{t('royalties.closeHint', { frequency: t(`frequency.${p.frequency}`) })}</p>
              <div className="flex flex-wrap items-end gap-2">
                <Field label={t('royalties.periodStart')}>{(f) => <Input id={f.id} type="date" value={closeDate || p.suggestedClose.startDate} onChange={(e) => setCloseDate(e.target.value)} data-testid="close-period-date" />}</Field>
                <Button icon="check" loading={act.pending} onClick={() => void close()} data-testid="close-period">{t('royalties.closePeriod')}</Button>
              </div>
            </SectionCard>
          )}
          <ActionError error={act.error} />
          {message && <Banner tone="success" live="polite">{message}</Banner>}
          {p.items.length === 0 ? <Empty icon="receipt" title={t('royalties.noPeriods')} body={t('royalties.noPeriodsBody')} /> : (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <Field label={t('royalties.period')}>
                  {(f) => (
                    <Select id={f.id} value={selected} onChange={(e) => setPeriodId(e.target.value)} data-testid="period-select">
                      {p.items.map((x) => <option key={x.id} value={x.id}>{period(x)}</option>)}
                    </Select>
                  )}
                </Field>
                {publish && <Button variant="secondary" icon="receipt" loading={act.pending} onClick={() => void act.run(async () => { const r = await financeApi.invoiceApproved(selected); return t('royalties.invoicedAll', { count: r.issued }); })}>{t('royalties.invoiceApproved')}</Button>}
                <Button variant="ghost" size="sm" icon="download" onClick={() => { const x = p.items.find((i) => i.id === selected); void act.run(async () => { await downloadFile('/exports/statements', `statements_${x?.startDate ?? ''}.csv`, { from: x?.startDate, to: x?.endDate }); return ''; }); }}>{t('common.exportCsv')}</Button>
              </div>
              <Async res={list} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="receipt" title={t('royalties.noStatements')} />}>
                {(d) => (
                  <>
                    <CurrencyTiles items={totals(d.items)} label={(c) => t('royalties.dueIn', { currency: c })} sub={(c) => t('royalties.statementCount', { count: d.items.filter((s) => s.currency === c).length })} />
                    <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
                      <DataTable<StatementVM>
                        rows={d.items}
                        rowKey={(s) => s.id}
                        onRowClick={(s) => setOpen(s.id)}
                        rowLabel={(s) => s.location.name ?? ''}
                        columns={[
                          { key: 'loc', header: t('col.location'), render: (s) => <span><strong>{s.location.name}</strong><span className="block text-xs text-stone">{s.ownerGroup?.name}</span></span> },
                          { key: 'gross', header: t('col.grossSales'), align: 'right', render: (s) => money(s.grossSalesMinor, s.currency) },
                          { key: 'basis', header: t('col.basis'), align: 'right', render: (s) => money(s.basisMinor, s.currency) },
                          { key: 'roy', header: t('col.royalty'), align: 'right', render: (s) => money(s.royaltyMinor, s.currency) },
                          { key: 'fund', header: t('col.fund'), align: 'right', render: (s) => money(s.marketingFundMinor, s.currency) },
                          { key: 'total', header: t('col.total'), align: 'right', render: (s) => <strong>{money(s.totalMinor, s.currency)}</strong> },
                          { key: 'st', header: t('col.status'), render: (s) => <span className="flex flex-wrap gap-1"><StatementBadge status={s.status} />{s.invoice && <InvoiceBadge state={s.invoice.status} />}{s.warnings.length > 0 && <Badge tone="warning" icon="alert">{t('royalties.warnings', { count: s.warnings.length })}</Badge>}</span> },
                        ]}
                      />
                    </section>
                  </>
                )}
              </Async>
            </>
          )}
          <StatementDrawer id={open} onClose={() => setOpen(null)} onChanged={list.reload} hq={{ edit, publish }} />
        </>
      )}
    </Async>
  );
}

const totals = (items: Array<{ currency: string; totalMinor: number }>) => {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.currency, (m.get(i.currency) ?? 0) + i.totalMinor);
  return [...m.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor }));
};

function InvoicesTab() {
  const t = useTranslations('finance');
  const app = useApp();
  const money = useMoney();
  const date = useDate();
  const edit = app.capabilities.has('finance.royalties:edit');
  const res = useFinance(() => financeApi.invoices(), [app.org.id]);
  const overview = useFinance(() => financeApi.overview(), [app.org.id]);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const dunning = useFinanceAction(async () => {
    const r = await financeApi.runDunning();
    setMsg(t('royalties.dunningDone', { reminders: r.reminders, lateFees: r.lateFees, retries: r.retries, notices: r.finalNotices }));
    res.reload();
  });
  return (
    <>
      {overview.data?.sandbox && <SandboxNote />}
      {overview.data && <CurrencyTiles items={overview.data.receivables.map((r) => ({ currency: r.currency, amountMinor: r.openMinor }))} label={(c) => t('royalties.receivable', { currency: c })} sub={(c) => { const r = overview.data!.receivables.find((x) => x.currency === c)!; return r.overdue ? t('royalties.overdueSub', { count: r.overdue, amount: money(r.overdueMinor, c) }) : t('royalties.noneOverdue'); }} />}
      <div className="flex flex-wrap gap-2">
        {edit && <Button variant="secondary" icon="clock" loading={dunning.pending} onClick={() => void dunning.run()} data-testid="run-dunning">{t('royalties.runDunning')}</Button>}
        <Button variant="ghost" size="sm" icon="download" onClick={() => void downloadFile('/exports/invoices', 'invoices.csv')}>{t('common.exportCsv')}</Button>
        <Button variant="ghost" size="sm" icon="download" onClick={() => void downloadFile('/exports/invoices', 'invoices_xero.csv', { format: 'xero' })}>{t('common.exportXero')}</Button>
        <Button variant="ghost" size="sm" icon="download" onClick={() => void downloadFile('/exports/invoices', 'invoices_quickbooks.csv', { format: 'quickbooks' })}>{t('common.exportQuickbooks')}</Button>
      </div>
      <ActionError error={dunning.error} />
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="receipt" title={t('invoices.empty')} />}>
        {(d) => (
          <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
            <DataTable<InvoiceVM>
              rows={d.items}
              rowKey={(i) => i.id}
              onRowClick={(i) => setOpen(i.id)}
              rowLabel={(i) => i.number}
              columns={[
                { key: 'no', header: t('col.invoice'), render: (i) => <span><strong className="font-mono text-[13px]">{i.number}</strong><span className="block text-xs text-stone">{date(i.issueDate)}</span></span> },
                { key: 'who', header: t('col.franchisee'), render: (i) => <span>{i.ownerGroup?.name}<span className="block text-xs text-stone">{i.location.name}</span></span> },
                { key: 'due', header: t('col.due'), render: (i) => date(i.dueDate) },
                { key: 'total', header: t('col.total'), align: 'right', render: (i) => money(i.totalMinor, i.currency) },
                { key: 'out', header: t('col.outstanding'), align: 'right', render: (i) => <strong>{money(i.outstandingMinor, i.currency)}</strong> },
                { key: 'st', header: t('col.status'), render: (i) => <InvoiceBadge state={i.state} /> },
              ]}
            />
          </section>
        )}
      </Async>
      <InvoiceDrawer id={open} onClose={() => setOpen(null)} onChanged={res.reload} hq={edit} canPay={false} sandbox={!!overview.data?.sandbox} />
    </>
  );
}

function SalesReviewTab() {
  const t = useTranslations('finance');
  const app = useApp();
  const money = useMoney();
  const date = useDate();
  const edit = app.capabilities.has('finance.royalties:edit');
  const res = useFinance(() => financeApi.externalSales(), [app.org.id]);
  const act = useFinanceAction(async (id: string, decision: 'accepted' | 'rejected') => {
    await financeApi.reviewExternalSales(id, decision);
    res.reload();
  });
  return (
    <>
      <p className="text-sm text-stone">{t('sales.hqHint')}</p>
      <ActionError error={act.error} />
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="file" title={t('sales.empty')} />}>
        {(d) => (
          <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
            <DataTable<ExternalSalesVM>
              rows={d.items}
              rowKey={(r) => r.id}
              columns={[
                { key: 'loc', header: t('col.location'), render: (r) => <span><strong>{r.location.name}</strong><span className="block text-xs text-stone">{date(r.periodStart)}</span></span> },
                { key: 'gross', header: t('col.grossSales'), align: 'right', render: (r) => money(r.grossMinor, r.currency) },
                { key: 'ref', header: t('col.refunds'), align: 'right', render: (r) => money(r.refundsMinor, r.currency) },
                { key: 'tax', header: t('col.tax'), align: 'right', render: (r) => money(r.taxMinor, r.currency) },
                { key: 'ev', header: t('col.evidence'), render: (r) => <Button size="sm" variant="ghost" icon="download" onClick={() => void downloadFile(`/documents/${r.evidenceDocumentId}`, `evidence-${r.periodStart}`)}>{t('sales.evidence')}</Button> },
                { key: 'st', header: t('col.status'), render: (r) => r.status === 'submitted' && edit ? (
                  <span className="flex gap-1">
                    <Button size="sm" loading={act.pending} onClick={() => void act.run(r.id, 'accepted')}>{t('sales.accept')}</Button>
                    <Button size="sm" variant="secondary" loading={act.pending} onClick={() => void act.run(r.id, 'rejected')}>{t('sales.reject')}</Button>
                  </span>
                ) : <Badge tone={r.status === 'accepted' ? 'success' : r.status === 'rejected' ? 'danger' : 'warning'}>{t(`sales.status.${r.status}`)}</Badge> },
              ]}
            />
          </section>
        )}
      </Async>
    </>
  );
}

const STREAMS = ['bookings', 'memberships', 'retail', 'food', 'gift_vouchers', 'other'];
const bpsOf = (s: string) => { const n = Number(s.replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const pctOf = (bps: number) => String(bps / 100);
const majorOf = (minor: number) => (minor / 100).toFixed(2);

function emptyTerms(currency: string): TermsInput {
  return {
    ownerGroupId: null, currency, effectiveFrom: new Date().toISOString().slice(0, 8) + '01', effectiveTo: null, royaltyBps: 600, tiers: [], tierMode: 'marginal', minimumRoyaltyMinor: 0,
    marketingFundBps: 200, technologyFeeMinor: 0, basis: { streams: ['bookings', 'memberships', 'retail', 'food', 'other'], netOfRefunds: true, excludeTax: true, excludeTips: true, includeExternalSales: true },
    lateFee: { kind: 'none', graceDays: 0 },
  };
}

function TermsTab() {
  const t = useTranslations('finance');
  const app = useApp();
  const money = useMoney();
  const date = useDate();
  const edit = app.capabilities.has('finance.royalties:edit');
  const res = useFinance(() => financeApi.terms(), [app.org.id]);
  const [form, setForm] = useState<{ id: string | null; v: TermsInput; royalty: string; fund: string; tech: string; min: string; fee: string; tiers: Array<{ from: string; rate: string }> } | null>(null);
  const save = useFinanceAction(async () => {
    const f = form!;
    const body: TermsInput = {
      ...f.v, royaltyBps: bpsOf(f.royalty), marketingFundBps: bpsOf(f.fund), technologyFeeMinor: toMinor(f.tech || '0') ?? 0, minimumRoyaltyMinor: toMinor(f.min || '0') ?? 0,
      tiers: f.tiers.filter((x) => x.from && x.rate).map((x) => ({ fromMinor: toMinor(x.from) ?? 0, bps: bpsOf(x.rate) })),
      lateFee: f.v.lateFee.kind === 'flat' ? { ...f.v.lateFee, flatMinor: toMinor(f.fee) ?? 0 } : f.v.lateFee.kind === 'percent' ? { ...f.v.lateFee, bps: bpsOf(f.fee) } : { kind: 'none', graceDays: f.v.lateFee.graceDays },
    };
    if (f.id) await financeApi.updateTerms(f.id, body);
    else await financeApi.createTerms(body);
    setForm(null);
    res.reload();
  });
  const startEdit = (x?: TermsVM) => {
    const v: TermsInput = x ? { ...x, tierMode: x.tierMode === 'whole' ? 'whole' : 'marginal' } : emptyTerms(app.org.defaultCurrency);
    setForm({ id: x?.id ?? null, v, royalty: pctOf(v.royaltyBps), fund: pctOf(v.marketingFundBps), tech: majorOf(v.technologyFeeMinor), min: majorOf(v.minimumRoyaltyMinor), fee: v.lateFee.kind === 'flat' ? majorOf(v.lateFee.flatMinor ?? 0) : v.lateFee.kind === 'percent' ? pctOf(v.lateFee.bps ?? 0) : '', tiers: v.tiers.map((x) => ({ from: majorOf(x.fromMinor), rate: pctOf(x.bps) })) });
  };
  const set = (patch: Partial<TermsInput>) => setForm((f) => (f ? { ...f, v: { ...f.v, ...patch } } : f));
  return (
    <Async res={res} loading={<LoadingBlock variant="table" />}>
      {(d) => (
        <>
          <p className="text-sm text-stone">{t('terms.hint')}</p>
          {edit && !form && <div><Button icon="plus" onClick={() => startEdit()} data-testid="add-terms">{t('terms.add')}</Button></div>}
          {form && (
            <SectionCard title={form.id ? t('terms.editTitle') : t('terms.addTitle')}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label={t('terms.appliesTo')}>{(p) => (
                  <Select id={p.id} value={form.v.ownerGroupId ?? ''} onChange={(e) => set({ ownerGroupId: e.target.value || null })}>
                    <option value="">{t('terms.orgDefault')}</option>
                    {d.ownerGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </Select>
                )}</Field>
                <Field label={t('terms.currency')}>{(p) => <Input id={p.id} maxLength={3} value={form.v.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />}</Field>
                <Field label={t('terms.effectiveFrom')}>{(p) => <Input id={p.id} type="date" value={form.v.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} />}</Field>
                <Field label={t('terms.effectiveTo')} optional>{(p) => <Input id={p.id} type="date" value={form.v.effectiveTo ?? ''} onChange={(e) => set({ effectiveTo: e.target.value || null })} />}</Field>
                <Field label={t('terms.royaltyPct')}>{(p) => <Input id={p.id} inputMode="decimal" value={form.royalty} onChange={(e) => setForm({ ...form, royalty: e.target.value })} />}</Field>
                <Field label={t('terms.fundPct')}>{(p) => <Input id={p.id} inputMode="decimal" value={form.fund} onChange={(e) => setForm({ ...form, fund: e.target.value })} />}</Field>
                <Field label={t('terms.techFee', { currency: form.v.currency })} hint={t('terms.techFeeHint')}>{(p) => <Input id={p.id} inputMode="decimal" value={form.tech} onChange={(e) => setForm({ ...form, tech: e.target.value })} />}</Field>
                <Field label={t('terms.minimum', { currency: form.v.currency })} hint={t('terms.minimumHint')}>{(p) => <Input id={p.id} inputMode="decimal" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} />}</Field>
                <Field label={t('terms.tierMode')}>{(p) => (
                  <Select id={p.id} value={form.v.tierMode} onChange={(e) => set({ tierMode: e.target.value as 'marginal' | 'whole' })}>
                    <option value="marginal">{t('terms.tierMarginal')}</option>
                    <option value="whole">{t('terms.tierWhole')}</option>
                  </Select>
                )}</Field>
              </div>
              <div className="mt-3 flex flex-col gap-2">
                <div className="text-sm font-bold">{t('terms.tiers')}</div>
                {form.tiers.map((x, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <Field label={t('terms.tierFrom', { currency: form.v.currency })}>{(p) => <Input id={p.id} inputMode="decimal" value={x.from} onChange={(e) => setForm({ ...form, tiers: form.tiers.map((y, j) => (j === i ? { ...y, from: e.target.value } : y)) })} />}</Field>
                    <Field label={t('terms.tierRate')}>{(p) => <Input id={p.id} inputMode="decimal" value={x.rate} onChange={(e) => setForm({ ...form, tiers: form.tiers.map((y, j) => (j === i ? { ...y, rate: e.target.value } : y)) })} />}</Field>
                    <Button size="sm" variant="ghost" icon="x" onClick={() => setForm({ ...form, tiers: form.tiers.filter((_, j) => j !== i) })}>{t('terms.removeTier')}</Button>
                  </div>
                ))}
                {form.tiers.length < 5 && <div><Button size="sm" variant="ghost" icon="plus" onClick={() => setForm({ ...form, tiers: [...form.tiers, { from: '', rate: '' }] })}>{t('terms.addTier')}</Button></div>}
              </div>
              <fieldset className="mt-3 flex flex-col gap-2">
                <legend className="text-sm font-bold">{t('terms.basis')}</legend>
                <div className="flex flex-wrap gap-3">
                  {STREAMS.map((st) => (
                    <label key={st} className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" checked={form.v.basis.streams.includes(st)} onChange={(e) => set({ basis: { ...form.v.basis, streams: e.target.checked ? [...form.v.basis.streams, st] : form.v.basis.streams.filter((x) => x !== st) } })} />
                      {t(`stream.${st}`)}
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap gap-4">
                  <Toggle checked={form.v.basis.netOfRefunds} onChange={(v) => set({ basis: { ...form.v.basis, netOfRefunds: v } })} label={t('terms.netOfRefunds')} />
                  <Toggle checked={form.v.basis.excludeTax} onChange={(v) => set({ basis: { ...form.v.basis, excludeTax: v } })} label={t('terms.excludeTax')} />
                  <Toggle checked={form.v.basis.excludeTips} onChange={(v) => set({ basis: { ...form.v.basis, excludeTips: v } })} label={t('terms.excludeTips')} />
                  <Toggle checked={form.v.basis.includeExternalSales} onChange={(v) => set({ basis: { ...form.v.basis, includeExternalSales: v } })} label={t('terms.includeExternal')} />
                </div>
              </fieldset>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Field label={t('terms.lateFee')}>{(p) => (
                  <Select id={p.id} value={form.v.lateFee.kind} onChange={(e) => set({ lateFee: { ...form.v.lateFee, kind: e.target.value as 'none' | 'flat' | 'percent' } })}>
                    <option value="none">{t('terms.lateFeeNone')}</option>
                    <option value="flat">{t('terms.lateFeeFlat')}</option>
                    <option value="percent">{t('terms.lateFeePercent')}</option>
                  </Select>
                )}</Field>
                {form.v.lateFee.kind !== 'none' && <Field label={form.v.lateFee.kind === 'flat' ? t('terms.lateFeeAmount', { currency: form.v.currency }) : t('terms.lateFeeRate')}>{(p) => <Input id={p.id} inputMode="decimal" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} />}</Field>}
                {form.v.lateFee.kind !== 'none' && <Field label={t('terms.graceDays')}>{(p) => <Input id={p.id} type="number" min={0} value={form.v.lateFee.graceDays} onChange={(e) => set({ lateFee: { ...form.v.lateFee, graceDays: Number(e.target.value) } })} />}</Field>}
              </div>
              <ActionError error={save.error} />
              <div className="mt-3 flex gap-2">
                <Button loading={save.pending} onClick={() => void save.run()} data-testid="save-terms">{t('common.save')}</Button>
                <Button variant="ghost" onClick={() => setForm(null)}>{t('common.cancel')}</Button>
              </div>
            </SectionCard>
          )}
          {d.items.length === 0 ? <Empty icon="file" title={t('terms.empty')} body={t('terms.emptyBody')} /> : (
            <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
              <DataTable<TermsVM>
                rows={d.items}
                rowKey={(x) => x.id}
                onRowClick={edit ? (x) => startEdit(x) : undefined}
                columns={[
                  { key: 'who', header: t('terms.appliesTo'), render: (x) => <strong>{x.ownerGroupId ? d.ownerGroups.find((g) => g.id === x.ownerGroupId)?.name : t('terms.orgDefault')}</strong> },
                  { key: 'cur', header: t('terms.currency'), render: (x) => x.currency },
                  { key: 'when', header: t('terms.effective'), render: (x) => `${date(x.effectiveFrom)} – ${x.effectiveTo ? date(x.effectiveTo) : t('terms.open')}` },
                  { key: 'roy', header: t('col.royalty'), align: 'right', render: (x) => (x.tiers.length ? t('terms.tiered', { count: x.tiers.length }) : `${pctOf(x.royaltyBps)}%`) },
                  { key: 'fund', header: t('col.fund'), align: 'right', render: (x) => `${pctOf(x.marketingFundBps)}%` },
                  { key: 'tech', header: t('col.techFee'), align: 'right', render: (x) => money(x.technologyFeeMinor, x.currency) },
                  { key: 'min', header: t('col.minimum'), align: 'right', render: (x) => (x.minimumRoyaltyMinor ? money(x.minimumRoyaltyMinor, x.currency) : '—') },
                ]}
              />
            </section>
          )}
        </>
      )}
    </Async>
  );
}

function SettingsTab() {
  const t = useTranslations('finance');
  const app = useApp();
  const res = useFinance(() => financeApi.settings(), [app.org.id]);
  const [draft, setDraft] = useState<SettingsVM | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useFinanceAction(async (body: SettingsVM) => {
    const { periodFrequency, weekStartsOn, invoicePrefix, paymentTermsDays, taxLines, dunning, autoCollect, issuerDetails } = body;
    await financeApi.saveSettings({ periodFrequency, weekStartsOn, invoicePrefix, paymentTermsDays, taxLines, dunning, autoCollect, issuerDetails });
    setSaved(true);
    res.reload();
  });
  const connect = useFinanceAction(async () => {
    const r = await financeApi.connectCollectionAccount();
    if (r.mode === 'live') window.location.assign(r.url);
    else res.reload();
  });
  return (
    <Async res={res} loading={<LoadingBlock variant="detail" />}>
      {(loaded) => {
        const s = draft ?? loaded;
        const set = (patch: Partial<SettingsVM>) => (setSaved(false), setDraft({ ...s, ...patch }));
        return (
          <>
            <SectionCard title={t('settings.collectionTitle')}>
              <p className="text-sm text-stone">{t('settings.collectionBody')}</p>
              <p className="mt-2 text-sm">{s.collectionAccountId ? t('settings.collectionConnected', { account: s.collectionAccountId }) : t('settings.collectionMissing')}{s.collectionMode === 'sandbox' ? ` · ${t('settings.sandboxMode')}` : ''}</p>
              {!s.collectionAccountId && <div className="mt-2"><Button size="sm" loading={connect.pending} onClick={() => void connect.run()}>{t('settings.connect')}</Button></div>}
              <ActionError error={connect.error} />
            </SectionCard>
            <SectionCard title={t('settings.periodsTitle')}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label={t('settings.frequency')}>{(p) => (
                  <Select id={p.id} value={s.periodFrequency} onChange={(e) => set({ periodFrequency: e.target.value as 'weekly' | 'monthly' })}>
                    <option value="monthly">{t('frequency.monthly')}</option>
                    <option value="weekly">{t('frequency.weekly')}</option>
                  </Select>
                )}</Field>
                {s.periodFrequency === 'weekly' && <Field label={t('settings.weekStartsOn')}>{(p) => (
                  <Select id={p.id} value={s.weekStartsOn} onChange={(e) => set({ weekStartsOn: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{t(`weekday.${d}`)}</option>)}
                  </Select>
                )}</Field>}
                <Field label={t('settings.invoicePrefix')} hint={t('settings.nextNumber', { number: `${s.invoicePrefix}-${String(s.nextInvoiceSeq).padStart(6, '0')}` })}>{(p) => <Input id={p.id} value={s.invoicePrefix} onChange={(e) => set({ invoicePrefix: e.target.value.toUpperCase() })} />}</Field>
                <Field label={t('settings.paymentTerms')}>{(p) => <Input id={p.id} type="number" min={0} value={s.paymentTermsDays} onChange={(e) => set({ paymentTermsDays: Number(e.target.value) })} />}</Field>
              </div>
              <div className="mt-3"><Toggle checked={s.autoCollect} onChange={(v) => set({ autoCollect: v })} label={t('settings.autoCollect')} /></div>
            </SectionCard>
            <SectionCard title={t('settings.dunningTitle')}>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('settings.retryDays')} hint={t('settings.retryDaysHint')}>{(p) => <Input id={p.id} value={s.dunning.retryDays.join(', ')} onChange={(e) => set({ dunning: { ...s.dunning, retryDays: e.target.value.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0) } })} />}</Field>
                <Field label={t('settings.reminderDays')}>{(p) => <Input id={p.id} type="number" min={0} value={s.dunning.reminderDaysBefore} onChange={(e) => set({ dunning: { ...s.dunning, reminderDaysBefore: Number(e.target.value) } })} />}</Field>
                <Field label={t('settings.finalNotice')}>{(p) => <Input id={p.id} type="number" min={0} value={s.dunning.finalNoticeAfterDays} onChange={(e) => set({ dunning: { ...s.dunning, finalNoticeAfterDays: Number(e.target.value) } })} />}</Field>
              </div>
            </SectionCard>
            <SectionCard title={t('settings.taxTitle')}>
              <p className="mb-2 text-sm text-stone">{t('settings.taxBody')}</p>
              {s.taxLines.map((x, i) => (
                <div key={i} className="mb-2 flex flex-wrap items-end gap-2">
                  <Field label={t('settings.taxName')}>{(p) => <Input id={p.id} value={x.name} onChange={(e) => set({ taxLines: s.taxLines.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) })} />}</Field>
                  <Field label={t('settings.taxRate')}>{(p) => <Input id={p.id} inputMode="decimal" value={pctOf(x.rateBps)} onChange={(e) => set({ taxLines: s.taxLines.map((y, j) => (j === i ? { ...y, rateBps: bpsOf(e.target.value) || 0 } : y)) })} />}</Field>
                  <Field label={t('settings.taxCountry')} optional>{(p) => <Input id={p.id} maxLength={2} value={x.country ?? ''} onChange={(e) => set({ taxLines: s.taxLines.map((y, j) => (j === i ? { ...y, country: e.target.value.toUpperCase() || null } : y)) })} />}</Field>
                  <fieldset className="flex flex-wrap gap-2 pb-2 text-sm">
                    <legend className="sr-only">{t('settings.taxAppliesTo')}</legend>
                    {(['royalty', 'marketing_fund', 'technology_fee', 'late_fee'] as const).map((k) => (
                      <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={x.appliesTo.includes(k)} onChange={(e) => set({ taxLines: s.taxLines.map((y, j) => (j === i ? { ...y, appliesTo: e.target.checked ? [...y.appliesTo, k] : y.appliesTo.filter((z) => z !== k) } : y)) })} />{t(`invoiceLine.${k}`)}</label>
                    ))}
                  </fieldset>
                  <Button size="sm" variant="ghost" icon="x" onClick={() => set({ taxLines: s.taxLines.filter((_, j) => j !== i) })}>{t('settings.removeTax')}</Button>
                </div>
              ))}
              <Button size="sm" variant="ghost" icon="plus" onClick={() => set({ taxLines: [...s.taxLines, { name: '', rateBps: 0, country: null, appliesTo: ['royalty', 'technology_fee'] }] })}>{t('settings.addTax')}</Button>
            </SectionCard>
            <SectionCard title={t('settings.issuerTitle')}>
              <div className="grid gap-3 sm:grid-cols-2">
                {(['legalName', 'address', 'taxNumber', 'email'] as const).map((k) => (
                  <Field key={k} label={t(`settings.issuer.${k}`)} optional>{(p) => <Input id={p.id} value={s.issuerDetails[k] ?? ''} onChange={(e) => set({ issuerDetails: { ...s.issuerDetails, [k]: e.target.value } })} />}</Field>
                ))}
              </div>
            </SectionCard>
            <ActionError error={save.error} />
            {saved && <Banner tone="success" live="polite">{t('settings.saved')}</Banner>}
            <div><Button loading={save.pending} onClick={() => void save.run(s)}>{t('common.save')}</Button></div>
          </>
        );
      }}
    </Async>
  );
}

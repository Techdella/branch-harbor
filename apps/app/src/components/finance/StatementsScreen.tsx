'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Field, Input, Select, Textarea } from '@bh/ui';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { downloadFile, financeApi, readUpload, useFinance, useFinanceAction, type ExternalSalesVM, type InvoiceVM, type StatementVM } from './api';
import { InvoiceDrawer, StatementDrawer } from './Drawers';
import { ActionError, CurrencyTiles, InvoiceBadge, PillTabs, SandboxNote, StatementBadge, toMinor, useDate, useMoney, usePeriodLabel } from './FinanceUi';

type Tab = 'statements' | 'invoices' | 'method' | 'sales';

/**
 * Statements & invoices for the locations in the person's scope. A franchise owner sees only their own studios:
 * royalty statements (and can dispute them), invoices (and pay them), their debit mandate and external sales reports.
 */
export function StatementsScreen() {
  const t = useTranslations('finance');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'statements';
  if (!app.hasModule('finance.invoices')) return <DeniedState />;
  const edit = app.capabilities.has('finance.invoices:edit');
  const tabs: Array<[Tab, string]> = [
    ['statements', t('mine.tab.statements')],
    ['invoices', t('mine.tab.invoices')],
    ...(edit ? ([['method', t('mine.tab.method')], ['sales', t('mine.tab.sales')]] as Array<[Tab, string]>) : []),
  ];
  return (
    <>
      <PageHeader icon="file" title={t('mine.title')} description={t('mine.description')} scope={false} />
      <PillTabs items={tabs} value={tab} onChange={(k) => router.replace(`?tab=${k}`, { scroll: false })} />
      {tab === 'invoices' ? <MyInvoices /> : tab === 'method' && edit ? <PaymentMethod /> : tab === 'sales' && edit ? <SalesReports /> : <MyStatements />}
    </>
  );
}

function MyStatements() {
  const t = useTranslations('finance');
  const app = useApp();
  const money = useMoney();
  const period = usePeriodLabel();
  const res = useFinance(() => financeApi.statements(), [app.org.id]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="receipt" title={t('mine.noStatements')} body={t('mine.noStatementsBody')} />}>
        {(d) => (
          <section className="overflow-x-auto rounded-xl bg-surface p-3.5" data-testid="my-statements">
            <DataTable<StatementVM>
              rows={d.items}
              rowKey={(s) => s.id}
              onRowClick={(s) => setOpen(s.id)}
              rowLabel={(s) => `${s.location.name} ${period(s.period)}`}
              columns={[
                { key: 'p', header: t('col.period'), render: (s) => <strong>{period(s.period)}</strong> },
                { key: 'loc', header: t('col.location'), render: (s) => s.location.name },
                { key: 'basis', header: t('col.basis'), align: 'right', render: (s) => money(s.basisMinor, s.currency) },
                { key: 'total', header: t('col.total'), align: 'right', render: (s) => <strong>{money(s.totalMinor, s.currency)}</strong> },
                { key: 'st', header: t('col.status'), render: (s) => <span className="flex flex-wrap gap-1"><StatementBadge status={s.status} />{s.invoice && <InvoiceBadge state={s.invoice.status} />}</span> },
              ]}
            />
          </section>
        )}
      </Async>
      <StatementDrawer id={open} onClose={() => setOpen(null)} onChanged={res.reload} hq={null} />
    </>
  );
}

function MyInvoices() {
  const t = useTranslations('finance');
  const app = useApp();
  const money = useMoney();
  const date = useDate();
  const res = useFinance(() => financeApi.invoices(), [app.org.id]);
  const overview = useFinance(() => financeApi.overview(), [app.org.id]);
  const [open, setOpen] = useState<string | null>(null);
  const canPay = app.capabilities.has('finance.invoices:edit');
  const hq = app.capabilities.has('finance.royalties:edit');
  return (
    <>
      {overview.data?.sandbox && <SandboxNote />}
      {overview.data && <CurrencyTiles items={overview.data.receivables.map((r) => ({ currency: r.currency, amountMinor: r.openMinor }))} label={(c) => t('mine.toPay', { currency: c })} sub={(c) => { const r = overview.data!.receivables.find((x) => x.currency === c)!; return r.overdue ? t('royalties.overdueSub', { count: r.overdue, amount: money(r.overdueMinor, c) }) : t('royalties.noneOverdue'); }} />}
      {app.capabilities.has('finance.invoices:export') && <div><Button variant="ghost" size="sm" icon="download" onClick={() => void downloadFile('/exports/invoices', 'invoices.csv')}>{t('common.exportCsv')}</Button></div>}
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="receipt" title={t('invoices.empty')} />}>
        {(d) => (
          <section className="overflow-x-auto rounded-xl bg-surface p-3.5" data-testid="my-invoices">
            <DataTable<InvoiceVM>
              rows={d.items}
              rowKey={(i) => i.id}
              onRowClick={(i) => setOpen(i.id)}
              rowLabel={(i) => i.number}
              columns={[
                { key: 'no', header: t('col.invoice'), render: (i) => <span><strong className="font-mono text-[13px]">{i.number}</strong><span className="block text-xs text-stone">{i.location.name}</span></span> },
                { key: 'due', header: t('col.due'), render: (i) => date(i.dueDate) },
                { key: 'total', header: t('col.total'), align: 'right', render: (i) => money(i.totalMinor, i.currency) },
                { key: 'out', header: t('col.outstanding'), align: 'right', render: (i) => <strong>{money(i.outstandingMinor, i.currency)}</strong> },
                { key: 'st', header: t('col.status'), render: (i) => <InvoiceBadge state={i.state} /> },
              ]}
            />
          </section>
        )}
      </Async>
      <InvoiceDrawer id={open} onClose={() => setOpen(null)} onChanged={() => (res.reload(), overview.reload())} hq={hq} canPay={canPay} sandbox={!!overview.data?.sandbox} />
    </>
  );
}

function PaymentMethod() {
  const t = useTranslations('finance');
  const res = useFinance(() => financeApi.paymentMethods(), []);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState('');
  const act = useFinanceAction(async (fn: () => Promise<unknown>, message: string) => {
    await fn();
    setMsg(message);
    res.reload();
  });
  return (
    <Async res={res} loading={<LoadingBlock variant="detail" />} isEmpty={(d) => d.ownerGroups.length === 0} empty={<Empty icon="card" title={t('method.noGroups')} />}>
      {(d) => (
        <>
          <p className="text-sm text-stone">{t('method.intro')}</p>
          {d.mode === 'sandbox' && <SandboxNote />}
          <ActionError error={act.error} />
          {msg && <Banner tone="success" live="polite">{msg}</Banner>}
          {d.ownerGroups.flatMap((g) => g.currencies.map((c) => {
            const key = `${g.id}:${c.currency}`;
            const active = d.items.find((m) => m.ownerGroupId === g.id && m.currency === c.currency && m.status === 'active');
            const pending = d.items.find((m) => m.ownerGroupId === g.id && m.currency === c.currency && m.status === 'pending');
            const type = choice[key] ?? c.methodTypes[c.methodTypes.length - 1]!;
            return (
              <SectionCard key={key} title={`${g.name} · ${c.currency}`} aside={active ? <Badge tone="success">{t('method.active')}</Badge> : <Badge tone="warning">{t('method.none')}</Badge>}>
                {active && (
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                    <span>{t('method.saved', { method: t(`method.${active.methodType}`), last4: active.display.last4 ?? '••••' })}</span>
                    <Button size="sm" variant="ghost" loading={act.pending} onClick={() => void act.run(() => financeApi.revokeMethod(active.id), t('method.revoked'))}>{t('method.revoke')}</Button>
                  </div>
                )}
                {pending ? (
                  <div className="flex flex-col gap-2 text-sm">
                    <p>{t('method.pending', { method: t(`method.${pending.methodType}`) })}</p>
                    <p className="rounded-lg bg-canvas p-3 text-xs">{pending.mandateText}</p>
                    <div className="flex flex-wrap gap-2">
                      {d.mode === 'sandbox' ? (
                        <>
                          <Button size="sm" loading={act.pending} onClick={() => void act.run(() => financeApi.sandboxConfirmMethod(pending.id, 'ok'), t('method.confirmed'))} data-testid="sandbox-confirm-method">{t('method.sandboxConfirm')}</Button>
                          <Button size="sm" variant="ghost" loading={act.pending} onClick={() => void act.run(() => financeApi.sandboxConfirmMethod(pending.id, 'decline'), t('method.confirmed'))}>{t('method.sandboxDecline')}</Button>
                        </>
                      ) : <Button size="sm" variant="secondary" icon="refresh" loading={act.pending} onClick={() => void act.run(() => financeApi.refreshMethod(pending.id), t('method.checked'))}>{t('method.check')}</Button>}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Field label={t('method.type')}>{(p) => (
                      <Select id={p.id} value={type} onChange={(e) => setChoice({ ...choice, [key]: e.target.value })}>
                        {c.methodTypes.map((m) => <option key={m} value={m}>{t(`method.${m}`)}</option>)}
                      </Select>
                    )}</Field>
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" className="mt-1" checked={!!accepted[key]} onChange={(e) => setAccepted({ ...accepted, [key]: e.target.checked })} data-testid="accept-mandate" />
                      <span>{t('method.authorise', { group: g.name, currency: c.currency })}</span>
                    </label>
                    <div><Button size="sm" icon="card" loading={act.pending} disabled={!accepted[key]} onClick={() => void act.run(() => financeApi.setupMethod({ ownerGroupId: g.id, currency: c.currency, methodType: type, acceptMandate: true }), t('method.started'))} data-testid="setup-method">{active ? t('method.replace') : t('method.setUp')}</Button></div>
                  </div>
                )}
              </SectionCard>
            );
          }))}
        </>
      )}
    </Async>
  );
}

function SalesReports() {
  const t = useTranslations('finance');
  const app = useApp();
  const money = useMoney();
  const date = useDate();
  const res = useFinance(() => financeApi.externalSales(), [app.org.id]);
  const periods = useFinance(() => financeApi.periods(), [app.org.id]);
  const [loc, setLoc] = useState(app.locations[0]?.id ?? '');
  const [start, setStart] = useState('');
  const [gross, setGross] = useState('');
  const [refunds, setRefunds] = useState('0');
  const [tax, setTax] = useState('0');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [ok, setOk] = useState(false);
  const location = app.locations.find((l) => l.id === loc);
  const submit = useFinanceAction(async () => {
    await financeApi.submitExternalSales({ locationId: loc, periodStart: start || periods.data!.suggestedClose.startDate, grossMinor: toMinor(gross) ?? 0, refundsMinor: toMinor(refunds) ?? 0, taxMinor: toMinor(tax) ?? 0, note, evidence: await readUpload(file!) });
    setOk(true);
    setGross('');
    setFile(null);
    res.reload();
  });
  return (
    <>
      <SectionCard title={t('sales.submitTitle')}>
        <p className="mb-3 text-sm text-stone">{t('sales.submitHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('col.location')}>{(p) => (
            <Select id={p.id} value={loc} onChange={(e) => setLoc(e.target.value)}>
              {app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          )}</Field>
          <Field label={t('royalties.periodStart')}>{(p) => <Input id={p.id} type="date" value={start || periods.data?.suggestedClose.startDate || ''} onChange={(e) => setStart(e.target.value)} />}</Field>
          <Field label={t('sales.gross', { currency: location?.currency ?? '' })}>{(p) => <Input id={p.id} inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} />}</Field>
          <Field label={t('sales.refunds', { currency: location?.currency ?? '' })}>{(p) => <Input id={p.id} inputMode="decimal" value={refunds} onChange={(e) => setRefunds(e.target.value)} />}</Field>
          <Field label={t('sales.tax', { currency: location?.currency ?? '' })}>{(p) => <Input id={p.id} inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} />}</Field>
          <Field label={t('sales.evidenceFile')} hint={t('sales.evidenceHint')}>{(p) => <Input id={p.id} type="file" accept="application/pdf,image/*,text/csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</Field>
        </div>
        <div className="mt-3"><Field label={t('sales.note')} optional>{(p) => <Textarea id={p.id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field></div>
        <ActionError error={submit.error} />
        {ok && <Banner tone="success" live="polite">{t('sales.submitted')}</Banner>}
        <div className="mt-3"><Button loading={submit.pending} disabled={!file || toMinor(gross) === null || !loc} onClick={() => void submit.run()}>{t('sales.submit')}</Button></div>
      </SectionCard>
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="file" title={t('sales.empty')} />}>
        {(d) => (
          <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
            <DataTable<ExternalSalesVM>
              rows={d.items}
              rowKey={(r) => r.id}
              columns={[
                { key: 'loc', header: t('col.location'), render: (r) => <span><strong>{r.location.name}</strong><span className="block text-xs text-stone">{date(r.periodStart)}</span></span> },
                { key: 'gross', header: t('col.grossSales'), align: 'right', render: (r) => money(r.grossMinor, r.currency) },
                { key: 'st', header: t('col.status'), render: (r) => <Badge tone={r.status === 'accepted' ? 'success' : r.status === 'rejected' ? 'danger' : 'warning'}>{t(`sales.status.${r.status}`)}</Badge> },
                { key: 'note', header: t('sales.reviewNote'), render: (r) => r.reviewNote ?? '' },
              ]}
            />
          </section>
        )}
      </Async>
    </>
  );
}

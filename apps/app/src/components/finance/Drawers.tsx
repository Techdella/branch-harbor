'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Input, Select, Textarea } from '@bh/ui';
import { LoadingBlock, ErrorState } from '../ui/States';
import { downloadFile, financeApi, useFinance, useFinanceAction, type StatementDetailVM, type StatementLineVM } from './api';
import { ActionError, InvoiceBadge, StatementBadge, toMinor, useDate, useMoney, usePeriodLabel } from './FinanceUi';

/** Human label for a statement line (computed lines carry a code; manual adjustments carry HQ's text). */
export function useLineLabel() {
  const t = useTranslations('finance');
  const money = useMoney();
  return (l: StatementLineVM, currency: string) => {
    const [code, a, b] = l.description.split(':');
    if (l.kind === 'sales') return code === 'excluded' ? t('line.excluded', { stream: t(`stream.${a}`) }) : t('line.sales', { stream: t(`stream.${a}`) });
    if (l.kind === 'royalty' && code === 'royalty_tier') return b ? t('line.royaltyTier', { from: money(Number(a), currency), to: money(Number(b), currency) }) : t('line.royaltyTierAbove', { from: money(Number(a), currency) });
    if (l.kind === 'adjustment') return code === 'dispute' ? t('line.disputeAdjustment', { text: l.description.slice(8) }) : l.description;
    return t(`line.${l.kind}`);
  };
}

export function useWarningLabel() {
  const t = useTranslations('finance');
  const money = useMoney();
  return (w: string) => {
    const [code, cur, amt] = w.split(':');
    if (code === 'foreign_currency_payments') return t('warning.foreign', { amount: money(Number(amt), cur!) });
    return t(`warning.${code}`);
  };
}

const pct = (bps: number | null) => (bps === null ? '' : `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`);

/**
 * Statement detail: lines, warnings and disputes. HQ (finance.royalties) can recalculate, adjust, approve, invoice and
 * resolve disputes; the franchisee (finance.invoices edit) can dispute a statement or one of its lines.
 */
export function StatementDrawer({ id, onClose, onChanged, hq }: { id: string | null; onClose: () => void; onChanged: () => void; hq: { edit: boolean; publish: boolean } | null; }) {
  const t = useTranslations('finance');
  const money = useMoney();
  const period = usePeriodLabel();
  const date = useDate();
  const lineLabel = useLineLabel();
  const warn = useWarningLabel();
  const res = useFinance(() => financeApi.statement(id!), [id], !!id);
  const [disputeLine, setDisputeLine] = useState<string>('');
  const [reason, setReason] = useState('');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjText, setAdjText] = useState('');
  const [resolution, setResolution] = useState('');
  const [resolveAdj, setResolveAdj] = useState('');
  const [done, setDone] = useState('');
  const act = useFinanceAction(async (fn: () => Promise<unknown>, message: string) => {
    await fn();
    setDone(message);
    res.reload();
    onChanged();
  });
  const s: StatementDetailVM | undefined = res.status === 'ready' || res.status === 'loading' ? res.data : undefined;
  const editable = s && (s.status === 'draft' || s.status === 'disputed');
  const disputable = s && ['draft', 'approved', 'disputed'].includes(s.status);
  const openDispute = s?.disputes.find((d) => d.status === 'open');

  return (
    <Drawer open={!!id} onClose={() => (setDone(''), onClose())} kicker={t('statement.kicker')} title={s ? `${s.location.name ?? ''} · ${period(s.period)}` : t('statement.kicker')}>
      {res.status === 'error' ? <ErrorState error={res.error} onRetry={res.reload} compact /> : !s ? <LoadingBlock variant="detail" /> : (
        <div className="flex flex-col gap-4" data-testid="statement-drawer">
          <div className="flex flex-wrap items-center gap-2">
            <StatementBadge status={s.status} />
            {s.ownerGroup && <Badge tone="neutral">{s.ownerGroup.name}</Badge>}
            <Badge tone="neutral">{s.currency}</Badge>
            <span className="text-xs text-stone">{t('statement.timeZone', { zone: s.timeZone })}</span>
          </div>
          {s.warnings.map((w) => <p key={w} className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{warn(w)}</p>)}
          {done && <p role="status" className="rounded-lg bg-success-bg px-3 py-2 text-sm text-success">{done}</p>}
          <ActionError error={act.error} />
          <div className="overflow-x-auto">
            <DataTable<StatementLineVM>
              rows={s.lines}
              rowKey={(l) => l.id}
              columns={[
                { key: 'what', header: t('statement.line'), render: (l) => <span className={l.kind === 'basis' ? 'font-bold' : undefined}>{lineLabel(l, s.currency)}{l.manual && <span className="ml-2 text-xs text-stone">{t('statement.manual')}</span>}</span> },
                { key: 'rate', header: t('statement.rate'), align: 'right', render: (l) => (l.rateBps !== null ? `${pct(l.rateBps)} × ${money(l.basisMinor ?? 0, s.currency)}` : '') },
                { key: 'amt', header: t('statement.amount'), align: 'right', render: (l) => <span className={l.charge ? 'font-bold' : 'text-stone'}>{money(l.amountMinor, s.currency)}</span> },
              ]}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg bg-lime px-4 py-3 font-extrabold">
            <span>{t('statement.totalDue')}</span>
            <span data-testid="statement-total">{money(s.totalMinor, s.currency)}</span>
          </div>
          {s.invoice && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-canvas px-4 py-3 text-sm">
              <span className="font-bold">{t('invoice.number', { number: s.invoice.number })}</span>
              <InvoiceBadge state={s.invoice.status} />
              <span className="text-stone">{t('invoice.due', { date: date(s.invoice.dueDate) })}</span>
              <Button size="sm" variant="secondary" icon="download" className="ml-auto" onClick={() => void act.run(() => downloadFile(`/invoices/${s.invoice!.id}/pdf`, `${s.invoice!.number}.pdf`), '')}>{t('invoice.pdf')}</Button>
            </div>
          )}

          {s.disputes.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-bold">{t('dispute.title')}</h3>
              {s.disputes.map((d) => (
                <div key={d.id} className="rounded-lg bg-canvas p-3 text-sm">
                  <div className="flex items-center gap-2"><Badge tone={d.status === 'open' ? 'warning' : d.status === 'accepted' ? 'success' : 'neutral'}>{t(`dispute.status.${d.status}`)}</Badge><span className="text-xs text-stone">{date(d.createdAt)}</span></div>
                  <p className="mt-1">{d.reason}</p>
                  {d.resolution && <p className="mt-1 text-stone">{t('dispute.resolution', { text: d.resolution })}{d.adjustmentMinor ? ` · ${money(d.adjustmentMinor, s.currency)}` : ''}</p>}
                </div>
              ))}
            </section>
          )}

          {hq?.edit && openDispute && (
            <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <h3 className="text-sm font-bold">{t('dispute.resolveTitle')}</h3>
              <Field label={t('dispute.resolutionLabel')}>{(p) => <Textarea id={p.id} value={resolution} onChange={(e) => setResolution(e.target.value)} rows={2} />}</Field>
              <Field label={t('dispute.adjustmentLabel', { currency: s.currency })} hint={t('dispute.adjustmentHint')} optional>{(p) => <Input id={p.id} inputMode="decimal" value={resolveAdj} onChange={(e) => setResolveAdj(e.target.value)} />}</Field>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" loading={act.pending} disabled={resolution.trim().length < 2} onClick={() => void act.run(() => financeApi.resolveDispute(openDispute.id, 'accepted', resolution, resolveAdj ? toMinor(resolveAdj) : null), t('dispute.resolved'))}>{t('dispute.accept')}</Button>
                <Button size="sm" variant="secondary" loading={act.pending} disabled={resolution.trim().length < 2} onClick={() => void act.run(() => financeApi.resolveDispute(openDispute.id, 'rejected', resolution), t('dispute.resolved'))}>{t('dispute.reject')}</Button>
              </div>
            </section>
          )}

          {!hq && disputable && (
            <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <h3 className="text-sm font-bold">{t('dispute.raiseTitle')}</h3>
              <p className="text-xs text-stone">{t('dispute.raiseHint')}</p>
              <Field label={t('dispute.lineLabel')} optional>
                {(p) => (
                  <Select id={p.id} value={disputeLine} onChange={(e) => setDisputeLine(e.target.value)}>
                    <option value="">{t('dispute.wholeStatement')}</option>
                    {s.lines.map((l) => <option key={l.id} value={l.id}>{lineLabel(l, s.currency)}</option>)}
                  </Select>
                )}
              </Field>
              <Field label={t('dispute.reasonLabel')}>{(p) => <Textarea id={p.id} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} data-testid="dispute-reason" />}</Field>
              <div><Button size="sm" variant="secondary" icon="flag" loading={act.pending} disabled={reason.trim().length < 5} onClick={() => void act.run(() => financeApi.dispute(s.id, reason, disputeLine || null), t('dispute.raised')).then(() => setReason(''))}>{t('dispute.raise')}</Button></div>
            </section>
          )}

          {hq?.edit && editable && (
            <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <h3 className="text-sm font-bold">{t('statement.adjustTitle')}</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label={t('statement.adjustAmount', { currency: s.currency })} hint={t('statement.adjustHint')}>{(p) => <Input id={p.id} inputMode="decimal" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} />}</Field>
                <Field label={t('statement.adjustReason')}>{(p) => <Input id={p.id} value={adjText} onChange={(e) => setAdjText(e.target.value)} />}</Field>
              </div>
              <div><Button size="sm" variant="secondary" loading={act.pending} disabled={!toMinor(adjAmount) || adjText.trim().length < 2} onClick={() => void act.run(() => financeApi.adjust(s.id, toMinor(adjAmount)!, adjText), t('statement.adjusted')).then(() => (setAdjAmount(''), setAdjText('')))}>{t('statement.adjust')}</Button></div>
            </section>
          )}

          {hq && (
            <div className="flex flex-wrap gap-2">
              {hq.edit && editable && <Button variant="secondary" icon="refresh" loading={act.pending} onClick={() => void act.run(() => financeApi.recalculate(s.id), t('statement.recalculated'))}>{t('statement.recalculate')}</Button>}
              {hq.publish && s.status === 'draft' && <Button icon="check" loading={act.pending} onClick={() => void act.run(() => financeApi.approve(s.id), t('statement.approved'))} data-testid="approve-statement">{t('statement.approve')}</Button>}
              {hq.publish && s.status === 'approved' && <Button variant="signal" icon="receipt" loading={act.pending} onClick={() => void act.run(() => financeApi.invoice(s.id), t('statement.invoiced'))} data-testid="issue-invoice">{t('statement.issueInvoice')}</Button>}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

/** Invoice detail with collection attempts and dunning history. HQ collects or records payments; the franchisee pays. */
export function InvoiceDrawer({ id, onClose, onChanged, hq, canPay, sandbox }: { id: string | null; onClose: () => void; onChanged: () => void; hq: boolean; canPay: boolean; sandbox: boolean }) {
  const t = useTranslations('finance');
  const money = useMoney();
  const date = useDate();
  const res = useFinance(() => financeApi.invoiceDetail(id!), [id], !!id);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [received, setReceived] = useState(new Date().toISOString().slice(0, 10));
  const [done, setDone] = useState('');
  const act = useFinanceAction(async (fn: () => Promise<unknown>, message: string) => {
    const r = (await fn()) as { status?: string; failureCode?: string | null } | undefined;
    setDone(r?.status === 'failed' ? t('invoice.collectFailed', { code: r.failureCode ?? '' }) : message);
    res.reload();
    onChanged();
  });
  const inv = res.status === 'error' ? undefined : res.data;
  const open = inv && inv.status !== 'paid' && inv.status !== 'void' && inv.outstandingMinor > 0;
  return (
    <Drawer open={!!id} onClose={() => (setDone(''), onClose())} kicker={t('invoice.kicker')} title={inv ? `${inv.number} · ${money(inv.totalMinor, inv.currency)}` : t('invoice.kicker')}>
      {res.status === 'error' ? <ErrorState error={res.error} onRetry={res.reload} compact /> : !inv ? <LoadingBlock variant="detail" /> : (
        <div className="flex flex-col gap-4" data-testid="invoice-drawer">
          <div className="flex flex-wrap items-center gap-2">
            <InvoiceBadge state={inv.state} />
            <span className="text-sm">{inv.location.name}{inv.ownerGroup ? ` · ${inv.ownerGroup.name}` : ''}</span>
          </div>
          {done && <p role="status" className="rounded-lg bg-canvas px-3 py-2 text-sm" data-testid="invoice-message">{done}</p>}
          <ActionError error={act.error} />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-stone">{t('invoice.issued')}</dt><dd>{date(inv.issueDate)}</dd>
            <dt className="text-stone">{t('invoice.dueDate')}</dt><dd>{date(inv.dueDate)}{inv.daysOverdue > 0 && inv.state === 'overdue' ? ` · ${t('invoice.daysOverdue', { count: inv.daysOverdue })}` : ''}</dd>
          </dl>
          <div className="flex flex-col gap-1 rounded-lg bg-canvas p-3 text-sm">
            {inv.lines.map((l, i) => <div key={i} className="flex justify-between"><span>{t(`invoiceLine.${l.kind}`)}</span><span>{money(l.amountMinor, inv.currency)}</span></div>)}
            {inv.taxes.map((x) => <div key={x.name} className="flex justify-between"><span>{t('invoice.tax', { name: x.name, rate: pct(x.rateBps) })}</span><span>{money(x.amountMinor, inv.currency)}</span></div>)}
            {!inv.taxes.length && <div className="flex justify-between text-stone"><span>{t('invoice.noTax')}</span><span>—</span></div>}
            <div className="flex justify-between border-t border-line pt-1 font-bold"><span>{t('invoice.total')}</span><span>{money(inv.totalMinor, inv.currency)}</span></div>
            {inv.paidMinor > 0 && <div className="flex justify-between"><span>{t('invoice.paid')}</span><span>{money(-inv.paidMinor, inv.currency)}</span></div>}
            <div className="flex justify-between font-extrabold"><span>{t('invoice.outstanding')}</span><span data-testid="invoice-outstanding">{money(inv.outstandingMinor, inv.currency)}</span></div>
          </div>
          {inv.paymentMethod ? (
            <p className="text-sm">{t('invoice.mandate', { method: t(`method.${inv.paymentMethod.methodType}`), last4: inv.paymentMethod.display.last4 ?? '••••' })}</p>
          ) : open ? <p className="text-sm text-stone">{t('invoice.noMandate')}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon="download" onClick={() => void act.run(() => downloadFile(`/invoices/${inv.id}/pdf`, `${inv.number}.pdf`), '')}>{t('invoice.pdf')}</Button>
            {open && inv.status !== 'processing' && inv.paymentMethod && hq && <Button size="sm" icon="card" loading={act.pending} onClick={() => void act.run(() => financeApi.collect(inv.id), t('invoice.collectStarted'))} data-testid="collect-invoice">{t('invoice.collect')}</Button>}
            {open && inv.status !== 'processing' && inv.paymentMethod && !hq && canPay && <Button size="sm" icon="card" loading={act.pending} onClick={() => void act.run(() => financeApi.pay(inv.id), t('invoice.payStarted'))} data-testid="pay-invoice">{t('invoice.payNow', { amount: money(inv.outstandingMinor, inv.currency) })}</Button>}
            {hq && sandbox && inv.status === 'processing' && (
              <>
                <Button size="sm" variant="secondary" loading={act.pending} onClick={() => void act.run(() => financeApi.sandboxSettle(inv.id, 'succeeded'), t('invoice.settled'))} data-testid="sandbox-settle">{t('invoice.sandboxSettle')}</Button>
                <Button size="sm" variant="ghost" loading={act.pending} onClick={() => void act.run(() => financeApi.sandboxSettle(inv.id, 'failed'), t('invoice.settleFailed'))}>{t('invoice.sandboxFail')}</Button>
              </>
            )}
          </div>
          {hq && open && (
            <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <h3 className="text-sm font-bold">{t('invoice.recordTitle')}</h3>
              <div className="grid gap-2 sm:grid-cols-3">
                <Field label={t('invoice.recordAmount', { currency: inv.currency })}>{(p) => <Input id={p.id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
                <Field label={t('invoice.recordReference')}>{(p) => <Input id={p.id} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
                <Field label={t('invoice.recordDate')}>{(p) => <Input id={p.id} type="date" value={received} onChange={(e) => setReceived(e.target.value)} />}</Field>
              </div>
              <div><Button size="sm" variant="secondary" loading={act.pending} disabled={!toMinor(amount) || !reference.trim()} onClick={() => void act.run(() => financeApi.recordPayment(inv.id, toMinor(amount)!, reference, received), t('invoice.recorded'))}>{t('invoice.record')}</Button></div>
            </section>
          )}
          {(inv.attempts.length > 0 || inv.dunning.length > 0) && (
            <section className="flex flex-col gap-1 text-sm">
              <h3 className="font-bold">{t('invoice.history')}</h3>
              {inv.attempts.map((a) => (
                <div key={a.id} className="flex flex-wrap justify-between gap-2 border-b border-line py-1">
                  <span>{t('invoice.attempt', { n: a.attempt, method: t(`attemptMethod.${a.method}`) })}{a.reference ? ` · ${a.reference}` : ''}</span>
                  <span><Badge tone={a.status === 'succeeded' ? 'success' : a.status === 'failed' ? 'danger' : 'info'}>{t(`attemptStatus.${a.status}`)}</Badge> {money(a.amountMinor, a.currency)}</span>
                </div>
              ))}
              {inv.dunning.map((d) => (
                <div key={d.id} className="flex justify-between gap-2 border-b border-line py-1 text-stone">
                  <span>{t(`dunning.${d.action}`)}</span>
                  <span>{date(d.createdAt)}</span>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}

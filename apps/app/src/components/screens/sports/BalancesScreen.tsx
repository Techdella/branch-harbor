'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Icon, Tabs } from '@bh/ui';
import { minorUnitExponent, type Currency } from '@bh/shared';
import type { BalanceState, SBalanceRow } from '@/lib/sports/types';
import { useSports, useSportsAction } from '@/lib/sports/useSports';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock } from '../../ui/States';
import { Amount, BalanceBadge, FieldLabel, Stat, fmtDate, inputCls, useScopeIds } from './ui';

type Filter = 'all' | 'overdue' | 'due' | 'on_track' | 'paid';

/** Instalments and balances per registration; totals per currency; financial aid and waivers by administrators. */
export function BalancesScreen() {
  const t = useTranslations('sportsHub.balances');
  const tOps = useTranslations('ops.sports.balances');
  const locale = useLocale();
  const app = useApp();
  const scope = useScopeIds();
  const allowed = app.can('payments.read') || app.can('customers.read');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<SBalanceRow | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const res = useSports((c) => c.balances(scope), [scope.join(','), app.role], allowed);
  const remind = useSportsAction((c) => c.runReminders());
  if (!allowed) return <><PageHeader icon="card" title={tOps('title')} /><DeniedState permission="payments.read" /></>;
  return (
    <>
      <PageHeader icon="card" title={tOps('title')} description={tOps('description')} actions={app.can('customers.write') && app.scope.kind === 'all' ? <Button variant="secondary" size="sm" icon="bell" loading={remind.pending} onClick={async () => { const r = await remind.run(); if (r) setMsg(t('remindersSent', { n: r.sent })); }}>{t('sendReminders')}</Button> : null} />
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      {remind.error && <Banner tone="danger">{remind.error.message}</Banner>}
      <Async res={res} loading={<LoadingBlock variant="table" rows={6} />}>
        {({ items, totals }) => {
          const rows = items.filter((r) => filter === 'all' || r.balance.state === filter);
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {totals.length === 0 && <Stat label={t('outstanding')} value={t('none')} />}
                {totals.map((x) => (
                  <Stat key={x.currency} icon="wallet" label={t('totalsFor', { currency: x.currency })} value={<Amount amount={x.outstanding} currency={x.currency} />} sub={<>{t('overdueLine')} <strong className="text-danger"><Amount amount={x.overdue} currency={x.currency} /></strong> · {t('paidLine')} <Amount amount={x.paid} currency={x.currency} /> · {t('regs', { n: x.registrations })}</>} tone={x.overdue ? 'danger' : undefined} />
                ))}
              </div>
              <p className="text-xs text-stone">{t('noCombined')}</p>
              <Tabs items={(['all', 'overdue', 'due', 'on_track', 'paid'] as Filter[]).map((k) => ({ key: k, label: t(`filter.${k}`), count: k === 'all' ? items.length : items.filter((r) => r.balance.state === k).length }))} value={filter} onChange={setFilter} />
              {rows.length === 0 ? <Empty icon="card" title={t('empty')} /> : (
                <div className="overflow-x-auto rounded-lg bg-surface">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead><tr className="text-left text-xs text-stone"><th className="p-3">{t('participant')}</th><th>{t('programme')}</th><th>{t('plan')}</th><th className="text-right">{t('paid')}</th><th className="text-right">{t('outstanding')}</th><th>{t('next')}</th><th>{t('state')}</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.registrationId} className="cursor-pointer border-t border-line-soft hover:bg-canvas" onClick={() => setOpen(r)}>
                          <td className="p-3"><button type="button" className="font-bold underline-offset-2 hover:underline" onClick={() => setOpen(r)}>{r.participant}</button><div className="text-xs text-stone">{r.guardian}</div></td>
                          <td>{r.programme}<div className="text-xs text-stone">{r.location.name}</div></td>
                          <td>{t(`planKind.${r.plan}`)}</td>
                          <td className="text-right"><Amount amount={r.balance.paid} currency={r.balance.currency} /></td>
                          <td className="text-right font-bold"><Amount amount={r.balance.outstanding} currency={r.balance.currency} /></td>
                          <td>{r.balance.nextDue ? <>{fmtDate(r.balance.nextDue.dueOn, locale)}</> : '—'}</td>
                          <td><BalanceBadge state={r.balance.state as BalanceState} />{r.status === 'withdrawn' && <Badge tone="neutral" icon="undo" className="ml-1">{t('withdrawn')}</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <BalanceDrawer row={open} onClose={() => setOpen(null)} onChanged={(m) => { setMsg(m); setOpen(null); res.reload(); }} />
            </>
          );
        }}
      </Async>
    </>
  );
}

function BalanceDrawer({ row, onClose, onChanged }: { row: SBalanceRow | null; onClose: () => void; onChanged: (m: string) => void }) {
  const t = useTranslations('sportsHub.balances');
  const locale = useLocale();
  const app = useApp();
  const [kind, setKind] = useState<'financial_aid' | 'waiver'>('financial_aid');
  const [amount, setAmount] = useState('');
  const [waiveAll, setWaiveAll] = useState(false);
  const [reason, setReason] = useState('');
  const adjust = useSportsAction((c, id: string, input: Parameters<typeof c.adjust>[1]) => c.adjust(id, input).then(() => true));
  if (!row) return null;
  const cur = (row.balance.currency ?? row.listFee.currency) as Currency;
  const canAdjust = (app.can('customers.write') || app.can('payments.refund')) && row.balance.outstanding > 0;
  const submit = async () => {
    const minor = Math.round(Number(amount || 0) * 10 ** minorUnitExponent(cur));
    if (await adjust.run(row.registrationId, { kind, reason, ...(waiveAll ? { waiveAll: true } : { amountMinor: minor }) })) onChanged(t('adjusted', { name: row.participant }));
  };
  return (
    <Drawer open onClose={onClose} title={row.participant} kicker={row.programme}>
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex flex-wrap gap-2"><BalanceBadge state={row.balance.state as BalanceState} /><Badge tone="neutral" icon="card">{t(`planKind.${row.plan}`)}</Badge></div>
        <dl className="grid grid-cols-2 gap-1">
          <dt className="text-stone">{t('listFee')}</dt><dd><Amount amount={row.listFee.amount} currency={row.listFee.currency} /></dd>
          <dt className="text-stone">{t('paid')}</dt><dd><Amount amount={row.balance.paid} currency={cur} /></dd>
          <dt className="text-stone">{t('outstanding')}</dt><dd className="font-bold"><Amount amount={row.balance.outstanding} currency={cur} /></dd>
          <dt className="text-stone">{t('overdueLine')}</dt><dd className="text-danger"><Amount amount={row.balance.overdue} currency={cur} /></dd>
        </dl>
        <section><h3 className="mb-1 font-bold">{t('instalments')}</h3>
          <ol className="flex flex-col divide-y divide-line-soft">
            {row.instalments.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{t('instalmentLine', { seq: i.seq, date: fmtDate(i.dueOn, locale) })} · <Amount amount={i.amount.amount} currency={i.amount.currency} /></span>
                <span className="flex items-center gap-1.5">
                  <Badge tone={i.state === 'paid' ? 'success' : i.state === 'overdue' ? 'danger' : i.state === 'due' ? 'warning' : 'neutral'} icon={i.state === 'paid' ? 'check-circle' : i.state === 'overdue' ? 'alert' : 'clock'}>{t(`inst.${i.state}`)}</Badge>
                  {i.remindersSent > 0 && i.state !== 'paid' && <span className="text-xs text-stone"><Icon name="bell" size={12} className="inline" /> {t('reminded', { n: i.remindersSent })}</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
        {row.adjustments.length > 0 && <section><h3 className="mb-1 font-bold">{t('adjustments')}</h3>{row.adjustments.map((a, k) => <p key={k} className="text-xs">{t(`adjKind.${a.kind}`)} · <Amount amount={a.amount.amount} currency={a.amount.currency} />{a.reason ? ` · ${a.reason}` : ''}</p>)}</section>}
        {canAdjust && (
          <section className="flex flex-col gap-2 rounded-lg bg-canvas p-3">
            <h3 className="font-bold">{t('aidTitle')}</h3>
            <div className="flex gap-3">{(['financial_aid', 'waiver'] as const).map((k) => <label key={k} className="flex items-center gap-1.5"><input type="radio" name="adj-kind" checked={kind === k} onChange={() => setKind(k)} />{t(`adjKind.${k}`)}</label>)}</div>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={waiveAll} onChange={(e) => setWaiveAll(e.target.checked)} />{t('waiveAll')}</label>
            {!waiveAll && <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="adj-amt">{t('amount', { currency: cur })}</FieldLabel><input id="adj-amt" inputMode="decimal" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} /></div>}
            <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="adj-reason">{t('reason')}</FieldLabel><input id="adj-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            {adjust.error && <p role="alert" className="text-xs font-bold text-danger">{adjust.error.message}</p>}
            <p className="text-xs text-stone">{t('aidPreview', { amount: waiveAll ? t('everything') : `${amount || '0'} ${cur}` })}</p>
            <Button size="sm" disabled={reason.trim().length < 3 || (!waiveAll && !Number(amount))} loading={adjust.pending} onClick={() => void submit()}>{t('apply')}</Button>
          </section>
        )}
        <p className="text-xs text-stone">{t('refundNote')}</p>
      </div>
    </Drawer>
  );
}

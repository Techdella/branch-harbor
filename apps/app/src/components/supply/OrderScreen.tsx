'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, Textarea, Toggle, cx } from '@bh/ui';
import { DISCREPANCY_KINDS } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, LoadingBlock, SectionCard } from '../ui/States';
import { ActionError, useQFmt } from '../quality/ui';
import { downloadFile, supplyApi, useAction, useLoad, type PoVM } from './api';
import { PoBadge } from './SuppliersScreen';

/** One purchase order: approval (HQ), the supplier's confirmation, receiving (phone-friendly), receipts and history. */
export function OrderScreen({ id }: { id: string }) {
  const app = useApp();
  const res = useLoad(() => supplyApi.order(id), [app.org.id, id]);
  if (!app.hasModule('operations.suppliers')) return <DeniedState />;
  return (
    <Async res={res} loading={<LoadingBlock variant="detail" />}>
      {(p) => <Order p={p} reload={res.reload} />}
    </Async>
  );
}

function Order({ p, reload }: { p: PoVM; reload: () => void }) {
  const t = useTranslations('supply');
  const f = useQFmt();
  const act = useAction();
  const [note, setNote] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  const run = async (fn: () => Promise<PoVM>) => { const r = await act.run(fn); if (r) { if (r.confirmUrl) setLink(r.confirmUrl); reload(); } };
  return (
    <>
      <PageHeader icon="truck" title={t('order.title', { number: p.number })} description={`${p.locationName} · ${p.supplierName}`} scope={false} actions={
        <span className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" icon="download" onClick={() => void downloadFile(`/supply/orders/${p.id}/pdf`, `${p.number}.pdf`)}>{t('order.pdf')}</Button>
          <Button variant="ghost" size="sm" icon="download" onClick={() => void downloadFile(`/supply/orders/${p.id}/csv`, `${p.number}.csv`)}>{t('order.csv')}</Button>
        </span>
      } />
      <Link href="/suppliers?tab=orders" className="self-start text-[13px] font-bold underline">{t('order.back')}</Link>
      <ActionError error={act.error} />
      {link && <Banner tone="success" title={t('order.sentTitle')}>{t('order.sentBody')} <span className="break-all font-mono text-xs">{link}</span></Banner>}

      {p.status === 'pending_approval' && (
        <section className="flex flex-col gap-3 rounded-xl border-[1.5px] border-warning bg-warning-bg/40 p-4" data-testid="po-approval">
          <span className="flex flex-wrap items-center gap-2"><Badge tone="warning" icon="shield">{t('order.needsApproval')}</Badge><span className="text-[13px]">{t('order.aboveThreshold', { total: f.money(p.totalMinor, p.currency), threshold: p.approval.thresholdMinor === null ? '—' : f.money(p.approval.thresholdMinor, p.currency) })}</span></span>
          {p.notes && <p className="text-[13px]"><strong>{t('order.locationNote')}</strong> {p.notes}</p>}
          {p.can?.approve ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1"><Field label={t('order.decisionNote')} hint={t('order.decisionHint')} optional>{(x) => <Input id={x.id} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />}</Field></div>
              <Button variant="secondary" icon="x" loading={act.pending} disabled={!note} onClick={() => void run(() => supplyApi.decide(p.id, 'reject', note))}>{t('order.reject')}</Button>
              <Button icon="check" loading={act.pending} onClick={() => void run(() => supplyApi.decide(p.id, 'approve', note || undefined))}>{t('order.approve')}</Button>
            </div>
          ) : <p className="text-[13px] text-stone">{t('order.waitingHq')}</p>}
        </section>
      )}
      {p.status === 'rejected' && <Banner tone="danger" title={t('order.rejected')}>{p.approval.note}</Banner>}
      {p.status === 'partially_received' && <Banner tone="warning">{t('order.partial', { received: p.packs.received, ordered: p.packs.ordered })}</Banner>}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <SectionCard title={t('order.lines')} aside={<PoBadge status={p.status} />}>
          <ul className="flex flex-col divide-y divide-line-soft">
            {p.lines.map((l) => (
              <li key={l.itemId} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
                <span className="min-w-0 flex-1"><strong>{l.name}</strong><span className="block text-xs text-stone">{l.sku} · {l.packLabel}</span></span>
                <span className="tabular">{t('order.qtyPrice', { qty: l.quantity, price: f.money(l.unitPriceMinor, p.currency) })}</span>
                {l.confirmedQuantity !== null && l.confirmedQuantity < l.quantity && <Badge tone="warning">{t('order.confirmedShort', { n: l.confirmedQuantity })}</Badge>}
                {(l.received > 0 || l.damaged > 0) && <Badge tone={l.received >= l.quantity ? 'success' : 'warning'}>{t('order.receivedOf', { received: l.received, ordered: l.quantity })}</Badge>}
                {l.damaged > 0 && <Badge tone="danger">{t('order.damaged', { n: l.damaged })}</Badge>}
                <strong className="tabular w-24 text-right">{f.money(l.totalMinor, p.currency)}</strong>
              </li>
            ))}
          </ul>
          <p className="flex justify-end gap-3 text-[14px]"><span>{t('col.total')}</span><strong className="tabular">{f.money(p.totalMinor, p.currency)}</strong></p>
        </SectionCard>
        <SectionCard title={t('order.delivery')}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
            <dt className="text-stone">{t('col.expected')}</dt><dd className={cx(p.late && 'font-bold text-danger')}>{f.date(p.expectedDeliveryDate)}</dd>
            <dt className="text-stone">{t('order.requested')}</dt><dd>{f.date(p.requestedDeliveryDate)}</dd>
            <dt className="text-stone">{t('order.sentTo')}</dt><dd className="break-all">{p.sentTo ?? '—'}</dd>
            <dt className="text-stone">{t('order.supplierConfirmed')}</dt><dd>{p.confirmedAt ? `${f.date(p.confirmedAt)}${p.supplierReference ? ` · ${p.supplierReference}` : ''}` : p.supplierViewedAt ? t('order.viewedNotConfirmed') : '—'}</dd>
            <dt className="text-stone">{t('order.createdBy')}</dt><dd>{p.createdBy?.name ?? '—'}</dd>
          </dl>
          {p.supplierNote && <p className="text-[13px]"><strong>{t('order.supplierNote')}</strong> {p.supplierNote}</p>}
          <div className="flex flex-wrap gap-2">
            {p.can?.receive && !receiving && <Button icon="box" onClick={() => setReceiving(true)}>{t('order.receive')}</Button>}
            {p.can?.submit && <Button icon="send" loading={act.pending} onClick={() => void run(() => supplyApi.submit(p.id))}>{t('orders.submit')}</Button>}
            {p.can?.resend && <Button variant="secondary" icon="send" loading={act.pending} onClick={() => void run(() => supplyApi.resend(p.id))}>{t('order.resend')}</Button>}
            {p.can?.cancel && <Button variant="ghost" icon="x" loading={act.pending} onClick={() => void run(() => supplyApi.cancel(p.id))}>{t('order.cancel')}</Button>}
          </div>
        </SectionCard>
      </div>
      {receiving && <ReceiveForm p={p} onDone={() => { setReceiving(false); reload(); }} onCancel={() => setReceiving(false)} />}
      {!!p.receipts.length && (
        <SectionCard title={t('order.receipts')}>
          <ul className="flex flex-col gap-2">
            {p.receipts.map((r) => (
              <li key={r.id} className="rounded-md bg-canvas-raised p-3 text-[13px]">
                <span className="flex flex-wrap items-center gap-2"><strong>{f.date(r.receivedOn)}</strong><span className="text-stone">{r.receivedBy?.name}</span>{r.issues > 0 && <Badge tone="warning">{t('order.issues', { count: r.issues })}</Badge>}{r.inventory.length > 0 && <Badge tone="info" icon="box">{t('order.restocked', { count: r.inventory.length })}</Badge>}</span>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {r.lines.map((l) => {
                    const line = p.lines.find((x) => x.itemId === l.itemId);
                    return <li key={l.itemId}>{line?.name}: {t('order.receiptLine', { received: l.received, damaged: l.damaged })}{l.issue ? ` · ${t(`issue.${l.issue}` as 'issue.short')}` : ''}{l.note ? ` · ${l.note}` : ''}</li>;
                  })}
                </ul>
                {r.note && <p className="text-stone">{r.note}</p>}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
      <SectionCard title={t('order.history')}>
        <ol className="flex flex-col gap-1 text-[13px]">
          {p.history.map((h, i) => <li key={i} className="flex flex-wrap gap-2"><span className="text-stone">{f.shortDate(h.at)}</span><strong>{t.has(`event.${h.event}`) ? t(`event.${h.event}` as 'event.created') : h.event}</strong>{h.byName && <span>{h.byName}</span>}{h.note && <span className="text-stone">{h.note}</span>}</li>)}
        </ol>
      </SectionCard>
    </>
  );
}

/** Receiving: per line, good packs and damaged packs (steppers for the phone), an issue and a note; close short. */
function ReceiveForm({ p, onDone, onCancel }: { p: PoVM; onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('supply');
  const act = useAction();
  const open = p.lines.filter((l) => l.received < l.quantity);
  const [rows, setRows] = useState(() => Object.fromEntries(open.map((l) => [l.itemId, { received: l.quantity - l.received, damaged: 0, issue: '', note: '' }])));
  const [note, setNote] = useState('');
  const [closeShort, setCloseShort] = useState(false);
  const set = (id: string, patch: Partial<(typeof rows)[string]>) => setRows((r) => ({ ...r, [id]: { ...r[id]!, ...patch } }));
  const short = open.filter((l) => (rows[l.itemId]?.received ?? 0) < l.quantity - l.received);
  return (
    <section className="flex flex-col gap-3 rounded-xl bg-surface p-4" data-testid="po-receive">
      <h2 className="text-[16px] font-extrabold">{t('receive.title')}</h2>
      <p className="text-[13px] text-stone">{t('receive.hint')}</p>
      <ActionError error={act.error} />
      <ul className="flex flex-col gap-2">
        {open.map((l) => {
          const r = rows[l.itemId]!;
          const outstanding = l.quantity - l.received;
          return (
            <li key={l.itemId} className={cx('flex flex-col gap-2 rounded-lg border-[1.5px] p-3', r.received < outstanding || r.damaged ? 'border-warning' : 'border-line-soft')}>
              <span className="text-[14px]"><strong>{l.name}</strong><span className="block text-xs text-stone">{l.packLabel} · {t('receive.expecting', { n: outstanding })}</span></span>
              <div className="flex flex-wrap items-center gap-3">
                <Stepper label={t('receive.good')} value={r.received} onChange={(v) => set(l.itemId, { received: v })} />
                <Stepper label={t('receive.damagedLabel')} value={r.damaged} onChange={(v) => set(l.itemId, { damaged: v })} />
              </div>
              {(r.received < outstanding || r.damaged > 0 || r.issue) && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Select aria-label={t('receive.issue')} value={r.issue} onChange={(e) => set(l.itemId, { issue: e.target.value })}>
                    <option value="">{t('receive.noIssue')}</option>
                    {DISCREPANCY_KINDS.map((k) => <option key={k} value={k}>{t(`issue.${k}`)}</option>)}
                  </Select>
                  <Input aria-label={t('receive.note')} placeholder={t('receive.notePlaceholder')} value={r.note} maxLength={500} onChange={(e) => set(l.itemId, { note: e.target.value })} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Field label={t('receive.deliveryNote')} optional>{(x) => <Textarea id={x.id} className="min-h-14" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />}</Field>
      {!!short.length && <label className="flex items-center gap-2 text-[13px] font-bold"><Toggle checked={closeShort} label={t('receive.closeShort')} onChange={setCloseShort} />{t('receive.closeShort')}</label>}
      <div className="flex flex-wrap gap-2">
        <Button icon="check" size="lg" loading={act.pending} onClick={async () => {
          const lines = open.map((l) => ({ itemId: l.itemId, received: rows[l.itemId]!.received, damaged: rows[l.itemId]!.damaged, issue: rows[l.itemId]!.issue || null, note: rows[l.itemId]!.note }));
          if (await act.run(() => supplyApi.receive(p.id, { lines, note, closeShort }))) onDone();
        }}>{t('receive.confirm')}</Button>
        <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </section>
  );
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const t = useTranslations('supply');
  return (
    <span className="flex items-center gap-2">
      <span className="text-[13px] font-bold">{label}</span>
      <Button size="sm" variant="secondary" icon="minus" aria-label={t('receive.less', { label })} disabled={value <= 0} onClick={() => onChange(Math.max(0, value - 1))} />
      <span className="tabular w-8 text-center text-[16px] font-extrabold">{value}</span>
      <Button size="sm" variant="secondary" icon="plus" aria-label={t('receive.more', { label })} onClick={() => onChange(value + 1)} />
    </span>
  );
}

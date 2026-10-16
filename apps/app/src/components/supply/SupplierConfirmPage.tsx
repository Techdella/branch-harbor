'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Logo, Textarea } from '@bh/ui';
import type { Currency } from '@bh/shared';
import { fmtYmd, moneyWithCode } from '@/lib/format';
import { API_URL } from '@/lib/http/client';

interface PublicPo {
  number: string; status: string; currency: string; totalMinor: number; requestedDeliveryDate: string | null; expectedDeliveryDate: string | null; notes: string; organization: string; supplier: string; orderFormat: string;
  deliverTo: { name: string; address: { line1?: string; city?: string; postalCode?: string; country?: string } | null; phone: string | null };
  lines: Array<{ itemId: string; sku: string; name: string; packLabel: string; quantity: number; confirmedQuantity: number | null; unitPriceMinor: number; totalMinor: number }>;
  confirmedAt: string | null; supplierReference: string | null; supplierNote: string | null; canConfirm: boolean;
}

/**
 * The supplier's page (magic link from the order email, no login): the order, PDF / CSV downloads and a confirmation
 * with quantities and the delivery date. Nothing else about the business is exposed.
 */
export function SupplierConfirmPage({ token }: { token: string }) {
  const t = useTranslations('supply.public');
  const locale = useLocale();
  const [po, setPo] = useState<PublicPo | null>(null);
  const [error, setError] = useState<'not_found' | 'failed' | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [v, setV] = useState({ date: '', reference: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const base = `${API_URL}/v1/public/supply/po/${encodeURIComponent(token)}`;
  useEffect(() => {
    fetch(base).then(async (r) => {
      if (!r.ok) { setError(r.status === 404 ? 'not_found' : 'failed'); return; }
      const d = (await r.json()) as PublicPo;
      setPo(d);
      setQty(Object.fromEntries(d.lines.map((l) => [l.itemId, l.confirmedQuantity ?? l.quantity])));
      setV({ date: d.expectedDeliveryDate ?? d.requestedDeliveryDate ?? '', reference: d.supplierReference ?? '', note: d.supplierNote ?? '' });
    }, () => setError('failed'));
  }, [base]);
  const money = (m: number) => moneyWithCode({ amount: m, currency: (po?.currency ?? 'USD') as Currency }, locale);
  const date = (d: string | null) => (d ? fmtYmd(d.slice(0, 10), locale, { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
  const confirm = async () => {
    if (!po) return;
    setBusy(true);
    const r = await fetch(`${base}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedDeliveryDate: v.date, reference: v.reference || undefined, note: v.note || undefined, lines: po.lines.map((l) => ({ itemId: l.itemId, confirmedQuantity: qty[l.itemId] ?? l.quantity })) }) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setError('failed'); return; }
    setPo((await r.json()) as PublicPo);
    setDone(true);
    setError(null);
  };
  return (
    <main className="mx-auto flex min-h-viewport w-full max-w-3xl flex-col gap-4 px-4 py-6" data-testid="supplier-confirm">
      <header className="flex items-center gap-3"><Logo /><span className="text-xs text-stone">{t('kicker')}</span></header>
      {error === 'not_found' && <section className="rounded-xl bg-surface p-5"><h1 className="text-[20px] font-extrabold">{t('notFound')}</h1><p className="text-[14px] text-stone">{t('notFoundBody')}</p></section>}
      {error === 'failed' && <p role="alert" className="rounded-md bg-danger-bg p-3 text-[13px] font-bold text-danger">{t('failed')}</p>}
      {po && (
        <>
          <section className="flex flex-col gap-1 rounded-xl bg-surface p-5">
            <span className="text-xs font-bold uppercase text-stone">{t('from', { org: po.organization })}</span>
            <h1 className="text-[22px] font-extrabold">{t('title', { number: po.number })}</h1>
            <p className="text-[14px]">{t('hello', { supplier: po.supplier })}</p>
            <div className="mt-2 grid gap-3 text-[13px] sm:grid-cols-2">
              <div><span className="block text-xs font-bold uppercase text-stone">{t('deliverTo')}</span><strong>{po.deliverTo.name}</strong><span className="block">{[po.deliverTo.address?.line1, po.deliverTo.address?.city, po.deliverTo.address?.postalCode, po.deliverTo.address?.country].filter(Boolean).join(', ')}</span>{po.deliverTo.phone && <span className="block">{po.deliverTo.phone}</span>}</div>
              <div><span className="block text-xs font-bold uppercase text-stone">{t('requested')}</span><strong>{date(po.requestedDeliveryDate ?? po.expectedDeliveryDate)}</strong>{po.notes && <span className="block">{po.notes}</span>}</div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <a href={`${base}/order.pdf`} className="inline-flex h-10 items-center rounded-full bg-canvas-raised px-4 text-[13px] font-bold hover:bg-line-soft">{t('downloadPdf')}</a>
              <a href={`${base}/order.csv`} className="inline-flex h-10 items-center rounded-full bg-canvas-raised px-4 text-[13px] font-bold hover:bg-line-soft">{t('downloadCsv')}</a>
            </div>
          </section>
          <section className="flex flex-col gap-2 rounded-xl bg-surface p-5">
            <h2 className="text-[16px] font-extrabold">{t('lines')}</h2>
            <ul className="flex flex-col divide-y divide-line-soft">
              {po.lines.map((l) => (
                <li key={l.itemId} className="flex flex-wrap items-center gap-3 py-2 text-[13px]">
                  <span className="min-w-0 flex-1"><strong>{l.name}</strong><span className="block text-xs text-stone">{l.sku} · {l.packLabel} · {money(l.unitPriceMinor)}</span></span>
                  <span>{t('ordered', { n: l.quantity })}</span>
                  {po.canConfirm && !done ? (
                    <div className="w-20 shrink-0"><Input aria-label={t('confirmQty', { item: l.name })} type="number" min={0} value={qty[l.itemId] ?? l.quantity} onChange={(e) => setQty({ ...qty, [l.itemId]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></div>
                  ) : l.confirmedQuantity !== null && <Badge tone={l.confirmedQuantity < l.quantity ? 'warning' : 'success'}>{t('confirmed', { n: l.confirmedQuantity })}</Badge>}
                  <strong className="tabular w-24 text-right">{money(l.totalMinor)}</strong>
                </li>
              ))}
            </ul>
            <p className="flex justify-end gap-3 text-[15px]"><span>{t('total')}</span><strong className="tabular">{money(po.totalMinor)}</strong></p>
          </section>
          {po.confirmedAt && (done || !po.canConfirm) ? (
            <section className="rounded-xl bg-success-bg p-5 text-[14px]" role="status"><strong>{t('thanks')}</strong> {t('thanksBody', { date: date(po.expectedDeliveryDate) })}</section>
          ) : po.canConfirm ? (
            <section className="flex flex-col gap-3 rounded-xl bg-surface p-5">
              <h2 className="text-[16px] font-extrabold">{po.confirmedAt ? t('update') : t('confirmTitle')}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('deliveryDate')}>{(x) => <Input id={x.id} type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />}</Field>
                <Field label={t('reference')} optional>{(x) => <Input id={x.id} value={v.reference} maxLength={80} onChange={(e) => setV({ ...v, reference: e.target.value })} />}</Field>
              </div>
              <Field label={t('note')} optional>{(x) => <Textarea id={x.id} value={v.note} maxLength={1000} onChange={(e) => setV({ ...v, note: e.target.value })} />}</Field>
              <Button size="lg" icon="check" className="self-start" disabled={!v.date} loading={busy} onClick={() => void confirm()}>{t('confirm')}</Button>
              <p className="text-xs text-stone">{t('privacy')}</p>
            </section>
          ) : <section className="rounded-xl bg-surface p-5 text-[14px]">{t('closed')}</section>}
        </>
      )}
    </main>
  );
}

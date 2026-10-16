'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Input, Select, cx } from '@bh/ui';
import { REBATE_PERIODS, fromMajor, type Currency, type RebateProgrammeBody } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, DeniedState, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { ActionError, Tiles, useQFmt } from '../quality/ui';
import { downloadFile, supplyApi, useAction, useLoad, type ClaimVM, type ProgrammeVM } from './api';

const CLAIM_TONE = { draft: 'neutral', submitted: 'info', received: 'success', void: 'neutral' } as const;

/**
 * Finance → Supplier rebates (HQ). Programmes negotiated with suppliers (percent of spend or per pack, tiered by
 * volume), the current period's accrual and the next tier, claims with a statement per location, and the share paid
 * into the marketing fund when a rebate is received. Amounts stay in the programme's currency.
 */
export function RebatesScreen() {
  const t = useTranslations('supply');
  const app = useApp();
  const f = useQFmt();
  const res = useLoad(() => supplyApi.rebates(), [app.org.id]);
  const [editing, setEditing] = useState<ProgrammeVM | 'new' | null>(null);
  if (!app.hasModule('finance.supplier_rebates')) return <DeniedState />;
  return (
    <>
      <PageHeader icon="receipt" title={t('rebates.title')} description={t('rebates.description')} scope={false} actions={res.data?.can.edit ? <Button icon="plus" onClick={() => setEditing('new')}>{t('rebates.add')}</Button> : undefined} />
      <Async res={res} loading={<LoadingBlock variant="cards" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="receipt" title={t('rebates.empty')} body={t('rebates.emptyBody')} />}>
        {(d) => (
          <div className="flex flex-col gap-3" data-testid="rebates">
            <Tiles items={d.totals.flatMap((x) => [
              { label: t('rebates.accrued', { currency: x.currency }), value: f.money(x.accruedMinor, x.currency), sub: t('rebates.accruedSub') },
              { label: t('rebates.claimedOpen', { currency: x.currency }), value: f.money(x.claimedOpenMinor, x.currency) },
              { label: t('rebates.received', { currency: x.currency }), value: f.money(x.receivedMinor, x.currency), sub: t('rebates.toFund', { amount: f.money(x.fundShareMinor, x.currency) }) },
            ])} />
            {d.items.map((p) => <Programme key={p.id} p={p} canEdit={d.can.edit} canExport={d.can.export} onEdit={() => setEditing(p)} reload={res.reload} />)}
          </div>
        )}
      </Async>
      {editing && <ProgrammeDrawer p={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); res.reload(); }} />}
    </>
  );
}

function rateText(t: ReturnType<typeof useTranslations<'supply'>>, f: ReturnType<typeof useQFmt>, p: Pick<ProgrammeVM, 'basis' | 'currency'>, rate: number) {
  return p.basis === 'percent' ? t('rebates.ratePct', { pct: f.num(rate / 100, 2) }) : t('rebates.ratePerPack', { amount: f.money(rate, p.currency) });
}

function Programme({ p, canEdit, canExport, onEdit, reload }: { p: ProgrammeVM; canEdit: boolean; canExport: boolean; onEdit: () => void; reload: () => void }) {
  const t = useTranslations('supply');
  const f = useQFmt();
  const act = useAction();
  const c = p.current;
  const vol = (n: number) => (p.measure === 'spend' ? f.money(n, p.currency) : t('rebates.packs', { n: f.num(n) }));
  const top = p.tiers[p.tiers.length - 1]!.from || 1;
  const progress = Math.min(100, Math.round((c.volume / (c.next?.from ?? top)) * 100));
  return (
    <SectionCard title={`${p.supplierName} · ${p.name}`} aside={canEdit ? <Button size="sm" variant="ghost" icon="edit" onClick={onEdit}>{t('common.edit')}</Button> : undefined}>
      <ActionError error={act.error} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-bold uppercase text-stone">{t('rebates.current', { period: c.label })}</span>
          <span className="flex flex-wrap items-baseline gap-2"><strong className="tabular text-[24px]">{f.money(c.accruedMinor, p.currency)}</strong><span className="text-[13px]">{t('rebates.on', { volume: vol(c.volume) })}</span></span>
          <span className="flex h-2.5 overflow-hidden rounded-full bg-line-soft" role="img" aria-label={c.next ? t('rebates.toNext', { remaining: vol(c.next.remaining), rate: rateText(t, f, p, c.next.rate) }) : t('rebates.topTier')}>
            <span className="bg-ink" style={{ width: `${progress}%` }} />
          </span>
          <span className="text-[13px]">{c.next ? t('rebates.toNext', { remaining: vol(c.next.remaining), rate: rateText(t, f, p, c.next.rate) }) : t('rebates.topTier')}</span>
          <ol className="flex flex-wrap gap-1.5">
            {p.tiers.map((tier, i) => <li key={i}><Badge tone={i === c.tierIndex ? 'success' : 'neutral'}>{t('rebates.tier', { n: i + 1, from: vol(tier.from), rate: rateText(t, f, p, tier.rate) })}</Badge></li>)}
          </ol>
          {p.fundSharePct > 0 && <span className="text-xs text-stone">{t('rebates.fundShare', { pct: p.fundSharePct, amount: f.money(c.fundShareMinor, p.currency) })}</span>}
          {!!c.locations.length && (
            <ul className="flex flex-col gap-0.5 text-[13px]">
              {c.locations.map((l) => <li key={l.locationId} className="flex justify-between"><span>{l.name}</span><span className="tabular">{vol(p.measure === 'spend' ? l.spendMinor : l.units)}</span></li>)}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-bold uppercase text-stone">{t('rebates.claims')}</span>
          {p.claimable && canEdit && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-signal/30 p-3 text-[13px]">
              <span className="flex-1">{t('rebates.claimable', { period: p.claimable.label, amount: f.money(p.claimable.accruedMinor, p.currency) })}</span>
              <Button size="sm" icon="receipt" loading={act.pending} onClick={async () => { if (await act.run(() => supplyApi.claim(p.id, p.claimable!.start))) reload(); }}>{t('rebates.raise')}</Button>
            </div>
          )}
          {p.claims.length ? (
            <ul className="flex flex-col gap-1.5">
              {p.claims.map((cl) => <Claim key={cl.id} c={cl} canEdit={canEdit} canExport={canExport} reload={reload} />)}
            </ul>
          ) : <p className="text-sm text-stone">{t('rebates.noClaims')}</p>}
        </div>
      </div>
    </SectionCard>
  );
}

function Claim({ c, canEdit, canExport, reload }: { c: ClaimVM; canEdit: boolean; canExport: boolean; reload: () => void }) {
  const t = useTranslations('supply');
  const f = useQFmt();
  const act = useAction();
  const [amount, setAmount] = useState<string | null>(null);
  return (
    <li className={cx('flex flex-col gap-1.5 rounded-md bg-canvas-raised p-3 text-[13px]', c.status === 'void' && 'opacity-60')}>
      <span className="flex flex-wrap items-center gap-2">
        <strong>{c.number}</strong><span className="text-stone">{c.periodLabel}</span><span className="flex-1" />
        <strong className="tabular">{f.money(c.amountMinor, c.currency)}</strong>
        <Badge tone={CLAIM_TONE[c.status]}>{t(`claimStatus.${c.status}`)}</Badge>
      </span>
      {c.status === 'received' && <span className="text-xs text-success">{t('rebates.receivedLine', { amount: f.money(c.receivedMinor ?? 0, c.currency), fund: f.money(c.fundShareMinor ?? 0, c.currency) })}</span>}
      <ActionError error={act.error} />
      <span className="flex flex-wrap gap-1.5">
        {canExport && <Button size="sm" variant="ghost" icon="download" onClick={() => void downloadFile(`/supply/rebates/claims/${c.id}/statement`, `${c.number}.pdf`, { format: 'pdf' })}>{t('rebates.statementPdf')}</Button>}
        {canExport && <Button size="sm" variant="ghost" icon="download" onClick={() => void downloadFile(`/supply/rebates/claims/${c.id}/statement`, `${c.number}.csv`, { format: 'csv' })}>{t('rebates.statementCsv')}</Button>}
        {canEdit && c.status === 'draft' && <Button size="sm" icon="send" loading={act.pending} onClick={async () => { if (await act.run(() => supplyApi.submitClaim(c.id))) reload(); }}>{t('rebates.markSent')}</Button>}
        {canEdit && (c.status === 'draft' || c.status === 'submitted') && amount === null && <Button size="sm" variant="secondary" icon="check" onClick={() => setAmount(String(c.amountMinor / 100))}>{t('rebates.markReceived')}</Button>}
        {canEdit && (c.status === 'draft' || c.status === 'submitted') && <Button size="sm" variant="ghost" icon="x" loading={act.pending} onClick={async () => { if (await act.run(() => supplyApi.voidClaim(c.id))) reload(); }}>{t('rebates.void')}</Button>}
      </span>
      {amount !== null && (
        <span className="flex flex-wrap items-end gap-2">
          <div className="w-36 shrink-0"><Input aria-label={t('rebates.amountReceived', { currency: c.currency })} type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <Button size="sm" icon="check" loading={act.pending} onClick={async () => { if (await act.run(() => supplyApi.claimReceived(c.id, fromMajor(Number(amount), c.currency as Currency).amount, new Date().toISOString().slice(0, 10)))) { setAmount(null); reload(); } }}>{t('common.save')}</Button>
        </span>
      )}
    </li>
  );
}

function ProgrammeDrawer({ p, onClose, onDone }: { p: ProgrammeVM | null; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('supply');
  const app = useApp();
  const act = useAction();
  const suppliers = useLoad(() => supplyApi.suppliers({ status: 'all' }), [app.org.id]);
  const [v, setV] = useState({ supplierId: p?.supplierId ?? '', name: p?.name ?? '', basis: p?.basis ?? 'percent', measure: p?.measure ?? 'spend', currency: p?.currency ?? 'USD', period: p?.period ?? 'quarter', startsOn: p?.startsOn ?? new Date().toISOString().slice(0, 10), endsOn: p?.endsOn ?? '', fundSharePct: p?.fundSharePct ?? 0 });
  const [tiers, setTiers] = useState<Array<{ from: string; rate: string }>>(p ? p.tiers.map((x) => ({ from: String(v.measure === 'spend' ? x.from / 100 : x.from), rate: String(v.basis === 'percent' ? x.rate / 100 : x.rate / 100) })) : [{ from: '0', rate: '' }]);
  const body = (): RebateProgrammeBody => ({
    supplierId: v.supplierId, name: v.name, basis: v.basis as RebateProgrammeBody['basis'], measure: v.measure as RebateProgrammeBody['measure'], currency: v.currency as Currency, period: v.period as RebateProgrammeBody['period'],
    startsOn: v.startsOn, endsOn: v.endsOn || null, itemIds: p?.itemIds ?? [], fundSharePct: Number(v.fundSharePct) || 0, active: true,
    tiers: tiers.filter((x) => x.rate !== '').map((x) => ({ from: v.measure === 'spend' ? fromMajor(Number(x.from) || 0, v.currency as Currency).amount : Math.round(Number(x.from) || 0), rate: Math.round((Number(x.rate) || 0) * 100) })),
  });
  return (
    <Drawer open onClose={onClose} title={p ? p.name : t('rebates.add')} footer={<Button icon="check" disabled={!v.supplierId || !v.name || !tiers.some((x) => x.rate !== '')} loading={act.pending} onClick={async () => { if (await act.run(() => (p ? supplyApi.saveProgramme(p.id, body()) : supplyApi.createProgramme(body())))) onDone(); }}>{t('common.save')}</Button>}>
      <div className="flex flex-col gap-3">
        <ActionError error={act.error} />
        <Field label={t('col.supplier')}>{(x) => <Select id={x.id} value={v.supplierId} onChange={(e) => { const s = suppliers.data?.items.find((y) => y.id === e.target.value); setV({ ...v, supplierId: e.target.value, currency: s?.currency ?? v.currency }); }}><option value="">{t('common.choose')}</option>{(suppliers.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        <Field label={t('rebates.name')}>{(x) => <Input id={x.id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('rebates.basis')}>{(x) => <Select id={x.id} value={v.basis} onChange={(e) => setV({ ...v, basis: e.target.value as typeof v.basis })}><option value="percent">{t('rebates.basisPercent')}</option><option value="per_unit">{t('rebates.basisPerUnit')}</option></Select>}</Field>
          <Field label={t('rebates.measure')}>{(x) => <Select id={x.id} value={v.measure} onChange={(e) => setV({ ...v, measure: e.target.value as typeof v.measure })}><option value="spend">{t('rebates.measureSpend')}</option><option value="units">{t('rebates.measureUnits')}</option></Select>}</Field>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label={t('suppliers.currency')}>{(x) => <Input id={x.id} value={v.currency} maxLength={3} onChange={(e) => setV({ ...v, currency: e.target.value.toUpperCase() as Currency })} />}</Field>
          <Field label={t('rebates.period')}>{(x) => <Select id={x.id} value={v.period} onChange={(e) => setV({ ...v, period: e.target.value as typeof v.period })}>{REBATE_PERIODS.map((r) => <option key={r} value={r}>{t(`rebates.periods.${r}`)}</option>)}</Select>}</Field>
          <Field label={t('rebates.fundPct')}>{(x) => <Input id={x.id} type="number" min={0} max={100} value={v.fundSharePct} onChange={(e) => setV({ ...v, fundSharePct: Number(e.target.value) })} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('suppliers.startsOn')}>{(x) => <Input id={x.id} type="date" value={v.startsOn} onChange={(e) => setV({ ...v, startsOn: e.target.value })} />}</Field>
          <Field label={t('suppliers.endsOn')} optional>{(x) => <Input id={x.id} type="date" value={v.endsOn} onChange={(e) => setV({ ...v, endsOn: e.target.value })} />}</Field>
        </div>
        <span className="text-[13px] font-bold">{t('rebates.tiers')}</span>
        <p className="text-xs text-stone">{t('rebates.tiersHint')}</p>
        {tiers.map((x, i) => (
          <div key={i} className="grid grid-cols-2 gap-2">
            <Input aria-label={v.measure === 'spend' ? t('rebates.fromSpend', { currency: v.currency }) : t('rebates.fromPacks')} type="number" min={0} value={x.from} onChange={(e) => setTiers(tiers.map((y, k) => (k === i ? { ...y, from: e.target.value } : y)))} />
            <Input aria-label={v.basis === 'percent' ? t('rebates.ratePctLabel') : t('rebates.ratePerPackLabel', { currency: v.currency })} type="number" min={0} step="0.01" value={x.rate} onChange={(e) => setTiers(tiers.map((y, k) => (k === i ? { ...y, rate: e.target.value } : y)))} />
          </div>
        ))}
        <Button size="sm" variant="ghost" icon="plus" className="self-start" onClick={() => setTiers([...tiers, { from: '', rate: '' }])}>{t('rebates.addTier')}</Button>
      </div>
    </Drawer>
  );
}

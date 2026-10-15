'use client';

import { useState } from 'react';
import { Badge, Button, DataTable, Drawer, Input, Select, Tabs } from '@bh/ui';
import { cx as call, useAction, useCommerce } from '@/lib/commerce/client';
import type { Alert, CountDetail, CountSummary, Movement, StockExplanation, StockRow } from '@/lib/commerce/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, SectionCard } from '../../ui/States';
import { ActionError, F, NumberInput, StatusBadge, StorePicker, View, When, useCt, useStore } from './kit';

type Tab = 'stock' | 'alerts' | 'history' | 'counts';
const REASONS = ['received', 'damage', 'shrinkage', 'found', 'correction', 'supplier_return', 'adjustment'] as const;

/** Inventory: stock per store (on hand / reserved / available), adjustments with reasons, reorder alerts, ledger history, cycle counts. */
export function InventoryScreen() {
  const t = useCt();
  const app = useApp();
  const [tab, setTab] = useState<Tab>('stock');
  const [loc, setLoc] = useStore();
  const [adjust, setAdjust] = useState<StockRow | null>(null);
  const [explain, setExplain] = useState<StockRow | null>(null);
  const stock = useCommerce(() => call<{ items: StockRow[] }>('GET', '/inventory', undefined, { locationId: loc }), [loc], !!loc && tab === 'stock');
  const alerts = useCommerce(() => call<{ items: Alert[] }>('GET', '/inventory/alerts'), [app.org.id, tab], tab === 'alerts');
  const history = useCommerce(() => call<{ items: Movement[] }>('GET', '/stock-movements', undefined, { locationId: loc, limit: 200 }), [loc, app.org.id, tab], !!loc && tab === 'history');
  const ids = app.scope.locationIds;

  return (
    <>
      <PageHeader icon="box" title={t('inventory.title')} description={t('inventory.description')} actions={tab !== 'alerts' && <StorePicker value={loc} onChange={setLoc} />} />
      <SectionCard>
        <Tabs className="mb-3" value={tab} onChange={setTab} items={(['stock', 'alerts', 'history', 'counts'] as const).map((k) => ({ key: k, label: t(`inventory.tabs.${k}`) }))} />
        {tab === 'stock' && (
          <View res={stock} isEmpty={(d) => !d.items.length} empty={<Empty icon="box" title={t('inventory.empty')} />}>
            {(d) => (
              <DataTable rows={d.items} rowKey={(r) => r.variantId} columns={[
                { key: 'item', header: t('inventory.item'), render: (r) => <span><span className="block font-semibold">{r.productName} — {r.name}</span><span className="text-xs text-stone">{r.sku}</span></span> },
                { key: 'onHand', header: t('inventory.onHand'), align: 'right', render: (r) => r.onHand },
                { key: 'reserved', header: t('inventory.reserved'), align: 'right', render: (r) => r.reserved },
                { key: 'available', header: t('inventory.available'), align: 'right', render: (r) => <span className="font-bold">{r.available}</span> },
                { key: 'flag', header: t('inventory.status'), render: (r) => r.available <= 0 ? <Badge tone="danger">{t('inventory.out')}</Badge> : r.lowStock ? <Badge tone="warning">{t('inventory.low', { point: r.reorderPoint ?? '—' })}</Badge> : <Badge tone="success">{t('inventory.ok')}</Badge> },
                { key: 'last', header: t('inventory.lastMovement'), render: (r) => <When iso={r.lastMovementAt} /> },
                { key: 'act', header: '', render: (r) => (
                  <span className="flex gap-1">
                    {app.can('operations.write') && <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setAdjust(r); }}>{t('inventory.adjust')}</Button>}
                    <Button size="sm" variant="ghost" icon="sparkles" onClick={(e) => { e.stopPropagation(); setExplain(r); }}>{t('inventory.explain')}</Button>
                  </span>
                ) },
              ]} />
            )}
          </View>
        )}
        {tab === 'alerts' && (
          <View res={alerts} isEmpty={(d) => !d.items.length} empty={<Empty icon="check-circle" title={t('inventory.noAlerts')} />}>
            {(d) => (
              <DataTable rows={d.items.filter((a) => !ids.length || ids.includes(a.locationId))} rowKey={(a) => `${a.locationId}:${a.variantId}`} columns={[
                { key: 'item', header: t('inventory.item'), render: (a) => <span><span className="block font-semibold">{a.name}</span><span className="text-xs text-stone">{a.locationName}</span></span> },
                { key: 'sev', header: t('inventory.status'), render: (a) => <Badge tone={a.severity === 'out' ? 'danger' : 'warning'}>{a.severity === 'out' ? t('inventory.out') : t('inventory.low', { point: a.reorderPoint ?? '—' })}</Badge> },
                { key: 'avail', header: t('inventory.available'), align: 'right', render: (a) => a.available },
                { key: 'onOrder', header: t('inventory.onOrder'), align: 'right', render: (a) => a.onOrder },
                { key: 'incoming', header: t('inventory.incoming'), align: 'right', render: (a) => a.incoming },
                { key: 'bo', header: t('inventory.backordered'), align: 'right', render: (a) => a.backordered },
                { key: 'sug', header: t('inventory.suggested'), align: 'right', render: (a) => <span className="font-bold">{a.suggestedQty}</span> },
              ]} />
            )}
          </View>
        )}
        {tab === 'history' && (
          <View res={history} isEmpty={(d) => !d.items.length} empty={<Empty icon="list" title={t('inventory.noHistory')} />}>
            {(d) => (
              <DataTable rows={d.items} rowKey={(m) => m.id} columns={[
                { key: 'when', header: t('inventory.when'), render: (m) => <When iso={m.createdAt} tz={m.location.timeZone} /> },
                { key: 'item', header: t('inventory.item'), render: (m) => <span>{m.variant.productName} — {m.variant.name}</span> },
                { key: 'reason', header: t('inventory.reason'), render: (m) => <span>{m.reasonLabel}{!m.affectsOnHand && <span className="ms-1 text-xs text-stone">({t('inventory.notPhysical')})</span>}</span> },
                { key: 'qty', header: t('inventory.qty'), align: 'right', render: (m) => <span className={m.quantity < 0 ? 'text-danger' : 'text-success'}>{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</span> },
                { key: 'bal', header: t('inventory.balance'), align: 'right', render: (m) => m.balanceAfter ?? '—' },
                { key: 'note', header: t('inventory.note'), render: (m) => <span className="text-xs">{[m.note, m.reference].filter(Boolean).join(' · ')}</span> },
                { key: 'by', header: t('inventory.by'), render: (m) => m.createdByName },
              ]} />
            )}
          </View>
        )}
        {tab === 'counts' && <Counts loc={loc} />}
      </SectionCard>
      {adjust && <AdjustDrawer row={adjust} onClose={() => setAdjust(null)} onDone={() => { setAdjust(null); stock.reload(); }} />}
      {explain && <ExplainDrawer row={explain} onClose={() => setExplain(null)} />}
    </>
  );
}

function AdjustDrawer({ row, onClose, onDone }: { row: StockRow; onClose: () => void; onDone: () => void }) {
  const t = useCt();
  const [qty, setQty] = useState(1);
  const [dir, setDir] = useState<1 | -1>(-1);
  const [reason, setReason] = useState<(typeof REASONS)[number]>('damage');
  const [note, setNote] = useState('');
  const save = useAction(() => call('POST', '/stock-movements', { locationId: row.locationId, variantId: row.variantId, quantity: qty * dir, reason, note: note || undefined }));
  return (
    <Drawer open onClose={onClose} kicker={t('inventory.adjust')} title={`${row.productName} — ${row.name}`}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-stone">{t('inventory.adjustHint', { onHand: row.onHand, reserved: row.reserved })}</p>
        <F label={t('inventory.reason')}><Select value={reason} onChange={(e) => { const r = e.target.value as (typeof REASONS)[number]; setReason(r); setDir(['received', 'found'].includes(r) ? 1 : -1); }}>{REASONS.map((r) => <option key={r} value={r}>{t(`inventory.reasons.${r}`)}</option>)}</Select></F>
        <div className="flex items-center gap-2">
          <Select value={String(dir)} onChange={(e) => setDir(Number(e.target.value) as 1 | -1)} className="h-10 w-32" aria-label={t('inventory.direction')}><option value="1">{t('inventory.add')}</option><option value="-1">{t('inventory.remove')}</option></Select>
          <NumberInput value={qty} onChange={setQty} min={1} label={t('inventory.qty')} />
        </div>
        <F label={t('inventory.note')} optional><Input value={note} onChange={(e) => setNote(e.target.value)} /></F>
        <ActionError error={save.error} />
        <Button loading={save.pending} disabled={!qty || qty < 1} onClick={async () => { if (await save.run()) onDone(); }}>{t('inventory.record', { qty: `${dir > 0 ? '+' : '−'}${qty}` })}</Button>
      </div>
    </Drawer>
  );
}

function ExplainDrawer({ row, onClose }: { row: StockRow; onClose: () => void }) {
  const t = useCt();
  const res = useCommerce(() => call<StockExplanation>('GET', '/ai/stock-explainer', undefined, { locationId: row.locationId, variantId: row.variantId, days: 30 }), [row.variantId]);
  return (
    <Drawer open onClose={onClose} kicker={t('inventory.explainKicker')} title={`${row.productName} — ${row.name}`}>
      <View res={res}>
        {(e) => (
          <div className="flex flex-col gap-3 text-sm">
            {e.narrative ? <p className="rounded-md bg-canvas-raised p-3">{e.narrative}</p> : <Banner tone="neutral" icon="info">{e.aiAvailable ? t('inventory.noNarrative') : t('inventory.aiOff')}</Banner>}
            <h3 className="font-bold">{t('inventory.observations')}</h3>
            <ul className="ms-5 list-disc">{e.observations.map((o) => <li key={o}>{o}</li>)}</ul>
            {e.hypotheses.length > 0 && <><h3 className="font-bold">{t('inventory.hypotheses')}</h3><ul className="ms-5 list-disc text-stone">{e.hypotheses.map((o) => <li key={o}>{o}</li>)}</ul></>}
            <h3 className="font-bold">{t('inventory.sources')}</h3>
            <ul className="flex flex-col gap-1 text-xs">{e.findings.map((f) => <li key={f.reason}><strong>{f.label}</strong> · {f.units > 0 ? `+${f.units}` : f.units} · {f.citations.map((c) => c.id.slice(0, 8)).join(', ')}{f.more ? ` +${f.more}` : ''}</li>)}</ul>
            <p className="text-xs text-stone">{e.source} · <When iso={e.asOf} /></p>
          </div>
        )}
      </View>
    </Drawer>
  );
}

function Counts({ loc }: { loc: string }) {
  const t = useCt();
  const app = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const list = useCommerce(() => call<{ items: CountSummary[] }>('GET', '/stock-counts'), [app.org.id]);
  const create = useAction(async () => { const c = await call<CountDetail>('POST', '/stock-counts', { locationId: loc, name: name || t('inventory.defaultCountName') }); list.reload(); setOpen(c.id); return c; });
  return (
    <div className="flex flex-col gap-3">
      {app.can('operations.write') && (
        <div className="flex flex-wrap items-center gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('inventory.countName')} aria-label={t('inventory.countName')} className="h-10 max-w-xs" />
          <Button icon="plus" loading={create.pending} onClick={() => create.run()}>{t('inventory.newCount')}</Button>
        </div>
      )}
      <ActionError error={create.error} />
      <View res={list} isEmpty={(d) => !d.items.length} empty={<Empty icon="list" title={t('inventory.noCounts')} />}>
        {(d) => (
          <DataTable rows={d.items.filter((c) => !loc || c.locationId === loc)} rowKey={(c) => c.id} onRowClick={(c) => setOpen(c.id)} columns={[
            { key: 'name', header: t('inventory.countName'), render: (c) => <span className="font-semibold">{c.name}</span> },
            { key: 'status', header: t('inventory.status'), render: (c) => <StatusBadge kind="count" value={c.status} /> },
            { key: 'progress', header: t('inventory.progress'), render: (c) => `${c.counted}/${c.lines}` },
            { key: 'var', header: t('inventory.variance'), align: 'right', render: (c) => c.varianceUnits },
            { key: 'when', header: t('inventory.when'), render: (c) => <When iso={c.createdAt} /> },
          ]} />
        )}
      </View>
      {open && <CountDrawer id={open} onClose={() => { setOpen(null); list.reload(); }} />}
    </div>
  );
}

function CountDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useCt();
  const app = useApp();
  const res = useCommerce(() => call<CountDetail>('GET', `/stock-counts/${id}`), [id]);
  const [vals, setVals] = useState<Record<string, number>>({});
  const act = useAction(async (path: string, body?: unknown) => { const r = await call<CountDetail | { count: CountDetail }>('POST', path, body); res.reload(); return r; });
  return (
    <Drawer open onClose={onClose} kicker={t('inventory.countKicker')} title={res.data?.name ?? ''}>
      <View res={res}>
        {(c) => (
          <div className="flex flex-col gap-3 text-sm">
            <StatusBadge kind="count" value={c.status} />
            <p className="text-xs text-stone">{t('inventory.countHint')}</p>
            <ul className="flex flex-col gap-1.5">
              {c.lines.map((l) => (
                <li key={l.variantId} className="flex items-center gap-2 rounded-md bg-canvas-raised px-3 py-2">
                  <span className="flex-1"><span className="block font-semibold">{l.name}</span><span className="text-xs text-stone">{l.sku}{l.expectedQty !== null ? ` · ${t('inventory.expected', { n: l.expectedQty })}` : ''}</span></span>
                  {c.status === 'in_progress' ? <NumberInput value={vals[l.variantId] ?? l.countedQty ?? NaN} onChange={(n) => setVals((v) => ({ ...v, [l.variantId]: n }))} label={t('inventory.counted', { name: l.name })} /> : <span>{l.countedQty ?? '—'}</span>}
                  {l.variance !== null && l.variance !== 0 && <Badge tone="warning">{l.variance > 0 ? `+${l.variance}` : l.variance}</Badge>}
                </li>
              ))}
            </ul>
            <ActionError error={act.error} />
            {c.status === 'in_progress' && (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" disabled={!Object.keys(vals).length} onClick={async () => { if (await act.run(`/stock-counts/${id}/entries`, { entries: Object.entries(vals).filter(([, n]) => Number.isFinite(n)).map(([variantId, countedQty]) => ({ variantId, countedQty })) })) setVals({}); }}>{t('inventory.saveCounts')}</Button>
                <Button onClick={() => act.run(`/stock-counts/${id}/submit`)}>{t('inventory.submit')}</Button>
              </div>
            )}
            {c.status === 'submitted' && (app.can('locations.read') ? <Button onClick={() => act.run(`/stock-counts/${id}/apply`)}>{t('inventory.apply')}</Button> : <Banner tone="neutral" icon="lock">{t('inventory.applyManager')}</Banner>)}
          </div>
        )}
      </View>
    </Drawer>
  );
}

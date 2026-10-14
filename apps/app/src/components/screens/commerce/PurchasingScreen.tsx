'use client';

import { useState } from 'react';
import { Button, DataTable, Drawer, Input, Select } from '@bh/ui';
import { cx as call, useAction, useCommerce } from '@/lib/commerce/client';
import type { AssortmentItem, PurchaseOrderView, Supplier } from '@/lib/commerce/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, SectionCard } from '../../ui/States';
import { ActionError, F, Money, MoneyInput, NumberInput, StatusBadge, View, When, useCt, useScopeStores } from './kit';

/** Suppliers and purchase orders (basic): draft → sent → received (stock arrives as `received` movements). */
export function PurchasingScreen() {
  const t = useCt();
  const app = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const pos = useCommerce(() => call<{ items: PurchaseOrderView[] }>('GET', '/purchase-orders'), [app.org.id, app.apiMode]);
  const sups = useCommerce(() => call<{ items: Supplier[] }>('GET', '/suppliers'), [app.org.id, app.apiMode]);
  const [sup, setSup] = useState({ name: '', currency: app.org.defaultCurrency as string, email: '' });
  const addSup = useAction(async () => { const r = await call<Supplier>('POST', '/suppliers', { name: sup.name, currency: sup.currency, email: sup.email || null }); sups.reload(); setSup({ ...sup, name: '', email: '' }); return r; });
  const manager = app.can('locations.read') && app.can('operations.write');
  const ids = app.scope.locationIds;
  const sel = pos.data?.items.find((p) => p.id === open);
  return (
    <>
      <PageHeader icon="file" title={t('purchasing.title')} description={t('purchasing.description')} actions={manager && <Button icon="plus" onClick={() => setCreating(true)}>{t('purchasing.newPo')}</Button>} />
      <SectionCard title={t('purchasing.orders')}>
        <View res={pos} isEmpty={(d) => !d.items.length} empty={<Empty icon="file" title={t('purchasing.empty')} />}>
          {(d) => (
            <DataTable rows={d.items.filter((p) => !ids.length || ids.includes(p.locationId))} rowKey={(p) => p.id} onRowClick={(p) => setOpen(p.id)} columns={[
              { key: 'n', header: t('purchasing.number'), render: (p) => <span className="font-bold">{p.number}</span> },
              { key: 's', header: t('purchasing.supplier'), render: (p) => p.supplierName },
              { key: 'l', header: t('common.store'), render: (p) => p.locationName },
              { key: 'st', header: t('purchasing.status'), render: (p) => <StatusBadge kind="po" value={p.status} /> },
              { key: 'u', header: t('purchasing.units'), align: 'right', render: (p) => `${p.units.received}/${p.units.ordered}` },
              { key: 't', header: t('purchasing.total'), align: 'right', render: (p) => <Money m={p.total} /> },
              { key: 'e', header: t('purchasing.expected'), render: (p) => <When iso={p.expectedAt} /> },
            ]} />
          )}
        </View>
      </SectionCard>
      <SectionCard title={t('purchasing.suppliers')}>
        <View res={sups}>
          {(d) => (
            <ul className="mb-3 flex flex-col gap-1 text-sm">{d.items.map((s) => <li key={s.id} className="rounded-md bg-canvas-raised px-3 py-2"><strong>{s.name}</strong> · {s.currency}{s.leadTimeDays != null ? ` · ${t('purchasing.leadTime', { n: s.leadTimeDays })}` : ''}{s.email ? ` · ${s.email}` : ''}</li>)}</ul>
          )}
        </View>
        {app.can('operations.write') && (
          <div className="flex flex-wrap items-end gap-2">
            <Input value={sup.name} onChange={(e) => setSup({ ...sup, name: e.target.value })} placeholder={t('purchasing.supplierName')} aria-label={t('purchasing.supplierName')} className="h-10 max-w-xs" />
            <Input value={sup.email} onChange={(e) => setSup({ ...sup, email: e.target.value })} placeholder={t('purchasing.email')} aria-label={t('purchasing.email')} className="h-10 max-w-xs" />
            <Select value={sup.currency} onChange={(e) => setSup({ ...sup, currency: e.target.value })} className="h-10 w-28" aria-label={t('purchasing.currency')}>{[...new Set(app.locations.map((l) => l.currency))].map((c) => <option key={c}>{c}</option>)}</Select>
            <Button variant="secondary" disabled={!sup.name} loading={addSup.pending} onClick={() => addSup.run()}>{t('purchasing.addSupplier')}</Button>
          </div>
        )}
        <ActionError error={addSup.error} />
      </SectionCard>
      {sel && <PoDrawer po={sel} manager={manager} onClose={() => setOpen(null)} onChanged={() => pos.reload()} />}
      {creating && sups.data && <NewPo suppliers={sups.data.items} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); pos.reload(); }} />}
    </>
  );
}

function PoDrawer({ po, manager, onClose, onChanged }: { po: PurchaseOrderView; manager: boolean; onClose: () => void; onChanged: () => void }) {
  const t = useCt();
  const [waiting, setWaiting] = useState<Array<{ orderNumber: string | null; name: string; backordered: number }> | null>(null);
  const act = useAction(async (path: string) => { const r = await call<{ backordersWaiting?: Array<{ orderNumber: string | null; name: string; backordered: number }> }>('POST', `/purchase-orders/${po.id}/${path}`, {}); if (r.backordersWaiting) setWaiting(r.backordersWaiting); onChanged(); return r; });
  return (
    <Drawer open onClose={onClose} kicker={po.supplierName} title={`${po.number} · ${po.locationName}`}>
      <div className="flex flex-col gap-3 text-sm">
        <StatusBadge kind="po" value={po.status} />
        <ul className="flex flex-col gap-1">{po.lines.map((l) => <li key={l.variantId} className="flex justify-between gap-2"><span>{l.name}</span><span>{l.received}/{l.quantity} · <Money m={{ amount: l.unitCostMinor, currency: po.currency }} /></span></li>)}</ul>
        <div className="font-bold">{t('purchasing.total')}: <Money m={po.total} /></div>
        <ActionError error={act.error} />
        <div className="flex flex-wrap gap-2">
          {po.status === 'draft' && manager && <Button icon="send" onClick={() => act.run('send')}>{t('purchasing.send')}</Button>}
          {['sent', 'partially_received'].includes(po.status) && <Button icon="box" onClick={() => act.run('receive')}>{t('purchasing.receiveAll')}</Button>}
          {['draft', 'sent'].includes(po.status) && manager && <Button variant="secondary" onClick={() => act.run('cancel')}>{t('purchasing.cancel')}</Button>}
        </div>
        {waiting && (waiting.length ? <Banner tone="warning" title={t('purchasing.backordersWaiting')}>{waiting.map((w, i) => <div key={i}>{w.orderNumber}: {w.name} ×{w.backordered}</div>)}</Banner> : <Banner tone="success" live="polite">{t('purchasing.received')}</Banner>)}
      </div>
    </Drawer>
  );
}

function NewPo({ suppliers, onClose, onCreated }: { suppliers: Supplier[]; onClose: () => void; onCreated: () => void }) {
  const t = useCt();
  const stores = useScopeStores();
  const [loc, setLoc] = useState(stores[0]?.id ?? '');
  const [sup, setSup] = useState(suppliers[0]?.id ?? '');
  const [lines, setLines] = useState<Record<string, { q: number; cost: number | null }>>({});
  const asst = useCommerce(() => call<{ items: AssortmentItem[] }>('GET', `/locations/${loc}/assortment`), [loc], !!loc);
  const currency = suppliers.find((s) => s.id === sup)?.currency ?? 'USD';
  const save = useAction(() => call<PurchaseOrderView>('POST', '/purchase-orders', { locationId: loc, supplierId: sup, lines: Object.entries(lines).filter(([, l]) => l.q > 0).map(([variantId, l]) => ({ variantId, quantity: l.q, unitCostMinor: l.cost ?? 0 })) }));
  return (
    <Drawer open onClose={onClose} kicker={t('purchasing.title')} title={t('purchasing.newPo')}>
      <div className="flex flex-col gap-3 text-sm">
        <F label={t('common.store')}><Select value={loc} onChange={(e) => { setLoc(e.target.value); setLines({}); }}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></F>
        <F label={t('purchasing.supplier')}><Select value={sup} onChange={(e) => setSup(e.target.value)}>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.currency}</option>)}</Select></F>
        <View res={asst}>
          {(d) => (
            <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
              {d.items.flatMap((p) => p.variants.map((v) => (
                <li key={v.variantId} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-40 flex-1">{p.productName} — {v.name} <span className="text-xs text-stone">({v.availableQty})</span></span>
                  <NumberInput value={lines[v.variantId]?.q ?? 0} onChange={(n) => setLines((l) => ({ ...l, [v.variantId]: { q: n, cost: l[v.variantId]?.cost ?? null } }))} label={t('purchasing.qtyFor', { name: v.name })} />
                  <MoneyInput minor={lines[v.variantId]?.cost ?? null} currency={currency} label={t('purchasing.costFor', { name: v.name })} onChange={(c) => setLines((l) => ({ ...l, [v.variantId]: { q: l[v.variantId]?.q ?? 0, cost: c } }))} />
                </li>
              )))}
            </ul>
          )}
        </View>
        <ActionError error={save.error} />
        <Button disabled={!sup || !Object.values(lines).some((l) => l.q > 0)} loading={save.pending} onClick={async () => { if (await save.run()) onCreated(); }}>{t('purchasing.create')}</Button>
      </div>
    </Drawer>
  );
}

'use client';

import { useState } from 'react';
import { Button, DataTable, Drawer, Input, Select, Tabs } from '@bh/ui';
import { cx as call, useAction, useCommerce } from '@/lib/commerce/client';
import type { AssortmentItem, TransferView } from '@/lib/commerce/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, SectionCard } from '../../ui/States';
import { ActionError, F, History, NumberInput, StatusBadge, View, When, useCt, useScopeStores } from './kit';

type Tab = 'open' | 'in_transit' | 'done';

/** Inter-store transfers: request → approve → ship (in transit) → receive, with shortfalls recorded. */
export function TransfersScreen() {
  const t = useCt();
  const app = useApp();
  const [tab, setTab] = useState<Tab>('open');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const res = useCommerce(() => call<{ items: TransferView[] }>('GET', '/transfers'), [app.org.id]);
  const ids = app.scope.locationIds;
  const all = (res.data?.items ?? []).filter((x) => !ids.length || ids.includes(x.fromLocationId) || ids.includes(x.toLocationId));
  const pick: Record<Tab, (x: TransferView) => boolean> = { open: (x) => ['requested', 'approved'].includes(x.status), in_transit: (x) => x.status === 'in_transit', done: (x) => ['received', 'rejected', 'cancelled'].includes(x.status) };
  const sel = all.find((x) => x.id === open);
  return (
    <>
      <PageHeader icon="truck" title={t('transfers.title')} description={t('transfers.description')} actions={app.can('operations.write') && <Button icon="plus" onClick={() => setCreating(true)}>{t('transfers.new')}</Button>} />
      <SectionCard>
        <Tabs className="mb-3" value={tab} onChange={setTab} items={(['open', 'in_transit', 'done'] as const).map((k) => ({ key: k, label: t(`transfers.tabs.${k}`), count: all.filter(pick[k]).length }))} />
        <View res={res} isEmpty={() => !all.filter(pick[tab]).length} empty={<Empty icon="truck" title={t('transfers.empty')} />}>
          {() => (
            <DataTable rows={all.filter(pick[tab])} rowKey={(x) => x.id} onRowClick={(x) => setOpen(x.id)} columns={[
              { key: 'n', header: t('transfers.number'), render: (x) => <span className="font-bold">{x.number}</span> },
              { key: 'route', header: t('transfers.route'), render: (x) => <span>{x.fromLocationName} → {x.toLocationName}</span> },
              { key: 'status', header: t('transfers.status'), render: (x) => <StatusBadge kind="transfer" value={x.status} /> },
              { key: 'units', header: t('transfers.units'), align: 'right', render: (x) => x.status === 'in_transit' ? t('transfers.inTransitUnits', { n: x.totals.inTransit }) : x.totals.requested },
              { key: 'reason', header: t('transfers.reason'), render: (x) => <span className="text-xs">{x.orderId ? t('transfers.forOrder') : x.reason}</span> },
              { key: 'when', header: t('transfers.updated'), render: (x) => <When iso={x.receivedAt ?? x.shippedAt ?? x.createdAt} /> },
            ]} />
          )}
        </View>
      </SectionCard>
      {sel && <TransferDrawer x={sel} onClose={() => setOpen(null)} onChanged={(u) => res.data && res.setData({ items: res.data.items.map((y) => (y.id === u.id ? u : y)) })} />}
      {creating && <NewTransfer onClose={() => setCreating(false)} onCreated={() => { setCreating(false); res.reload(); }} />}
    </>
  );
}

function TransferDrawer({ x, onClose, onChanged }: { x: TransferView; onClose: () => void; onChanged: (t: TransferView) => void }) {
  const t = useCt();
  const app = useApp();
  const [qty, setQty] = useState<Record<string, number>>(Object.fromEntries(x.lines.map((l) => [l.variantId, x.status === 'in_transit' ? l.shipped : l.quantity])));
  const [note, setNote] = useState('');
  const [tracking, setTracking] = useState('');
  const act = useAction(async (path: string, body: unknown) => { const r = await call<TransferView>('POST', `/transfers/${x.id}/${path}`, body); onChanged(r); return r; });
  const lines = x.lines.map((l) => ({ variantId: l.variantId, quantity: qty[l.variantId] ?? 0 }));
  const manager = app.can('locations.read') && app.can('operations.write');
  return (
    <Drawer open onClose={onClose} kicker={t('transfers.kicker')} title={`${x.number} · ${x.fromLocationName} → ${x.toLocationName}`}>
      <div className="flex flex-col gap-3 text-sm">
        <StatusBadge kind="transfer" value={x.status} />
        {x.orderId && <Banner tone="info" icon="receipt">{t('transfers.orderNote')}</Banner>}
        {x.receiveNote && <Banner tone="warning">{x.receiveNote}</Banner>}
        <div className="max-w-full overflow-x-auto" tabIndex={0}><table className="w-full">
          <thead><tr className="text-left text-xs uppercase text-stone"><th className="py-1">{t('transfers.item')}</th><th className="py-1 text-right">{t('transfers.requested')}</th><th className="py-1 text-right">{t('transfers.shipped')}</th><th className="py-1 text-right">{t('transfers.received')}</th></tr></thead>
          <tbody>{x.lines.map((l) => (
            <tr key={l.variantId} className="border-t border-line-soft">
              <td className="py-2">{l.name}</td><td className="py-2 text-right">{l.quantity}</td>
              <td className="py-2 text-right">{x.status === 'approved' ? <NumberInput value={qty[l.variantId] ?? 0} onChange={(n) => setQty((q) => ({ ...q, [l.variantId]: n }))} label={t('transfers.shipQty', { name: l.name })} /> : l.shipped}</td>
              <td className="py-2 text-right">{x.status === 'in_transit' ? <NumberInput value={qty[l.variantId] ?? 0} onChange={(n) => setQty((q) => ({ ...q, [l.variantId]: n }))} label={t('transfers.receiveQty', { name: l.name })} /> : l.received}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <ActionError error={act.error} />
        {x.status === 'requested' && (manager ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('transfers.note')} aria-label={t('transfers.note')} className="h-10 flex-1" />
            <Button onClick={() => act.run('decision', { decision: 'approve', note: note || undefined })}>{t('transfers.approve')}</Button>
            <Button variant="secondary" disabled={!note} onClick={() => act.run('decision', { decision: 'reject', note })}>{t('transfers.reject')}</Button>
          </div>
        ) : <Banner tone="neutral" icon="lock">{t('transfers.needsManager')}</Banner>)}
        {x.status === 'approved' && app.can('operations.write') && (
          <div className="flex flex-wrap items-center gap-2">
            <Input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder={t('transfers.tracking')} aria-label={t('transfers.tracking')} className="h-10 flex-1" />
            <Button icon="truck" onClick={() => act.run('ship', { lines, trackingNumber: tracking || undefined })}>{t('transfers.ship')}</Button>
          </div>
        )}
        {x.status === 'in_transit' && app.can('operations.write') && (
          <div className="flex flex-wrap items-center gap-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('transfers.note')} aria-label={t('transfers.note')} className="h-10 flex-1" />
            <Button icon="check" onClick={() => act.run('receive', { lines, note: note || undefined })}>{t('transfers.receive')}</Button>
          </div>
        )}
        <History items={x.history} />
      </div>
    </Drawer>
  );
}

function NewTransfer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useCt();
  const stores = useScopeStores();
  const app = useApp();
  const [from, setFrom] = useState(app.locations.find((l) => !stores.some((s) => s.id === l.id))?.id ?? app.locations[0]?.id ?? '');
  const [to, setTo] = useState(stores[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const asst = useCommerce(() => call<{ items: AssortmentItem[] }>('GET', `/locations/${from}/assortment`), [from], !!from);
  const save = useAction(() => call<TransferView>('POST', '/transfers', { fromLocationId: from, toLocationId: to, reason: reason || undefined, lines: Object.entries(qty).filter(([, n]) => n > 0).map(([variantId, quantity]) => ({ variantId, quantity })) }));
  return (
    <Drawer open onClose={onClose} kicker={t('transfers.kicker')} title={t('transfers.new')}>
      <div className="flex flex-col gap-3 text-sm">
        <F label={t('transfers.from')}><Select value={from} onChange={(e) => { setFrom(e.target.value); setQty({}); }}>{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></F>
        <F label={t('transfers.to')}><Select value={to} onChange={(e) => setTo(e.target.value)}>{app.locations.filter((l) => l.id !== from).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></F>
        <F label={t('transfers.reason')} optional><Input value={reason} onChange={(e) => setReason(e.target.value)} /></F>
        <View res={asst}>
          {(d) => (
            <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
              {d.items.flatMap((p) => p.variants.map((v) => (
                <li key={v.variantId} className="flex items-center gap-2">
                  <span className="flex-1">{p.productName} — {v.name} <span className="text-xs text-stone">({t('transfers.availableAt', { n: v.availableQty })})</span></span>
                  <NumberInput value={qty[v.variantId] ?? 0} onChange={(n) => setQty((q) => ({ ...q, [v.variantId]: n }))} label={`${p.productName} ${v.name}`} />
                </li>
              )))}
            </ul>
          )}
        </View>
        <ActionError error={save.error} />
        <Button disabled={!to || from === to || !Object.values(qty).some((n) => n > 0)} loading={save.pending} onClick={async () => { if (await save.run()) onCreated(); }}>{t('transfers.request')}</Button>
      </div>
    </Drawer>
  );
}

'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Input, Select, Textarea, Toggle, cx, type Tone } from '@bh/ui';
import { OFF_CONTRACT_REASONS, SUPPORTED_CURRENCIES, fromMajor, toMajor, type Currency, type SupplierBody } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, DeniedState, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { ActionError, PillTabs, Tiles, useQFmt } from '../quality/ui';
import { downloadFile, readUpload, supplyApi, useAction, useLoad, type CertVM, type ItemVM, type OffContractVM, type PoStatus, type PoVM, type SupplierVM } from './api';

type Tab = 'overview' | 'orders' | 'catalogue' | 'offContract' | 'scorecards';

const PO_TONE: Record<PoStatus, Tone> = { draft: 'neutral', pending_approval: 'warning', approved: 'info', rejected: 'danger', sent: 'info', confirmed: 'info', partially_received: 'warning', received: 'success', cancelled: 'neutral' };
export function PoBadge({ status }: { status: PoStatus }) {
  const t = useTranslations('supply');
  return <Badge tone={PO_TONE[status]}>{t(`poStatus.${status}`)}</Badge>;
}
const CERT_TONE: Record<CertVM['state'], Tone> = { valid: 'success', expiring: 'warning', expired: 'danger', missing: 'danger', pending: 'info' };
export function ScorePill({ score }: { score: number | null }) {
  const f = useQFmt();
  if (score === null) return <span className="text-stone">—</span>;
  return <Badge tone={score >= 90 ? 'success' : score >= 75 ? 'warning' : 'danger'}>{f.num(score, 1)}</Badge>;
}

/**
 * Operations → Suppliers. HQ: approved suppliers and catalogues, the approval threshold, orders waiting for approval,
 * off-contract spend and scorecards. Locations: order from the catalogue, receive deliveries, log off-contract buys.
 */
export function SuppliersScreen() {
  const t = useTranslations('supply');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  if (!app.hasModule('operations.suppliers')) return <DeniedState />;
  const tabs: Array<[Tab, string]> = [['overview', t('tab.overview')], ['orders', t('tab.orders')], ['catalogue', t('tab.catalogue')], ['offContract', t('tab.offContract')], ['scorecards', t('tab.scorecards')]];
  return (
    <>
      <PageHeader icon="truck" title={t('title')} description={t('description')} scope={false} actions={app.capabilities.has('finance.supplier_rebates:view') ? <Link href="/finance/supplier-rebates" className="inline-flex h-10 items-center gap-2 rounded-full bg-surface px-4 text-[13px] font-bold hover:bg-line-soft">{t('rebatesLink')}</Link> : undefined} />
      <PillTabs items={tabs} value={tab} onChange={(k) => router.replace(`?tab=${k}`, { scroll: false })} />
      {tab === 'orders' ? <Orders /> : tab === 'catalogue' ? <Catalogue /> : tab === 'offContract' ? <OffContract /> : tab === 'scorecards' ? <Scorecards /> : <Overview />}
    </>
  );
}

function Overview() {
  const t = useTranslations('supply');
  const app = useApp();
  const f = useQFmt();
  const res = useLoad(() => supplyApi.overview(), [app.org.id]);
  return (
    <Async res={res} loading={<LoadingBlock variant="cards" />}>
      {(d) => (
        <>
          <Tiles items={[
            { label: t('overview.pendingApproval'), value: f.num(d.totals.pendingApproval), tone: d.totals.pendingApproval ? 'danger' : undefined },
            { label: t('overview.open'), value: f.num(d.totals.open) },
            { label: t('overview.dueThisWeek'), value: f.num(d.totals.dueThisWeek) },
            { label: t('overview.late'), value: f.num(d.totals.late), tone: d.totals.late ? 'danger' : undefined },
            { label: t('overview.offContract'), value: f.num(d.totals.offContractFlagged), tone: d.totals.offContractFlagged ? 'danger' : undefined },
          ]} />
          <div className="grid gap-3 lg:grid-cols-2">
            <SectionCard title={t('overview.deliveries')}>
              {d.deliveries.length ? (
                <ul className="flex flex-col gap-1.5">
                  {d.deliveries.map((x) => (
                    <li key={x.id}><Link href={`/suppliers/orders/${x.id}`} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised px-3 py-2 text-[13px] hover:bg-line-soft">
                      <span className="min-w-0 flex-1"><strong>{x.locationName}</strong> · {x.supplierName}<span className="block text-xs text-stone">{x.number}</span></span>
                      <PoBadge status={x.status} />
                      <Badge tone={x.late ? 'danger' : 'neutral'} icon="truck">{f.shortDate(x.expectedDeliveryDate)}</Badge>
                    </Link></li>
                  ))}
                </ul>
              ) : <p className="text-sm text-stone">{t('overview.noDeliveries')}</p>}
            </SectionCard>
            <SectionCard title={t('overview.onContract')}>
              {d.compliance.length ? (
                <ul className="flex flex-col gap-3">
                  {d.compliance.map((c) => (
                    <li key={c.currency} className="flex flex-col gap-1">
                      <span className="flex items-center justify-between text-[13px]"><strong>{c.currency}</strong><span>{t('overview.onContractPct', { pct: f.pct(c.onContractPct) })}</span></span>
                      <span className="flex h-2.5 overflow-hidden rounded-full bg-line-soft" role="img" aria-label={t('overview.onContractPct', { pct: f.pct(c.onContractPct) })}>
                        <span className="bg-ink" style={{ width: `${c.onContractPct ?? 0}%` }} />
                      </span>
                      <span className="text-xs text-stone">{t('overview.split', { on: f.money(c.onContractMinor, c.currency), off: f.money(c.offContractMinor, c.currency) })}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-stone">{t('overview.noSpend')}</p>}
            </SectionCard>
          </div>
          <SectionCard title={t('overview.spendBySupplier')}>
            {d.spendBySupplier.length ? (
              <DataTable rows={d.spendBySupplier} rowKey={(r) => `${r.supplierId}:${r.currency}`} rowLabel={(r) => r.supplier} columns={[
                { key: 's', header: t('col.supplier'), render: (r) => <strong>{r.supplier}</strong> },
                { key: 'o', header: t('col.orders'), render: (r) => f.num(r.orders) },
                { key: 'a', header: t('col.spend'), render: (r) => <span className="tabular">{f.money(r.amountMinor, r.currency)}</span> },
              ]} />
            ) : <p className="text-sm text-stone">{t('overview.noSpend')}</p>}
          </SectionCard>
          {d.can.manage && <ThresholdCard />}
        </>
      )}
    </Async>
  );
}

function ThresholdCard() {
  const t = useTranslations('supply');
  const app = useApp();
  const f = useQFmt();
  const res = useLoad(() => supplyApi.settings(), [app.org.id]);
  const act = useAction();
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const currencies = useMemo(() => [...new Set(app.locations.map((l) => l.currency))].sort(), [app.locations]);
  return (
    <SectionCard title={t('settings.title')} aside={!edit && res.data ? <Button size="sm" variant="ghost" icon="edit" onClick={() => setEdit(Object.fromEntries(currencies.map((c) => [c, res.data!.approvalThresholds[c] !== undefined ? String(toMajor({ amount: res.data!.approvalThresholds[c]!, currency: c })) : ''])))}>{t('common.edit')}</Button> : undefined}>
      <p className="text-[13px] text-stone">{t('settings.hint')}</p>
      <ActionError error={act.error} />
      {edit ? (
        <div className="flex flex-wrap items-end gap-2">
          {currencies.map((c) => <div key={c} className="w-36"><Field label={c} optional>{(x) => <Input id={x.id} type="number" min={0} inputMode="decimal" value={edit[c] ?? ''} onChange={(e) => setEdit({ ...edit, [c]: e.target.value })} />}</Field></div>)}
          <Button loading={act.pending} icon="check" onClick={async () => {
            const th = Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== '').map(([c, v]) => [c, fromMajor(Number(v), c as Currency).amount]));
            if (await act.run(() => supplyApi.saveSettings(th))) { setEdit(null); res.reload(); }
          }}>{t('common.save')}</Button>
          <Button variant="ghost" onClick={() => setEdit(null)}>{t('common.cancel')}</Button>
        </div>
      ) : (
        <span className="flex flex-wrap gap-2">
          {currencies.map((c) => <Badge key={c} tone="neutral">{res.data?.approvalThresholds[c] !== undefined ? t('settings.above', { amount: f.money(res.data.approvalThresholds[c]!, c) }) : t('settings.none', { currency: c })}</Badge>)}
        </span>
      )}
    </SectionCard>
  );
}

/* ------------------------------- orders -------------------------------- */

function Orders() {
  const t = useTranslations('supply');
  const app = useApp();
  const router = useRouter();
  const f = useQFmt();
  const [status, setStatus] = useState<'all' | 'pending_approval' | 'open' | 'received' | 'draft'>('all');
  const res = useLoad(() => supplyApi.orders({ status }), [app.org.id, status]);
  const [ordering, setOrdering] = useState(false);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <PillTabs items={[['all', t('filter.all')], ['pending_approval', t('filter.pendingApproval')], ['open', t('filter.open')], ['received', t('filter.received')], ['draft', t('filter.draft')]]} value={status} onChange={setStatus} />
        <span className="flex-1" />
        {res.data?.can.export && <Button variant="ghost" size="sm" icon="download" onClick={() => void downloadFile('/supply/orders/export', 'purchase-orders.csv')}>{t('common.exportCsv')}</Button>}
        {res.data?.can.order && <Button icon="plus" onClick={() => setOrdering(true)}>{t('orders.new')}</Button>}
      </div>
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="truck" title={t('orders.empty')} body={t('orders.emptyBody')} />}>
        {(d) => (
          <section className="rounded-xl bg-surface p-3.5" data-testid="po-list">
            <DataTable<PoVM> rows={d.items} rowKey={(p) => p.id} rowLabel={(p) => `${p.number} ${p.locationName}`} onRowClick={(p) => router.push(`/suppliers/orders/${p.id}`)} columns={[
              { key: 'n', header: t('col.order'), render: (p) => <span><strong>{p.number}</strong><span className="block text-xs text-stone">{f.shortDate(p.createdAt)}</span></span> },
              { key: 'l', header: t('col.location'), render: (p) => p.locationName },
              { key: 's', header: t('col.supplier'), render: (p) => p.supplierName },
              { key: 'tot', header: t('col.total'), render: (p) => <span className="tabular">{f.money(p.totalMinor, p.currency)}</span> },
              { key: 'exp', header: t('col.expected'), render: (p) => <span className={p.late ? 'font-bold text-danger' : undefined}>{f.shortDate(p.expectedDeliveryDate)}</span> },
              { key: 'st', header: t('col.status'), render: (p) => <PoBadge status={p.status} /> },
            ]} />
          </section>
        )}
      </Async>
      {ordering && <NewOrderDrawer onClose={() => setOrdering(false)} onDone={(id) => router.push(`/suppliers/orders/${id}`)} />}
    </>
  );
}

function NewOrderDrawer({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const t = useTranslations('supply');
  const app = useApp();
  const f = useQFmt();
  const [locationId, setLocationId] = useState(app.locations.length === 1 ? app.locations[0]!.id : '');
  const [supplierId, setSupplierId] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [date, setDate] = useState('');
  const [notes, setNotes] = useState('');
  const cat = useLoad(() => (locationId ? supplyApi.catalogue(locationId) : Promise.resolve(null)), [app.org.id, locationId]);
  const act = useAction();
  const items = (cat.data?.items ?? []).filter((i) => i.supplierId === supplierId && i.price);
  const lines = items.filter((i) => (qty[i.id] ?? 0) > 0).map((i) => ({ itemId: i.id, quantity: qty[i.id]! }));
  const total = items.reduce((a, i) => a + (qty[i.id] ?? 0) * (i.price?.amountMinor ?? 0), 0);
  const currency = cat.data?.location.currency ?? 'USD';
  const below = items.filter((i) => (qty[i.id] ?? 0) > 0 && (qty[i.id] ?? 0) < i.moq);
  const place = async (submit: boolean) => {
    const r = await act.run(() => supplyApi.createOrder({ locationId, supplierId, lines, requestedDeliveryDate: date || null, notes, submit }));
    if (r) onDone(r.id);
  };
  return (
    <Drawer open onClose={onClose} title={t('orders.new')} footer={
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-[13px]"><strong className="tabular">{f.money(total, currency)}</strong></span>
        <Button variant="secondary" disabled={!lines.length || !!below.length} loading={act.pending} onClick={() => void place(false)}>{t('orders.saveDraft')}</Button>
        <Button icon="send" disabled={!lines.length || !!below.length} loading={act.pending} onClick={() => void place(true)}>{t('orders.submit')}</Button>
      </div>
    }>
      <div className="flex flex-col gap-3">
        <ActionError error={act.error} />
        <Field label={t('col.location')}>{(x) => (
          <Select id={x.id} value={locationId} onChange={(e) => { setLocationId(e.target.value); setSupplierId(''); setQty({}); }}>
            <option value="">{t('common.choose')}</option>
            {app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        )}</Field>
        {cat.data && (
          <Field label={t('col.supplier')} hint={t('orders.approvedHere')}>{(x) => (
            <Select id={x.id} value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setQty({}); }}>
              <option value="">{t('common.choose')}</option>
              {cat.data!.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          )}</Field>
        )}
        {supplierId && (
          <ul className="flex flex-col gap-1.5">
            {items.map((i) => (
              <li key={i.id} className="flex items-center gap-2 rounded-md bg-canvas-raised px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1"><strong>{i.name}</strong><span className="block text-xs text-stone">{i.sku} · {i.packLabel} · {f.money(i.price!.amountMinor, i.price!.currency)} · {t('catalogue.moq', { n: i.moq })}</span></span>
                <div className="w-20 shrink-0"><Input aria-label={t('orders.qtyFor', { item: i.name })} type="number" min={0} className={cx((qty[i.id] ?? 0) > 0 && (qty[i.id] ?? 0) < i.moq && 'border-danger')} value={qty[i.id] ?? ''} onChange={(e) => setQty({ ...qty, [i.id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></div>
              </li>
            ))}
            {!items.length && <li className="text-sm text-stone">{t('orders.noItems')}</li>}
          </ul>
        )}
        {!!below.length && <p className="text-xs font-bold text-danger">{t('orders.belowMoq')}</p>}
        <Field label={t('orders.deliveryDate')} optional>{(x) => <Input id={x.id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label={t('orders.notes')} optional>{(x) => <Textarea id={x.id} className="min-h-14" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />}</Field>
      </div>
    </Drawer>
  );
}

/* ------------------------------ catalogue ------------------------------- */

function Catalogue() {
  const t = useTranslations('supply');
  const app = useApp();
  const res = useLoad(() => supplyApi.suppliers({ status: 'all' }), [app.org.id]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<SupplierVM | 'new' | null>(null);
  return (
    <Async res={res} loading={<LoadingBlock variant="cards" />} isEmpty={(d) => !d.items.length && !d.can.manage} empty={<Empty icon="truck" title={t('suppliers.empty')} body={t('suppliers.emptyBody')} />}>
      {(d) => {
        const current = d.items.find((s) => s.id === selected) ?? d.items[0];
        return (
          <div className="grid gap-3 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]" data-testid="supplier-catalogue">
            <div className="flex flex-col gap-2">
              {d.can.manage && <Button icon="plus" variant="secondary" className="self-start" onClick={() => setEditing('new')}>{t('suppliers.add')}</Button>}
              {d.items.map((s) => (
                <button key={s.id} type="button" onClick={() => setSelected(s.id)} className={cx('flex flex-col gap-1 rounded-lg p-3 text-left', current?.id === s.id ? 'bg-ink text-white' : 'bg-surface hover:bg-line-soft')}>
                  <span className="flex items-center gap-2"><strong className="min-w-0 flex-1 truncate">{s.name}</strong>{s.status !== 'active' && <Badge tone="warning">{t(`supplierStatus.${s.status}`)}</Badge>}</span>
                  <span className={cx('text-xs', current?.id === s.id ? 'text-white/80' : 'text-stone')}>{[s.countries.join(', '), ...s.regions.map((r) => r.name)].filter(Boolean).join(' · ') || t('suppliers.everywhere')} · {t('suppliers.items', { count: s.itemCount })}</span>
                  {s.certifications.some((c) => c.state !== 'valid') && <span className="text-xs font-bold text-danger">{t('suppliers.certAttention')}</span>}
                </button>
              ))}
            </div>
            {current ? <SupplierDetail key={current.id} id={current.id} onEdit={(s) => setEditing(s)} /> : <Empty icon="truck" title={t('suppliers.empty')} />}
            {editing && <SupplierDrawer supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={(s) => { setEditing(null); setSelected(s.id); res.reload(); }} />}
          </div>
        );
      }}
    </Async>
  );
}

function SupplierDetail({ id, onEdit }: { id: string; onEdit: (s: SupplierVM) => void }) {
  const t = useTranslations('supply');
  const app = useApp();
  const f = useQFmt();
  const res = useLoad(() => supplyApi.supplier(id), [app.org.id, id]);
  const [item, setItem] = useState<ItemVM | 'new' | null>(null);
  const [cert, setCert] = useState(false);
  return (
    <Async res={res} loading={<LoadingBlock variant="detail" />}>
      {(s) => {
        const currencies = [...new Set(s.items.flatMap((i) => Object.keys(i.prices)))].sort();
        return (
          <div className="flex flex-col gap-3">
            <SectionCard title={s.name} aside={s.can.manage ? <Button size="sm" variant="ghost" icon="edit" onClick={() => onEdit(s)}>{t('common.edit')}</Button> : undefined}>
              <div className="grid gap-3 text-[13px] md:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold uppercase text-stone">{t('suppliers.contacts')}</span>
                  {s.contacts.map((c, i) => <span key={i}><strong>{c.name}</strong>{c.role ? ` · ${c.role}` : ''}<span className="block text-xs text-stone">{[c.email, c.phone].filter(Boolean).join(' · ')}</span></span>)}
                  {s.orderEmail && <span className="text-xs">{t('suppliers.ordersTo', { email: s.orderEmail, format: s.orderFormat.toUpperCase() })}</span>}
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold uppercase text-stone">{t('suppliers.contract')}</span>
                  {s.contract ? (
                    <>
                      <span><strong>{s.contract.reference || '—'}</strong> · {s.contract.paymentTerms}</span>
                      <span className="text-xs text-stone">{f.date(s.contract.startsOn)} – {s.contract.endsOn ? f.date(s.contract.endsOn) : t('suppliers.openEnded')}</span>
                      {s.contract.notes && <span className="text-xs">{s.contract.notes}</span>}
                    </>
                  ) : <span className="text-stone">{t('suppliers.noContract')}</span>}
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold uppercase text-stone">{t('suppliers.scorecard')}</span>
                  {s.scorecard ? (
                    <>
                      <span className="flex items-center gap-2">{t('score.overall')} <ScorePill score={s.scorecard.score} /></span>
                      <span className="text-xs">{t('score.summary', { onTime: f.pct(s.scorecard.onTimePct), fill: f.pct(s.scorecard.fillRatePct), issues: s.scorecard.issues })}</span>
                    </>
                  ) : <span className="text-stone">{t('score.none')}</span>}
                </div>
              </div>
            </SectionCard>
            <SectionCard title={t('suppliers.certifications')} aside={s.can.manage ? <Button size="sm" variant="ghost" icon="plus" onClick={() => setCert(true)}>{t('suppliers.addCert')}</Button> : undefined}>
              {s.certifications.length ? (
                <ul className="flex flex-wrap gap-2">
                  {s.certifications.map((c) => (
                    <li key={c.id} className="flex items-center gap-2 rounded-md bg-canvas-raised px-3 py-2 text-[13px]">
                      <span><strong>{c.name}</strong><span className="block text-xs text-stone">{[c.issuer, c.reference].filter(Boolean).join(' · ')}{c.expiresOn ? ` · ${t('suppliers.expires', { date: f.date(c.expiresOn) })}` : ''}</span></span>
                      <Badge tone={CERT_TONE[c.state]}>{t(`certState.${c.state}`)}</Badge>
                      {c.file && <a href={c.file.url} target="_blank" rel="noreferrer" className="text-xs font-bold underline">{t('common.view')}</a>}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-stone">{t('suppliers.noCerts')}</p>}
            </SectionCard>
            <SectionCard title={t('catalogue.title', { count: s.items.length })} aside={s.can.manage ? <Button size="sm" icon="plus" onClick={() => setItem('new')}>{t('catalogue.add')}</Button> : undefined}>
              {s.items.length ? (
                <DataTable<ItemVM> rows={s.items} rowKey={(i) => i.id} rowLabel={(i) => i.name} onRowClick={s.can.manage ? (i) => setItem(i) : undefined} columns={[
                  { key: 'sku', header: t('col.sku'), render: (i) => <span className="font-mono text-xs">{i.sku}</span> },
                  { key: 'n', header: t('col.item'), render: (i) => <span><strong>{i.name}</strong><span className="block text-xs text-stone">{i.category} · {i.packLabel}</span>{!i.active && <Badge tone="neutral">{t('catalogue.inactive')}</Badge>}</span> },
                  ...currencies.map((c) => ({ key: c, header: c, render: (i: ItemVM) => <span className="tabular">{i.prices[c] !== undefined ? f.money(i.prices[c]!, c) : '—'}</span> })),
                  { key: 'moq', header: t('col.moq'), render: (i) => f.num(i.moq) },
                  { key: 'lead', header: t('col.lead'), render: (i) => t('catalogue.days', { n: i.leadTimeDays }) },
                  { key: 'stock', header: t('col.stock'), render: (i) => (i.stockLink ? <Badge tone="info" icon="box">{t(`catalogue.link.${i.stockLink}`, { n: f.num(i.unitsPerPack) })}</Badge> : '—') },
                ]} />
              ) : <Empty icon="box" title={t('catalogue.empty')} />}
            </SectionCard>
            {item && <ItemDrawer supplierId={s.id} item={item === 'new' ? null : item} onClose={() => setItem(null)} onDone={() => { setItem(null); res.reload(); }} />}
            {cert && <CertDrawer supplierId={s.id} onClose={() => setCert(false)} onDone={() => { setCert(false); res.reload(); }} />}
          </div>
        );
      }}
    </Async>
  );
}

function SupplierDrawer({ supplier, onClose, onDone }: { supplier: SupplierVM | null; onClose: () => void; onDone: (s: SupplierVM) => void }) {
  const t = useTranslations('supply');
  const act = useAction();
  const c0 = supplier?.contacts[0];
  const [v, setV] = useState({
    name: supplier?.name ?? '', code: supplier?.code ?? '', status: supplier?.status ?? 'active', countries: supplier?.countries.join(', ') ?? '', currency: supplier?.currency ?? 'USD', orderEmail: supplier?.orderEmail ?? '',
    orderFormat: supplier?.orderFormat ?? 'pdf', contactName: c0?.name ?? '', contactEmail: c0?.email ?? '', contactPhone: c0?.phone ?? '', reference: supplier?.contract?.reference ?? '', startsOn: supplier?.contract?.startsOn ?? '',
    endsOn: supplier?.contract?.endsOn ?? '', paymentTerms: supplier?.contract?.paymentTerms ?? '', contractNotes: supplier?.contract?.notes ?? '',
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const body = (): SupplierBody => ({
    name: v.name, code: v.code, status: v.status as SupplierBody['status'], countries: v.countries.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)), regionIds: supplier?.regionIds ?? [],
    contacts: [...(v.contactName ? [{ name: v.contactName, role: c0?.role ?? '', email: v.contactEmail || null, phone: v.contactPhone || null, primary: true }] : []), ...(supplier?.contacts.slice(1) ?? [])],
    orderEmail: v.orderEmail || null, orderFormat: v.orderFormat as SupplierBody['orderFormat'], currency: v.currency as Currency,
    contract: v.reference || v.paymentTerms || v.startsOn ? { reference: v.reference, startsOn: v.startsOn || null, endsOn: v.endsOn || null, paymentTerms: v.paymentTerms, notes: v.contractNotes } : null, notes: supplier?.notes ?? '',
  });
  return (
    <Drawer open onClose={onClose} title={supplier ? supplier.name : t('suppliers.add')} footer={<Button icon="check" disabled={!v.name.trim()} loading={act.pending} onClick={async () => { const r = await act.run(() => (supplier ? supplyApi.saveSupplier(supplier.id, body()) : supplyApi.createSupplier(body()))); if (r) onDone(r); }}>{t('common.save')}</Button>}>
      <div className="flex flex-col gap-3">
        <ActionError error={act.error} />
        <Field label={t('suppliers.name')}>{(x) => <Input id={x.id} value={v.name} maxLength={160} onChange={set('name')} />}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('suppliers.code')} optional>{(x) => <Input id={x.id} value={v.code} maxLength={40} onChange={set('code')} />}</Field>
          <Field label={t('col.status')}>{(x) => <Select id={x.id} value={v.status} onChange={set('status')}>{(['active', 'suspended', 'archived'] as const).map((s) => <option key={s} value={s}>{t(`supplierStatus.${s}`)}</option>)}</Select>}</Field>
        </div>
        <Field label={t('suppliers.countries')} hint={t('suppliers.countriesHint')} optional>{(x) => <Input id={x.id} value={v.countries} onChange={set('countries')} />}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('suppliers.currency')}>{(x) => <Select id={x.id} value={v.currency} onChange={set('currency')}>{SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
          <Field label={t('suppliers.format')}>{(x) => <Select id={x.id} value={v.orderFormat} onChange={set('orderFormat')}>{(['pdf', 'csv', 'both'] as const).map((s) => <option key={s} value={s}>{t(`format.${s}`)}</option>)}</Select>}</Field>
        </div>
        <Field label={t('suppliers.orderEmail')} optional>{(x) => <Input id={x.id} type="email" value={v.orderEmail} onChange={set('orderEmail')} />}</Field>
        <Field label={t('suppliers.contactName')} optional>{(x) => <Input id={x.id} value={v.contactName} onChange={set('contactName')} />}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('suppliers.contactEmail')} optional>{(x) => <Input id={x.id} type="email" value={v.contactEmail} onChange={set('contactEmail')} />}</Field>
          <Field label={t('suppliers.contactPhone')} optional>{(x) => <Input id={x.id} value={v.contactPhone} onChange={set('contactPhone')} />}</Field>
        </div>
        <Field label={t('suppliers.reference')} optional>{(x) => <Input id={x.id} value={v.reference} onChange={set('reference')} />}</Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label={t('suppliers.startsOn')} optional>{(x) => <Input id={x.id} type="date" value={v.startsOn} onChange={set('startsOn')} />}</Field>
          <Field label={t('suppliers.endsOn')} optional>{(x) => <Input id={x.id} type="date" value={v.endsOn} onChange={set('endsOn')} />}</Field>
          <Field label={t('suppliers.paymentTerms')} optional>{(x) => <Input id={x.id} value={v.paymentTerms} onChange={set('paymentTerms')} />}</Field>
        </div>
        <Field label={t('suppliers.contractNotes')} optional>{(x) => <Textarea id={x.id} value={v.contractNotes} onChange={set('contractNotes')} />}</Field>
      </div>
    </Drawer>
  );
}

function ItemDrawer({ supplierId, item, onClose, onDone }: { supplierId: string; item: ItemVM | null; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('supply');
  const act = useAction();
  const [v, setV] = useState({ sku: item?.sku ?? '', name: item?.name ?? '', category: item?.category ?? '', packLabel: item?.packLabel ?? '', unitsPerPack: item?.unitsPerPack ?? 1, moq: item?.moq ?? 1, leadTimeDays: item?.leadTimeDays ?? 2, active: item?.active ?? true });
  const [prices, setPrices] = useState<Array<[string, string]>>(item ? Object.entries(item.prices).map(([c, m]) => [c, String(toMajor({ amount: m, currency: c as Currency }))]) : [['USD', '']]);
  const body = () => ({ ...v, prices: Object.fromEntries(prices.filter(([, p]) => p !== '').map(([c, p]) => [c, fromMajor(Number(p), c as Currency).amount])), variantId: item?.variantId ?? null, ingredientId: item?.ingredientId ?? null });
  return (
    <Drawer open onClose={onClose} title={item ? item.name : t('catalogue.add')} footer={<Button icon="check" disabled={!v.sku || !v.name || !prices.some(([, p]) => p !== '')} loading={act.pending} onClick={async () => { if (await act.run(() => (item ? supplyApi.saveItem(item.id, body()) : supplyApi.addItem(supplierId, body())))) onDone(); }}>{t('common.save')}</Button>}>
      <div className="flex flex-col gap-3">
        <ActionError error={act.error} />
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('col.sku')}>{(x) => <Input id={x.id} value={v.sku} maxLength={60} onChange={(e) => setV({ ...v, sku: e.target.value })} />}</Field>
          <Field label={t('catalogue.category')} optional>{(x) => <Input id={x.id} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} />}</Field>
        </div>
        <Field label={t('col.item')}>{(x) => <Input id={x.id} value={v.name} maxLength={200} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('catalogue.pack')} optional>{(x) => <Input id={x.id} value={v.packLabel} onChange={(e) => setV({ ...v, packLabel: e.target.value })} />}</Field>
          <Field label={t('catalogue.unitsPerPack')} hint={t('catalogue.unitsHint')}>{(x) => <Input id={x.id} type="number" min={1} value={v.unitsPerPack} onChange={(e) => setV({ ...v, unitsPerPack: Math.max(1, Number(e.target.value) || 1) })} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('col.moq')}>{(x) => <Input id={x.id} type="number" min={1} value={v.moq} onChange={(e) => setV({ ...v, moq: Math.max(1, Number(e.target.value) || 1) })} />}</Field>
          <Field label={t('catalogue.leadTime')}>{(x) => <Input id={x.id} type="number" min={0} value={v.leadTimeDays} onChange={(e) => setV({ ...v, leadTimeDays: Math.max(0, Number(e.target.value) || 0) })} />}</Field>
        </div>
        <span className="text-[13px] font-bold">{t('catalogue.prices')}</span>
        {prices.map(([c, p], i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="w-28 shrink-0"><Select aria-label={t('suppliers.currency')} value={c} onChange={(e) => setPrices(prices.map((x, k) => (k === i ? [e.target.value, x[1]] : x)))}>{SUPPORTED_CURRENCIES.map((cc) => <option key={cc} value={cc}>{cc}</option>)}</Select></div>
            <Input aria-label={t('catalogue.priceIn', { currency: c })} type="number" min={0} step="0.01" value={p} onChange={(e) => setPrices(prices.map((x, k) => (k === i ? [x[0], e.target.value] : x)))} />
          </div>
        ))}
        <Button size="sm" variant="ghost" icon="plus" className="self-start" onClick={() => setPrices([...prices, ['EUR', '']])}>{t('catalogue.addPrice')}</Button>
        <label className="flex items-center gap-2 text-[13px] font-bold"><Toggle checked={v.active} label={t('catalogue.active')} onChange={(x) => setV({ ...v, active: x })} />{t('catalogue.active')}</label>
      </div>
    </Drawer>
  );
}

function CertDrawer({ supplierId, onClose, onDone }: { supplierId: string; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('supply');
  const act = useAction();
  const [v, setV] = useState({ name: '', issuer: '', reference: '', expiresOn: '' });
  const [file, setFile] = useState<File | null>(null);
  return (
    <Drawer open onClose={onClose} title={t('suppliers.addCert')} footer={<Button icon="check" disabled={!v.name} loading={act.pending} onClick={async () => {
      if (await act.run(async () => supplyApi.addCert(supplierId, { name: v.name, required: true, issuer: v.issuer || null, reference: v.reference || null, expiresOn: v.expiresOn || null, file: file ? await readUpload(file) : null }))) onDone();
    }}>{t('common.save')}</Button>}>
      <div className="flex flex-col gap-3">
        <ActionError error={act.error} />
        <Field label={t('suppliers.certName')}>{(x) => <Input id={x.id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}</Field>
        <Field label={t('suppliers.issuer')} optional>{(x) => <Input id={x.id} value={v.issuer} onChange={(e) => setV({ ...v, issuer: e.target.value })} />}</Field>
        <Field label={t('suppliers.certRef')} optional>{(x) => <Input id={x.id} value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} />}</Field>
        <Field label={t('suppliers.expiresOn')} optional>{(x) => <Input id={x.id} type="date" value={v.expiresOn} onChange={(e) => setV({ ...v, expiresOn: e.target.value })} />}</Field>
        <Field label={t('suppliers.certFile')} optional>{(x) => <Input id={x.id} type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</Field>
      </div>
    </Drawer>
  );
}

/* ---------------------------- off-contract ------------------------------ */

function OffContract() {
  const t = useTranslations('supply');
  const app = useApp();
  const f = useQFmt();
  const [status, setStatus] = useState<'all' | 'flagged' | 'accepted' | 'action_required'>('flagged');
  const res = useLoad(() => supplyApi.offContract({ status }), [app.org.id, status]);
  const suppliers = useLoad(() => supplyApi.suppliers(), [app.org.id]);
  const [logging, setLogging] = useState(false);
  const [reviewing, setReviewing] = useState<OffContractVM | null>(null);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <PillTabs items={[['flagged', t('offStatus.flagged')], ['action_required', t('offStatus.action_required')], ['accepted', t('offStatus.accepted')], ['all', t('filter.all')]]} value={status} onChange={setStatus} />
        <span className="flex-1" />
        {res.data?.can.log && <Button icon="plus" onClick={() => setLogging(true)}>{t('off.log')}</Button>}
      </div>
      <p className="text-[13px] text-stone">{t('off.hint')}</p>
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="check-circle" title={t('off.empty')} />}>
        {(d) => (
          <section className="rounded-xl bg-surface p-3.5">
            <DataTable<OffContractVM> rows={d.items} rowKey={(x) => x.id} rowLabel={(x) => x.vendorName} onRowClick={d.can.review ? (x) => setReviewing(x) : undefined} columns={[
              { key: 'd', header: t('col.date'), render: (x) => f.shortDate(x.purchasedOn) },
              { key: 'l', header: t('col.location'), render: (x) => x.locationName },
              { key: 'v', header: t('off.vendor'), render: (x) => <span><strong>{x.vendorName}</strong><span className="block text-xs text-stone">{x.description}</span></span> },
              { key: 'r', header: t('off.reason'), render: (x) => t(`offReason.${x.reason}`) },
              { key: 'a', header: t('col.total'), render: (x) => <span className="tabular">{f.money(x.amountMinor, x.currency)}</span> },
              { key: 's', header: t('col.status'), render: (x) => <span className="flex flex-col gap-0.5"><Badge tone={x.status === 'flagged' ? 'warning' : x.status === 'accepted' ? 'success' : 'danger'}>{t(`offStatus.${x.status}`)}</Badge>{x.reviewNote && <span className="text-xs text-stone">{x.reviewNote}</span>}</span> },
            ]} />
          </section>
        )}
      </Async>
      {logging && <LogOffContractDrawer onClose={() => setLogging(false)} onDone={() => { setLogging(false); res.reload(); }} />}
      {reviewing && (
        <ReviewDrawer x={reviewing} suppliers={suppliers.data?.items ?? []} onClose={() => setReviewing(null)} onDone={() => { setReviewing(null); res.reload(); }} />
      )}
    </>
  );
}

function LogOffContractDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations('supply');
  const app = useApp();
  const act = useAction();
  const [v, setV] = useState({ locationId: app.locations.length === 1 ? app.locations[0]!.id : '', vendorName: '', description: '', category: '', amount: '', purchasedOn: new Date().toISOString().slice(0, 10), reason: 'out_of_stock', note: '' });
  const [file, setFile] = useState<File | null>(null);
  const loc = app.locations.find((l) => l.id === v.locationId);
  return (
    <Drawer open onClose={onClose} title={t('off.log')} footer={<Button icon="flag" disabled={!loc || !v.vendorName || !v.description || !(Number(v.amount) > 0)} loading={act.pending} onClick={async () => {
      if (await act.run(async () => supplyApi.logOffContract({ locationId: v.locationId, vendorName: v.vendorName, description: v.description, category: v.category, amountMinor: fromMajor(Number(v.amount), loc!.currency).amount, currency: loc!.currency, purchasedOn: v.purchasedOn, reason: v.reason, note: v.note, receipt: file ? await readUpload(file, { shrinkImages: true }) : null }))) onDone();
    }}>{t('off.flag')}</Button>}>
      <div className="flex flex-col gap-3">
        <ActionError error={act.error} />
        <Field label={t('col.location')}>{(x) => <Select id={x.id} value={v.locationId} onChange={(e) => setV({ ...v, locationId: e.target.value })}><option value="">{t('common.choose')}</option>{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
        <Field label={t('off.vendor')}>{(x) => <Input id={x.id} value={v.vendorName} onChange={(e) => setV({ ...v, vendorName: e.target.value })} />}</Field>
        <Field label={t('off.what')}>{(x) => <Input id={x.id} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={loc ? t('off.amountIn', { currency: loc.currency }) : t('col.total')}>{(x) => <Input id={x.id} type="number" min={0} step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />}</Field>
          <Field label={t('col.date')}>{(x) => <Input id={x.id} type="date" value={v.purchasedOn} onChange={(e) => setV({ ...v, purchasedOn: e.target.value })} />}</Field>
        </div>
        <Field label={t('off.reason')}>{(x) => <Select id={x.id} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })}>{OFF_CONTRACT_REASONS.map((r) => <option key={r} value={r}>{t(`offReason.${r}`)}</option>)}</Select>}</Field>
        <Field label={t('orders.notes')} optional>{(x) => <Textarea id={x.id} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />}</Field>
        <Field label={t('off.receipt')} optional>{(x) => <Input id={x.id} type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</Field>
      </div>
    </Drawer>
  );
}

function ReviewDrawer({ x, suppliers, onClose, onDone }: { x: OffContractVM; suppliers: SupplierVM[]; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('supply');
  const f = useQFmt();
  const act = useAction();
  const [note, setNote] = useState(x.reviewNote ?? '');
  const [sug, setSug] = useState(x.suggestedSupplier?.id ?? '');
  const decide = async (status: 'accepted' | 'action_required') => { if (await act.run(() => supplyApi.reviewOffContract(x.id, { status, note: note || undefined, suggestedSupplierId: sug || null }))) onDone(); };
  return (
    <Drawer open onClose={onClose} title={x.vendorName} kicker={x.locationName ?? undefined} footer={
      <div className="flex gap-2">
        <Button variant="secondary" icon="flag" loading={act.pending} disabled={!note} onClick={() => void decide('action_required')}>{t('off.actionRequired')}</Button>
        <Button icon="check" loading={act.pending} onClick={() => void decide('accepted')}>{t('off.accept')}</Button>
      </div>
    }>
      <div className="flex flex-col gap-3 text-[13px]">
        <ActionError error={act.error} />
        <p><strong>{f.money(x.amountMinor, x.currency)}</strong> · {f.date(x.purchasedOn)} · {t(`offReason.${x.reason}`)}</p>
        <p>{x.description}</p>
        {x.note && <p className="text-stone">{x.note}</p>}
        {x.receipt && <a href={x.receipt.url} target="_blank" rel="noreferrer" className="font-bold underline">{t('off.viewReceipt')}</a>}
        <Field label={t('off.suggest')} optional>{(fx) => <Select id={fx.id} value={sug} onChange={(e) => setSug(e.target.value)}><option value="">{t('common.none')}</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        <Field label={t('off.reviewNote')} hint={t('off.reviewHint')} optional>{(fx) => <Textarea id={fx.id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
    </Drawer>
  );
}

/* ----------------------------- scorecards ------------------------------- */

function Scorecards() {
  const t = useTranslations('supply');
  const app = useApp();
  const f = useQFmt();
  const res = useLoad(() => supplyApi.scorecards(), [app.org.id]);
  return (
    <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="chart" title={t('score.none')} />}>
      {(d) => (
        <SectionCard title={t('score.title')} aside={<span className="text-xs text-stone">{t('score.how')}</span>}>
          <DataTable rows={d.items} rowKey={(r) => r.supplierId} rowLabel={(r) => r.name} columns={[
            { key: 'n', header: t('col.supplier'), render: (r) => <span><strong>{r.name}</strong>{r.status !== 'active' && <Badge tone="warning">{t(`supplierStatus.${r.status}` as 'supplierStatus.active')}</Badge>}</span> },
            { key: 'o', header: t('col.orders'), render: (r) => t('score.delivered', { delivered: r.delivered, orders: r.orders }) },
            { key: 'ot', header: t('score.onTime'), render: (r) => f.pct(r.onTimePct) },
            { key: 'fr', header: t('score.fillRate'), render: (r) => f.pct(r.fillRatePct) },
            { key: 'i', header: t('score.issues'), render: (r) => (r.issues ? <Badge tone="warning">{f.num(r.issues)}</Badge> : '0') },
            { key: 's', header: t('score.overall'), render: (r) => <ScorePill score={r.score} /> },
          ]} />
        </SectionCard>
      )}
    </Async>
  );
}

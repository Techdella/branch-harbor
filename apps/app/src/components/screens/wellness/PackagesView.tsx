'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Input, Select, Tabs, type Column } from '@bh/ui';
import { fmtYmd } from '@/lib/format';
import { useWellness, useWellnessAction } from '@/lib/wellness/api';
import type { ClientPackage, PackagePlan, Voucher } from '@/lib/wellness/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, LoadingBlock } from '../../ui/States';
import { Loadable, Money, StatusBadge, useScopeLocations } from './shared';

type Tab = 'plans' | 'sold' | 'vouchers';

export function PackagesView() {
  const t = useTranslations('wellnessFull.packages');
  const locale = useLocale();
  const app = useApp();
  const locs = useScopeLocations();
  const [tab, setTab] = useState<Tab>('plans');
  const [drawer, setDrawer] = useState<null | 'plan' | 'sell' | 'voucher' | { voucher: string }>(null);
  const res = useWellness(app.locations, async (api) => ({ plans: await api.plans(), sold: await api.clientPackages().catch(() => [] as ClientPackage[]), vouchers: await api.vouchers().catch(() => [] as Voucher[]), services: await api.services() }), [app.role, app.scopeId]);
  const ids = new Set(locs.map((l) => l.id));
  const locName = (id: string | null) => (id ? app.locations.find((l) => l.id === id)?.name ?? '—' : t('allLocations'));
  const date = (iso: string | null) => (iso ? fmtYmd(iso.slice(0, 10), locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const canWrite = app.can('operations.write');
  const canSell = app.can('customers.write');
  const actions = tab === 'plans' && canWrite ? <Button icon="plus" onClick={() => setDrawer('plan')}>{t('newPlan')}</Button> : tab === 'sold' && canSell ? <Button icon="plus" onClick={() => setDrawer('sell')}>{t('sell')}</Button> : tab === 'vouchers' && canSell ? <Button icon="gift" onClick={() => setDrawer('voucher')}>{t('issueVoucher')}</Button> : null;

  const planCols: Column<PackagePlan>[] = [
    { key: 'name', header: t('plan'), render: (p) => <span className="font-bold">{p.name}</span> },
    { key: 'loc', header: t('soldAt'), render: (p) => locName(p.locationId) },
    { key: 'sessions', header: t('sessions'), align: 'right', render: (p) => p.sessions },
    { key: 'price', header: t('price'), align: 'right', render: (p) => <Money m={p.price} /> },
    { key: 'per', header: t('perSession'), align: 'right', render: (p) => <Money m={p.perSession} /> },
    { key: 'valid', header: t('validity'), render: (p) => t('days', { n: p.validityDays }) },
    { key: 'share', header: t('sharing'), render: (p) => (p.sharing === 'shareable' ? t('shareable', { n: p.maxSharedWith }) : t('personal')) },
    { key: 'online', header: t('online'), render: (p) => <Badge tone={p.onlinePurchasable ? 'success' : 'neutral'} icon={p.onlinePurchasable ? 'globe' : 'store'}>{p.onlinePurchasable ? t('yes') : t('desk')}</Badge> },
  ];
  const soldCols: Column<ClientPackage>[] = [
    { key: 'client', header: t('client'), render: (c) => <span className="font-bold">{c.clientName ?? '—'}</span> },
    { key: 'plan', header: t('plan'), render: (c) => c.name },
    { key: 'left', header: t('remaining'), align: 'right', render: (c) => `${c.sessionsRemaining} / ${c.sessionsTotal}` },
    { key: 'exp', header: t('expires'), render: (c) => date(c.expiresAt) },
    { key: 'shared', header: t('sharing'), render: (c) => (c.sharedWithCustomerIds.length ? t('sharedWith', { n: c.sharedWithCustomerIds.length }) : '—') },
    { key: 'status', header: t('status'), render: (c) => <StatusBadge status={c.status} /> },
  ];
  const vCols: Column<Voucher>[] = [
    { key: 'code', header: t('code'), render: (v) => <span className="tabular font-bold">{v.code}</span> },
    { key: 'bal', header: t('balance'), align: 'right', render: (v) => <Money m={v.balance} /> },
    { key: 'init', header: t('initial'), align: 'right', render: (v) => <Money m={v.initial} /> },
    { key: 'exp', header: t('expires'), render: (v) => date(v.expiresAt) },
    { key: 'for', header: t('recipient'), render: (v) => v.recipientName ?? '—' },
    { key: 'loc', header: t('soldAt'), render: (v) => locName(v.locationId) },
    { key: 'status', header: t('status'), render: (v) => <StatusBadge status={v.status} /> },
  ];

  return (
    <>
      <PageHeader icon="gift" title={t('title')} description={t('description')} actions={actions} />
      <section className="flex flex-col gap-3 rounded-xl bg-surface p-3.5">
        <Tabs items={[{ key: 'plans', label: t('tabPlans') }, { key: 'sold', label: t('tabSold') }, { key: 'vouchers', label: t('tabVouchers') }]} value={tab} onChange={(k) => setTab(k as Tab)} />
        <Loadable res={res} loading={<LoadingBlock variant="table" />}>
          {({ plans, sold, vouchers }) => {
            if (tab === 'plans') return <DataTable columns={planCols} rows={plans.filter((p) => !p.locationId || ids.has(p.locationId))} rowKey={(p) => p.id} empty={<Empty icon="gift" title={t('noPlans')} body={t('noPlansBody')} />} />;
            if (tab === 'sold') return <><p className="px-1 text-xs text-stone">{t('soldNote')}</p><DataTable columns={soldCols} rows={sold.filter((c) => ids.has(c.locationId))} rowKey={(c) => c.id} empty={<Empty icon="gift" title={t('noSold')} />} /></>;
            return <><p className="px-1 text-xs text-stone">{t('voucherNote')}</p><DataTable columns={vCols} rows={vouchers.filter((v) => !v.locationId || ids.has(v.locationId))} rowKey={(v) => v.id} onRowClick={(v) => setDrawer({ voucher: v.id })} empty={<Empty icon="gift" title={t('noVouchers')} />} /></>;
          }}
        </Loadable>
      </section>
      {drawer === 'plan' && res.status === 'ready' && <PlanDrawer services={res.data.services} onClose={() => setDrawer(null)} onDone={() => { setDrawer(null); res.reload(); }} />}
      {drawer === 'sell' && res.status === 'ready' && <SellDrawer plans={res.data.plans} onClose={() => setDrawer(null)} onDone={() => { setDrawer(null); res.reload(); }} />}
      {drawer === 'voucher' && <VoucherDrawer onClose={() => setDrawer(null)} onDone={() => { res.reload(); }} />}
      {drawer && typeof drawer === 'object' && <VoucherDetail id={drawer.voucher} onClose={() => setDrawer(null)} />}
    </>
  );
}

function PlanDrawer({ services, onClose, onDone }: { services: { id: string; name: string; locationId: string | null }[]; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('wellnessFull.packages');
  const app = useApp();
  const locs = useScopeLocations();
  const action = useWellnessAction(app.locations);
  const [f, setF] = useState({ locationId: locs[0]?.id ?? '', name: '', serviceId: '', sessions: 5, price: '', validityDays: 180, sharing: 'personal' as 'personal' | 'shareable', maxSharedWith: 1 });
  const loc = app.locations.find((l) => l.id === f.locationId);
  return (
    <Drawer open onClose={onClose} kicker={t('tabPlans')} title={t('newPlan')}>
      <div className="flex flex-col gap-3">
        <Field label={t('soldAt')}>{({ id }) => <Select id={id} value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}>{locs.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.currency})</option>)}</Select>}</Field>
        <Field label={t('plan')}>{({ id }) => <Input id={id} value={f.name} placeholder={t('planPh')} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t('service')}>{({ id }) => <Select id={id} value={f.serviceId} onChange={(e) => setF({ ...f, serviceId: e.target.value })}><option value="">{t('chooseService')}</option>{services.filter((s) => !s.locationId || s.locationId === f.locationId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label={t('sessions')}>{({ id }) => <Input id={id} type="number" min={1} value={f.sessions} onChange={(e) => setF({ ...f, sessions: Number(e.target.value) })} />}</Field>
          <Field label={t('priceIn', { currency: loc?.currency ?? '' })}>{({ id }) => <Input id={id} type="number" min={0} step="0.01" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />}</Field>
          <Field label={t('validityDays')}>{({ id }) => <Input id={id} type="number" min={1} value={f.validityDays} onChange={(e) => setF({ ...f, validityDays: Number(e.target.value) })} />}</Field>
        </div>
        <Field label={t('sharing')}>{({ id }) => <Select id={id} value={f.sharing} onChange={(e) => setF({ ...f, sharing: e.target.value as 'personal' })}><option value="personal">{t('personal')}</option><option value="shareable">{t('shareableOption')}</option></Select>}</Field>
        {action.error && <Banner tone="danger" live="assertive">{action.error.message}</Banner>}
        <Button disabled={!f.name || !f.serviceId || !f.price || action.pending} onClick={async () => { const ok = await action.run(async (api) => { await api.createPlan({ locationId: f.locationId, name: f.name, serviceId: f.serviceId, sessions: f.sessions, priceMinor: Math.round(Number(f.price) * 100), currency: loc!.currency, validityDays: f.validityDays, sharing: f.sharing, maxSharedWith: f.sharing === 'shareable' ? f.maxSharedWith : 0 }); return true; }); if (ok) onDone(); }}>{t('create')}</Button>
      </div>
    </Drawer>
  );
}

function SellDrawer({ plans, onClose, onDone }: { plans: PackagePlan[]; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('wellnessFull.packages');
  const app = useApp();
  const locs = useScopeLocations();
  const clients = useWellness(app.locations, (api) => api.clients(''), []);
  const action = useWellnessAction(app.locations);
  const [f, setF] = useState({ locationId: locs[0]?.id ?? '', planId: '', customerId: '' });
  const loc = app.locations.find((l) => l.id === f.locationId);
  const options = plans.filter((p) => p.active && (!p.locationId || p.locationId === f.locationId) && p.price.currency === loc?.currency);
  const plan = options.find((p) => p.id === f.planId);
  return (
    <Drawer open onClose={onClose} kicker={t('tabSold')} title={t('sell')}>
      <div className="flex flex-col gap-3">
        <Field label={t('soldAt')}>{({ id }) => <Select id={id} value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value, planId: '' })}>{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
        <Field label={t('plan')}>{({ id }) => <Select id={id} value={f.planId} onChange={(e) => setF({ ...f, planId: e.target.value })}><option value="">{t('choosePlan')}</option>{options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
        <Field label={t('client')}>{({ id }) => <Select id={id} value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">{t('chooseClient')}</option>{clients.status === 'ready' && clients.data.map((c) => <option key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ''}</option>)}</Select>}</Field>
        {plan && <Banner tone="info" title={t('consequence')}><Money m={plan.price} /> · {t('consequenceBody', { n: plan.sessions, days: plan.validityDays })}</Banner>}
        {action.error && <Banner tone="danger" live="assertive">{action.error.message}</Banner>}
        <Button disabled={!f.planId || !f.customerId || action.pending} onClick={async () => { const ok = await action.run(async (api) => { await api.sellPackage(f); return true; }); if (ok) onDone(); }}>{t('confirmSale')}</Button>
      </div>
    </Drawer>
  );
}

function VoucherDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations('wellnessFull.packages');
  const app = useApp();
  const locs = useScopeLocations();
  const action = useWellnessAction(app.locations);
  const [f, setF] = useState({ locationId: locs[0]?.id ?? '', amount: '100', recipientName: '', validityDays: 365 });
  const [issued, setIssued] = useState<Voucher | null>(null);
  const loc = app.locations.find((l) => l.id === f.locationId);
  return (
    <Drawer open onClose={onClose} kicker={t('tabVouchers')} title={t('issueVoucher')}>
      <div className="flex flex-col gap-3">
        {issued ? (
          <Banner tone="success" title={t('issued')} live="polite"><span className="tabular text-lg font-bold">{issued.code}</span> · <Money m={issued.balance} /></Banner>
        ) : (
          <>
            <Field label={t('soldAt')} hint={t('voucherCurrencyHint')}>{({ id, describedBy }) => <Select id={id} aria-describedby={describedBy} value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}>{locs.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.currency})</option>)}</Select>}</Field>
            <Field label={t('valueIn', { currency: loc?.currency ?? '' })}>{({ id }) => <Input id={id} type="number" min={1} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
            <Field label={t('recipient')} optional>{({ id }) => <Input id={id} value={f.recipientName} onChange={(e) => setF({ ...f, recipientName: e.target.value })} />}</Field>
            <Field label={t('validityDays')}>{({ id }) => <Input id={id} type="number" min={30} value={f.validityDays} onChange={(e) => setF({ ...f, validityDays: Number(e.target.value) })} />}</Field>
            {action.error && <Banner tone="danger" live="assertive">{action.error.message}</Banner>}
            <Button disabled={!Number(f.amount) || action.pending} onClick={async () => { const v = await action.run((api) => api.issueVoucher({ locationId: f.locationId, amountMinor: Math.round(Number(f.amount) * 100), recipientName: f.recipientName || undefined, validityDays: f.validityDays })); if (v) { setIssued(v); onDone(); } }}>{t('issue')}</Button>
          </>
        )}
      </div>
    </Drawer>
  );
}

function VoucherDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations('wellnessFull.packages');
  const locale = useLocale();
  const app = useApp();
  const res = useWellness(app.locations, (api) => api.voucher(id), [id]);
  return (
    <Drawer open onClose={onClose} kicker={t('tabVouchers')} title={res.status === 'ready' ? res.data.code : t('voucher')}>
      <Loadable res={res}>
        {(v) => (
          <div className="flex flex-col gap-3 text-[13px]">
            <div className="flex items-center gap-2"><StatusBadge status={v.status} /><span>{t('balance')}: <strong><Money m={v.balance} /></strong> / <Money m={v.initial} /></span></div>
            <p className="text-stone">{t('voucherRule', { currency: v.balance.currency })}</p>
            <ul className="flex flex-col gap-1">
              {(v.transactions ?? []).map((x) => (
                <li key={x.id} className="grid grid-cols-[1fr_auto_auto] gap-3 rounded-md bg-canvas px-3 py-2">
                  <span>{t(`tx.${x.kind}`)} · {fmtYmd(x.createdAt.slice(0, 10), locale, { day: 'numeric', month: 'short' })}</span>
                  <span className={x.amount.amount < 0 ? 'text-danger' : 'text-success'}><Money m={x.amount} /></span>
                  <span className="text-stone"><Money m={x.balanceAfter} /></span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Loadable>
    </Drawer>
  );
}

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, DataTable, Drawer, Input, Select, Tabs } from '@bh/ui';
import { cx as call, useAction, useCommerce } from '@/lib/commerce/client';
import type { ReturnView } from '@/lib/commerce/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, SectionCard } from '../../ui/States';
import { ActionError, History, Money, MoneyInput, NumberInput, StatusBadge, View, When, useCt } from './kit';

type Tab = 'open' | 'approval' | 'closed';

/** Returns: requested → reviewed → authorised → received (restock / write-off) → resolved (refund, store credit or exchange). */
export function ReturnsScreen() {
  const t = useCt();
  const app = useApp();
  const [tab, setTab] = useState<Tab>('open');
  const [open, setOpen] = useState<string | null>(null);
  const res = useCommerce(() => call<{ items: ReturnView[] }>('GET', '/returns'), [app.org.id, app.apiMode]);
  const ids = app.scope.locationIds;
  const all = (res.data?.items ?? []).filter((r) => !ids.length || ids.includes(r.locationId));
  const pick: Record<Tab, (r: ReturnView) => boolean> = { open: (r) => ['requested', 'reviewed', 'authorised', 'received'].includes(r.status), approval: (r) => r.status === 'refund_pending_approval', closed: (r) => ['resolved', 'rejected'].includes(r.status) };
  const sel = all.find((r) => r.id === open);
  return (
    <>
      <PageHeader icon="undo" title={t('returns.title')} description={t('returns.description')} />
      <SectionCard>
        <Tabs className="mb-3" value={tab} onChange={setTab} items={(['open', 'approval', 'closed'] as const).map((k) => ({ key: k, label: t(`returns.tabs.${k}`), count: all.filter(pick[k]).length }))} />
        <View res={res} isEmpty={() => !all.filter(pick[tab]).length} empty={<Empty icon="undo" title={t('returns.empty')} />}>
          {() => (
            <DataTable rows={all.filter(pick[tab])} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} columns={[
              { key: 'rma', header: t('returns.rma'), render: (r) => <span className="font-bold">{r.rmaNumber}</span> },
              { key: 'order', header: t('returns.order'), render: (r) => r.orderNumber },
              { key: 'store', header: t('common.store'), render: (r) => r.locationName },
              { key: 'status', header: t('returns.status'), render: (r) => <StatusBadge kind="return" value={r.status} /> },
              { key: 'via', header: t('returns.via'), render: (r) => t(`returns.viaKind.${r.requestedVia}`) },
              { key: 'value', header: t('returns.value'), align: 'right', render: (r) => <Money m={r.value.amount ? r.value : r.requestedValue} /> },
              { key: 'when', header: t('returns.created'), render: (r) => <When iso={r.createdAt} /> },
            ]} />
          )}
        </View>
      </SectionCard>
      {sel && <ReturnDrawer r={sel} onClose={() => setOpen(null)} onChanged={(u) => res.data && res.setData({ items: res.data.items.map((x) => (x.id === u.id ? u : x)) })} />}
    </>
  );
}

function ReturnDrawer({ r, onClose, onChanged }: { r: ReturnView; onClose: () => void; onChanged: (r: ReturnView) => void }) {
  const t = useCt();
  const app = useApp();
  const manager = app.can('locations.read') && app.can('operations.write');
  const [note, setNote] = useState('');
  const [recv, setRecv] = useState<Record<string, { qty: number; disp: 'restock' | 'write_off' }>>(Object.fromEntries(r.lines.map((l) => [l.variantId, { qty: l.quantity, disp: 'restock' as const }])));
  const [resolution, setResolution] = useState<'refund' | 'store_credit'>('refund');
  const [amount, setAmount] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<{ outcome: string; giftCardCode: string | null; note?: string | null } | null>(null);
  const act = useAction(async (path: string, body: unknown) => {
    const out = await call<ReturnView & { return?: ReturnView; outcome?: string; giftCardCode?: string | null }>('POST', `/returns/${r.id}/${path}`, body);
    const ret = out.return ?? out;
    onChanged(ret as ReturnView);
    if (out.outcome) setOutcome({ outcome: out.outcome, giftCardCode: out.giftCardCode ?? null });
    return out;
  });
  return (
    <Drawer open onClose={onClose} kicker={t('returns.kicker')} title={`${r.rmaNumber} · ${t('returns.order')} ${r.orderNumber}`} footer={<Link href={`/ops/orders?open=${r.orderId}`} className="text-[13px] font-bold underline">{t('returns.openOrder')}</Link>}>
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap gap-2"><StatusBadge kind="return" value={r.status} />{r.approvalStatus && <span className="text-xs">{t('returns.approval', { status: r.approvalStatus })}</span>}</div>
        {r.reason && <p className="rounded-md bg-canvas-raised p-3">“{r.reason}”</p>}
        <ul className="flex flex-col gap-1.5">
          {r.lines.map((l) => (
            <li key={l.variantId} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised px-3 py-2">
              <span className="flex-1">{l.name} ×{l.quantity}{l.reason ? <span className="text-xs text-stone"> · {l.reason}</span> : null}</span>
              {r.status === 'authorised' ? (
                <>
                  <NumberInput value={recv[l.variantId]?.qty ?? 0} onChange={(n) => setRecv((s) => ({ ...s, [l.variantId]: { ...s[l.variantId]!, qty: n } }))} label={t('returns.receivedQty', { name: l.name ?? '' })} />
                  <Select value={recv[l.variantId]?.disp} onChange={(e) => setRecv((s) => ({ ...s, [l.variantId]: { ...s[l.variantId]!, disp: e.target.value as 'restock' | 'write_off' } }))} className="h-10 w-36" aria-label={t('returns.disposition')}>
                    <option value="restock">{t('returns.restock')}</option><option value="write_off">{t('returns.writeOff')}</option>
                  </Select>
                </>
              ) : l.receivedQty !== undefined ? <span className="text-xs">{t('returns.receivedAs', { n: l.receivedQty, disp: t(l.disposition === 'write_off' ? 'returns.writeOff' : 'returns.restock') })}</span> : null}
              <Money m={l.unitPrice} />
            </li>
          ))}
        </ul>
        <ActionError error={act.error} />
        {outcome && <Banner tone="success" live="polite" title={t(`returns.outcome.${outcome.outcome}`)}>{outcome.giftCardCode && <>{t('returns.codeOnce')} <code className="font-bold">{outcome.giftCardCode}</code></>}</Banner>}
        {['requested', 'reviewed'].includes(r.status) && <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('returns.note')} aria-label={t('returns.note')} className="h-10" />}
        {r.status === 'requested' && app.can('operations.write') && <Button variant="secondary" onClick={() => act.run('review', { note: note || undefined })}>{t('returns.markReviewed')}</Button>}
        {['requested', 'reviewed'].includes(r.status) && manager && (
          <div className="flex flex-wrap gap-2">
            {r.status === 'reviewed' && <Button onClick={() => act.run('authorise', { note: note || undefined })}>{t('returns.authorise')}</Button>}
            <Button variant="secondary" disabled={!note} onClick={() => act.run('reject', { note })}>{t('returns.reject')}</Button>
          </div>
        )}
        {r.status === 'authorised' && app.can('operations.write') && <Button icon="box" onClick={() => act.run('receive', { lines: Object.entries(recv).map(([variantId, x]) => ({ variantId, receivedQty: x.qty, disposition: x.disp })) })}>{t('returns.receive')}</Button>}
        {(r.status === 'received' || (r.status === 'refund_pending_approval' && r.approvalStatus === 'rejected')) && manager && (
          <div className="rounded-lg border border-line-soft p-3">
            <div className="mb-2 font-bold">{t('returns.resolve')}</div>
            <Select value={resolution} onChange={(e) => setResolution(e.target.value as 'refund' | 'store_credit')} className="mb-2 h-10 max-w-xs" aria-label={t('returns.resolution')}>
              <option value="refund">{t('returns.res.refund')}</option><option value="store_credit">{t('returns.res.store_credit')}</option>
            </Select>
            <div className="flex flex-wrap items-center gap-2">
              <MoneyInput minor={amount ?? r.value.amount} currency={r.value.currency} label={t('returns.amount')} onChange={setAmount} />
              <Button onClick={() => act.run('resolve', { resolution, amountMinor: amount ?? undefined })}>{t('returns.confirmResolve')}</Button>
            </div>
            <p className="mt-1 text-xs text-stone">{t('returns.thresholdNote')}</p>
          </div>
        )}
        {r.status === 'refund_pending_approval' && r.approvalStatus !== 'rejected' && <Banner tone="warning" icon="shield">{t('returns.waitingApproval')} <Link className="underline" href="/approvals">{t('returns.openApprovals')}</Link></Banner>}
        <History items={r.history} />
      </div>
    </Drawer>
  );
}

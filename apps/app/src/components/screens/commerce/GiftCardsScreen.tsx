'use client';

import { useState } from 'react';
import { Button, DataTable, Drawer, Input, Select } from '@bh/ui';
import { cx as call, useAction, useCommerce } from '@/lib/commerce/client';
import type { GiftCard, M } from '@/lib/commerce/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, DeniedState, Empty, SectionCard } from '../../ui/States';
import { ActionError, F, Money, MoneyInput, MoneyList, View, When, useCt } from './kit';

/** Gift cards and store credit: balances per currency (one currency per card), ledger, issue and adjust. */
export function GiftCardsScreen() {
  const t = useCt();
  const app = useApp();
  const [issuing, setIssuing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const res = useCommerce(() => call<{ items: GiftCard[]; outstandingByCurrency: M[] }>('GET', '/gift-cards'), [app.org.id, app.apiMode], app.can('payments.read'));
  if (!app.can('payments.read')) return <DeniedState permission="payments.read" />;
  return (
    <>
      <PageHeader icon="gift" title={t('gift.title')} description={t('gift.description')} actions={app.can('payments.refund') && <Button icon="plus" onClick={() => setIssuing(true)}>{t('gift.issue')}</Button>} />
      <View res={res} isEmpty={(d) => !d.items.length} empty={<Empty icon="gift" title={t('gift.empty')} />}>
        {(d) => (
          <>
            <SectionCard title={t('gift.outstanding')}><MoneyList values={d.outstandingByCurrency} /><p className="mt-1 text-xs text-stone">{t('gift.perCurrency')}</p></SectionCard>
            <SectionCard>
              <DataTable rows={d.items} rowKey={(g) => g.id} onRowClick={(g) => setOpen(g.id)} columns={[
                { key: 'code', header: t('gift.code'), render: (g) => <code>{g.code}</code> },
                { key: 'kind', header: t('gift.kind'), render: (g) => t(`gift.kinds.${g.kind}`) },
                { key: 'who', header: t('gift.customer'), render: (g) => g.customerEmail ?? '—' },
                { key: 'bal', header: t('gift.balance'), align: 'right', render: (g) => <Money m={g.balance} className="font-bold" /> },
                { key: 'init', header: t('gift.initial'), align: 'right', render: (g) => <Money m={g.initial} /> },
                { key: 'why', header: t('gift.reason'), render: (g) => <span className="text-xs">{g.issuedReason}</span> },
                { key: 'when', header: t('gift.issued'), render: (g) => <When iso={g.createdAt} /> },
              ]} />
            </SectionCard>
          </>
        )}
      </View>
      {issuing && <Issue onClose={() => setIssuing(false)} onDone={() => res.reload()} />}
      {open && <Ledger id={open} onClose={() => { setOpen(null); res.reload(); }} />}
    </>
  );
}

function Issue({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useCt();
  const app = useApp();
  const [f, setF] = useState({ kind: 'gift_card', locationId: app.locations[0]?.id ?? '', amount: 2500 as number | null, email: '', reason: '' });
  const [code, setCode] = useState<string | null>(null);
  const currency = app.locations.find((l) => l.id === f.locationId)?.currency ?? 'USD';
  const save = useAction(async () => { const r = await call<GiftCard & { code: string }>('POST', '/gift-cards', { kind: f.kind, currency, amountMinor: f.amount, customerEmail: f.email || null, locationId: f.locationId, reason: f.reason || null }); setCode(r.code); onDone(); return r; });
  return (
    <Drawer open onClose={onClose} kicker={t('gift.title')} title={t('gift.issue')}>
      <div className="flex flex-col gap-3 text-sm">
        {code ? <Banner tone="success" live="polite" title={t('gift.issuedOk')}>{t('gift.codeOnce')} <code className="text-base font-bold">{code}</code></Banner> : (
          <>
            <F label={t('gift.kind')}><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="gift_card">{t('gift.kinds.gift_card')}</option><option value="store_credit">{t('gift.kinds.store_credit')}</option></Select></F>
            <F label={t('common.store')}><Select value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}>{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.currency}</option>)}</Select></F>
            <div><div className="mb-1 text-[13px] font-bold">{t('gift.amount')}</div><MoneyInput minor={f.amount} currency={currency} label={t('gift.amount')} onChange={(a) => setF({ ...f, amount: a })} /></div>
            <F label={t('gift.customer')} optional><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></F>
            <F label={t('gift.reason')} optional><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></F>
            <ActionError error={save.error} />
            <Button disabled={!f.amount} loading={save.pending} onClick={() => save.run()}>{t('gift.issueConfirm')}</Button>
          </>
        )}
      </div>
    </Drawer>
  );
}

function Ledger({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useCt();
  const res = useCommerce(() => call<GiftCard>('GET', `/gift-cards/${id}`), [id]);
  return (
    <Drawer open onClose={onClose} kicker={t('gift.ledger')} title={res.data?.code ?? ''}>
      <View res={res}>
        {(g) => (
          <div className="flex flex-col gap-2 text-sm">
            <div className="text-lg font-bold"><Money m={g.balance} /></div>
            <ul className="flex flex-col gap-1">{(g.ledger ?? []).map((l) => <li key={l.id} className="flex justify-between gap-2 rounded-md bg-canvas-raised px-3 py-2"><span>{t.has(`gift.entry.${l.kind}`) ? t(`gift.entry.${l.kind}`) : l.kind}{l.note ? ` · ${l.note}` : ''}</span><span><Money m={l.amount} /> → <Money m={l.balanceAfter} /></span></li>)}</ul>
          </div>
        )}
      </View>
    </Drawer>
  );
}

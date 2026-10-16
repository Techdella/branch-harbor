'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, cx } from '@bh/ui';
import { TerritoryMap } from '@bh/ui/map';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { download, fdevApi, useAction, useLoad, type MasterVM, type SplitStatementVM } from './api';
import { ActionError, KeyValue, PillTabs, StatusBadge, TerritoryStatus, useFmt } from './ui';

type Tab = 'agreements' | 'pipeline' | 'statements';

/**
 * Sales → Master franchise (and Finance → Royalty splits): master agreements with their split per currency, the
 * master franchisee's own pipeline for their countries, and split statements with payouts.
 */
export function MasterScreen({ initial = 'agreements' }: { initial?: Tab }) {
  const t = useTranslations('fdev');
  const app = useApp();
  const pipeMod = app.hasModule('sales.master_franchise');
  const splitMod = app.hasModule('finance.royalty_splits');
  const tabs: Tab[] = [...(pipeMod || splitMod ? (['agreements'] as Tab[]) : []), ...(pipeMod ? (['pipeline'] as Tab[]) : []), ...(splitMod ? (['statements'] as Tab[]) : [])];
  const [tab, setTab] = useState<Tab>(tabs.includes(initial) ? initial : tabs[0]!);
  const res = useLoad(() => fdevApi.masters(), [app.org.id]);
  const [sel, setSel] = useState<string | null>(null);
  const selected = res.data?.items.find((m) => m.id === sel) ?? res.data?.items[0] ?? null;
  return (
    <>
      <PageHeader icon="globe" title={initial === 'statements' ? t('master.splitsTitle') : t('master.title')} description={res.data?.view === 'master' ? t('master.descriptionMaster') : t('master.description')} scope={false} />
      {tabs.length > 1 && <PillTabs items={tabs.map((k) => [k, t(`master.tab.${k}`)] as [Tab, string])} value={tab} onChange={setTab} />}
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {(d) => (
          <>
            {tab === 'agreements' && <Agreements d={d} onChanged={res.reload} />}
            {tab === 'pipeline' && (d.items.length ? (
              <>
                {d.items.length > 1 && <div className="w-72"><Field label={t('master.agreement')}>{(x) => <Select id={x.id} value={selected?.id ?? ''} onChange={(e) => setSel(e.target.value)}>{d.items.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}</Field></div>}
                {selected && <Pipeline m={selected} />}
              </>
            ) : <Empty icon="globe" title={t('master.empty')} />)}
            {tab === 'statements' && <Statements />}
          </>
        )}
      </Async>
    </>
  );
}

const shares = (m: MasterVM, t: (k: string, v?: Record<string, string | number>) => string) => m.splits.map((s) => t('master.split', { currency: s.currency ?? t('master.anyCurrency'), royalty: s.royaltyShareBps / 100, fund: s.fundShareBps / 100 })).join(' · ');

function Agreements({ d, onChanged }: { d: { view: 'hq' | 'master'; items: MasterVM[]; can: { manage: boolean; splits: boolean } }; onChanged: () => void }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  const groups = useLoad(() => (d.can.manage ? fdevApi.ownerGroups() : Promise.resolve({ items: [] })), [d.can.manage]);
  const act = useAction();
  const [v, setV] = useState({ ownerGroupId: '', name: '', countries: '', homeCountry: '', royalty: '40', fund: '25', payout: 'manual', account: '' });
  return (
    <>
      {d.can.manage && (
        <SectionCard title={t('master.new')}>
          <div className="grid gap-2 sm:grid-cols-4">
            <Field label={t('master.masterGroup')}>{(x) => <Select id={x.id} value={v.ownerGroupId} onChange={(e) => setV((s) => ({ ...s, ownerGroupId: e.target.value }))}><option value="">—</option>{(groups.data?.items ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>}</Field>
            <Field label={t('master.name')}>{(x) => <Input id={x.id} value={v.name} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} />}</Field>
            <Field label={t('master.countries')} hint={t('master.countriesHint')}>{(x) => <Input id={x.id} value={v.countries} onChange={(e) => setV((s) => ({ ...s, countries: e.target.value.toUpperCase() }))} />}</Field>
            <Field label={t('master.home')}>{(x) => <Input id={x.id} maxLength={2} value={v.homeCountry} onChange={(e) => setV((s) => ({ ...s, homeCountry: e.target.value.toUpperCase() }))} />}</Field>
            <Field label={t('master.royaltyShare')}>{(x) => <Input id={x.id} inputMode="decimal" value={v.royalty} onChange={(e) => setV((s) => ({ ...s, royalty: e.target.value }))} />}</Field>
            <Field label={t('master.fundShare')}>{(x) => <Input id={x.id} inputMode="decimal" value={v.fund} onChange={(e) => setV((s) => ({ ...s, fund: e.target.value }))} />}</Field>
            <Field label={t('master.payout')}>{(x) => <Select id={x.id} value={v.payout} onChange={(e) => setV((s) => ({ ...s, payout: e.target.value }))}><option value="manual">{t('payoutMethod.manual')}</option><option value="stripe_transfer">{t('payoutMethod.stripe_transfer')}</option></Select>}</Field>
            {v.payout === 'stripe_transfer' && <Field label={t('master.account')}>{(x) => <Input id={x.id} value={v.account} onChange={(e) => setV((s) => ({ ...s, account: e.target.value }))} />}</Field>}
          </div>
          <ActionError error={act.error} />
          <Button className="mt-2" icon="plus" loading={act.pending} disabled={!v.ownerGroupId || !v.name.trim() || !v.countries.trim() || v.homeCountry.length !== 2} onClick={async () => {
            const countries = v.countries.split(/[\s,]+/).filter((c) => /^[A-Z]{2}$/.test(c));
            const r = await act.run(() => fdevApi.createMaster({ ownerGroupId: v.ownerGroupId, name: v.name.trim(), countries, homeCountry: v.homeCountry, startDate: new Date().toISOString().slice(0, 10), splits: [{ currency: null, royaltyShareBps: Math.round(Number(v.royalty) * 100), fundShareBps: Math.round(Number(v.fund) * 100) }], payoutMethod: v.payout, stripeAccountId: v.payout === 'stripe_transfer' ? v.account : null }));
            if (r) { setV((s) => ({ ...s, name: '', countries: '' })); onChanged(); }
          }}>{t('master.create')}</Button>
        </SectionCard>
      )}
      {d.items.length ? (
        <section className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]">
          {d.items.map((m) => (
            <article key={m.id} className="flex flex-col gap-2 rounded-xl bg-surface p-4">
              <div className="flex items-start justify-between gap-2"><h3 className="text-[15px] font-extrabold">{m.name}</h3><StatusBadge status={m.status} /></div>
              <KeyValue items={[
                [t('master.masterGroup'), m.ownerGroupName ?? '—'],
                [t('master.kindLabel'), t(`masterKind.${m.kind}`)],
                [t('master.countries'), `${m.countries.join(', ')}${m.regions.length ? ` (${m.regions.join(', ')})` : ''}`],
                [t('master.since'), f.date(m.startDate)],
                [t('master.splits'), shares(m, t as never) || '—'],
                [t('master.payout'), `${t(`payoutMethod.${m.payoutMethod}`)}${m.payoutMethod === 'stripe_transfer' && !m.stripeAccountConnected ? ` · ${t('master.noAccount')}` : ''}`],
                [t('master.units'), String(m.units ?? 0)],
                [t('master.pipelineCount'), String(m.activeProspects ?? 0)],
              ]} />
            </article>
          ))}
        </section>
      ) : <Empty icon="globe" title={t('master.empty')} body={d.can.manage ? t('master.emptyBody') : undefined} />}
    </>
  );
}

function Pipeline({ m }: { m: MasterVM }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  const res = useLoad(() => fdevApi.masterPipeline(m.id), [m.id]);
  const act = useAction();
  const [v, setV] = useState({ name: '', email: '', country: m.countries[0] ?? '', city: '' });
  const [doc, setDoc] = useState<Record<string, string>>({});
  return (
    <Async res={res} loading={<LoadingBlock variant="detail" />}>
      {(d) => (
        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <div className="flex flex-col gap-3">
            <Banner tone="neutral" icon="scale">{t('master.rulesNote', { home: m.homeCountry })}</Banner>
            {d.can.edit && (
              <SectionCard title={t('master.addProspect')}>
                <div className="grid gap-2 sm:grid-cols-4">
                  <Field label={t('master.prospectName')}>{(x) => <Input id={x.id} value={v.name} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} />}</Field>
                  <Field label={t('master.email')}>{(x) => <Input id={x.id} type="email" value={v.email} onChange={(e) => setV((s) => ({ ...s, email: e.target.value }))} />}</Field>
                  <Field label={t('master.country')}>{(x) => <Select id={x.id} value={v.country} onChange={(e) => setV((s) => ({ ...s, country: e.target.value }))}>{m.countries.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
                  <Field label={t('master.city')} optional>{(x) => <Input id={x.id} value={v.city} onChange={(e) => setV((s) => ({ ...s, city: e.target.value }))} />}</Field>
                </div>
                <ActionError error={act.error} />
                <Button className="mt-2" size="sm" icon="plus" disabled={!v.name.trim() || !v.email.includes('@')} loading={act.pending} onClick={async () => { if (await act.run(() => fdevApi.masterProspect(m.id, { name: v.name.trim(), email: v.email.trim(), country: v.country, city: v.city || null, source: 'other' }))) { setV((s) => ({ ...s, name: '', email: '', city: '' })); res.reload(); } }}>{t('master.add')}</Button>
              </SectionCard>
            )}
            <SectionCard title={t('master.pipeline')}>
              {d.prospects.length ? (
                <ul className="flex flex-col divide-y divide-line-soft">
                  {d.prospects.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
                      <span><strong>{p.name}</strong><span className="block text-xs text-stone">{[p.city, p.country].filter(Boolean).join(', ')} · {t(`stage.${p.stage}` as 'stage.enquiry')} · {f.date(p.createdAt)}</span></span>
                      {d.can.disclose && d.documents.length > 0 && ['enquiry', 'qualified', 'discovery_call'].includes(p.stage) && (
                        <span className="flex items-center gap-2">
                          <Select aria-label={t('master.docFor', { name: p.name })} className="h-9 w-48!" value={doc[p.id] ?? ''} onChange={(e) => setDoc((s) => ({ ...s, [p.id]: e.target.value }))}><option value="">{t('master.chooseDoc')}</option>{d.documents.map((x) => <option key={x.id} value={x.id}>{x.title} v{x.version}</option>)}</Select>
                          <Button size="sm" variant="secondary" icon="send" disabled={!doc[p.id]} onClick={async () => { if (await act.run(() => fdevApi.masterDisclose(m.id, p.id, doc[p.id]!))) res.reload(); }}>{t('master.disclose')}</Button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-[13px] text-stone">{t('master.noProspects')}</p>}
            </SectionCard>
          </div>
          <SectionCard title={t('master.territories')}>
            {d.territories.length > 0 && <TerritoryMap className="mb-3 h-[280px] w-full" config={d.map} territories={d.territories} label={t('master.territories')} outlineNote={t('territories.outlineNote')} />}
            <ul className="flex flex-col gap-1.5 text-[13px]">{d.territories.map((x) => <li key={x.id} className="flex items-center justify-between gap-2"><span>{x.name} · {x.country}</span><TerritoryStatus status={x.status} /></li>)}</ul>
            {!d.territories.length && <p className="text-[13px] text-stone">{t('master.noTerritories')}</p>}
          </SectionCard>
        </div>
      )}
    </Async>
  );
}

function Statements() {
  const t = useTranslations('fdev');
  const f = useFmt();
  const res = useLoad(() => fdevApi.statements(), []);
  const periods = useLoad(() => fdevApi.periods().catch(() => ({ items: [] })), []);
  const act = useAction();
  const [period, setPeriod] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [ref, setRef] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<number | null>(null);
  return (
    <Async res={res} loading={<LoadingBlock variant="table" />}>
      {(d) => (
        <>
          {d.stripeMode === 'sandbox' && d.can.approve && <Banner tone="neutral" icon="info">{t('master.sandbox')}</Banner>}
          {d.can.generate && (
            <section className="flex flex-wrap items-end gap-2 rounded-xl bg-surface p-4">
              <div className="w-64"><Field label={t('master.period')}>{(x) => <Select id={x.id} value={period} onChange={(e) => setPeriod(e.target.value)}><option value="">—</option>{(periods.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{f.date(p.startDate)} – {f.date(p.endDate)}</option>)}</Select>}</Field></div>
              <Button icon="refresh" disabled={!period} loading={act.pending} onClick={async () => { const r = await act.run(() => fdevApi.generateStatements(period)); if (r) { setSkipped(r.skipped.length); res.reload(); } }}>{t('master.generate')}</Button>
              {skipped !== null && skipped > 0 && <span className="text-xs text-stone">{t('master.skipped', { count: skipped })}</span>}
            </section>
          )}
          <ActionError error={act.error} />
          {d.items.length ? (
            <div className="flex flex-col gap-3">
              {d.items.map((s) => (
                <article key={s.id} className="rounded-xl bg-surface p-4" data-testid="split-statement">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span>
                      <h3 className="text-[15px] font-extrabold">{s.number}</h3>
                      <span className="text-xs text-stone">{[s.masterName, s.period ? `${f.date(s.period.startDate)} – ${f.date(s.period.endDate)}` : null, s.currency].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="flex items-center gap-2"><StatusBadge status={s.status} />{s.sandbox && <Badge tone="warning">{t('master.sandboxBadge')}</Badge>}</span>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-4">
                    <Figure label={t('master.billed')} value={f.money(s.royaltyMinor + s.marketingFundMinor, s.currency)} sub={t('master.billedSub', { royalty: f.money(s.royaltyMinor, s.currency), fund: f.money(s.marketingFundMinor, s.currency) })} />
                    <Figure label={t('master.masterShare')} value={f.money(s.masterRoyaltyMinor + s.masterFundMinor, s.currency)} sub={t('master.shareSub', { royalty: s.royaltyShareBps / 100, fund: s.fundShareBps / 100 })} strong />
                    <Figure label={t('master.hqShare')} value={f.money(s.hqRoyaltyMinor + s.hqFundMinor, s.currency)} />
                    <Figure label={t('master.payable')} value={f.money(s.payableMinor, s.currency)} sub={t('master.payableSub')} strong />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="ghost" icon={open === s.id ? 'chevron-down' : 'chevron-right'} onClick={() => setOpen(open === s.id ? null : s.id)}>{t('master.lines', { count: s.lines.length })}</Button>
                    <Button size="sm" variant="ghost" icon="download" onClick={() => void download(`/master/statements/${s.id}/export`, `${s.number}.pdf`, { format: 'pdf' })}>{t('master.pdf')}</Button>
                    {d.can.export && <Button size="sm" variant="ghost" icon="download" onClick={() => void download(`/master/statements/${s.id}/export`, `${s.number}.csv`, { format: 'csv' })}>{t('common.exportCsv')}</Button>}
                    {d.can.approve && s.status === 'draft' && <Button size="sm" icon="check" onClick={async () => { if (await act.run(() => fdevApi.approveStatement(s.id))) res.reload(); }}>{t('master.approve')}</Button>}
                    {d.can.approve && s.status === 'approved' && (
                      <>
                        <Button size="sm" icon="send" disabled={!s.payableMinor} onClick={async () => { if (await act.run(() => fdevApi.payStatement(s.id, { method: 'stripe_transfer' }))) res.reload(); }}>{t('master.payStripe')}</Button>
                        <Input aria-label={t('master.reference')} placeholder={t('master.reference')} className="h-9 w-44!" value={ref[s.id] ?? ''} onChange={(e) => setRef((x) => ({ ...x, [s.id]: e.target.value }))} />
                        <Button size="sm" variant="secondary" disabled={!s.payableMinor || !ref[s.id]} onClick={async () => { if (await act.run(() => fdevApi.payStatement(s.id, { method: 'manual', reference: ref[s.id] }))) res.reload(); }}>{t('master.payManual')}</Button>
                      </>
                    )}
                    {s.status === 'paid' && <span className="text-xs text-stone">{t('master.paidOn', { date: f.date(s.paidAt), ref: s.transferId ?? s.payoutReference ?? '' })}</span>}
                  </div>
                  {open === s.id && <Lines s={s} />}
                </article>
              ))}
            </div>
          ) : <Empty icon="receipt" title={t('master.noStatements')} body={d.can.generate ? t('master.noStatementsBody') : undefined} />}
        </>
      )}
    </Async>
  );
}

function Figure({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={cx('rounded-md p-3', strong ? 'bg-[#E2F5A6]' : 'bg-canvas')}>
      <div className="text-xs font-semibold">{label}</div>
      <div className="tabular text-[18px] font-extrabold">{value}</div>
      {sub && <div className="text-[11px] text-graphite">{sub}</div>}
    </div>
  );
}

function Lines({ s }: { s: SplitStatementVM }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead><tr className="border-b border-line-soft text-left text-xs text-stone">{[t('master.location'), t('master.royalty'), t('master.fund'), t('master.collected'), t('master.masterShare')].map((h) => <th key={h} scope="col" className="py-1.5 pe-2">{h}</th>)}</tr></thead>
        <tbody>
          {s.lines.map((l) => (
            <tr key={l.locationId} className="border-b border-line-soft last:border-0">
              <td className="py-2 pe-2 font-semibold">{l.locationName}<span className="block text-xs font-normal text-stone">{t(`status.${l.statementStatus}` as 'status.paid')}</span></td>
              <td className="tabular py-2 pe-2">{f.money(l.royaltyMinor, s.currency)}</td>
              <td className="tabular py-2 pe-2">{f.money(l.marketingFundMinor, s.currency)}</td>
              <td className="tabular py-2 pe-2">{f.money(l.collectedRoyaltyMinor + l.collectedFundMinor, s.currency)}</td>
              <td className="tabular py-2 pe-2 font-bold">{f.money(l.masterRoyaltyMinor + l.masterFundMinor, s.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

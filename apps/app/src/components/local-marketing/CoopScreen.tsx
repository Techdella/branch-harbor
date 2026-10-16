'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Input, Select, Tabs, Textarea, type Tone } from '@bh/ui';
import { COOP_PERIODS, COOP_SPEND_KINDS, DEFAULT_COOP_CHECKLIST } from '@bh/shared';
import { fmtYmd } from '@/lib/format';
import { API_URL, getAccessToken } from '@/lib/http/client';
import { orgId } from '@/lib/http/workspace';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { NotAvailable } from '../screens/NotAvailable';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { coopApi, fileToUpload, type AssetTemplateVM, type Burn, type CoopRequestVM } from './api';
import { BurnBar, Kpi, KpiRow, toMinor, useMoneyFmt } from './ui';

type Tab = 'overview' | 'requests' | 'allowances' | 'templates';
const M = 'marketing.coop';
export const STATUS_TONE: Record<string, Tone> = { submitted: 'info', changes_requested: 'warning', approved: 'success', rejected: 'danger', claimed: 'signal', cancelled: 'neutral', paid: 'success' };

/**
 * Marketing → Co-op fund: allowances per location (a share of fund contributions or a fixed amount, with a matching
 * ratio), pre-approval requests reviewed against the brand checklist, claims with the invoice and proof of
 * performance, reimbursement booked in the Finance fund ledger, burn-down per location and across the network, and
 * the approved local asset library.
 */
export function CoopScreen() {
  const t = useTranslations('lmk.coop');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const [open, setOpen] = useState<string | null>(params.get('request'));
  const [creating, setCreating] = useState(false);
  if (!app.hasModule(M)) return <NotAvailable />;
  const canEdit = app.capabilities.has(`${M}:edit`);
  const tabs: Array<{ key: Tab; label: string }> = [{ key: 'overview', label: t('tab.overview') }, { key: 'requests', label: t('tab.requests') }, { key: 'allowances', label: t('tab.allowances') }, { key: 'templates', label: t('tab.templates') }];
  return (
    <>
      <PageHeader icon="wallet" title={t('title')} description={t('description')} actions={canEdit ? <Button icon="plus" onClick={() => setCreating(true)}>{t('newRequest')}</Button> : undefined} />
      <Tabs items={tabs} value={tab} onChange={(k) => router.replace(`?tab=${k}`, { scroll: false })} />
      {tab === 'overview' && <Overview />}
      {tab === 'requests' && <Requests onOpen={setOpen} />}
      {tab === 'allowances' && <Allowances />}
      {tab === 'templates' && <Templates />}
      <RequestDrawer id={open} onClose={() => setOpen(null)} />
      <NewRequestDrawer open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); router.replace('?tab=requests', { scroll: false }); setOpen(id); }} />
    </>
  );
}

function Overview() {
  const t = useTranslations('lmk.coop');
  const app = useApp();
  const money = useMoneyFmt();
  const res = useApi(() => coopApi.overview(), [app.org.id]);
  return (
    <Async res={res} loading={<LoadingBlock variant="cards" />}>
      {(d) => (
        <>
          <KpiRow>
            {d.totals.map((x) => <Kpi key={x.currency} label={t('kpi.remaining', { period: d.periodKey, currency: x.currency })} value={money(x.remainingMinor, x.currency)} sub={t('kpi.of', { allowance: money(x.allowanceMinor, x.currency), n: x.locations })} testId="kpi-remaining" />)}
            <Kpi label={t('kpi.requests')} value={d.queue.requests} sub={t('kpi.requestsSub')} />
            <Kpi label={t('kpi.claims')} value={d.queue.claims} sub={t('kpi.claimsSub', { n: d.queue.toPay })} />
          </KpiRow>
          {!d.totals.length && <Banner tone="info" title={t('noProgramme.title')}>{t('noProgramme.body')}</Banner>}
          <SectionCard title={t('burnDown', { period: d.periodKey })} aside={<span className="flex flex-wrap gap-3 text-xs text-stone"><Legend className="bg-ink" label={t('legend.paid')} /><Legend className="bg-graphite" label={t('legend.claimed')} /><Legend className="bg-lime" label={t('legend.committed')} /></span>}>
            <DataTable<Burn & { name?: string }>
              rows={d.items}
              rowKey={(r) => r.locationId}
              rowLabel={(r) => r.name ?? ''}
              columns={[
                { key: 'n', header: t('col.location'), render: (r) => <strong>{r.name}</strong> },
                { key: 'b', header: t('col.burn'), render: (r) => (r.hasProgramme ? <BurnBar allowance={r.allowanceMinor} paid={r.paidMinor} claimed={r.claimedMinor} committed={r.committedMinor} label={t('burnLabel', { remaining: money(r.remainingMinor, r.currency), allowance: money(r.allowanceMinor, r.currency) })} /> : <span className="text-stone">{t('noAllowance')}</span>) },
                { key: 'a', header: t('col.allowance'), align: 'right', render: (r) => <span className="tabular">{money(r.allowanceMinor, r.currency)}</span> },
                { key: 'c', header: t('col.committed'), align: 'right', render: (r) => <span className="tabular">{money(r.committedMinor, r.currency)}</span> },
                { key: 'p', header: t('col.paid'), align: 'right', render: (r) => <span className="tabular">{money(r.paidMinor, r.currency)}</span> },
                { key: 'r', header: t('col.remaining'), align: 'right', render: (r) => <strong className="tabular">{money(r.remainingMinor, r.currency)}</strong> },
              ]}
            />
          </SectionCard>
        </>
      )}
    </Async>
  );
}

const Legend = ({ className, label }: { className: string; label: string }) => <span className="inline-flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-full ${className}`} />{label}</span>;

function Requests({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useTranslations('lmk.coop');
  const app = useApp();
  const locale = useLocale();
  const money = useMoneyFmt();
  const [status, setStatus] = useState('');
  const res = useApi(() => coopApi.requests({ status: status || undefined }), [app.org.id, status]);
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('filter.status')}>{(f) => (
          <Select id={f.id} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('filter.all')}</option>
            {['submitted', 'changes_requested', 'approved', 'claimed', 'rejected', 'cancelled'].map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
          </Select>
        )}</Field>
      </div>
      <Async res={res} loading={<LoadingBlock variant="table" />}>
        {(d) => (
          <SectionCard>
            <DataTable<CoopRequestVM>
              rows={d.items}
              rowKey={(r) => r.id}
              onRowClick={(r) => onOpen(r.id)}
              rowLabel={(r) => r.title}
              empty={<Empty icon="wallet" title={t('noRequests')} />}
              columns={[
                { key: 't', header: t('col.request'), render: (r) => <span><strong>{r.title}</strong><span className="block text-xs text-stone">{r.locationName} · {t(`kind.${r.kind}`)}</span></span> },
                { key: 'd', header: t('col.dates'), render: (r) => fmtYmd(r.startsOn, locale, { day: 'numeric', month: 'short', year: 'numeric' }) },
                { key: 'b', header: t('col.budget'), align: 'right', render: (r) => <span className="tabular">{money(r.approvedMinor ?? r.budgetMinor, r.currency)}</span> },
                { key: 's', header: t('col.status'), render: (r) => <Badge tone={STATUS_TONE[r.claim ? r.claim.status : r.status] ?? 'neutral'}>{r.claim ? t(`claimStatus.${r.claim.status}`) : t(`status.${r.status}`)}</Badge> },
                { key: 'r', header: t('col.reimbursed'), align: 'right', render: (r) => (r.claim?.reimbursableMinor != null ? <span className="tabular">{money(r.claim.reimbursableMinor, r.currency)}</span> : <span className="text-stone">—</span>) },
              ]}
            />
          </SectionCard>
        )}
      </Async>
    </>
  );
}

/* ------------------------------ Request detail ------------------------------ */

function RequestDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useTranslations('lmk.coop');
  const res = useApi(() => (id ? coopApi.request(id) : Promise.resolve(null)), [id], !!id);
  return (
    <Drawer open={!!id} onClose={onClose} title={res.data?.title ?? t('request')} kicker={res.data?.locationName ?? t('request')}>
      {id && <Async res={res} loading={<LoadingBlock variant="detail" />}>{(r) => (r ? <RequestDetail r={r} onChanged={() => res.reload()} /> : null)}</Async>}
    </Drawer>
  );
}

function RequestDetail({ r, onChanged }: { r: CoopRequestVM; onChanged: () => void }) {
  const t = useTranslations('lmk.coop');
  const locale = useLocale();
  const money = useMoneyFmt();
  const [checks, setChecks] = useState<Record<string, boolean>>(() => Object.fromEntries(r.checklist.map((c) => [c.key, c.passed])));
  const [approved, setApproved] = useState(String((r.approvedMinor ?? r.budgetMinor) / 100));
  const [note, setNote] = useState('');
  const decide = useMutation((_a, decision: 'approve' | 'reject' | 'changes_requested') => coopApi.decide(r.id, { decision, checklist: Object.entries(checks).map(([key, passed]) => ({ key, passed })), approvedMinor: toMinor(approved), note: note || null }));
  const label = (c: { key: string; label?: string | null }) => c.label || ((DEFAULT_COOP_CHECKLIST as readonly string[]).includes(c.key) ? t(`checklist.${c.key}`) : c.key);
  return (
    <div className="flex flex-col gap-4" data-testid="coop-request">
      <div className="flex flex-wrap gap-2"><Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{t(`status.${r.status}`)}</Badge><Badge>{t(`kind.${r.kind}`)}</Badge><Badge>{r.periodKey}</Badge></div>
      <dl className="grid gap-1.5 text-sm sm:grid-cols-[150px_1fr]">
        <dt className="text-stone">{t('budget')}</dt><dd className="tabular">{money(r.budgetMinor, r.currency)}{r.approvedMinor != null && r.approvedMinor !== r.budgetMinor ? ` · ${t('approvedAmount', { amount: money(r.approvedMinor, r.currency) })}` : ''}</dd>
        <dt className="text-stone">{t('dates')}</dt><dd>{fmtYmd(r.startsOn, locale, { day: 'numeric', month: 'short', year: 'numeric' })}{r.endsOn ? ` – ${fmtYmd(r.endsOn, locale, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</dd>
        {r.vendor && <><dt className="text-stone">{t('vendor')}</dt><dd>{r.vendor}</dd></>}
        <dt className="text-stone">{t('requestedBy')}</dt><dd>{r.requestedBy.name}</dd>
        {r.description && <><dt className="text-stone">{t('details')}</dt><dd className="whitespace-pre-wrap">{r.description}</dd></>}
        {r.creative.length > 0 && <><dt className="text-stone">{t('creative')}</dt><dd>{r.creative.map((c, i) => (c.url ? <a key={i} className="me-2 underline" href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : <span key={i} className="me-2">{c.name}</span>))}</dd></>}
        {r.decisionNote && <><dt className="text-stone">{t('hqNote')}</dt><dd>{r.decisionNote}</dd></>}
      </dl>
      <SectionCard title={t('checklistTitle')}>
        <ul className="flex flex-col gap-1.5">
          {r.checklist.map((c) => (
            <li key={c.key}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!checks[c.key]} disabled={!(r.canDecide && r.status === 'submitted')} onChange={(e) => setChecks((x) => ({ ...x, [c.key]: e.target.checked }))} />
                {label(c)}
              </label>
            </li>
          ))}
        </ul>
        {r.canDecide && r.status === 'submitted' && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('approveAmount', { currency: r.currency })}>{(f) => <Input id={f.id} inputMode="decimal" value={approved} onChange={(e) => setApproved(e.target.value)} />}</Field>
              <Field label={t('note')} optional>{(f) => <Input id={f.id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button icon="check" loading={decide.pending} onClick={async () => { if (await decide.run('approve')) onChanged(); }}>{t('approve')}</Button>
              <Button variant="secondary" icon="edit" onClick={async () => { if (await decide.run('changes_requested')) onChanged(); }}>{t('requestChanges')}</Button>
              <Button variant="ghost" icon="x" onClick={async () => { if (await decide.run('reject')) onChanged(); }}>{t('reject')}</Button>
            </div>
            {decide.error && <Banner tone="danger" live="assertive">{decide.error.message}</Banner>}
          </div>
        )}
      </SectionCard>
      {r.status === 'approved' && !r.claim && r.canEdit && <ClaimForm r={r} onDone={onChanged} />}
      {r.claim && <ClaimCard r={r} onChanged={onChanged} />}
    </div>
  );
}

function ClaimForm({ r, onDone }: { r: CoopRequestVM; onDone: () => void }) {
  const t = useTranslations('lmk.coop');
  const [spent, setSpent] = useState('');
  const [invoice, setInvoice] = useState<File | null>(null);
  const [proofs, setProofs] = useState<File[]>([]);
  const [notes, setNotes] = useState('');
  const [leads, setLeads] = useState('');
  const [impressions, setImpressions] = useState('');
  const submit = useMutation(async (_a) => coopApi.claim(r.id, {
    spentMinor: toMinor(spent) ?? 0, invoice: await fileToUpload(invoice!), proofs: await Promise.all(proofs.map(fileToUpload)), proofNotes: notes,
    performance: Object.fromEntries([['leads', leads], ['impressions', impressions]].filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])),
  }));
  return (
    <SectionCard title={t('claimTitle')}>
      <p className="mb-3 text-sm text-stone">{t('claimIntro')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('spent', { currency: r.currency })}>{(f) => <Input id={f.id} inputMode="decimal" value={spent} onChange={(e) => setSpent(e.target.value)} />}</Field>
        <Field label={t('invoice')} hint={t('fileHint')}>{(f) => <Input id={f.id} type="file" accept="application/pdf,image/*" onChange={(e) => setInvoice(e.target.files?.[0] ?? null)} />}</Field>
        <Field label={t('proofs')} optional>{(f) => <Input id={f.id} type="file" multiple accept="application/pdf,image/*" onChange={(e) => setProofs([...(e.target.files ?? [])].slice(0, 5))} />}</Field>
        <Field label={t('perf.leads')} optional>{(f) => <Input id={f.id} inputMode="numeric" value={leads} onChange={(e) => setLeads(e.target.value.replace(/\D/g, ''))} />}</Field>
        <Field label={t('perf.impressions')} optional>{(f) => <Input id={f.id} inputMode="numeric" value={impressions} onChange={(e) => setImpressions(e.target.value.replace(/\D/g, ''))} />}</Field>
      </div>
      <div className="mt-3"><Field label={t('proofNotes')}>{(f) => <Textarea id={f.id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field></div>
      {submit.error && <Banner tone="danger" live="assertive">{submit.error.message}</Banner>}
      <div className="mt-3"><Button icon="send" loading={submit.pending} disabled={!invoice || !toMinor(spent)} onClick={async () => { if (await submit.run()) onDone(); }}>{t('submitClaim')}</Button></div>
    </SectionCard>
  );
}

function ClaimCard({ r, onChanged }: { r: CoopRequestVM; onChanged: () => void }) {
  const t = useTranslations('lmk.coop');
  const app = useApp();
  const money = useMoneyFmt();
  const c = r.claim!;
  const [ref, setRef] = useState('');
  const [method, setMethod] = useState<'bank_transfer' | 'manual'>('bank_transfer');
  const decide = useMutation((_a, d: 'approve' | 'reject') => coopApi.decideClaim(c.id, d));
  const pay = useMutation(() => coopApi.pay(c.id, { method, reference: ref || null }));
  const canPay = r.canDecide || app.capabilities.has('finance.marketing_fund:edit');
  const download = async (docId: string) => {
    const res = await fetch(`${API_URL}/v1/orgs/${orgId()}/coop/claims/${c.id}/documents/${docId}`, { headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` }, credentials: 'include' });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
  };
  return (
    <SectionCard title={t('claim')} aside={<Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{t(`claimStatus.${c.status}`)}</Badge>}>
      <dl className="grid gap-1.5 text-sm sm:grid-cols-[170px_1fr]">
        <dt className="text-stone">{t('spentLabel')}</dt><dd className="tabular">{money(c.spentMinor, c.currency)}</dd>
        {c.reimbursableMinor != null && <><dt className="text-stone">{t('reimbursable')}</dt><dd className="tabular font-bold">{money(c.reimbursableMinor, c.currency)}</dd></>}
        <dt className="text-stone">{t('files')}</dt>
        <dd className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" icon="download" onClick={() => download(c.invoiceDocumentId)}>{t('invoice')}</Button>{c.proofDocumentIds.map((p, i) => <Button key={p} size="sm" variant="ghost" icon="download" onClick={() => download(p)}>{t('proofN', { n: i + 1 })}</Button>)}</dd>
        {c.proofNotes && <><dt className="text-stone">{t('proofNotes')}</dt><dd>{c.proofNotes}</dd></>}
        {Object.keys(c.performance).length > 0 && <><dt className="text-stone">{t('results')}</dt><dd>{Object.entries(c.performance).map(([k, v]) => `${t(`perf.${k}`)}: ${v}`).join(' · ')}</dd></>}
        {c.paidAt && <><dt className="text-stone">{t('paid')}</dt><dd>{t(`payout.${c.payoutMethod}`)}{c.payoutReference ? ` · ${c.payoutReference}` : ''} · {t('ledgerBooked')}</dd></>}
      </dl>
      {r.canDecide && c.status === 'submitted' && (
        <div className="mt-3 flex gap-2">
          <Button icon="check" loading={decide.pending} onClick={async () => { if (await decide.run('approve')) onChanged(); }}>{t('approveClaim')}</Button>
          <Button variant="secondary" icon="x" onClick={async () => { if (await decide.run('reject')) onChanged(); }}>{t('reject')}</Button>
        </div>
      )}
      {canPay && c.status === 'approved' && (
        <div className="mt-3 flex flex-col gap-3 rounded-lg bg-canvas p-3">
          <p className="text-sm">{t('payIntro', { amount: money(c.reimbursableMinor ?? 0, c.currency) })}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('payoutMethod')}>{(f) => <Select id={f.id} value={method} onChange={(e) => setMethod(e.target.value as 'bank_transfer' | 'manual')}><option value="bank_transfer">{t('payout.bank_transfer')}</option><option value="manual">{t('payout.manual')}</option></Select>}</Field>
            <Field label={t('reference')} optional={method === 'manual'}>{(f) => <Input id={f.id} value={ref} onChange={(e) => setRef(e.target.value)} />}</Field>
          </div>
          <div><Button icon="wallet" loading={pay.pending} onClick={async () => { if (await pay.run()) onChanged(); }}>{t('markPaid')}</Button></div>
          <p className="text-xs text-stone">{t('payNote')}</p>
        </div>
      )}
      {(decide.error || pay.error) && <Banner tone="danger" live="assertive">{(decide.error ?? pay.error)!.message}</Banner>}
    </SectionCard>
  );
}

function NewRequestDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations('lmk.coop');
  const app = useApp();
  const [locationId, setLocationId] = useState('');
  const [kind, setKind] = useState<string>('print');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [vendor, setVendor] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [budget, setBudget] = useState('');
  const [link, setLink] = useState('');
  const loc = locationId || app.locations[0]?.id || '';
  const summary = useApi(() => (loc && startsOn ? coopApi.summary(loc, startsOn) : Promise.resolve(null)), [loc, startsOn], open && !!loc);
  const money = useMoneyFmt();
  const create = useMutation(() => coopApi.create({ locationId: loc, kind, title, description, vendor: vendor || null, startsOn, endsOn: null, budgetMinor: toMinor(budget) ?? 0, creative: link ? [{ kind: 'link', url: link, name: link.split('/').pop() || link }] : [] }));
  return (
    <Drawer open={open} onClose={onClose} title={t('newRequest')} kicker={t('title')}
      footer={<Button icon="send" loading={create.pending} disabled={!loc || title.trim().length < 3 || !startsOn || !toMinor(budget)} onClick={async () => { const r = await create.run(); if (r) onCreated(r.id); }}>{t('submitRequest')}</Button>}>
      <div className="flex flex-col gap-3">
        <Field label={t('location')}>{(f) => <Select id={f.id} value={loc} onChange={(e) => setLocationId(e.target.value)}>{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
        <Field label={t('kindLabel')}>{(f) => <Select id={f.id} value={kind} onChange={(e) => setKind(e.target.value)}>{COOP_SPEND_KINDS.map((k) => <option key={k} value={k}>{t(`kind.${k}`)}</option>)}</Select>}</Field>
        <Field label={t('titleLabel')}>{(f) => <Input id={f.id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label={t('details')} optional>{(f) => <Textarea id={f.id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('vendor')} optional>{(f) => <Input id={f.id} value={vendor} onChange={(e) => setVendor(e.target.value)} />}</Field>
          <Field label={t('startsOn')}>{(f) => <Input id={f.id} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />}</Field>
          <Field label={t('budgetLabel')}>{(f) => <Input id={f.id} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />}</Field>
          <Field label={t('creativeLink')} optional>{(f) => <Input id={f.id} type="url" value={link} onChange={(e) => setLink(e.target.value)} />}</Field>
        </div>
        {summary.data && (summary.data.hasProgramme
          ? <Banner tone="info">{t('availableNow', { remaining: money(summary.data.remainingMinor, summary.data.currency), period: summary.data.periodKey, match: Math.round(summary.data.matchRatioBps / 100) })}</Banner>
          : <Banner tone="warning">{t('noAllowance')}</Banner>)}
        {create.error && <Banner tone="danger" live="assertive">{create.error.message}</Banner>}
      </div>
    </Drawer>
  );
}

/* ------------------------------ Allowances ------------------------------ */

function Allowances() {
  const t = useTranslations('lmk.coop');
  const app = useApp();
  const money = useMoneyFmt();
  const res = useApi(() => coopApi.allowances(), [app.org.id]);
  const [period, setPeriod] = useState('quarter');
  const [basis, setBasis] = useState('fund_percent');
  const [value, setValue] = useState('');
  const [match, setMatch] = useState('50');
  const [locationId, setLocationId] = useState('');
  const save = useMutation(() => coopApi.setAllowance({ locationId: locationId || null, period, basis, percentBps: basis === 'fund_percent' ? Math.round(Number(value) * 100) : 0, fixedMinor: basis === 'fixed' ? toMinor(value) ?? 0 : 0, matchRatioBps: Math.round(Number(match) * 100) }));
  const name = (id: string | null) => (id ? app.locations.find((l) => l.id === id)?.name ?? '—' : t('networkDefault'));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard title={t('allowanceRules')}>
        <Async res={res} loading={<LoadingBlock variant="table" rows={2} />}>
          {(d) => (d.items.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {d.items.map((a) => (
                <li key={a.id} className="rounded-lg border border-line-soft p-3">
                  <strong>{name(a.locationId)}</strong>
                  <div>{t('ruleText', { period: t(`period.${a.period}`), amount: a.basis === 'fixed' ? money(a.fixedMinor, app.locations.find((l) => l.id === a.locationId)?.currency ?? app.org.defaultCurrency) : t('percentOfFund', { pct: a.percentBps / 100 }), match: a.matchRatioBps / 100 })}</div>
                </li>
              ))}
            </ul>
          ) : <Empty icon="wallet" title={t('noRules')} />)}
        </Async>
      </SectionCard>
      {res.data?.canEdit && (
        <SectionCard title={t('setRule')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('appliesTo')}>{(f) => <Select id={f.id} value={locationId} onChange={(e) => setLocationId(e.target.value)}><option value="">{t('networkDefault')}</option>{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
            <Field label={t('periodLabel')}>{(f) => <Select id={f.id} value={period} onChange={(e) => setPeriod(e.target.value)}>{COOP_PERIODS.map((p) => <option key={p} value={p}>{t(`period.${p}`)}</option>)}</Select>}</Field>
            <Field label={t('basisLabel')}>{(f) => <Select id={f.id} value={basis} onChange={(e) => setBasis(e.target.value)}><option value="fund_percent">{t('basis.fund_percent')}</option><option value="fixed">{t('basis.fixed')}</option></Select>}</Field>
            <Field label={basis === 'fixed' ? t('fixedAmount') : t('percent')}>{(f) => <Input id={f.id} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
            <Field label={t('matchLabel')} hint={t('matchHint')}>{(f) => <Input id={f.id} inputMode="decimal" value={match} onChange={(e) => setMatch(e.target.value)} />}</Field>
          </div>
          {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
          <div className="mt-3"><Button icon="check" loading={save.pending} disabled={!value} onClick={async () => { if (await save.run()) res.reload(); }}>{t('saveRule')}</Button></div>
        </SectionCard>
      )}
    </div>
  );
}

/* ------------------------------ Local asset templates ------------------------------ */

export function AssetPreview({ tpl, values }: { tpl: AssetTemplateVM; values: Record<string, string> }) {
  return (
    <svg viewBox={`0 0 ${tpl.width} ${tpl.height}`} className="h-auto w-full rounded-lg bg-ink" role="img" aria-label={tpl.name}>
      {tpl.baseUrl && <image href={tpl.baseUrl} x="0" y="0" width={tpl.width} height={tpl.height} preserveAspectRatio="xMidYMid slice" opacity="0.85" />}
      {tpl.fields.map((f) => (
        <text key={f.key} x={(f.x / 100) * tpl.width} y={(f.y / 100) * tpl.height} fontSize={(f.size / 1080) * tpl.width * 2} fill="#fff" fontWeight={f.locked ? 800 : 600} fontFamily="system-ui, sans-serif">{values[f.key] ?? f.default}</text>
      ))}
    </svg>
  );
}

function Templates() {
  const t = useTranslations('lmk.coop');
  const app = useApp();
  const res = useApi(() => coopApi.templates(), [app.org.id]);
  const [sel, setSel] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const loc = app.locations[0]?.id ?? '';
  const [locationId, setLocationId] = useState(loc);
  const save = useMutation((_a, id: string) => coopApi.customise(id, { locationId: locationId || loc, values }));
  const [saved, setSaved] = useState(false);
  return (
    <Async res={res} loading={<LoadingBlock variant="cards" rows={3} />}>
      {(d) => {
        const tpl = d.items.find((x) => x.id === sel);
        return d.items.length ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <ul className="grid gap-3 sm:grid-cols-2">
              {d.items.map((x) => (
                <li key={x.id}>
                  <button type="button" onClick={() => { setSel(x.id); setValues({}); setSaved(false); }} className={`w-full rounded-xl bg-surface p-3 text-left ${sel === x.id ? 'ring-2 ring-ink' : ''}`}>
                    <AssetPreview tpl={x} values={{}} />
                    <span className="mt-2 block font-semibold">{x.name}</span>
                    <span className="text-xs text-stone">{t(`assetKind.${x.kind}`)}{x.status !== 'published' ? ` · ${t('draft')}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
            {tpl ? (
              <SectionCard title={t('customise', { name: tpl.name })}>
                <AssetPreview tpl={tpl} values={values} />
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label={t('location')}>{(f) => <Select id={f.id} value={locationId} onChange={(e) => setLocationId(e.target.value)}>{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
                  {tpl.fields.map((f) => (
                    <Field key={f.key} label={f.label} hint={f.locked ? t('lockedByHq') : t('maxChars', { n: f.maxLength })}>{(p) => <Input id={p.id} disabled={f.locked} maxLength={f.maxLength} value={values[f.key] ?? f.default} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />}</Field>
                  ))}
                </div>
                {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
                {saved && <Banner tone="success" live="polite">{t('versionSaved')}</Banner>}
                <div className="mt-3"><Button icon="check" loading={save.pending} disabled={tpl.status !== 'published'} onClick={async () => { const editable = Object.fromEntries(Object.entries(values).filter(([k]) => !tpl.fields.find((f) => f.key === k)?.locked)); setValues(editable); if (await save.run(tpl.id)) setSaved(true); }}>{t('saveVersion')}</Button></div>
              </SectionCard>
            ) : <Empty icon="image" title={t('pickTemplate')} />}
          </div>
        ) : <Empty icon="image" title={t('noTemplates')} body={t('noTemplatesBody')} />;
      }}
    </Async>
  );
}

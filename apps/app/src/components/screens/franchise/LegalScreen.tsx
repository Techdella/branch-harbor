'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Field, Input, Select, Tabs } from '@bh/ui';
import { REGISTRATION_STATUSES } from '@bh/shared';
import { downloadDocument, fileToBase64, franchiseApi, useFranchise, useFranchiseAction, type Agreement, type FranchiseDocument, type Registration } from '@/lib/franchise/api';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, SectionCard } from '../../ui/States';
import { NotAvailable } from '../NotAvailable';
import { FAsync, NetworkOnly, useFmt } from './common';
import { ComplianceExpiring } from '../../quality/ComplianceScreen';

export function LegalScreen() {
  return <NetworkOnly><Legal /></NetworkOnly>;
}

type Tab = 'agreements' | 'documents' | 'registrations';

function Legal() {
  const t = useTranslations('franchise');
  const app = useApp();
  // Agreements: the whole register (Franchise agreements) or a franchise owner's own (New locations).
  // Documents and registrations: the franchise pipeline or either Legal module. Nothing else is shown.
  const agreements = app.can('legal.view') || app.can('onboarding.view');
  const documents = app.can('legal.view') || app.can('disclosure.view') || app.can('franchise.pipeline.view');
  const [tab, setTab] = useState<Tab>(app.can('legal.view') || !documents ? 'agreements' : 'documents');
  const tabs = [
    ...(agreements ? [{ key: 'agreements' as const, label: t('legal.agreements') }] : []),
    ...(documents ? [{ key: 'documents' as const, label: t('legal.documents') }, { key: 'registrations' as const, label: t('legal.registrations') }] : []),
  ];
  if (!tabs.length) return <NotAvailable />;
  return (
    <>
      <PageHeader icon="scale" title={t('legal.title')} description={t('legal.description')} scope={false} />
      {tabs.length > 1 && <Tabs items={tabs} value={tab} onChange={setTab} />}
      {tab === 'agreements' && <Agreements />}
      {tab === 'agreements' && <ComplianceExpiring />}
      {tab === 'documents' && <Documents />}
      {tab === 'registrations' && <Registrations />}
    </>
  );
}

function Agreements() {
  const t = useTranslations('franchise');
  const f = useFmt();
  const app = useApp();
  const res = useFranchise(() => franchiseApi.agreements(), [app.org.id]);
  const groups = useFranchise(() => franchiseApi.ownerGroups(), [app.org.id], app.can('legal.edit'));
  const act = useFranchiseAction();
  const [v, setV] = useState({ ownerGroupId: '', territory: '', jurisdiction: '', startDate: '', endDate: '', royalty: '6', fund: '2', renewal: '' });
  return (
    <div className="flex flex-col gap-3">
      <FAsync res={res} variant="table">
        {(d) => d.items.length ? (
          <div className="rounded-xl bg-surface p-2">
            <DataTable<Agreement>
              rows={d.items}
              rowKey={(r) => r.id}
              rowLabel={(r) => r.ownerGroupName ?? r.id}
              columns={[
                { key: 'group', header: t('legal.franchisee'), render: (r) => <span className="font-bold">{r.ownerGroupName ?? '—'}</span> },
                { key: 'territory', header: t('legal.territory'), render: (r) => <span>{r.territory ?? '—'}{r.jurisdiction ? <span className="text-stone"> ({r.jurisdiction})</span> : null}</span> },
                { key: 'term', header: t('legal.term'), render: (r) => `${f.date(r.startDate)} – ${f.date(r.endDate)}` },
                { key: 'fees', header: t('legal.fees'), render: (r) => t('legal.feesValue', { royalty: f.pct(r.royaltyBps), fund: f.pct(r.marketingFundBps) }) },
                { key: 'renewal', header: t('legal.renewal'), render: (r) => r.renewalOption ?? '—' },
                { key: 'status', header: t('legal.status'), render: (r) => r.expiringSoon ? <Badge tone="warning" icon="clock">{t('legal.expiresIn', { days: r.daysToExpiry })}</Badge> : <Badge tone={r.status === 'active' ? 'success' : 'neutral'}>{t(`agreementStatus.${r.status}` as 'agreementStatus.active')}</Badge> },
              ]}
            />
          </div>
        ) : <Empty icon="file" title={t('legal.noAgreements')} />}
      </FAsync>
      {app.can('legal.edit') && (
        <SectionCard title={t('legal.addAgreement')}>
          {act.error && <Banner tone="danger">{act.error.message}</Banner>}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('legal.franchisee')}>{(x) => (
              <Select id={x.id} value={v.ownerGroupId} onChange={(e) => setV((s) => ({ ...s, ownerGroupId: e.target.value }))}>
                <option value="">{t('actions.choose')}</option>
                {(groups.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </Select>
            )}</Field>
            <Field label={t('legal.territory')} optional>{(x) => <Input id={x.id} value={v.territory} onChange={(e) => setV((s) => ({ ...s, territory: e.target.value }))} />}</Field>
            <Field label={t('legal.jurisdiction')} optional>{(x) => <Input id={x.id} value={v.jurisdiction} maxLength={10} onChange={(e) => setV((s) => ({ ...s, jurisdiction: e.target.value.toUpperCase() }))} />}</Field>
            <Field label={t('legal.renewal')} optional>{(x) => <Input id={x.id} value={v.renewal} onChange={(e) => setV((s) => ({ ...s, renewal: e.target.value }))} />}</Field>
            <Field label={t('legal.start')}>{(x) => <Input id={x.id} type="date" value={v.startDate} onChange={(e) => setV((s) => ({ ...s, startDate: e.target.value }))} />}</Field>
            <Field label={t('legal.end')}>{(x) => <Input id={x.id} type="date" value={v.endDate} onChange={(e) => setV((s) => ({ ...s, endDate: e.target.value }))} />}</Field>
            <Field label={t('actions.royalty')}>{(x) => <Input id={x.id} inputMode="decimal" value={v.royalty} onChange={(e) => setV((s) => ({ ...s, royalty: e.target.value }))} />}</Field>
            <Field label={t('actions.fund')}>{(x) => <Input id={x.id} inputMode="decimal" value={v.fund} onChange={(e) => setV((s) => ({ ...s, fund: e.target.value }))} />}</Field>
          </div>
          <Button className="mt-3" icon="plus" disabled={!v.ownerGroupId || !v.startDate || !v.endDate} loading={act.pending} onClick={async () => {
            if (await act.run(() => franchiseApi.createAgreement({ ownerGroupId: v.ownerGroupId, territory: v.territory || null, jurisdiction: v.jurisdiction || null, startDate: v.startDate, endDate: v.endDate, renewalOption: v.renewal || null, royaltyBps: Math.round(Number(v.royalty) * 100), marketingFundBps: Math.round(Number(v.fund) * 100) }))) res.reload();
          }}>{t('legal.addAgreement')}</Button>
          <p className="mt-2 text-xs text-stone">{t('legal.remindersHint')}</p>
        </SectionCard>
      )}
    </div>
  );
}

function Documents() {
  const t = useTranslations('franchise');
  const f = useFmt();
  const app = useApp();
  const res = useFranchise(() => franchiseApi.documents(), [app.org.id]);
  const act = useFranchiseAction();
  // Disclosure documents are Disclosure; agreement templates, executed agreements and the vault are Franchise agreements.
  const kinds: FranchiseDocument['kind'][] = [...(app.can('disclosure.edit') ? (['disclosure'] as const) : []), ...(app.can('legal.edit') ? (['agreement_template', 'executed_agreement', 'vault'] as const) : [])];
  const [v, setV] = useState<{ kind: FranchiseDocument['kind']; title: string; version: string; jurisdictions: string; file: File | null }>({ kind: kinds[0] ?? 'disclosure', title: '', version: '', jurisdictions: '', file: null });
  return (
    <div className="flex flex-col gap-3">
      {act.error && <Banner tone="danger">{act.error.message}</Banner>}
      <FAsync res={res} variant="table">
        {(items) => items.length ? (
          <div className="rounded-xl bg-surface p-2">
            <DataTable<FranchiseDocument>
              rows={items}
              rowKey={(r) => r.id}
              rowLabel={(r) => r.title}
              columns={[
                { key: 'title', header: t('legal.docTitle'), render: (r) => <span className="font-bold">{r.title}</span> },
                { key: 'kind', header: t('legal.kind'), render: (r) => t(`docKind.${r.kind}`) },
                { key: 'version', header: t('legal.version'), render: (r) => r.version },
                { key: 'jur', header: t('legal.jurisdictions'), render: (r) => r.jurisdictions.join(', ') || '—' },
                { key: 'status', header: t('legal.status'), render: (r) => <Badge tone={r.status === 'current' ? 'success' : 'neutral'}>{t(`docStatus.${r.status}` as 'docStatus.current')}</Badge> },
                { key: 'date', header: t('legal.uploaded'), render: (r) => f.date(r.createdAt) },
                { key: 'dl', header: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" icon="download" aria-label={t('legal.download', { title: r.title })} onClick={() => act.run(() => downloadDocument(r))} /> },
              ]}
            />
          </div>
        ) : <Empty icon="file" title={t('legal.noDocuments')} />}
      </FAsync>
      {kinds.length > 0 && (
        <SectionCard title={t('legal.upload')}>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('legal.kind')}>{(x) => <Select id={x.id} value={v.kind} onChange={(e) => setV((s) => ({ ...s, kind: e.target.value as FranchiseDocument['kind'] }))}>{kinds.map((k) => <option key={k} value={k}>{t(`docKind.${k}`)}</option>)}</Select>}</Field>
            <Field label={t('legal.docTitle')}>{(x) => <Input id={x.id} value={v.title} onChange={(e) => setV((s) => ({ ...s, title: e.target.value }))} />}</Field>
            <Field label={t('legal.version')}>{(x) => <Input id={x.id} value={v.version} onChange={(e) => setV((s) => ({ ...s, version: e.target.value }))} />}</Field>
            <Field label={t('legal.jurisdictions')} hint={t('legal.jurisdictionsHint')} optional={v.kind !== 'disclosure'}>{(x) => <Input id={x.id} value={v.jurisdictions} onChange={(e) => setV((s) => ({ ...s, jurisdictions: e.target.value.toUpperCase() }))} />}</Field>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input type="file" aria-label={t('legal.file')} accept="application/pdf,.pdf,.doc,.docx" onChange={(e) => setV((s) => ({ ...s, file: e.target.files?.[0] ?? null }))} className="text-[13px]" />
            <Button icon="plus" disabled={!v.title || !v.file} loading={act.pending} onClick={async () => {
              const file = v.file!;
              const contentBase64 = await fileToBase64(file);
              const r = await act.run(() => franchiseApi.uploadDocument({ kind: v.kind, title: v.title, version: v.version || '1', jurisdictions: v.jurisdictions.split(/[,\s]+/).filter(Boolean), fileName: file.name, contentType: file.type || 'application/octet-stream', contentBase64 }));
              if (r) { setV((s) => ({ ...s, title: '', version: '', file: null })); res.reload(); }
            }}>{t('legal.upload')}</Button>
          </div>
          <p className="mt-2 text-xs text-stone">{t('legal.uploadHint')}</p>
        </SectionCard>
      )}
    </div>
  );
}

function Registrations() {
  const t = useTranslations('franchise');
  const f = useFmt();
  const app = useApp();
  const res = useFranchise(() => franchiseApi.registrations(), [app.org.id]);
  const act = useFranchiseAction();
  const [v, setV] = useState({ jurisdiction: '', status: 'registered', fileNumber: '', expiresAt: '' });
  return (
    <div className="flex flex-col gap-3">
      <Banner tone="info" icon="info">{t('legal.registrationsHint')}</Banner>
      {act.error && <Banner tone="danger">{act.error.message}</Banner>}
      <FAsync res={res} variant="table">
        {(items) => items.length ? (
          <div className="rounded-xl bg-surface p-2">
            <DataTable<Registration>
              rows={items}
              rowKey={(r) => r.id}
              rowLabel={(r) => r.jurisdiction}
              columns={[
                { key: 'j', header: t('legal.jurisdiction'), render: (r) => <span className="font-bold">{r.jurisdiction}</span> },
                { key: 's', header: t('legal.status'), render: (r) => <Badge tone={r.active ? 'success' : 'warning'}>{t(`registrationStatus.${r.status}` as 'registrationStatus.registered')}</Badge> },
                { key: 'n', header: t('legal.fileNumber'), render: (r) => r.fileNumber ?? '—' },
                { key: 'e', header: t('legal.expires'), render: (r) => f.date(r.expiresAt) },
              ]}
            />
          </div>
        ) : <Empty icon="shield" title={t('legal.noRegistrations')} />}
      </FAsync>
      {app.can('disclosure.edit') && (
        <SectionCard title={t('legal.recordRegistration')}>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-28"><Field label={t('legal.jurisdiction')}>{(x) => <Input id={x.id} value={v.jurisdiction} maxLength={6} onChange={(e) => setV((s) => ({ ...s, jurisdiction: e.target.value.toUpperCase() }))} />}</Field></div>
            <div className="w-40"><Field label={t('legal.status')}>{(x) => <Select id={x.id} value={v.status} onChange={(e) => setV((s) => ({ ...s, status: e.target.value }))}>{REGISTRATION_STATUSES.map((s) => <option key={s} value={s}>{t(`registrationStatus.${s}`)}</option>)}</Select>}</Field></div>
            <div className="w-40"><Field label={t('legal.fileNumber')} optional>{(x) => <Input id={x.id} value={v.fileNumber} onChange={(e) => setV((s) => ({ ...s, fileNumber: e.target.value }))} />}</Field></div>
            <div className="w-44"><Field label={t('legal.expires')} optional>{(x) => <Input id={x.id} type="date" value={v.expiresAt} onChange={(e) => setV((s) => ({ ...s, expiresAt: e.target.value }))} />}</Field></div>
            <Button icon="check" disabled={!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(v.jurisdiction)} loading={act.pending} onClick={async () => {
              if (await act.run(() => franchiseApi.saveRegistration(v.jurisdiction, { status: v.status, fileNumber: v.fileNumber || null, expiresAt: v.expiresAt ? `${v.expiresAt}T00:00:00Z` : null }))) res.reload();
            }}>{t('common.save')}</Button>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

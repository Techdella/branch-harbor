'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Input, Select, Toggle } from '@bh/ui';
import { COMPLIANCE_CATEGORIES } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { downloadCsv, qualityApi, readUpload, useQuality, useQualityAction, type ComplianceCategory, type DocumentVM, type MatrixVM, type RequirementInput, type RequirementVM } from './api';
import { ActionError, CellBadge, PillTabs, Tiles, useQFmt } from './ui';

type Tab = 'matrix' | 'documents' | 'requirements';

/** Minor units from a typed amount ("2,000,000" or "2000000.50"). */
function toMinor(s: string): number | null {
  const clean = s.replace(/[\s,']/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [w, fr = ''] = clean.split('.');
  return Number(w) * 100 + Number(fr.padEnd(2, '0'));
}

/**
 * Legal & compliance → Compliance documents. HQ: the matrix of locations × requirements, review of uploads and the
 * requirements. Franchisees: their own locations' status and uploads.
 */
export function ComplianceScreen() {
  const t = useTranslations('quality');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const manage = app.capabilities.has('legal.compliance_documents:publish');
  const tab = (params.get('tab') as Tab) || 'matrix';
  const [upload, setUpload] = useState<{ requirementId?: string; locationId?: string } | null>(null);
  const [version, setVersion] = useState(0);
  if (!app.hasModule('legal.compliance_documents')) return <DeniedState />;
  const tabs: Array<[Tab, string]> = [['matrix', t('compliance.tab.matrix')], ['documents', t('compliance.tab.documents')], ...(manage ? ([['requirements', t('compliance.tab.requirements')]] as Array<[Tab, string]>) : [])];
  const canUpload = app.capabilities.has('legal.compliance_documents:edit');
  return (
    <>
      <PageHeader icon="shield" title={t('compliance.title')} description={t('compliance.description')} scope={false}
        actions={canUpload ? <Button icon="plus" onClick={() => setUpload({})}>{t('compliance.upload')}</Button> : undefined} />
      <PillTabs items={tabs} value={tab} onChange={(k) => router.replace(`?tab=${k}`, { scroll: false })} />
      {tab === 'documents' ? <Documents key={version} manage={manage} /> : tab === 'requirements' && manage ? <Requirements /> : <Matrix key={version} onUpload={canUpload ? setUpload : undefined} />}
      {upload && <UploadDrawer preset={upload} onClose={() => setUpload(null)} onDone={() => { setUpload(null); setVersion((v) => v + 1); }} />}
    </>
  );
}

function Matrix({ onUpload }: { onUpload?: (p: { requirementId: string; locationId: string }) => void }) {
  const t = useTranslations('quality');
  const app = useApp();
  const f = useQFmt();
  const [category, setCategory] = useState('');
  const [group, setGroup] = useState('');
  const groups = useQuality(() => qualityApi.ownerGroups().catch(() => ({ items: [] })), [app.org.id]);
  const res = useQuality(() => qualityApi.matrix({ category: category || undefined, ownerGroupId: group || undefined }), [app.org.id, category, group]);
  const [open, setOpen] = useState<{ row: MatrixVM['rows'][number]; req: RequirementVM } | null>(null);
  return (
    <>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-48"><Field label={t('compliance.category')}>{(x) => (
          <Select id={x.id} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {COMPLIANCE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
          </Select>
        )}</Field></div>
        {(groups.data?.items.length ?? 0) > 1 && <div className="w-56"><Field label={t('common.ownerGroup')}>{(x) => (
          <Select id={x.id} value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {groups.data!.items.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        )}</Field></div>}
        <span className="flex-1" />
        {res.data?.can.export && <Button variant="ghost" size="sm" icon="download" onClick={() => void downloadCsv('/compliance/export', 'compliance-matrix.csv')}>{t('common.exportCsv')}</Button>}
      </div>
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.requirements.length} empty={<Empty icon="shield" title={t('compliance.noRequirements')} body={t('compliance.noRequirementsBody')} />}>
        {(d) => (
          <>
            <Tiles items={[
              { label: t('state.valid'), value: f.num(d.totals.valid ?? 0) },
              { label: t('state.expiring'), value: f.num(d.totals.expiring ?? 0) },
              { label: t('state.expired'), value: f.num(d.totals.expired ?? 0), tone: d.totals.expired ? 'danger' : undefined },
              { label: t('state.missing'), value: f.num(d.totals.missing ?? 0), tone: d.totals.missing ? 'danger' : undefined },
              { label: t('state.pending'), value: f.num(d.totals.pending ?? 0) },
            ]} />
            <section className="overflow-x-auto rounded-xl bg-surface p-3.5" data-testid="compliance-matrix">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line-soft text-left">
                    <th scope="col" className="sticky left-0 bg-surface px-3 py-3 text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{t('col.location')}</th>
                    {d.requirements.map((r) => (
                      <th key={r.id} scope="col" className="px-2 py-3 text-xs font-extrabold text-stone">
                        <span className="block uppercase tracking-[0.06em]">{r.name}</span>
                        <span className="block font-medium normal-case">{t(`category.${r.category}`)}{r.minAmount ? ` · ≥ ${f.money(r.minAmount.amountMinor, r.minAmount.currency)}` : ''}</span>
                      </th>
                    ))}
                    <th scope="col" className="px-2 py-3 text-right text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{t('compliance.compliant')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((row) => (
                    <tr key={row.location.id} className="border-b border-line-soft last:border-0">
                      <th scope="row" className="sticky left-0 bg-surface px-3 py-3 text-left font-bold">{row.location.name}<span className="block text-xs font-medium text-stone">{row.location.ownerGroupName ?? t('compliance.companyOwned')}</span></th>
                      {row.cells.map((c) => {
                        const req = d.requirements.find((r) => r.id === c.requirementId)!;
                        return (
                          <td key={c.requirementId} className="px-2 py-3">
                            {c.state === 'not_applicable' ? <span className="text-xs text-stone">{t('state.not_applicable')}</span> : (
                              <button type="button" className="flex flex-col items-start gap-0.5 text-left" onClick={() => setOpen({ row, req })} aria-label={`${row.location.name}: ${req.name}`}>
                                <CellBadge state={c.state} />
                                {c.expiresOn && <span className="text-[11px] text-stone">{f.date(c.expiresOn)}</span>}
                              </button>
                            )}
                          </td>
                        );
                      })}
                      <td className="tabular px-2 py-3 text-right font-bold">{row.compliant}/{row.applicable}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </Async>
      {open && <CellDrawer row={open.row} req={open.req} onClose={() => setOpen(null)} onUpload={onUpload ? () => { onUpload({ requirementId: open.req.id, locationId: open.row.location.id }); setOpen(null); } : undefined} />}
    </>
  );
}

function CellDrawer({ row, req, onClose, onUpload }: { row: MatrixVM['rows'][number]; req: RequirementVM; onClose: () => void; onUpload?: () => void }) {
  const t = useTranslations('quality');
  const app = useApp();
  const res = useQuality(() => qualityApi.documents({ locationId: row.location.id, requirementId: req.id }), [app.org.id, row.location.id, req.id]);
  return (
    <Drawer open onClose={onClose} title={req.name} kicker={row.location.name} footer={onUpload ? <Button icon="plus" onClick={onUpload}>{t('compliance.uploadFor')}</Button> : undefined}>
      <div className="flex flex-col gap-2">
        {req.description && <p className="text-sm text-stone">{req.description}</p>}
        <Async res={res} loading={<LoadingBlock variant="detail" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="file" title={t('compliance.noDocuments')} />}>
          {(d) => <ul className="flex flex-col gap-2">{d.items.map((doc) => <DocumentCard key={doc.id} doc={doc} manage={false} onChanged={res.reload} />)}</ul>}
        </Async>
      </div>
    </Drawer>
  );
}

function DocumentCard({ doc, manage, onChanged }: { doc: DocumentVM; manage: boolean; onChanged: () => void }) {
  const t = useTranslations('quality');
  const f = useQFmt();
  const act = useQualityAction();
  const [note, setNote] = useState('');
  return (
    <li className="flex flex-col gap-1.5 rounded-lg bg-canvas-raised p-3 text-[13px]">
      <div className="flex flex-wrap items-start gap-2">
        <span className="min-w-0 flex-1"><strong>{doc.title}</strong><span className="block text-xs text-stone">{doc.locationName ?? doc.ownerGroupName}{doc.requirementName ? ` · ${doc.requirementName}` : ''}</span></span>
        <Badge tone={doc.status === 'approved' ? 'success' : doc.status === 'rejected' ? 'danger' : 'info'}>{t(`docStatus.${doc.status}`)}</Badge>
        {doc.superseded && <Badge tone="neutral">{t('compliance.superseded')}</Badge>}
        {doc.expiry && !doc.superseded && <CellBadge state={doc.expiry} />}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        {doc.issuer && (<><dt className="text-stone">{t('compliance.issuer')}</dt><dd>{doc.issuer}</dd></>)}
        {doc.reference && (<><dt className="text-stone">{t('compliance.reference')}</dt><dd>{doc.reference}</dd></>)}
        {doc.coverageAmount && (<><dt className="text-stone">{t('compliance.coverage')}</dt><dd>{doc.coverageType ? `${doc.coverageType} · ` : ''}{f.money(doc.coverageAmount.amountMinor, doc.coverageAmount.currency)}</dd></>)}
        <dt className="text-stone">{t('compliance.expires')}</dt><dd>{doc.expiresOn ? f.date(doc.expiresOn) : t('compliance.noExpiry')}</dd>
        {doc.uploadedBy && (<><dt className="text-stone">{t('compliance.uploadedBy')}</dt><dd>{doc.uploadedBy}</dd></>)}
      </dl>
      {doc.reviewNote && <p className="text-xs"><strong>{t('compliance.reviewNote')}</strong> {doc.reviewNote}</p>}
      {doc.file && <a href={doc.file.url} target="_blank" rel="noreferrer" className="self-start text-xs font-bold underline">{t('compliance.openFile')}</a>}
      <ActionError error={act.error} />
      {manage && doc.status === 'pending' && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[180px] flex-1"><Field label={t('compliance.reviewNote')} optional>{(x) => <Input id={x.id} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />}</Field></div>
          <Button size="sm" variant="secondary" icon="x" disabled={!note} loading={act.pending} onClick={async () => { if (await act.run(() => qualityApi.reviewDocument(doc.id, 'reject', note))) onChanged(); }}>{t('compliance.reject')}</Button>
          <Button size="sm" icon="check" loading={act.pending} onClick={async () => { if (await act.run(() => qualityApi.reviewDocument(doc.id, 'approve', note || undefined))) onChanged(); }}>{t('compliance.approve')}</Button>
        </div>
      )}
    </li>
  );
}

function Documents({ manage }: { manage: boolean }) {
  const t = useTranslations('quality');
  const app = useApp();
  const [status, setStatus] = useState<'pending' | 'expiring' | 'expired' | 'all'>(manage ? 'pending' : 'all');
  const res = useQuality(() => qualityApi.documents({ status }), [app.org.id, status]);
  return (
    <>
      <PillTabs items={[['pending', t('compliance.filter.pending')], ['expiring', t('state.expiring')], ['expired', t('state.expired')], ['all', t('common.all')]]} value={status} onChange={setStatus} />
      <Async res={res} loading={<LoadingBlock variant="cards" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="file" title={t('compliance.noDocuments')} />}>
        {(d) => <ul className="grid gap-2 lg:grid-cols-2" data-testid="compliance-documents">{d.items.map((doc) => <DocumentCard key={doc.id} doc={doc} manage={manage} onChanged={res.reload} />)}</ul>}
      </Async>
    </>
  );
}

function UploadDrawer({ preset, onClose, onDone }: { preset: { requirementId?: string; locationId?: string }; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('quality');
  const app = useApp();
  const f = useQFmt();
  const reqs = useQuality(() => qualityApi.requirements(), [app.org.id]);
  const groups = useQuality(() => qualityApi.ownerGroups().catch(() => ({ items: [] })), [app.org.id]);
  const act = useQualityAction();
  const [v, setV] = useState({ requirementId: preset.requirementId ?? '', locationId: preset.locationId ?? '', ownerGroupId: '', category: 'insurance' as ComplianceCategory, title: '', issuer: '', reference: '', coverageType: '', amount: '', currency: String(app.org.defaultCurrency ?? 'USD'), issuedOn: '', expiresOn: '' });
  const [file, setFile] = useState<File | null>(null);
  const req = reqs.data?.items.find((r) => r.id === v.requirementId);
  const perGroup = req?.appliesTo === 'owner_group';
  const set = (p: Partial<typeof v>) => setV((s) => ({ ...s, ...p }));
  const amountMinor = v.amount ? toMinor(v.amount) : null;
  const valid = !!file && !!v.title && (perGroup ? !!v.ownerGroupId : !!v.locationId) && (!req?.requiresExpiry || !!v.expiresOn) && (!v.amount || amountMinor !== null);
  return (
    <Drawer open onClose={onClose} title={t('compliance.upload')} footer={
      <Button icon="check" disabled={!valid} loading={act.pending} onClick={async () => {
        const up = await act.run(async () => qualityApi.uploadDocument({
          requirementId: v.requirementId || null, locationId: perGroup ? null : v.locationId || null, ownerGroupId: perGroup ? v.ownerGroupId || null : null, category: req?.category ?? v.category, title: v.title,
          issuer: v.issuer || null, reference: v.reference || null, coverageType: v.coverageType || null, coverageAmountMinor: amountMinor, currency: amountMinor !== null ? v.currency : null,
          issuedOn: v.issuedOn || null, expiresOn: v.expiresOn || null, file: await readUpload(file!),
        }));
        if (up) onDone();
      }}>{t('compliance.uploadSave')}</Button>
    }>
      <div className="flex flex-col gap-3" data-testid="compliance-upload">
        <ActionError error={act.error} />
        <Field label={t('compliance.requirement')}>{(x) => (
          <Select id={x.id} value={v.requirementId} onChange={(e) => { const r = reqs.data?.items.find((y) => y.id === e.target.value); set({ requirementId: e.target.value, ...(r ? { category: r.category, title: v.title || r.name, coverageType: r.coverageType ?? v.coverageType, currency: r.minAmount?.currency ?? v.currency } : {}) }); }}>
            <option value="">{t('compliance.ownDocument')}</option>
            {(reqs.data?.items ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        )}</Field>
        {!req && <Field label={t('compliance.category')}>{(x) => (
          <Select id={x.id} value={v.category} onChange={(e) => set({ category: e.target.value as ComplianceCategory })}>
            {COMPLIANCE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
          </Select>
        )}</Field>}
        {perGroup ? (
          <Field label={t('common.ownerGroup')}>{(x) => (
            <Select id={x.id} value={v.ownerGroupId} onChange={(e) => set({ ownerGroupId: e.target.value })}>
              <option value="">{t('common.choose')}</option>
              {(groups.data?.items ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          )}</Field>
        ) : (
          <Field label={t('col.location')}>{(x) => (
            <Select id={x.id} value={v.locationId} onChange={(e) => set({ locationId: e.target.value })}>
              <option value="">{t('common.choose')}</option>
              {app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          )}</Field>
        )}
        <Field label={t('compliance.docTitle')}>{(x) => <Input id={x.id} value={v.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('compliance.issuer')} optional>{(x) => <Input id={x.id} value={v.issuer} maxLength={200} onChange={(e) => set({ issuer: e.target.value })} />}</Field>
          <Field label={t('compliance.reference')} optional>{(x) => <Input id={x.id} value={v.reference} maxLength={120} onChange={(e) => set({ reference: e.target.value })} />}</Field>
        </div>
        {(v.category === 'insurance' || req?.minAmount) && (
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_90px] gap-2">
            <Field label={t('compliance.coverageType')} optional>{(x) => <Input id={x.id} value={v.coverageType} maxLength={120} onChange={(e) => set({ coverageType: e.target.value })} />}</Field>
            <Field label={t('compliance.amount')} optional error={v.amount && amountMinor === null ? t('compliance.amountInvalid') : undefined}>{(x) => <Input id={x.id} inputMode="decimal" value={v.amount} onChange={(e) => set({ amount: e.target.value })} />}</Field>
            <Field label={t('compliance.currency')}>{(x) => <Input id={x.id} maxLength={3} value={v.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />}</Field>
          </div>
        )}
        {req?.minAmount && <p className="text-xs text-stone">{t('compliance.minimumHint', { amount: f.money(req.minAmount.amountMinor, req.minAmount.currency) })}</p>}
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('compliance.issued')} optional>{(x) => <Input id={x.id} type="date" value={v.issuedOn} onChange={(e) => set({ issuedOn: e.target.value })} />}</Field>
          <Field label={t('compliance.expires')} optional={!req?.requiresExpiry}>{(x) => <Input id={x.id} type="date" value={v.expiresOn} onChange={(e) => set({ expiresOn: e.target.value })} />}</Field>
        </div>
        <Field label={t('compliance.file')} hint={t('compliance.fileHint')}>{(x) => <input id={x.id} type="file" accept="application/pdf,image/*" capture="environment" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</Field>
        <Banner tone="neutral" icon="info">{app.capabilities.has('legal.compliance_documents:publish') ? t('compliance.autoApproved') : t('compliance.reviewedByHq')}</Banner>
      </div>
    </Drawer>
  );
}

function Requirements() {
  const t = useTranslations('quality');
  const app = useApp();
  const f = useQFmt();
  const res = useQuality(() => qualityApi.requirements(true), [app.org.id]);
  const [edit, setEdit] = useState<RequirementVM | 'new' | null>(null);
  return (
    <>
      <div className="flex justify-end"><Button icon="plus" onClick={() => setEdit('new')}>{t('requirements.add')}</Button></div>
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="shield" title={t('compliance.noRequirements')} body={t('compliance.noRequirementsBody')} />}>
        {(d) => (
          <SectionCard>
            <DataTable<RequirementVM>
              rows={d.items}
              rowKey={(r) => r.id}
              rowLabel={(r) => r.name}
              onRowClick={(r) => setEdit(r)}
              columns={[
                { key: 'name', header: t('requirements.name'), render: (r) => <span><strong>{r.name}</strong>{!r.active && <Badge tone="neutral" className="ml-2">{t('requirements.inactive')}</Badge>}</span> },
                { key: 'cat', header: t('compliance.category'), render: (r) => t(`category.${r.category}`) },
                { key: 'min', header: t('requirements.minimum'), render: (r) => (r.minAmount ? f.money(r.minAmount.amountMinor, r.minAmount.currency) : '—') },
                { key: 'where', header: t('requirements.where'), render: (r) => (r.jurisdictions.length ? r.jurisdictions.join(', ') : t('requirements.everywhere')) },
                { key: 'per', header: t('requirements.heldBy'), render: (r) => t(`requirements.per.${r.appliesTo}`) },
              ]}
            />
          </SectionCard>
        )}
      </Async>
      {edit && <RequirementDrawer req={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); res.reload(); }} />}
    </>
  );
}

function RequirementDrawer({ req, onClose, onDone }: { req: RequirementVM | null; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('quality');
  const app = useApp();
  const act = useQualityAction();
  const [v, setV] = useState({
    name: req?.name ?? '', category: req?.category ?? ('insurance' as ComplianceCategory), description: req?.description ?? '', coverageType: req?.coverageType ?? '',
    amount: req?.minAmount ? String(req.minAmount.amountMinor / 100) : '', currency: req?.minAmount?.currency ?? String(app.org.defaultCurrency ?? 'USD'), appliesTo: req?.appliesTo ?? 'location',
    jurisdictions: (req?.jurisdictions ?? []).join(', '), requiresExpiry: req?.requiresExpiry ?? true, active: req?.active ?? true,
  });
  const set = (p: Partial<typeof v>) => setV((s) => ({ ...s, ...p }));
  const amountMinor = v.amount ? toMinor(v.amount) : null;
  const body = (): RequirementInput => ({
    name: v.name, category: v.category, description: v.description, coverageType: v.coverageType || null, minAmountMinor: amountMinor, currency: amountMinor !== null ? v.currency : null,
    appliesTo: v.appliesTo as 'location' | 'owner_group', jurisdictions: v.jurisdictions.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean), requiresExpiry: v.requiresExpiry, active: v.active,
  });
  return (
    <Drawer open onClose={onClose} title={req ? req.name : t('requirements.add')} footer={
      <Button icon="check" disabled={!v.name || (!!v.amount && amountMinor === null)} loading={act.pending} onClick={async () => { if (await act.run(() => (req ? qualityApi.saveRequirement(req.id, body()) : qualityApi.addRequirement(body())))) onDone(); }}>{t('requirements.save')}</Button>
    }>
      <div className="flex flex-col gap-3">
        <ActionError error={act.error} />
        <Field label={t('requirements.name')} hint={t('requirements.nameHint')}>{(x) => <Input id={x.id} value={v.name} maxLength={160} onChange={(e) => set({ name: e.target.value })} />}</Field>
        <Field label={t('compliance.category')}>{(x) => (
          <Select id={x.id} value={v.category} onChange={(e) => set({ category: e.target.value as ComplianceCategory })}>
            {COMPLIANCE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
          </Select>
        )}</Field>
        <Field label={t('requirements.description')} optional>{(x) => <Input id={x.id} value={v.description} maxLength={1000} onChange={(e) => set({ description: e.target.value })} />}</Field>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_90px] gap-2">
          <Field label={t('compliance.coverageType')} optional>{(x) => <Input id={x.id} value={v.coverageType} maxLength={120} onChange={(e) => set({ coverageType: e.target.value })} />}</Field>
          <Field label={t('requirements.minimum')} optional error={v.amount && amountMinor === null ? t('compliance.amountInvalid') : undefined}>{(x) => <Input id={x.id} inputMode="decimal" value={v.amount} onChange={(e) => set({ amount: e.target.value })} />}</Field>
          <Field label={t('compliance.currency')}>{(x) => <Input id={x.id} maxLength={3} value={v.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />}</Field>
        </div>
        <Field label={t('requirements.heldBy')}>{(x) => (
          <Select id={x.id} value={v.appliesTo} onChange={(e) => set({ appliesTo: e.target.value as 'location' | 'owner_group' })}>
            <option value="location">{t('requirements.per.location')}</option>
            <option value="owner_group">{t('requirements.per.owner_group')}</option>
          </Select>
        )}</Field>
        <Field label={t('requirements.where')} hint={t('requirements.whereHint')} optional>{(x) => <Input id={x.id} value={v.jurisdictions} onChange={(e) => set({ jurisdictions: e.target.value.toUpperCase() })} />}</Field>
        <label className="flex items-center gap-2 text-[13px] font-bold"><Toggle checked={v.requiresExpiry} label={t('requirements.requiresExpiry')} onChange={(x) => set({ requiresExpiry: x })} />{t('requirements.requiresExpiry')}</label>
        {req && <label className="flex items-center gap-2 text-[13px] font-bold"><Toggle checked={v.active} label={t('requirements.active')} onChange={(x) => set({ active: x })} />{t('requirements.active')}</label>}
      </div>
    </Drawer>
  );
}

/** Compliance documents in the Legal renewals & expiries tracker (next to franchise agreements). */
export function ComplianceExpiring() {
  const t = useTranslations('quality');
  const app = useApp();
  const f = useQFmt();
  const res = useQuality(() => qualityApi.documents({ expiringWithinDays: 60 }), [app.org.id], app.hasModule('legal.compliance_documents'));
  if (!app.hasModule('legal.compliance_documents')) return null;
  return (
    <SectionCard title={t('compliance.expiringTitle')} aside={<Link href="/compliance" className="text-[13px] font-bold underline">{t('compliance.openMatrix')}</Link>}>
      <Async res={res} loading={<LoadingBlock variant="table" rows={2} />} isEmpty={(d) => !d.items.length} empty={<p className="text-sm text-stone">{t('compliance.nothingExpiring')}</p>}>
        {(d) => (
          <ul className="flex flex-col gap-1.5">
            {d.items.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1"><strong>{doc.title}</strong> · {doc.locationName ?? doc.ownerGroupName}</span>
                <CellBadge state={doc.daysLeft !== null && doc.daysLeft < 0 ? 'expired' : 'expiring'} label={doc.daysLeft !== null && doc.daysLeft < 0 ? t('state.expired') : t('compliance.inDays', { days: doc.daysLeft ?? 0 })} />
                <span className="text-xs text-stone">{f.date(doc.expiresOn)}</span>
              </li>
            ))}
          </ul>
        )}
      </Async>
    </SectionCard>
  );
}

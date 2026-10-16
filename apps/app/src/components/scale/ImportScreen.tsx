'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Select, Toggle, cx } from '@bh/ui';
import type { ImportEntity } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, LoadingBlock, SectionCard } from '../ui/States';
import { downloadCsv, readUpload, scaleApi, useScale, useScaleAction, type BatchVM, type ImportCatalogVM, type PreviewVM } from './api';
import { ActionError, Progress, Tiles, useQFmt } from './ui';

type Step = 'choose' | 'map' | 'preview' | 'run';

/**
 * Settings → Import: CSV or Excel files into locations, staff (with role mapping), customers (consent only when the
 * file says so), memberships and passes, products or menu items, rooms or listings, and leads. Columns are matched
 * automatically (exports from Mindbody, Glofox, Square, Shopify, Fresha and Vagaro are recognised), every row is
 * validated before anything is written, a dry run shows the outcome, and an import can be undone for 24 hours.
 */
export function ImportScreen() {
  const t = useTranslations('scale');
  const app = useApp();
  const allowed = app.hasModule('settings.import');
  const cat = useScale(() => scaleApi.importCatalog(), [app.org.id], allowed);
  const history = useScale(() => scaleApi.imports(), [app.org.id], allowed);
  const [step, setStep] = useState<Step>('choose');
  const [batch, setBatch] = useState<BatchVM | null>(null);
  const [preview, setPreview] = useState<PreviewVM | null>(null);
  if (!allowed) return <DeniedState />;
  const reset = () => { setStep('choose'); setBatch(null); setPreview(null); history.reload(); };
  return (
    <>
      <PageHeader icon="file" title={t('import.title')} description={t('import.description')} scope={false} />
      <Stepper step={step} />
      <Async res={cat} loading={<LoadingBlock variant="detail" />}>
        {(c) => (
          <>
            {step === 'choose' && <ChooseStep cat={c} onUploaded={(b) => { setBatch(b); setStep('map'); }} />}
            {step === 'map' && batch && <MapStep cat={c} batch={batch} onBack={reset} onPreview={(p) => { setPreview(p); setBatch(p.batch); setStep('preview'); }} />}
            {step === 'preview' && batch && preview && <PreviewStep preview={preview} onBack={() => setStep('map')} onStarted={(b) => { setBatch(b); setStep('run'); }} />}
            {step === 'run' && batch && <RunStep id={batch.id} onDone={reset} onDryRunBack={() => setStep('preview')} />}
          </>
        )}
      </Async>
      <SectionCard title={t('import.history')}>
        <Async res={history} loading={<LoadingBlock variant="table" rows={2} />} isEmpty={(d) => !d.items.length} empty={<p className="text-[13px] text-stone">{t('import.noHistory')}</p>}>
          {(d) => <History items={d.items} onChange={history.reload} />}
        </Async>
      </SectionCard>
    </>
  );
}

function Stepper({ step }: { step: Step }) {
  const t = useTranslations('scale');
  const steps: Step[] = ['choose', 'map', 'preview', 'run'];
  const at = steps.indexOf(step);
  return (
    <ol className="flex flex-wrap gap-2" aria-label={t('import.steps')}>
      {steps.map((s, i) => (
        <li key={s} aria-current={i === at ? 'step' : undefined} className={cx('flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-bold', i === at ? 'bg-ink text-white' : i < at ? 'bg-lime' : 'bg-surface text-stone')}>
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-[11px]">{i + 1}</span>{t(`import.step.${s}`)}
        </li>
      ))}
    </ol>
  );
}

function ChooseStep({ cat, onUploaded }: { cat: ImportCatalogVM; onUploaded: (b: BatchVM) => void }) {
  const t = useTranslations('scale');
  const act = useScaleAction();
  const entities = cat.entities.filter((e) => e.allowed);
  const [entity, setEntity] = useState<ImportEntity>(entities[0]?.key ?? 'customers');
  const [template, setTemplate] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const templates = cat.templates.filter((x) => x.entity === entity);
  if (!entities.length) return <Banner tone="neutral">{t('import.nothingAllowed')}</Banner>;
  return (
    <SectionCard title={t('import.step.choose')}>
      <form className="flex flex-col gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        const up = await readUpload(file);
        const b = await act.run(() => scaleApi.upload({ entity, filename: up.filename, dataBase64: up.dataBase64, templateKey: template || null }));
        if (b) onUploaded(b);
      }}>
        <div className="flex flex-wrap gap-3">
          <div className="w-56"><Field label={t('import.what')}>{(x) => (
            <Select id={x.id} value={entity} onChange={(e) => { setEntity(e.target.value as ImportEntity); setTemplate(''); }}>
              {entities.map((e) => <option key={e.key} value={e.key}>{t(`entity.${e.key}`)}</option>)}
            </Select>
          )}</Field></div>
          <div className="w-64"><Field label={t('import.from')} hint={t('import.fromHint')}>{(x) => (
            <Select id={x.id} value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="">{t('import.autoDetect')}</option>
              {templates.map((tp) => <option key={tp.key} value={tp.key}>{t(`template.${tp.key}` as 'template.square_customers')}</option>)}
            </Select>
          )}</Field></div>
          <div className="w-72"><Field label={t('import.file')} hint={t('import.fileHint')}>{(x) => (
            <input id={x.id} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="block w-full text-sm file:mr-3 file:rounded-full file:border-0 file:bg-ink file:px-4 file:py-2 file:text-white" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          )}</Field></div>
        </div>
        {entity === 'customers' && <Banner tone="info" icon="shield">{t('import.consentNote')}</Banner>}
        <ActionError error={act.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" icon="arrow-right" disabled={!file} loading={act.pending}>{t('import.upload')}</Button>
          <Button type="button" variant="ghost" icon="download" onClick={() => void downloadCsv(`/imports/templates/${entity}`, `branchharbor-${entity}.csv`)}>{t('import.blankTemplate')}</Button>
        </div>
      </form>
    </SectionCard>
  );
}

function MapStep({ cat, batch, onBack, onPreview }: { cat: ImportCatalogVM; batch: BatchVM; onBack: () => void; onPreview: (p: PreviewVM) => void }) {
  const t = useTranslations('scale');
  const ta = useTranslations('access');
  const app = useApp();
  const act = useScaleAction();
  const fields = cat.entities.find((e) => e.key === batch.entity)?.fields ?? [];
  const [mapping, setMapping] = useState<Record<string, number | null>>(batch.mapping);
  const [locationId, setLocationId] = useState<string>((batch.options.locationId as string | undefined) ?? '');
  const [dateFormat, setDateFormat] = useState<string>((batch.options.dateFormat as string | undefined) ?? 'ymd');
  const [roles, setRoles] = useState<Array<{ title: string; role: string }>>([]);
  const [sendInvites, setSendInvites] = useState(true);
  const sample = batch.sample?.[0] ?? [];
  const check = async (roleMapping?: Record<string, string>) => {
    const p = await act.run(() => scaleApi.mapping(batch.id, mapping, { locationId: locationId || null, dateFormat, ...(roleMapping ? { roleMapping } : {}), ...(batch.entity === 'staff' ? { sendInvites } : {}) }));
    if (!p) return;
    if (batch.entity === 'staff' && !roleMapping && p.roles.length) { setRoles(p.roles); return; }
    onPreview(p);
  };
  return (
    <SectionCard title={t('import.step.map')} aside={<span className="text-xs text-stone">{t('import.fileSummary', { file: batch.filename, rows: batch.totalRows })}</span>}>
      {batch.templateKey && <Banner tone="success" icon="check-circle">{t('import.templateDetected', { template: t(`template.${batch.templateKey}` as 'template.square_customers') })}</Banner>}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm" data-testid="import-mapping">
          <thead>
            <tr className="border-b border-line-soft text-left text-xs font-extrabold uppercase tracking-[0.06em] text-stone">
              <th scope="col" className="px-2 py-2">{t('import.col.field')}</th>
              <th scope="col" className="px-2 py-2">{t('import.col.column')}</th>
              <th scope="col" className="px-2 py-2">{t('import.col.sample')}</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((fd) => {
              const idx = mapping[fd.key];
              return (
                <tr key={fd.key} className="border-b border-line-soft last:border-0">
                  <td className="px-2 py-2 font-bold">{t(`field.${fd.key}` as 'field.name')}{fd.required && <span className="ml-2"><Badge tone="warning">{t('import.required')}</Badge></span>}</td>
                  <td className="w-64 px-2 py-1.5">
                    <Select aria-label={t(`field.${fd.key}` as 'field.name')} value={idx === null || idx === undefined ? '' : String(idx)} onChange={(e) => setMapping((m) => ({ ...m, [fd.key]: e.target.value === '' ? null : Number(e.target.value) }))}>
                      <option value="">{t('import.notImported')}</option>
                      {batch.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                    </Select>
                  </td>
                  <td className="max-w-[240px] truncate px-2 py-2 text-stone">{idx === null || idx === undefined ? '—' : sample[idx] || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        {['customers', 'leads', 'memberships', 'staff', 'properties'].includes(batch.entity) && (
          <div className="w-60"><Field label={t('import.defaultLocation')} hint={t('import.defaultLocationHint')}>{(x) => (
            <Select id={x.id} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">{t('import.noDefaultLocation')}</option>
              {app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          )}</Field></div>
        )}
        <div className="w-52"><Field label={t('import.dateFormat')}>{(x) => (
          <Select id={x.id} value={dateFormat} onChange={(e) => setDateFormat(e.target.value)}>
            {(['ymd', 'mdy', 'dmy'] as const).map((d) => <option key={d} value={d}>{t(`import.dateFormats.${d}`)}</option>)}
          </Select>
        )}</Field></div>
        {batch.entity === 'staff' && (
          <label className="flex items-center gap-3 self-end text-[13px]"><Toggle checked={sendInvites} label={t('import.sendInvites')} onChange={setSendInvites} />{t('import.sendInvites')}</label>
        )}
      </div>
      {roles.length > 0 && (
        <div className="mt-3 rounded-lg bg-canvas p-3">
          <h3 className="mb-2 text-sm font-bold">{t('import.roleMapping')}</h3>
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]">
            {roles.map((r, i) => (
              <div key={r.title}><Field label={r.title}>{(x) => (
                <Select id={x.id} value={r.role} onChange={(e) => setRoles((rs) => rs.map((y, j) => (j === i ? { ...y, role: e.target.value } : y)))}>
                  {cat.roles.map((role) => <option key={role} value={role}>{ta(`roles.${role}.name` as 'roles.staff.name')}</option>)}
                </Select>
              )}</Field></div>
            ))}
          </div>
        </div>
      )}
      <ActionError error={act.error} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="ghost" icon="arrow-left" onClick={onBack}>{t('common.back')}</Button>
        <Button icon="check" loading={act.pending} onClick={() => void check(roles.length ? Object.fromEntries(roles.map((r) => [r.title, r.role])) : undefined)}>{roles.length ? t('import.confirmRoles') : t('import.checkRows')}</Button>
      </div>
    </SectionCard>
  );
}

function PreviewStep({ preview, onBack, onStarted }: { preview: PreviewVM; onBack: () => void; onStarted: (b: BatchVM) => void }) {
  const t = useTranslations('scale');
  const act = useScaleAction();
  const c = preview.counts;
  const blocking = preview.batch.errors.filter((e) => e.code === 'column_not_mapped');
  const tone = { create: 'success', update: 'info', skip: 'neutral', error: 'danger' } as const;
  return (
    <SectionCard title={t('import.step.preview')}>
      <Tiles items={[
        { label: t('import.tiles.rows'), value: c.total },
        { label: t('import.tiles.create'), value: c.create },
        { label: t('import.tiles.update'), value: c.update },
        { label: t('import.tiles.skip'), value: c.skip },
        { label: t('import.tiles.errors'), value: c.invalid, tone: c.invalid ? 'danger' : undefined },
      ]} />
      {blocking.length > 0 && <Banner tone="danger">{t('import.unmapped', { fields: blocking.map((e) => t(`field.${e.field}` as 'field.name')).join(', ') })}</Banner>}
      {c.invalid > 0 && !blocking.length && <Banner tone="warning">{t('import.errorsSkipped', { count: c.invalid })}</Banner>}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm" data-testid="import-preview">
          <thead>
            <tr className="border-b border-line-soft text-left text-xs font-extrabold uppercase tracking-[0.06em] text-stone">
              <th scope="col" className="px-2 py-2">{t('import.col.row')}</th>
              <th scope="col" className="px-2 py-2">{t('import.col.result')}</th>
              <th scope="col" className="px-2 py-2">{t('import.col.record')}</th>
              <th scope="col" className="px-2 py-2">{t('import.col.problems')}</th>
            </tr>
          </thead>
          <tbody>
            {preview.preview.map((p) => (
              <tr key={p.row} className={cx('border-b border-line-soft last:border-0', p.action === 'error' && 'bg-danger-bg/40')}>
                <td className="tabular px-2 py-2">{p.row}</td>
                <td className="px-2 py-2"><Badge tone={tone[p.action]}>{t(`import.action.${p.action}`)}</Badge></td>
                <td className="px-2 py-2 font-medium">{p.summary || '—'}</td>
                <td className="px-2 py-2 text-danger">{p.errors.map((e) => `${t(`field.${e.field}` as 'field.name')}: ${t.has(`rowError.${e.code}`) ? t(`rowError.${e.code}` as 'rowError.required') : e.message}`).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.preview.length < c.total && <p className="mt-2 text-xs text-stone">{t('import.previewLimited', { shown: preview.preview.length, total: c.total })}</p>}
      <ActionError error={act.error} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="ghost" icon="arrow-left" onClick={onBack}>{t('import.changeMapping')}</Button>
        <Button variant="secondary" icon="eye" disabled={!!blocking.length} loading={act.pending} onClick={async () => { const b = await act.run(() => scaleApi.run(preview.batch.id, true)); if (b) onStarted(b); }}>{t('import.dryRun')}</Button>
        <Button icon="check" disabled={!!blocking.length || c.valid === 0} loading={act.pending} onClick={async () => { const b = await act.run(() => scaleApi.run(preview.batch.id, false)); if (b) onStarted(b); }}>{t('import.run', { count: c.create + c.update })}</Button>
      </div>
    </SectionCard>
  );
}

function RunStep({ id, onDone, onDryRunBack }: { id: string; onDone: () => void; onDryRunBack: () => void }) {
  const t = useTranslations('scale');
  const [tick, setTick] = useState(0);
  const res = useScale(() => scaleApi.batch(id), [id, tick]);
  const act = useScaleAction();
  const b = res.data;
  const busy = b ? ['queued', 'running'].includes(b.status) : true;
  useEffect(() => {
    if (!busy) return;
    const h = setTimeout(() => setTick((x) => x + 1), 1000);
    return () => clearTimeout(h);
  }, [busy, tick]);
  return (
    <SectionCard title={t('import.step.run')}>
      {!b ? <LoadingBlock variant="detail" /> : (
        <div className="flex flex-col gap-3" data-testid="import-progress">
          <div className="flex items-center gap-3">
            <Badge tone={b.status === 'completed' ? 'success' : b.status === 'failed' ? 'danger' : 'info'}>{t(`batchStatus.${b.status}`)}</Badge>
            {b.dryRun && <Badge tone="neutral">{t('import.dryRunBadge')}</Badge>}
            <span className="text-[13px] text-stone">{t('import.processed', { done: b.processedRows, total: b.totalRows })}</span>
          </div>
          <Progress done={b.processedRows} total={b.totalRows} label={t('import.progress')} />
          {b.status === 'failed' && <Banner tone="danger">{b.error}</Banner>}
          {b.status === 'completed' && (
            <>
              <Tiles items={[
                { label: b.dryRun ? t('import.tiles.wouldCreate') : t('import.tiles.created'), value: b.createdCount },
                { label: b.dryRun ? t('import.tiles.wouldUpdate') : t('import.tiles.updated'), value: b.updatedCount },
                { label: t('import.tiles.skipped'), value: b.skippedCount, tone: b.errorRows ? 'danger' : undefined },
              ]} />
              {b.canUndo && <Banner tone="info" icon="undo" action={<Button size="sm" variant="secondary" icon="undo" loading={act.pending} onClick={async () => { if (await act.run(() => scaleApi.rollback(b.id))) onDone(); }}>{t('import.undo')}</Button>}>{t('import.undoHint')}</Banner>}
            </>
          )}
          <ActionError error={act.error} />
          {b.errorRows > 0 && <Button variant="ghost" size="sm" icon="download" onClick={() => void downloadCsv(`/imports/${b.id}/errors`, `import-errors-${b.id.slice(0, 8)}.csv`)}>{t('import.downloadErrors')}</Button>}
          {!busy && (
            <div className="flex gap-2">
              {b.dryRun && b.status === 'completed' && <Button icon="arrow-left" variant="secondary" onClick={onDryRunBack}>{t('import.backToPreview')}</Button>}
              <Button variant="ghost" onClick={onDone}>{t('import.newImport')}</Button>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function History({ items, onChange }: { items: BatchVM[]; onChange: () => void }) {
  const t = useTranslations('scale');
  const f = useQFmt();
  const act = useScaleAction();
  return (
    <>
      <ActionError error={act.error} />
      <ul className="flex flex-col divide-y divide-line-soft">
        {items.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-2 py-2.5 text-[13px]">
            <span className="font-bold">{t(`entity.${b.entity}`)}</span>
            <span className="text-stone">{b.filename}</span>
            <Badge tone={b.status === 'completed' ? 'success' : b.status === 'failed' ? 'danger' : b.status === 'rolled_back' ? 'neutral' : 'info'}>{t(`batchStatus.${b.status}`)}</Badge>
            {b.dryRun && <Badge tone="neutral">{t('import.dryRunBadge')}</Badge>}
            <span className="text-stone">{t('import.historyCounts', { created: b.createdCount, updated: b.updatedCount, errors: b.errorRows })}</span>
            <span className="ml-auto text-xs text-stone">{f.date(b.createdAt)}</span>
            {b.canUndo && <Button size="sm" variant="ghost" icon="undo" onClick={async () => { if (window.confirm(t('import.undoConfirm')) && (await act.run(() => scaleApi.rollback(b.id)))) onChange(); }}>{t('import.undo')}</Button>}
          </li>
        ))}
      </ul>
    </>
  );
}

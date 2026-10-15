'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Input, Select, Textarea, Toggle } from '@bh/ui';
import { useWellness, useWellnessAction } from '@/lib/wellness/api';
import type { DepositRule, Draft, Policy, ServiceInput, WPractitioner, WService } from '@/lib/wellness/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, LoadingBlock } from '../../ui/States';
import { Loadable, Money, Pill, useScopeLocations } from './shared';
import { useDataText } from '../../ui/useDataText';

const DEFAULT_POLICY: Policy = { freeCancelHours: 24, lateCancelFeePercent: 50, noShowFeePercent: 100, depositRefundable: true };

export function ServicesView() {
  const t = useTranslations('wellnessFull.services');
  const app = useApp();
  const locs = useScopeLocations();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<WService | 'new' | null>(null);
  const res = useWellness(app.locations, async (api) => ({ services: await api.services(), pracs: await api.practitioners() }), [app.role, app.scopeId]);
  const canWrite = app.can('operations.write');
  return (
    <>
      <PageHeader icon="leaf" title={t('title')} description={t('description')} actions={canWrite ? <Button icon="plus" onClick={() => setEdit('new')}>{t('add')}</Button> : null} />
      <Loadable res={res} loading={<LoadingBlock variant="table" />}>
        {({ services, pracs }) => {
          const ids = new Set(locs.map((l) => l.id));
          const visible = services.filter((s) => (!s.locationId || ids.has(s.locationId)) && (!q || `${s.name} ${s.category ?? ''}`.toLowerCase().includes(q.toLowerCase())));
          const cats = [...new Set(visible.map((s) => s.category ?? t('uncategorised')))];
          return (
            <section className="flex flex-col gap-3 rounded-xl bg-surface p-3.5">
              <div className="flex flex-wrap items-center gap-2 px-1">
                <Input aria-label={t('search')} placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} className="!h-9 max-w-xs !text-[13px]" />
                <span className="text-xs text-stone">{t('count', { n: visible.length })}</span>
              </div>
              {!visible.length && <Empty icon="leaf" title={t('empty')} body={t('emptyBody')} />}
              {cats.map((c) => (
                <div key={c} className="flex flex-col gap-2">
                  <h2 className="px-1 text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{c}</h2>
                  {visible.filter((s) => (s.category ?? t('uncategorised')) === c).map((s) => <ServiceCard key={s.id} s={s} pracs={pracs} onEdit={canWrite ? () => setEdit(s) : undefined} />)}
                </div>
              ))}
            </section>
          );
        }}
      </Loadable>
      {edit && res.status === 'ready' && <ServiceEditor svc={edit === 'new' ? null : edit} pracs={res.data.pracs} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); res.reload(); }} />}
    </>
  );
}

function ServiceCard({ s, pracs, onEdit }: { s: WService; pracs: WPractitioner[]; onEdit?: () => void }) {
  const t = useTranslations('wellnessFull.services');
  const dt = useDataText();
  const app = useApp();
  const locName = (id: string) => app.locations.find((l) => l.id === id)?.name ?? id;
  const eligible = pracs.filter((p) => p.serviceIds.includes(s.id));
  return (
    <article className="grid gap-3 rounded-lg border border-line-soft p-4 md:grid-cols-[1.3fr_1fr_1fr]">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] font-bold">{s.name}</h3>
          {!s.active && <Badge tone="neutral" icon="x">{t('inactive')}</Badge>}
          <Badge tone={s.onlineBookable ? 'success' : 'neutral'} icon={s.onlineBookable ? 'globe' : 'phone'}>{s.onlineBookable ? t('online') : t('staffOnly')}</Badge>
          {s.practitionersRequired > 1 && <Badge tone="info" icon="users">{t('couples')}</Badge>}
        </div>
        <p className="text-[13px] text-stone">{s.description ?? t('noDescription')}</p>
        <div className="flex flex-wrap gap-1.5">
          <Pill>{t('buffers', { before: s.bufferBeforeMinutes, after: s.bufferAfterMinutes })}</Pill>
          {s.requiredResourceType && <Pill>{t('needs', { what: dt(`table.resource.${s.requiredResourceType}`, undefined, s.requiredResourceType.replace(/_/g, ' ')) })}</Pill>}
          {s.equipmentTypes.map((e) => <Pill key={e}>{t('needs', { what: dt(`table.resource.${e}`, undefined, e.replace(/_/g, ' ')) })}</Pill>)}
          <Pill>{s.depositRule ? (s.depositRule.kind === 'percent' ? t('depositPercent', { v: s.depositRule.value }) : s.depositRule.kind === 'fixed' ? t('depositFixed') : t('noDeposit')) : s.depositMinor ? t('depositFixed') : t('noDeposit')}</Pill>
          <Pill>{t('policySummary', { hours: s.policy.freeCancelHours, late: s.policy.lateCancelFeePercent, noShow: s.policy.noShowFeePercent })}</Pill>
          {s.rebookAfterWeeks && <Pill>{t('rebook', { weeks: s.rebookAfterWeeks })}</Pill>}
        </div>
      </div>
      <div className="text-[13px]">
        <div className="mb-1 text-xs font-bold text-stone">{t('pricing')}</div>
        {s.variants.length ? (
          <ul className="flex flex-col gap-1">
            {s.variants.map((v) => (
              <li key={v.id}><strong>{v.name}</strong> <span className="text-stone">({t('minutes', { count: v.durationMinutes })})</span>
                <ul className="pl-3">{v.prices.map((p) => <li key={p.locationId} className="flex justify-between gap-2"><span className="text-stone">{locName(p.locationId)}</span><Money m={{ amount: p.priceMinor, currency: p.currency }} /></li>)}{!v.prices.length && <li className="text-stone">{t('noPrices')}</li>}</ul>
              </li>
            ))}
          </ul>
        ) : (
          <p><strong>{t('minutes', { count: s.durationMinutes })}</strong> · <Money m={{ amount: s.priceMinor, currency: s.currency }} /> {s.locationId && <span className="text-stone">· {locName(s.locationId)}</span>}</p>
        )}
      </div>
      <div className="flex flex-col justify-between gap-2 text-[13px]">
        <div><div className="mb-1 text-xs font-bold text-stone">{t('eligible')}</div>{eligible.length ? eligible.map((p) => p.name).join(', ') : <span className="text-warning">{t('noneEligible')}</span>}</div>
        {onEdit && <Button size="sm" variant="secondary" icon="edit" onClick={onEdit}>{t('edit')}</Button>}
      </div>
    </article>
  );
}

function ServiceEditor({ svc, pracs, onClose, onSaved }: { svc: WService | null; pracs: WPractitioner[]; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('wellnessFull.services');
  const locale = useLocale();
  const app = useApp();
  const locs = useScopeLocations();
  const action = useWellnessAction(app.locations);
  const [f, setF] = useState<ServiceInput & { description: string; practitionerIds: string[]; active: boolean }>(() => ({
    locationId: svc ? svc.locationId : locs[0]?.id ?? null, name: svc?.name ?? '', description: svc?.description ?? '', category: svc?.category ?? '', durationMinutes: svc?.durationMinutes ?? 60, bufferBeforeMinutes: svc?.bufferBeforeMinutes ?? 0, bufferAfterMinutes: svc?.bufferAfterMinutes ?? 15,
    priceMinor: svc?.priceMinor ?? 10000, currency: svc?.currency ?? locs[0]?.currency, requiredResourceType: svc?.requiredResourceType ?? 'room', equipmentTypes: svc?.equipmentTypes ?? [], onlineBookable: svc?.onlineBookable ?? true, practitionersRequired: svc?.practitionersRequired ?? 1,
    depositRule: svc?.depositRule ?? { kind: 'none', value: 0 }, policy: svc?.policy ?? DEFAULT_POLICY, cancellationPolicy: svc?.cancellationPolicy ?? '', rebookAfterWeeks: svc?.rebookAfterWeeks ?? null, practitionerIds: pracs.filter((p) => svc && p.serviceIds.includes(svc.id)).map((p) => p.id), active: svc?.active ?? true,
  }));
  const [variant, setVariant] = useState({ name: '', durationMinutes: 90, prices: {} as Record<string, string> });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const loc = app.locations.find((l) => l.id === f.locationId);
  const priceLocs = svc?.locationId ? app.locations.filter((l) => l.id === svc.locationId) : locs;
  const save = async () => {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = t('required');
    if (f.durationMinutes < 5) e.durationMinutes = t('minDuration');
    setErrors(e);
    if (Object.keys(e).length) return;
    const body = { ...f, category: f.category || undefined, requiredResourceType: f.requiredResourceType || undefined, cancellationPolicy: f.cancellationPolicy || undefined, currency: loc?.currency ?? f.currency, depositRule: f.depositRule?.kind === 'none' ? { kind: 'none' as const, value: 0 } : f.depositRule };
    const ok = await action.run(async (api) => {
      if (svc) {
        const { locationId: _l, currency: _c, ...patch } = body;
        await api.updateService(svc.id, { ...patch, requiredResourceType: f.requiredResourceType || null } as never);
      } else {
        const created = await api.createService(body);
        if (f.practitionerIds.length) await api.updateService(created.id, { practitionerIds: f.practitionerIds });
      }
      return true;
    });
    if (ok) onSaved();
  };
  const addVariant = async () => {
    const prices = Object.entries(variant.prices).filter(([, v]) => v !== '').map(([locationId, v]) => ({ locationId, priceMinor: Math.round(Number(v) * 100) }));
    if (!svc || !variant.name || !prices.length) return;
    const ok = await action.run(async (api) => { await api.addVariant(svc.id, { name: variant.name, durationMinutes: variant.durationMinutes, prices }); return true; });
    if (ok) onSaved();
  };
  return (
    <Drawer open onClose={onClose} kicker={svc ? t('editKicker') : t('newKicker')} title={svc?.name ?? t('newTitle')} footer={<div className="flex gap-2"><Button onClick={save} disabled={action.pending}>{t('save')}</Button><Button variant="secondary" onClick={onClose}>{t('close')}</Button></div>}>
      <div className="flex flex-col gap-3">
        {Object.keys(errors).length > 0 && <Banner tone="danger" live="assertive" title={t('fixErrors')}>{Object.values(errors).join(' · ')}</Banner>}
        {action.error && <Banner tone="danger" live="assertive" title={t('saveFailed')}>{action.error.message}</Banner>}
        {!svc && (
          <Field label={t('offeredAt')} hint={t('offeredAtHint')}>{({ id, describedBy }) => <Select id={id} aria-describedby={describedBy} value={f.locationId ?? ''} onChange={(e) => set('locationId', e.target.value || null)}>{locs.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.currency})</option>)}{app.can('templates.write') && <option value="">{t('network')}</option>}</Select>}</Field>
        )}
        <Field label={t('name')} error={errors.name}>{({ id, invalid }) => <Input id={id} aria-invalid={invalid} value={f.name} onChange={(e) => set('name', e.target.value)} />}</Field>
        <Field label={t('category')} optional>{({ id }) => <Input id={id} value={f.category ?? ''} onChange={(e) => set('category', e.target.value)} />}</Field>
        <Field label={t('descriptionLabel')} hint={t('noHealthClaims')} optional>{({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} value={f.description} onChange={(e) => set('description', e.target.value)} />}</Field>
        {svc && app.can('ai.use') && (
          <div className="flex flex-col gap-2 rounded-lg bg-canvas p-3">
            <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="secondary" icon="sparkles" disabled={action.pending} onClick={async () => setDraft((await action.run((api) => api.draftServiceCopy(svc.id, 'calm'))) ?? null)}>{t('aiDraft')}</Button><span className="text-xs text-stone">{t('aiDraftHint')}</span></div>
            {draft && (
              <div className="flex flex-col gap-2 text-[13px]">
                <p className="rounded-md bg-surface p-2.5">{draft.output}</p>
                {draft.removedClaims.length > 0 && <Banner tone="warning" title={t('claimsRemoved', { n: draft.removedClaims.length })}>{draft.removedClaims.join(' ')}</Banner>}
                <div className="flex gap-2"><Button size="sm" onClick={async () => { const ok = await action.run(async (api) => { await api.decideDraft(draft.id, 'apply'); return true; }); if (ok) { set('description', draft.output); setDraft(null); } }}>{t('useDraft')}</Button><Button size="sm" variant="ghost" onClick={async () => { await action.run(async (api) => { await api.decideDraft(draft.id, 'discard'); return true; }); setDraft(null); }}>{t('discard')}</Button></div>
              </div>
            )}
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          <Field label={t('duration')} error={errors.durationMinutes}>{({ id }) => <Input id={id} type="number" min={5} value={f.durationMinutes} onChange={(e) => set('durationMinutes', Number(e.target.value))} />}</Field>
          <Field label={t('bufferBefore')}>{({ id }) => <Input id={id} type="number" min={0} max={120} value={f.bufferBeforeMinutes} onChange={(e) => set('bufferBeforeMinutes', Number(e.target.value))} />}</Field>
          <Field label={t('bufferAfter')}>{({ id }) => <Input id={id} type="number" min={0} max={120} value={f.bufferAfterMinutes} onChange={(e) => set('bufferAfterMinutes', Number(e.target.value))} />}</Field>
        </div>
        {(!svc || !svc.variants.length) && (
          <Field label={t('basePrice', { currency: loc?.currency ?? f.currency ?? '' })} hint={f.locationId ? undefined : t('networkPriceHint')}>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={0} step="0.01" value={f.priceMinor / 100} onChange={(e) => set('priceMinor', Math.round(Number(e.target.value) * 100))} />}</Field>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('deposit')}>{({ id }) => <Select id={id} value={f.depositRule?.kind ?? 'none'} onChange={(e) => set('depositRule', { kind: e.target.value as DepositRule['kind'], value: f.depositRule?.value ?? 20 })}><option value="none">{t('noDeposit')}</option><option value="percent">{t('percentOfPrice')}</option><option value="fixed">{t('fixedAmount')}</option></Select>}</Field>
          {f.depositRule && f.depositRule.kind !== 'none' && <Field label={f.depositRule.kind === 'percent' ? t('percent') : t('amountMinor')}>{({ id }) => <Input id={id} type="number" min={0} value={f.depositRule!.value} onChange={(e) => set('depositRule', { ...f.depositRule!, value: Number(e.target.value) })} />}</Field>}
        </div>
        <fieldset className="grid grid-cols-3 gap-2 rounded-lg border border-line-soft p-3">
          <legend className="px-1 text-[13px] font-bold">{t('policy')}</legend>
          <Field label={t('freeHours')}>{({ id }) => <Input id={id} type="number" min={0} value={f.policy.freeCancelHours} onChange={(e) => set('policy', { ...f.policy, freeCancelHours: Number(e.target.value) })} />}</Field>
          <Field label={t('lateFee')}>{({ id }) => <Input id={id} type="number" min={0} max={100} value={f.policy.lateCancelFeePercent} onChange={(e) => set('policy', { ...f.policy, lateCancelFeePercent: Number(e.target.value) })} />}</Field>
          <Field label={t('noShowFee')}>{({ id }) => <Input id={id} type="number" min={0} max={100} value={f.policy.noShowFeePercent} onChange={(e) => set('policy', { ...f.policy, noShowFeePercent: Number(e.target.value) })} />}</Field>
          <label className="col-span-3 flex items-center justify-between gap-2 text-[13px]"><span>{t('depositRefundable')}</span><Toggle checked={f.policy.depositRefundable} label={t('depositRefundable')} onChange={(v) => set('policy', { ...f.policy, depositRefundable: v })} /></label>
          <div className="col-span-3"><Field label={t('policyText')} hint={t('policyTextHint')}>{({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} value={f.cancellationPolicy ?? ''} onChange={(e) => set('cancellationPolicy', e.target.value)} />}</Field></div>
        </fieldset>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('room')} optional>{({ id }) => <Select id={id} value={f.requiredResourceType ?? ''} onChange={(e) => set('requiredResourceType', e.target.value)}><option value="">{t('noRoom')}</option><option value="room">{t('roomType')}</option></Select>}</Field>
          <Field label={t('equipment')} hint={t('equipmentHint')} optional>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={f.equipmentTypes.join(', ')} onChange={(e) => set('equipmentTypes', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('practitionersRequired')}>{({ id }) => <Select id={id} value={f.practitionersRequired} onChange={(e) => set('practitionersRequired', Number(e.target.value))}><option value={1}>{t('one')}</option><option value={2}>{t('two')}</option></Select>}</Field>
          <Field label={t('rebookWeeks')} optional>{({ id }) => <Input id={id} type="number" min={1} max={52} value={f.rebookAfterWeeks ?? ''} onChange={(e) => set('rebookAfterWeeks', e.target.value ? Number(e.target.value) : null)} />}</Field>
        </div>
        <label className="flex items-center justify-between gap-2 text-[13px]"><span>{t('onlineBookable')}</span><Toggle checked={f.onlineBookable} label={t('onlineBookable')} onChange={(v) => set('onlineBookable', v)} /></label>
        {svc && <label className="flex items-center justify-between gap-2 text-[13px]"><span>{t('activeLabel')}</span><Toggle checked={f.active} label={t('activeLabel')} onChange={(v) => set('active', v)} /></label>}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[13px] font-bold">{t('eligible')}</legend>
          {pracs.filter((p) => !f.locationId || p.locations.some((x) => x.locationId === f.locationId)).map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="h-4 w-4 accent-ink" checked={f.practitionerIds.includes(p.id)} onChange={(e) => set('practitionerIds', e.target.checked ? [...f.practitionerIds, p.id] : f.practitionerIds.filter((x) => x !== p.id))} />{p.name} <span className="text-stone">· {app.locations.find((l) => l.id === p.locationId)?.name}</span></label>
          ))}
        </fieldset>
        {svc && (
          <fieldset className="flex flex-col gap-2 rounded-lg border border-line-soft p-3">
            <legend className="px-1 text-[13px] font-bold">{t('addVariant')}</legend>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('variantName')}>{({ id }) => <Input id={id} placeholder={t('variantPh')} value={variant.name} onChange={(e) => setVariant({ ...variant, name: e.target.value })} />}</Field>
              <Field label={t('duration')}>{({ id }) => <Input id={id} type="number" min={5} value={variant.durationMinutes} onChange={(e) => setVariant({ ...variant, durationMinutes: Number(e.target.value) })} />}</Field>
            </div>
            {priceLocs.map((l) => <Field key={l.id} label={t('priceAt', { location: l.name, currency: l.currency })} optional>{({ id }) => <Input id={id} type="number" min={0} step="0.01" value={variant.prices[l.id] ?? ''} onChange={(e) => setVariant({ ...variant, prices: { ...variant.prices, [l.id]: e.target.value } })} />}</Field>)}
            <Button size="sm" variant="secondary" disabled={!variant.name || action.pending} onClick={addVariant}>{t('addVariantBtn')}</Button>
            <p className="text-xs text-stone">{t('currencyNote', { example: new Intl.NumberFormat(locale, { style: 'currency', currency: priceLocs[0]?.currency ?? 'CAD' }).format(110) })}</p>
          </fieldset>
        )}
      </div>
    </Drawer>
  );
}


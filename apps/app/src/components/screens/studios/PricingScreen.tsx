'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Tabs } from '@bh/ui';
import { useStudio, useStudioMutation } from '@/lib/studios/api';
import type { AccessPolicy, PolicyVM } from '@/lib/studios/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, LoadingBlock } from '../../ui/States';
import { ErrorLine, Labeled, StudioAsync, fmtMoney, inputCls, toMinor } from './shared';

type Tab = 'packs' | 'memberships' | 'policies';
const POLICIES: AccessPolicy[] = ['home_only', 'same_currency', 'any_location', 'listed'];

/** Class packs, memberships (recurring billing) and the booking / late-cancel / no-show policy. */
export function PricingScreen() {
  const t = useTranslations('studiosFull.pricing');
  const locale = useLocale();
  const app = useApp();
  const [tab, setTab] = useState<Tab>('packs');
  const currencies = [...new Set(app.locations.map((l) => l.currency))];
  const packs = useStudio((api) => api.packProducts(), [app.role]);
  const plans = useStudio((api) => api.membershipPlans(), [app.role]);
  const canWrite = app.can('operations.write');
  const prices = (p: Record<string, number>) => Object.entries(p).map(([c, a]) => fmtMoney(a, c, locale)).join(' · ');
  const archive = useStudioMutation((api, kind: 'pack' | 'plan', id: string, status: string) => (kind === 'pack' ? api.updatePackProduct(id, { status }) : api.updateMembershipPlan(id, { status })));

  return (
    <>
      <PageHeader icon="tag" title={t('title')} description={t('description')} actions={<Tabs items={[{ key: 'packs', label: t('packs') }, { key: 'memberships', label: t('memberships') }, { key: 'policies', label: t('policies') }]} value={tab} onChange={(k) => setTab(k as Tab)} />} />
      {tab === 'policies' ? <PoliciesPanel currencies={currencies} canWrite={canWrite} /> : (
        <div className="grid items-start gap-3 xl:grid-cols-[1.6fr_1fr]">
          <section className="rounded-xl bg-surface p-4">
            {tab === 'packs' ? (
              <StudioAsync res={packs} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.length === 0} empty={<Empty icon="tag" title={t('noPacks')} />}>
                {(rows) => (
                  <ul className="flex flex-col gap-2">
                    {rows.map((p) => (
                      <li key={p.id} className="flex flex-col gap-1 rounded-md bg-canvas-raised px-4 py-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong>{p.name}</strong>
                          <Badge tone="neutral">{p.scope === 'network' ? t('network') : app.locations.find((l) => l.id === p.locationId)?.name ?? t('local')}</Badge>
                          <Badge tone={p.status === 'active' ? 'success' : 'neutral'} icon={p.status === 'active' ? 'check-circle' : 'x'}>{t(`status.${p.status}`)}</Badge>
                          <span className="ml-auto text-xs">{t('activeN', { n: p.active })}</span>
                        </div>
                        <div className="text-xs text-graphite">{t('packLine', { credits: p.credits, days: p.validityDays })} · {t(`access.${p.transferPolicy}`)}</div>
                        <div className="text-xs tabular">{prices(p.prices)}</div>
                        {p.missingCurrencies.length > 0 && <div className="text-xs font-bold text-warning">{t('missing', { list: p.missingCurrencies.join(', ') })}</div>}
                        {canWrite && <div><Button size="sm" variant="ghost" onClick={async () => { await archive.run('pack', p.id, p.status === 'active' ? 'archived' : 'active'); packs.reload(); }}>{p.status === 'active' ? t('archive') : t('reactivate')}</Button></div>}
                      </li>
                    ))}
                  </ul>
                )}
              </StudioAsync>
            ) : (
              <StudioAsync res={plans} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.length === 0} empty={<Empty icon="tag" title={t('noPlans')} />}>
                {(rows) => (
                  <ul className="flex flex-col gap-2">
                    {rows.map((p) => (
                      <li key={p.id} className="flex flex-col gap-1 rounded-md bg-canvas-raised px-4 py-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong>{p.name}</strong>
                          <Badge tone="neutral">{p.scope === 'network' ? t('network') : app.locations.find((l) => l.id === p.locationId)?.name ?? t('local')}</Badge>
                          <Badge tone={p.status === 'active' ? 'success' : 'neutral'} icon={p.status === 'active' ? 'check-circle' : 'x'}>{t(`status.${p.status}`)}</Badge>
                          <span className="ml-auto text-xs">{t('membersN', { n: p.active })}</span>
                        </div>
                        <div className="text-xs text-graphite">{p.classesPerPeriod ? t('perMonth', { n: p.classesPerPeriod }) : t('unlimited')} · {t(`access.${p.accessPolicy}`)} · {t('terms', { notice: p.noticeDays, pause: p.maxPauseDays, grace: p.graceDays })}</div>
                        <div className="text-xs tabular">{prices(p.prices)} {t('monthly')}</div>
                        {p.missingCurrencies.length > 0 && <div className="text-xs font-bold text-warning">{t('missing', { list: p.missingCurrencies.join(', ') })}</div>}
                        {canWrite && <div><Button size="sm" variant="ghost" onClick={async () => { await archive.run('plan', p.id, p.status === 'active' ? 'archived' : 'active'); plans.reload(); }}>{p.status === 'active' ? t('archive') : t('reactivate')}</Button></div>}
                      </li>
                    ))}
                  </ul>
                )}
              </StudioAsync>
            )}
            <ErrorLine message={archive.error?.message} />
          </section>
          {canWrite && <ProductForm kind={tab === 'packs' ? 'pack' : 'plan'} currencies={currencies} onDone={() => (tab === 'packs' ? packs.reload() : plans.reload())} />}
        </div>
      )}
    </>
  );
}

function ProductForm({ kind, currencies, onDone }: { kind: 'pack' | 'plan'; currencies: string[]; onDone: () => void }) {
  const t = useTranslations('studiosFull.pricing');
  const app = useApp();
  const [f, setF] = useState({ name: '', description: '', locationId: '', credits: '10', validity: '90', perMonth: '', notice: '30', pause: '60', grace: '7', policy: 'home_only' as AccessPolicy, prices: {} as Record<string, string> });
  const [ok, setOk] = useState<string | null>(null);
  const priced = Object.fromEntries(Object.entries(f.prices).map(([c, v]) => [c, toMinor(v, c)]).filter(([, v]) => v !== null)) as Record<string, number>;
  const save = useStudioMutation((api) => kind === 'pack'
    ? api.createPackProduct({ name: f.name.trim(), description: f.description || null, locationId: f.locationId || null, credits: Number(f.credits), validityDays: Number(f.validity), prices: priced, transferPolicy: f.policy })
    : api.createMembershipPlan({ name: f.name.trim(), description: f.description || null, locationId: f.locationId || null, classesPerPeriod: f.perMonth ? Number(f.perMonth) : null, prices: priced, accessPolicy: f.policy, noticeDays: Number(f.notice), maxPauseDays: Number(f.pause), graceDays: Number(f.grace) }));
  const shown = f.locationId ? [app.locations.find((l) => l.id === f.locationId)?.currency ?? ''] : currencies;
  return (
    <form className="flex flex-col gap-3 rounded-xl bg-surface p-5" onSubmit={async (e) => { e.preventDefault(); setOk(null); if ((await save.run()) !== undefined) { setOk(t('saved', { name: f.name })); setF((x) => ({ ...x, name: '', description: '', prices: {} })); onDone(); } }}>
      <h2 className="text-base font-bold">{kind === 'pack' ? t('newPack') : t('newPlan')}</h2>
      <Labeled label={t('name')} error={save.error?.fields?.name}><input required className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Labeled>
      <Labeled label={t('descriptionLabel')}><input className={inputCls} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Labeled>
      <Labeled label={t('scope')} hint={t('scopeHint')}>
        <select className={inputCls} value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}>
          <option value="">{t('network')}</option>
          {app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Labeled>
      {kind === 'pack' ? (
        <div className="grid grid-cols-2 gap-3">
          <Labeled label={t('credits')}><input type="number" min={1} className={inputCls} value={f.credits} onChange={(e) => setF({ ...f, credits: e.target.value })} /></Labeled>
          <Labeled label={t('validityDays')}><input type="number" min={1} className={inputCls} value={f.validity} onChange={(e) => setF({ ...f, validity: e.target.value })} /></Labeled>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Labeled label={t('classesPerMonth')} hint={t('blankUnlimited')}><input type="number" min={1} className={inputCls} value={f.perMonth} onChange={(e) => setF({ ...f, perMonth: e.target.value })} /></Labeled>
          <Labeled label={t('noticeDays')}><input type="number" min={0} className={inputCls} value={f.notice} onChange={(e) => setF({ ...f, notice: e.target.value })} /></Labeled>
          <Labeled label={t('maxPause')}><input type="number" min={0} className={inputCls} value={f.pause} onChange={(e) => setF({ ...f, pause: e.target.value })} /></Labeled>
          <Labeled label={t('graceDays')} hint={t('graceHint')}><input type="number" min={0} className={inputCls} value={f.grace} onChange={(e) => setF({ ...f, grace: e.target.value })} /></Labeled>
        </div>
      )}
      <Labeled label={t('where')}>
        <select className={inputCls} value={f.policy} onChange={(e) => setF({ ...f, policy: e.target.value as AccessPolicy })}>{POLICIES.map((p) => <option key={p} value={p}>{t(`access.${p}`)}</option>)}</select>
      </Labeled>
      <fieldset className="grid grid-cols-2 gap-3">
        <legend className="mb-1 text-[13px] font-bold">{kind === 'pack' ? t('pricesPack') : t('pricesPlan')}</legend>
        {shown.map((c) => <Labeled key={c} label={c}><input inputMode="decimal" className={inputCls} value={f.prices[c] ?? ''} onChange={(e) => setF({ ...f, prices: { ...f.prices, [c]: e.target.value } })} /></Labeled>)}
      </fieldset>
      <p className="text-xs text-stone">{t('currencyNote')}</p>
      <Button type="submit" icon="plus" disabled={save.pending || !f.name.trim() || !Object.keys(priced).length}>{t('create')}</Button>
      <ErrorLine message={save.error?.message} />
      {ok && <Banner tone="success" live="polite">{ok}</Banner>}
    </form>
  );
}

function PoliciesPanel({ currencies, canWrite }: { currencies: string[]; canWrite: boolean }) {
  const t = useTranslations('studiosFull.pricing');
  const app = useApp();
  const res = useStudio((api) => api.policies(), [app.role]);
  const [target, setTarget] = useState<string>('');
  const [draft, setDraft] = useState<PolicyVM | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const save = useStudioMutation((api, p: PolicyVM) => api.savePolicy(target || null, p));
  const edit = (loc: string) => {
    const d = res.data;
    const p = (loc ? d?.locationOverrides.find((o) => o.locationId === loc) : null) ?? d?.organizationDefault ?? { lateCancelMinutes: 720, lateCancelFee: {}, noShowFee: {}, forfeitCreditOnLateCancel: true, refundPaidOnLateCancel: false, feesApplyToMembers: true, bookingWindowDays: 30 };
    setTarget(loc);
    setDraft({ lateCancelMinutes: p.lateCancelMinutes, lateCancelFee: { ...p.lateCancelFee }, noShowFee: { ...p.noShowFee }, forfeitCreditOnLateCancel: p.forfeitCreditOnLateCancel, refundPaidOnLateCancel: p.refundPaidOnLateCancel, feesApplyToMembers: p.feesApplyToMembers, bookingWindowDays: p.bookingWindowDays });
  };
  const shown = target ? [app.locations.find((l) => l.id === target)?.currency ?? ''] : currencies;
  return (
    <div className="grid items-start gap-3 xl:grid-cols-[1.4fr_1fr]">
      <StudioAsync res={res} loading={<LoadingBlock variant="table" />}>
        {(d) => (
          <section className="flex flex-col gap-2 rounded-xl bg-surface p-4">
            <p className="text-xs text-stone">{t('policyIntro')}</p>
            {d.effective.map((e) => (
              <article key={e.locationId} className="rounded-md bg-canvas-raised px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{e.locationName}</strong>
                  <Badge tone={e.policy.source === 'location' ? 'info' : 'neutral'}>{e.policy.source === 'location' ? t('localOverride') : t('orgDefault')}</Badge>
                  {canWrite && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => edit(e.locationId)}>{t('editLocal')}</Button>}
                </div>
                <ul className="mt-1 list-disc pl-5 text-xs text-graphite">{e.text.map((x) => <li key={x}>{x}</li>)}</ul>
              </article>
            ))}
            {canWrite && <Button variant="secondary" onClick={() => edit('')}>{t('editDefault')}</Button>}
          </section>
        )}
      </StudioAsync>
      {draft && (
        <form className="flex flex-col gap-3 rounded-xl bg-surface p-5" onSubmit={async (e) => { e.preventDefault(); if ((await save.run(draft)) !== undefined) { setOk(t('policySaved')); res.reload(); } }}>
          <h2 className="text-base font-bold">{target ? t('policyFor', { name: app.locations.find((l) => l.id === target)?.name ?? '' }) : t('orgDefault')}</h2>
          <Labeled label={t('lateWindow')} hint={t('lateWindowHint')}><input type="number" min={0} className={inputCls} value={draft.lateCancelMinutes / 60} onChange={(e) => setDraft({ ...draft, lateCancelMinutes: Math.round(Number(e.target.value) * 60) })} /></Labeled>
          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="mb-1 text-[13px] font-bold">{t('fees')}</legend>
            {shown.map((c) => (
              <div key={c} className="contents">
                <Labeled label={t('lateFee', { c })}><input inputMode="decimal" className={inputCls} defaultValue={draft.lateCancelFee[c] ? String(draft.lateCancelFee[c]! / 100) : ''} onChange={(e) => { const v = toMinor(e.target.value, c); const n = { ...draft.lateCancelFee }; if (v) n[c] = v; else delete n[c]; setDraft({ ...draft, lateCancelFee: n }); }} /></Labeled>
                <Labeled label={t('noShowFee', { c })}><input inputMode="decimal" className={inputCls} defaultValue={draft.noShowFee[c] ? String(draft.noShowFee[c]! / 100) : ''} onChange={(e) => { const v = toMinor(e.target.value, c); const n = { ...draft.noShowFee }; if (v) n[c] = v; else delete n[c]; setDraft({ ...draft, noShowFee: n }); }} /></Labeled>
              </div>
            ))}
          </fieldset>
          {(['forfeitCreditOnLateCancel', 'refundPaidOnLateCancel', 'feesApplyToMembers'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" className="size-4 accent-ink" checked={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />{t(k)}</label>
          ))}
          <Labeled label={t('bookingWindow')}><input type="number" min={1} className={inputCls} value={draft.bookingWindowDays} onChange={(e) => setDraft({ ...draft, bookingWindowDays: Number(e.target.value) })} /></Labeled>
          <p className="text-xs text-stone">{t('policyShown')}</p>
          <Button type="submit" icon="check" disabled={save.pending}>{t('savePolicy')}</Button>
          <ErrorLine message={save.error?.message} />
          {ok && <Banner tone="success" live="polite">{ok}</Banner>}
        </form>
      )}
    </div>
  );
}

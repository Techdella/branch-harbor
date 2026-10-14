'use client';

import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Button, Toggle, cx } from '@bh/ui';
import type { FoodConfig, LocationSettings } from '@/lib/foods/types';
import { useFoods, useFoodsMutation } from '@/lib/foods/useFoods';
import { useApp } from '../../../shell/AppContext';
import { PageHeader } from '../../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../../ui/States';
import { ErrorLine, Labeled, LocationSelect, NoLocations, Section, inputCls, pctFromBps, useFx, useLocationPick } from './common';

const CHANNELS: Array<keyof FoodConfig['channels']> = ['pickup', 'delivery', 'dineIn', 'preorder', 'catering', 'mealPlans'];

/** Ordering channels, tips, service charges, allergen convention, configured tax, delivery hours and KDS stations per location. */
export function OrderingSettingsScreen() {
  const t = useFx();
  const app = useApp();
  const pick = useLocationPick();
  const res = useFoods((api) => api.settings(), [app.org.id]);
  if (!pick.loc) return <NoLocations />;
  return (
    <>
      <PageHeader icon="settings" title={t('settings.title')} description={t('settings.description')} />
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-4 py-3"><LocationSelect pick={pick} /></div>
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {(all) => {
          const s = all.find((x) => x.locationId === pick.locationId);
          if (!s) return <Banner tone="neutral">{t('common.unavailable')}</Banner>;
          return <SettingsForm key={s.locationId} s={s} canWrite={app.can('operations.write')} onSaved={res.reload} />;
        }}
      </Async>
      <Stations locationId={pick.locationId} canWrite={app.can('operations.write')} />
    </>
  );
}

function SettingsForm({ s, canWrite, onSaved }: { s: LocationSettings; canWrite: boolean; onSaved: () => void }) {
  const t = useFx();
  const locale = useLocale();
  const [cfg, setCfg] = useState<FoodConfig>(s.config);
  const [tax, setTax] = useState(s.taxRateBps === null ? '' : (s.taxRateBps / 100).toString());
  const [presets, setPresets] = useState(s.config.tips.presetsBps.map((b) => b / 100).join(', '));
  const [saved, setSaved] = useState(false);
  const save = useFoodsMutation(async (api, body: Parameters<typeof api.saveSettings>[1]) => { await api.saveSettings(s.locationId, body); return true; });
  useEffect(() => setSaved(false), [cfg, tax, presets]);
  const set = <K extends keyof FoodConfig>(k: K, v: FoodConfig[K]) => setCfg({ ...cfg, [k]: v });
  const chanToggle = (list: string[], c: string) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]);
  const submit = async () => {
    const body = { ...cfg, tips: { ...cfg.tips, presetsBps: presets.split(',').map((x) => Math.round(Number(x.trim()) * 100)).filter((x) => Number.isFinite(x) && x > 0) }, taxRateBps: tax.trim() === '' ? null : Math.round(Number(tax) * 100) };
    if (await save.run(body)) { setSaved(true); onSaved(); }
  };
  return (
    <fieldset disabled={!canWrite} className="grid gap-3 lg:grid-cols-2">
      <Section title={t('settings.channels')}>
        <ul className="flex flex-col gap-2">
          {CHANNELS.map((c) => (
            <li key={c} className="flex items-center justify-between gap-2 text-sm font-semibold">{t(`settings.channel.${c}`)}<Toggle checked={cfg.channels[c]} label={t(`settings.channel.${c}`)} onChange={(v) => set('channels', { ...cfg.channels, [c]: v })} /></li>
          ))}
        </ul>
      </Section>
      <Section title={t('settings.tipsAndCharges')}>
        <div className="flex flex-col gap-3">
          <span className="flex items-center justify-between text-sm font-semibold">{t('settings.tipsEnabled')}<Toggle checked={cfg.tips.enabled} label={t('settings.tipsEnabled')} onChange={(v) => set('tips', { ...cfg.tips, enabled: v })} /></span>
          <Labeled label={t('settings.tipPresets')} hint={t('settings.tipPresetsHint')}><input value={presets} onChange={(e) => setPresets(e.target.value)} className={inputCls} /></Labeled>
          <div className="flex flex-wrap gap-1.5">{['pickup', 'delivery', 'dine_in'].map((c) => <button key={c} type="button" aria-pressed={cfg.tips.channels.includes(c)} onClick={() => set('tips', { ...cfg.tips, channels: chanToggle(cfg.tips.channels, c) })} className={cx('h-8 rounded-full px-3 text-xs font-bold', cfg.tips.channels.includes(c) ? 'bg-ink text-white' : 'bg-canvas')}>{t(`channel.${c}`)}</button>)}</div>
          <div className="grid grid-cols-2 gap-2">
            <Labeled label={t('settings.serviceCharge')}><input inputMode="decimal" value={cfg.serviceCharge.bps / 100} onChange={(e) => set('serviceCharge', { ...cfg.serviceCharge, bps: Math.round(Number(e.target.value || 0) * 100) })} className={inputCls} /></Labeled>
            <Labeled label={t('settings.serviceChargeLabel')}><input value={cfg.serviceCharge.label} onChange={(e) => set('serviceCharge', { ...cfg.serviceCharge, label: e.target.value })} className={inputCls} /></Labeled>
          </div>
          <div className="flex flex-wrap gap-1.5">{['dine_in', 'catering', 'delivery', 'pickup'].map((c) => <button key={c} type="button" aria-pressed={cfg.serviceCharge.channels.includes(c)} onClick={() => set('serviceCharge', { ...cfg.serviceCharge, channels: chanToggle(cfg.serviceCharge.channels, c) })} className={cx('h-8 rounded-full px-3 text-xs font-bold', cfg.serviceCharge.channels.includes(c) ? 'bg-ink text-white' : 'bg-canvas')}>{t(`channel.${c}`)}</button>)}</div>
          <Labeled label={t('settings.tax')} hint={t('settings.taxHint')}><input inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} placeholder={t('settings.taxNone')} className={inputCls} /></Labeled>
          <p className="text-xs text-stone">{cfg.serviceCharge.bps ? t('settings.serviceSummary', { pct: pctFromBps(cfg.serviceCharge.bps, locale) }) : t('settings.noServiceCharge')}</p>
        </div>
      </Section>
      <Section title={t('settings.allergenConvention')}>
        <Labeled label={t('settings.convention')} hint={t('settings.conventionHint')}>
          <select value={cfg.allergenRegime ?? ''} onChange={(e) => set('allergenRegime', e.target.value || null)} className={inputCls}>
            <option value="">{t('settings.conventionDefault', { regime: s.allergenRegime })}</option>
            <option value="eu14">{t('settings.regime.eu14')}</option>
            <option value="us9">{t('settings.regime.us9')}</option>
            <option value="ca">{t('settings.regime.ca')}</option>
          </select>
        </Labeled>
        <span className="mt-3 flex items-center justify-between text-sm font-semibold">{t('settings.autoSoldOut')}<Toggle checked={cfg.autoSoldOutOnIngredients} label={t('settings.autoSoldOut')} onChange={(v) => set('autoSoldOutOnIngredients', v)} /></span>
        <span className="mt-3 flex items-center justify-between text-sm font-semibold">{t('settings.kdsSound')}<Toggle checked={cfg.kds.audibleDefault} label={t('settings.kdsSound')} onChange={(v) => set('kds', { ...cfg.kds, audibleDefault: v })} /></span>
      </Section>
      <Section title={t('settings.delivery')}>
        <div className="grid grid-cols-2 gap-2">
          <Labeled label={t('settings.provider')}>
            <select value={cfg.delivery.provider} onChange={(e) => set('delivery', { ...cfg.delivery, provider: e.target.value as 'own' })} className={inputCls}>
              <option value="own">{t('delivery.provider.own')}</option><option value="uber_direct">Uber Direct</option><option value="deliverect">Deliverect</option>
            </select>
          </Labeled>
          <Labeled label={t('settings.slotCapacity')}><input inputMode="numeric" value={cfg.delivery.slotCapacity} onChange={(e) => set('delivery', { ...cfg.delivery, slotCapacity: Number(e.target.value) || 1 })} className={inputCls} /></Labeled>
          <Labeled label={t('settings.leadMinutes')}><input inputMode="numeric" value={cfg.delivery.leadMinutes} onChange={(e) => set('delivery', { ...cfg.delivery, leadMinutes: Number(e.target.value) || 0 })} className={inputCls} /></Labeled>
          <Labeled label={t('settings.slotMinutes')}><input inputMode="numeric" value={cfg.delivery.slotMinutes} onChange={(e) => set('delivery', { ...cfg.delivery, slotMinutes: Number(e.target.value) || 30 })} className={inputCls} /></Labeled>
        </div>
        <p className="mt-2 text-xs text-stone">{cfg.delivery.hours.length ? t('settings.deliveryHours', { hours: [...new Set(cfg.delivery.hours.map((h) => `${h.open}–${h.close}`))].join(', '), tz: s.timeZone }) : t('settings.noDeliveryHours')}</p>
      </Section>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
          <Button loading={save.pending} onClick={submit}>{t('common.save')}</Button>
          {saved && !save.error && <Badge tone="success">{t('common.saved')}</Badge>}
          <ErrorLine error={save.error} />
        </div>
      )}
    </fieldset>
  );
}

function Stations({ locationId, canWrite }: { locationId: string; canWrite: boolean }) {
  const t = useFx();
  const res = useFoods((api) => api.stations(locationId), [locationId], !!locationId);
  const create = useFoodsMutation((api, body: { key: string; name: string; prepTargetMinutes: number }) => api.createStation(locationId, body));
  const defaults = useFoodsMutation((api) => api.defaultStations(locationId));
  const update = useFoodsMutation((api, id: string, prep: number) => api.updateStation(id, { prepTargetMinutes: prep }));
  const [name, setName] = useState('');
  const [prep, setPrep] = useState('10');
  return (
    <Section title={t('settings.stations')} aside={canWrite && <Button size="sm" variant="secondary" icon="plus" loading={defaults.pending} onClick={async () => { await defaults.run(); res.reload(); }}>{t('settings.defaultStations')}</Button>}>
      <p className="mb-2 text-sm text-stone">{t('settings.stationsBody')}</p>
      <Async res={res} loading={<LoadingBlock variant="table" rows={2} />}>
        {(list) => (
          <ul className="divide-y divide-line-soft">
            {list.map((st) => (
              <li key={st.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <strong className="min-w-28">{st.name}</strong><span className="text-stone">{st.key}{st.isExpo && ` · ${t('kds.expo')}`}</span>
                <label className="ml-auto flex items-center gap-2 text-xs font-bold">{t('settings.prepTarget')}
                  <input aria-label={t('settings.prepTargetOf', { name: st.name })} disabled={!canWrite} defaultValue={st.prepTargetMinutes} inputMode="numeric" className={cx(inputCls, 'w-20')} onBlur={async (e) => { const v = Number(e.target.value); if (v && v !== st.prepTargetMinutes) { await update.run(st.id, v); res.reload(); } }} />
                </label>
              </li>
            ))}
            {!list.length && <li className="py-2 text-sm text-stone">{t('kds.noStationsBody')}</li>}
          </ul>
        )}
      </Async>
      {canWrite && (
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (await create.run({ name, key: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30), prepTargetMinutes: Number(prep) || 10 })) { setName(''); res.reload(); } }}>
          <Labeled label={t('settings.stationName')}><input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} className={inputCls} /></Labeled>
          <Labeled label={t('settings.prepTarget')}><input value={prep} onChange={(e) => setPrep(e.target.value)} inputMode="numeric" className={cx(inputCls, 'w-24')} /></Labeled>
          <Button type="submit" size="sm" icon="plus" loading={create.pending}>{t('common.add')}</Button>
        </form>
      )}
      <ErrorLine error={create.error ?? defaults.error ?? update.error} />
    </Section>
  );
}

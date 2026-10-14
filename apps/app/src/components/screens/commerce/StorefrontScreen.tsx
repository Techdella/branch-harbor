'use client';

import { useState } from 'react';
import { Button, Input, Toggle } from '@bh/ui';
import { cx as call, useAction, useCommerce } from '@/lib/commerce/client';
import type { Collection, StoreSettings } from '@/lib/commerce/types';
import { workspace } from '@/lib/http/workspace';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, SectionCard } from '../../ui/States';
import { ActionError, MoneyInput, NumberInput, StorePicker, View, useCt, useStore } from './kit';

const SITES_URL = (process.env.NEXT_PUBLIC_SITES_URL ?? 'http://localhost:3002').replace(/\/$/, '');

/** Storefront: fulfilment options per store, configured taxes, reservation and return windows, collections, preview. */
export function StorefrontScreen() {
  const t = useCt();
  const app = useApp();
  const [loc, setLoc] = useStore();
  const res = useCommerce(() => call<{ items: StoreSettings[] }>('GET', '/fulfilment-settings'), [app.org.id, app.apiMode]);
  const cols = useCommerce(() => call<{ items: Collection[] }>('GET', '/collections'), [app.org.id, app.apiMode]);
  const store = res.data?.items.find((s) => s.location.id === loc);
  const slug = app.locations.find((l) => l.id === loc);
  return (
    <>
      <PageHeader icon="cart" title={t('storefront.title')} description={t('storefront.description')} actions={<StorePicker value={loc} onChange={setLoc} />} />
      <View res={res}>
        {() => store ? <Settings key={loc} s={store} onSaved={() => res.reload()} /> : <Banner tone="neutral">{t('storefront.noStore')}</Banner>}
      </View>
      {slug && (() => {
        const ws = workspace();
        const url = app.live && ws?.org ? `${SITES_URL}/${ws.org.slug}` : SITES_URL;
        return <SectionCard title={t('storefront.preview')}><p className="text-sm text-stone">{t('storefront.previewHint')}</p><a className="text-sm font-bold underline" href={url} target="_blank" rel="noreferrer">{url}</a></SectionCard>;
      })()}
      <SectionCard title={t('storefront.collections')}>
        <View res={cols}>
          {(d) => (
            <ul className="flex flex-col gap-1.5 text-sm">
              {d.items.map((c) => <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised px-3 py-2"><strong>{c.title}</strong><span className="text-xs text-stone">/{c.slug} · {t('storefront.productsN', { n: c.productIds.length })}{Object.keys(c.translations).length ? ` · ${Object.keys(c.translations).join(', ')}` : ''}</span></li>)}
            </ul>
          )}
        </View>
        <NewCollection onCreated={() => cols.reload()} />
      </SectionCard>
    </>
  );
}

function NewCollection({ onCreated }: { onCreated: () => void }) {
  const t = useCt();
  const app = useApp();
  const [title, setTitle] = useState('');
  const save = useAction(async () => { const r = await call<Collection>('POST', '/collections', { title, slug: title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') }); setTitle(''); onCreated(); return r; });
  if (!app.can('templates.write')) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('storefront.collectionTitle')} aria-label={t('storefront.collectionTitle')} className="h-10 max-w-xs" />
      <Button variant="secondary" disabled={!title} loading={save.pending} onClick={() => save.run()}>{t('storefront.addCollection')}</Button>
      <ActionError error={save.error} />
    </div>
  );
}

function Settings({ s, onSaved }: { s: StoreSettings; onSaved: () => void }) {
  const t = useCt();
  const app = useApp();
  const [v, setV] = useState(s.settings);
  const [rates, setRates] = useState(s.taxRates.map((r) => ({ name: r.name, pct: r.rateBps / 100, inclusive: r.inclusive })));
  const manager = app.can('locations.read') && app.can('operations.write');
  const cur = s.location.currency;
  const save = useAction(async () => { const { configured: _c, ...body } = v; const r = await call('PUT', `/locations/${s.location.id}/fulfilment-settings`, body); onSaved(); return r; });
  const saveTax = useAction(async () => { const r = await call('PUT', `/locations/${s.location.id}/tax-rates`, { rates: rates.filter((x) => x.name).map((x) => ({ name: x.name, rateBps: Math.round(x.pct * 100), inclusive: x.inclusive })) }); onSaved(); return r; });
  const set = (p: Partial<typeof v>) => setV({ ...v, ...p });
  return (
    <div className="flex flex-col gap-4">
      <SectionCard title={t('storefront.ordering')}>
        <fieldset disabled={!manager} className="flex flex-col gap-3 text-sm">
          {!v.configured && <Banner tone="neutral">{t('storefront.defaults')}</Banner>}
          <Toggle checked={v.storefrontEnabled} onChange={(x) => set({ storefrontEnabled: x })} label={t('storefront.enabled')} />
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex flex-col gap-2 rounded-lg bg-canvas-raised p-3">
              <Toggle checked={v.pickupEnabled} onChange={(x) => set({ pickupEnabled: x })} label={t('storefront.pickup')} />
              <label className="flex items-center gap-2">{t('storefront.readyIn')}<NumberInput value={v.pickupReadyMinutes} onChange={(n) => set({ pickupReadyMinutes: n })} label={t('storefront.readyIn')} />min</label>
              <Input value={v.pickupInstructions ?? ''} onChange={(e) => set({ pickupInstructions: e.target.value || null })} placeholder={t('storefront.instructions')} aria-label={t('storefront.instructions')} />
              <Toggle checked={v.crossLocationPickup} onChange={(x) => set({ crossLocationPickup: x })} label={t('storefront.crossPickup')} />
            </div>
            <div className="flex flex-col gap-2 rounded-lg bg-canvas-raised p-3">
              <Toggle checked={v.localDeliveryEnabled} onChange={(x) => set({ localDeliveryEnabled: x })} label={t('storefront.delivery')} />
              <span className="flex items-center gap-2">{t('storefront.fee')}<MoneyInput minor={v.deliveryFeeMinor} currency={cur} label={t('storefront.fee')} onChange={(n) => set({ deliveryFeeMinor: n ?? 0 })} /></span>
              <span className="flex items-center gap-2">{t('storefront.freeOver')}<MoneyInput minor={v.freeDeliveryOverMinor} currency={cur} label={t('storefront.freeOver')} onChange={(n) => set({ freeDeliveryOverMinor: n })} /></span>
              <Input value={v.deliveryPostcodes.join(', ')} onChange={(e) => set({ deliveryPostcodes: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder={t('storefront.postcodes')} aria-label={t('storefront.postcodes')} />
            </div>
            <div className="flex flex-col gap-2 rounded-lg bg-canvas-raised p-3">
              <Toggle checked={v.shippingEnabled} onChange={(x) => set({ shippingEnabled: x })} label={t('storefront.shipping')} />
              <span className="flex items-center gap-2">{t('storefront.fee')}<MoneyInput minor={v.shippingFeeMinor} currency={cur} label={t('storefront.shippingFee')} onChange={(n) => set({ shippingFeeMinor: n ?? 0 })} /></span>
              <Input value={v.shippingCountries.join(', ')} onChange={(e) => set({ shippingCountries: e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter((x) => x.length === 2) })} placeholder={t('storefront.countries')} aria-label={t('storefront.countries')} />
            </div>
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2">{t('storefront.reservation')}<NumberInput value={v.reservationMinutes} onChange={(n) => set({ reservationMinutes: n })} label={t('storefront.reservation')} />min</label>
            <label className="flex items-center gap-2">{t('storefront.returnWindow')}<NumberInput value={v.returnWindowDays} onChange={(n) => set({ returnWindowDays: n })} label={t('storefront.returnWindow')} />{t('storefront.days')}</label>
          </div>
          <ActionError error={save.error} />
          {manager && <Button className="self-start" loading={save.pending} onClick={() => save.run()}>{t('common.save')}</Button>}
        </fieldset>
      </SectionCard>
      <SectionCard title={t('storefront.taxes')}>
        <p className="mb-2 text-xs text-stone">{t('storefront.taxHint')}</p>
        {!rates.length && <Banner tone="neutral" icon="info">{t('storefront.noTax')}</Banner>}
        <fieldset disabled={!app.can('policies.write')} className="flex flex-col gap-2 text-sm">
          {rates.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input value={r.name} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label={t('storefront.taxName')} className="h-10 w-40" />
              <input type="number" step="0.001" min={0} max={100} value={r.pct} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, pct: Number(e.target.value) } : x)))} aria-label={t('storefront.taxRate')} className="h-10 w-24 rounded-md border border-line px-2 text-right" />%
              <Toggle checked={r.inclusive} onChange={(x) => setRates(rates.map((y, j) => (j === i ? { ...y, inclusive: x } : y)))} label={t('storefront.inclusive')} />
              <Button size="sm" variant="ghost" icon="x" aria-label={t('common.remove')} onClick={() => setRates(rates.filter((_, j) => j !== i))} />
            </div>
          ))}
          {app.can('policies.write') && (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" icon="plus" onClick={() => setRates([...rates, { name: '', pct: 0, inclusive: false }])}>{t('storefront.addTax')}</Button>
              <Button size="sm" loading={saveTax.pending} onClick={() => saveTax.run()}>{t('storefront.saveTaxes')}</Button>
            </div>
          )}
          <ActionError error={saveTax.error} />
        </fieldset>
      </SectionCard>
    </div>
  );
}

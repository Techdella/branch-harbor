'use client';

import { useMemo, useState } from 'react';
import { Badge, Button, DataTable, Drawer, Icon, Input, Select, Tabs, Textarea, Toggle } from '@bh/ui';
import { cx as call, useAction, useCommerce } from '@/lib/commerce/client';
import type { CatalogueItem, CopyDraft, Distribution, PlanItem, ProductDetail, VariantRow } from '@/lib/commerce/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, SectionCard } from '../../ui/States';
import { ActionError, F, Money, MoneyInput, StatusBadge, View, When, useCt, useScopeStores } from './kit';

/** Master catalogue (HQ): products, options matrix, variants, images, per-locale content, distribution with preview and results. */
export function CatalogueScreen() {
  const t = useCt();
  const app = useApp();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'draft' | 'archived'>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [distributing, setDistributing] = useState(false);
  const res = useCommerce(() => call<{ items: CatalogueItem[] }>('GET', '/catalogue'), [app.org.id]);
  const dists = useCommerce(() => call<{ items: Distribution[] }>('GET', '/distributions'), [app.org.id], app.can('templates.write'));
  const hq = app.can('templates.write');
  const items = (res.data?.items ?? []).filter((p) => (status === 'all' || p.status === status) && (!q || `${p.name} ${p.sku}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <>
      <PageHeader icon="layers" title={t('catalogue.title')} description={t('catalogue.description')} actions={hq && (
        <>
          <Button variant="secondary" icon="send" disabled={!selected.length} onClick={() => setDistributing(true)}>{t('catalogue.distribute', { n: selected.length })}</Button>
          <Button icon="plus" onClick={() => setEditing('new')}>{t('catalogue.newProduct')}</Button>
        </>
      )} />
      {!hq && <Banner tone="neutral" icon="lock">{t('catalogue.readOnly')}</Banner>}
      <SectionCard>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input placeholder={t('catalogue.search')} value={q} onChange={(e) => setQ(e.target.value)} className="h-10 max-w-xs" aria-label={t('catalogue.search')} />
          <Tabs value={status} onChange={setStatus} items={(['all', 'active', 'draft', 'archived'] as const).map((k) => ({ key: k, label: t(`catalogue.status.${k}`) }))} />
        </div>
        <View res={res} isEmpty={(d) => !d.items.length} empty={<Empty icon="layers" title={t('catalogue.empty')} body={t('catalogue.emptyBody')} />}>
          {() => (
            <DataTable
              rows={items}
              rowKey={(p) => p.id}
              onRowClick={(p) => setEditing(p.id)}
              columns={[
                ...(hq ? [{ key: 'sel', header: '', render: (p: CatalogueItem) => <input type="checkbox" aria-label={t('catalogue.select', { name: p.name })} className="h-[18px] w-[18px] accent-ink" checked={selected.includes(p.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id)))} /> }] : []),
                { key: 'name', header: t('catalogue.product'), render: (p: CatalogueItem) => (
                  <span className="flex items-center gap-3">
                    {p.image ? <img src={p.image} alt="" className="h-10 w-10 rounded-md object-cover" /> : <span className="h-10 w-10 rounded-md bg-canvas" />}
                    <span><span className="block font-bold">{p.name}</span><span className="text-xs text-stone">{p.sku} · {t('catalogue.variants', { n: p.variantCount })}{p.options.length ? ` · ${p.options.map((o) => o.name).join(' × ')}` : ''}</span></span>
                  </span>
                ) },
                { key: 'status', header: t('catalogue.statusCol'), render: (p: CatalogueItem) => <StatusBadge kind="product" value={p.status} /> },
                { key: 'prices', header: t('catalogue.prices'), render: (p: CatalogueItem) => <span className="text-xs">{[...new Set(p.prices.flatMap((x) => Object.keys(x)))].join(' · ') || t('common.none')}</span> },
                { key: 'i18n', header: t('catalogue.languages'), render: (p: CatalogueItem) => <span className="text-xs">{['en', ...p.translations].join(', ')}</span> },
                { key: 'pub', header: t('catalogue.publish'), render: (p: CatalogueItem) => (
                  <span className="flex flex-wrap gap-1">
                    <Badge tone={p.publish.listedAt ? 'success' : 'neutral'}>{t('catalogue.listedAt', { n: p.publish.listedAt })}</Badge>
                    {p.publish.outdated > 0 && <Badge tone="warning">{t('catalogue.outdated', { n: p.publish.outdated })}</Badge>}
                  </span>
                ) },
              ]}
            />
          )}
        </View>
      </SectionCard>
      {hq && (
        <SectionCard title={t('catalogue.recentDistributions')}>
          <View res={dists} isEmpty={(d) => !d.items.length} empty={<p className="text-sm text-stone">{t('catalogue.noDistributions')}</p>}>
            {(d) => (
              <ul className="flex flex-col gap-1.5 text-sm">
                {d.items.slice(0, 6).map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised px-3 py-2">
                    <StatusBadge kind="result" value={x.status === 'completed' ? 'synced' : x.status === 'partial' ? 'skipped' : 'failed'} />
                    <span className="font-semibold">{t(`catalogue.distStatus.${x.status}`)}</span>
                    <span className="text-xs text-stone">{t('catalogue.summary', x.summary)}</span>
                    <span className="ms-auto text-xs text-stone"><When iso={x.createdAt} />{x.createdByName ? ` · ${x.createdByName}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </View>
        </SectionCard>
      )}
      {editing && <ProductEditor id={editing === 'new' ? null : editing} canEdit={hq} onClose={() => setEditing(null)} onSaved={() => res.reload()} onDistribute={(id) => { setSelected([id]); setEditing(null); setDistributing(true); }} />}
      {distributing && <DistributionPanel productIds={selected} onClose={() => setDistributing(false)} onDone={() => { res.reload(); dists.reload(); }} />}
    </>
  );
}

const blank = (): ProductDetail => ({ id: '', sku: '', name: '', description: '', slug: null, vendor: null, productType: null, tags: [], status: 'draft', options: [], specs: {}, eligibility: { mode: 'all', locationIds: [] }, priceBounds: {}, allowBackorder: false, returnable: true, contentVersion: 0, variants: [], images: [], translations: {}, collectionIds: [], lockedFields: [], listings: [] });

function ProductEditor({ id, canEdit, onClose, onSaved, onDistribute }: { id: string | null; canEdit: boolean; onClose: () => void; onSaved: () => void; onDistribute: (id: string) => void }) {
  const t = useCt();
  const app = useApp();
  const stores = useScopeStores();
  const currencies = [...new Set(app.locations.map((l) => l.currency as string))];
  const res = useCommerce(() => (id ? call<ProductDetail>('GET', `/catalogue/${id}`) : Promise.resolve(blank())), [id]);
  const [draft, setDraft] = useState<ProductDetail | null>(null);
  const [tab, setTab] = useState<'basics' | 'variants' | 'rules' | 'content' | 'publish'>('basics');
  const [locale, setLocale] = useState('fr');
  const [aiDraft, setAiDraft] = useState<CopyDraft | null>(null);
  const p = draft ?? res.data ?? null;
  const set = (patch: Partial<ProductDetail>) => p && setDraft({ ...p, ...patch });
  const distributed = !!p?.listings.length;
  const save = useAction(async () => {
    const body = { sku: p!.sku, name: p!.name, description: p!.description || null, slug: p!.slug || null, vendor: p!.vendor || null, productType: p!.productType || null, tags: p!.tags, status: p!.status, options: p!.options, specs: p!.specs, eligibility: p!.eligibility, priceBounds: p!.priceBounds, allowBackorder: p!.allowBackorder, returnable: p!.returnable, images: p!.images.map((i) => ({ url: i.url, alt: i.alt, variantId: i.variantId })), variants: p!.variants.map((v) => ({ ...(v.id && !v.id.startsWith('new_') ? { id: v.id } : {}), sku: v.sku, name: v.name, options: v.options, prices: v.prices, barcode: v.barcode, imageUrl: v.imageUrl, status: v.status })) };
    const out = await call<ProductDetail>(id ? 'PUT' : 'POST', id ? `/catalogue/${id}` : '/catalogue', body);
    setDraft(out); onSaved(); return out;
  });
  const saveTr = useAction(async (name: string, description: string) => { const out = await call<ProductDetail>('PUT', `/catalogue/${id}/translations/${locale}`, { name: name || undefined, description }); setDraft(out); onSaved(); return out; });
  const ai = useAction(async () => { const r = await call<CopyDraft>('POST', '/ai/product-copy', { productId: id, locale: 'en' }); setAiDraft(r); return r; });
  const gen = useAction(async () => {
    const r = await call<{ variants: Array<{ sku: string; name: string; options: Record<string, string> }> }>('POST', '/catalogue/variant-matrix', { sku: p!.sku || 'SKU', name: p!.name || 'Variant', options: p!.options });
    const existing = p!.variants;
    const merged: VariantRow[] = r.variants.map((g, i) => existing.find((e) => JSON.stringify(e.options) === JSON.stringify(g.options)) ?? { id: `new_${i}_${g.sku}`, sku: g.sku, name: g.name, options: g.options, prices: {}, barcode: null, imageUrl: null, status: 'active' });
    set({ variants: [...merged, ...existing.filter((e) => !merged.includes(e)).map((e) => ({ ...e, status: 'archived' as const }))] });
    return r;
  });
  const [trName, setTrName] = useState('');
  const [trDesc, setTrDesc] = useState('');

  return (
    <Drawer open onClose={onClose} kicker={id ? t('catalogue.editKicker') : t('catalogue.newKicker')} title={p?.name || t('catalogue.newProduct')} footer={canEdit && p && (
      <div className="flex flex-wrap items-center gap-2">
        <Button icon="check" loading={save.pending} onClick={() => save.run()}>{t('common.save')}</Button>
        {id && <Button variant="secondary" icon="send" onClick={() => onDistribute(id)}>{t('catalogue.distributeThis')}</Button>}
      </div>
    )}>
      <View res={res}>
        {() => p && (
          <div className="flex flex-col gap-4">
            <Tabs value={tab} onChange={setTab} items={[{ key: 'basics', label: t('catalogue.tabs.basics') }, { key: 'variants', label: t('catalogue.tabs.variants') }, { key: 'rules', label: t('catalogue.tabs.rules') }, { key: 'content', label: t('catalogue.tabs.content') }, ...(id ? [{ key: 'publish' as const, label: t('catalogue.tabs.publish') }] : [])]} />
            <ActionError error={save.error} />
            {tab === 'basics' && (
              <fieldset disabled={!canEdit} className="flex flex-col gap-3">
                <F label={t('catalogue.f.sku')} hint={distributed ? t('catalogue.skuLocked') : undefined}><Input value={p.sku} disabled={distributed} onChange={(e) => set({ sku: e.target.value })} /></F>
                <F label={t('catalogue.f.name')}><Input value={p.name} onChange={(e) => set({ name: e.target.value })} /></F>
                <F label={t('catalogue.f.description')} optional>
                  <Textarea rows={4} value={p.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
                </F>
                {id && (
                  <div className="rounded-lg bg-canvas-raised p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Icon name="marina" size={16} /><strong>{t('catalogue.ai.title')}</strong>
                      <Button size="sm" variant="secondary" loading={ai.pending} onClick={() => ai.run()}>{t('catalogue.ai.draft')}</Button>
                    </div>
                    <p className="mt-1 text-xs text-stone">{t('catalogue.ai.note')}</p>
                    {ai.error && <div className="mt-2"><Banner tone={ai.error.status === 503 ? 'neutral' : 'danger'} icon={ai.error.status === 503 ? 'wifi-off' : undefined}>{ai.error.message}</Banner></div>}
                    {aiDraft && (
                      <div className="mt-2 flex flex-col gap-2">
                        <p className="whitespace-pre-wrap rounded-md bg-white p-3">{aiDraft.draft.description}</p>
                        {aiDraft.draft.bullets.length > 0 && <ul className="ms-5 list-disc">{aiDraft.draft.bullets.map((b) => <li key={b}>{b}</li>)}</ul>}
                        {aiDraft.removedClaims.length > 0 && <Banner tone="warning" title={t('catalogue.ai.removed')}>{aiDraft.removedClaims.map((c) => <div key={c.sentence}>“{c.sentence}” — {c.term}</div>)}</Banner>}
                        <p className="text-xs text-stone">{t('catalogue.ai.sources', { list: aiDraft.sources.map((s) => s.key).join(', ') })}</p>
                        <Button size="sm" variant="secondary" onClick={() => set({ description: aiDraft.draft.description })}>{t('catalogue.ai.use')}</Button>
                      </div>
                    )}
                  </div>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  <F label={t('catalogue.f.slug')} optional><Input value={p.slug ?? ''} onChange={(e) => set({ slug: e.target.value })} /></F>
                  <F label={t('catalogue.f.status')}><Select value={p.status} onChange={(e) => set({ status: e.target.value as ProductDetail['status'] })}>{(['draft', 'active', 'archived'] as const).map((s) => <option key={s} value={s}>{t(`catalogue.status.${s}`)}</option>)}</Select></F>
                  <F label={t('catalogue.f.vendor')} optional><Input value={p.vendor ?? ''} onChange={(e) => set({ vendor: e.target.value })} /></F>
                  <F label={t('catalogue.f.type')} optional><Input value={p.productType ?? ''} onChange={(e) => set({ productType: e.target.value })} /></F>
                </div>
                <div>
                  <div className="mb-1 text-sm font-bold">{t('catalogue.f.images')}</div>
                  {p.images.map((im, i) => (
                    <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
                      <img src={im.url} alt="" className="h-12 w-12 rounded-md object-cover" />
                      <Input className="h-10 min-w-0 flex-1" value={im.url} aria-label={t('catalogue.f.imageUrl')} onChange={(e) => set({ images: p.images.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
                      <Input className="h-10 w-40" value={im.alt} placeholder={t('catalogue.f.alt')} aria-label={t('catalogue.f.alt')} onChange={(e) => set({ images: p.images.map((x, j) => (j === i ? { ...x, alt: e.target.value } : x)) })} />
                      <Button size="sm" variant="ghost" icon="x" aria-label={t('common.remove')} onClick={() => set({ images: p.images.filter((_, j) => j !== i) })} />
                    </div>
                  ))}
                  <Button size="sm" variant="secondary" icon="plus" onClick={() => set({ images: [...p.images, { url: 'https://', alt: p.name, variantId: null }] })}>{t('catalogue.addImage')}</Button>
                </div>
                <div>
                  <div className="mb-1 text-sm font-bold">{t('catalogue.f.specs')}</div>
                  <p className="mb-2 text-xs text-stone">{t('catalogue.specsHint')}</p>
                  {Object.entries(p.specs).map(([k, v], i) => (
                    <div key={i} className="mb-2 flex gap-2">
                      <Input className="h-10 w-40" value={k} aria-label={t('catalogue.f.specKey')} onChange={(e) => set({ specs: Object.fromEntries(Object.entries(p.specs).map(([a, b]) => (a === k ? [e.target.value, b] : [a, b]))) })} />
                      <Input className="h-10 flex-1" value={v} aria-label={t('catalogue.f.specValue')} onChange={(e) => set({ specs: { ...p.specs, [k]: e.target.value } })} />
                      <Button size="sm" variant="ghost" icon="x" aria-label={t('common.remove')} onClick={() => { const s = { ...p.specs }; delete s[k]; set({ specs: s }); }} />
                    </div>
                  ))}
                  <Button size="sm" variant="secondary" icon="plus" onClick={() => set({ specs: { ...p.specs, [`Spec ${Object.keys(p.specs).length + 1}`]: '' } })}>{t('catalogue.addSpec')}</Button>
                </div>
              </fieldset>
            )}
            {tab === 'variants' && (
              <fieldset disabled={!canEdit} className="flex flex-col gap-3">
                <div>
                  <div className="mb-1 text-sm font-bold">{t('catalogue.optionsMatrix')}</div>
                  {p.options.map((o, i) => (
                    <div key={i} className="mb-2 flex flex-wrap gap-2">
                      <Input className="h-10 w-36" value={o.name} aria-label={t('catalogue.f.optionName')} onChange={(e) => set({ options: p.options.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                      <Input className="h-10 min-w-0 flex-1" value={o.values.join(', ')} aria-label={t('catalogue.f.optionValues')} onChange={(e) => set({ options: p.options.map((x, j) => (j === i ? { ...x, values: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) } : x)) })} />
                      <Button size="sm" variant="ghost" icon="x" aria-label={t('common.remove')} onClick={() => set({ options: p.options.filter((_, j) => j !== i) })} />
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" icon="plus" disabled={p.options.length >= 3} onClick={() => set({ options: [...p.options, { name: '', values: [] }] })}>{t('catalogue.addOption')}</Button>
                    <Button size="sm" variant="secondary" icon="grid" loading={gen.pending} onClick={() => gen.run()}>{t('catalogue.generate')}</Button>
                  </div>
                  <ActionError error={gen.error} />
                </div>
                <div className="overflow-x-auto" tabIndex={0}>
                  <table className="w-full min-w-[560px] text-sm">
                    <thead><tr className="border-b border-line-soft text-left text-xs uppercase text-stone"><th className="py-2">{t('catalogue.f.sku')}</th><th className="py-2">{t('catalogue.f.variantName')}</th>{currencies.map((c) => <th key={c} className="py-2 text-right">{c}</th>)}<th className="py-2">{t('catalogue.statusCol')}</th></tr></thead>
                    <tbody>
                      {p.variants.map((v, i) => {
                        const upd = (patch: Partial<VariantRow>) => set({ variants: p.variants.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                        const locked = distributed && !v.id.startsWith('new_');
                        return (
                          <tr key={v.id || i} className="border-b border-line-soft">
                            <td className="py-2 pe-2"><Input className="h-10 w-36" value={v.sku} disabled={locked} title={locked ? t('catalogue.skuLocked') : undefined} aria-label={t('catalogue.f.sku')} onChange={(e) => upd({ sku: e.target.value })} /></td>
                            <td className="py-2 pe-2"><Input className="h-10 w-40" value={v.name} aria-label={t('catalogue.f.variantName')} onChange={(e) => upd({ name: e.target.value })} /><div className="text-xs text-stone">{Object.entries(v.options).map(([k, x]) => `${k}: ${x}`).join(' · ')}</div></td>
                            {currencies.map((c) => <td key={c} className="py-2 text-right"><MoneyInput minor={v.prices[c] ?? null} currency={c} label={`${v.name} ${c}`} onChange={(n) => { const pr = { ...v.prices }; if (n === null) delete pr[c]; else pr[c] = n; upd({ prices: pr }); }} /></td>)}
                            <td className="py-2"><Select className="h-10" value={v.status} onChange={(e) => upd({ status: e.target.value as VariantRow['status'] })}><option value="active">{t('catalogue.status.active')}</option><option value="archived">{t('catalogue.status.archived')}</option></Select></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Button size="sm" variant="secondary" icon="plus" onClick={() => set({ variants: [...p.variants, { id: `new_${p.variants.length}`, sku: `${p.sku}-${p.variants.length + 1}`, name: '', options: {}, prices: {}, barcode: null, imageUrl: null, status: 'active' }] })}>{t('catalogue.addVariant')}</Button>
                <p className="text-xs text-stone">{t('catalogue.missingPriceHint')}</p>
              </fieldset>
            )}
            {tab === 'rules' && (
              <fieldset disabled={!canEdit} className="flex flex-col gap-4">
                <div>
                  <div className="mb-1 text-sm font-bold">{t('catalogue.eligibility')}</div>
                  <Select value={p.eligibility.mode} onChange={(e) => set({ eligibility: { ...p.eligibility, mode: e.target.value as 'all' | 'selected' } })} className="h-10 max-w-xs">
                    <option value="all">{t('catalogue.eligAll')}</option><option value="selected">{t('catalogue.eligSelected')}</option>
                  </Select>
                  {p.eligibility.mode === 'selected' && (
                    <div className="mt-2 grid gap-1.5 md:grid-cols-2">
                      {app.locations.map((l) => (
                        <label key={l.id} className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-[18px] w-[18px] accent-ink" checked={p.eligibility.locationIds.includes(l.id)} onChange={(e) => set({ eligibility: { mode: 'selected', locationIds: e.target.checked ? [...p.eligibility.locationIds, l.id] : p.eligibility.locationIds.filter((x) => x !== l.id) } })} />{l.name}</label>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <div className="mb-1 text-sm font-bold">{t('catalogue.bounds')}</div>
                  <p className="mb-2 text-xs text-stone">{t('catalogue.boundsHint')}</p>
                  {currencies.map((c) => {
                    const b = p.priceBounds[c];
                    return (
                      <div key={c} className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                        <span className="w-12 font-bold">{c}</span>
                        <Toggle checked={!!b} label={t('catalogue.allowLocal')} onChange={(v) => { const nb = { ...p.priceBounds }; if (v) nb[c] = { minPct: -10, maxPct: 10 }; else delete nb[c]; set({ priceBounds: nb }); }} />
                        {b && (<>
                          <label className="flex items-center gap-1">{t('catalogue.min')}<input type="number" className="h-10 w-20 rounded-md border border-line px-2" value={b.minPct} max={0} min={-90} onChange={(e) => set({ priceBounds: { ...p.priceBounds, [c]: { ...b, minPct: Number(e.target.value) } } })} />%</label>
                          <label className="flex items-center gap-1">{t('catalogue.max')}<input type="number" className="h-10 w-20 rounded-md border border-line px-2" value={b.maxPct} min={0} max={200} onChange={(e) => set({ priceBounds: { ...p.priceBounds, [c]: { ...b, maxPct: Number(e.target.value) } } })} />%</label>
                        </>)}
                        {!b && <span className="text-xs text-stone">{t('catalogue.hqPriceLocked')}</span>}
                      </div>
                    );
                  })}
                </div>
                <Toggle checked={p.allowBackorder} onChange={(v) => set({ allowBackorder: v })} label={t('catalogue.allowBackorder')} />
                <Toggle checked={p.returnable} onChange={(v) => set({ returnable: v })} label={t('catalogue.returnable')} />
              </fieldset>
            )}
            {tab === 'content' && (
              id ? (
                <fieldset disabled={!canEdit} className="flex flex-col gap-3">
                  <p className="text-xs text-stone">{t('catalogue.translationsHint')}</p>
                  <Select value={locale} onChange={(e) => { setLocale(e.target.value); setTrName(p.translations[e.target.value]?.name ?? ''); setTrDesc(p.translations[e.target.value]?.description ?? ''); }} className="h-10 max-w-xs" aria-label={t('catalogue.locale')}>
                    {['fr', 'fr-CA', 'nl', 'de', 'es', 'pt-BR'].map((l) => <option key={l} value={l}>{l}{p.translations[l] ? ' ✓' : ''}</option>)}
                  </Select>
                  <F label={t('catalogue.f.name')}><Input value={trName} placeholder={p.translations[locale]?.name ?? p.name} onChange={(e) => setTrName(e.target.value)} /></F>
                  <F label={t('catalogue.f.description')}><Textarea rows={4} value={trDesc} placeholder={p.translations[locale]?.description ?? ''} onChange={(e) => setTrDesc(e.target.value)} /></F>
                  <ActionError error={saveTr.error} />
                  <Button variant="secondary" icon="check" loading={saveTr.pending} onClick={() => saveTr.run(trName, trDesc)}>{t('catalogue.saveTranslation', { locale })}</Button>
                  <div className="text-xs text-stone">{t('catalogue.existingTranslations')}: {Object.keys(p.translations).join(', ') || t('common.none')}</div>
                </fieldset>
              ) : <p className="text-sm text-stone">{t('catalogue.saveFirst')}</p>
            )}
            {tab === 'publish' && (
              <div className="flex flex-col gap-2 text-sm">
                <p className="text-xs text-stone">{t('catalogue.publishHint', { version: p.contentVersion })}</p>
                {stores.map((s) => {
                  const l = p.listings.find((x) => x.locationId === s.id);
                  return (
                    <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised px-3 py-2">
                      <span className="font-semibold">{s.name}</span>
                      {!l ? <Badge tone="neutral">{t('catalogue.notListed')}</Badge> : l.status !== 'listed' ? <Badge tone="neutral">{t('catalogue.delisted')}</Badge> : l.upToDate ? <Badge tone="success">{t('catalogue.upToDate', { v: l.contentVersion })}</Badge> : <Badge tone="warning">{t('catalogue.pending', { v: l.contentVersion })}</Badge>}
                      {l && !l.upToDate && l.pendingChanges.length > 0 && <span className="text-xs text-stone">{l.pendingChanges.join(' · ')}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </View>
    </Drawer>
  );
}

function DistributionPanel({ productIds, onClose, onDone }: { productIds: string[]; onClose: () => void; onDone: () => void }) {
  const t = useCt();
  const stores = useScopeStores();
  const [locIds, setLocIds] = useState<string[]>(stores.map((s) => s.id));
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [result, setResult] = useState<Distribution | null>(null);
  const preview = useAction(async () => { const r = await call<{ items: PlanItem[] }>('POST', '/distributions/preview', { productIds, locationIds: locIds }); setPlan(r.items); return r; });
  const run = useAction(async () => { const r = await call<Distribution>('POST', '/distributions', { productIds, locationIds: locIds }); setResult(r); onDone(); return r; });
  const retry = useAction(async () => { const r = await call<Distribution>('POST', `/distributions/${result!.id}/retry`); setResult(r); onDone(); return r; });
  const counts = useMemo(() => plan && { ready: plan.filter((p) => p.status === 'ready').length, skipped: plan.filter((p) => p.status === 'skipped').length, blocked: plan.filter((p) => p.status === 'blocked').length, resets: plan.reduce((a, p) => a + p.overridesOutOfBounds.length, 0) }, [plan]);

  return (
    <Drawer open onClose={onClose} kicker={t('dist.kicker')} title={t('dist.title', { n: productIds.length })}>
      <div className="flex flex-col gap-4 text-sm">
        {!result && (
          <>
            <div>
              <div className="mb-1 font-bold">{t('dist.stores')}</div>
              <div className="grid gap-1.5 md:grid-cols-2">
                {stores.map((l) => <label key={l.id} className="flex items-center gap-2"><input type="checkbox" className="h-[18px] w-[18px] accent-ink" checked={locIds.includes(l.id)} onChange={(e) => { setPlan(null); setLocIds((s) => (e.target.checked ? [...s, l.id] : s.filter((x) => x !== l.id))); }} />{l.name} · {l.currency}</label>)}
              </div>
            </div>
            <Button variant="secondary" icon="eye" disabled={!locIds.length} loading={preview.pending} onClick={() => preview.run()}>{t('dist.preview')}</Button>
            <ActionError error={preview.error} />
            {plan && counts && (
              <>
                <Banner tone={counts.blocked ? 'warning' : 'info'} title={t('dist.consequence')}>{t('dist.counts', counts)}</Banner>
                <ul className="flex flex-col gap-1.5">
                  {plan.map((i) => (
                    <li key={`${i.locationId}:${i.productId}`} className="rounded-md bg-canvas-raised px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2"><StatusBadge kind="result" value={i.status} /><strong>{i.productName}</strong><span className="text-stone">→ {i.locationName}</span><Badge tone="neutral">{t(`dist.action.${i.action}`)}</Badge></div>
                      {i.message && <div className="text-xs text-stone">{i.message}</div>}
                      {i.changes.length > 0 && <div className="text-xs">{i.changes.join(' · ')}</div>}
                      {i.overridesOutOfBounds.map((o) => <div key={o.variantId} className="text-xs font-semibold text-warning">{t('dist.reset', { variant: o.variantName })} <Money m={{ amount: o.priceMinor, currency: i.currency }} /></div>)}
                    </li>
                  ))}
                </ul>
                <Button icon="send" disabled={!counts.ready} loading={run.pending} onClick={() => run.run()}>{t('dist.confirm', { n: counts.ready })}</Button>
                <ActionError error={run.error} />
              </>
            )}
          </>
        )}
        {result && (
          <>
            <Banner tone={result.status === 'completed' ? 'success' : result.status === 'partial' ? 'warning' : 'danger'} live="polite" title={t(`catalogue.distStatus.${result.status}`)}>{t('catalogue.summary', result.summary)}</Banner>
            <ul className="flex flex-col gap-1.5">
              {(result.results ?? []).map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised px-3 py-2">
                  <StatusBadge kind="result" value={r.status} /><strong>{r.productName}</strong><span className="text-stone">→ {r.locationName}</span>{r.message && <span className="text-xs text-stone">{r.message}</span>}
                </li>
              ))}
            </ul>
            {result.summary.failed > 0 && <Button variant="secondary" icon="refresh" loading={retry.pending} onClick={() => retry.run()}>{t('dist.retry')}</Button>}
            <ActionError error={retry.error} />
          </>
        )}
      </div>
    </Drawer>
  );
}

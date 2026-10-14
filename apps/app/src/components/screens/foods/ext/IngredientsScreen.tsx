'use client';

import { useState } from 'react';
import { Badge, Button, Toggle, cx } from '@bh/ui';
import type { Ingredient } from '@/lib/foods/types';
import { useFoods, useFoodsMutation } from '@/lib/foods/useFoods';
import { useApp } from '../../../shell/AppContext';
import { PageHeader } from '../../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../../ui/States';
import { ErrorLine, Labeled, LocationSelect, NoLocations, Section, inputCls, useFx, useLocationPick } from './common';

/** Basic ingredient inventory: stock per location, receive/waste/count, low-stock alerts, auto sold-out and recipes. */
export function IngredientsScreen() {
  const t = useFx();
  const app = useApp();
  const pick = useLocationPick();
  const lid = pick.locationId;
  const res = useFoods((api) => api.ingredients(lid), [lid], !!lid);
  const builder = useFoods((api) => api.builder(), [app.org.id]);
  const move = useFoodsMutation((api, id: string, reason: 'receive' | 'waste' | 'count', quantity: number) => api.movement(lid, id, { reason, quantity }));
  const setStock = useFoodsMutation(async (api, id: string, body: { lowStockThreshold?: number; autoSoldOut?: boolean }) => { await api.setStock(lid, id, body); return true; });
  const create = useFoodsMutation((api, body: { name: string; unit: 'g' | 'ml' | 'each' }) => api.createIngredient(body));
  const [msg, setMsg] = useState('');
  const [newIng, setNewIng] = useState<{ name: string; unit: 'g' | 'ml' | 'each' }>({ name: '', unit: 'g' });
  const canWrite = app.can('operations.write');
  if (!pick.loc) return <NoLocations />;
  return (
    <>
      <PageHeader icon="box" title={t('ing.title')} description={t('ing.description')} />
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-4 py-3"><LocationSelect pick={pick} /></div>
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      <ErrorLine error={move.error ?? setStock.error ?? create.error} />
      <Async res={res} loading={<LoadingBlock variant="table" />}>
        {(list) => (
          <>
            {list.some((i) => i.stock?.lowStock) && <Banner tone="warning" title={t('ing.lowStockTitle')}>{list.filter((i) => i.stock?.lowStock).map((i) => `${i.name} (${i.stock!.onHand} ${i.unit})`).join(', ')}</Banner>}
            <Section title={t('ing.stock')}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead><tr className="text-left text-xs uppercase text-stone"><th className="p-2">{t('ing.ingredient')}</th><th className="p-2">{t('ing.onHand')}</th><th className="p-2">{t('ing.threshold')}</th><th className="p-2">{t('ing.autoSoldOut')}</th><th className="p-2">{t('ing.usedBy')}</th><th className="p-2">{t('ing.adjust')}</th></tr></thead>
                  <tbody>{list.map((i) => <Row key={i.id} i={i} canWrite={canWrite} onMove={async (r, q) => { const x = await move.run(i.id, r, q); if (x) { setMsg(x.soldOutItems.length ? t('ing.nowSoldOut', { name: i.name }) : t('ing.recorded', { name: i.name, n: x.onHand, unit: i.unit })); res.reload(); } }} onStock={async (b) => { if (await setStock.run(i.id, b)) res.reload(); }} />)}</tbody>
                </table>
              </div>
            </Section>
          </>
        )}
      </Async>
      {app.can('templates.write') && (
        <Section title={t('ing.catalogue')}>
          <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (await create.run(newIng)) { setNewIng({ name: '', unit: 'g' }); res.reload(); } }}>
            <Labeled label={t('ing.name')}><input required value={newIng.name} onChange={(e) => setNewIng({ ...newIng, name: e.target.value })} className={inputCls} /></Labeled>
            <Labeled label={t('ing.unit')}><select value={newIng.unit} onChange={(e) => setNewIng({ ...newIng, unit: e.target.value as 'g' })} className={inputCls}><option value="g">g</option><option value="ml">ml</option><option value="each">{t('ing.each')}</option></select></Labeled>
            <Button type="submit" icon="plus" loading={create.pending}>{t('common.add')}</Button>
          </form>
          {builder.data && res.data && <RecipeEditor items={builder.data.menus.flatMap((m) => m.items).filter((x) => x.active)} ingredients={res.data} onSaved={res.reload} />}
        </Section>
      )}
    </>
  );
}

function Row({ i, canWrite, onMove, onStock }: { i: Ingredient; canWrite: boolean; onMove: (r: 'receive' | 'waste' | 'count', q: number) => void; onStock: (b: { lowStockThreshold?: number; autoSoldOut?: boolean }) => void }) {
  const t = useFx();
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<'receive' | 'waste' | 'count'>('receive');
  return (
    <tr className="border-t border-line-soft align-top">
      <td className="p-2 font-bold">{i.name}<div className="text-xs font-normal text-stone">{i.sku}</div></td>
      <td className="p-2">{i.stock ? <span className="flex flex-col gap-1"><span className="tabular">{i.stock.onHand} {i.unit}</span>{i.stock.exhausted ? <Badge tone="danger">{t('ing.exhausted')}</Badge> : i.stock.lowStock ? <Badge tone="warning">{t('ing.low')}</Badge> : null}</span> : <span className="text-stone">{t('ing.notTracked')}</span>}</td>
      <td className="p-2"><input aria-label={t('ing.thresholdOf', { name: i.name })} disabled={!canWrite} defaultValue={i.stock?.lowStockThreshold ?? ''} inputMode="numeric" className={cx(inputCls, 'w-24')} onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== (i.stock?.lowStockThreshold ?? -1)) onStock({ lowStockThreshold: v }); }} /></td>
      <td className="p-2"><Toggle checked={!!i.stock?.autoSoldOut} label={t('ing.autoSoldOutOf', { name: i.name })} onChange={(v) => canWrite && onStock({ autoSoldOut: v })} /></td>
      <td className="p-2 text-xs">{i.usedBy.map((u) => `${u.name} (${u.quantity} ${i.unit}${u.viaModifier ? `, ${t('ing.option')}` : ''})`).join('; ') || '—'}</td>
      <td className="p-2">
        {canWrite && (
          <form className="flex flex-wrap gap-1" onSubmit={(e) => { e.preventDefault(); const q = Number(qty); if (Number.isFinite(q) && q >= 0) { onMove(reason, q); setQty(''); } }}>
            <select aria-label={t('ing.reason')} value={reason} onChange={(e) => setReason(e.target.value as 'receive')} className={cx(inputCls, 'w-28')}><option value="receive">{t('ing.receive')}</option><option value="waste">{t('ing.waste')}</option><option value="count">{t('ing.count')}</option></select>
            <input aria-label={t('ing.quantity')} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className={cx(inputCls, 'w-24')} />
            <Button type="submit" size="sm" variant="secondary">{t('ing.record')}</Button>
          </form>
        )}
      </td>
    </tr>
  );
}

function RecipeEditor({ items, ingredients, onSaved }: { items: Array<{ id: string; name: string }>; ingredients: Ingredient[]; onSaved: () => void }) {
  const t = useFx();
  const [itemId, setItemId] = useState(items[0]?.id ?? '');
  const recipe = useFoods((api) => api.recipe(itemId), [itemId], !!itemId);
  const save = useFoodsMutation(async (api, lines: Array<{ ingredientId: string; quantity: number }>) => { await api.saveRecipe(itemId, lines); return true; });
  const [ing, setIng] = useState(ingredients[0]?.id ?? '');
  const [qty, setQty] = useState('');
  return (
    <div className="mt-4 rounded-lg border border-line-soft p-3">
      <h3 className="font-bold">{t('ing.recipes')}</h3>
      <p className="mb-2 text-xs text-stone">{t('ing.recipesHint')}</p>
      <select aria-label={t('ing.menuItem')} value={itemId} onChange={(e) => setItemId(e.target.value)} className={cx(inputCls, 'max-w-sm')}>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
      <Async res={recipe} loading={<LoadingBlock variant="table" rows={1} />}>
        {(lines) => (
          <>
            <ul className="mt-2 flex flex-wrap gap-2 text-sm">{lines.map((l) => <li key={l.ingredientId + (l.modifierId ?? '')} className="rounded-full bg-canvas px-3 py-1">{l.quantity} {l.unit} {l.name}{l.modifierId ? ` (${t('ing.option')})` : ''}</li>)}{!lines.length && <li className="text-stone">{t('ing.noRecipe')}</li>}</ul>
            <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); const q = Number(qty); if (!q) return; const next = [...lines.filter((l) => l.ingredientId !== ing || l.modifierId).map((l) => ({ ingredientId: l.ingredientId, quantity: l.quantity, modifierId: l.modifierId })), { ingredientId: ing, quantity: q }]; if (await save.run(next)) { setQty(''); recipe.reload(); onSaved(); } }}>
              <select aria-label={t('ing.ingredient')} value={ing} onChange={(e) => setIng(e.target.value)} className={cx(inputCls, 'w-48')}>{ingredients.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}</select>
              <input aria-label={t('ing.perPortion')} placeholder={t('ing.perPortion')} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className={cx(inputCls, 'w-32')} />
              <Button type="submit" size="sm" icon="plus" loading={save.pending}>{t('ing.setLine')}</Button>
            </form>
            <ErrorLine error={save.error} />
          </>
        )}
      </Async>
    </div>
  );
}

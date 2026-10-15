'use client';

import { useState } from 'react';
import { Badge, Button, Toggle } from '@bh/ui';
import { cx as call, useAction, useCommerce } from '@/lib/commerce/client';
import type { AssortmentItem, AssortmentVariant } from '@/lib/commerce/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, SectionCard } from '../../ui/States';
import { ActionError, Money, MoneyInput, NumberInput, StorePicker, View, useCt, useStore } from './kit';

/** Local assortment: prices inside HQ ranges (origin shown, reset to HQ), availability, reorder settings, stock. */
export function AssortmentScreen() {
  const t = useCt();
  const app = useApp();
  const [loc, setLoc] = useStore();
  const res = useCommerce(() => call<{ location: { id: string; name: string; currency: string }; items: AssortmentItem[] }>('GET', `/locations/${loc}/assortment`), [loc], !!loc);
  const manager = app.can('locations.read') && app.can('operations.write');
  const reset = useAction(async () => { const r = await call<{ reset: number; items: AssortmentItem[] }>('POST', `/locations/${loc}/assortment/reset`, {}); if (res.data) res.setData({ ...res.data, items: r.items }); return r; });
  const local = res.data?.items.flatMap((i) => i.variants).filter((v) => v.priceOrigin === 'local').length ?? 0;

  return (
    <>
      <PageHeader icon="store" title={t('assortment.title')} description={t('assortment.description')} actions={<StorePicker value={loc} onChange={setLoc} />} />
      {!manager && <Banner tone="neutral" icon="lock">{t('assortment.staffNote')}</Banner>}
      <SectionCard aside={manager && local > 0 && <Button size="sm" variant="secondary" icon="undo" loading={reset.pending} onClick={() => reset.run()}>{t('assortment.resetAll', { n: local })}</Button>}>
        <ActionError error={reset.error} />
        <View res={res} isEmpty={(d) => !d.items.length} empty={<Empty icon="store" title={t('assortment.empty')} body={t('assortment.emptyBody')} />}>
          {(d) => (
            <div className="flex flex-col gap-4">
              {d.items.map((p) => (
                <div key={p.productId} className="rounded-lg border border-line-soft">
                  <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2.5">
                    <strong>{p.productName}</strong><span className="text-xs text-stone">{p.sku}</span>
                    {p.listingStatus !== 'listed' && <Badge tone="neutral">{t('assortment.delisted')}</Badge>}
                    {p.updateAvailable && <Badge tone="warning">{t('assortment.updateAvailable', { from: p.distributedVersion, to: p.masterVersion })}</Badge>}
                    <span className="ms-auto text-xs text-stone">{t('assortment.locked')}</span>
                  </div>
                  <div className="overflow-x-auto" tabIndex={0}>
                    <table className="w-full min-w-[760px] text-sm">
                      <thead><tr className="text-left text-xs uppercase text-stone"><th className="px-4 py-2">{t('assortment.variant')}</th><th className="py-2">{t('assortment.price')}</th><th className="py-2">{t('assortment.availability')}</th><th className="py-2 text-right">{t('assortment.stock')}</th><th className="py-2 pe-4 text-right">{t('assortment.reorder')}</th></tr></thead>
                      <tbody>{p.variants.map((v) => <Row key={v.variantId} loc={loc} v={v} manager={manager} onSaved={(nv) => res.setData({ ...d, items: d.items.map((i) => (i.productId === p.productId ? { ...i, variants: i.variants.map((x) => (x.variantId === nv.variantId ? nv : x)) } : i)) })} />)}</tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </View>
      </SectionCard>
    </>
  );
}

function Row({ loc, v, manager, onSaved }: { loc: string; v: AssortmentVariant; manager: boolean; onSaved: (v: AssortmentVariant) => void }) {
  const t = useCt();
  const [price, setPrice] = useState<number | null>(v.localPrice?.amount ?? null);
  const [point, setPoint] = useState(v.reorderPoint ?? NaN);
  const save = useAction(async (body: Record<string, unknown>) => { const r = await call<AssortmentVariant>('PUT', `/locations/${loc}/assortment/${v.variantId}`, body); onSaved(r); setPrice(r.localPrice?.amount ?? null); return r; });
  const currency = v.hqPrice?.currency ?? v.effectivePrice?.currency ?? 'USD';
  return (
    <tr className="border-t border-line-soft align-top">
      <td className="px-4 py-3"><div className="font-semibold">{v.name}</div><div className="text-xs text-stone">{v.sku}</div></td>
      <td className="py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Money m={v.effectivePrice} className="font-bold" />
          <Badge tone={v.priceOrigin === 'local' ? 'info' : 'neutral'}>{v.priceOrigin === 'local' ? t('assortment.originLocal') : t('assortment.originHq')}</Badge>
        </div>
        <div className="text-xs text-stone">{t('assortment.hq')} <Money m={v.hqPrice} />{v.priceSetBy && v.priceOrigin === 'local' ? ` · ${t('assortment.setBy', { name: v.priceSetBy })}` : ''}</div>
        {v.bounds ? (
          <div className="text-xs text-stone">{t('assortment.range')} <Money m={v.bounds.min} /> – <Money m={v.bounds.max} /></div>
        ) : <div className="text-xs text-stone">{t('assortment.noRange')}</div>}
        {manager && v.bounds && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <MoneyInput minor={price} currency={currency} label={t('assortment.localPrice', { name: v.name })} onChange={setPrice} />
            <Button size="sm" variant="secondary" loading={save.pending} disabled={price === null || price === v.localPrice?.amount} onClick={() => save.run({ priceMinor: price })}>{t('common.save')}</Button>
            {v.priceOrigin === 'local' && <Button size="sm" variant="ghost" icon="undo" onClick={() => save.run({ priceMinor: null })}>{t('assortment.resetHq')}</Button>}
          </div>
        )}
        <ActionError error={save.error} />
      </td>
      <td className="py-3">
        <Toggle checked={v.available} onChange={(x) => save.run({ available: x })} label={v.available ? t('assortment.sellable') : t('assortment.hidden')} />
      </td>
      <td className="py-3 text-right tabular">
        <div className="font-bold">{v.availableQty} <span className="text-xs font-normal text-stone">{t('assortment.free')}</span></div>
        <div className="text-xs text-stone">{t('assortment.onHandReserved', { onHand: v.onHand, reserved: v.reserved })}</div>
        {v.inTransit > 0 && <div className="text-xs font-bold text-info">{t('assortment.inTransit', { n: v.inTransit })}</div>}
      </td>
      <td className="py-3 pe-4 text-right">
        {manager ? (
          <span className="inline-flex items-center gap-1.5">
            <NumberInput value={point} onChange={setPoint} label={t('assortment.reorderPoint')} />
            <Button size="sm" variant="ghost" icon="check" aria-label={t('common.save')} disabled={Number.isNaN(point) || point === v.reorderPoint} onClick={() => save.run({ reorderPoint: point })} />
          </span>
        ) : <span>{v.reorderPoint ?? '—'}</span>}
      </td>
    </tr>
  );
}

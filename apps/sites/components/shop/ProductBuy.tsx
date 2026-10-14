'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { money } from '@/lib/format';
import { readCart, writeCart, type ShopProduct, type Storefront } from '@/lib/shop';

/** Variant selection by option, this store's price and stock band, add to cart, sibling-store availability. */
export function ProductBuy({ product, storefront, cartHref, otherStoreHref }: { product: ShopProduct; storefront: Storefront; cartHref: string; otherStoreHref: Record<string, string> }) {
  const t = useTranslations('storefront');
  const ts = useTranslations('shop');
  const locale = useLocale();
  const sellable = product.variants.filter((v) => v.availability !== 'not_stocked');
  const [sel, setSel] = useState<Record<string, string>>(sellable[0]?.options ?? {});
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const variant = useMemo(() => (product.options.length ? sellable.find((v) => product.options.every((o) => v.options[o.name] === sel[o.name])) : sellable[0]) ?? null, [sel, product, sellable]);
  const label: Record<string, string> = { in_stock: ts('inStock'), low_stock: ts('lowStock'), out_of_stock: ts('outOfStock'), backorder: t('backorder'), not_stocked: t('notHere') };
  const canBuy = storefront.checkout.mode === 'native' && !!variant && !!variant.price && ['in_stock', 'low_stock', 'backorder'].includes(variant.availability);

  return (
    <div className="mt-5 flex flex-col gap-4">
      {product.options.map((o) => (
        <fieldset key={o.name}>
          <legend className="mb-1.5 text-sm font-bold">{o.name}</legend>
          <div className="flex flex-wrap gap-2">
            {o.values.map((val) => {
              const exists = sellable.some((v) => v.options[o.name] === val);
              const on = sel[o.name] === val;
              return (
                <label key={val} className={`flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm font-semibold ${on ? 'border-ink bg-ink text-white' : 'border-line bg-white'} ${exists ? '' : 'opacity-40'}`}>
                  <input type="radio" name={o.name} value={val} className="sr-only" disabled={!exists} checked={on} onChange={() => { setSel({ ...sel, [o.name]: val }); setAdded(false); }} />{val}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div aria-live="polite" className="flex flex-wrap items-baseline gap-3">
        <span className="text-2xl font-extrabold tabular">{variant?.price ? money(variant.price, locale) : ''}</span>
        {variant ? <span className={variant.availability === 'out_of_stock' ? 'font-semibold text-danger' : variant.availability === 'backorder' ? 'font-semibold text-warning' : 'font-semibold text-success'}>{label[variant.availability]} · {storefront.location.name}</span> : <span className="text-graphite">{t('combinationUnavailable')}</span>}
      </div>
      {storefront.taxes.some((x) => x.inclusive) && <p className="text-xs text-graphite">{t('pricesInclude', { list: storefront.taxes.filter((x) => x.inclusive).map((x) => `${x.name} ${x.rateBps / 100}%`).join(', ') })}</p>}
      {storefront.checkout.mode === 'native' ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-semibold">{t('quantity')}
            <select className="field w-20" value={qty} onChange={(e) => setQty(Number(e.target.value))}>{Array.from({ length: 10 }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select>
          </label>
          <button type="button" className="btn btn-primary" disabled={!canBuy} onClick={() => {
            if (!variant) return;
            const cart = readCart(storefront.location.id);
            const ex = cart.find((l) => l.variantId === variant.id);
            const next = ex ? cart.map((l) => (l.variantId === variant.id ? { ...l, quantity: Math.min(99, l.quantity + qty) } : l)) : [...cart, { variantId: variant.id, productId: product.id, productSlug: product.slug, name: product.name, variantName: variant.name, quantity: qty, unit: variant.price, image: product.image }];
            writeCart(storefront.location.id, next);
            setAdded(true);
          }}><Icon name="cart" size={18} />{t('addToCart')}</button>
          {added && <a href={cartHref} className="link font-semibold" role="status">{t('addedViewCart')}</a>}
        </div>
      ) : storefront.checkout.url ? (
        <a href={storefront.checkout.url} rel="noopener" className="btn btn-primary self-start">{ts('buyOn', { provider: storefront.checkout.provider ?? '' })}<Icon name="arrow-up-right" size={16} /></a>
      ) : <p className="text-graphite">{ts('noCheckout')}</p>}
      {(product.otherStores ?? []).length > 0 && (
        <section aria-labelledby="also-at" className="rounded-2xl bg-canvas p-4 text-sm">
          <h2 id="also-at" className="font-bold">{t('alsoAt')}</h2>
          <ul className="mt-1 space-y-1">
            {product.otherStores!.map((o) => {
              const band = variant ? o.variants.find((v) => v.id === variant.id)?.availability ?? 'not_stocked' : 'not_stocked';
              return <li key={o.id} className="flex flex-wrap justify-between gap-2"><a className="link" href={otherStoreHref[o.id]}>{o.name}</a><span>{label[band]}{o.sameCurrency && storefront.fulfilment.collectAt.some((c) => c.id === o.id) ? '' : ''}</span></li>;
            })}
          </ul>
          {storefront.fulfilment.collectAt.length > 0 && <p className="mt-2 text-xs text-graphite">{t('collectElsewhere', { stores: storefront.fulfilment.collectAt.map((c) => c.name).join(', ') })}</p>}
        </section>
      )}
    </div>
  );
}

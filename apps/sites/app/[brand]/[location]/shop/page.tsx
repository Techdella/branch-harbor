import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { CartLink } from '@/components/shop/CartLink';
import { apiGet } from '@/lib/api';
import { money } from '@/lib/format';
import { providerName } from '@/lib/modules';
import type { ShopProduct, Storefront } from '@/lib/shop';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string }>; searchParams: Promise<{ collection?: string; q?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('shop');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('title')} · ${data.brand.name} ${data.location.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/shop') } };
}

/** Storefront: collections, search and products with this store's price and stock. Link-out when an external store is authoritative. */
export default async function Shop({ params, searchParams }: Props) {
  const { brand, location } = await params;
  const sp = await searchParams;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'commerce') notFound();
  const t = await getTranslations('shop');
  const ts = await getTranslations('storefront');
  const locale = await getLocale();
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  const base = `/v1/public/commerce/${encodeURIComponent(brand)}/${encodeURIComponent(location)}`;
  const qs = new URLSearchParams({ locale, ...(sp.collection ? { collection: sp.collection } : {}), ...(sp.q ? { q: sp.q } : {}) });
  const [sf, res] = await Promise.all([apiGet<Storefront>(`${base}/storefront?locale=${encodeURIComponent(locale)}`), apiGet<{ items: ShopProduct[] }>(`${base}/products?${qs}`)]);
  const label: Record<string, string> = { in_stock: t('inStock'), low_stock: t('lowStock'), out_of_stock: t('outOfStock'), backorder: ts('backorder'), not_stocked: t('outOfStock') };
  const prov = providerName(sf.checkout.provider);
  const shopPath = (p = '') => links.location(location, `/shop${p}`);
  const native = sf.checkout.mode === 'native';

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">{t('title')}</h1>
          <p className="mt-1 flex items-center gap-1.5 text-graphite"><Icon name="box" size={16} />{t('stockFor', { location: data.location.name })} {sf.checkout.mode === 'external' ? t('checkoutExternal', { provider: prov }) : sf.checkout.mode === 'disabled' ? t('noCheckout') : ts('fulfilmentSummary', { pickup: sf.fulfilment.pickup.enabled ? 'yes' : 'no', delivery: sf.fulfilment.localDelivery.enabled ? 'yes' : 'no', shipping: sf.fulfilment.shipping.enabled ? 'yes' : 'no' })}</p>
        </div>
        {native && (
          <div className="flex items-center gap-2">
            <a href={shopPath('/account')} className="btn btn-secondary h-10 min-h-10 text-sm"><Icon name="user" size={16} />{ts('account')}</a>
            <CartLink locationId={sf.location.id} href={shopPath('/cart')} />
          </div>
        )}
      </div>
      {sf.checkout.mode === 'external' && sf.checkout.url && (
        <div className="card mt-4 flex flex-wrap items-center justify-between gap-3 p-4"><p>{ts('externalNote', { provider: prov })}</p><a href={sf.checkout.url} rel="noopener" className="btn btn-primary">{t('buyOn', { provider: prov })}<Icon name="arrow-up-right" size={16} /></a></div>
      )}
      <form className="mt-6 flex flex-wrap items-center gap-2" role="search" action={shopPath()}>
        <label htmlFor="shop-q" className="sr-only">{ts('search')}</label>
        <input id="shop-q" name="q" defaultValue={sp.q ?? ''} className="field max-w-xs" placeholder={ts('search')} />
        <button className="btn btn-secondary" type="submit"><Icon name="search" size={16} />{ts('searchCta')}</button>
      </form>
      {sf.collections.length > 0 && (
        <nav aria-label={ts('collections')} className="mt-4 flex flex-wrap gap-2 text-sm font-semibold">
          <a href={shopPath()} aria-current={!sp.collection ? 'page' : undefined} className={`rounded-full px-3 py-1.5 ${!sp.collection ? 'bg-ink text-white' : 'bg-canvas'}`}>{ts('all')}</a>
          {sf.collections.map((c) => <a key={c.id} href={`${shopPath()}?collection=${encodeURIComponent(c.slug)}`} aria-current={sp.collection === c.slug ? 'page' : undefined} className={`rounded-full px-3 py-1.5 ${sp.collection === c.slug ? 'bg-ink text-white' : 'bg-canvas'}`}>{c.title}</a>)}
        </nav>
      )}
      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {res.items.map((p) => (
          <li key={p.id} className="card flex flex-col overflow-hidden">
            {p.image && /^https:\/\//.test(p.image) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.image} alt="" className="aspect-[4/3] w-full object-cover" loading="lazy" />
            )}
            <div className="flex flex-1 flex-col p-4">
              <h2 className="font-bold"><a href={shopPath(`/p/${p.slug ?? p.id}`)} className="hover:underline">{p.name}</a></h2>
              {p.description && <p className="mt-1 line-clamp-2 text-sm text-graphite">{p.description}</p>}
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3 text-sm">
                <span className="font-semibold tabular">{p.priceFrom ? (p.priceVaries ? ts('from', { price: money(p.priceFrom, locale) }) : money(p.priceFrom, locale)) : ''}</span>
                <span className={p.availability === 'out_of_stock' ? 'text-danger' : p.availability === 'backorder' ? 'text-warning' : 'text-success'}>{p.availability === 'in_stock' ? t('inStock') : label[p.availability]}</span>
              </div>
              {sf.checkout.mode === 'external' && (
                <ul className="mt-2 space-y-1 text-xs text-graphite">{p.variants.filter((v) => v.availability !== 'not_stocked').map((v) => <li key={v.id} className="flex justify-between gap-2"><span>{v.name}</span><span>{label[v.availability]}</span></li>)}</ul>
              )}
            </div>
          </li>
        ))}
        {!res.items.length && <li className="card p-6 text-graphite sm:col-span-2 lg:col-span-3">{sp.q || sp.collection ? ts('noResults') : t('noProducts')}</li>}
      </ul>
      {native && <p className="mt-6 text-xs text-graphite">{sf.taxConfigured ? ts('taxNote', { list: sf.taxes.map((x) => `${x.name} ${x.rateBps / 100}%${x.inclusive ? ` (${ts('included')})` : ''}`).join(', ') }) : ts('noTaxConfigured')}</p>}
    </main>
  );
}

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { CartLink } from '@/components/shop/CartLink';
import { ProductBuy } from '@/components/shop/ProductBuy';
import { apiGet, isNotFound } from '@/lib/api';
import type { ShopProduct, Storefront } from '@/lib/shop';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string; product: string }> };

async function load(brand: string, location: string, product: string, locale: string) {
  try {
    return await apiGet<ShopProduct>(`/v1/public/commerce/${encodeURIComponent(brand)}/${encodeURIComponent(location)}/products/${encodeURIComponent(product)}?locale=${encodeURIComponent(locale)}`);
  } catch (err) {
    if (isNotFound(err)) notFound();
    throw err;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location, product } = await params;
  const data = await loadLocation(brand, location);
  const p = await load(brand, location, product, await getLocale());
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${p.name} · ${data.brand.name} ${data.location.name}`, description: p.description ?? undefined, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, `/shop/p/${p.slug ?? p.id}`) } };
}

/** Product page: variant matrix with this store's price and stock band; availability at sibling stores. */
export default async function ProductPage({ params }: Props) {
  const { brand, location, product } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'commerce') notFound();
  const locale = await getLocale();
  const t = await getTranslations('storefront');
  const p = await load(brand, location, product, locale);
  const sf = await apiGet<Storefront>(`/v1/public/commerce/${encodeURIComponent(brand)}/${encodeURIComponent(location)}/storefront`);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  const img = p.images.find((i) => /^https:\/\//.test(i.url));
  const jsonLd = { '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: p.description ?? undefined, image: img?.url, sku: p.variants[0]?.sku, brand: { '@type': 'Brand', name: data.brand.name } };
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <nav className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm"><a href={links.location(location, '/shop')} className="link">← {t('backToShop')}</a>{sf.checkout.mode === 'native' && <CartLink locationId={sf.location.id} href={links.location(location, '/shop/cart')} />}</nav>
      <div className="grid gap-8 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={img.url} alt={img.alt || p.name} className="aspect-square w-full rounded-3xl object-cover" />
          ) : <div className="aspect-square w-full rounded-3xl bg-canvas" />}
        </div>
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">{p.name}</h1>
          {p.vendor && <p className="text-sm text-graphite">{p.vendor}</p>}
          {p.description && <p className="mt-3 text-graphite">{p.description}</p>}
          <ProductBuy product={p} storefront={sf} cartHref={links.location(location, '/shop/cart')} otherStoreHref={Object.fromEntries((p.otherStores ?? []).map((o) => [o.id, links.location(o.slug, `/shop/p/${p.slug ?? p.id}`)]))} />
          {Object.keys(p.specs).length > 0 && (
            <section className="mt-6"><h2 className="text-lg font-bold">{t('details')}</h2>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">{Object.entries(p.specs).map(([k, v]) => <div key={k} className="contents"><dt className="font-semibold">{k}</dt><dd className="text-graphite">{v}</dd></div>)}</dl>
            </section>
          )}
          <p className="mt-4 text-xs text-graphite">{p.returnable ? t('returnable', { days: sf.returnWindowDays }) : t('finalSale')}</p>
        </div>
      </div>
    </main>
  );
}

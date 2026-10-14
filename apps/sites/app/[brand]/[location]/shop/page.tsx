import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { apiGet } from '@/lib/api';
import { money } from '@/lib/format';
import { providerName } from '@/lib/modules';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';
import type { Product } from '@/lib/types';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('shop');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('title')} · ${data.brand.name} ${data.location.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/shop') } };
}

/** Product listing with this store's availability. No native checkout: an external store (e.g. WooCommerce) stays authoritative. */
export default async function Shop({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'commerce') notFound();
  const t = await getTranslations('shop');
  const locale = await getLocale();
  const res = await apiGet<{ checkout: { mode: 'external' | 'none'; provider: string | null; url: string | null }; items: Product[] }>(`/v1/public/sites/${encodeURIComponent(brand)}/${encodeURIComponent(location)}/products`);
  const label = { in_stock: t('inStock'), low_stock: t('lowStock'), out_of_stock: t('outOfStock'), not_stocked: t('outOfStock') };
  const prov = providerName(res.checkout.provider);
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('title')}</h1>
      <p className="mt-1 flex items-center gap-1.5 text-graphite"><Icon name="box" size={16} />{t('stockFor', { location: data.location.name })} {res.checkout.mode === 'external' ? t('checkoutExternal', { provider: prov }) : t('noCheckout')}</p>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {res.items.map((p) => (
          <li key={p.id} className="card overflow-hidden">
            {p.image && /^https:\/\//.test(p.image) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.image} alt="" className="aspect-[4/3] w-full object-cover" />
            )}
            <div className="p-4">
              <h2 className="font-bold">{p.name}</h2>
              {p.description && <p className="mt-1 text-sm text-graphite">{p.description}</p>}
              <ul className="mt-3 space-y-1 text-sm">
                {p.variants.filter((v) => v.availability !== 'not_stocked').map((v) => (
                  <li key={v.id} className="flex justify-between gap-2">
                    <span>{v.name}</span>
                    <span className="text-end"><span className="font-semibold tabular">{money(v.price, locale)}</span> · <span className={v.availability === 'out_of_stock' ? 'text-danger' : v.availability === 'low_stock' ? 'text-warning' : 'text-success'}>{label[v.availability]}</span></span>
                  </li>
                ))}
              </ul>
              {res.checkout.url && <a href={res.checkout.url} rel="noopener" className="btn btn-secondary mt-4 h-10 min-h-10 text-sm">{t('buyOn', { provider: prov })}<Icon name="arrow-up-right" size={14} /></a>}
            </div>
          </li>
        ))}
        {!res.items.length && <li className="card p-6 text-graphite sm:col-span-2 lg:col-span-3">{t('noProducts')}</li>}
      </ul>
    </main>
  );
}

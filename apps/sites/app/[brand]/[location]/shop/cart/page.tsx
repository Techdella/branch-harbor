import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Checkout } from '@/components/shop/Checkout';
import { apiGet } from '@/lib/api';
import type { Storefront } from '@/lib/shop';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function CartPage({ params }: { params: Promise<{ brand: string; location: string }> }) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'commerce') notFound();
  const t = await getTranslations('storefront');
  const sf = await apiGet<Storefront>(`/v1/public/commerce/${encodeURIComponent(brand)}/${encodeURIComponent(location)}/storefront`);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-10">
      <a href={links.location(location, '/shop')} className="link text-sm"><span aria-hidden className="inline-block rtl:-scale-x-100">←</span> {t('backToShop')}</a>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{t('cartTitle')}</h1>
      <p className="mt-1 text-graphite">{data.brand.name} {data.location.name}</p>
      {sf.checkout.mode !== 'native' ? <p className="card mt-6 p-6">{t('checkoutUnavailable')}</p> : <Checkout sf={sf} statusBase={links.location(location, '/shop/orders')} shopHref={links.location(location, '/shop')} />}
    </main>
  );
}

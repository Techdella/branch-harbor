import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ShopAccount } from '@/components/shop/ShopAccount';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AccountPage({ params }: { params: Promise<{ brand: string; location: string }> }) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'commerce') notFound();
  const t = await getTranslations('storefront');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10">
      <a href={links.location(location, '/shop')} className="link text-sm"><span aria-hidden className="inline-block rtl:-scale-x-100">←</span> {t('backToShop')}</a>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{t('account')}</h1>
      <ShopAccount brand={brand} />
    </main>
  );
}

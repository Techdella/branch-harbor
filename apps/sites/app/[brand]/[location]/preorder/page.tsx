import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { CheckoutFlow } from '@/components/foods/CheckoutFlow';
import { apiGet } from '@/lib/api';
import type { MenuX } from '@/lib/foods-ext';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('foodsite');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('preorderTitle')} · ${data.brand.name} ${data.location.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/preorder') } };
}

/** Preorders: choose the cooking/collection date first, then the preorder menu; orders close at the date's cut-off. */
export default async function PreorderPage({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'foods' || data.module.mode === 'external') notFound();
  const t = await getTranslations('foodsite');
  const menu = await apiGet<MenuX>(`/v1/public/foods/${data.location.id}/menu`);
  if (!menu.channels.preorder) return <MessagePage icon="calendar" title={t('preorderTitle')} body={t('preorderOff')} />;
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('preorderTitle')}</h1>
      <p className="mt-1 text-graphite">{data.brand.name} {data.location.name}</p>
      <CheckoutFlow locationId={data.location.id} locationName={data.location.name} brandName={data.brand.name} timeZone={data.location.timeZone} statusBase={links.location(location, '/orders')} channels={['preorder']} payments={menu.location.acceptingOrders} />
    </main>
  );
}

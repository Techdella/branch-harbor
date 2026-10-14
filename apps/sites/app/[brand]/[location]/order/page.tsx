import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ExternalNotice } from '@/components/ExternalNotice';
import { CheckoutFlow } from '@/components/foods/CheckoutFlow';
import { apiGet } from '@/lib/api';
import type { MenuX } from '@/lib/foods-ext';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string }>; searchParams: Promise<{ channel?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('foodsite');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return {
    title: `${t('orderTitle')} · ${data.brand.name} ${data.location.name}`,
    description: `${t('orderTitle')} — ${data.brand.name} ${data.location.name}, ${data.location.address.city}`,
    alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/order') },
  };
}

/** Order for pickup or delivery (the channels the location offers). Preorders and table ordering have their own pages. */
export default async function OrderPage({ params, searchParams }: Props) {
  const { brand, location } = await params;
  const { channel } = await searchParams;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'foods') notFound();
  const t = await getTranslations('foodsite');
  const to = await getTranslations('order');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  if (data.module.mode === 'external') {
    return <main id="main" className="mx-auto max-w-4xl px-4 py-10"><h1 className="text-3xl font-extrabold">{t('orderTitle')}</h1><div className="mt-6"><ExternalNotice data={data} /></div></main>;
  }
  const menu = await apiGet<MenuX>(`/v1/public/foods/${data.location.id}/menu`);
  const channels = ([menu.channels.pickup ? 'pickup' : null, menu.channels.delivery ? 'delivery' : null].filter(Boolean)) as Array<'pickup' | 'delivery'>;
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('orderTitle')}</h1>
      <p className="mt-1 text-graphite">{data.brand.name} {data.location.name}</p>
      {!menu.location.acceptingOrders || !channels.length ? <p className="card mt-6 p-6">{to('notAccepting')}</p> : (
        <CheckoutFlow
          locationId={data.location.id} locationName={data.location.name} brandName={data.brand.name} timeZone={data.location.timeZone}
          statusBase={links.location(location, '/orders')} channels={channels} initialChannel={channel === 'delivery' && channels.includes('delivery') ? 'delivery' : channels[0]} payments={menu.location.acceptingOrders}
        />
      )}
    </main>
  );
}

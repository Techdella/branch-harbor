import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ExternalNotice } from '@/components/ExternalNotice';
import { OrderFlow } from '@/components/foods/OrderFlow';
import { apiGet } from '@/lib/api';
import type { Menu, Slot } from '@/lib/foods';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('order');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return {
    title: `${t('title')} · ${data.brand.name} ${data.location.name}`,
    description: `${t('title')} — ${data.brand.name} ${data.location.name}, ${data.location.address.city}`,
    alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/order') },
  };
}

export default async function OrderPage({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'foods') notFound();
  const t = await getTranslations('order');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  if (data.module.mode === 'external') {
    return <main id="main" className="mx-auto max-w-4xl px-4 py-10"><h1 className="text-3xl font-extrabold">{t('title')}</h1><div className="mt-6"><ExternalNotice data={data} /></div></main>;
  }
  const [menu, slots] = await Promise.all([
    apiGet<Menu>(`/v1/public/foods/${data.location.id}/menu`),
    apiGet<{ timeZone: string; items: Slot[] }>(`/v1/public/foods/${data.location.id}/pickup-slots`),
  ]);
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('title')}</h1>
      <p className="mt-1 text-graphite">{data.brand.name} {data.location.name}</p>
      <OrderFlow
        locationId={data.location.id}
        locationName={data.location.name}
        brandName={data.brand.name}
        timeZone={data.location.timeZone}
        menu={menu}
        slots={slots.items}
        statusBase={links.location(location, '/orders')}
      />
    </main>
  );
}

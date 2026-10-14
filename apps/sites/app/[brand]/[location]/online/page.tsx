import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { OnlineLibrary } from '@/components/studios/Commerce';
import { apiGet } from '@/lib/api';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('studio');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('onlineTitle')} · ${data.brand.name} ${data.location.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/online') } };
}

export default async function OnlinePage({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'studios' || data.module.mode !== 'native') notFound();
  const t = await getTranslations('studio');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  const lib = await apiGet<{ items: Parameters<typeof OnlineLibrary>[0]['publicItems'] }>(`/v1/public/studios/${data.location.id}/online`);
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('onlineTitle')}</h1>
      <p className="mb-6 mt-1 text-graphite">{t('onlineIntro')}</p>
      <OnlineLibrary brand={brand} locationId={data.location.id} timeZone={data.location.timeZone} accountPath={links.location(location, '/account')} publicItems={lib.items} />
    </main>
  );
}

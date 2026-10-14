import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ExternalNotice } from '@/components/ExternalNotice';
import { PackagesShop, type PlanT } from '@/components/wellness/PackagesShop';
import { apiGet } from '@/lib/api';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('wellnessPro');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('packagesTitle')} · ${data.brand.name} ${data.location.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/packages') } };
}

export default async function Packages({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'wellness') notFound();
  const t = await getTranslations('wellnessPro');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  if (data.module.mode === 'external') {
    return <main id="main" className="mx-auto max-w-4xl px-4 py-10"><h1 className="text-3xl font-extrabold">{t('packagesTitle')}</h1><div className="mt-6"><ExternalNotice data={data} /></div></main>;
  }
  const r = await apiGet<{ location: { currency: string; paymentsEnabled: boolean }; items: PlanT[]; vouchers: { currency: string; minMinor: number; maxMinor: number; validityDays: number } }>(`/v1/public/wellness/${data.location.id}/packages`);
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('packagesTitle')}</h1>
      <p className="mt-1 text-graphite">{data.brand.name} {data.location.name}</p>
      <PackagesShop locationId={data.location.id} plans={r.items} vouchers={r.vouchers} paymentsEnabled={r.location.paymentsEnabled} manageBase={links.location(location, '/manage')} bookHref={links.location(location, '/book')} brandName={data.brand.name} />
    </main>
  );
}

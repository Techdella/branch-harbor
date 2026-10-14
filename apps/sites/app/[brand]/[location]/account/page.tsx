import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AccountView } from '@/components/studios/Account';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string }> };
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AccountPage({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'studios' || data.module.mode !== 'native') notFound();
  const t = await getTranslations('studio');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="mb-6 text-3xl font-extrabold tracking-tight">{t('accountTitle')}</h1>
      <AccountView brand={brand} locationId={data.location.id} timeZone={data.location.timeZone} accountPath={links.location(location, '/account')} pricingPath={links.location(location, '/pricing')} onlinePath={links.location(location, '/online')} />
    </main>
  );
}

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { GuardianPortal } from '@/components/sports/GuardianPortal';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('portal');
  return { title: `${t('title')} · ${data.brand.name}`, robots: { index: false, follow: false } };
}

/** Guardian portal: sign in by emailed link, then participants, schedules, balances, forms and messages. */
export default async function PortalPage({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'sports') notFound();
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return (
    <main id="main" className="mx-auto max-w-4xl px-4 py-10">
      <GuardianPortal locationId={data.location.id} brandName={data.brand.name} programmesHref={links.location(location, '/programmes')} />
    </main>
  );
}

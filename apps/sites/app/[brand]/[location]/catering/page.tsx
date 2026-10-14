import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { CateringEnquiryForm } from '@/components/foods/Extras';
import { apiGet } from '@/lib/api';
import type { CateringPackageX } from '@/lib/foods-ext';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('foodsite');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('cateringTitle')} · ${data.brand.name} ${data.location.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/catering') } };
}

/** Catering enquiry: packages with price per guest; the business reviews and sends a quote before anything is booked. */
export default async function CateringPage({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'foods' || data.module.mode === 'external') notFound();
  const t = await getTranslations('foodsite');
  const c = await apiGet<{ enabled: boolean; currency: string; earliestDate: string; packages: CateringPackageX[] }>(`/v1/public/foods/${data.location.id}/catering`);
  if (!c.enabled) return <MessagePage icon="gift" title={t('cateringTitle')} body={t('cateringOff')} />;
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('cateringTitle')}</h1>
      <p className="mt-1 text-graphite">{t('cateringIntro', { location: data.location.name })}</p>
      <CateringEnquiryForm locationId={data.location.id} brandName={data.brand.name} packages={c.packages} currency={c.currency} earliestDate={c.earliestDate} manageBase={links.location(location, '/catering')} />
    </main>
  );
}

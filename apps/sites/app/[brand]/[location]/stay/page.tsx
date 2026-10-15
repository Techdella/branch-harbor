import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { ExternalNotice } from '@/components/ExternalNotice';
import { BookStay } from '@/components/stay/BookStay';
import { apiGet } from '@/lib/api';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';
import type { PropertyPage } from '@/lib/stay';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('module');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('hospitality')} · ${data.brand.name} ${data.location.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/stay') } };
}

export default async function Stay({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'hospitality') notFound();
  const t = await getTranslations();
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  if (data.module.mode === 'external') {
    return <main id="main" className="mx-auto max-w-4xl px-4 py-10"><h1 className="text-3xl font-extrabold">{t('module.hospitality')}</h1><div className="mt-6"><ExternalNotice data={data} /></div></main>;
  }
  const p = await apiGet<PropertyPage>(`/v1/public/hospitality/properties/${data.location.id}`);
  return (
    <main id="main" className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('stay.title', { name: p.property.name })}</h1>
      {p.property.description && <p className="mt-1 text-graphite">{p.property.description}</p>}
      <p className="mt-2 flex flex-wrap gap-4 text-sm text-graphite">
        <span className="inline-flex items-center gap-1"><Icon name="clock" size={16} />{t('stay.times', { checkIn: p.property.checkInTime, checkOut: p.property.checkOutTime })}</span>
        {p.outlet && <span className="inline-flex items-center gap-1"><Icon name="utensils" size={16} />{p.outlet.name ?? t('stay.restaurant')}</span>}
      </p>
      {p.property.amenities.length > 0 && <p className="mt-2 text-sm text-graphite">{p.property.amenities.join(' · ')}</p>}
      <BookStay locationId={data.location.id} today={p.property.today} currency={p.property.currency} checkInTime={p.property.checkInTime} manageBase={links.location(location, '/manage')} brandName={data.brand.name} />
      {p.taxes.length > 0 && (
        <section className="mt-8 text-sm text-graphite" aria-labelledby="tax-h">
          <h2 id="tax-h" className="font-bold text-ink">{t('stay.taxesTitle')}</h2>
          <ul className="mt-1 list-disc ps-5">{p.taxes.map((x) => <li key={x.name}>{x.name}{x.inclusive ? ` — ${t('stay.included')}` : ''}</li>)}</ul>
        </section>
      )}
      {p.houseRules && <p className="mt-4 text-sm text-graphite"><strong className="text-ink">{t('stay.houseRules')}</strong> {p.houseRules}</p>}
    </main>
  );
}

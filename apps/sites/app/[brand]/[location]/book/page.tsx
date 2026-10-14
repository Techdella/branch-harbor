import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ExternalNotice } from '@/components/ExternalNotice';
import { BookAppointment, type Service } from '@/components/wellness/BookAppointment';
import { apiGet } from '@/lib/api';
import { localDate } from '@/lib/format';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('module');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('wellness')} · ${data.brand.name} ${data.location.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/book') } };
}

export default async function Book({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'wellness') notFound();
  const t = await getTranslations();
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  if (data.module.mode === 'external') {
    return <main id="main" className="mx-auto max-w-4xl px-4 py-10"><h1 className="text-3xl font-extrabold">{t('module.wellness')}</h1><div className="mt-6"><ExternalNotice data={data} /></div></main>;
  }
  const s = await apiGet<{ items: Service[] }>(`/v1/public/wellness/${data.location.id}/services`);
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('module.wellness')}</h1>
      <p className="mt-1 text-graphite">{data.brand.name} {data.location.name}</p>
      <BookAppointment
        locationId={data.location.id}
        timeZone={data.location.timeZone}
        today={localDate(new Date(), data.location.timeZone)}
        services={s.items}
        brandName={data.brand.name}
        manageBase={links.location(location, '/manage')}
        packagesHref={links.location(location, '/packages')}
      />
    </main>
  );
}

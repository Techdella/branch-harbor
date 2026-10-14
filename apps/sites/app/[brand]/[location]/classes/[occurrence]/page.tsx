import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { BookClass } from '@/components/studios/BookClass';
import { apiGet } from '@/lib/api';
import { dateLong, money, time, zone } from '@/lib/format';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';
import type { ScheduleItem } from '@/lib/types';

type Props = { params: Promise<{ brand: string; location: string; occurrence: string }> };

export const metadata: Metadata = { robots: { index: false, follow: true } };

export default async function BookClassPage({ params }: Props) {
  const { brand, location, occurrence } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'studios' || data.module.mode !== 'native' || !/^[0-9a-f-]{36}$/i.test(occurrence)) notFound();
  const from = new Date(Date.now() - 60_000).toISOString();
  const to = new Date(Date.now() + 30 * 86400_000).toISOString();
  const s = await apiGet<{ items: ScheduleItem[] }>(`/v1/public/studios/${data.location.id}/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const c = s.items.find((i) => i.id === occurrence);
  if (!c) notFound();
  const locale = await getLocale();
  const t = await getTranslations();
  const tz = data.location.timeZone;
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  const when = `${dateLong(c.startsAt, tz, locale)}, ${time(c.startsAt, tz, locale)}–${time(c.endsAt, tz, locale)} ${zone(tz, locale, c.startsAt)}`;
  const full = c.action === 'join_waitlist';

  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <a href={links.location(location, '/classes')} className="link text-sm font-semibold">← {t('schedule.title')}</a>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight">{full ? t('booking.waitlistTitle', { name: c.classType.name }) : t('booking.title', { name: c.classType.name })}</h1>
      <dl className="card mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 p-5 text-sm">
        <dt className="font-semibold text-graphite">{t('booking.when')}</dt><dd>{when}</dd>
        <dt className="font-semibold text-graphite">{t('booking.where')}</dt><dd>{data.brand.name} {data.location.name}{c.room ? ` · ${c.room}` : ''}</dd>
        {c.instructorName && (<><dt className="font-semibold text-graphite">{t('booking.instructor')}</dt><dd>{c.instructorName}</dd></>)}
        <dt className="font-semibold text-graphite">{t('booking.price')}</dt><dd className="font-bold">{c.price.amount ? money(c.price, locale) : t('schedule.free')}</dd>
      </dl>
      {c.action ? (
        <BookClass
          occurrenceId={c.id}
          full={full}
          paid={c.price.amount > 0}
          priceLabel={money(c.price, locale)}
          className={c.classType.name}
          whenLabel={when}
          locationName={`${data.brand.name} ${data.location.name}`}
          brandName={data.brand.name}
          manageBase={links.location(location, '/manage')}
        />
      ) : (
        <p className="card mt-5 p-5">{c.status === 'cancelled' ? t('schedule.cancelled') : t('location.notPurchasable')}</p>
      )}
    </main>
  );
}

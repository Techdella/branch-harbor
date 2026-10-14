import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ExternalNotice } from '@/components/ExternalNotice';
import { apiGet } from '@/lib/api';
import { addDays, calendarLabel, localDate, money, time, zone } from '@/lib/format';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';
import type { ScheduleItem } from '@/lib/types';

type Props = { params: Promise<{ brand: string; location: string }>; searchParams: Promise<{ day?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('schedule');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return {
    title: `${t('title')} · ${data.brand.name} ${data.location.name}`,
    description: `${t('title')} — ${data.brand.name} ${data.location.name}, ${data.location.address.city}`,
    alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/classes') },
  };
}

export default async function Classes({ params, searchParams }: Props) {
  const { brand, location } = await params;
  const { day } = await searchParams;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'studios') notFound();
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  const t = await getTranslations();
  const locale = await getLocale();
  const tz = data.location.timeZone;
  const today = localDate(new Date(), tz);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const selected = day && days.includes(day) ? day : today;

  if (data.module.mode === 'external') {
    return (
      <main id="main" className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="text-3xl font-extrabold tracking-tight">{t('schedule.title')}</h1>
        <div className="mt-6"><ExternalNotice data={data} /></div>
      </main>
    );
  }

  const from = new Date(Date.now() - 60_000).toISOString();
  const to = new Date(Date.now() + 8 * 86400_000).toISOString();
  const schedule = await apiGet<{ items: ScheduleItem[] }>(`/v1/public/studios/${data.location.id}/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const items = schedule.items.filter((i) => localDate(i.startsAt, tz) === selected);

  return (
    <main id="main" className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('schedule.title')}</h1>
      <p className="mt-1 text-graphite">{data.brand.name} {data.location.name} · {t('common.timesIn', { zone: `${zone(tz, locale)} (${tz})` })}</p>

      <nav aria-label={t('schedule.days')} className="mt-5 flex gap-2 overflow-x-auto pb-1">
        {days.map((d) => {
          const active = d === selected;
          return (
            <a
              key={d}
              href={`${links.location(location, '/classes')}?day=${d}`}
              aria-current={active ? 'date' : undefined}
              className={`flex min-h-14 min-w-16 shrink-0 flex-col items-center justify-center rounded-2xl border px-3 text-sm font-bold ${active ? 'border-ink bg-ink text-white' : 'border-line bg-white'}`}
            >
              <span>{calendarLabel(d, locale, { weekday: 'short' })}</span>
              <span className="text-xs font-semibold opacity-80">{calendarLabel(d, locale, { day: 'numeric', month: 'short' })}</span>
            </a>
          );
        })}
      </nav>

      <ul className="mt-5 space-y-3">
        {items.map((c) => {
          const label = c.status === 'cancelled' ? t('schedule.cancelled') : c.status === 'unavailable' ? t('schedule.unavailable') : c.status === 'full' ? t('schedule.full') : t('schedule.spotsLeft', { n: c.spotsLeft });
          return (
            <li key={c.id} className="card flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
              <div className="w-24 shrink-0">
                <p className="text-lg font-extrabold tabular">{time(c.startsAt, tz, locale)}</p>
                <p className="text-xs text-graphite">{zone(tz, locale, c.startsAt)}</p>
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-bold">{c.classType.name}</h2>
                <p className="text-sm text-graphite">{[c.instructorName && t('schedule.with', { name: c.instructorName }), c.room].filter(Boolean).join(' · ')}</p>
                <p className={`mt-1 text-sm font-semibold ${c.status === 'full' ? 'text-warning' : c.status === 'available' ? 'text-success' : 'text-graphite'}`}>{label}</p>
              </div>
              <p className="font-bold tabular">{c.price.amount ? money(c.price, locale) : t('schedule.free')}</p>
              {c.action && (
                <a
                  href={links.location(location, `/classes/${c.id}`)}
                  className={`btn ${c.action === 'book' ? 'btn-primary' : 'btn-secondary'}`}
                  aria-label={`${c.action === 'book' ? t('schedule.book') : t('schedule.joinWaitlist')}: ${c.classType.name} ${time(c.startsAt, tz, locale)}`}
                >
                  {c.action === 'book' ? t('schedule.book') : t('schedule.joinWaitlist')}
                </a>
              )}
            </li>
          );
        })}
        {!items.length && <li className="card p-6 text-center text-graphite">{t('schedule.noClasses')}</li>}
      </ul>
      {!data.module.paymentsEnabled && <p className="mt-4 text-sm text-graphite">{t('location.notPurchasable')}</p>}
    </main>
  );
}

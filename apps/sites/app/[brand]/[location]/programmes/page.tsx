import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ExternalNotice } from '@/components/ExternalNotice';
import { RegisterProgramme } from '@/components/sports/RegisterProgramme';
import { apiGet } from '@/lib/api';
import { calendarLabel, money } from '@/lib/format';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';
import type { Programme } from '@/lib/types';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('module');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('sports')} · ${data.brand.name} ${data.location.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/programmes') } };
}

export default async function Programmes({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'sports') notFound();
  const t = await getTranslations();
  const locale = await getLocale();
  if (data.module.mode === 'external') {
    return <main id="main" className="mx-auto max-w-4xl px-4 py-10"><h1 className="text-3xl font-extrabold">{t('module.sports')}</h1><div className="mt-6"><ExternalNotice data={data} /></div></main>;
  }
  const res = await apiGet<{ items: Programme[] }>(`/v1/public/sports/${data.location.id}/programmes`);
  const now = Date.now();
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('module.sports')}</h1>
      <p className="mt-1 text-graphite">{data.brand.name} {data.location.name}</p>
      <p className="mt-3 rounded-2xl bg-canvas p-4 text-sm">{t('sports.reviewNote')}</p>
      <ul className="mt-5 space-y-4">
        {res.items.map((p) => {
          const open = (!p.registrationOpensAt || new Date(p.registrationOpensAt).getTime() <= now) && (!p.registrationClosesAt || new Date(p.registrationClosesAt).getTime() >= now);
          return (
            <li key={p.id} className="card p-5">
              <h2 className="text-xl font-bold">{p.name}</h2>
              {p.description && <p className="mt-1 text-graphite">{p.description}</p>}
              <p className="mt-2 text-sm">
                {(p.ageMin !== null || p.ageMax !== null) && <>{t('sports.ages', { min: p.ageMin ?? 0, max: p.ageMax ?? '—' })}{p.ageCutoffDate && ` (${t('sports.agesOn', { date: calendarLabel(p.ageCutoffDate, locale, { day: 'numeric', month: 'short', year: 'numeric' }) })})`} · </>}
                {t('sports.fee')}: {p.fee.amount ? money(p.fee, locale) : t('schedule.free')}
                {p.spotsLeft !== null && <> · {p.spotsLeft > 0 ? t('sports.spotsLeft', { n: p.spotsLeft }) : t('sports.full')}</>}
              </p>
              {open
                ? <RegisterProgramme programme={p} feeLabel={money(p.fee, locale)} brandName={data.brand.name} />
                : <p className="mt-3 text-sm font-semibold text-graphite">{t('sports.closed')}</p>}
            </li>
          );
        })}
        {!res.items.length && <li className="card p-6 text-center text-graphite">{t('sports.noProgrammes')}</li>}
      </ul>
    </main>
  );
}

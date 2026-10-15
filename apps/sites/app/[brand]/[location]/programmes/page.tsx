import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ExternalNotice } from '@/components/ExternalNotice';
import { RegisterProgramme } from '@/components/sports/RegisterProgramme';
import { apiGet } from '@/lib/api';
import { calendarLabel, money } from '@/lib/format';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';
import type { Programme } from '@/lib/types';

type Props = { params: Promise<{ brand: string; location: string }>; searchParams: Promise<{ dob?: string }> };

export async function generateMetadata({ params }: { params: Props['params'] }): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('module');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('sports')} · ${data.brand.name} ${data.location.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/programmes') } };
}

/** Programme catalogue with an age filter (date of birth → eligible programmes) and registration. */
export default async function Programmes({ params, searchParams }: Props) {
  const { brand, location } = await params;
  const { dob: rawDob } = await searchParams;
  const dob = rawDob && /^\d{4}-\d{2}-\d{2}$/.test(rawDob) ? rawDob : undefined;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'sports') notFound();
  const t = await getTranslations();
  const locale = await getLocale();
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  if (data.module.mode === 'external') {
    return <main id="main" className="mx-auto max-w-4xl px-4 py-10"><h1 className="text-3xl font-extrabold">{t('module.sports')}</h1><div className="mt-6"><ExternalNotice data={data} /></div></main>;
  }
  const res = await apiGet<{ items: (Programme & { eligibility?: { ageGroup: string } | null })[] }>(`/v1/public/sports/${data.location.id}/programmes${dob ? `?dob=${dob}` : ''}`);
  const now = Date.now();
  const d = (x: string) => calendarLabel(x, locale, { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-3xl font-extrabold tracking-tight">{t('module.sports')}</h1>
          <p className="mt-1 text-graphite">{data.brand.name} {data.location.name}</p>
        </div>
        <a href={links.location(location, '/programmes/portal')} className="btn btn-secondary">{t('sports.portalLink')}</a>
      </div>
      <form method="get" className="mt-5 flex flex-wrap items-end gap-3 rounded-2xl bg-canvas p-4" aria-label={t('sports.filterLabel')}>
        <div className="min-w-0 max-w-full">
          <label htmlFor="dob-filter" className="mb-1 block text-sm font-semibold">{t('sports.filterDob')}</label>
          <input id="dob-filter" name="dob" type="date" defaultValue={dob} className="field" />
        </div>
        <button type="submit" className="btn btn-primary">{t('sports.filterApply')}</button>
        {dob && <a href={links.location(location, '/programmes')} className="text-sm font-semibold underline">{t('sports.filterClear')}</a>}
        <p className="w-full text-xs text-graphite">{t('sports.filterHelp')}</p>
      </form>
      <p className="mt-3 rounded-2xl bg-canvas p-4 text-sm">{t('sports.reviewNote')}</p>
      <ul className="mt-5 space-y-4">
        {res.items.map((p) => {
          const open = (!p.registrationOpensAt || new Date(p.registrationOpensAt).getTime() <= now) && (!p.registrationClosesAt || new Date(p.registrationClosesAt).getTime() >= now);
          const born = p.age?.birthDates;
          return (
            <li key={p.id} className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="text-xl font-bold">{p.name}</h2>
                {p.eligibility && <span className="rounded-full bg-success-bg px-3 py-1 text-xs font-bold text-success">{t('sports.eligible', { group: p.eligibility.ageGroup })}</span>}
              </div>
              {p.season && <p className="text-sm text-graphite">{p.season.name} · {d(p.season.startsOn)} – {d(p.season.endsOn)}</p>}
              {p.description && <p className="mt-1 text-graphite">{p.description}</p>}
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                {(p.ageMin !== null || p.ageMax !== null) && (
                  <div><dt className="font-semibold">{t('sports.ages', { min: p.ageMin ?? 0, max: p.ageMax ?? '—' })}</dt>
                    {born && <dd className="text-graphite">{t('sports.born', { from: born.from ? d(born.from) : '—', to: born.to ? d(born.to) : '—' })}{p.age?.rule === 'birth_year' ? ` · ${t('sports.ruleBirthYear')}` : p.ageCutoffDate ? ` · ${t('sports.agesOn', { date: d(p.ageCutoffDate) })}` : ''}</dd>}</div>
                )}
                <div><dt className="font-semibold">{t('sports.fee')}: {p.fee.amount ? money(p.fee, locale) : t('schedule.free')}</dt>
                  {!!p.paymentOptions?.some((o) => o.kind === 'instalments') && <dd className="text-graphite">{t('sports.instalmentsAvailable')}</dd>}
                  {!!p.siblingDiscountPercent && <dd className="text-graphite">{t('sports.siblingDiscount', { pct: p.siblingDiscountPercent })}</dd>}</div>
                {!!p.venues?.length && <div><dt className="font-semibold">{t('sports.venues')}</dt><dd className="text-graphite">{p.venues.map((v) => v.name).join(', ')}</dd></div>}
                {p.spotsLeft !== null && <div><dt className="font-semibold">{p.spotsLeft > 0 ? t('sports.spotsLeft', { n: p.spotsLeft }) : t('sports.full')}</dt></div>}
              </dl>
              {p.eligibilityNotes && <p className="mt-2 text-sm"><strong>{t('sports.eligibility')}:</strong> {p.eligibilityNotes}</p>}
              {open
                ? <RegisterProgramme programme={p} feeLabel={money(p.fee, locale)} brandName={data.brand.name} timeZone={data.location.timeZone} portalHref={links.location(location, '/programmes/portal')} />
                : <p className="mt-3 text-sm font-semibold text-graphite">{t('sports.closed')}</p>}
            </li>
          );
        })}
        {!res.items.length && <li className="card p-6 text-center text-graphite">{dob ? t('sports.noneForAge') : t('sports.noProgrammes')}</li>}
      </ul>
    </main>
  );
}

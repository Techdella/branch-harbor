import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { NearMe } from '@/components/NearMe';
import { OpenBadge } from '@/components/OpenBadge';
import { SchematicMap } from '@/components/SchematicMap';
import { FranchiseEnquiry } from '@/components/franchise/FranchiseEnquiry';
import { getFranchiseForm, getTerritoryMap } from '@/lib/franchise';
import { AvailableTerritories } from '@/components/franchise/AvailableTerritories';
import { BrandDocument } from '@/components/builder/SiteContent';
import { getRouting, loadBrand, makeLinks, resolveSiteLocale, str } from '@/lib/site';
import type { BrandSite } from '@/lib/types';

type Props = { params: Promise<{ brand: string }>; searchParams: Promise<{ q?: string; country?: string; near?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand } = await params;
  const data = await loadBrand(brand);
  const r = await getRouting();
  const links = makeLinks(r, brand, { brandPrimaryHost: data.site.primaryHost });
  const home = data.pages.find((p) => p.slug === 'home');
  const { available } = await resolveSiteLocale();
  const canonical = links.brandCanonical();
  return {
    title: home?.seo.title ?? data.brand.name,
    description: home?.seo.description ?? data.brand.tagline ?? undefined,
    alternates: {
      canonical,
      languages: available.length > 1 ? Object.fromEntries(available.map((l) => [l, `${canonical}?lang=${l}`])) : undefined,
    },
    openGraph: { title: data.brand.name, siteName: data.brand.name, type: 'website', url: canonical },
  };
}

const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 10) / 10;
};

function filter(data: BrandSite, q: string, country: string, near: string | undefined) {
  const ql = q.trim().toLowerCase();
  let items = data.locations.filter((l) => {
    if (country && l.country !== country) return false;
    if (!ql) return true;
    const hay = [l.name, l.address.city, l.address.region, l.address.postalCode, l.address.line1, l.country].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(ql);
  }).map((l) => ({ ...l, distanceKm: null as number | null }));
  const m = near?.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const at = { lat: Number(m[1]), lng: Number(m[2]) };
    items = items.map((l) => ({ ...l, distanceKm: l.geo ? km(at, l.geo) : null })).sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  }
  return items;
}

export default async function BrandHome({ params, searchParams }: Props) {
  const { brand: slug } = await params;
  const sp = await searchParams;
  const data = await loadBrand(slug);
  const r = await getRouting();
  const links = makeLinks(r, slug, { brandPrimaryHost: data.site.primaryHost });
  const t = await getTranslations('finder');
  const tb = await getTranslations('brand');
  const locale = await getLocale();
  const home = data.pages.find((p) => p.slug === 'home');
  const q = (sp.q ?? '').slice(0, 80);
  const country = (sp.country ?? '').toUpperCase().slice(0, 2);
  const results = filter(data, q, country, sp.near);
  const countries = [...new Set(data.locations.map((l) => l.country))].sort();
  const countryName = (c: string) => { try { return new Intl.DisplayNames([locale], { type: 'region' }).of(c) ?? c; } catch { return c; } };
  const heroTitle = str(home?.content.hero_title) ?? data.brand.name;
  const heroText = data.brand.tagline ?? str(home?.content.brand_tagline) ?? str(home?.content.intro);
  const heroImage = data.brand.theme.heroImageUrl ?? str(home?.content.hero_image);
  // "Own a franchise" module: franchise networks that switched the enquiry form on (posts to their pipeline).
  const franchise = data.brand.model === 'independent' ? null : await getFranchiseForm(slug);
  // Opt-in "Available territories" map for the recruitment section.
  const territoryMap = data.brand.model === 'independent' ? null : await getTerritoryMap(slug);
  const tf = await getTranslations('franchiseSite');

  return (
    <main id="main">
      {/* Website builder brand home: the published document, then the location finder. */}
      {home?.document ? <BrandDocument doc={home.document} brand={data.brand} pageUrl={links.brandCanonical()} /> : (
      <section className="relative overflow-hidden bg-brand text-on-brand">
        {heroImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={heroImage} alt="" className="absolute inset-0 size-full object-cover opacity-30" />
        )}
        <div className="relative mx-auto max-w-6xl px-4 py-14 sm:py-20">
          <h1 className="max-w-3xl text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">{heroTitle}</h1>
          {heroText && <p className="mt-4 max-w-2xl text-lg opacity-90">{heroText}</p>}
          <form method="get" action="#finder" role="search" className="mt-8 flex max-w-xl flex-col gap-2 rounded-3xl bg-white p-2 text-ink shadow-pop sm:flex-row sm:rounded-full">
            <label htmlFor="hero-q" className="sr-only">{t('searchLabel')}</label>
            <input id="hero-q" name="q" defaultValue={q} placeholder={t('searchPlaceholder')} className="h-12 min-w-0 rounded-full px-4 text-base outline-offset-0 sm:flex-1" />
            <button type="submit" className="btn btn-primary h-12">{t('title')}</button>
          </form>
          {data.brand.industry === 'realty' && (
            <a href={links.brand('/properties')} className="btn mt-4 border border-white/60 bg-white/10 text-on-brand"><Icon name="house" size={18} />{tb('searchProperties')}</a>
          )}
          {franchise && (
            <a href="#own-a-franchise" className="btn mt-4 ms-2 border border-white/60 bg-white/10 text-on-brand"><Icon name="briefcase" size={18} />{tf('cta')}</a>
          )}
        </div>
      </section>
      )}

      <section id="finder" aria-labelledby="finder-h" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-10">
        <h2 id="finder-h" className="text-2xl font-extrabold tracking-tight sm:text-3xl">{tb('ourLocations')}</h2>
        <form method="get" action="#finder" role="search" className="mt-4 flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <label htmlFor="q" className="mb-1 block text-sm font-semibold">{t('searchLabel')}</label>
            <input id="q" name="q" defaultValue={q} className="field" />
          </div>
          {countries.length > 1 && (
            <div>
              <label htmlFor="country" className="mb-1 block text-sm font-semibold">{t('country')}</label>
              <select id="country" name="country" defaultValue={country} className="field">
                <option value="">{t('allCountries')}</option>
                {countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
              </select>
            </div>
          )}
          <button type="submit" className="btn btn-primary"><Icon name="search" size={16} />{t('search')}</button>
          <NearMe label={t('nearMe')} errorText={t('nearMeError')} />
        </form>

        <p className="mt-4 text-sm font-semibold text-graphite" role="status">{t('results', { count: results.length })}</p>

        <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ul className="space-y-3">
            {results.map((l) => (
              <li key={l.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="text-lg font-bold"><a href={links.location(l.slug)} className="hover:underline">{l.name}</a></h3>
                  <OpenBadge loc={l} />
                </div>
                <p className="mt-1 text-sm text-graphite">
                  <bdi>{[l.address.line1, l.address.city, l.address.region, l.address.postalCode].filter(Boolean).join(', ')}</bdi> · {countryName(l.country)}
                </p>
                {l.hours.summary && <p className="mt-1 text-sm text-graphite"><Icon name="clock" size={14} className="me-1 inline align-[-2px]" />{l.hours.summary}</p>}
                {l.distanceKm !== null && <p className="mt-1 text-sm text-graphite">{t('distance', { km: l.distanceKm.toLocaleString(locale) })}</p>}
                <a href={links.location(l.slug)} className="btn btn-secondary mt-3 h-10 min-h-10 text-sm" aria-label={`${t('visit')}: ${l.name}`}>{t('visit')}<Icon name="arrow-right" size={16} /></a>
              </li>
            ))}
            {!results.length && (
              <li className="card p-6 text-center">
                <p>{t('noResults', { q })}</p>
                <a href={`${links.brand()}#finder`} className="link mt-2 inline-block font-semibold">{t('showAll')}</a>
              </li>
            )}
          </ul>
          <div className="lg:sticky lg:top-20 lg:self-start">
            <SchematicMap items={results} label={t('mapLabel')} note={t('mapNote')} hrefFor={(s) => links.location(s)} />
          </div>
        </div>
      </section>

      {(franchise || territoryMap) && (
        <section id="own-a-franchise" aria-labelledby="franchise-h" className="mx-auto mt-14 max-w-3xl scroll-mt-20 px-4">
          <h2 id="franchise-h" className="text-2xl font-extrabold tracking-tight sm:text-3xl">{tf('title', { brand: data.brand.name })}</h2>
          {franchise && <p className="mb-5 mt-2 text-graphite">{tf('intro')}</p>}
          {territoryMap && <AvailableTerritories data={territoryMap} formAnchor={franchise ? '#franchise-form' : null} />}
          {franchise && <div id="franchise-form" className="scroll-mt-20"><FranchiseEnquiry brandSlug={slug} brandName={data.brand.name} currency={franchise.currency ?? 'USD'} countries={franchise.countries ?? []} territories={franchise.territories ?? []} /></div>}
        </section>
      )}

      {!home?.document && str(home?.content.about) && (
        <section className="mx-auto mt-14 max-w-3xl px-4">
          <p className="whitespace-pre-line text-lg leading-relaxed">{str(home?.content.about)}</p>
        </section>
      )}
    </main>
  );
}

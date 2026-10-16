import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { Hours } from '@/components/Hours';
import { TrackingNumber } from '@/components/TrackingNumber';
import { OpenBadge } from '@/components/OpenBadge';
import { PageContent } from '@/components/PageContent';
import { LocationDocument } from '@/components/builder/SiteContent';
import { apiGet } from '@/lib/api';
import { dateTime, money, zone } from '@/lib/format';
import { MODULE_ICON, MODULE_PATH, SCHEMA_TYPE, providerName } from '@/lib/modules';
import { getRouting, loadLocation, makeLinks, resolveSiteLocale, str } from '@/lib/site';
import type { LocationSite, ScheduleItem } from '@/lib/types';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  const home = data.pages.find((p) => p.slug === 'home');
  const canonical = links.locationCanonical(location, data.site.primaryHost);
  const { available } = await resolveSiteLocale();
  const title = home?.seo.title ?? home?.title ?? (data.site.singleLocation ? data.brand.name : `${data.brand.name} ${data.location.name}`);
  const description = home?.seo.description ?? str(home?.content.about) ?? `${data.brand.name} · ${data.location.address.line1}, ${data.location.address.city}`;
  return {
    title,
    description: description.slice(0, 300),
    alternates: { canonical, languages: available.length > 1 ? Object.fromEntries(available.map((l) => [l, `${canonical}?lang=${l}`])) : undefined },
    openGraph: { title, description: description.slice(0, 300), siteName: data.brand.name, type: 'website', url: canonical, ...(home?.seo.socialImage ? { images: [home.seo.socialImage] } : {}) },
    ...(home?.seo.noindex ? { robots: { index: false, follow: true } } : {}),
  };
}

/** schema.org LocalBusiness for search engines, with opening hours from structured weekly hours. */
function jsonLd(data: LocationSite, url: string) {
  const l = data.location;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return {
    '@context': 'https://schema.org',
    '@type': SCHEMA_TYPE[data.module.kind] ?? 'LocalBusiness',
    name: data.site.singleLocation || l.name === data.brand.name ? data.brand.name : `${data.brand.name} ${l.name}`,
    url,
    ...(l.phone ? { telephone: l.phone } : {}),
    ...(l.email ? { email: l.email } : {}),
    ...(data.brand.theme.logoUrl ? { logo: data.brand.theme.logoUrl } : {}),
    address: {
      '@type': 'PostalAddress',
      streetAddress: [l.address.line1, l.address.line2].filter(Boolean).join(', '),
      addressLocality: l.address.city,
      ...(l.address.region ? { addressRegion: l.address.region } : {}),
      ...(l.address.postalCode ? { postalCode: l.address.postalCode } : {}),
      addressCountry: l.country,
    },
    ...(l.geo ? { geo: { '@type': 'GeoCoordinates', latitude: l.geo.lat, longitude: l.geo.lng } } : {}),
    ...(l.hours.weekly ? { openingHoursSpecification: l.hours.weekly.map((w) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: `https://schema.org/${days[w.day]}`, opens: w.opens, closes: w.closes === '24:00' ? '23:59' : w.closes })) } : {}),
    currenciesAccepted: l.currency,
    parentOrganization: { '@type': 'Organization', name: data.brand.name },
  };
}

export default async function LocationHome({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  const t = await getTranslations();
  const locale = await getLocale();
  const l = data.location;
  const home = data.pages.find((p) => p.slug === 'home');
  const kind = data.module.kind;
  const modPath = MODULE_PATH[kind];
  const offer = str(home?.content.intro_offer) ?? str(home?.content.offer);
  const about = str(home?.content.about);
  const heroTitle = str(home?.content.hero_title) ?? l.name;
  const heroImage = str(home?.content.hero_image) ?? data.brand.theme.heroImageUrl;
  const address = [l.address.line1, l.address.line2, l.address.city, l.address.region, l.address.postalCode].filter(Boolean).join(', ');
  const directions = l.geo
    ? `https://www.openstreetmap.org/?mlat=${l.geo.lat}&mlon=${l.geo.lng}#map=17/${l.geo.lat}/${l.geo.lng}`
    : `https://www.openstreetmap.org/search?query=${encodeURIComponent(`${address}, ${l.country}`)}`;

  let upcoming: ScheduleItem[] = [];
  if (kind === 'studios' && data.module.mode === 'native') {
    try {
      const s = await apiGet<{ items: ScheduleItem[] }>(`/v1/public/studios/${l.id}/schedule`);
      upcoming = s.items.filter((i) => i.status !== 'cancelled').slice(0, 3);
    } catch { /* teaser only; the schedule page shows errors */ }
  }

  const ld = <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd(data, links.locationCanonical(location, data.site.primaryHost))).replace(/</g, '\\u003c') }} />;
  // Website builder page: the published document rendered in the business's theme.
  if (home?.document) {
    return (
      <main id="main">
        {ld}
        <TrackingNumber brand={data.brand.slug} location={l.slug} />
        <LocationDocument doc={home.document} site={data} brandSlug={brand} locationSlug={location} href={(p) => links.location(location, p)} brandHref={(p) => links.brand(p)} pageUrl={links.locationCanonical(location, data.site.primaryHost)} />
      </main>
    );
  }

  return (
    <main id="main">
      {ld}
      <TrackingNumber brand={data.brand.slug} location={l.slug} />
      <section className="mx-auto grid max-w-6xl gap-8 px-4 py-10 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        <div>
          <p className="text-sm font-bold uppercase tracking-wider text-brand-ink">{data.brand.name} · {l.address.city}</p>
          <h1 className="mt-2 text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl">{heroTitle}</h1>
          {heroTitle !== l.name && <p className="mt-2 text-xl font-semibold">{l.name}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2"><OpenBadge loc={l} /></div>
          <ul className="mt-4 space-y-2 text-graphite">
            <li className="flex gap-2"><Icon name="pin" size={18} className="mt-0.5 shrink-0" /><bdi>{address}</bdi></li>
            {l.hours.summary && <li className="flex gap-2"><Icon name="clock" size={18} className="mt-0.5 shrink-0" />{l.hours.summary}</li>}
            {l.phone && <li className="flex gap-2"><Icon name="phone" size={18} className="mt-0.5 shrink-0" /><a href={`tel:${l.phone.replace(/\s+/g, '')}`} className="hover:underline" dir="ltr" data-bh-phone="text">{l.phone}</a></li>}
          </ul>
          {offer && (
            <p className="mt-5 flex items-start gap-2 rounded-2xl bg-brand-tint p-4 font-semibold">
              <Icon name="gift" size={20} className="mt-0.5 shrink-0" /><span><span className="sr-only">{t('location.offer')}: </span>{offer}</span>
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            {modPath && data.module.mode === 'native' && (
              <a href={links.location(location, modPath)} className="btn btn-primary"><Icon name={MODULE_ICON[kind] ?? 'calendar'} size={18} />{t(`module.${kind}Cta` as 'module.studiosCta')}</a>
            )}
            <a href="#visit" className="btn btn-secondary">{t('location.hours')}</a>
          </div>
        </div>
        {heroImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={heroImage} alt="" className="aspect-[4/3] w-full rounded-3xl object-cover" />
        ) : (
          <div className="grid aspect-[4/3] w-full place-items-center rounded-3xl bg-brand-tint text-brand-ink" aria-hidden>
            <Icon name={MODULE_ICON[kind] ?? 'store'} size={72} stroke={1.4} />
          </div>
        )}
      </section>

      {data.module.mode === 'external' && (
        <section className="mx-auto max-w-6xl px-4">
          <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
            <p>{t('location.externalNote', { provider: providerName(data.module.externalProvider) })}</p>
            {data.module.externalUrl
              ? <a href={data.module.externalUrl} className="btn btn-primary" rel="noopener">{t('location.externalCta', { provider: providerName(data.module.externalProvider) })}<Icon name="arrow-up-right" size={16} /></a>
              : <span className="text-sm text-graphite">{t('location.externalNoLink')}</span>}
          </div>
        </section>
      )}

      {upcoming.length > 0 && (
        <section aria-labelledby="next-h" className="mx-auto max-w-6xl px-4 pt-6">
          <div className="flex items-end justify-between gap-2">
            <h2 id="next-h" className="text-2xl font-extrabold tracking-tight">{t('module.studios')}</h2>
            <a href={links.location(location, '/classes')} className="link text-sm font-semibold">{t('module.studiosCta')}</a>
          </div>
          <ul className="mt-3 grid gap-3 sm:grid-cols-3">
            {upcoming.map((c) => (
              <li key={c.id} className="card p-4">
                <p className="text-sm font-semibold text-graphite">{dateTime(c.startsAt, l.timeZone, locale)} {zone(l.timeZone, locale, c.startsAt)}</p>
                <p className="mt-1 font-bold"><a href={links.location(location, `/classes/${c.id}`)} className="hover:underline">{c.classType.name}</a></p>
                <p className="text-sm text-graphite">{c.price.amount ? money(c.price, locale) : t('schedule.free')}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(about || (home && Object.keys(home.content).length > 0)) && (
        <section aria-labelledby="about-h" className="mx-auto max-w-6xl px-4 pt-12">
          <h2 id="about-h" className="text-2xl font-extrabold tracking-tight">{t('location.about')}</h2>
          <div className="mt-3 max-w-3xl">
            {home ? <PageContent page={home} skip={['hero_title', 'intro_offer', 'offer', 'brand_tagline', 'hero_image']} /> : null}
          </div>
        </section>
      )}

      <section id="visit" aria-label={t('location.contact')} className="mx-auto grid max-w-6xl scroll-mt-24 gap-6 px-4 pt-12 md:grid-cols-2">
        <div className="card p-6">
          <h2 className="text-xl font-extrabold">{t('location.hours')}</h2>
          <div className="mt-3"><Hours loc={l} /></div>
        </div>
        <div className="card p-6">
          <h2 className="text-xl font-extrabold">{t('location.contact')}</h2>
          <address className="mt-3 not-italic">
            <p>{data.site.singleLocation || l.name === data.brand.name ? data.brand.name : `${data.brand.name} ${l.name}`}</p>
            <p><bdi>{address}</bdi></p>
          </address>
          <div className="mt-4 flex flex-wrap gap-2">
            <a href={directions} className="btn btn-secondary" rel="noopener"><Icon name="map" size={16} />{t('location.directions')}</a>
            {l.phone && <a href={`tel:${l.phone.replace(/\s+/g, '')}`} className="btn btn-secondary" data-bh-phone="href"><Icon name="phone" size={16} />{t('location.call')}</a>}
            {l.email && <a href={`mailto:${l.email}`} className="btn btn-secondary"><Icon name="mail" size={16} />{t('location.email')}</a>}
          </div>
        </div>
      </section>
    </main>
  );
}


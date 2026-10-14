import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { BookViewing, EnquiryForm } from '@/components/realty/BookViewing';
import { isNotFound } from '@/lib/api';
import { dateLong, localDate, money, time, zone } from '@/lib/format';
import { getListingPage, type ListingPage } from '@/lib/realty';
import { getRouting, loadBrand, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; listing: string }>; searchParams: Promise<{ unit?: string }> };

async function load(brand: string, id: string, unit?: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  try {
    const page = await getListingPage(id, unit === 'sqm' || unit === 'sqft' ? unit : undefined);
    if (page.brand.slug !== brand) notFound();
    return page;
  } catch (err) {
    if (isNotFound(err)) notFound();
    throw err;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, listing } = await params;
  const data = await loadBrand(brand);
  const p = await load(brand, listing);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
  const canonical = links.brandCanonical(`/properties/${listing}`);
  const description = (p.listing.description ?? p.listing.title).slice(0, 300);
  return { title: `${p.listing.title} · ${data.brand.name}`, description, alternates: { canonical }, openGraph: { title: p.listing.title, description, url: canonical, type: 'website', images: p.listing.photos.slice(0, 1).map((x) => x.url) } };
}

/** schema.org RealEstateListing with the offer in the listing currency and the agency as offeredBy. */
function jsonLd(p: ListingPage, url: string) {
  const l = p.listing;
  const accommodation = {
    '@type': l.propertyType === 'house' || l.propertyType === 'townhouse' ? 'SingleFamilyResidence' : l.propertyType === 'apartment' || l.propertyType === 'condo' ? 'Apartment' : 'Accommodation',
    ...(l.bedrooms != null ? { numberOfBedrooms: l.bedrooms } : {}),
    ...(l.bathrooms != null ? { numberOfBathroomsTotal: l.bathrooms } : {}),
    ...(l.area ? { floorSize: { '@type': 'QuantitativeValue', value: l.area.value, unitCode: l.area.unit === 'sqm' ? 'MTK' : 'FTK', unitText: l.area.label } } : {}),
    address: { '@type': 'PostalAddress', addressLocality: l.city, ...(l.region ? { addressRegion: l.region } : {}), addressCountry: l.country, ...(l.hideStreet ? {} : { streetAddress: l.addressLines[0] }) },
    ...(l.geo ? { geo: { '@type': 'GeoCoordinates', latitude: l.geo.lat, longitude: l.geo.lng } } : {}),
  };
  return {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    name: l.title,
    url,
    ...(l.description ? { description: l.description } : {}),
    ...(l.photos.length ? { image: l.photos.map((x) => x.url) } : {}),
    ...(l.publishedAt ? { datePosted: l.publishedAt } : {}),
    about: accommodation,
    offers: {
      '@type': 'Offer',
      price: (l.price.amount / (l.price.currency === 'JPY' ? 1 : 100)).toFixed(l.price.currency === 'JPY' ? 0 : 2),
      priceCurrency: l.price.currency,
      businessFunction: l.transaction === 'rent' ? 'http://purl.org/goodrelations/v1#LeaseOut' : 'http://purl.org/goodrelations/v1#Sell',
      availability: l.status === 'under_offer' ? 'https://schema.org/LimitedAvailability' : l.status === 'coming_soon' ? 'https://schema.org/PreOrder' : 'https://schema.org/InStock',
      offeredBy: { '@type': 'RealEstateAgent', name: `${p.brand.name} ${p.office.name}`, ...(p.office.phone ? { telephone: p.office.phone } : {}) },
    },
  };
}

export default async function ListingDetail({ params, searchParams }: Props) {
  const { brand, listing } = await params;
  const { unit } = await searchParams;
  const data = await loadBrand(brand);
  if (data.brand.industry !== 'realty') notFound();
  const p = await load(brand, listing, unit);
  const t = await getTranslations('realty');
  const locale = await getLocale();
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
  const l = p.listing;
  const tz = p.office.timeZone;
  const otherUnit = l.area?.unit === 'sqm' ? 'sqft' : 'sqm';
  const canonical = links.brandCanonical(`/properties/${listing}`);

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd(p, canonical)).replace(/</g, '\\u003c') }} />
      <nav aria-label={t('listing.breadcrumb')} className="text-sm"><a href={links.brand('/properties')} className="link">{t('search.title')}</a> <span aria-hidden>›</span> <a href={links.location(p.office.slug, '/properties')} className="link">{p.office.name}</a></nav>

      <section aria-label={t('listing.gallery')} className="mt-4">
        {l.photos.length ? (
          <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto rounded-3xl" tabIndex={0}>
            {l.photos.map((ph, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={ph.url} alt={ph.alt ?? ph.caption ?? `${l.title} — ${t('listing.photo', { n: i + 1 })}`} className="h-72 w-full shrink-0 snap-center object-cover sm:h-[26rem] sm:w-[85%]" loading={i ? 'lazy' : 'eager'} />
            ))}
          </div>
        ) : <div className="grid h-60 place-items-center rounded-3xl bg-canvas text-graphite">{t('listing.noPhoto')}</div>}
        {l.photos.length > 1 && <p className="mt-1 text-xs text-graphite">{t('listing.photoCount', { count: l.photos.length })}</p>}
      </section>

      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-1 rounded-full bg-canvas px-3 py-1 text-sm font-bold"><Icon name={l.status === 'under_offer' ? 'receipt' : l.status === 'coming_soon' ? 'clock' : 'check'} size={14} />{t(`status.${l.status}`)}</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">{l.title}</h1>
          <p className="mt-1 text-graphite"><bdi>{l.addressLines.join(', ')}</bdi>{l.hideStreet ? ` · ${t('listing.streetHidden')}` : ''}</p>
          <p className="mt-3 text-3xl font-extrabold">{money(l.price, locale)}{l.rentPeriod ? <span className="text-lg font-semibold text-graphite"> / {t(`per.${l.rentPeriod}`)}</span> : null}</p>
          <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="card p-3"><dt className="text-xs font-semibold text-graphite">{t('listing.bedrooms')}</dt><dd className="text-xl font-bold">{l.bedrooms ?? t('listing.unknown')}</dd></div>
            <div className="card p-3"><dt className="text-xs font-semibold text-graphite">{t('listing.bathrooms')}</dt><dd className="text-xl font-bold">{l.bathrooms ?? t('listing.unknown')}</dd></div>
            <div className="card p-3"><dt className="text-xs font-semibold text-graphite">{t('listing.area')}</dt><dd className="text-xl font-bold">{l.area ? `${l.area.value.toLocaleString(locale)} ${l.area.label}` : t('listing.unknown')}</dd>
              {l.areaAlt && <dd className="text-xs text-graphite">≈ {l.areaAlt.value.toLocaleString(locale)} {l.areaAlt.label} · <a className="link" href={`?unit=${otherUnit}`}>{t('listing.switchUnit')}</a></dd>}</div>
            <div className="card p-3"><dt className="text-xs font-semibold text-graphite">{t('listing.type')}</dt><dd className="text-xl font-bold">{t(`type.${l.propertyType}`)}</dd>{l.yearBuilt && <dd className="text-xs text-graphite">{t('listing.built', { year: l.yearBuilt })}</dd>}</div>
          </dl>
          {l.description && <section className="mt-6"><h2 className="text-xl font-bold">{t('listing.about')}</h2><p className="mt-2 whitespace-pre-line leading-relaxed">{l.description}</p></section>}
          {l.features.length > 0 && <section className="mt-6"><h2 className="text-xl font-bold">{t('listing.features')}</h2><ul className="mt-2 grid gap-1 sm:grid-cols-2">{l.features.map((f) => <li key={f} className="flex items-center gap-2"><Icon name="check" size={16} />{f}</li>)}</ul></section>}
          {(l.floorPlans.length > 0 || l.virtualTourUrl) && (
            <section className="mt-6"><h2 className="text-xl font-bold">{t('listing.plansTour')}</h2>
              <div className="mt-2 flex flex-wrap gap-3">
                {l.floorPlans.map((fp, i) => <a key={i} href={fp.url} className="btn btn-secondary" target="_blank" rel="noopener noreferrer"><Icon name="file" size={16} />{fp.caption ?? t('listing.floorPlan', { n: i + 1 })}</a>)}
                {l.virtualTourUrl && <a href={l.virtualTourUrl} className="btn btn-secondary" target="_blank" rel="noopener noreferrer"><Icon name="video" size={16} />{t('listing.tour')}</a>}
              </div>
            </section>
          )}
          {p.openHouses.length > 0 && (
            <section className="mt-6"><h2 className="text-xl font-bold">{t('listing.openHouses')}</h2>
              <ul className="mt-2 space-y-1">{p.openHouses.map((o) => <li key={o.id}>{dateLong(o.startsAt, tz, locale)}, {time(o.startsAt, tz, locale)}–{time(o.endsAt, tz, locale)} {zone(tz, locale, o.startsAt)}</li>)}</ul>
            </section>
          )}
          <section className="mt-6" aria-labelledby="map-h">
            <h2 id="map-h" className="text-xl font-bold">{t('listing.location')}</h2>
            <figure className="card mt-2 grid min-h-40 place-items-center bg-[#EEF1EC] p-6 text-center text-sm">
              <div><Icon name="map" size={24} /><p className="mt-1 font-semibold"><bdi>{l.addressLines.join(', ')}</bdi></p><p className="text-graphite">{t('search.mapBody')}</p>
                {l.geo && <a className="link mt-1 inline-block" href={`https://www.openstreetmap.org/?mlat=${l.geo.lat}&mlon=${l.geo.lng}#map=16/${l.geo.lat}/${l.geo.lng}`} target="_blank" rel="noopener noreferrer">{t('listing.openMap')}</a>}</div>
            </figure>
          </section>
          {(l.disclosures.length > 0 || l.brokerageLicence) && (
            <section className="mt-6 text-sm"><h2 className="text-lg font-bold">{t('listing.disclosures')}</h2>
              <ul className="mt-2 space-y-1">{l.disclosures.map((d) => <li key={d.key}><strong>{d.label}:</strong> {d.text}</li>)}{l.brokerageLicence && <li>{l.brokerageLicence}</li>}</ul>
              <p className="mt-2 text-xs text-graphite">{t('listing.disclosuresNote')}</p>
            </section>
          )}
        </div>

        <aside className="min-w-0 space-y-4 lg:sticky lg:top-20 lg:self-start">
          <section className="card p-5" aria-labelledby="book-h">
            <h2 id="book-h" className="text-xl font-bold">{t('book.title')}</h2>
            <div className="mt-3"><BookViewing listingId={l.id} timeZone={tz} today={localDate(new Date(), tz)} manageBase={links.location(p.office.slug, '/manage')} comingSoon={l.status === 'coming_soon'} /></div>
          </section>
          <section className="card p-5" aria-labelledby="agents-h">
            <h2 id="agents-h" className="text-lg font-bold">{t('listing.agents')}</h2>
            <ul className="mt-2 space-y-3">
              {p.agents.map((a) => (
                <li key={a.id} className="flex items-center gap-3">
                  {a.photoUrl
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={a.photoUrl} alt="" className="size-12 rounded-full object-cover" />
                    : <span className="grid size-12 place-items-center rounded-full bg-canvas font-bold" aria-hidden>{a.name.slice(0, 1)}</span>}
                  <div className="text-sm"><p className="font-bold">{a.name}</p><p className="text-graphite">{a.title}{a.licenceNumber ? ` · ${a.licenceNumber}` : ''}</p>
                    {a.phone && <a className="link" dir="ltr" href={`tel:${a.phone.replace(/\s/g, '')}`}>{a.phone}</a>}</div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm"><a className="link font-semibold" href={links.location(p.office.slug, '/properties')}>{p.office.name}</a> · {p.office.phone}</p>
          </section>
          <section className="card p-5" aria-labelledby="enq-h">
            <h2 id="enq-h" className="text-lg font-bold">{t('enquiry.title')}</h2>
            <div className="mt-3"><EnquiryForm brand={brand} listingId={l.id} /></div>
          </section>
        </aside>
      </div>
    </main>
  );
}

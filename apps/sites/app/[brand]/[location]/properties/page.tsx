import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { EnquiryForm } from '@/components/realty/BookViewing';
import { ListingCardView } from '@/components/realty/ListingCardView';
import { isNotFound } from '@/lib/api';
import { getOfficePage } from '@/lib/realty';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('realty');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('office.title', { office: data.location.name })} · ${data.brand.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/properties') } };
}

/** Office page: homes listed by this office, its agents, and an enquiry / valuation form. */
export default async function OfficeProperties({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'realty') notFound();
  const t = await getTranslations('realty');
  const locale = await getLocale();
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  let page;
  try {
    page = await getOfficePage(brand, location);
  } catch (err) {
    if (isNotFound(err)) notFound();
    throw err;
  }
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('office.title', { office: page.office.name })}</h1>
      <p className="mt-1 text-graphite">{page.office.addressLines.join(', ')}{page.office.phone ? ` · ${page.office.phone}` : ''}</p>
      <p className="mt-2 text-sm text-graphite">{t('office.units', { unit: page.office.areaUnit === 'sqm' ? 'm²' : 'sq ft', currency: page.office.currency })}</p>

      <section className="mt-8" aria-labelledby="homes-h">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="homes-h" className="text-2xl font-bold">{t('office.homes')}</h2>
          <a href={links.brand(`/properties?office=${location}`)} className="link text-sm font-semibold">{t('office.searchAll')}</a>
        </div>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {page.listings.map((l) => <li key={l.id}><ListingCardView l={l} href={links.brand(`/properties/${l.id}`)} locale={locale} /></li>)}
          {!page.listings.length && <li className="card p-6 text-center sm:col-span-2 lg:col-span-3">{t('office.noHomes')}</li>}
        </ul>
      </section>

      <section className="mt-10" aria-labelledby="agents-h">
        <h2 id="agents-h" className="text-2xl font-bold">{t('office.agents')}</h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {page.agents.map((a) => (
            <li key={a.id} className="card flex items-center gap-3 p-4">
              {a.photoUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={a.photoUrl} alt="" className="size-14 rounded-full object-cover" />
                : <span className="grid size-14 place-items-center rounded-full bg-canvas text-lg font-bold" aria-hidden>{a.name.slice(0, 1)}</span>}
              <div className="text-sm">
                <p className="font-bold">{a.name}</p>
                <p className="text-graphite">{a.title}{a.licenceNumber ? ` · ${a.licenceNumber}` : ''}</p>
                {a.languages.length > 0 && <p className="text-graphite">{t('office.languages', { list: a.languages.map((x) => { try { return new Intl.DisplayNames([locale], { type: 'language' }).of(x) ?? x; } catch { return x; } }).join(', ') })}</p>}
                {a.phone && <a className="link" href={`tel:${a.phone.replace(/\s/g, '')}`}>{a.phone}</a>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10 grid gap-6 lg:grid-cols-2" aria-labelledby="enq-h">
        <div>
          <h2 id="enq-h" className="text-2xl font-bold">{t('office.contactTitle')}</h2>
          <p className="mt-1 text-graphite">{t('office.contactBody')}</p>
        </div>
        <div className="card p-5"><EnquiryForm brand={brand} officeSlug={location} kinds={['buyer', 'valuation', 'tenant', 'general']} /></div>
      </section>
      {(page.office.disclosures.length > 0 || page.office.brokerageLicence) && (
        <section className="mt-10 text-sm text-graphite"><ul>{page.office.disclosures.map((d) => <li key={d.key}><strong>{d.label}:</strong> {d.text}</li>)}{page.office.brokerageLicence && <li>{page.office.brokerageLicence}</li>}</ul></section>
      )}
    </main>
  );
}

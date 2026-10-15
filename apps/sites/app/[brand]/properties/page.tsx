import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { ListingCardView } from '@/components/realty/ListingCardView';
import { SaveSearch } from '@/components/realty/BookViewing';
import { ApiError } from '@/lib/api';
import { PROPERTY_TYPES, searchListings, toMinor, type SearchResult } from '@/lib/realty';
import { getRouting, loadBrand, makeLinks } from '@/lib/site';

type SP = { transaction?: string; type?: string; minPrice?: string; maxPrice?: string; currency?: string; minBeds?: string; minBaths?: string; minArea?: string; areaUnit?: string; city?: string; office?: string; sort?: string };
type Props = { params: Promise<{ brand: string }>; searchParams: Promise<SP> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand } = await params;
  const data = await loadBrand(brand);
  const t = await getTranslations('realty');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
  return { title: `${t('search.title')} · ${data.brand.name}`, alternates: { canonical: links.brandCanonical('/properties') } };
}

const num = (v: string | undefined) => (v && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined);

/** Property search across all public offices. Filters are a plain GET form (works without JavaScript). */
export default async function Properties({ params, searchParams }: Props) {
  const { brand } = await params;
  const sp = await searchParams;
  const data = await loadBrand(brand);
  if (data.brand.industry !== 'realty') notFound();
  const t = await getTranslations('realty');
  const locale = await getLocale();
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });

  const currency = /^[A-Z]{3}$/.test(sp.currency ?? '') ? sp.currency! : '';
  const areaUnit = sp.areaUnit === 'sqm' || sp.areaUnit === 'sqft' ? sp.areaUnit : '';
  const qs = new URLSearchParams();
  if (sp.transaction === 'sale' || sp.transaction === 'rent') qs.set('transaction', sp.transaction);
  if (sp.type && (PROPERTY_TYPES as readonly string[]).includes(sp.type)) qs.set('type', sp.type);
  if (currency) qs.set('currency', currency);
  if (num(sp.minPrice) != null && currency) qs.set('minPrice', String(toMinor(num(sp.minPrice)!, currency)));
  if (num(sp.maxPrice) != null && currency) qs.set('maxPrice', String(toMinor(num(sp.maxPrice)!, currency)));
  if (num(sp.minBeds) != null) qs.set('minBeds', String(Math.floor(num(sp.minBeds)!)));
  if (num(sp.minBaths) != null) qs.set('minBaths', String(num(sp.minBaths)));
  if (areaUnit) qs.set('areaUnit', areaUnit);
  if (num(sp.minArea) != null && areaUnit) qs.set('minArea', String(num(sp.minArea)));
  if (sp.city) qs.set('city', sp.city.slice(0, 80));
  if (sp.office) qs.set('office', sp.office.slice(0, 80));
  if (sp.sort === 'price_asc' || sp.sort === 'price_desc') qs.set('sort', sp.sort);
  const priceWithoutCurrency = !currency && (num(sp.minPrice) != null || num(sp.maxPrice) != null);
  const areaWithoutUnit = !areaUnit && num(sp.minArea) != null;

  let result: SearchResult | null = null;
  let problem: string | null = null;
  try {
    result = await searchListings(brand, qs);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 400 || err.status === 404)) problem = err.message;
    else throw err;
  }
  const facets = result?.facets;
  const criteria: Record<string, unknown> = {
    ...(qs.get('transaction') ? { transaction: qs.get('transaction') } : {}), ...(qs.get('type') ? { propertyTypes: [qs.get('type')] } : {}),
    ...(qs.get('minPrice') ? { minPrice: Number(qs.get('minPrice')) } : {}), ...(qs.get('maxPrice') ? { maxPrice: Number(qs.get('maxPrice')) } : {}),
    ...(qs.get('currency') && (qs.get('minPrice') || qs.get('maxPrice')) ? { currency: qs.get('currency') } : {}),
    ...(qs.get('minBeds') ? { minBedrooms: Number(qs.get('minBeds')) } : {}), ...(qs.get('minBaths') ? { minBathrooms: Number(qs.get('minBaths')) } : {}),
    ...(qs.get('minArea') ? { minArea: Number(qs.get('minArea')), areaUnit: qs.get('areaUnit') } : {}), ...(qs.get('city') ? { city: qs.get('city') } : {}),
  };
  const summary = [qs.get('transaction') ? t(`transaction.${qs.get('transaction')}`) : null, qs.get('type') ? t(`type.${qs.get('type')}`) : null, qs.get('minBeds') ? t('search.bedsPlus', { n: qs.get('minBeds')! }) : null, qs.get('city')].filter(Boolean).join(' · ') || t('search.allHomes');

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{t('search.title')}</h1>
      <p className="mt-1 text-graphite">{t('search.subtitle', { brand: data.brand.name })}</p>

      <form method="get" role="search" aria-label={t('search.title')} className="card mt-6 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div><label htmlFor="transaction" className="mb-1 block text-sm font-semibold">{t('search.transaction')}</label>
          <select id="transaction" name="transaction" defaultValue={sp.transaction ?? ''} className="field"><option value="">{t('search.any')}</option><option value="sale">{t('transaction.sale')}</option><option value="rent">{t('transaction.rent')}</option></select></div>
        <div><label htmlFor="type" className="mb-1 block text-sm font-semibold">{t('search.type')}</label>
          <select id="type" name="type" defaultValue={sp.type ?? ''} className="field"><option value="">{t('search.any')}</option>{PROPERTY_TYPES.map((x) => <option key={x} value={x}>{t(`type.${x}`)}</option>)}</select></div>
        <div><label htmlFor="office" className="mb-1 block text-sm font-semibold">{t('search.office')}</label>
          <select id="office" name="office" defaultValue={sp.office ?? ''} className="field"><option value="">{t('search.allOffices')}</option>{(facets?.offices ?? data.locations.map((l) => ({ slug: l.slug, name: l.name }))).map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}</select></div>
        <div><label htmlFor="city" className="mb-1 block text-sm font-semibold">{t('search.city')}</label>
          <input id="city" name="city" list="cities" defaultValue={sp.city ?? ''} className="field" /><datalist id="cities">{facets?.cities.map((c) => <option key={c} value={c} />)}</datalist></div>
        <fieldset className="grid grid-cols-3 gap-2 sm:col-span-2">
          <legend className="mb-1 text-sm font-semibold">{t('search.price')}</legend>
          <div><label htmlFor="currency" className="sr-only">{t('search.currency')}</label>
            <select id="currency" name="currency" defaultValue={currency} className="field" aria-invalid={priceWithoutCurrency || undefined}><option value="">{t('search.currency')}</option>{(facets?.currencies ?? []).map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
          <div><label htmlFor="minPrice" className="sr-only">{t('search.min')}</label><input id="minPrice" name="minPrice" inputMode="decimal" placeholder={t('search.min')} defaultValue={sp.minPrice ?? ''} className="field" /></div>
          <div><label htmlFor="maxPrice" className="sr-only">{t('search.max')}</label><input id="maxPrice" name="maxPrice" inputMode="decimal" placeholder={t('search.max')} defaultValue={sp.maxPrice ?? ''} className="field" /></div>
          {priceWithoutCurrency && <p className="col-span-3 text-sm font-semibold text-danger">{t('search.needCurrency')}</p>}
        </fieldset>
        <div className="grid grid-cols-2 gap-2">
          <div><label htmlFor="minBeds" className="mb-1 block text-sm font-semibold">{t('search.beds')}</label>
            <select id="minBeds" name="minBeds" defaultValue={sp.minBeds ?? ''} className="field"><option value="">{t('search.any')}</option>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 0 ? t('search.studio') : `${n}+`}</option>)}</select></div>
          <div><label htmlFor="minBaths" className="mb-1 block text-sm font-semibold">{t('search.baths')}</label>
            <select id="minBaths" name="minBaths" defaultValue={sp.minBaths ?? ''} className="field"><option value="">{t('search.any')}</option>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}+</option>)}</select></div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div><label htmlFor="minArea" className="mb-1 block text-sm font-semibold">{t('search.minArea')}</label><input id="minArea" name="minArea" inputMode="decimal" defaultValue={sp.minArea ?? ''} className="field" /></div>
          <div><label htmlFor="areaUnit" className="mb-1 block text-sm font-semibold">{t('search.unit')}</label>
            <select id="areaUnit" name="areaUnit" defaultValue={areaUnit} className="field" aria-invalid={areaWithoutUnit || undefined}><option value="">{t('search.officeUnit')}</option><option value="sqm">m²</option><option value="sqft">{t('search.sqft')}</option></select></div>
          {areaWithoutUnit && <p className="col-span-2 text-sm font-semibold text-danger">{t('search.needUnit')}</p>}
        </div>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
          <div><label htmlFor="sort" className="mb-1 block text-sm font-semibold">{t('search.sort')}</label>
            <select id="sort" name="sort" defaultValue={sp.sort ?? 'newest'} className="field"><option value="newest">{t('search.newest')}</option><option value="price_asc">{t('search.priceAsc')}</option><option value="price_desc">{t('search.priceDesc')}</option></select></div>
          <button type="submit" className="btn btn-primary"><Icon name="search" size={16} />{t('search.submit')}</button>
          <a href={links.brand('/properties')} className="link ms-2 text-sm font-semibold">{t('search.reset')}</a>
        </div>
      </form>

      {problem && <p role="alert" className="mt-4 rounded-2xl bg-danger-bg p-4 text-sm font-semibold text-danger">{problem}</p>}
      {result && (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-graphite" role="status">{t('search.results', { count: result.total })}</p>
            <SaveSearch brand={brand} criteria={criteria} summary={summary} />
          </div>
          {result.excluded.otherCurrency > 0 && <p className="mt-2 text-sm text-graphite">{t('search.otherCurrency', { count: result.excluded.otherCurrency })}</p>}
          <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <ul className="grid gap-4 sm:grid-cols-2">
              {result.items.map((l) => <li key={l.id}><ListingCardView l={l} href={links.brand(`/properties/${l.id}`)} locale={locale} /></li>)}
              {!result.items.length && <li className="card p-6 text-center sm:col-span-2">{t('search.none')}</li>}
            </ul>
            <aside className="lg:sticky lg:top-20 lg:self-start">
              <figure className="card grid min-h-64 place-items-center bg-[#EEF1EC] p-6 text-center">
                <div>
                  <Icon name="map" size={28} />
                  <p className="mt-2 font-semibold">{t('search.mapTitle')}</p>
                  <p className="mt-1 text-sm text-graphite">{t('search.mapBody')}</p>
                  <ul className="mt-3 text-sm">{[...new Set(result.items.map((l) => l.city))].map((c) => <li key={c}>{c} · {result.items.filter((l) => l.city === c).length}</li>)}</ul>
                </div>
              </figure>
            </aside>
          </div>
        </>
      )}
      <p className="mt-8 text-xs text-graphite">{t('search.fairHousing')}</p>
    </main>
  );
}

import { getLocale, getTranslations } from 'next-intl/server';
import { resolveTheme, type PageDocument, type ResolvedTheme } from '@bh/shared';
import { SiteDocument, type SiteLabels, type SiteLocationInfo } from '@bh/ui/site';
import { apiGet } from '@/lib/api';
import { fontVar } from '@/lib/fonts';
import { liveData } from '@/lib/live';
import { MODULE_PATH } from '@/lib/modules';
import type { Brand, LocationSite, LocationSummary } from '@/lib/types';
import { NewsletterForm, SiteForm, type PublicFormDef } from './SiteForms';

export const siteTheme = (brand: Brand): ResolvedTheme => brand.theme.site ?? resolveTheme('classic', { colorMode: 'brand', primaryColor: brand.theme.brandColor });

export async function siteLabels(): Promise<SiteLabels> {
  const t = await getTranslations('builder');
  return {
    hours: t('hours'), contact: t('contact'), closed: t('closed'), directions: t('directions'), call: t('call'), email: t('email'), map: t('map'),
    livePreview: t('livePreview'), order: t('order'), viewAll: t('viewAll'), formUnavailable: t('formUnavailable'), highlighted: t('highlighted'),
    empty: {
      class_schedule: t('empty.class_schedule'), programmes: t('empty.programmes'), services: t('empty.services'), product_grid: t('empty.product_grid'),
      menu: t('empty.menu'), listings: t('empty.listings'), rooms: t('empty.rooms'),
    },
  };
}

export function locationInfo(l: LocationSummary, displayName: string): SiteLocationInfo {
  const lines = [l.address.line1, l.address.line2, [l.address.postalCode, l.address.city].filter(Boolean).join(' '), l.address.region].filter((x): x is string => !!x && !!x.trim());
  const query = [l.address.line1, l.address.city, l.country].filter(Boolean).join(', ');
  return {
    name: displayName, addressLines: lines, phone: l.phone, email: l.email, geo: l.geo, hours: l.hours,
    directionsUrl: l.geo ? `https://www.openstreetmap.org/?mlat=${l.geo.lat}&mlon=${l.geo.lng}#map=17/${l.geo.lat}/${l.geo.lng}` : `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`,
  };
}

async function formsFor(doc: PageDocument): Promise<Record<string, PublicFormDef | null>> {
  const ids = [...new Set(doc.sections.filter((s) => s.type === 'form' && typeof s.props.formId === 'string' && s.props.formId).map((s) => s.props.formId as string))];
  const out: Record<string, PublicFormDef | null> = {};
  await Promise.all(ids.map(async (id) => { try { out[id] = await apiGet<PublicFormDef>(`/v1/public/forms/${id}`, { revalidate: 30 }); } catch { out[id] = null; } }));
  return out;
}

/** A published builder page on a location site (live industry data, forms, newsletter). */
export async function LocationDocument({ doc, site, brandSlug, locationSlug, href, brandHref, pageUrl }: { doc: PageDocument; site: LocationSite; brandSlug: string; locationSlug: string; href: (p: string) => string; brandHref: (p: string) => string; pageUrl: string }) {
  const locale = await getLocale();
  const [labels, live, formDefs] = await Promise.all([siteLabels(), liveData(doc, site, locale, href, brandHref), formsFor(doc)]);
  const single = site.site.singleLocation || site.location.name === site.brand.name;
  const modPath = MODULE_PATH[site.module.kind];
  return (
    <SiteDocument
      document={doc}
      theme={siteTheme(site.brand)}
      fontVar={fontVar}
      labels={labels}
      live={live}
      ctx={{ brandName: site.brand.name, locale, location: locationInfo(site.location, single ? site.brand.name : `${site.brand.name} ${site.location.name}`), moduleHref: modPath && site.module.mode === 'native' ? href(modPath) : site.module.externalUrl }}
      renderForm={({ formId }) => (formDefs[formId] ? <SiteForm def={formDefs[formId]!} pageUrl={pageUrl} /> : <p className="bhs-empty">{labels.formUnavailable}</p>)}
      renderNewsletter={({ buttonLabel }) => <NewsletterForm brandSlug={brandSlug} locationSlug={locationSlug} buttonLabel={buttonLabel} />}
    />
  );
}

/** A published builder page on the brand (network) site: no single location, so location blocks show their empty state. */
export async function BrandDocument({ doc, brand, pageUrl }: { doc: PageDocument; brand: Brand; pageUrl: string }) {
  const locale = await getLocale();
  const [labels, formDefs] = await Promise.all([siteLabels(), formsFor(doc)]);
  return (
    <SiteDocument
      document={doc}
      theme={siteTheme(brand)}
      fontVar={fontVar}
      labels={labels}
      live={Object.fromEntries(doc.sections.map((s) => [s.id, null]))}
      ctx={{ brandName: brand.name, locale, location: null, moduleHref: null }}
      renderForm={({ formId }) => (formDefs[formId] ? <SiteForm def={formDefs[formId]!} pageUrl={pageUrl} /> : <p className="bhs-empty">{labels.formUnavailable}</p>)}
      renderNewsletter={({ buttonLabel }) => <NewsletterForm brandSlug={brand.slug} buttonLabel={buttonLabel} />}
    />
  );
}

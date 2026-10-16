/**
 * Listing directory adapters (docs/API_INTEGRATIONS.md "Listings"): push a location's canonical listing and read the
 * directory's copy back for drift detection.
 *
 * - Google Business Profile: Business Information API v1 (`locations.get` / `locations.patch` with an update mask),
 *   reusing the Reviews OAuth connection — its `business.manage` scope already covers listing edits, so connecting
 *   once serves reviews and listings. Categories are pushed only when stored as Google category ids (`gcid:…`).
 * - Apple Business Connect and Bing Places: partner APIs that need approval. Until the platform credentials are set
 *   (APPLE_BUSINESS_CONNECT_CLIENT_ID/SECRET, BING_PLACES_API_KEY) connections are sandbox: nothing leaves
 *   BranchHarbor, the "directory copy" is simulated in `listing_syncs.remote_snapshot`, and drift can be simulated.
 *   Base URLs are configurable because both programmes hand partners their endpoint details on approval.
 *
 * Every HTTP call goes through the injected `fetch` (Services.partnerFetch), so tests use fakes.
 */
import type { ListingField, ListingProvider, ListingSnapshot, SpecialHour, WeeklyHour } from '@bh/shared';
import type { Config } from '../config.ts';
import { PartnerHttpError, TokenCache, requestJson, type FetchLike } from './partners/http.ts';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_INFO_URL = 'https://mybusinessbusinessinformation.googleapis.com/v1';

export interface ListingDirectory {
  readonly provider: ListingProvider;
  /** Platform credentials present: live connections are possible. */
  readonly configured: boolean;
  /** Read the directory's copy of a location (null when the directory has no such location). */
  fetch(credential: string, externalId: string): Promise<ListingSnapshot | null>;
  /** Push the given fields of the canonical listing. */
  push(credential: string, externalId: string, listing: ListingSnapshot, fields: readonly ListingField[]): Promise<void>;
}

const tokens = new TokenCache();
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
const pad = (n: number | undefined) => String(n ?? 0).padStart(2, '0');
const toTime = (t: string) => ({ hours: Number(t.slice(0, 2)), minutes: Number(t.slice(3, 5)) });
const fromTime = (t?: { hours?: number; minutes?: number }) => `${pad(t?.hours)}:${pad(t?.minutes)}`;
const toDate = (d: string) => ({ year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), day: Number(d.slice(8, 10)) });
const fromDate = (d?: { year?: number; month?: number; day?: number }) => `${d?.year ?? 0}-${pad(d?.month)}-${pad(d?.day)}`;

interface GoogleLocation {
  name?: string;
  title?: string;
  storefrontAddress?: { regionCode?: string; postalCode?: string; administrativeArea?: string; locality?: string; addressLines?: string[] };
  phoneNumbers?: { primaryPhone?: string };
  regularHours?: { periods?: Array<{ openDay: string; openTime?: { hours?: number; minutes?: number }; closeDay: string; closeTime?: { hours?: number; minutes?: number } }> };
  specialHours?: { specialHourPeriods?: Array<{ startDate: { year: number; month: number; day: number }; openTime?: { hours?: number; minutes?: number }; closeTime?: { hours?: number; minutes?: number }; closed?: boolean }> };
  categories?: { primaryCategory?: { name?: string; displayName?: string }; additionalCategories?: Array<{ name?: string; displayName?: string }> };
  profile?: { description?: string };
  websiteUri?: string;
}

const GOOGLE_MASK: Partial<Record<ListingField, string>> = {
  name: 'title', address: 'storefrontAddress', phone: 'phoneNumbers', hours: 'regularHours', specialHours: 'specialHours', categories: 'categories', description: 'profile.description', websiteUrl: 'websiteUri',
};

export function toGoogleLocation(l: ListingSnapshot): GoogleLocation {
  const gcid = (c: string | null | undefined) => (c && /^gcid:/.test(c) ? { name: `categories/${c}` } : undefined);
  return {
    title: l.name,
    storefrontAddress: { regionCode: l.address.country, postalCode: l.address.postalCode, administrativeArea: l.address.region, locality: l.address.city, addressLines: [l.address.line1, l.address.line2].filter((x): x is string => !!x) },
    phoneNumbers: { primaryPhone: l.phone ?? undefined },
    regularHours: { periods: l.hours.map((h) => ({ openDay: DAYS[h.day]!, openTime: toTime(h.opens), closeDay: h.closes <= h.opens ? DAYS[(h.day + 1) % 7]! : DAYS[h.day]!, closeTime: toTime(h.closes === '24:00' ? '23:59' : h.closes) })) },
    specialHours: { specialHourPeriods: l.specialHours.map((s) => (s.closed ? { startDate: toDate(s.date), closed: true } : { startDate: toDate(s.date), openTime: toTime(s.opens!), closeTime: toTime(s.closes!) })) },
    categories: gcid(l.categories.primary) ? { primaryCategory: gcid(l.categories.primary), additionalCategories: l.categories.additional.map(gcid).filter((x): x is { name: string } => !!x) } : undefined,
    profile: { description: l.description ?? '' },
    websiteUri: l.websiteUrl ?? undefined,
  };
}

export function fromGoogleLocation(g: GoogleLocation): ListingSnapshot {
  const a = g.storefrontAddress ?? {};
  const cat = (c?: { name?: string; displayName?: string }) => (c?.name?.startsWith('categories/') ? c.name.slice('categories/'.length) : c?.displayName ?? null);
  return {
    name: g.title ?? '',
    address: { line1: a.addressLines?.[0] ?? '', ...(a.addressLines?.[1] ? { line2: a.addressLines[1] } : {}), city: a.locality ?? '', region: a.administrativeArea, postalCode: a.postalCode, country: a.regionCode ?? '' },
    phone: g.phoneNumbers?.primaryPhone ?? null,
    hours: (g.regularHours?.periods ?? []).map((p): WeeklyHour => ({ day: Math.max(0, DAYS.indexOf(p.openDay as (typeof DAYS)[number])), opens: fromTime(p.openTime), closes: fromTime(p.closeTime) })),
    specialHours: (g.specialHours?.specialHourPeriods ?? []).map((p): SpecialHour => (p.closed ? { date: fromDate(p.startDate), closed: true } : { date: fromDate(p.startDate), closed: false, opens: fromTime(p.openTime), closes: fromTime(p.closeTime) })),
    categories: { primary: cat(g.categories?.primaryCategory), additional: (g.categories?.additionalCategories ?? []).map((c) => cat(c)).filter((x): x is string => !!x) },
    description: g.profile?.description ?? null,
    photos: [],
    websiteUrl: g.websiteUri ?? null,
    bookingUrl: null,
    attributes: {},
  };
}

export function createGoogleListings(cfg: Config, fetchImpl: FetchLike): ListingDirectory {
  const configured = !!(cfg.GOOGLE_OAUTH_CLIENT_ID && cfg.GOOGLE_OAUTH_CLIENT_SECRET);
  const accessToken = async (refreshToken: string) => {
    const key = `gbp-listings:${refreshToken}`;
    const cached = tokens.get(key, Date.now());
    if (cached) return cached;
    const { data } = await requestJson<{ access_token: string; expires_in: number }>('Google', fetchImpl, GOOGLE_TOKEN_URL, {
      form: { client_id: cfg.GOOGLE_OAUTH_CLIENT_ID!, client_secret: cfg.GOOGLE_OAUTH_CLIENT_SECRET!, refresh_token: refreshToken, grant_type: 'refresh_token' },
    });
    tokens.set(key, data.access_token, Date.now() + (data.expires_in ?? 3600) * 1000);
    return data.access_token;
  };
  const loc = (id: string) => (id.startsWith('locations/') ? id : `locations/${id.replace(/^accounts\/[^/]+\//, '')}`);
  return {
    provider: 'google',
    configured,
    async fetch(refreshToken, externalId) {
      const mask = Object.values(GOOGLE_MASK).map((m) => m!.split('.')[0]).join(',');
      try {
        const { data } = await requestJson<GoogleLocation>('Google', fetchImpl, `${GOOGLE_INFO_URL}/${loc(externalId)}?readMask=${encodeURIComponent(mask)}`, { headers: { Authorization: `Bearer ${await accessToken(refreshToken)}` } });
        return fromGoogleLocation(data);
      } catch (err) {
        if (err instanceof PartnerHttpError && err.status === 404) return null;
        throw err;
      }
    },
    async push(refreshToken, externalId, listing, fields) {
      const g = toGoogleLocation(listing);
      const mask = fields.map((f) => GOOGLE_MASK[f]).filter((m): m is string => !!m).filter((m) => m !== 'categories' || !!g.categories);
      if (!mask.length) return;
      await requestJson('Google', fetchImpl, `${GOOGLE_INFO_URL}/${loc(externalId)}?updateMask=${encodeURIComponent(mask.join(','))}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${await accessToken(refreshToken)}` }, body: g,
      });
    },
  };
}

/**
 * Apple Business Connect (partner API). Client-credentials token, then the company's location resource. The
 * credential stored per connection is the Apple company id.
 */
export function createAppleListings(cfg: Config, fetchImpl: FetchLike): ListingDirectory {
  const configured = !!(cfg.APPLE_BUSINESS_CONNECT_CLIENT_ID && cfg.APPLE_BUSINESS_CONNECT_CLIENT_SECRET);
  const base = cfg.APPLE_BUSINESS_CONNECT_API_URL.replace(/\/$/, '');
  const token = async () => {
    const cached = tokens.get('apple', Date.now());
    if (cached) return cached;
    const { data } = await requestJson<{ access_token: string; expires_in: number }>('Apple Business Connect', fetchImpl, `${base}/v1/oauth2/token`, {
      body: { client_id: cfg.APPLE_BUSINESS_CONNECT_CLIENT_ID, client_secret: cfg.APPLE_BUSINESS_CONNECT_CLIENT_SECRET, grant_type: 'client_credentials', scope: 'business_connect' },
    });
    tokens.set('apple', data.access_token, Date.now() + (data.expires_in ?? 3600) * 1000);
    return data.access_token;
  };
  const toApple = (l: ListingSnapshot) => ({
    displayNames: [{ name: l.name, primary: true }],
    mainAddress: { structuredAddress: { thoroughfare: l.address.line1, subPremise: l.address.line2, locality: l.address.city, administrativeArea: l.address.region, postCode: l.address.postalCode, countryCode: l.address.country } },
    phoneNumbers: l.phone ? [{ phoneNumber: l.phone, type: 'PRIMARY' }] : [],
    openingHoursByDay: l.hours.map((h) => ({ day: DAYS[h.day], times: [{ startTime: h.opens, endTime: h.closes }] })),
    specialHours: l.specialHours.map((s) => ({ startDate: s.date, endDate: s.date, closed: s.closed, ...(s.closed ? {} : { hoursByDay: [{ times: [{ startTime: s.opens, endTime: s.closes }] }] }) })),
    categories: [l.categories.primary, ...l.categories.additional].filter(Boolean),
    descriptions: l.description ? [{ text: l.description, type: 'ABOUT' }] : [],
    urls: [...(l.websiteUrl ? [{ url: l.websiteUrl, type: 'HOMEPAGE' }] : []), ...(l.bookingUrl ? [{ url: l.bookingUrl, type: 'RESERVATIONS' }] : [])],
    photos: l.photos.map((p) => ({ url: p.url, altText: p.alt })),
  });
  return {
    provider: 'apple',
    configured,
    async fetch(companyId, externalId) {
      try {
        const { data } = await requestJson<{ locationDetails?: ReturnType<typeof toApple> }>('Apple Business Connect', fetchImpl, `${base}/v1/companies/${encodeURIComponent(companyId)}/locations/${encodeURIComponent(externalId)}`, { headers: { Authorization: `Bearer ${await token()}` } });
        const d = data.locationDetails;
        if (!d) return null;
        const addr = d.mainAddress?.structuredAddress ?? {};
        return {
          name: d.displayNames?.[0]?.name ?? '', phone: d.phoneNumbers?.[0]?.phoneNumber ?? null,
          address: { line1: addr.thoroughfare ?? '', ...(addr.subPremise ? { line2: addr.subPremise } : {}), city: addr.locality ?? '', region: addr.administrativeArea, postalCode: addr.postCode, country: addr.countryCode ?? '' },
          hours: (d.openingHoursByDay ?? []).flatMap((x) => x.times.map((t) => ({ day: Math.max(0, DAYS.indexOf(x.day as (typeof DAYS)[number])), opens: t.startTime, closes: t.endTime }))),
          specialHours: (d.specialHours ?? []).map((x) => (x.closed ? { date: x.startDate, closed: true } : { date: x.startDate, closed: false, opens: x.hoursByDay?.[0]?.times[0]?.startTime ?? null, closes: x.hoursByDay?.[0]?.times[0]?.endTime ?? null })),
          categories: { primary: (d.categories?.[0] as string | undefined) ?? null, additional: (d.categories ?? []).slice(1) as string[] },
          description: d.descriptions?.[0]?.text ?? null,
          photos: (d.photos ?? []).map((p) => ({ url: p.url, kind: 'other' as const, alt: p.altText ?? '' })),
          websiteUrl: d.urls?.find((u) => u.type === 'HOMEPAGE')?.url ?? null, bookingUrl: d.urls?.find((u) => u.type === 'RESERVATIONS')?.url ?? null, attributes: {},
        };
      } catch (err) {
        if (err instanceof PartnerHttpError && err.status === 404) return null;
        throw err;
      }
    },
    async push(companyId, externalId, listing) {
      await requestJson('Apple Business Connect', fetchImpl, `${base}/v1/companies/${encodeURIComponent(companyId)}/locations/${encodeURIComponent(externalId)}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${await token()}` }, body: { locationDetails: toApple(listing) },
      });
    },
  };
}

/** Bing Places for Business (partner API, approval through Microsoft). The credential is the Bing store id prefix. */
export function createBingListings(cfg: Config, fetchImpl: FetchLike): ListingDirectory {
  const configured = !!cfg.BING_PLACES_API_KEY;
  const base = cfg.BING_PLACES_API_URL.replace(/\/$/, '');
  const headers = () => ({ 'Ocp-Apim-Subscription-Key': cfg.BING_PLACES_API_KEY ?? '' });
  const toBing = (l: ListingSnapshot) => ({
    BusinessName: l.name, AddressLine1: l.address.line1, AddressLine2: l.address.line2 ?? '', City: l.address.city, StateOrProvince: l.address.region ?? '', ZipCode: l.address.postalCode ?? '', Country: l.address.country,
    MainPhone: l.phone ?? '', Website: l.websiteUrl ?? '', Description: l.description ?? '', Categories: [l.categories.primary, ...l.categories.additional].filter(Boolean),
    HoursOfOperation: l.hours.map((h) => ({ Day: DAYS[h.day], Open: h.opens, Close: h.closes })), SpecialHours: l.specialHours.map((s) => ({ Date: s.date, Closed: s.closed, Open: s.opens ?? null, Close: s.closes ?? null })),
    Photos: l.photos.map((p) => p.url),
  });
  return {
    provider: 'bing',
    configured,
    async fetch(account, externalId) {
      try {
        const { data } = await requestJson<{ Business?: ReturnType<typeof toBing> }>('Bing Places', fetchImpl, `${base}/businesses/${encodeURIComponent(account)}/${encodeURIComponent(externalId)}`, { headers: headers() });
        const b = data.Business;
        if (!b) return null;
        return {
          name: b.BusinessName, phone: b.MainPhone || null, address: { line1: b.AddressLine1, ...(b.AddressLine2 ? { line2: b.AddressLine2 } : {}), city: b.City, region: b.StateOrProvince || undefined, postalCode: b.ZipCode || undefined, country: b.Country },
          hours: b.HoursOfOperation.map((h) => ({ day: Math.max(0, DAYS.indexOf(h.Day as (typeof DAYS)[number])), opens: h.Open, closes: h.Close })),
          specialHours: b.SpecialHours.map((s) => (s.Closed ? { date: s.Date, closed: true } : { date: s.Date, closed: false, opens: s.Open, closes: s.Close })),
          categories: { primary: (b.Categories[0] as string | undefined) ?? null, additional: b.Categories.slice(1) as string[] }, description: b.Description || null,
          photos: b.Photos.map((url) => ({ url, kind: 'other' as const, alt: '' })), websiteUrl: b.Website || null, bookingUrl: null, attributes: {},
        };
      } catch (err) {
        if (err instanceof PartnerHttpError && err.status === 404) return null;
        throw err;
      }
    },
    async push(account, externalId, listing) {
      await requestJson('Bing Places', fetchImpl, `${base}/businesses/${encodeURIComponent(account)}/${encodeURIComponent(externalId)}`, { method: 'PUT', headers: headers(), body: { Business: toBing(listing) } });
    },
  };
}

export function createListingDirectories(cfg: Config, fetchImpl: FetchLike): Record<ListingProvider, ListingDirectory> {
  return { google: createGoogleListings(cfg, fetchImpl), apple: createAppleListings(cfg, fetchImpl), bing: createBingListings(cfg, fetchImpl) };
}

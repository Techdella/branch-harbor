/** Real Estate public data (GET /v1/public/realty/*). No mock fallback — API failures show the error page. */
import { apiGet } from './api';
import type { Money } from './types';

export type AreaUnit = 'sqft' | 'sqm';
export interface AreaView { value: number; unit: AreaUnit; label: string; sqm: number }
export interface Media { url: string; caption?: string | null; alt?: string | null }

export interface ListingCard {
  id: string;
  reference: string;
  title: string;
  transaction: 'sale' | 'rent';
  propertyType: string;
  status: 'coming_soon' | 'active' | 'under_offer';
  price: Money;
  rentPeriod: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  area: AreaView | null;
  officeAreaUnit: AreaUnit;
  city: string;
  region: string | null;
  country: string;
  addressLines: string[];
  photo: Media | null;
  photoCount: number;
  publishedAt: string | null;
  office?: { id: string; slug: string; name: string; timeZone: string };
}

export interface SearchResult {
  total: number;
  items: ListingCard[];
  facets: { currencies: string[]; cities: string[]; offices: Array<{ slug: string; name: string; city: string; country: string; currency: string; areaUnit: AreaUnit | null }> };
  excluded: { otherCurrency: number; note: string | null };
}

export interface PublicAgent { id: string; name: string; title: string | null; photoUrl: string | null; phone: string | null; email: string | null; licenceNumber: string | null; languages: string[]; bio: string | null }

export interface ListingPage {
  listing: ListingCard & {
    description: string | null;
    features: string[];
    photos: Media[];
    floorPlans: Media[];
    virtualTourUrl: string | null;
    areaAlt: AreaView | null;
    lot: AreaView | null;
    yearBuilt: number | null;
    geo: { lat: number; lng: number } | null;
    hideStreet: boolean;
    disclosures: Array<{ key: string; label: string; text: string }>;
    brokerageLicence: string | null;
  };
  agents: PublicAgent[];
  openHouses: Array<{ id: string; startsAt: string; endsAt: string }>;
  office: { id: string; slug: string; name: string; phone: string | null; email: string | null; timeZone: string; currency: string; locale: string; addressLines: string[]; areaUnit: AreaUnit; viewingMinutes: number };
  brand: { name: string; slug: string };
}

export interface OfficePage {
  office: { id: string; slug: string; name: string; phone: string | null; email: string | null; timeZone: string; currency: string; addressLines: string[]; areaUnit: AreaUnit; brokerageLicence: string | null; disclosures: Array<{ key: string; label: string; text: string }> };
  agents: PublicAgent[];
  listings: ListingCard[];
}

export const searchListings = (brand: string, qs: URLSearchParams) => apiGet<SearchResult>(`/v1/public/realty/${encodeURIComponent(brand)}/listings?${qs.toString()}`);
export const getListingPage = (id: string, unit?: string) => apiGet<ListingPage>(`/v1/public/realty/listings/${encodeURIComponent(id)}${unit ? `?areaUnit=${unit}` : ''}`);
export const getOfficePage = (brand: string, office: string) => apiGet<OfficePage>(`/v1/public/realty/${encodeURIComponent(brand)}/offices/${encodeURIComponent(office)}`);

/** Major → minor units (prices typed by visitors). */
export const toMinor = (major: number, currency: string) => Math.round(major * (currency === 'JPY' ? 1 : 100));
export const PROPERTY_TYPES = ['house', 'townhouse', 'apartment', 'condo', 'land', 'commercial', 'other'] as const;

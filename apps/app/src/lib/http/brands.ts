/**
 * Multi-brand HQ: brands of the selected business, the top-bar brand filter and the brand screens' API calls.
 *
 * The brand filter is sent as `X-BH-Brand` on every request for the selected business (see client.ts); the API
 * narrows lists, reports, KPIs, the league table and campaigns to that brand. "All brands" sends nothing. People
 * scoped to one brand only ever see that brand, whatever is sent.
 */
import type { Currency } from '@bh/shared';
import { http } from './client';

export interface ApiBrand {
  id: string;
  name: string;
  slug: string | null;
  isDefault: boolean;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  headingFont: string | null;
  bodyFont: string | null;
  themeId: string | null;
  tagline: string | null;
  domain: string | null;
  locales: string[];
  defaultCurrency: Currency | null;
  emailFromName: string | null;
  emailReplyTo: string | null;
  onboardingTemplateKey: string | null;
  siteTemplateId: string | null;
  emailTemplateId: string | null;
  assetFolder: string | null;
  locationCount: number;
}

export interface BrandList {
  items: ApiBrand[];
  /** The business runs more than one brand (single-brand businesses show no brand UI). */
  multiBrand: boolean;
  canManage: boolean;
}

export type BrandInput = Partial<Omit<ApiBrand, 'id' | 'isDefault' | 'locationCount'>>;

export interface CurrencyRevenue {
  currency: Currency;
  grossMinor: number;
  refundedMinor: number;
  netMinor: number;
  paymentCount: number;
}

export interface BrandComparison {
  period: { days: number; from: string };
  multiBrand: boolean;
  network: { brands: number; locations: number; operating: number; revenueByCurrency: CurrencyRevenue[] | null; combinedRevenue: null; openProspects: number | null };
  brands: {
    id: string;
    name: string;
    slug: string | null;
    isDefault: boolean;
    primaryColor: string | null;
    logoUrl: string | null;
    locations: { total: number; operating: number; opening: number };
    currencies: Currency[];
    revenue: CurrencyRevenue[] | null;
    pipeline: { open: number; signed: number; availableTerritories: number } | null;
    activeAgreements: number | null;
    terms: { currency: Currency; royaltyBps: number; marketingFundBps: number; source: 'brand' | 'organization' }[] | null;
  }[];
}

export interface BrandFranchiseTerms {
  brandId: string;
  disclosureDocuments: { id: string; title: string; version: string; jurisdictions: string[]; status: string; shared: boolean }[] | null;
  agreementTemplates: { id: string; title: string; version: string; status: string; shared: boolean }[] | null;
  royaltyTerms: { id: string; currency: Currency; royaltyBps: number; marketingFundBps: number; effectiveFrom: string; effectiveTo: string | null }[] | null;
  onboardingTemplateKey: string;
}

/* ---------------- brand filter ---------------- */

const KEY = 'bh_brand_filter';
let current: { orgId: string; brandId: string } | null = null;

function read(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** The brand the app is filtered to for this business (null = all brands). */
export function storedBrandFilter(orgId: string): string | null {
  return read()[orgId] ?? null;
}

/** Sets (or clears) the brand filter for a business; requests for it carry the brand from now on. */
export function setBrandFilter(orgId: string, brandId: string | null) {
  current = brandId ? { orgId, brandId } : null;
  try {
    const all = read();
    if (brandId) all[orgId] = brandId;
    else delete all[orgId];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the filter lasts for this page */
  }
}

/** Header for a request path: only requests for the filtered business carry the brand. */
export function brandHeaderFor(path: string): Record<string, string> {
  if (!current || !path.startsWith(`/orgs/${current.orgId}/`)) return {};
  return { 'X-BH-Brand': current.brandId };
}

/* ---------------- API ---------------- */

export const brandsApi = {
  list: (orgId: string) => http.get<BrandList>(`/orgs/${orgId}/brands`),
  create: (orgId: string, input: BrandInput & { name: string }) => http.post<ApiBrand>(`/orgs/${orgId}/brands`, input),
  update: (orgId: string, id: string, input: BrandInput) => http.patch<ApiBrand>(`/orgs/${orgId}/brands/${id}`, input),
  archive: (orgId: string, id: string) => http.del<{ ok: true }>(`/orgs/${orgId}/brands/${id}`),
  comparison: (orgId: string, days = 30) => http.get<BrandComparison>(`/orgs/${orgId}/brands/comparison`, { days }),
  franchiseTerms: (orgId: string, id: string) => http.get<BrandFranchiseTerms>(`/orgs/${orgId}/brands/${id}/franchise-terms`),
  setLocationBrand: (orgId: string, locationId: string, brandId: string) => http.put<{ id: string; brandId: string }>(`/orgs/${orgId}/locations/${locationId}/brand`, { brandId }),
};

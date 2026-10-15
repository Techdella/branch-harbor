import type { PageDocument, ResolvedTheme } from '@bh/shared';

export interface Money { amount: number; currency: string }

export interface Theme {
  primary: string;
  brandColor: string;
  onPrimary: string;
  primaryInk: string;
  primaryContrast: number;
  font: string;
  logoUrl: string | null;
  heroImageUrl: string | null;
  /** Website builder theme (absent on older APIs). */
  themeId?: string;
  site?: ResolvedTheme;
}

export interface Brand {
  name: string;
  slug: string;
  industry: 'studios' | 'sports' | 'wellness' | 'commerce' | 'foods' | 'realty' | string;
  country: string;
  defaultLocale: string;
  locales: string[];
  tagline: string | null;
  poweredBy: boolean;
  theme: Theme;
  /** independent: the brand site is the location site (no finder). Absent on older APIs = network. */
  model?: 'independent' | 'network';
}

export interface PublishedPage {
  slug: string;
  title: string;
  seo: { title: string | null; description: string | null; canonicalOwner: 'branchharbor' | 'external'; socialImage?: string | null; noindex?: boolean };
  content: Record<string, unknown>;
  version: number;
  publishedAt: string;
  /** Website builder document of the published version (null/absent = classic field page). */
  document?: PageDocument | null;
  nav?: { label: string; show: boolean; order: number };
}

export interface WeeklyHours { day: number; opens: string; closes: string }

export interface Address { line1: string; line2?: string; city: string; region?: string; postalCode?: string; country: string }

export interface LocationSummary {
  id: string;
  slug: string;
  name: string;
  address: Address;
  country: string;
  timeZone: string;
  currency: string;
  locale: string;
  phone: string | null;
  email: string | null;
  status: string;
  geo: { lat: number; lng: number } | null;
  hours: { summary: string | null; weekly: WeeklyHours[] | null };
  openNow: { open: boolean; closesAt: string | null } | null;
  path: string;
}

export interface BrandSite {
  brand: Brand;
  pages: PublishedPage[];
  site: { includedAddress: string; primaryHost: string | null; singleLocationSlug?: string | null };
  locations: Array<LocationSummary & { primaryHost: string | null; pages: Array<{ slug: string; publishedAt: string | null }> }>;
}

export interface LocationSite {
  brand: Brand;
  location: LocationSummary;
  pages: PublishedPage[];
  module: {
    kind: string;
    mode: 'native' | 'external';
    externalProvider: string | null;
    externalUrl: string | null;
    paymentsEnabled: boolean;
    payAtPickup: boolean;
    sandboxPayments: boolean;
  };
  site: { includedAddress: string; primaryHost: string | null; brandPrimaryHost: string | null; locationCount: number; singleLocation?: boolean; navLinks?: Array<{ label: string; href: string }> };
}

export interface ScheduleItem {
  id: string;
  classType: { id: string; name: string; description: string | null };
  startsAt: string;
  endsAt: string;
  instructorName: string | null;
  room: string | null;
  online: boolean;
  capacity: number;
  spotsLeft: number;
  price: Money;
  status: 'available' | 'full' | 'cancelled' | 'unavailable';
  action: 'book' | 'join_waitlist' | null;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  image: string | null;
  variants: Array<{ id: string; name: string; options: Record<string, string>; price: Money | null; availability: 'in_stock' | 'low_stock' | 'out_of_stock' | 'not_stocked' }>;
}

export interface Programme {
  id: string;
  name: string;
  description: string | null;
  ageMin: number | null;
  ageMax: number | null;
  ageCutoffDate: string | null;
  fee: Money;
  spotsLeft: number | null;
  requiresApproval: boolean;
  refundPolicy: string | null;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  kind?: string;
  eligibilityNotes?: string | null;
  siblingDiscountPercent?: number;
  age?: { rule: 'age_on_date' | 'birth_year'; cutoffDate: string; birthDates: { from: string | null; to: string | null } };
  season?: { id: string; name: string; startsOn: string; endsOn: string } | null;
  venues?: { id: string; name: string; kind: string }[];
  paymentOptions?: { id: string; name: string; kind: 'full' | 'instalments'; instalments: { seq: number; dueOn: string; amountMinor: number }[] }[];
  questions?: { key: string; label: string; type: string; required: boolean; options: string[] | null; category: string; help: string | null; restricted: boolean }[];
}

/**
 * Internationalisation primitives. BranchHarbor is built for an international audience:
 * every user-facing string is translated, every amount keeps its currency, every time is
 * stored in UTC and shown in the location's timezone.
 */

export const SUPPORTED_LOCALES = ['en', 'en-GB', 'fr', 'es', 'de', 'pt-BR', 'nl', 'it', 'ar'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const RTL_LOCALES: readonly Locale[] = ['ar'];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English (US)',
  'en-GB': 'English (UK)',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  'pt-BR': 'Português (Brasil)',
  nl: 'Nederlands',
  it: 'Italiano',
  ar: 'العربية',
};

export function isRtl(locale: string): boolean {
  return RTL_LOCALES.includes(locale as Locale);
}

export function resolveLocale(input: string | null | undefined): Locale {
  if (!input) return DEFAULT_LOCALE;
  const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === input.toLowerCase());
  if (exact) return exact;
  const base = input.split('-')[0]?.toLowerCase();
  return SUPPORTED_LOCALES.find((l) => l.toLowerCase() === base) ?? DEFAULT_LOCALE;
}

/** Launch markets. Payment/tax availability per country is validated against providers at runtime. */
export const LAUNCH_COUNTRIES = [
  { code: 'US', name: 'United States', currency: 'USD', locale: 'en', region: 'NA' },
  { code: 'CA', name: 'Canada', currency: 'CAD', locale: 'en', region: 'NA' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', locale: 'en-GB', region: 'EU' },
  { code: 'IE', name: 'Ireland', currency: 'EUR', locale: 'en-GB', region: 'EU' },
  { code: 'DE', name: 'Germany', currency: 'EUR', locale: 'de', region: 'EU' },
  { code: 'FR', name: 'France', currency: 'EUR', locale: 'fr', region: 'EU' },
  { code: 'ES', name: 'Spain', currency: 'EUR', locale: 'es', region: 'EU' },
  { code: 'NL', name: 'Netherlands', currency: 'EUR', locale: 'nl', region: 'EU' },
  { code: 'IT', name: 'Italy', currency: 'EUR', locale: 'it', region: 'EU' },
  { code: 'AU', name: 'Australia', currency: 'AUD', locale: 'en-GB', region: 'APAC' },
  { code: 'NZ', name: 'New Zealand', currency: 'NZD', locale: 'en-GB', region: 'APAC' },
  { code: 'SG', name: 'Singapore', currency: 'SGD', locale: 'en-GB', region: 'APAC' },
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED', locale: 'en-GB', region: 'MEA' },
  { code: 'BR', name: 'Brazil', currency: 'BRL', locale: 'pt-BR', region: 'LATAM' },
  { code: 'MX', name: 'Mexico', currency: 'MXN', locale: 'es', region: 'LATAM' },
] as const;
export type CountryCode = (typeof LAUNCH_COUNTRIES)[number]['code'];

/** Data residency region for tenant data. Chosen at organisation creation. */
export const DATA_REGIONS = ['us', 'eu', 'apac'] as const;
export type DataRegion = (typeof DATA_REGIONS)[number];

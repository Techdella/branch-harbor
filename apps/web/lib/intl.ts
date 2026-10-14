/**
 * Locale used for Intl number/currency formatting.
 *
 * Arabic uses Western (Latin) digits across the site: copy in messages/ar.json writes figures such
 * as times, prices and counts in Latin digits (common practice for Gulf and international
 * product sites), so formatted numbers must match rather than switch to Arabic-Indic digits.
 * Text direction, grouping and currency placement still follow Arabic conventions.
 */
export function numberLocale(locale: string): string {
  return locale === 'ar' ? 'ar-u-nu-latn' : locale;
}

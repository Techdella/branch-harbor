/** UI languages offered in the app. English is complete; others fall back to English per key. */
export const APP_LOCALES = ['en', 'fr', 'es', 'de', 'pt-BR'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];
export const DEFAULT_APP_LOCALE: AppLocale = 'en';
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export const APP_LOCALE_LABELS: Record<AppLocale, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  'pt-BR': 'Português (Brasil)',
};

export function resolveAppLocale(input: string | null | undefined): AppLocale {
  if (!input) return DEFAULT_APP_LOCALE;
  const exact = APP_LOCALES.find((l) => l.toLowerCase() === input.toLowerCase());
  if (exact) return exact;
  const base = input.split(/[-_]/)[0]?.toLowerCase();
  if (base === 'pt') return 'pt-BR';
  return APP_LOCALES.find((l) => l.toLowerCase() === base) ?? DEFAULT_APP_LOCALE;
}

import { defineRouting } from 'next-intl/routing';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '@bh/shared';

export const routing = defineRouting({
  locales: SUPPORTED_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'always',
});

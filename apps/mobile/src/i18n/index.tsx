import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nManager } from 'react-native';
import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';
import { isRtl } from '@bh/shared';
import en from './en';
import fr from './fr';
import es from './es';
import de from './de';
import ptBR from './ptBR';
import { storage } from '@/lib/storage';
import { foodsxDe, foodsxEn, foodsxEs, foodsxFr, foodsxPt } from '@/features/foods/i18n';

export const APP_LOCALES = ['en', 'fr', 'es', 'de', 'pt-BR'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];
export const APP_LOCALE_LABELS: Record<AppLocale, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  'pt-BR': 'Português (Brasil)',
};

const i18n = new I18n({ en, fr, es, de, 'pt-BR': ptBR });
i18n.store({ en: { foodsx: foodsxEn }, fr: { foodsx: foodsxFr }, es: { foodsx: foodsxEs }, de: { foodsx: foodsxDe }, 'pt-BR': { foodsx: foodsxPt } });
i18n.enableFallback = true;
i18n.defaultLocale = 'en';

export function resolveAppLocale(tag: string | null | undefined): AppLocale {
  if (!tag) return 'en';
  const exact = APP_LOCALES.find((l) => l.toLowerCase() === tag.toLowerCase());
  if (exact) return exact;
  const base = tag.split('-')[0]?.toLowerCase();
  if (base === 'pt') return 'pt-BR';
  return APP_LOCALES.find((l) => l === base) ?? 'en';
}

function deviceLocale(): AppLocale {
  try {
    return resolveAppLocale(getLocales()[0]?.languageTag);
  } catch {
    return 'en';
  }
}

export type TFn = (key: string, opts?: Record<string, unknown>) => string;

interface I18nCtx {
  locale: AppLocale;
  /** BCP-47 tag for Intl formatting (device region is kept when it matches the language). */
  intlLocale: string;
  setLocale: (l: AppLocale) => void;
  t: TFn;
  rtl: boolean;
}

const Ctx = createContext<I18nCtx | null>(null);
const KEY = 'bh.locale';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(deviceLocale);

  useEffect(() => {
    storage.get(KEY).then((v) => {
      if (v) setLocaleState(resolveAppLocale(v));
    });
  }, []);

  const setLocale = useCallback((l: AppLocale) => {
    setLocaleState(l);
    void storage.set(KEY, l);
  }, []);

  const value = useMemo<I18nCtx>(() => {
    i18n.locale = locale;
    let intlLocale: string = locale;
    try {
      const device = getLocales()[0];
      // Device tags can carry POSIX suffixes ("en-US@posix") that Intl rejects; keep only valid BCP 47 tags.
      const tag = device?.languageTag?.split('@')[0];
      if (device?.languageCode && locale.startsWith(device.languageCode) && tag) intlLocale = Intl.getCanonicalLocales(tag)[0] ?? locale;
    } catch {
      /* keep app locale */
    }
    const t: TFn = (key, opts) => i18n.t(key, { locale, ...opts });
    // Layouts use start/end so they mirror correctly; native direction changes need a reload.
    const rtl = isRtl(locale) || I18nManager.isRTL;
    return { locale, intlLocale, setLocale, t, rtl };
  }, [locale, setLocale]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useI18n must be used inside I18nProvider');
  return c;
}

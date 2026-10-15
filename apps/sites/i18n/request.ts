import { getRequestConfig } from 'next-intl/server';
import en from '../messages/en.json';
import foodsEn from '../messages/foods/en.json';
import paymentsEn from '../messages/payments/en.json';
import franchiseEn from '../messages/franchise/en.json';
import coursesEn from '../messages/courses/en.json';
import builderEn from '../messages/builder/en.json';
import reviewsEn from '../messages/reviews/en.json';
import { resolveSiteLocale } from '../lib/site';

type Messages = Record<string, unknown>;

const pair = (a: Promise<{ default: unknown }>, b: Promise<{ default: unknown }>) =>
  Promise.all([a, b]).then(([x, y]) => ({ default: mergeMessages(x.default as Messages, y.default as Messages) }));
const trio = (a: Promise<{ default: unknown }>, b: Promise<{ default: unknown }>, c: Promise<{ default: unknown }>) =>
  Promise.all([pair(a, b), c]).then(([x, y]) => ({ default: mergeMessages(x.default, y.default as Messages) }));

/**
 * Every platform locale (@bh/shared SUPPORTED_LOCALES) has complete UI strings — `pnpm check:messages` enforces it.
 * The English merge below stays as a safety net for keys added before their translations land.
 */
const loaders: Record<string, () => Promise<{ default: Messages }>> = {
  'en-GB': () => trio(import('../messages/en-GB.json'), import('../messages/foods/en-GB.json'), import('../messages/payments/en-GB.json')),
  fr: () => trio(import('../messages/fr.json'), import('../messages/foods/fr.json'), import('../messages/payments/fr.json')),
  es: () => trio(import('../messages/es.json'), import('../messages/foods/es.json'), import('../messages/payments/es.json')),
  de: () => trio(import('../messages/de.json'), import('../messages/foods/de.json'), import('../messages/payments/de.json')),
  'pt-BR': () => trio(import('../messages/pt-BR.json'), import('../messages/foods/pt-BR.json'), import('../messages/payments/pt-BR.json')),
  nl: () => trio(import('../messages/nl.json'), import('../messages/foods/nl.json'), import('../messages/payments/nl.json')),
  it: () => trio(import('../messages/it.json'), import('../messages/foods/it.json'), import('../messages/payments/it.json')),
  ar: () => trio(import('../messages/ar.json'), import('../messages/foods/ar.json'), import('../messages/payments/ar.json')),
};

/** "Own a franchise" module, disclosure receipt and agreement signing (messages/franchise/*.json, namespace franchiseSite). */
const franchiseLoaders: Record<string, () => Promise<{ default: unknown }>> = {
  'en-GB': () => import('../messages/franchise/en-GB.json'),
  fr: () => import('../messages/franchise/fr.json'),
  es: () => import('../messages/franchise/es.json'),
  de: () => import('../messages/franchise/de.json'),
  'pt-BR': () => import('../messages/franchise/pt-BR.json'),
  nl: () => import('../messages/franchise/nl.json'),
  it: () => import('../messages/franchise/it.json'),
  ar: () => import('../messages/franchise/ar.json'),
};

/** Hosted review page (namespace "reviewPage", messages/reviews/*.json). */
const reviewLoaders: Record<string, () => Promise<{ default: unknown }>> = {
  'en-GB': () => import('../messages/reviews/en-GB.json'),
  fr: () => import('../messages/reviews/fr.json'),
  es: () => import('../messages/reviews/es.json'),
  de: () => import('../messages/reviews/de.json'),
  'pt-BR': () => import('../messages/reviews/pt-BR.json'),
  nl: () => import('../messages/reviews/nl.json'),
  it: () => import('../messages/reviews/it.json'),
  ar: () => import('../messages/reviews/ar.json'),
};

/** Website builder strings (namespace "builder", messages/builder/*.json). */
const builderLoaders: Record<string, () => Promise<{ default: unknown }>> = {
  'en-GB': () => import('../messages/builder/en-GB.json'),
  fr: () => import('../messages/builder/fr.json'),
  es: () => import('../messages/builder/es.json'),
  de: () => import('../messages/builder/de.json'),
  'pt-BR': () => import('../messages/builder/pt-BR.json'),
  nl: () => import('../messages/builder/nl.json'),
  it: () => import('../messages/builder/it.json'),
  ar: () => import('../messages/builder/ar.json'),
};

const isObject = (v: unknown): v is Messages => typeof v === 'object' && v !== null && !Array.isArray(v);

export function mergeMessages(base: Messages, override: Messages): Messages {
  const out: Messages = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const b = base[k];
    out[k] = isObject(b) && isObject(v) ? mergeMessages(b, v) : v;
  }
  return out;
}

export async function messagesFor(locale: string): Promise<Messages> {
  const load = loaders[locale] ?? loaders[locale.split('-')[0]!];
  const franchise = franchiseLoaders[locale] ?? franchiseLoaders[locale.split('-')[0]!];
  const builder = builderLoaders[locale] ?? builderLoaders[locale.split('-')[0]!];
  const review = reviewLoaders[locale] ?? reviewLoaders[locale.split('-')[0]!];
  const base = mergeMessages(mergeMessages(mergeMessages(mergeMessages(mergeMessages(mergeMessages(en as Messages, foodsEn as Messages), paymentsEn as Messages), franchiseEn as Messages), coursesEn as Messages), builderEn as Messages), reviewsEn as Messages);
  const local = load ? (await load()).default : {};
  // Public courses (Training academy): messages/courses/*.json.
  const courseLocale = loaders[locale] ? locale : locale.split('-')[0]!;
  const courses = loaders[courseLocale] ? ((await import(`../messages/courses/${courseLocale}.json`)).default as Messages) : {};
  const withBuilder0 = builder ? mergeMessages(base, (await builder()).default as Messages) : base;
  const withBuilder = review ? mergeMessages(withBuilder0, (await review()).default as Messages) : withBuilder0;
  return mergeMessages(mergeMessages(withBuilder, franchise ? mergeMessages(local, (await franchise()).default as Messages) : local), courses);
}

export default getRequestConfig(async () => {
  const { locale } = await resolveSiteLocale();
  return {
    locale,
    messages: await messagesFor(locale),
    onError() {
      /* Missing keys fall back to English via the merge above. */
    },
  };
});

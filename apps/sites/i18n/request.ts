import { getRequestConfig } from 'next-intl/server';
import en from '../messages/en.json';
import foodsEn from '../messages/foods/en.json';
import paymentsEn from '../messages/payments/en.json';
import coursesEn from '../messages/courses/en.json';
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
  const base = mergeMessages(mergeMessages(mergeMessages(en as Messages, foodsEn as Messages), paymentsEn as Messages), coursesEn as Messages);
  // Public courses (Training academy): messages/courses/*.json.
  const courseLocale = loaders[locale] ? locale : locale.split('-')[0]!;
  const courses = loaders[courseLocale] ? ((await import(`../messages/courses/${courseLocale}.json`)).default as Messages) : {};
  return mergeMessages(mergeMessages(base, load ? (await load()).default : {}), courses);
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

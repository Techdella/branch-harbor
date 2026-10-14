import { getRequestConfig } from 'next-intl/server';
import en from '../messages/en.json';
import foodsEn from '../messages/foods/en.json';
import { resolveSiteLocale } from '../lib/site';

type Messages = Record<string, unknown>;

const pair = (a: Promise<{ default: unknown }>, b: Promise<{ default: unknown }>) =>
  Promise.all([a, b]).then(([x, y]) => ({ default: mergeMessages(x.default as Messages, y.default as Messages) }));

/**
 * Every platform locale (@bh/shared SUPPORTED_LOCALES) has complete UI strings — `pnpm check:messages` enforces it.
 * The English merge below stays as a safety net for keys added before their translations land.
 */
const loaders: Record<string, () => Promise<{ default: Messages }>> = {
  'en-GB': () => pair(import('../messages/en-GB.json'), import('../messages/foods/en-GB.json')),
  fr: () => pair(import('../messages/fr.json'), import('../messages/foods/fr.json')),
  es: () => pair(import('../messages/es.json'), import('../messages/foods/es.json')),
  de: () => pair(import('../messages/de.json'), import('../messages/foods/de.json')),
  'pt-BR': () => pair(import('../messages/pt-BR.json'), import('../messages/foods/pt-BR.json')),
  nl: () => pair(import('../messages/nl.json'), import('../messages/foods/nl.json')),
  it: () => pair(import('../messages/it.json'), import('../messages/foods/it.json')),
  ar: () => pair(import('../messages/ar.json'), import('../messages/foods/ar.json')),
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
  return mergeMessages(mergeMessages(en as Messages, foodsEn as Messages), load ? (await load()).default : {});
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

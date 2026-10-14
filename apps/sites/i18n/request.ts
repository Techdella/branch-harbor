import { getRequestConfig } from 'next-intl/server';
import en from '../messages/en.json';
import foodsEn from '../messages/foods/en.json';
import { resolveSiteLocale } from '../lib/site';

type Messages = Record<string, unknown>;

/** UI strings with their own translations. Other enabled languages use English UI text but their own date/number formats. */
const loaders: Record<string, () => Promise<{ default: Messages }>> = {
  fr: () => Promise.all([import('../messages/fr.json'), import('../messages/foods/fr.json')]).then(([a, b]) => ({ default: mergeMessages(a.default as Messages, b.default as Messages) })),
  de: () => Promise.all([import('../messages/de.json'), import('../messages/foods/de.json')]).then(([a, b]) => ({ default: mergeMessages(a.default as Messages, b.default as Messages) })),
  es: () => Promise.all([import('../messages/es.json'), import('../messages/foods/es.json')]).then(([a, b]) => ({ default: mergeMessages(a.default as Messages, b.default as Messages) })),
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

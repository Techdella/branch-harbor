import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';
import en from '../messages/en.json';

type Messages = Record<string, unknown>;

/** Locales with their own message files. Everything else (and every missing key) falls back to English. */
const loaders: Record<string, () => Promise<{ default: Messages }>> = {
  fr: () => import('../messages/fr.json'),
  es: () => import('../messages/es.json'),
  de: () => import('../messages/de.json'),
  'pt-BR': () => import('../messages/pt-BR.json'),
};

function isObject(v: unknown): v is Messages {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge translated messages over English so missing keys fall back per key. Arrays are replaced whole. */
export function mergeMessages(base: Messages, override: Messages): Messages {
  const out: Messages = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const b = base[k];
    out[k] = isObject(b) && isObject(v) ? mergeMessages(b, v) : v;
  }
  return out;
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const load = loaders[locale];
  const translated = load ? (await load()).default : {};
  return {
    locale,
    messages: mergeMessages(en as Messages, translated),
    onError() {
      /* Missing keys fall back to English via the merge above. */
    },
  };
});

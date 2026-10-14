import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';
import en from '../messages/en.json';

type Messages = Record<string, unknown>;

/**
 * Every supported locale has a complete message file (verified by `pnpm check:messages`). The deep
 * merge over English below is a safety net so a key added to en.json never renders as a raw key.
 */
const loaders: Record<string, () => Promise<{ default: Messages }>> = {
  'en-GB': () => import('../messages/en-GB.json'),
  fr: () => import('../messages/fr.json'),
  es: () => import('../messages/es.json'),
  de: () => import('../messages/de.json'),
  'pt-BR': () => import('../messages/pt-BR.json'),
  nl: () => import('../messages/nl.json'),
  it: () => import('../messages/it.json'),
  ar: () => import('../messages/ar.json'),
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

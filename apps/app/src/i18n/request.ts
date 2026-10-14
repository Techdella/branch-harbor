import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, resolveAppLocale } from './config';
import en from '../../messages/en.json';
import singleEn from '../../messages/single/en.json';
import foodsEn from '../../messages/foods/en.json';

type Messages = Record<string, unknown>;

/** Deep-merge so any key missing in a translation falls back to English. */
function merge(base: Messages, over: Messages): Messages {
  const out: Messages = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = base[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' ? merge(b as Messages, v as Messages) : v;
  }
  return out;
}

export default getRequestConfig(async () => {
  const store = await cookies();
  let raw = store.get(LOCALE_COOKIE)?.value;
  if (!raw) {
    const accept = (await headers()).get('accept-language') ?? '';
    raw = accept.split(',')[0]?.split(';')[0];
  }
  const locale = resolveAppLocale(raw);
  // Independent-business strings live in messages/single/*.json (namespace "single") and foods strings in
  // messages/foods/*.json so they merge cleanly.
  let messages: Messages = merge({ ...(en as Messages), single: singleEn as Messages }, foodsEn as Messages);
  if (locale !== 'en') {
    const translated = (await import(`../../messages/${locale}.json`)).default as Messages;
    const single = (await import(`../../messages/single/${locale}.json`)).default as Messages;
    messages = merge(messages, { ...translated, single });
    messages = merge(messages, (await import(`../../messages/foods/${locale}.json`)).default as Messages);
  }
  return { locale, messages, timeZone: 'UTC' };
});

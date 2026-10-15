/**
 * Strings needed where next-intl is not available: the root error page and browser-side network failures
 * from the API clients (lib/client.ts, lib/portal.ts, lib/shop.ts). Kept small; checked with the other catalogues.
 */
import { resolveLocale } from '@bh/shared';
import en from '../messages/fallback/en.json';
import enGB from '../messages/fallback/en-GB.json';
import fr from '../messages/fallback/fr.json';
import es from '../messages/fallback/es.json';
import de from '../messages/fallback/de.json';
import ptBR from '../messages/fallback/pt-BR.json';
import nl from '../messages/fallback/nl.json';
import it from '../messages/fallback/it.json';
import ar from '../messages/fallback/ar.json';

export type FallbackMessages = typeof en;
const MESSAGES: Record<string, FallbackMessages> = { en, 'en-GB': enGB, fr, es, de, 'pt-BR': ptBR, nl, it, ar };

export function fallbackMessages(locale: string | null | undefined): FallbackMessages {
  return MESSAGES[resolveLocale(locale)] ?? en;
}

type TextKey = { [K in keyof FallbackMessages]: FallbackMessages[K] extends string ? K : never }[keyof FallbackMessages];
const pageLang = () => (typeof document === 'undefined' ? 'en' : document.documentElement.lang);
const fill = (tpl: string, vars: Record<string, unknown>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

/** Text in the page's language (<html lang>), for code running in the browser. */
export function fallbackText(key: TextKey, vars: Record<string, string | number> = {}): string {
  return fill(fallbackMessages(pageLang())[key], vars);
}

/**
 * API errors in the page's language. The API sends a stable `code` (plus arguments in `details` for a few) and an
 * English `message`; known codes are phrased from the catalogue (`apiError.*`), anything else keeps the API's
 * message as the generic fallback. The original text stays available as `apiMessage`.
 */
export function localizeApiError<E extends { code: string; message: string; details?: Record<string, unknown> }>(error: E, lang = pageLang()): E & { apiMessage: string } {
  const tpl = (fallbackMessages(lang).apiError as Record<string, string>)[error.code];
  const d = error.details ?? {};
  const vars: Record<string, unknown> = { days: d.days, hours: d.freeCancelHours ?? d.hours };
  const complete = tpl && [...tpl.matchAll(/\{(\w+)\}/g)].every((m) => vars[m[1]!] !== undefined && vars[m[1]!] !== null);
  return { ...error, message: complete ? fill(tpl, vars) : error.message, apiMessage: error.message };
}

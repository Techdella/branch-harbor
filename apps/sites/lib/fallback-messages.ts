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

/** Text in the page's language (<html lang>), for code running in the browser. */
export function fallbackText(key: keyof FallbackMessages, vars: Record<string, string | number> = {}): string {
  const lang = typeof document === 'undefined' ? 'en' : document.documentElement.lang;
  return fallbackMessages(lang)[key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

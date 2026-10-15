import en from '@/i18n/en';
import { tNow } from '@/i18n/current';

/** Error shape returned by apps/api: { error: { code, message, fields } }. */
export class ApiError extends Error {
  code: string;
  status: number;
  fields?: Record<string, string>;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
  get isNetwork() {
    return this.code === 'network_error';
  }
}


/**
 * The API sends a stable `code` (with arguments in `details` for a few) and an English `message`. Known codes are
 * phrased from the catalogue (`apiError.*`) in the app's language; anything else keeps the API's message.
 */
export function localizedApiMessage(code: string, message: string, details?: Record<string, unknown>): string {
  const tpl = (en.apiError as Record<string, string>)[code];
  if (!tpl) return message;
  const d = details ?? {};
  const vars: Record<string, unknown> = { days: d.days, hours: d.freeCancelHours ?? d.hours };
  if ([...tpl.matchAll(/%\{(\w+)\}/g)].some((m) => vars[m[1]!] === undefined || vars[m[1]!] === null)) return message;
  return tNow(`apiError.${code}`, message, vars);
}

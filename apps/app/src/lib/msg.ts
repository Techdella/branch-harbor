/**
 * Text the data layer (mock and live) builds for the UI is carried as catalogue keys plus structured arguments, and
 * translated in the components with next-intl (namespace "data", messages/data/*.json). The plain English string
 * that sits next to each key in the view models is only the fallback for keys the catalogue doesn't have (for
 * example free text the API sent). Proper nouns and business data (names, places, references) are passed as
 * plain string arguments and are never translated.
 */

/** A nested translatable argument: a catalogue key (namespace "data") with its own arguments and English fallback. */
export interface MsgRef {
  t: 'msg';
  key: string;
  params?: MsgParams;
  /** English fallback when the key is missing. */
  text?: string;
}
/** A date/time argument, formatted in the viewer's locale (and the location's time zone when given). */
export interface DateParam {
  t: 'date';
  at: string;
  tz?: string;
  style?: 'date' | 'dateTime' | 'dayTime' | 'dayMonth' | 'monthYear' | 'weekday' | 'time' | 'zone';
}
/** An amount in minor units, formatted in the viewer's locale. */
export interface MoneyParam {
  t: 'money';
  amount: number;
  currency: string;
}
export type MsgParam = string | number | MsgRef | DateParam | MoneyParam | MsgRef[] | string[] | MoneyParam[];
export type MsgParams = Record<string, MsgParam>;

/** Builders used by the data layer. */
export const ref = (key: string, params?: MsgParams, text?: string): MsgRef => ({ t: 'msg', key, ...(params ? { params } : {}), ...(text ? { text } : {}) });
export const dateArg = (at: string, tz?: string, style: DateParam['style'] = 'date'): DateParam => ({ t: 'date', at, tz, style });
export const moneyArg = (amount: number, currency: string): MoneyParam => ({ t: 'money', amount, currency });

/** Role assignment keys shared by mock and live members. */
export const ROLE_KEYS = ['org_owner', 'hq_admin', 'regional_manager', 'franchise_owner', 'location_manager', 'staff', 'marketing_contributor', 'finance', 'customer', 'support'] as const;

/**
 * Text that is either plain (business data, shown as is) or a catalogue reference. Table cells, AI answers and search
 * results carry the plain English string for searching and as the fallback, plus the reference (`…Msg`) to translate.
 */
export type Txt = string | MsgRef;
export const isRef = (x: unknown): x is MsgRef => !!x && typeof x === 'object' && (x as MsgRef).t === 'msg';
/** English fallback of a Txt. */
export const plain = (x: Txt): string => (typeof x === 'string' ? x : (x.text ?? x.key));
/** Catalogue key segment from an English label: "Home studio" → "homeStudio", "Attendance (30d)" → "attendance30d". */
export const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .map((w, i) => (i ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join('');
/** Generic-table text (namespace "data", `table.*`). */
export const tbl = (key: string, params?: MsgParams, text?: string): MsgRef => ref(`table.${key}`, params, text);
/** A fixed English label keyed by its slug, e.g. `lbl('col', 'Home studio')` → `table.col.homeStudio`. */
export const lbl = (group: string, english: string): MsgRef => tbl(`${group}.${slug(english)}`, undefined, english);
export const timeArg = (at: string, tz?: string): DateParam => ({ t: 'date', at, tz, style: 'time' });
export const zoneArg = (tz: string, at = new Date().toISOString()): DateParam => ({ t: 'date', at, tz, style: 'zone' });
export const dayArg = (at: string, tz?: string): DateParam => ({ t: 'date', at, tz, style: 'dayMonth' });

/** Report source sentences the API sends without a code → data `reportSource.*`; anything else is shown as sent. */
export const reportSourceKey = (s: string): string =>
  /^sample data$/i.test(s) ? 'reportSource.sample' : /^BranchHarbor native bookings/i.test(s) ? 'reportSource.studiosNative' : /^BranchHarbor listings, enquiries/i.test(s) ? 'reportSource.realtyNative' : 'reportSource.unknown';

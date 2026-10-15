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
  style?: 'date' | 'dateTime' | 'dayTime';
}
/** An amount in minor units, formatted in the viewer's locale. */
export interface MoneyParam {
  t: 'money';
  amount: number;
  currency: string;
}
export type MsgParam = string | number | MsgRef | DateParam | MoneyParam | MsgRef[] | string[];
export type MsgParams = Record<string, MsgParam>;

/** Builders used by the data layer. */
export const ref = (key: string, params?: MsgParams, text?: string): MsgRef => ({ t: 'msg', key, ...(params ? { params } : {}), ...(text ? { text } : {}) });
export const dateArg = (at: string, tz?: string, style: DateParam['style'] = 'date'): DateParam => ({ t: 'date', at, tz, style });
export const moneyArg = (amount: number, currency: string): MoneyParam => ({ t: 'money', amount, currency });

/** Role assignment keys shared by mock and live members. */
export const ROLE_KEYS = ['org_owner', 'hq_admin', 'regional_manager', 'franchise_owner', 'location_manager', 'staff', 'marketing_contributor', 'finance', 'customer', 'support'] as const;

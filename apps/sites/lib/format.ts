/** Isomorphic formatting: money in the location currency, times in the location timezone. */
import { isRtl } from '@bh/shared';
import type { Money } from './types';

const EXP: Record<string, number> = { JPY: 0 };

export function money(m: Money | null | undefined, locale: string): string {
  if (!m) return '';
  const s = new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency }).format(m.amount / 10 ** (EXP[m.currency] ?? 2));
  // In right-to-left pages, isolate the amount (FSI…PDI) so it never reorders with surrounding text. CLDR's leading
  // RLM is dropped so a Latin currency code ("15.00 UK£") keeps its own order instead of rendering as "£UK 15.00".
  return isRtl(locale) ? `\u2068${s.replace(/[\u200e\u200f]/g, '')}\u2069` : s;
}

export function time(iso: string, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function dateLong(iso: string, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
}

export function dateTime(iso: string, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** Short zone label such as "EDT", "GMT+1" or "BST" at a given instant. */
export function zone(timeZone: string, locale: string, at: Date | string = new Date()): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}

/** YYYY-MM-DD of an instant in a timezone. */
export function localDate(iso: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(typeof iso === 'string' ? new Date(iso) : iso);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** Label a YYYY-MM-DD calendar date (no timezone shift). */
export function calendarLabel(date: string, locale: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Weekday name (0 = Sunday). */
export function weekdayName(day: number, locale: string, style: 'long' | 'short' = 'long'): string {
  // 2026-10-11 is a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 11 + day, 12)));
}

/** "09:00" → locale time label, e.g. "9:00 AM" / "09:00". */
export function clock(hhmm: string, locale: string): string {
  if (hhmm === '24:00') hhmm = '23:59';
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 1, h, m)));
}

export function weekdayInZone(timeZone: string, at = new Date()): number {
  const w = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(w);
}

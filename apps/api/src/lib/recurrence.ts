/**
 * RRULE-like weekly recurrence expanded in a location's IANA time zone. Occurrences keep their local
 * wall-clock time across daylight-saving changes (07:00 stays 07:00 locally; the UTC instant moves).
 * A local time that does not exist on a spring-forward day is moved forward by the gap and flagged.
 */
import { addDays, localDateParts, weekdayOf, zonedToUtc } from './tz.ts';

export interface Recurrence {
  freq: 'WEEKLY';
  interval: number;
  byWeekday: number[];
  time: string;
  startDate: string;
  untilDate: string | null;
  count: number | null;
  skipDates: string[];
}

export interface ExpandedOccurrence {
  localDate: string;
  localTime: string;
  startsAt: Date;
  endsAt: Date;
  /** UTC offset in minutes at the start (e.g. -240 for EDT). */
  utcOffsetMinutes: number;
  /** The requested local time does not exist on this date (spring forward); the class starts at `localTime`. */
  dstAdjusted: boolean;
}

/** Hard cap on generated occurrences per series (≈ 2 years of a daily class). */
export const MAX_OCCURRENCES = 750;
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function utcOffsetMinutes(at: Date, timeZone: string): number {
  const p = localDateParts(at, timeZone);
  const [y, m, d] = p.date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = p.time.split(':').map(Number) as [number, number];
  return Math.round((Date.UTC(y, m - 1, d, hh, mm) - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** Days between two YYYY-MM-DD dates. */
export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** Local date+time → UTC with DST detection. */
export function localToUtc(date: string, time: string, timeZone: string): { at: Date; localTime: string; dstAdjusted: boolean } {
  const at = zonedToUtc(date, time, timeZone);
  const back = localDateParts(at, timeZone);
  if (back.date === date && back.time === time) return { at, localTime: time, dstAdjusted: false };
  // Non-existent local time (spring forward): use the instant one hour later on the same wall clock, which
  // Intl resolves to the first valid local time after the gap.
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const before = utcOffsetMinutes(new Date(naive - 12 * 3600_000), timeZone);
  const shifted = new Date(naive - before * 60_000);
  const p = localDateParts(shifted, timeZone);
  return { at: shifted, localTime: p.time, dstAdjusted: true };
}

export function validateRecurrence(r: Recurrence): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!/^\d{2}:\d{2}$/.test(r.time) || Number(r.time.slice(0, 2)) > 23 || Number(r.time.slice(3)) > 59) errors.time = 'Use HH:MM (24-hour)';
  if (!r.byWeekday.length) errors.byWeekday = 'Choose at least one weekday';
  if (r.byWeekday.some((d) => d < 0 || d > 6 || !Number.isInteger(d))) errors.byWeekday = 'Weekdays are 0 (Sunday) to 6 (Saturday)';
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 8) errors.interval = 'Repeat every 1–8 weeks';
  if (!r.untilDate && !r.count) errors.untilDate = 'Set an end date or a number of classes';
  if (r.untilDate && r.untilDate < r.startDate) errors.untilDate = 'The end date must be after the start date';
  if (r.untilDate && daysBetween(r.startDate, r.untilDate) > 731) errors.untilDate = 'Schedule at most two years ahead';
  if (r.count !== null && (r.count < 1 || r.count > MAX_OCCURRENCES)) errors.count = `Between 1 and ${MAX_OCCURRENCES} classes`;
  return errors;
}

/** Expand a weekly recurrence into concrete UTC instants. */
export function expandRecurrence(r: Recurrence, timeZone: string, durationMinutes: number): ExpandedOccurrence[] {
  const out: ExpandedOccurrence[] = [];
  const days = [...new Set(r.byWeekday)].sort();
  const skip = new Set(r.skipDates);
  // Weeks are anchored on the Sunday on/before the start date so INTERVAL counts calendar weeks.
  const anchor = addDays(r.startDate, -weekdayOf(r.startDate));
  const limitDate = r.untilDate ?? addDays(r.startDate, 7 * r.interval * (Math.ceil((r.count ?? 1) / Math.max(1, days.length)) + 1) + 7);
  for (let week = 0; ; week += r.interval) {
    const weekStart = addDays(anchor, week * 7);
    if (weekStart > limitDate) break;
    for (const wd of days) {
      const date = addDays(weekStart, wd);
      if (date < r.startDate || date > limitDate || skip.has(date)) continue;
      const { at, localTime, dstAdjusted } = localToUtc(date, r.time, timeZone);
      out.push({ localDate: date, localTime, startsAt: at, endsAt: new Date(at.getTime() + durationMinutes * 60_000), utcOffsetMinutes: utcOffsetMinutes(at, timeZone), dstAdjusted });
      if ((r.count && out.length >= r.count) || out.length >= MAX_OCCURRENCES) return out;
    }
  }
  return out;
}

/** RFC 5545-style rule text for display / export (DTSTART is local time with TZID). */
export function toRRule(r: Recurrence, timeZone: string): string {
  const parts = ['FREQ=WEEKLY', `INTERVAL=${r.interval}`, `BYDAY=${[...r.byWeekday].sort().map((d) => DAY_CODES[d]).join(',')}`];
  if (r.untilDate) parts.push(`UNTIL=${r.untilDate.replace(/-/g, '')}T235959`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  const dt = `DTSTART;TZID=${timeZone}:${r.startDate.replace(/-/g, '')}T${r.time.replace(':', '')}00`;
  const ex = r.skipDates.length ? `\nEXDATE;TZID=${timeZone}:${r.skipDates.map((d) => `${d.replace(/-/g, '')}T${r.time.replace(':', '')}00`).join(',')}` : '';
  return `${dt}\nRRULE:${parts.join(';')}${ex}`;
}

/** Move an occurrence to a new local time (and optionally weekday) keeping its week; DST-safe. */
export function moveLocal(startsAt: Date, timeZone: string, change: { time?: string; weekday?: number }): { at: Date; localDate: string; dstAdjusted: boolean } {
  const cur = localDateParts(startsAt, timeZone);
  const date = change.weekday === undefined ? cur.date : addDays(cur.date, change.weekday - cur.weekday);
  const r = localToUtc(date, change.time ?? cur.time, timeZone);
  return { at: r.at, localDate: date, dstAdjusted: r.dstAdjusted };
}

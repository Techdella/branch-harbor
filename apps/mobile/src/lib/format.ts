import { formatMoney, formatInZone, zoneAbbreviation, type Money } from '@bh/shared';

/** Money is always formatted with Intl in its own currency. Never combine currencies. */
export function fmtMoney(m: Money, locale: string): string {
  try {
    return formatMoney(m, locale);
  } catch {
    return `${(m.amount / 100).toFixed(2)} ${m.currency}`;
  }
}

export function fmtTime(iso: string, timeZone: string, locale: string): string {
  return formatInZone(iso, timeZone, locale, { hour: 'numeric', minute: '2-digit' });
}

export function fmtDay(iso: string, timeZone: string, locale: string): string {
  return formatInZone(iso, timeZone, locale, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function fmtDateTime(iso: string, timeZone: string, locale: string): string {
  return formatInZone(iso, timeZone, locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** e.g. "EDT", "GMT+1" — shown next to every location time. */
export function fmtZone(timeZone: string, locale: string, at = new Date()): string {
  try {
    return zoneAbbreviation(timeZone, locale, at);
  } catch {
    return timeZone;
  }
}

/** Calendar date (YYYY-MM-DD) of an instant as seen in `timeZone`. */
export function localDateKey(at: Date | string, timeZone: string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Offset (ms) of `timeZone` from UTC at instant `at`. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - at.getTime();
}

/** Converts a wall-clock time at a location (YYYY-MM-DD + HH:mm) into a UTC ISO string. DST-safe for normal hours. */
export function zonedToUtcIso(dateKey: string, hhmm: string, timeZone: string): string {
  const [y, mo, d] = dateKey.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = zoneOffsetMs(new Date(guess), timeZone);
  const off2 = zoneOffsetMs(new Date(guess - off1), timeZone);
  return new Date(guess - off2).toISOString();
}

export function addDaysKey(dateKey: string, days: number): string {
  const [y, mo, d] = dateKey.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function relativeAgo(iso: string, locale: string, now = Date.now()): string {
  const diff = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(diff, 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

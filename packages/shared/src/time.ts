/** Store UTC, present in the location's IANA timezone. */
export function formatInZone(
  iso: string | Date,
  timeZone: string,
  locale = 'en',
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return new Intl.DateTimeFormat(locale, { timeZone, ...opts }).format(typeof iso === 'string' ? new Date(iso) : iso);
}

export function zoneAbbreviation(timeZone: string, locale = 'en', at = new Date()): string {
  const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

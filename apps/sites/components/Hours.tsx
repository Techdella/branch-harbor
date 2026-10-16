import { getLocale, getTranslations } from 'next-intl/server';
import { calendarLabel, clock, weekdayInZone, weekdayName, zone } from '@/lib/format';
import type { LocationSummary } from '@/lib/types';

/** Upcoming holiday / special hours (next 60 days) from Listings; they replace the weekly hours on those dates. */
async function SpecialHoursList({ loc }: { loc: LocationSummary }) {
  const t = await getTranslations('listingsSite');
  const locale = await getLocale();
  const until = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  const items = (loc.hours.special ?? []).filter((x) => x.date <= until);
  if (!items.length) return null;
  return (
    <div className="mt-4">
      <h3 className="text-sm font-bold">{t('specialHours')}</h3>
      <ul className="mt-1 text-sm">
        {items.map((x) => (
          <li key={x.date} className="flex justify-between gap-4 py-1">
            <span className="font-semibold">{calendarLabel(x.date, locale)}{x.label ? ` · ${x.label}` : ''}</span>
            <span className="tabular">{x.closed || !x.opens || !x.closes ? t('closed') : `${clock(x.opens, locale)}–${clock(x.closes, locale)}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Weekly hours in the location's timezone, Monday first, today highlighted; upcoming special hours below. */
export async function Hours({ loc }: { loc: LocationSummary }) {
  const t = await getTranslations();
  const locale = await getLocale();
  const tz = zone(loc.timeZone, locale);
  if (!loc.hours.weekly) {
    return (
      <div>
        {loc.hours.summary ? <p className="text-lg">{loc.hours.summary}</p> : null}
        <p className="mt-1 text-sm text-graphite">{t('common.timesIn', { zone: `${tz} (${loc.timeZone})` })}</p>
        <SpecialHoursList loc={loc} />
      </div>
    );
  }
  const today = weekdayInZone(loc.timeZone);
  const days = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div>
      <table className="w-full max-w-sm text-sm">
        <caption className="sr-only">{t('location.hours')}</caption>
        <tbody>
          {days.map((d) => {
            const rows = loc.hours.weekly!.filter((w) => w.day === d);
            const isToday = d === today;
            return (
              <tr key={d} className={isToday ? 'font-bold' : ''} aria-current={isToday ? 'date' : undefined}>
                <th scope="row" className="py-1.5 pe-4 text-start font-semibold">
                  {weekdayName(d, locale)}{isToday && <span className="ms-2 rounded-full bg-brand-tint px-2 py-0.5 text-xs">{t('location.today')}</span>}
                </th>
                <td className="py-1.5 tabular">
                  {rows.length ? rows.map((w) => `${clock(w.opens, locale)}–${clock(w.closes, locale)}`).join(', ') : t('location.closedDay')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-sm text-graphite">{t('common.timesIn', { zone: `${tz} (${loc.timeZone})` })}</p>
      <SpecialHoursList loc={loc} />
    </div>
  );
}

import { getLocale, getTranslations } from 'next-intl/server';
import { clock, weekdayInZone, weekdayName, zone } from '@/lib/format';
import type { LocationSummary } from '@/lib/types';

/** Weekly hours in the location's timezone, Monday first, today highlighted. */
export async function Hours({ loc }: { loc: LocationSummary }) {
  const t = await getTranslations();
  const locale = await getLocale();
  const tz = zone(loc.timeZone, locale);
  if (!loc.hours.weekly) {
    return (
      <div>
        {loc.hours.summary ? <p className="text-lg">{loc.hours.summary}</p> : null}
        <p className="mt-1 text-sm text-graphite">{t('common.timesIn', { zone: `${tz} (${loc.timeZone})` })}</p>
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
    </div>
  );
}

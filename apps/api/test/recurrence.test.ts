import { describe, expect, it } from 'vitest';
import { expandRecurrence, localToUtc, moveLocal, toRRule, validateRecurrence, type Recurrence } from '../src/lib/recurrence.ts';
import { localDateParts } from '../src/lib/tz.ts';
import { addMonthsUtc, locationAccess, periodContaining } from '../src/services/studios-entitlements.ts';

const weekly = (over: Partial<Recurrence>): Recurrence => ({ freq: 'WEEKLY', interval: 1, byWeekday: [0], time: '07:00', startDate: '2026-10-18', untilDate: '2026-11-15', count: null, skipDates: [], ...over });

describe('weekly recurrence in the location time zone (DST-safe)', () => {
  it('keeps 07:00 local in Toronto across the November DST change while the UTC instant moves', () => {
    const occ = expandRecurrence(weekly({}), 'America/Toronto', 60);
    expect(occ.map((o) => o.localDate)).toEqual(['2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08', '2026-11-15']);
    expect(occ.every((o) => o.localTime === '07:00' && localDateParts(o.startsAt, 'America/Toronto').time === '07:00')).toBe(true);
    expect(occ[1]!.startsAt.toISOString()).toBe('2026-10-25T11:00:00.000Z'); // EDT
    expect(occ[2]!.startsAt.toISOString()).toBe('2026-11-01T12:00:00.000Z'); // EST
    expect(occ[1]!.utcOffsetMinutes).toBe(-240);
    expect(occ[2]!.utcOffsetMinutes).toBe(-300);
    expect(occ[2]!.endsAt.getTime() - occ[2]!.startsAt.getTime()).toBe(60 * 60_000);
  });

  it('handles London (October) and Sydney (April, southern hemisphere) changes', () => {
    const lon = expandRecurrence(weekly({ byWeekday: [6], time: '09:30', startDate: '2026-10-17', untilDate: '2026-10-31' }), 'Europe/London', 75);
    expect(lon.map((o) => o.startsAt.toISOString())).toEqual(['2026-10-17T08:30:00.000Z', '2026-10-24T08:30:00.000Z', '2026-10-31T09:30:00.000Z']);
    const syd = expandRecurrence(weekly({ byWeekday: [1, 3], time: '18:00', startDate: '2026-03-30', untilDate: '2026-04-08' }), 'Australia/Sydney', 60);
    expect(syd.map((o) => o.localDate)).toEqual(['2026-03-30', '2026-04-01', '2026-04-06', '2026-04-08']);
    expect(syd.every((o) => localDateParts(o.startsAt, 'Australia/Sydney').time === '18:00')).toBe(true);
    expect(syd[0]!.utcOffsetMinutes).toBe(660);
    expect(syd[2]!.utcOffsetMinutes).toBe(600);
  });

  it('moves a time that does not exist (spring forward) to the next valid local time and flags it', () => {
    const r = localToUtc('2026-03-08', '02:30', 'America/Toronto');
    expect(r).toMatchObject({ localTime: '03:30', dstAdjusted: true });
    expect(r.at.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    const occ = expandRecurrence(weekly({ time: '02:30', startDate: '2026-03-01', untilDate: '2026-03-15' }), 'America/Toronto', 45);
    expect(occ.map((o) => [o.localTime, o.dstAdjusted])).toEqual([['02:30', false], ['03:30', true], ['02:30', false]]);
  });

  it('supports intervals, counts, skip dates and RRULE text; validates input', () => {
    const occ = expandRecurrence(weekly({ interval: 2, byWeekday: [2, 4], startDate: '2026-11-03', untilDate: null, count: 5, skipDates: ['2026-11-05'] }), 'Europe/Berlin', 60);
    expect(occ.map((o) => o.localDate)).toEqual(['2026-11-03', '2026-11-17', '2026-11-19', '2026-12-01', '2026-12-03']);
    expect(toRRule(weekly({ byWeekday: [1, 3, 5] }), 'America/Toronto')).toContain('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;UNTIL=20261115T235959');
    expect(validateRecurrence(weekly({ byWeekday: [], untilDate: null }))).toMatchObject({ byWeekday: expect.any(String), untilDate: expect.any(String) });
    expect(validateRecurrence(weekly({ time: '25:00' })).time).toBeTruthy();
  });

  it('moves one occurrence to a new weekday/time in local terms', () => {
    const from = new Date('2026-10-26T11:00:00Z'); // Mon 07:00 Toronto (EDT)
    const r = moveLocal(from, 'America/Toronto', { weekday: 3, time: '18:15' });
    expect(r.localDate).toBe('2026-10-28');
    expect(localDateParts(r.at, 'America/Toronto')).toMatchObject({ date: '2026-10-28', time: '18:15' });
  });
});

describe('membership periods and location access', () => {
  it('anchors monthly periods on the start date (month-end safe)', () => {
    expect(addMonthsUtc(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    const p = periodContaining({ startsAt: new Date('2026-08-15T00:00:00Z'), currentPeriodStart: null }, new Date('2026-10-20T00:00:00Z'));
    expect(p.start.toISOString().slice(0, 10)).toBe('2026-10-15');
    expect(p.end.toISOString().slice(0, 10)).toBe('2026-11-15');
  });
  it('evaluates transfer policies', () => {
    const t = { id: 'b', currency: 'CAD' };
    expect(locationAccess('home_only', 'a', [], t, 'CAD').ok).toBe(false);
    expect(locationAccess('home_only', 'b', [], t, 'CAD').ok).toBe(true);
    expect(locationAccess('same_currency', 'a', [], t, 'CAD').ok).toBe(true);
    expect(locationAccess('same_currency', 'a', [], t, 'USD').ok).toBe(false);
    expect(locationAccess('listed', 'a', ['b'], t, 'USD').ok).toBe(true);
    expect(locationAccess('any_location', 'a', [], t, 'USD').ok).toBe(true);
  });
});

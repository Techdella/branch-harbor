import { describe, expect, it } from 'vitest';
import { ageOnDate, checkAgeEligibility, defaultAgeConvention, eligibleBirthDates, instalmentState, siblingDiscount, splitInstalments } from '@bh/shared';
import { balanceOf, scheduleFor, splitAnswers, BUILT_IN_QUESTIONS } from '../src/services/sports-core.ts';
import { recurrenceDates, relatedVenueIds, localSlot } from '../src/services/sports-schedule.ts';

describe('sports age boundaries', () => {
  it('measures age on the cutoff date; the birthday itself counts', () => {
    expect(ageOnDate('2016-08-31', '2026-08-31')).toBe(10);
    expect(ageOnDate('2016-09-01', '2026-08-31')).toBe(9);
    expect(ageOnDate('2016-08-30', '2026-08-31')).toBe(10);
  });

  it('a 29 February birthday is reached on 1 March in non-leap years', () => {
    expect(ageOnDate('2016-02-29', '2026-02-28')).toBe(9);
    expect(ageOnDate('2016-02-29', '2026-03-01')).toBe(10);
    expect(ageOnDate('2016-02-29', '2024-02-29')).toBe(8);
  });

  it('country defaults: GB school-year (31 Aug of season start), North America birth-year (season end year) — configurable', () => {
    expect(defaultAgeConvention('GB', '2026-09-01', '2027-05-31')).toMatchObject({ rule: 'age_on_date', cutoffDate: '2026-08-31' });
    expect(defaultAgeConvention('US', '2026-08-15', '2027-06-15')).toMatchObject({ rule: 'birth_year', cutoffDate: '2027-12-31', seasonYear: 2027 });
    expect(defaultAgeConvention('CA', '2026-09-07', '2026-12-13')).toMatchObject({ rule: 'birth_year', cutoffDate: '2026-12-31' });
  });

  it('birth-year groups ignore the day of birth: everyone born in the same year is in the same group', () => {
    const jan = checkAgeEligibility({ dateOfBirth: '2016-01-01', rule: 'birth_year', cutoffDate: '2026-12-31', ageMin: 8, ageMax: 10 });
    const dec = checkAgeEligibility({ dateOfBirth: '2016-12-31', rule: 'birth_year', cutoffDate: '2026-12-31', ageMin: 8, ageMax: 10 });
    expect(jan.age).toBe(10);
    expect(dec.age).toBe(10);
    expect(jan.ageGroup).toBe('U10');
    expect(checkAgeEligibility({ dateOfBirth: '2015-12-31', rule: 'birth_year', cutoffDate: '2026-12-31', ageMin: 8, ageMax: 10 }).reason).toBe('too_old');
    expect(checkAgeEligibility({ dateOfBirth: '2019-01-01', rule: 'birth_year', cutoffDate: '2026-12-31', ageMin: 8, ageMax: 10 }).reason).toBe('too_young');
  });

  it('age-on-date eligibility flips exactly at the boundary day', () => {
    const base = { rule: 'age_on_date' as const, cutoffDate: '2026-08-31', ageMin: 9, ageMax: 10 };
    expect(checkAgeEligibility({ ...base, dateOfBirth: '2015-09-01' }).eligible).toBe(true); // 10 on cutoff
    expect(checkAgeEligibility({ ...base, dateOfBirth: '2015-08-31' }).reason).toBe('too_old'); // turns 11 on cutoff
    expect(checkAgeEligibility({ ...base, dateOfBirth: '2017-08-31' }).eligible).toBe(true); // turns 9 on cutoff
    expect(checkAgeEligibility({ ...base, dateOfBirth: '2017-09-01' }).reason).toBe('too_young');
    expect(checkAgeEligibility({ ...base, dateOfBirth: '2016-01-01' }).ageGroup).toBe('U11');
  });

  it('previews the inclusive birth-date range of an age band', () => {
    expect(eligibleBirthDates('age_on_date', '2026-08-31', 9, 10)).toEqual({ from: '2015-09-01', to: '2017-08-31' });
    expect(eligibleBirthDates('birth_year', '2026-12-31', 8, 10)).toEqual({ from: '2016-01-01', to: '2018-12-31' });
    expect(eligibleBirthDates('age_on_date', '2028-02-29', 8, null)).toEqual({ from: null, to: '2020-02-29' });
    expect(eligibleBirthDates('age_on_date', '2028-02-29', 9, null).to).toBe('2019-02-28');
  });
});

describe('sports fees and instalments', () => {
  it('splits a total exactly; the remainder goes to the first instalment', () => {
    const lines = splitInstalments(10_000, [{ dueOn: '2026-09-01', shareBps: 3334 }, { dueOn: '2026-10-01', shareBps: 3333 }, { dueOn: '2026-11-01', shareBps: 3333 }]);
    expect(lines.map((l) => l.amountMinor)).toEqual([3334, 3333, 3333]);
    const odd = splitInstalments(42_001, [{ dueOn: '2026-09-01', shareBps: 5000 }, { dueOn: '2026-10-01', shareBps: 5000 }]);
    expect(odd[0]!.amountMinor + odd[1]!.amountMinor).toBe(42_001);
    expect(odd[0]!.amountMinor).toBe(21_001);
    expect(() => splitInstalments(100, [{ dueOn: '2026-09-01', shareBps: 9000 }])).toThrow(/100%/);
    expect(() => splitInstalments(10.5, [{ dueOn: '2026-09-01', shareBps: 10_000 }])).toThrow();
  });

  it('JPY (no minor unit) and other currencies use the same integer arithmetic', () => {
    expect(splitInstalments(45_000, [{ dueOn: '2026-09-01', shareBps: 5000 }, { dueOn: '2026-12-01', shareBps: 5000 }]).map((l) => l.amountMinor)).toEqual([22_500, 22_500]);
  });

  it('plan schedules move past due dates to today and pay-in-full is a single line', () => {
    const plan = { id: 'p', organizationId: 'o', programmeId: 'x', name: '3 instalments', kind: 'instalments', active: true, createdAt: new Date(), schedule: [{ dueOn: '2026-09-01', shareBps: 4000 }, { dueOn: '2026-09-20', shareBps: 3000 }, { dueOn: '2026-11-01', shareBps: 3000 }] };
    expect(scheduleFor(30_000, plan, '2026-10-14')).toEqual([{ seq: 1, dueOn: '2026-10-14', amountMinor: 12_000 }, { seq: 2, dueOn: '2026-10-14', amountMinor: 9000 }, { seq: 3, dueOn: '2026-11-01', amountMinor: 9000 }]);
    expect(scheduleFor(30_000, null, '2026-10-14')).toEqual([{ seq: 1, dueOn: '2026-10-14', amountMinor: 30_000 }]);
  });

  it('sibling discount applies from the second child only', () => {
    expect(siblingDiscount(42_000, 1000, 1)).toBe(0);
    expect(siblingDiscount(42_000, 1000, 2)).toBe(4200);
    expect(siblingDiscount(42_000, 0, 3)).toBe(0);
  });

  it('unpaid instalments become due on the due date and overdue after it; paid/waived stay final', () => {
    expect(instalmentState({ status: 'scheduled', dueOn: '2026-11-01' }, '2026-10-14')).toBe('scheduled');
    expect(instalmentState({ status: 'scheduled', dueOn: '2026-10-14' }, '2026-10-14')).toBe('due');
    expect(instalmentState({ status: 'scheduled', dueOn: '2026-10-13' }, '2026-10-14')).toBe('overdue');
    expect(instalmentState({ status: 'scheduled', dueOn: '2026-10-10' }, '2026-10-14', 7)).toBe('due');
    expect(instalmentState({ status: 'paid', dueOn: '2026-01-01' }, '2026-10-14')).toBe('paid');
  });

  it('balance summarises paid / outstanding / overdue in one currency', () => {
    const mk = (seq: number, dueOn: string, amountMinor: number, status: string) => ({ id: `i${seq}`, seq, dueOn, amountMinor, status, currency: 'GBP' }) as never;
    const b = balanceOf([mk(1, '2026-09-01', 8000, 'paid'), mk(2, '2026-10-01', 8000, 'scheduled'), mk(3, '2026-11-01', 8000, 'scheduled')], '2026-10-14');
    expect(b).toMatchObject({ currency: 'GBP', total: 24_000, paid: 8000, outstanding: 16_000, overdue: 8000, state: 'overdue' });
    expect(b.nextDue).toMatchObject({ dueOn: '2026-10-01', amountMinor: 8000 });
    expect(balanceOf([mk(1, '2026-09-01', 8000, 'paid')], '2026-10-14').state).toBe('paid');
  });

  it('registration answers: required built-ins are enforced and medical/emergency answers are split into the restricted store', () => {
    expect(() => splitAnswers(BUILT_IN_QUESTIONS, {})).toThrow(/need an answer/);
    const r = splitAnswers(BUILT_IN_QUESTIONS, { emergency_contact_name: 'Sam', emergency_contact_phone: '+1 416 555 0101', medical_notes: 'Asthma', photo_consent: false });
    expect(r.general).toEqual({ photo_consent: false });
    expect(r.restricted).toEqual({ emergency_contact_name: 'Sam', emergency_contact_phone: '+1 416 555 0101', medical_notes: 'Asthma' });
    expect(r.coachVisibleKeys).toEqual(['emergency_contact_name', 'emergency_contact_phone', 'medical_action_plan']);
  });
});

describe('sports schedule helpers', () => {
  it('weekly recurrence keeps local wall-clock time across the DST change', () => {
    const dates = recurrenceDates('2026-10-27', '2026-11-05', [2, 4]);
    expect(dates).toEqual(['2026-10-27', '2026-10-29', '2026-11-03', '2026-11-05']);
    const before = localSlot('2026-10-29', '17:00', 90, 'America/Toronto');
    const after = localSlot('2026-11-03', '17:00', 90, 'America/Toronto');
    expect(before.startsAt.toISOString()).toBe('2026-10-29T21:00:00.000Z'); // EDT
    expect(after.startsAt.toISOString()).toBe('2026-11-03T22:00:00.000Z'); // EST
    expect(after.endsAt.getTime() - after.startsAt.getTime()).toBe(90 * 60_000);
  });

  it('a half pitch clashes with the full pitch but not with the other half', () => {
    const venues = [{ id: 'full', parentVenueId: null }, { id: 'half-a', parentVenueId: 'full' }, { id: 'half-b', parentVenueId: 'full' }];
    expect([...relatedVenueIds(venues, 'half-a')].sort()).toEqual(['full', 'half-a']);
    expect([...relatedVenueIds(venues, 'full')].sort()).toEqual(['full', 'half-a', 'half-b']);
  });
});

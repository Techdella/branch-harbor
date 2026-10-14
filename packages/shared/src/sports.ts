/**
 * Sports: age-boundary and fee-schedule rules shared by the API, the business app and customer sites.
 * Pure functions only — no I/O. Dates are calendar dates (YYYY-MM-DD) with no time zone.
 */

/** How a programme decides a participant's age group. */
export type SportsAgeRule = 'age_on_date' | 'birth_year';

export interface SportsAgeConvention {
  rule: SportsAgeRule;
  /** For `age_on_date`: the date on which age is measured. For `birth_year`: 31 Dec of the competition year. */
  cutoffDate: string;
  /** Competition/season year used by `birth_year` (U-age = seasonYear − birth year). */
  seasonYear: number;
  /** Human description of where the default comes from. Always configurable per programme. */
  note: string;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const parts = (d: string): [number, number, number] => {
  if (!isoDate.test(d)) throw new Error(`Invalid date ${d}`);
  return d.split('-').map(Number) as [number, number, number];
};

/** Age in whole years on a reference date. A 29 Feb birthday counts from 1 Mar in non-leap years. */
export function ageOnDate(dateOfBirth: string, on: string): number {
  const [y, m, d] = parts(dateOfBirth);
  const [ry, rm, rd] = parts(on);
  return ry - y - (rm < m || (rm === m && rd < d) ? 1 : 0);
}

/**
 * Default age convention by country for a season starting in `seasonStartYear`. These are common
 * youth-football defaults, not legal or governing-body advice — every programme can override them.
 *  - GB (England, Wales, Scotland, NI school-year groups): age on 31 August of the season's start year.
 *  - US, CA, IE, AU, NZ and others: birth-year groups, competition year = the year the season ends
 *    (a season running Sep 2026 – Jun 2027 uses 2027; a calendar-year season uses its own year).
 */
export function defaultAgeConvention(country: string, seasonStartsOn: string, seasonEndsOn?: string): SportsAgeConvention {
  const [sy] = parts(seasonStartsOn);
  const ey = seasonEndsOn ? parts(seasonEndsOn)[0] : sy;
  if (country.toUpperCase() === 'GB' || country.toUpperCase() === 'UK') {
    return { rule: 'age_on_date', cutoffDate: `${sy}-08-31`, seasonYear: sy, note: 'School-year age groups: age on 31 August at the start of the season' };
  }
  return { rule: 'birth_year', cutoffDate: `${ey}-12-31`, seasonYear: ey, note: 'Birth-year age groups: age reached during the competition year' };
}

export interface AgeEligibilityInput {
  dateOfBirth: string;
  rule: SportsAgeRule;
  /** age_on_date: measure on this date. birth_year: its year is the competition year. */
  cutoffDate: string;
  ageMin: number | null;
  ageMax: number | null;
}

export interface AgeEligibility {
  eligible: boolean;
  /** Age used for eligibility (age on the cutoff date, or competition year − birth year). */
  age: number;
  /** "U" label: the age group the participant plays in (U-age is one more than the age on date). */
  ageGroup: string;
  referenceDate: string;
  reason: 'ok' | 'too_young' | 'too_old';
}

export function ageForRule(dateOfBirth: string, rule: SportsAgeRule, cutoffDate: string): number {
  if (rule === 'birth_year') return parts(cutoffDate)[0] - parts(dateOfBirth)[0];
  return ageOnDate(dateOfBirth, cutoffDate);
}

export function checkAgeEligibility(i: AgeEligibilityInput): AgeEligibility {
  const age = ageForRule(i.dateOfBirth, i.rule, i.cutoffDate);
  const reason = i.ageMin !== null && age < i.ageMin ? 'too_young' : i.ageMax !== null && age > i.ageMax ? 'too_old' : 'ok';
  // U-labels: under-N means "younger than N on the cutoff", i.e. age + 1 (birth-year: year − birth year).
  const ageGroup = `U${i.rule === 'birth_year' ? age : age + 1}`;
  return { eligible: reason === 'ok', age, ageGroup, referenceDate: i.cutoffDate, reason };
}

/**
 * Inclusive birth-date range eligible for an age band — what the setup wizard previews and the
 * catalogue shows ("born 1 Sep 2014 – 31 Aug 2016").
 */
export function eligibleBirthDates(rule: SportsAgeRule, cutoffDate: string, ageMin: number | null, ageMax: number | null): { from: string | null; to: string | null } {
  const [cy, cm, cd] = parts(cutoffDate);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (rule === 'birth_year') {
    return { from: ageMax === null ? null : `${cy - ageMax}-01-01`, to: ageMin === null ? null : `${cy - ageMin}-12-31` };
  }
  // age_on_date: age ≤ ageMax ⇔ born after cutoff − (ageMax+1) years; age ≥ ageMin ⇔ born on/before cutoff − ageMin years.
  const shift = (years: number) => {
    let y = cy - years;
    let m = cm;
    let d = cd;
    if (m === 2 && d === 29 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) d = 28;
    return { y, m, d };
  };
  const nextDay = ({ y, m, d }: { y: number; m: number; d: number }) => {
    const dt = new Date(Date.UTC(y, m - 1, d + 1));
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  };
  const to = ageMin === null ? null : (() => { const s = shift(ageMin); return `${s.y}-${pad(s.m)}-${pad(s.d)}`; })();
  const from = ageMax === null ? null : nextDay(shift(ageMax + 1));
  return { from, to };
}

/* ------------------------------------------------------------------ */
/* Fees                                                                */
/* ------------------------------------------------------------------ */

export interface InstalmentStep {
  /** Due date (YYYY-MM-DD). The first step is normally due at registration. */
  dueOn: string;
  /** Share of the total in basis points (10000 = 100%). */
  shareBps: number;
}

export interface InstalmentLine {
  seq: number;
  dueOn: string;
  amountMinor: number;
}

/**
 * Splits a total (integer minor units) across a plan. Shares must add up to 10000 bps. Rounding is
 * floor per step and the remainder goes to the FIRST instalment, so the schedule always sums to the
 * total exactly and later instalments never exceed their share.
 */
export function splitInstalments(totalMinor: number, steps: InstalmentStep[]): InstalmentLine[] {
  if (!Number.isInteger(totalMinor) || totalMinor < 0) throw new Error('Total must be a non-negative integer in minor units');
  if (!steps.length) throw new Error('A plan needs at least one instalment');
  const bps = steps.reduce((a, s) => a + s.shareBps, 0);
  if (bps !== 10_000) throw new Error(`Instalment shares must add up to 100% (got ${bps / 100}%)`);
  const lines = steps.map((s, i) => ({ seq: i + 1, dueOn: s.dueOn, amountMinor: Math.floor((totalMinor * s.shareBps) / 10_000) }));
  const rem = totalMinor - lines.reduce((a, l) => a + l.amountMinor, 0);
  lines[0]!.amountMinor += rem;
  return lines;
}

/** Sibling discount in minor units for the Nth active registration of a family (1-based); first child pays full fee. */
export function siblingDiscount(feeMinor: number, discountBps: number, familyPosition: number): number {
  if (familyPosition <= 1 || discountBps <= 0) return 0;
  return Math.floor((feeMinor * Math.min(discountBps, 10_000)) / 10_000);
}

export type InstalmentState = 'scheduled' | 'due' | 'overdue' | 'paid' | 'waived' | 'cancelled';

/** Display state of an unpaid instalment on `today` (location calendar date). `graceDays` before it counts as overdue. */
export function instalmentState(i: { status: string; dueOn: string }, today: string, graceDays = 0): InstalmentState {
  if (i.status === 'paid' || i.status === 'waived' || i.status === 'cancelled') return i.status as InstalmentState;
  if (i.dueOn > today) return 'scheduled';
  const [y, m, d] = parts(i.dueOn);
  const graceEnd = new Date(Date.UTC(y, m - 1, d + graceDays)).toISOString().slice(0, 10);
  return today > graceEnd ? 'overdue' : 'due';
}

export const sportsRegistrationStates = ['submitted', 'awaiting_review', 'accepted', 'waitlisted', 'withdrawn', 'rejected'] as const;
export const sportsAbsenceReasons = ['illness', 'injury', 'family', 'school', 'travel', 'other'] as const;
export type SportsAbsenceReason = (typeof sportsAbsenceReasons)[number];

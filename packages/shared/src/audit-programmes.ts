/**
 * Audits phase 2 (Operations → Audits and Operations → Self-checks). Pure rules shared by the API, the dashboard and
 * the mobile app:
 *
 * - recurring audit schedules (every N weeks / months / quarters from an anchor date) and which due dates fall in a window;
 * - self-check schedules (daily or on chosen weekdays, due by a local time) and their starter checklists
 *   (opening, closing, food-safety temperature log);
 * - the visit planner's route order: nearest neighbour by straight-line distance (no paid routing API);
 * - the most-failed items across the network.
 */
import { z } from 'zod';
import type { AuditQuestion, AuditSection, AuditTemplateBody } from './quality.ts';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/* ------------------------------------------------------------------ */
/* Targets (which locations a schedule covers)                         */
/* ------------------------------------------------------------------ */

export const SCHEDULE_TARGET_KINDS = ['all', 'region', 'owner_group', 'locations'] as const;
export const scheduleTargetSchema = z.object({
  kind: z.enum(SCHEDULE_TARGET_KINDS),
  /** Region, owner group or location ids (ignored for `all`). */
  ids: z.array(z.uuid()).max(500).default([]),
}).refine((t) => t.kind === 'all' || t.ids.length > 0, { message: 'Choose at least one', path: ['ids'] });
export type ScheduleTarget = z.infer<typeof scheduleTargetSchema>;

export function targetIncludes(t: ScheduleTarget, loc: { id: string; regionId: string | null; ownerGroupId: string | null }): boolean {
  switch (t.kind) {
    case 'all': return true;
    case 'region': return !!loc.regionId && t.ids.includes(loc.regionId);
    case 'owner_group': return !!loc.ownerGroupId && t.ids.includes(loc.ownerGroupId);
    case 'locations': return t.ids.includes(loc.id);
  }
}

/* ------------------------------------------------------------------ */
/* Recurring audit schedules                                           */
/* ------------------------------------------------------------------ */

export const AUDIT_FREQUENCIES = ['weekly', 'monthly', 'quarterly'] as const;
export type AuditFrequency = (typeof AUDIT_FREQUENCIES)[number];
export const AUDITOR_RULES = ['field_consultant', 'user'] as const;

export const auditScheduleBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  templateId: z.uuid(),
  target: scheduleTargetSchema,
  frequency: z.enum(AUDIT_FREQUENCIES),
  /** Every N weeks / months / quarters. */
  interval: z.number().int().min(1).max(12).default(1),
  /** The first due date; later ones follow from it (a day past the month's end moves to its last day). */
  anchorDate: ymd,
  /** The audit is created this many days before it is due. */
  leadDays: z.number().int().min(0).max(60).default(14),
  /** field_consultant: the location's field consultant (account manager), else `auditorUserId`. */
  auditorRule: z.enum(AUDITOR_RULES).default('field_consultant'),
  auditorUserId: z.uuid().nullable().optional().default(null),
  active: z.boolean().optional().default(true),
});
export type AuditScheduleBody = z.infer<typeof auditScheduleBodySchema>;

const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);

/** Adds months to a date, clamping to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsClamped(date: string, months: number, anchorDay = Number(date.slice(8, 10))): string {
  const d = toDate(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(y, m, Math.min(anchorDay, last))));
}

/** The n-th due date of a schedule (n = 0 is the anchor). */
export function scheduleOccurrence(s: { frequency: AuditFrequency; interval: number; anchorDate: string }, n: number): string {
  if (s.frequency === 'weekly') return fmt(new Date(toDate(s.anchorDate).getTime() + n * s.interval * 7 * 86_400_000));
  const months = (s.frequency === 'monthly' ? 1 : 3) * s.interval * n;
  return addMonthsClamped(s.anchorDate, months, Number(s.anchorDate.slice(8, 10)));
}

/** Due dates of a schedule within [from, to] (inclusive), never before the anchor. */
export function scheduleDueDates(s: { frequency: AuditFrequency; interval: number; anchorDate: string }, from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  for (let n = 0; n < max; n++) {
    const d = scheduleOccurrence(s, n);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Self-checks                                                         */
/* ------------------------------------------------------------------ */

export const SELF_CHECK_KINDS = ['opening', 'closing', 'food_safety', 'cleaning', 'other'] as const;
export type SelfCheckKind = (typeof SELF_CHECK_KINDS)[number];
export const SELF_RUN_STATUSES = ['due', 'in_progress', 'completed', 'missed'] as const;
export type SelfRunStatus = (typeof SELF_RUN_STATUSES)[number];

export const selfCheckScheduleBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  templateId: z.uuid(),
  kind: z.enum(SELF_CHECK_KINDS).default('other'),
  target: scheduleTargetSchema,
  /** 0 = Sunday … 6 = Saturday. All seven = daily. */
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  /** Local time at the location by which it should be done (HH:MM). */
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM').default('10:00'),
  /** Remind the location this many minutes before the due time when it isn't done yet (0 = at the due time). */
  remindMinutesBefore: z.number().int().min(0).max(720).default(30),
  active: z.boolean().optional().default(true),
});
export type SelfCheckScheduleBody = z.infer<typeof selfCheckScheduleBodySchema>;

/** Weekday (0 = Sunday) of a YYYY-MM-DD date. */
export const weekdayOf = (date: string) => toDate(date).getUTCDay();

/** Whether a self-check schedule is due on a local date. */
export const selfCheckDueOn = (s: { weekdays: readonly number[] }, date: string) => s.weekdays.includes(weekdayOf(date));

type SQ = Partial<AuditQuestion> & { id: string; text: string };
const yn = (id: string, text: string, o: Partial<AuditQuestion> = {}): AuditQuestion => ({ id, text, type: 'yes_no', weight: 1, critical: false, photoRequired: false, ...o });
const num = (o: SQ): AuditQuestion => ({ type: 'number', weight: 2, critical: false, photoRequired: false, ...o } as AuditQuestion);

export interface SelfCheckStarter extends Omit<AuditTemplateBody, 'description'> { key: string; kind: SelfCheckKind; description: string; industries?: readonly string[]; dueTime: string }

/** Short daily checklists a location runs itself. Generic checks only; HQ edits them into their own standards. */
export const SELF_CHECK_STARTERS: readonly SelfCheckStarter[] = [
  {
    key: 'opening_check', kind: 'opening', name: 'Opening check', description: 'Before the doors open: safety, cleanliness and readiness.', dueTime: '09:00',
    passThreshold: 80, reauditDays: 7, correctiveDays: 1,
    sections: [
      { id: 'safety', title: 'Safety', questions: [
        yn('exits_clear', 'Emergency exits are unlocked and clear', { critical: true }),
        yn('alarm_off', 'Alarm disarmed and no incidents overnight'),
      ] },
      { id: 'space', title: 'Space', questions: [
        yn('floors_clean', 'Floors and surfaces are clean'),
        yn('restrooms_stocked', 'Restrooms are clean and stocked'),
        yn('lights_music', 'Lights, music and temperature are set'),
      ] },
      { id: 'ready', title: 'Ready to open', questions: [
        yn('systems_on', 'Tills, booking screens and card readers are on and working'),
        yn('team_briefed', 'The team on shift is briefed'),
      ] },
    ],
  },
  {
    key: 'closing_check', kind: 'closing', name: 'Closing check', description: 'At close: cash, equipment, cleaning and security.', dueTime: '22:00',
    passThreshold: 80, reauditDays: 7, correctiveDays: 1,
    sections: [
      { id: 'close', title: 'Close', questions: [
        yn('cash_secured', 'Cash counted and secured'),
        yn('equipment_off', 'Equipment switched off (except fridges and freezers)'),
        yn('cleaned', 'Cleaning for the day is complete'),
        yn('waste_out', 'Waste and recycling taken out'),
      ] },
      { id: 'security', title: 'Security', questions: [
        yn('doors_locked', 'Doors and windows locked', { critical: true }),
        yn('alarm_set', 'Alarm set', { critical: true }),
      ] },
    ],
  },
  {
    key: 'temperature_log', kind: 'food_safety', name: 'Food-safety temperature log', description: 'Fridge, freezer and hot-holding temperatures, twice a day.', industries: ['foods', 'hospitality'], dueTime: '11:00',
    passThreshold: 100, reauditDays: 1, correctiveDays: 1,
    sections: [
      { id: 'temps', title: 'Temperatures', questions: [
        num({ id: 'fridge_1', text: 'Walk-in fridge', max: 5, unit: '°C', critical: true }),
        num({ id: 'fridge_2', text: 'Prep fridge', max: 5, unit: '°C', critical: true }),
        num({ id: 'freezer', text: 'Freezer', max: -18, unit: '°C', critical: true }),
        num({ id: 'hot_hold', text: 'Hot-holding', min: 63, unit: '°C' }),
      ] },
      { id: 'checks', title: 'Checks', questions: [
        yn('probe_cleaned', 'Probe thermometer cleaned between readings'),
        yn('dates_checked', 'Use-by dates checked; nothing out of date', { critical: true }),
      ] },
    ],
  },
];

export function selfCheckStartersFor(industry: string): SelfCheckStarter[] {
  return SELF_CHECK_STARTERS.filter((t) => !t.industries || t.industries.includes(industry));
}

/* ------------------------------------------------------------------ */
/* Visit planner                                                       */
/* ------------------------------------------------------------------ */

export interface GeoPoint { lat: number; lng: number }

/** Great-circle distance in kilometres. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))) * 10) / 10;
}

/**
 * Orders stops by nearest neighbour from `start` (or the first stop with a location). Stops without coordinates keep
 * their order at the end. Returns each stop with the leg distance from the previous one.
 */
export function nearestNeighbourRoute<T extends { geo: GeoPoint | null }>(stops: readonly T[], start?: GeoPoint | null): Array<T & { legKm: number | null }> {
  const located = stops.filter((s) => s.geo);
  const rest = stops.filter((s) => !s.geo);
  const out: Array<T & { legKm: number | null }> = [];
  let here: GeoPoint | null = start ?? null;
  const left = [...located];
  while (left.length) {
    let best = 0;
    if (here) {
      let bestD = Infinity;
      left.forEach((s, i) => { const d = haversineKm(here!, s.geo!); if (d < bestD) { bestD = d; best = i; } });
    }
    const [s] = left.splice(best, 1);
    out.push({ ...s!, legKm: here ? haversineKm(here, s!.geo!) : null });
    here = s!.geo;
  }
  for (const s of rest) out.push({ ...s, legKm: null });
  return out;
}

export const routeKm = (legs: ReadonlyArray<{ legKm: number | null }>) => Math.round(legs.reduce((a, l) => a + (l.legKm ?? 0), 0) * 10) / 10;

/* ------------------------------------------------------------------ */
/* Trends                                                              */
/* ------------------------------------------------------------------ */

/** The training a failed item recommends (set per question on the checklist). */
export const questionTraining = (sections: readonly AuditSection[], questionId: string) => {
  for (const s of sections) for (const q of s.questions) if (q.id === questionId) return q.trainingCourseId ? { courseId: q.trainingCourseId, autoAssign: !!q.trainingAutoAssign } : null;
  return null;
};

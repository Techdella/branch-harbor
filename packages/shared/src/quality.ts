/**
 * Field audits, compliance documents and the league table (Operations → Audits, Legal & compliance → Compliance
 * documents, Network → League table). Pure rules shared by the API, the dashboard and the mobile app:
 *
 * - checklist templates (sections, weighted questions, critical items) and the starter checklists per industry;
 * - audit scoring: a percentage of the weighted points, with an automatic fail when a critical item fails;
 * - compliance document states (valid / expiring within 30 days / expired / missing …) and reminder steps;
 * - league table quartiles (computed per metric, and per currency for money, never across currencies).
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Checklist templates                                                 */
/* ------------------------------------------------------------------ */

export const AUDIT_QUESTION_TYPES = ['yes_no', 'scale', 'number', 'text', 'photo'] as const;
export type AuditQuestionType = (typeof AUDIT_QUESTION_TYPES)[number];

const key = z.string().trim().min(1).max(40).regex(/^[a-z0-9_-]+$/i, 'Letters, digits, - and _');

export const auditQuestionSchema = z.object({
  id: key,
  text: z.string().trim().min(1).max(300),
  guidance: z.string().trim().max(600).optional(),
  type: z.enum(AUDIT_QUESTION_TYPES),
  /** Points this question is worth (0 = not scored). Text questions are never scored. */
  weight: z.number().int().min(0).max(100).default(1),
  /** A failed critical item fails the whole audit, whatever the score. */
  critical: z.boolean().default(false),
  /** A photo must be attached to answer the question (always true for `photo` questions). */
  photoRequired: z.boolean().default(false),
  /** Number questions: the passing range (inclusive). Without a range a number is recorded but not scored. */
  min: z.number().optional(),
  max: z.number().optional(),
  /** Number questions: the unit shown next to the value (e.g. °C). */
  unit: z.string().trim().max(12).optional(),
  /** Training academy course recommended when this item fails (retraining loop). */
  trainingCourseId: z.uuid().optional(),
  /** Assign that course to the location's team automatically when the item fails. */
  trainingAutoAssign: z.boolean().optional(),
});
export type AuditQuestion = z.infer<typeof auditQuestionSchema>;

export const auditSectionSchema = z.object({
  id: key,
  title: z.string().trim().min(1).max(160),
  questions: z.array(auditQuestionSchema).min(1).max(80),
});
export type AuditSection = z.infer<typeof auditSectionSchema>;

export const auditTemplateBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).optional().default(''),
  sections: z.array(auditSectionSchema).min(1).max(30),
  /** Pass mark in percent. */
  passThreshold: z.number().int().min(0).max(100).default(80),
  /** Days after a failed audit before the re-audit is due. */
  reauditDays: z.number().int().min(1).max(365).default(30),
  /** Days the location has to complete a corrective action. */
  correctiveDays: z.number().int().min(1).max(180).default(14),
}).superRefine((t, ctx) => {
  const ids = new Set<string>();
  t.sections.forEach((s, si) => s.questions.forEach((q, qi) => {
    if (ids.has(q.id)) ctx.addIssue({ code: 'custom', path: ['sections', si, 'questions', qi, 'id'], message: 'Each question needs a unique id' });
    ids.add(q.id);
    if (q.type === 'number' && q.min !== undefined && q.max !== undefined && q.min > q.max) ctx.addIssue({ code: 'custom', path: ['sections', si, 'questions', qi, 'max'], message: 'The maximum must be at least the minimum' });
  }));
  const sids = t.sections.map((s) => s.id);
  if (new Set(sids).size !== sids.length) ctx.addIssue({ code: 'custom', path: ['sections'], message: 'Each section needs a unique id' });
});
export type AuditTemplateBody = z.infer<typeof auditTemplateBodySchema>;

/* ------------------------------------------------------------------ */
/* Answers and scoring                                                 */
/* ------------------------------------------------------------------ */

export const auditAnswerSchema = z.object({
  /** yes_no: 'yes' | 'no' · scale: 1–5 · number: a number · text: a string · photo: null (the photo is the answer). */
  value: z.union([z.literal('yes'), z.literal('no'), z.number(), z.string().max(4000), z.null()]).optional(),
  /** Not applicable: excluded from the score. */
  na: z.boolean().optional(),
  note: z.string().max(2000).optional(),
  photoIds: z.array(z.uuid()).max(10).optional(),
});
export type AuditAnswer = z.infer<typeof auditAnswerSchema>;
export type AuditAnswers = Record<string, AuditAnswer>;

export interface QuestionResult {
  questionId: string;
  sectionId: string;
  answered: boolean;
  na: boolean;
  /** Points earned and possible (0/0 when the question is not scored or not applicable). */
  earned: number;
  possible: number;
  failed: boolean;
  critical: boolean;
  /** Why it failed or is incomplete: no, low_score, out_of_range, photo_missing, unanswered. */
  reason: 'no' | 'low_score' | 'out_of_range' | 'photo_missing' | 'unanswered' | null;
}

export interface AuditScore {
  /** 0–100 with one decimal; null when nothing is scored. */
  scorePct: number | null;
  earned: number;
  possible: number;
  passed: boolean;
  criticalFailed: boolean;
  /** Questions without an answer (and not marked n/a). */
  unanswered: string[];
  failedItems: QuestionResult[];
  sections: Array<{ id: string; title: string; earned: number; possible: number; scorePct: number | null }>;
  results: QuestionResult[];
}

const hasPhoto = (a: AuditAnswer | undefined) => !!a?.photoIds?.length;

/** Evaluates one question. A scale answer of 1 or 2 fails; 3–5 pass with partial points. */
export function evaluateQuestion(q: AuditQuestion, a: AuditAnswer | undefined, sectionId: string): QuestionResult {
  const base = { questionId: q.id, sectionId, critical: q.critical };
  if (a?.na) return { ...base, answered: true, na: true, earned: 0, possible: 0, failed: false, reason: null };
  const weight = q.type === 'text' ? 0 : q.weight;
  const needsPhoto = q.photoRequired || q.type === 'photo';
  let answered: boolean;
  let ratio = 0;
  let reason: QuestionResult['reason'] = null;
  switch (q.type) {
    case 'yes_no':
      answered = a?.value === 'yes' || a?.value === 'no';
      ratio = a?.value === 'yes' ? 1 : 0;
      if (a?.value === 'no') reason = 'no';
      break;
    case 'scale': {
      const v = typeof a?.value === 'number' ? Math.round(a.value) : null;
      answered = v !== null && v >= 1 && v <= 5;
      ratio = answered ? (v! - 1) / 4 : 0;
      if (answered && v! <= 2) reason = 'low_score';
      break;
    }
    case 'number': {
      const v = typeof a?.value === 'number' && Number.isFinite(a.value) ? a.value : null;
      answered = v !== null;
      const ranged = q.min !== undefined || q.max !== undefined;
      if (!ranged) return { ...base, answered, na: false, earned: 0, possible: 0, failed: false, reason: answered ? null : 'unanswered' };
      const ok = answered && (q.min === undefined || v! >= q.min) && (q.max === undefined || v! <= q.max);
      ratio = ok ? 1 : 0;
      if (answered && !ok) reason = 'out_of_range';
      break;
    }
    case 'text':
      answered = typeof a?.value === 'string' && a.value.trim().length > 0;
      return { ...base, answered, na: false, earned: 0, possible: 0, failed: false, reason: answered ? null : 'unanswered' };
    case 'photo':
      answered = hasPhoto(a);
      ratio = answered ? 1 : 0;
      break;
  }
  if (!answered) return { ...base, answered: false, na: false, earned: 0, possible: weight, failed: false, reason: needsPhoto && q.type === 'photo' ? 'photo_missing' : 'unanswered' };
  if (needsPhoto && !hasPhoto(a)) {
    // An answer without its required photo is incomplete evidence: it can't pass.
    return { ...base, answered: true, na: false, earned: 0, possible: weight, failed: true, reason: 'photo_missing' };
  }
  const earned = Math.round(weight * ratio * 100) / 100;
  return { ...base, answered: true, na: false, earned, possible: weight, failed: reason !== null, reason };
}

/** Scores an audit against its checklist. `passed` needs every question answered, the pass mark and no critical failure. */
export function scoreAudit(t: { sections: AuditSection[]; passThreshold: number }, answers: AuditAnswers): AuditScore {
  const results: QuestionResult[] = [];
  const sections = t.sections.map((s) => {
    let earned = 0;
    let possible = 0;
    for (const q of s.questions) {
      const r = evaluateQuestion(q, answers[q.id], s.id);
      results.push(r);
      earned += r.earned;
      possible += r.possible;
    }
    return { id: s.id, title: s.title, earned, possible, scorePct: possible ? Math.round((earned / possible) * 1000) / 10 : null };
  });
  const earned = results.reduce((a, r) => a + r.earned, 0);
  const possible = results.reduce((a, r) => a + r.possible, 0);
  const scorePct = possible ? Math.round((earned / possible) * 1000) / 10 : null;
  const failedItems = results.filter((r) => r.failed);
  const criticalFailed = failedItems.some((r) => r.critical);
  const unanswered = results.filter((r) => !r.answered).map((r) => r.questionId);
  return {
    scorePct, earned: Math.round(earned * 100) / 100, possible, criticalFailed, unanswered, failedItems, sections, results,
    passed: !criticalFailed && unanswered.length === 0 && (scorePct ?? 100) >= t.passThreshold,
  };
}

export const AUDIT_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];
export const AUDIT_PURPOSES = ['routine', 'pre_opening', 'reaudit'] as const;
export type AuditPurpose = (typeof AUDIT_PURPOSES)[number];
export const CORRECTIVE_STATUSES = ['open', 'submitted', 'verified'] as const;
export type CorrectiveStatus = (typeof CORRECTIVE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Starter checklists                                                  */
/* ------------------------------------------------------------------ */

export interface StarterTemplate extends Omit<AuditTemplateBody, 'description'> {
  key: string;
  description: string;
  /** Industries the starter is offered to (all when absent). */
  industries?: readonly string[];
  /** Suggested for the pre-opening checks of a new location. */
  preOpening?: boolean;
}

type Q = Partial<AuditQuestion> & { id: string; text: string };
const yn = (id: string, text: string, o: Partial<AuditQuestion> = {}): AuditQuestion => ({ id, text, type: 'yes_no', weight: 1, critical: false, photoRequired: false, ...o });
const sc = (id: string, text: string, o: Partial<AuditQuestion> = {}): AuditQuestion => ({ id, text, type: 'scale', weight: 2, critical: false, photoRequired: false, ...o });
const q = (o: Q & { type: AuditQuestionType }): AuditQuestion => ({ weight: 1, critical: false, photoRequired: false, ...o } as AuditQuestion);

/**
 * Starter checklists offered when HQ creates a template. They hold sensible, generic checks only (no sample data);
 * HQ edits them into their own brand standards.
 */
export const STARTER_AUDIT_TEMPLATES: readonly StarterTemplate[] = [
  {
    key: 'brand_standards', name: 'Brand standards visit', description: 'A field consultant’s routine visit: storefront, interior, team, customer experience and local marketing.',
    passThreshold: 80, reauditDays: 30, correctiveDays: 14,
    sections: [
      { id: 'exterior', title: 'Exterior and signage', questions: [
        yn('sign_clean', 'Signage is clean, lit and undamaged', { photoRequired: true }),
        yn('entrance_clear', 'Entrance is clear, swept and welcoming'),
        yn('hours_posted', 'Opening hours are posted and match the website'),
      ] },
      { id: 'interior', title: 'Interior', questions: [
        sc('interior_condition', 'Overall condition of the interior (1 poor – 5 excellent)'),
        yn('brand_materials', 'Only current, approved brand materials are on display', { photoRequired: true }),
        yn('music_lighting', 'Music, lighting and temperature follow the brand standard'),
      ] },
      { id: 'team', title: 'Team', questions: [
        yn('uniforms', 'Team members wear the approved uniform and name badges'),
        yn('greeting', 'Customers are greeted within 30 seconds of arriving'),
        sc('product_knowledge', 'Team product and service knowledge (1–5)'),
        yn('training_current', 'Required training is up to date for the team on shift'),
      ] },
      { id: 'experience', title: 'Customer experience', questions: [
        sc('service_flow', 'Service flow and wait times (1–5)'),
        yn('complaints_logged', 'Complaints are recorded and followed up'),
        q({ id: 'experience_notes', text: 'What stood out during the visit?', type: 'text', weight: 0 }),
      ] },
      { id: 'marketing', title: 'Local marketing', questions: [
        yn('current_campaign', 'The current network campaign is visible in store'),
        yn('online_listing', 'Online listing details (address, hours, phone) are correct'),
      ] },
    ],
  },
  {
    key: 'cleanliness_safety', name: 'Cleanliness & safety', description: 'Cleaning standards, fire and first-aid readiness, and hazards.',
    passThreshold: 85, reauditDays: 14, correctiveDays: 7,
    sections: [
      { id: 'cleaning', title: 'Cleaning', questions: [
        sc('floors', 'Floors and surfaces are clean (1–5)'),
        sc('restrooms', 'Restrooms are clean and stocked (1–5)', { photoRequired: true }),
        yn('cleaning_log', 'The cleaning log is complete for the last 7 days'),
        yn('waste', 'Waste is stored and removed correctly'),
      ] },
      { id: 'fire', title: 'Fire safety', questions: [
        yn('exits_clear', 'Emergency exits are unlocked and unobstructed', { critical: true, photoRequired: true }),
        yn('extinguishers', 'Fire extinguishers are in place and in date', { critical: true }),
        yn('alarm_tested', 'The fire alarm test is recorded within the required interval'),
      ] },
      { id: 'first_aid', title: 'First aid and incidents', questions: [
        yn('first_aid_kit', 'The first-aid kit is complete and in date'),
        yn('first_aider', 'A trained first aider is on shift'),
        yn('incident_log', 'Incidents are recorded in the incident log'),
      ] },
      { id: 'hazards', title: 'Hazards', questions: [
        yn('chemicals', 'Cleaning chemicals are labelled and stored safely', { critical: true }),
        yn('trip_hazards', 'No trip hazards, loose cables or damaged fittings'),
        q({ id: 'hazard_notes', text: 'Hazards found and actions taken', type: 'text', weight: 0 }),
      ] },
    ],
  },
  {
    key: 'pre_opening', name: 'Pre-opening check', description: 'HQ sign-off before a new location opens: fit-out, systems, team, safety and brand.', preOpening: true,
    passThreshold: 90, reauditDays: 7, correctiveDays: 5,
    sections: [
      { id: 'fit_out', title: 'Fit-out', questions: [
        yn('fitout_complete', 'Fit-out matches the approved design package', { photoRequired: true }),
        yn('snagging', 'All snagging items are closed'),
        q({ id: 'exterior_photo', text: 'Photo of the finished storefront', type: 'photo', weight: 1 }),
      ] },
      { id: 'compliance', title: 'Permits and safety', questions: [
        yn('permits', 'Occupancy and trading permits are on file', { critical: true }),
        yn('insurance', 'Insurance certificates are on file and in date', { critical: true }),
        yn('fire_signoff', 'Fire safety sign-off is complete', { critical: true }),
      ] },
      { id: 'systems', title: 'Systems', questions: [
        yn('payments_live', 'Payments are live and a test transaction succeeded'),
        yn('booking_test', 'A test booking or order went end to end'),
        yn('website_ready', 'The location website is ready for HQ review'),
      ] },
      { id: 'team', title: 'Team', questions: [
        yn('team_hired', 'The opening team is hired'),
        yn('team_trained', 'The opening team completed required training'),
        sc('team_readiness', 'Team readiness (1–5)'),
      ] },
      { id: 'brand', title: 'Brand', questions: [
        yn('signage_installed', 'Approved signage is installed'),
        yn('materials_stocked', 'Opening stock and brand materials are in place'),
      ] },
    ],
  },
  {
    key: 'room_inspection', name: 'Hospitality room inspection', description: 'Room-by-room inspection after housekeeping: cleanliness, amenities, maintenance and safety.', industries: ['hospitality'],
    passThreshold: 90, reauditDays: 14, correctiveDays: 3,
    sections: [
      { id: 'room', title: 'Room and bathroom', questions: [
        q({ id: 'room_number', text: 'Room inspected', type: 'text', weight: 0 }),
        sc('bed', 'Bed made to standard, linen clean and unstained (1–5)', { photoRequired: true }),
        sc('bathroom', 'Bathroom clean, dry and free of hair (1–5)', { photoRequired: true }),
        yn('dusting', 'Surfaces, headboard and skirting are dust-free'),
        yn('odour', 'No odours; the room is aired'),
      ] },
      { id: 'amenities', title: 'Amenities', questions: [
        yn('towels', 'Towels and toiletries are stocked to standard'),
        yn('minibar', 'Minibar, kettle and refreshments are stocked'),
        yn('info', 'Guest information and Wi-Fi details are present'),
      ] },
      { id: 'maintenance', title: 'Maintenance', questions: [
        yn('lights', 'All lights, sockets and the TV work'),
        yn('hvac', 'Heating or air conditioning works'),
        yn('plumbing', 'Taps, shower and toilet work without leaks'),
      ] },
      { id: 'safety', title: 'Safety', questions: [
        yn('smoke_detector', 'Smoke detector is present and the test light works', { critical: true }),
        yn('door_lock', 'Door lock, chain and peephole work', { critical: true }),
        yn('evacuation_plan', 'Evacuation plan is displayed on the door'),
      ] },
    ],
  },
  {
    key: 'kitchen_food_safety', name: 'Kitchen food safety', description: 'Temperatures, storage, hygiene, allergens and pest control (HACCP-style).', industries: ['foods', 'hospitality'],
    passThreshold: 85, reauditDays: 14, correctiveDays: 3,
    sections: [
      { id: 'temperatures', title: 'Temperatures', questions: [
        q({ id: 'fridge_temp', text: 'Walk-in fridge temperature', type: 'number', max: 5, unit: '°C', critical: true, weight: 2 }),
        q({ id: 'freezer_temp', text: 'Freezer temperature', type: 'number', max: -18, unit: '°C', critical: true, weight: 2 }),
        q({ id: 'hot_hold', text: 'Hot-holding temperature', type: 'number', min: 63, unit: '°C', weight: 2 }),
        yn('temp_log', 'Temperature log is complete for the last 7 days'),
      ] },
      { id: 'storage', title: 'Storage', questions: [
        yn('labelled', 'Food is covered, labelled and dated'),
        yn('raw_cooked', 'Raw and ready-to-eat food are stored apart', { critical: true }),
        yn('fifo', 'Stock rotation (first in, first out) is followed'),
        yn('expired', 'No out-of-date products', { critical: true, photoRequired: true }),
      ] },
      { id: 'hygiene', title: 'Hygiene', questions: [
        yn('handwash', 'Hand-wash stations have soap, hot water and towels', { critical: true }),
        yn('ppe', 'Staff wear clean uniforms, hair restraints and gloves where required'),
        sc('cleanliness', 'Kitchen cleanliness (1–5)', { photoRequired: true }),
      ] },
      { id: 'allergens', title: 'Allergens', questions: [
        yn('allergen_matrix', 'The allergen matrix is current and available to staff'),
        yn('allergen_separation', 'Allergen-free preparation is separated'),
      ] },
      { id: 'pests', title: 'Pest control', questions: [
        yn('no_pests', 'No signs of pests', { critical: true }),
        yn('pest_contract', 'The pest control visit report is on file'),
      ] },
    ],
  },
];

/** Starter checklists offered to an industry. */
export function startersFor(industry: string): StarterTemplate[] {
  return STARTER_AUDIT_TEMPLATES.filter((t) => !t.industries || t.industries.includes(industry));
}

/* ------------------------------------------------------------------ */
/* Compliance documents                                                */
/* ------------------------------------------------------------------ */

export const COMPLIANCE_CATEGORIES = ['insurance', 'licence', 'permit', 'health_certificate', 'franchisee_document'] as const;
export type ComplianceCategory = (typeof COMPLIANCE_CATEGORIES)[number];

/** States of a matrix cell (location × requirement). */
export const COMPLIANCE_STATES = ['valid', 'expiring', 'expired', 'missing', 'pending', 'below_minimum'] as const;
export type ComplianceState = (typeof COMPLIANCE_STATES)[number];

/** Days before expiry when reminders go out; 0 = on the day it expires (and HQ is told). */
export const COMPLIANCE_REMINDER_DAYS = [60, 30, 7, 0] as const;
export const COMPLIANCE_EXPIRING_DAYS = 30;

/** Whole days from `today` (YYYY-MM-DD) to `ymd`. */
export function daysUntil(ymd: string, today: string): number {
  return Math.round((Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/**
 * The state of one requirement at one location from its documents: an approved, unexpired document makes it valid
 * (or expiring within 30 days); a document waiting for review is pending; an approved document below the required
 * amount does not satisfy it.
 */
export function complianceState(
  docs: ReadonlyArray<{ status: string; expiresOn: string | null; coverageAmountMinor: number | null; currency: string | null }>,
  req: { minAmountMinor: number | null; currency: string | null },
  today: string,
): { state: ComplianceState; expiresOn: string | null; daysLeft: number | null } {
  const approved = docs.filter((d) => d.status === 'approved').sort((a, b) => (b.expiresOn ?? '9999').localeCompare(a.expiresOn ?? '9999'));
  const meetsAmount = (d: (typeof approved)[number]) => req.minAmountMinor == null || (d.coverageAmountMinor != null && d.coverageAmountMinor >= req.minAmountMinor && (!req.currency || d.currency === req.currency));
  const current = approved.filter((d) => !d.expiresOn || d.expiresOn >= today);
  const best = current.find(meetsAmount);
  if (best) {
    const daysLeft = best.expiresOn ? daysUntil(best.expiresOn, today) : null;
    return { state: daysLeft !== null && daysLeft <= COMPLIANCE_EXPIRING_DAYS ? 'expiring' : 'valid', expiresOn: best.expiresOn, daysLeft };
  }
  if (docs.some((d) => d.status === 'pending')) return { state: 'pending', expiresOn: null, daysLeft: null };
  if (current.length) return { state: 'below_minimum', expiresOn: current[0]!.expiresOn, daysLeft: current[0]!.expiresOn ? daysUntil(current[0]!.expiresOn, today) : null };
  if (approved.length) return { state: 'expired', expiresOn: approved[0]!.expiresOn, daysLeft: approved[0]!.expiresOn ? daysUntil(approved[0]!.expiresOn, today) : null };
  return { state: 'missing', expiresOn: null, daysLeft: null };
}

/** The reminder step due for a document (the smallest threshold reached and not yet sent), or null. */
export function dueReminderStep(daysLeft: number, sent: readonly number[]): number | null {
  const due = COMPLIANCE_REMINDER_DAYS.filter((d) => daysLeft <= d && !sent.includes(d));
  return due.length ? Math.min(...due) : null;
}

/* ------------------------------------------------------------------ */
/* League table                                                        */
/* ------------------------------------------------------------------ */

export const LEAGUE_METRICS = ['revenue', 'growth', 'activity', 'occupancy', 'auditScore', 'royaltyStatus', 'reviewRating'] as const;
export type LeagueMetric = (typeof LEAGUE_METRICS)[number];

export interface Quartiles { count: number; min: number; q1: number; median: number; q3: number; max: number }

/** Quartiles (linear interpolation) of a list of values; null with fewer than 4 values (too few to stay anonymous). */
export function quartiles(values: readonly number[], minCount = 4): Quartiles | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < minCount) return null;
  const at = (p: number) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return Math.round((v[lo]! + (v[hi]! - v[lo]!) * (i - lo)) * 100) / 100;
  };
  return { count: v.length, min: v[0]!, q1: at(0.25), median: at(0.5), q3: at(0.75), max: v[v.length - 1]! };
}

/** Which quartile (1 = top 25 %) a value falls in, for a metric where higher is better. */
export function quartileOf(value: number, q: Quartiles): 1 | 2 | 3 | 4 {
  if (value >= q.q3) return 1;
  if (value >= q.median) return 2;
  if (value >= q.q1) return 3;
  return 4;
}

/** Growth in percent between two amounts of the same currency; null when there is no previous amount. */
export function growthPct(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

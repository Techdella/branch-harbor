/**
 * Franchise development features competitors have (research §7 #7, #8, #12 and §12 Phase 2/3):
 *
 * - Territory map: GeoJSON geometry or postcode lists, status tied to the pipeline and agreements, exclusivity rules
 *   and overlap detection, demographics and scoring.
 * - Franchisee satisfaction surveys (eNPS + custom questions, anonymity threshold) and candidate validation calls.
 * - Agreement lifecycle: transfers, notices of default with cure periods, amendments, renewals with option windows and
 *   multi-unit development schedules.
 * - Master franchise: royalty and marketing-fund splits between HQ and a master franchisee, per currency.
 *
 * Everything here is pure and shared by the API (enforcement) and the apps (display). Legal templates are a
 * compliance aid, never legal advice: every notice is flagged "review with counsel" before it can be issued.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Territories                                                         */
/* ------------------------------------------------------------------ */

/** Committed statuses: a territory in one of these is taken (by a reservation, an agreement or an open location). */
export const COMMITTED_TERRITORY_STATUSES = ['reserved', 'sold', 'under_development', 'open'] as const;
export const TERRITORY_EXCLUSIVITY = ['exclusive', 'protected', 'non_exclusive'] as const;
export type TerritoryExclusivity = (typeof TERRITORY_EXCLUSIVITY)[number];

export type Position = [number, number];
export type PolygonGeometry = { type: 'Polygon'; coordinates: Position[][] };
export type MultiPolygonGeometry = { type: 'MultiPolygon'; coordinates: Position[][][] };
export type TerritoryGeometry = PolygonGeometry | MultiPolygonGeometry;

const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
/** A ring is closed automatically and needs at least three distinct points. */
const ring = z.array(position).min(3).max(5000).transform((r) => {
  const [a, b] = [r[0]!, r[r.length - 1]!];
  return (a[0] === b[0] && a[1] === b[1] ? r : [...r, a]) as Position[];
}).refine((r) => r.length >= 4, 'A ring needs at least three points');

export const territoryGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1).max(50) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1).max(50)).min(1).max(100) }),
]);

export const polygonsOf = (g: TerritoryGeometry): Position[][][] => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

export function bboxOf(g: TerritoryGeometry): [number, number, number, number] {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of polygonsOf(g)) for (const [x, y] of poly[0] ?? []) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

const KM_PER_DEG = 111.32;
/** Signed planar area of a ring in km², projected around `lat0` (good enough for territory-sized shapes). */
function ringArea(r: Position[], lat0: number) {
  const k = Math.cos((lat0 * Math.PI) / 180);
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const [x1, y1] = r[i]!;
    const [x2, y2] = r[i + 1]!;
    s += x1 * k * KM_PER_DEG * (y2 * KM_PER_DEG) - x2 * k * KM_PER_DEG * (y1 * KM_PER_DEG);
  }
  return s / 2;
}

/** Area in km² (outer rings minus holes). */
export function areaKm2(g: TerritoryGeometry): number {
  const [, minY, , maxY] = bboxOf(g);
  const lat0 = (minY + maxY) / 2;
  let a = 0;
  for (const poly of polygonsOf(g)) poly.forEach((r, i) => (a += (i === 0 ? 1 : -1) * Math.abs(ringArea(r, lat0))));
  return Math.round(Math.max(0, a) * 100) / 100;
}

/** Area-weighted centroid of the outer rings, as { lat, lng }. */
export function centroidOf(g: TerritoryGeometry): { lat: number; lng: number } {
  let [cx, cy, w] = [0, 0, 0];
  for (const poly of polygonsOf(g)) {
    const r = poly[0]!;
    let [a, x, y] = [0, 0, 0];
    for (let i = 0; i < r.length - 1; i++) {
      const [x1, y1] = r[i]!;
      const [x2, y2] = r[i + 1]!;
      const f = x1 * y2 - x2 * y1;
      a += f; x += (x1 + x2) * f; y += (y1 + y2) * f;
    }
    if (Math.abs(a) < 1e-12) continue;
    cx += x / (3 * a) * Math.abs(a); cy += y / (3 * a) * Math.abs(a); w += Math.abs(a);
  }
  if (!w) { const [a, b, c, d] = bboxOf(g); return { lng: (a + c) / 2, lat: (b + d) / 2 }; }
  return { lng: Math.round((cx / w) * 1e6) / 1e6, lat: Math.round((cy / w) * 1e6) / 1e6 };
}

function inRing(p: Position, r: Position[]) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]!;
    const [xj, yj] = r[j]!;
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInGeometry(p: Position, g: TerritoryGeometry): boolean {
  return polygonsOf(g).some((poly) => inRing(p, poly[0]!) && !poly.slice(1).some((h) => inRing(p, h)));
}

function segmentsCross(a: Position, b: Position, c: Position, d: Position) {
  const o = (p: Position, q: Position, r: Position) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

function onBoundary(p: Position, r: Position[], eps = 1e-9) {
  for (let i = 0; i < r.length - 1; i++) {
    const [a, b] = [r[i]!, r[i + 1]!];
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(cross) > eps) continue;
    if (p[0] >= Math.min(a[0], b[0]) - eps && p[0] <= Math.max(a[0], b[0]) + eps && p[1] >= Math.min(a[1], b[1]) - eps && p[1] <= Math.max(a[1], b[1]) + eps) return true;
  }
  return false;
}

/** True when two territories share area (touching edges only do not count). */
export function geometriesOverlap(a: TerritoryGeometry, b: TerritoryGeometry): boolean {
  const [ax1, ay1, ax2, ay2] = bboxOf(a);
  const [bx1, by1, bx2, by2] = bboxOf(b);
  if (ax2 <= bx1 || bx2 <= ax1 || ay2 <= by1 || by2 <= ay1) return false;
  for (const pa of polygonsOf(a)) for (const pb of polygonsOf(b)) {
    const ra = pa[0]!;
    const rb = pb[0]!;
    for (let i = 0; i < ra.length - 1; i++) for (let j = 0; j < rb.length - 1; j++) if (segmentsCross(ra[i]!, ra[i + 1]!, rb[j]!, rb[j + 1]!)) return true;
    // One inside the other (no crossing edges): a vertex strictly inside the other shape (points on a shared edge
    // don't count, so neighbours that touch are not an overlap), or a centroid inside it.
    const gb: TerritoryGeometry = { type: 'Polygon', coordinates: pb };
    const ga: TerritoryGeometry = { type: 'Polygon', coordinates: pa };
    if (ra.some((p) => !onBoundary(p, rb) && pointInGeometry(p, gb))) return true;
    if (rb.some((p) => !onBoundary(p, ra) && pointInGeometry(p, ga))) return true;
    const ca = centroidOf(ga);
    const cb = centroidOf(gb);
    if (pointInGeometry([ca.lng, ca.lat], gb) && pointInGeometry([ca.lng, ca.lat], ga)) return true;
    if (pointInGeometry([cb.lng, cb.lat], ga) && pointInGeometry([cb.lng, cb.lat], gb)) return true;
  }
  return false;
}

/** Postcodes / ZIP codes compared upper-case without spaces ("m5v 1a1" = "M5V1A1"). */
export const normalizePostcode = (s: string) => s.toUpperCase().replace(/\s+/g, '').trim();

export function parsePostcodeList(text: string): string[] {
  return [...new Set(text.split(/[\n,;]+/).map(normalizePostcode).filter((x) => /^[A-Z0-9-]{2,10}$/.test(x)))];
}

export interface TerritoryShape {
  id: string;
  name: string;
  status: string;
  exclusivity: TerritoryExclusivity;
  geometry: TerritoryGeometry | null;
  postcodes: string[];
  /** Brand whose availability map the territory is on (null = the default brand). Territories of different brands never overlap. */
  brandId?: string | null;
}

export interface TerritoryOverlap {
  id: string;
  name: string;
  status: string;
  /** How they overlap: drawn areas, shared postcodes, or both. */
  by: Array<'area' | 'postcodes'>;
  sharedPostcodes: string[];
  /** Overlap that the exclusivity rules forbid (one of them is exclusive and the other is taken). */
  conflict: boolean;
}

const committed = (s: string) => (COMMITTED_TERRITORY_STATUSES as readonly string[]).includes(s);

/**
 * Overlaps between `t` and the other territories. A conflict is an overlap with a taken territory (reserved, sold,
 * under development or open) where either side is exclusive, or both are protected.
 */
export function findOverlaps(t: TerritoryShape, others: TerritoryShape[]): TerritoryOverlap[] {
  const mine = new Set(t.postcodes.map(normalizePostcode));
  const out: TerritoryOverlap[] = [];
  for (const o of others) {
    if (o.id === t.id) continue;
    // Each brand has its own map: two brands may sell the same area.
    if ((o.brandId ?? null) !== (t.brandId ?? null)) continue;
    const by: TerritoryOverlap['by'] = [];
    if (t.geometry && o.geometry && geometriesOverlap(t.geometry, o.geometry)) by.push('area');
    const shared = o.postcodes.map(normalizePostcode).filter((p) => mine.has(p));
    if (shared.length) by.push('postcodes');
    if (!by.length) continue;
    const strict = t.exclusivity === 'exclusive' || o.exclusivity === 'exclusive' || (t.exclusivity === 'protected' && o.exclusivity === 'protected');
    out.push({ id: o.id, name: o.name, status: o.status, by, sharedPostcodes: shared.slice(0, 50), conflict: strict && (committed(o.status) || committed(t.status)) && t.exclusivity !== 'non_exclusive' && o.exclusivity !== 'non_exclusive' });
  }
  return out;
}

/**
 * Status that the pipeline and agreements imply: the most advanced deal wins (open > under development > sold >
 * reserved). Without any deal a lapsed reservation goes back to available; sold / under development / open set by
 * hand (contracts signed outside BranchHarbor) and `unavailable` are kept.
 */
export function deriveTerritoryStatus(current: string, links: { openLocation: boolean; activeProject: boolean; activeAgreement: boolean; activeProspect: boolean }): string {
  if (links.openLocation) return 'open';
  if (links.activeProject) return 'under_development';
  if (links.activeAgreement) return 'sold';
  if (links.activeProspect) return 'reserved';
  return current === 'reserved' ? 'available' : current;
}

/* ------------------------------------------------------------------ */
/* Demographics and scoring                                            */
/* ------------------------------------------------------------------ */

export interface Demographics {
  population: number | null;
  households: number | null;
  /** Median household income in minor units of `currency` (household-weighted mean of the areas' medians). */
  medianHouseholdIncomeMinor: number | null;
  currency: string;
  /** Provider key, e.g. `us_census_acs5`, `sandbox`. */
  source: string;
  /** Survey year (ACS 5-year end year) when known. */
  year: number | null;
  /** Number of areas (ZCTAs, postcode districts…) the figures were built from. */
  areas: number;
  /** Postcodes the provider had no data for. */
  missing: string[];
  sandbox: boolean;
  fetchedAt: string;
}

export interface ScoringTargets {
  /** Population at which the population part scores full marks. */
  population: number;
  households: number;
  /** Median household income (minor units) at which the income part scores full marks. */
  incomeMinor: number;
}

export const DEFAULT_SCORING_TARGETS: ScoringTargets = { population: 120_000, households: 45_000, incomeMinor: 8_500_000 };

export interface ScorePart { key: 'population' | 'households' | 'income' | 'performance'; weight: number; value: number | null }
export interface TerritoryScore { score: number | null; parts: ScorePart[] }

/**
 * Territory score 0–100: population (40), median income (25), households (15) and how the network's locations nearby
 * perform against the network median (20). Missing parts are left out and the rest re-weighted.
 */
export function scoreTerritory(d: Pick<Demographics, 'population' | 'households' | 'medianHouseholdIncomeMinor'> | null, perf: { nearbyRevenueMinor: number | null; networkMedianRevenueMinor: number | null } | null, targets: ScoringTargets = DEFAULT_SCORING_TARGETS): TerritoryScore {
  const cap = (x: number) => Math.max(0, Math.min(1, x));
  const parts: ScorePart[] = [
    { key: 'population', weight: 40, value: d?.population != null ? cap(d.population / targets.population) : null },
    { key: 'income', weight: 25, value: d?.medianHouseholdIncomeMinor != null ? cap(d.medianHouseholdIncomeMinor / targets.incomeMinor) : null },
    { key: 'households', weight: 15, value: d?.households != null ? cap(d.households / targets.households) : null },
    { key: 'performance', weight: 20, value: perf?.nearbyRevenueMinor != null && perf.networkMedianRevenueMinor ? cap((perf.nearbyRevenueMinor / perf.networkMedianRevenueMinor) * 0.5) : null },
  ];
  const known = parts.filter((p) => p.value !== null);
  if (!known.length) return { score: null, parts };
  const w = known.reduce((s, p) => s + p.weight, 0);
  return { score: Math.round((known.reduce((s, p) => s + p.weight * p.value!, 0) / w) * 100), parts: parts.map((p) => ({ ...p, value: p.value === null ? null : Math.round(p.value * 100) / 100 })) };
}

/* ------------------------------------------------------------------ */
/* Franchisee satisfaction surveys                                     */
/* ------------------------------------------------------------------ */

export const SURVEY_QUESTION_TYPES = ['nps', 'scale', 'choice', 'text'] as const;
export const SURVEY_RECURRENCES = ['once', 'quarterly', 'semiannual', 'annual'] as const;
export const SURVEY_AUDIENCES = ['franchise_owners', 'owners_and_managers'] as const;
export type SurveyRecurrence = (typeof SURVEY_RECURRENCES)[number];

export const surveyQuestionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/),
  type: z.enum(SURVEY_QUESTION_TYPES),
  label: z.string().trim().min(1).max(300),
  required: z.boolean().default(true),
  /** Choices for `choice` questions. */
  options: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
  /** Theme for results grouping (support, marketing, training, value, …). */
  theme: z.string().trim().max(40).nullable().default(null),
});
export type SurveyQuestion = z.infer<typeof surveyQuestionSchema>;

export const surveyBodySchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().default(null),
  questions: z.array(surveyQuestionSchema).min(1).max(40).refine((q) => new Set(q.map((x) => x.id)).size === q.length, 'Question ids must be unique')
    .refine((q) => q.every((x) => x.type !== 'choice' || x.options.length >= 2), 'Choice questions need at least two options'),
  anonymous: z.boolean().default(true),
  /** Results (and slices of them) are hidden below this many responses when anonymous. */
  minResponses: z.number().int().min(3).max(50).default(5),
  audience: z.enum(SURVEY_AUDIENCES).default('franchise_owners'),
  recurrence: z.enum(SURVEY_RECURRENCES).default('once'),
  /** Days each round stays open. */
  openDays: z.number().int().min(1).max(60).default(14),
});
export type SurveyBody = z.infer<typeof surveyBodySchema>;

/** The eNPS-style starter: "How likely are you to recommend owning a {brand} franchise?" plus themed scales. */
export const STARTER_SURVEY: SurveyBody = {
  title: 'Franchisee satisfaction',
  description: 'Your honest view helps us improve support. Answers are anonymous: HQ only sees results when enough owners have answered.',
  questions: [
    { id: 'enps', type: 'nps', label: 'How likely are you to recommend owning a franchise in our network to a friend?', required: true, options: [], theme: null },
    { id: 'support', type: 'scale', label: 'How satisfied are you with the support you get from HQ?', required: true, options: [], theme: 'support' },
    { id: 'marketing', type: 'scale', label: 'How well does network marketing bring customers to your location?', required: true, options: [], theme: 'marketing' },
    { id: 'training', type: 'scale', label: 'How useful is the training for you and your team?', required: true, options: [], theme: 'training' },
    { id: 'value', type: 'scale', label: 'Do the royalties and fees feel like good value?', required: true, options: [], theme: 'value' },
    { id: 'invest_again', type: 'choice', label: 'Would you invest in this franchise again?', required: true, options: ['Yes', 'Probably', 'Not sure', 'No'], theme: null },
    { id: 'improve', type: 'text', label: 'What one thing should HQ improve next?', required: false, options: [], theme: null },
  ],
  anonymous: true, minResponses: 5, audience: 'franchise_owners', recurrence: 'quarterly', openDays: 14,
};

export type SurveyAnswer = number | string | null;

/** Validates answers against the questions; returns field errors keyed by question id. */
export function validateSurveyAnswers(questions: SurveyQuestion[], answers: Record<string, SurveyAnswer>): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const q of questions) {
    const a = answers[q.id];
    const empty = a === null || a === undefined || a === '';
    if (empty) { if (q.required) errs[q.id] = 'Required'; continue; }
    if (q.type === 'nps' && !(Number.isInteger(a) && (a as number) >= 0 && (a as number) <= 10)) errs[q.id] = 'Answer 0 to 10';
    if (q.type === 'scale' && !(Number.isInteger(a) && (a as number) >= 1 && (a as number) <= 5)) errs[q.id] = 'Answer 1 to 5';
    if (q.type === 'choice' && !q.options.includes(a as string)) errs[q.id] = 'Choose one of the options';
    if (q.type === 'text' && (typeof a !== 'string' || a.length > 4000)) errs[q.id] = 'At most 4000 characters';
  }
  for (const k of Object.keys(answers)) if (!questions.some((q) => q.id === k)) errs[k] = 'Unknown question';
  return errs;
}

export interface NpsResult { n: number; promoters: number; passives: number; detractors: number; score: number | null }

/** eNPS: % promoters (9–10) minus % detractors (0–6), −100…100. */
export function npsOf(scores: number[]): NpsResult {
  const n = scores.length;
  const promoters = scores.filter((s) => s >= 9).length;
  const detractors = scores.filter((s) => s <= 6).length;
  return { n, promoters, passives: n - promoters - detractors, detractors, score: n ? Math.round(((promoters - detractors) / n) * 100) : null };
}

/** Whether a slice of `n` responses may be shown (anonymous surveys hide small groups). */
export const sliceVisible = (n: number, anonymous: boolean, minResponses: number) => !anonymous || n >= minResponses;

export function nextRoundDate(from: string, r: SurveyRecurrence): string | null {
  const months = r === 'quarterly' ? 3 : r === 'semiannual' ? 6 : r === 'annual' ? 12 : 0;
  if (!months) return null;
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export const ACTION_PLAN_STATUSES = ['open', 'in_progress', 'done'] as const;

/* ------------------------------------------------------------------ */
/* Validation calls                                                    */
/* ------------------------------------------------------------------ */

export const VALIDATION_CALL_STATUSES = ['requested', 'scheduled', 'completed', 'no_show', 'cancelled'] as const;
export const VALIDATION_SENTIMENTS = ['positive', 'neutral', 'negative'] as const;

export interface ValidatorCandidate { id: string; country: string | null; region: string | null; callsLast90: number; callsThisMonth: number; maxCallsPerMonth: number; lastCallAt: string | null }

/**
 * Rotation: validators under their monthly limit, same region first, then same country, then fewest calls in the last
 * 90 days, then the longest since their last call. Never the same validator twice for one candidate.
 */
export function pickValidators<T extends ValidatorCandidate>(pool: T[], prospect: { country: string; region: string | null }, n: number, exclude: Iterable<string> = []): T[] {
  const skip = new Set(exclude);
  const rank = (v: T) => (v.country === prospect.country && v.region && v.region === prospect.region ? 0 : v.country === prospect.country ? 1 : 2);
  return pool
    .filter((v) => !skip.has(v.id) && v.callsThisMonth < v.maxCallsPerMonth)
    .sort((a, b) => rank(a) - rank(b) || a.callsLast90 - b.callsLast90 || (a.lastCallAt ?? '').localeCompare(b.lastCallAt ?? ''))
    .slice(0, n);
}

/* ------------------------------------------------------------------ */
/* Agreement lifecycle                                                 */
/* ------------------------------------------------------------------ */

export const COUNSEL_NOTICE = 'Templates are a starting point, not legal advice. Have franchise counsel review every notice, transfer and amendment before it is issued or signed, and check the agreement and local law for notice and cure requirements.';

export const TRANSFER_STATUSES = ['draft', 'in_review', 'approved', 'completed', 'rejected', 'cancelled'] as const;
export const TRANSFER_STEPS = ['buyer_application', 'buyer_qualified', 'buyer_disclosure', 'financial_review', 'buyer_training', 'release_signed', 'transfer_fee_paid', 'new_agreement_signed'] as const;
export type TransferStep = (typeof TRANSFER_STEPS)[number];
/** Steps that must be done before HQ can approve, and before the transfer can complete. */
export const TRANSFER_APPROVAL_STEPS: readonly TransferStep[] = ['buyer_application', 'buyer_qualified', 'buyer_disclosure', 'financial_review'];
export const TRANSFER_COMPLETION_STEPS: readonly TransferStep[] = TRANSFER_STEPS;

export const NOTICE_KINDS = ['default', 'cure_reminder', 'termination', 'withdrawal'] as const;
export const NOTICE_REASONS = ['non_payment', 'brand_standards', 'insurance', 'reporting', 'unauthorized_transfer', 'other'] as const;
export const NOTICE_STATUSES = ['draft', 'issued', 'cured', 'escalated', 'terminated', 'withdrawn'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export type NoticeReason = (typeof NOTICE_REASONS)[number];

/** Typical cure periods used when the agreement doesn't say otherwise (days). Always confirm with counsel. */
export const DEFAULT_CURE_DAYS: Record<NoticeReason, number> = { non_payment: 10, brand_standards: 30, insurance: 10, reporting: 15, unauthorized_transfer: 30, other: 30 };

const REASON_TEXT: Record<NoticeReason, string> = {
  non_payment: 'failure to pay amounts due under the Agreement ({{details}})',
  brand_standards: 'failure to operate the franchised business in line with the brand standards and operations manual ({{details}})',
  insurance: 'failure to maintain the insurance coverage required by the Agreement ({{details}})',
  reporting: 'failure to submit the reports required by the Agreement ({{details}})',
  unauthorized_transfer: 'a transfer or attempted transfer without our prior written consent ({{details}})',
  other: '{{details}}',
};

/** Notice templates (English). Placeholders: {{franchisee}}, {{brand}}, {{agreement_date}}, {{reason}}, {{cure_days}}, {{cure_deadline}}, {{details}}, {{date}}. */
export const NOTICE_TEMPLATES: Record<NoticeKind, { subject: string; body: string }> = {
  default: {
    subject: 'Notice of default under your {{brand}} franchise agreement',
    body: 'Date: {{date}}\n\nTo: {{franchisee}}\n\nRe: Franchise agreement dated {{agreement_date}}\n\nThis is formal notice that you are in default of the franchise agreement because of {{reason}}.\n\nYou have {{cure_days}} days from the date of this notice, until {{cure_deadline}}, to cure this default. If it is not cured by then, we may exercise our rights under the agreement, which can include termination.\n\nNothing in this notice waives any of our rights under the agreement or applicable law.\n\n{{brand}}',
  },
  cure_reminder: {
    subject: 'Reminder: cure period ends {{cure_deadline}}',
    body: 'Date: {{date}}\n\nTo: {{franchisee}}\n\nThis is a reminder that the default notified to you ({{reason}}) must be cured by {{cure_deadline}}. Please contact us if you have questions or believe it has been cured.\n\n{{brand}}',
  },
  termination: {
    subject: 'Notice of termination of your {{brand}} franchise agreement',
    body: 'Date: {{date}}\n\nTo: {{franchisee}}\n\nRe: Franchise agreement dated {{agreement_date}}\n\nWe notified you of a default ({{reason}}) and the cure period ended on {{cure_deadline}} without the default being cured. We therefore terminate the franchise agreement with effect from {{date}}, under its terms.\n\nPlease follow the post-termination obligations in the agreement, including de-identification and return of confidential materials.\n\n{{brand}}',
  },
  withdrawal: {
    subject: 'Withdrawal of notice',
    body: 'Date: {{date}}\n\nTo: {{franchisee}}\n\nWe withdraw our notice concerning {{reason}}. No further action is required in relation to it.\n\n{{brand}}',
  },
};

export function renderNotice(kind: NoticeKind, v: { franchisee: string; brand: string; agreementDate: string; reason: NoticeReason; details: string; cureDays: number; cureDeadline: string; date: string }) {
  const reason = REASON_TEXT[v.reason].replace('{{details}}', v.details.trim() || 'details to be completed').replace(' ()', '');
  const vars: Record<string, string> = { franchisee: v.franchisee, brand: v.brand, agreement_date: v.agreementDate, reason, details: v.details, cure_days: String(v.cureDays), cure_deadline: v.cureDeadline, date: v.date };
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
  const t = NOTICE_TEMPLATES[kind];
  return { subject: fill(t.subject), body: fill(t.body) };
}

export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonthsYmd(ymd: string, months: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export const AMENDMENT_FIELDS = ['endDate', 'royaltyBps', 'marketingFundBps', 'territory', 'renewalOption'] as const;
export const AMENDMENT_STATUSES = ['draft', 'signed', 'cancelled'] as const;

export const RENEWAL_STATUSES = ['upcoming', 'window_open', 'notice_received', 'approved', 'declined', 'renewed', 'lapsed'] as const;
export const RENEWAL_CONDITIONS = ['notice_given', 'no_open_defaults', 'refurbishment', 'training_current', 'general_release', 'renewal_fee_paid', 'new_agreement_signed'] as const;

/**
 * The renewal option window: the franchisee gives notice between `openMonths` and `closeMonths` before the term ends
 * (defaults 12 and 6 months, the usual range in franchise agreements; set per agreement in its terms).
 */
export function renewalWindow(endDate: string, openMonths = 12, closeMonths = 6) {
  return { opensOn: addMonthsYmd(endDate, -openMonths), closesOn: addMonthsYmd(endDate, -closeMonths) };
}

export function renewalPhase(today: string, w: { opensOn: string; closesOn: string }, endDate: string): 'upcoming' | 'window_open' | 'window_closed' | 'expired' {
  if (today > endDate) return 'expired';
  if (today < w.opensOn) return 'upcoming';
  if (today <= w.closesOn) return 'window_open';
  return 'window_closed';
}

export const DEVELOPMENT_ITEM_STATUSES = ['pending', 'signed', 'opened', 'missed', 'waived'] as const;

export interface ScheduleItemLike { sequence: number; signByDate: string | null; openByDate: string; status: string }

/** Progress of a development schedule at `today`: units due so far, opened, and whether the developer is behind. */
export function scheduleProgress(items: ScheduleItemLike[], today: string) {
  const opened = items.filter((i) => i.status === 'opened').length;
  const signed = items.filter((i) => i.status === 'signed' || i.status === 'opened').length;
  const waived = items.filter((i) => i.status === 'waived').length;
  const dueToOpen = items.filter((i) => i.openByDate <= today && i.status !== 'waived').length;
  const dueToSign = items.filter((i) => i.signByDate && i.signByDate <= today && i.status !== 'waived').length;
  const overdue = items.filter((i) => i.status !== 'opened' && i.status !== 'waived' && (i.openByDate < today || (i.status === 'pending' && !!i.signByDate && i.signByDate < today)));
  const next = items.filter((i) => i.status === 'pending' || i.status === 'signed').sort((a, b) => a.openByDate.localeCompare(b.openByDate))[0];
  return { total: items.length, opened, signed, waived, dueToOpen, dueToSign, behind: opened < dueToOpen || signed < dueToSign, overdue: overdue.map((i) => i.sequence), nextDeadline: next ? (next.status === 'pending' && next.signByDate ? next.signByDate : next.openByDate) : null };
}

/* ------------------------------------------------------------------ */
/* Master franchise royalty splits                                     */
/* ------------------------------------------------------------------ */

export interface SplitRule { currency: string | null; royaltyShareBps: number; fundShareBps: number }

export const splitRuleSchema = z.object({
  /** null = every currency without its own rule. */
  currency: z.string().length(3).transform((s) => s.toUpperCase()).nullable(),
  royaltyShareBps: z.number().int().min(0).max(10_000),
  fundShareBps: z.number().int().min(0).max(10_000),
});

export const ruleFor = (rules: SplitRule[], currency: string) => rules.find((r) => r.currency === currency) ?? rules.find((r) => r.currency === null) ?? null;

/** The master franchisee's share is rounded down to the minor unit; HQ keeps the remainder, so the parts always add up. */
export function splitAmounts(royaltyMinor: number, fundMinor: number, rule: Pick<SplitRule, 'royaltyShareBps' | 'fundShareBps'>) {
  const masterRoyalty = Math.floor((royaltyMinor * rule.royaltyShareBps) / 10_000);
  const masterFund = Math.floor((fundMinor * rule.fundShareBps) / 10_000);
  return { masterRoyaltyMinor: masterRoyalty, hqRoyaltyMinor: royaltyMinor - masterRoyalty, masterFundMinor: masterFund, hqFundMinor: fundMinor - masterFund };
}

export const MASTER_STATEMENT_STATUSES = ['draft', 'approved', 'paid'] as const;

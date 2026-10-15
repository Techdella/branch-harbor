/**
 * Hospitality (`hospitality`) — pure rules shared by the API, the business app, customer sites and mobile:
 * stay nights, nightly rate resolution (base → season → daily override, weekday prices, derived plans), stay
 * restrictions, business-configured taxes, deposits, cancellation/no-show fees, housekeeping and reservation state
 * machines, and KPI maths. See docs/verticals/hospitality.md. Money is integer minor units in the property currency.
 */

export const ROOM_TYPE_KINDS = ['room', 'apartment', 'dorm'] as const;
export type RoomTypeKind = (typeof ROOM_TYPE_KINDS)[number];
export const BED_TYPES = ['single', 'double', 'queen', 'king', 'twin', 'bunk', 'sofa_bed'] as const;
export type BedType = (typeof BED_TYPES)[number];

export const HK_STATUSES = ['clean', 'dirty', 'inspected', 'out_of_order'] as const;
export type HkStatus = (typeof HK_STATUSES)[number];

const HK_TRANSITIONS: Record<HkStatus, readonly HkStatus[]> = {
  dirty: ['clean', 'out_of_order'],
  clean: ['inspected', 'dirty', 'out_of_order'],
  inspected: ['dirty', 'clean', 'out_of_order'],
  out_of_order: ['dirty'],
};
export function hkTransition(from: HkStatus, to: HkStatus): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: false, reason: 'same_status' };
  return HK_TRANSITIONS[from].includes(to) ? { ok: true } : { ok: false, reason: 'invalid_transition' };
}
export const allowedHkTransitions = (from: HkStatus): readonly HkStatus[] => HK_TRANSITIONS[from];
/** Rooms a guest may be checked into (inspected only when the property requires inspection). */
export const roomReadyForArrival = (status: HkStatus, requireInspected: boolean) => (requireInspected ? status === 'inspected' : status === 'clean' || status === 'inspected');

export const HK_TASK_KINDS = ['departure_clean', 'stayover', 'inspection', 'maintenance', 'turndown'] as const;
export type HkTaskKind = (typeof HK_TASK_KINDS)[number];
export const HK_TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'] as const;
export type HkTaskStatus = (typeof HK_TASK_STATUSES)[number];
const TASK_TRANSITIONS: Record<HkTaskStatus, readonly HkTaskStatus[]> = {
  todo: ['in_progress', 'done', 'cancelled'],
  in_progress: ['done', 'todo', 'cancelled'],
  done: ['todo'],
  cancelled: ['todo'],
};
export const taskTransitionAllowed = (from: HkTaskStatus, to: HkTaskStatus) => TASK_TRANSITIONS[from].includes(to);

export const RESERVATION_STATUSES = ['hold', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'expired'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
/** Statuses that consume inventory. */
export const INVENTORY_STATUSES: readonly ReservationStatus[] = ['hold', 'confirmed', 'checked_in'];
const RES_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  hold: ['confirmed', 'cancelled', 'expired'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['checked_out'],
  checked_out: [],
  cancelled: [],
  no_show: [],
  expired: ['confirmed'],
};
export const reservationTransitionAllowed = (from: ReservationStatus, to: ReservationStatus) => RES_TRANSITIONS[from].includes(to);

export const RATE_PLAN_KINDS = ['bar', 'non_refundable', 'package'] as const;
export type RatePlanKind = (typeof RATE_PLAN_KINDS)[number];
export const DEPOSIT_RULES = ['none', 'first_night', 'percent', 'full'] as const;
export type DepositRule = (typeof DEPOSIT_RULES)[number];
export const FEE_TYPES = ['none', 'first_night', 'percent', 'full', 'fixed'] as const;
export type FeeType = (typeof FEE_TYPES)[number];
export const TAX_KINDS = ['percent', 'per_night', 'per_person_per_night', 'per_stay'] as const;
export type TaxKind = (typeof TAX_KINDS)[number];
export const FOLIO_LINE_KINDS = ['room', 'tax', 'extra', 'outlet', 'fee', 'payment', 'refund', 'adjustment'] as const;
export type FolioLineKind = (typeof FOLIO_LINE_KINDS)[number];
export const RESERVATION_SOURCES = ['website', 'mobile', 'front_desk', 'phone', 'email', 'channel'] as const;
export const REGISTRATION_FIELD_KINDS = ['text', 'date', 'country', 'document_number'] as const;

// ───────────────────────── dates ─────────────────────────

const DAY = 86_400_000;
const parse = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const isIsoDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && fmt(parse(d)) === d;
export const addDaysIso = (d: string, n: number) => fmt(parse(d) + n * DAY);
/** 0 = Sunday … 6 = Saturday. */
export const weekdayOfIso = (d: string) => new Date(parse(d)).getUTCDay();
export const nightsBetween = (arrival: string, departure: string) => Math.round((parse(departure) - parse(arrival)) / DAY);
/** The nights of a stay: arrival … departure − 1. */
export function stayNights(arrival: string, departure: string): string[] {
  const n = nightsBetween(arrival, departure);
  return Array.from({ length: Math.max(0, n) }, (_, i) => addDaysIso(arrival, i));
}

// ───────────────────────── rates ─────────────────────────

export interface PriceRow { seasonId: string | null; amountMinor: number; weekdayAmounts?: Partial<Record<string, number>> | null; extraAdultMinor?: number | null; extraChildMinor?: number | null }
export interface SeasonRow { id: string; name?: string; startDate: string; endDate: string; minStay?: number | null; maxStay?: number | null; priority?: number }
export interface DailyRow { date: string; amountMinor?: number | null; minStay?: number | null; maxStay?: number | null; closed?: boolean; closedToArrival?: boolean; closedToDeparture?: boolean }
export interface TaxRule { id?: string; name: string; kind: TaxKind; rateBps?: number | null; amountMinor?: number | null; inclusive?: boolean; maxNights?: number | null; appliesToChildren?: boolean }
export interface PlanRule { minStay?: number | null; maxStay?: number | null; adjustmentBps?: number | null; deposit: { rule: DepositRule; percentBps?: number | null } }

export interface StayQuoteInput {
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  baseOccupancy: number;
  maxOccupancy: number;
  maxAdults?: number | null;
  plan: PlanRule;
  /** Prices of the plan that sets the price (the parent for derived plans). */
  prices: PriceRow[];
  seasons: SeasonRow[];
  /** Daily price overrides of the pricing plan. */
  dailyPrices: DailyRow[];
  /** Daily restrictions of this plan. */
  restrictions: DailyRow[];
  taxes: TaxRule[];
}
export interface NightPrice { date: string; amountMinor: number; source: 'base' | 'season' | 'daily'; seasonId: string | null }
export interface TaxLine { name: string; kind: TaxKind; amountMinor: number; inclusive: boolean }
export type StayQuote =
  | { ok: true; nights: NightPrice[]; roomTotalMinor: number; taxes: TaxLine[]; taxAddedMinor: number; totalMinor: number; depositMinor: number }
  | { ok: false; reason: 'invalid_dates' | 'too_many_guests' | 'no_price' | 'closed' | 'closed_to_arrival' | 'closed_to_departure' | 'min_stay' | 'max_stay'; detail?: Record<string, unknown> };

export function seasonFor(date: string, seasons: SeasonRow[]): SeasonRow | null {
  const hits = seasons.filter((s) => s.startDate <= date && date <= s.endDate);
  hits.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.startDate.localeCompare(a.startDate));
  return hits[0] ?? null;
}

const weekdayAmount = (row: PriceRow, date: string) => {
  const w = row.weekdayAmounts?.[String(weekdayOfIso(date))];
  return typeof w === 'number' ? w : row.amountMinor;
};

/** One night's price for one unit (before extra guests and derived-plan adjustment), or null when not priced. */
export function nightlyPrice(date: string, prices: PriceRow[], seasons: SeasonRow[], dailyPrices: DailyRow[]): NightPrice | null {
  const d = dailyPrices.find((x) => x.date === date);
  if (d && typeof d.amountMinor === 'number') return { date, amountMinor: d.amountMinor, source: 'daily', seasonId: null };
  const season = seasonFor(date, seasons);
  if (season) {
    const row = prices.find((p) => p.seasonId === season.id);
    if (row) return { date, amountMinor: weekdayAmount(row, date), source: 'season', seasonId: season.id };
  }
  const base = prices.find((p) => p.seasonId === null);
  return base ? { date, amountMinor: weekdayAmount(base, date), source: 'base', seasonId: null } : null;
}

/** Strictest min/max stay for an arrival date (plan, season of the arrival night, daily restriction of the arrival night). */
export function stayLimits(arrival: string, plan: Pick<PlanRule, 'minStay' | 'maxStay'>, seasons: SeasonRow[], restrictions: DailyRow[]) {
  const season = seasonFor(arrival, seasons);
  const daily = restrictions.find((r) => r.date === arrival);
  const mins = [plan.minStay, season?.minStay, daily?.minStay].filter((x): x is number => typeof x === 'number' && x > 0);
  const maxs = [plan.maxStay, season?.maxStay, daily?.maxStay].filter((x): x is number => typeof x === 'number' && x > 0);
  return { minStay: mins.length ? Math.max(...mins) : 1, maxStay: maxs.length ? Math.min(...maxs) : null };
}

export function taxLines(taxes: TaxRule[], input: { roomTotalMinor: number; nights: number; adults: number; children: number }): TaxLine[] {
  return taxes.map((t) => {
    const nights = t.maxNights && t.maxNights > 0 ? Math.min(input.nights, t.maxNights) : input.nights;
    const persons = input.adults + (t.appliesToChildren ? input.children : 0);
    const inclusive = t.kind === 'percent' && !!t.inclusive;
    let amount = 0;
    if (t.kind === 'percent') {
      const bps = t.rateBps ?? 0;
      amount = inclusive ? Math.round((input.roomTotalMinor * bps) / (10_000 + bps)) : Math.round((input.roomTotalMinor * bps) / 10_000);
    } else if (t.kind === 'per_night') amount = (t.amountMinor ?? 0) * nights;
    else if (t.kind === 'per_person_per_night') amount = (t.amountMinor ?? 0) * nights * persons;
    else amount = t.amountMinor ?? 0;
    return { name: t.name, kind: t.kind, amountMinor: amount, inclusive };
  });
}

export function depositFor(rule: PlanRule['deposit'], firstNightMinor: number, totalMinor: number): number {
  const v = rule.rule === 'none' ? 0 : rule.rule === 'first_night' ? firstNightMinor : rule.rule === 'full' ? totalMinor : Math.round((totalMinor * (rule.percentBps ?? 0)) / 10_000);
  return Math.max(0, Math.min(totalMinor, v));
}

/** Prices and validates a stay of one unit on one rate plan. */
export function quoteStay(q: StayQuoteInput): StayQuote {
  if (!isIsoDate(q.arrival) || !isIsoDate(q.departure) || nightsBetween(q.arrival, q.departure) < 1) return { ok: false, reason: 'invalid_dates' };
  if (q.adults < 1 || q.adults + q.children > q.maxOccupancy || (q.maxAdults && q.adults > q.maxAdults)) return { ok: false, reason: 'too_many_guests', detail: { maxOccupancy: q.maxOccupancy } };
  const dates = stayNights(q.arrival, q.departure);
  const arr = q.restrictions.find((r) => r.date === q.arrival);
  if (arr?.closedToArrival) return { ok: false, reason: 'closed_to_arrival', detail: { date: q.arrival } };
  const dep = q.restrictions.find((r) => r.date === q.departure);
  if (dep?.closedToDeparture) return { ok: false, reason: 'closed_to_departure', detail: { date: q.departure } };
  const closed = dates.find((d) => q.restrictions.some((r) => r.date === d && r.closed));
  if (closed) return { ok: false, reason: 'closed', detail: { date: closed } };
  const limits = stayLimits(q.arrival, q.plan, q.seasons, q.restrictions);
  if (dates.length < limits.minStay) return { ok: false, reason: 'min_stay', detail: { minStay: limits.minStay } };
  if (limits.maxStay !== null && dates.length > limits.maxStay) return { ok: false, reason: 'max_stay', detail: { maxStay: limits.maxStay } };
  const extraAdults = Math.max(0, q.adults - q.baseOccupancy);
  const extraChildren = Math.max(0, Math.min(q.children, q.adults + q.children - q.baseOccupancy - extraAdults));
  const nights: NightPrice[] = [];
  for (const d of dates) {
    const p = nightlyPrice(d, q.prices, q.seasons, q.dailyPrices);
    if (!p) return { ok: false, reason: 'no_price', detail: { date: d } };
    const row = (p.seasonId ? q.prices.find((x) => x.seasonId === p.seasonId) : null) ?? q.prices.find((x) => x.seasonId === null);
    let amount = p.amountMinor + extraAdults * (row?.extraAdultMinor ?? 0) + extraChildren * (row?.extraChildMinor ?? 0);
    if (q.plan.adjustmentBps) amount = Math.round((amount * (10_000 + q.plan.adjustmentBps)) / 10_000);
    nights.push({ ...p, amountMinor: amount });
  }
  const roomTotalMinor = nights.reduce((a, n) => a + n.amountMinor, 0);
  const taxes = taxLines(q.taxes, { roomTotalMinor, nights: nights.length, adults: q.adults, children: q.children });
  const taxAddedMinor = taxes.filter((t) => !t.inclusive).reduce((a, t) => a + t.amountMinor, 0);
  const totalMinor = roomTotalMinor + taxAddedMinor;
  return { ok: true, nights, roomTotalMinor, taxes, taxAddedMinor, totalMinor, depositMinor: depositFor(q.plan.deposit, nights[0]!.amountMinor, totalMinor) };
}

// ───────────────────────── cancellation ─────────────────────────

export interface FeeRule { type: FeeType; percentBps?: number | null; amountMinor?: number | null }
export interface CancellationPolicy { name?: string; nonRefundable: boolean; freeUntilHours: number | null; lateFee: FeeRule; noShowFee: FeeRule }

export function feeAmount(rule: FeeRule, stay: { firstNightMinor: number; totalMinor: number }): number {
  const v = rule.type === 'none' ? 0 : rule.type === 'first_night' ? stay.firstNightMinor : rule.type === 'full' ? stay.totalMinor
    : rule.type === 'percent' ? Math.round((stay.totalMinor * (rule.percentBps ?? 0)) / 10_000) : rule.amountMinor ?? 0;
  return Math.max(0, Math.min(stay.totalMinor, v));
}

/** Fee for cancelling now; `arrivalAt` is the check-in instant in the property time zone. */
export function cancellationFee(policy: CancellationPolicy, input: { now: Date; arrivalAt: Date; firstNightMinor: number; totalMinor: number }): { feeMinor: number; free: boolean; freeUntil: string | null; reason: 'non_refundable' | 'free_window' | 'late' } {
  if (policy.nonRefundable) return { feeMinor: input.totalMinor, free: false, freeUntil: null, reason: 'non_refundable' };
  const freeUntil = policy.freeUntilHours === null ? null : new Date(input.arrivalAt.getTime() - policy.freeUntilHours * 3_600_000);
  if (freeUntil && input.now < freeUntil) return { feeMinor: 0, free: true, freeUntil: freeUntil.toISOString(), reason: 'free_window' };
  return { feeMinor: feeAmount(policy.lateFee, input), free: false, freeUntil: freeUntil?.toISOString() ?? null, reason: 'late' };
}

export const noShowFee = (policy: CancellationPolicy, stay: { firstNightMinor: number; totalMinor: number }) => (policy.nonRefundable ? stay.totalMinor : feeAmount(policy.noShowFee, stay));

// ───────────────────────── KPIs ─────────────────────────

/** Occupancy (0–1), ADR and RevPAR in minor units of ONE currency; null when undefined (never a fabricated 0). */
export function hotelKpis(input: { roomNightsAvailable: number; roomNightsSold: number; roomRevenueMinor: number }) {
  return {
    occupancy: input.roomNightsAvailable > 0 ? input.roomNightsSold / input.roomNightsAvailable : null,
    adrMinor: input.roomNightsSold > 0 ? Math.round(input.roomRevenueMinor / input.roomNightsSold) : null,
    revparMinor: input.roomNightsAvailable > 0 ? Math.round(input.roomRevenueMinor / input.roomNightsAvailable) : null,
  };
}

/**
 * Royalty & marketing-fund engine (pure functions, no I/O).
 *
 * Every calculation works on one location, one period and one currency. Amounts are integer minor units; the
 * caller never passes amounts from two currencies to the same calculation (the services group by currency first).
 */
import { addDays, zonedToUtc } from '../lib/tz.ts';
import type { FinanceTaxLine, InvoiceLine, InvoiceTax, LateFeeTerms, RevenueBasis, RevenueStream, RoyaltyTier } from '../db/schema/finance.ts';

export const REVENUE_STREAMS: readonly RevenueStream[] = ['bookings', 'memberships', 'retail', 'food', 'gift_vouchers', 'other'];

/** Payment target types → revenue stream. Royalty invoices themselves (`royalty_invoice`) are never sales. */
const STREAM_OF: Record<string, RevenueStream> = {
  class_booking: 'bookings', appointment: 'bookings', registration: 'bookings',
  studio_purchase: 'memberships', membership_invoice: 'memberships', wellness_package: 'memberships',
  order: 'retail',
  food_order: 'food', catering_deposit: 'food', food_tab: 'food',
  wellness_voucher: 'gift_vouchers',
};
export const NON_SALES_TARGETS = new Set(['royalty_invoice']);

export function streamOf(targetType: string | null | undefined): RevenueStream | null {
  if (targetType && NON_SALES_TARGETS.has(targetType)) return null;
  return (targetType && STREAM_OF[targetType]) || 'other';
}

/** Default basis: everything except gift vouchers (counted when redeemed), net of refunds and tax, tips excluded. */
export const DEFAULT_BASIS: RevenueBasis = {
  streams: ['bookings', 'memberships', 'retail', 'food', 'other'],
  netOfRefunds: true,
  excludeTax: true,
  excludeTips: true,
  includeExternalSales: true,
};

/** The terms a statement is computed with (one currency). */
export interface RoyaltyTerms {
  source: 'agreement' | 'owner_group' | 'organization';
  sourceId: string | null;
  currency: string;
  royaltyBps: number;
  tiers: RoyaltyTier[];
  tierMode: 'marginal' | 'whole';
  minimumRoyaltyMinor: number;
  marketingFundBps: number;
  technologyFeeMinor: number;
  basis: RevenueBasis;
  lateFee: LateFeeTerms;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface StreamTotals { grossMinor: number; refundsMinor: number; taxMinor: number; tipsMinor: number }
export interface SalesAggregate {
  currency: string;
  streams: Partial<Record<RevenueStream, StreamTotals>>;
  /** Accepted external (manually reported) sales for the period. */
  external?: { grossMinor: number; refundsMinor: number; taxMinor: number } | null;
}

export interface ComputedLine {
  kind: 'sales' | 'refunds' | 'tax' | 'tips' | 'external_sales' | 'basis' | 'royalty' | 'royalty_minimum' | 'marketing_fund' | 'technology_fee' | 'adjustment';
  stream?: RevenueStream | 'external' | null;
  description: string;
  basisMinor?: number | null;
  rateBps?: number | null;
  amountMinor: number;
  charge: boolean;
}

export interface ComputedStatement {
  currency: string;
  grossSalesMinor: number;
  refundsMinor: number;
  taxMinor: number;
  tipsMinor: number;
  externalSalesMinor: number;
  basisMinor: number;
  royaltyMinor: number;
  marketingFundMinor: number;
  technologyFeeMinor: number;
  adjustmentsMinor: number;
  totalMinor: number;
  lines: ComputedLine[];
  warnings: string[];
}

/** Rounds a basis × rate (basis points) to the nearest minor unit, halves away from zero. */
export function applyBps(basisMinor: number, bps: number): number {
  const v = (basisMinor * bps) / 10_000;
  return Math.sign(v) * Math.round(Math.abs(v));
}

/** Royalty on a basis with tiers. Without tiers, the flat `royaltyBps` applies. */
export function tieredRoyalty(basisMinor: number, terms: Pick<RoyaltyTerms, 'royaltyBps' | 'tiers' | 'tierMode'>): { amountMinor: number; slices: Array<{ fromMinor: number; toMinor: number | null; bps: number; basisMinor: number; amountMinor: number }> } {
  if (basisMinor <= 0) return { amountMinor: 0, slices: [] };
  const tiers = [...(terms.tiers ?? [])].sort((a, b) => a.fromMinor - b.fromMinor);
  if (!tiers.length) {
    const amt = applyBps(basisMinor, terms.royaltyBps);
    return { amountMinor: amt, slices: [{ fromMinor: 0, toMinor: null, bps: terms.royaltyBps, basisMinor, amountMinor: amt }] };
  }
  if (tiers[0]!.fromMinor !== 0) tiers.unshift({ fromMinor: 0, bps: terms.royaltyBps });
  if (terms.tierMode === 'whole') {
    const reached = [...tiers].reverse().find((t) => basisMinor > t.fromMinor || t.fromMinor === 0)!;
    const amt = applyBps(basisMinor, reached.bps);
    return { amountMinor: amt, slices: [{ fromMinor: reached.fromMinor, toMinor: null, bps: reached.bps, basisMinor, amountMinor: amt }] };
  }
  const slices: Array<{ fromMinor: number; toMinor: number | null; bps: number; basisMinor: number; amountMinor: number }> = [];
  for (let i = 0; i < tiers.length; i++) {
    const from = tiers[i]!.fromMinor;
    const to = tiers[i + 1]?.fromMinor ?? null;
    if (basisMinor <= from) break;
    const portion = (to === null ? basisMinor : Math.min(basisMinor, to)) - from;
    slices.push({ fromMinor: from, toMinor: to, bps: tiers[i]!.bps, basisMinor: portion, amountMinor: applyBps(portion, tiers[i]!.bps) });
  }
  return { amountMinor: slices.reduce((a, s) => a + s.amountMinor, 0), slices };
}

/**
 * Computes a statement for one location and period.
 * basis = included streams' gross − refunds (if net) − tax (if excluded) − tips (if excluded) + accepted external sales (net).
 * royalty = max(tiered royalty, minimum); fund = basis × fund rate; technology fee is flat; manual adjustments are added.
 */
export function computeStatement(terms: RoyaltyTerms, sales: SalesAggregate, adjustmentsMinor: number[] = []): ComputedStatement {
  if (sales.currency !== terms.currency) throw new Error(`Terms are in ${terms.currency} but sales are in ${sales.currency}`);
  const lines: ComputedLine[] = [];
  const warnings: string[] = [];
  const b = terms.basis;
  let gross = 0, refunds = 0, tax = 0, tips = 0;
  for (const stream of REVENUE_STREAMS) {
    const s = sales.streams[stream];
    if (!s || (!s.grossMinor && !s.refundsMinor)) continue;
    if (!b.streams.includes(stream)) {
      lines.push({ kind: 'sales', stream, description: `excluded:${stream}`, amountMinor: s.grossMinor, charge: false });
      continue;
    }
    gross += s.grossMinor;
    lines.push({ kind: 'sales', stream, description: `sales:${stream}`, amountMinor: s.grossMinor, charge: false });
    if (b.netOfRefunds) refunds += s.refundsMinor;
    if (b.excludeTax) tax += s.taxMinor;
    if (b.excludeTips) tips += s.tipsMinor;
  }
  if (refunds) lines.push({ kind: 'refunds', description: 'refunds', amountMinor: -refunds, charge: false });
  if (tax) lines.push({ kind: 'tax', description: 'tax', amountMinor: -tax, charge: false });
  if (tips) lines.push({ kind: 'tips', description: 'tips', amountMinor: -tips, charge: false });
  let external = 0;
  if (sales.external) {
    if (b.includeExternalSales) {
      external = sales.external.grossMinor - (b.netOfRefunds ? sales.external.refundsMinor : 0) - (b.excludeTax ? sales.external.taxMinor : 0);
      lines.push({ kind: 'external_sales', stream: 'external', description: 'external_sales', amountMinor: external, charge: false });
    } else warnings.push('external_sales_excluded');
  }
  const basis = Math.max(0, gross - refunds - tax - tips + external);
  lines.push({ kind: 'basis', description: 'basis', amountMinor: basis, charge: false });

  const tiered = tieredRoyalty(basis, terms);
  for (const s of tiered.slices) {
    lines.push({ kind: 'royalty', description: s.toMinor === null && s.fromMinor === 0 ? 'royalty' : `royalty_tier:${s.fromMinor}:${s.toMinor ?? ''}`, basisMinor: s.basisMinor, rateBps: s.bps, amountMinor: s.amountMinor, charge: true });
  }
  let royalty = tiered.amountMinor;
  if (terms.minimumRoyaltyMinor > royalty) {
    const topUp = terms.minimumRoyaltyMinor - royalty;
    lines.push({ kind: 'royalty_minimum', description: 'royalty_minimum', basisMinor: terms.minimumRoyaltyMinor, amountMinor: topUp, charge: true });
    royalty = terms.minimumRoyaltyMinor;
  }
  const fund = applyBps(basis, terms.marketingFundBps);
  if (terms.marketingFundBps > 0) lines.push({ kind: 'marketing_fund', description: 'marketing_fund', basisMinor: basis, rateBps: terms.marketingFundBps, amountMinor: fund, charge: true });
  const tech = terms.technologyFeeMinor;
  if (tech > 0) lines.push({ kind: 'technology_fee', description: 'technology_fee', amountMinor: tech, charge: true });
  const adj = adjustmentsMinor.reduce((a, x) => a + x, 0);
  return {
    currency: terms.currency, grossSalesMinor: gross, refundsMinor: refunds, taxMinor: tax, tipsMinor: tips, externalSalesMinor: external, basisMinor: basis,
    royaltyMinor: royalty, marketingFundMinor: fund, technologyFeeMinor: tech, adjustmentsMinor: adj, totalMinor: royalty + fund + tech + adj, lines, warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Periods                                                             */
/* ------------------------------------------------------------------ */

export type PeriodFrequency = 'weekly' | 'monthly';

/** The period containing a local date: monthly = calendar month; weekly = 7 days from `weekStartsOn` (1 = Monday … 7 = Sunday). */
export function periodContaining(frequency: PeriodFrequency, localDate: string, weekStartsOn = 1): { startDate: string; endDate: string } {
  if (frequency === 'monthly') {
    const [y, m] = localDate.split('-').map(Number) as [number, number];
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    return { startDate: start, endDate: next };
  }
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7; // 1..7, Monday = 1
  const back = (dow - weekStartsOn + 7) % 7;
  const start = addDays(localDate, -back);
  return { startDate: start, endDate: addDays(start, 7) };
}

/** Whether `startDate` is a valid period start for the frequency. */
export function isPeriodStart(frequency: PeriodFrequency, startDate: string, weekStartsOn = 1): boolean {
  return periodContaining(frequency, startDate, weekStartsOn).startDate === startDate;
}

/** UTC instants of a local-date period in a location's time zone: [start, end). */
export function periodBoundsUtc(startDate: string, endDate: string, timeZone: string): { startAt: Date; endAt: Date } {
  return { startAt: zonedToUtc(startDate, '00:00', timeZone), endAt: zonedToUtc(endDate, '00:00', timeZone) };
}

/* ------------------------------------------------------------------ */
/* Invoices, late fees, ageing                                         */
/* ------------------------------------------------------------------ */

/** Taxes HQ configured, applied per line kind for the location's country. Nothing configured = no tax. */
export function invoiceTaxes(lines: InvoiceLine[], taxLines: FinanceTaxLine[], country: string): InvoiceTax[] {
  const out: InvoiceTax[] = [];
  for (const t of taxLines) {
    if (t.country && t.country.toUpperCase() !== country.toUpperCase()) continue;
    const base = lines.filter((l) => (t.appliesTo as string[]).includes(l.kind)).reduce((a, l) => a + l.amountMinor, 0);
    if (base <= 0 || t.rateBps <= 0) continue;
    out.push({ name: t.name, rateBps: t.rateBps, baseMinor: base, amountMinor: applyBps(base, t.rateBps) });
  }
  return out;
}

/** Invoice lines from a statement: royalty (incl. minimum), marketing fund, technology fee, adjustments. */
export function invoiceLinesFromStatement(s: { royaltyMinor: number; marketingFundMinor: number; technologyFeeMinor: number; adjustmentsMinor: number }): InvoiceLine[] {
  const out: InvoiceLine[] = [];
  if (s.royaltyMinor) out.push({ kind: 'royalty', description: 'royalty', amountMinor: s.royaltyMinor });
  if (s.marketingFundMinor) out.push({ kind: 'marketing_fund', description: 'marketing_fund', amountMinor: s.marketingFundMinor });
  if (s.technologyFeeMinor) out.push({ kind: 'technology_fee', description: 'technology_fee', amountMinor: s.technologyFeeMinor });
  if (s.adjustmentsMinor) out.push({ kind: 'adjustment', description: 'adjustment', amountMinor: s.adjustmentsMinor });
  return out;
}

/** Late fee owed on an overdue amount under the agreement's terms (0 within the grace period). */
export function lateFeeFor(fee: LateFeeTerms, outstandingMinor: number, daysOverdue: number): number {
  if (fee.kind === 'none' || outstandingMinor <= 0 || daysOverdue <= (fee.graceDays ?? 0)) return 0;
  if (fee.kind === 'flat') return Math.max(0, fee.flatMinor ?? 0);
  return Math.max(0, applyBps(outstandingMinor, fee.bps ?? 0));
}

export const AGEING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** Days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function ageingBucket(dueDate: string, today: string): AgeingBucket {
  const d = daysBetween(dueDate, today);
  if (d <= 0) return 'current';
  if (d <= 30) return 'd1_30';
  if (d <= 60) return 'd31_60';
  if (d <= 90) return 'd61_90';
  return 'd90_plus';
}

/** Invoice numbers: `<prefix>-<6-digit sequence>`, sequence gapless per organisation. */
export function formatInvoiceNumber(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

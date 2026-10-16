/**
 * Supplier and approved-vendor network (Operations → Suppliers, Finance → Supplier rebates). Pure rules shared by the
 * API, the dashboard and the mobile app:
 *
 * - request bodies (suppliers, catalogue items, purchase orders, receiving, rebate programmes, off-contract spend);
 * - purchase order totals and the HQ approval threshold (per currency, never converted);
 * - receiving: per-line shortfalls, damage and the resulting status (partial or complete);
 * - rebates: tiered by volume (spend or units) per period; the reached tier's rate applies to the whole period volume;
 * - supplier scorecards: on-time delivery, fill rate and issues.
 *
 * Money is integer minor units with its currency. Quantities on purchase orders are packs (cases); a catalogue item
 * says how many stock units a pack holds, which is what receiving adds to inventory.
 */
import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from './money.ts';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const currency = z.enum(SUPPORTED_CURRENCIES);
const trimmed = (max: number) => z.string().trim().max(max);

/* ------------------------------------------------------------------ */
/* Suppliers and catalogue                                             */
/* ------------------------------------------------------------------ */

export const SUPPLIER_STATUSES = ['active', 'suspended', 'archived'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];
export const PO_FORMATS = ['pdf', 'csv', 'both'] as const;
export type PoFormat = (typeof PO_FORMATS)[number];

export const supplierContactSchema = z.object({
  name: trimmed(120).min(1),
  role: trimmed(80).optional().default(''),
  email: z.email().nullable().optional().default(null),
  phone: trimmed(40).nullable().optional().default(null),
  /** Receives purchase orders when the supplier has no separate order email. */
  primary: z.boolean().optional().default(false),
});
export type SupplierContact = z.infer<typeof supplierContactSchema>;

export const supplierContractSchema = z.object({
  reference: trimmed(80).optional().default(''),
  startsOn: ymd.nullable().optional().default(null),
  endsOn: ymd.nullable().optional().default(null),
  /** e.g. "Net 30". */
  paymentTerms: trimmed(80).optional().default(''),
  notes: trimmed(2000).optional().default(''),
});
export type SupplierContract = z.infer<typeof supplierContractSchema>;

export const supplierBodySchema = z.object({
  name: trimmed(160).min(1),
  code: trimmed(40).optional().default(''),
  status: z.enum(SUPPLIER_STATUSES).optional().default('active'),
  /** Where the supplier is approved: country codes (`CA`) and/or region ids. Both empty = every location. */
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(60).optional().default([]),
  regionIds: z.array(z.uuid()).max(60).optional().default([]),
  contacts: z.array(supplierContactSchema).max(20).optional().default([]),
  /** Where purchase orders are emailed (falls back to the primary contact). */
  orderEmail: z.email().nullable().optional().default(null),
  orderFormat: z.enum(PO_FORMATS).optional().default('pdf'),
  currency,
  contract: supplierContractSchema.nullable().optional().default(null),
  notes: trimmed(2000).optional().default(''),
});
export type SupplierBody = z.infer<typeof supplierBodySchema>;

export const catalogueItemBodySchema = z.object({
  sku: trimmed(60).min(1),
  name: trimmed(200).min(1),
  category: trimmed(80).optional().default(''),
  /** How the pack is described to the location, e.g. "Case of 12 × 1 L". */
  packLabel: trimmed(80).optional().default(''),
  /** Stock units in one pack: receiving one pack adds this many units (or grams / ml for ingredients) to inventory. */
  unitsPerPack: z.number().int().min(1).max(1_000_000).default(1),
  /** Price per pack in each currency it is sold in (minor units). */
  prices: z.partialRecord(currency, z.number().int().min(0).max(1_000_000_000)).refine((p) => Object.keys(p).length > 0, 'Set a price in at least one currency'),
  /** Minimum order quantity in packs. */
  moq: z.number().int().min(1).max(100_000).default(1),
  leadTimeDays: z.number().int().min(0).max(365).default(2),
  active: z.boolean().optional().default(true),
  /** Commerce: the product variant this item restocks. */
  variantId: z.uuid().nullable().optional().default(null),
  /** Foods: the ingredient this item restocks (units per pack in the ingredient's unit). */
  ingredientId: z.uuid().nullable().optional().default(null),
}).refine((b) => !(b.variantId && b.ingredientId), { message: 'Link a product or an ingredient, not both', path: ['ingredientId'] });
export type CatalogueItemBody = z.infer<typeof catalogueItemBodySchema>;

/** A supplier covers a location when it is approved for the location's country or region (or everywhere). */
export function supplierCovers(s: { countries: readonly string[]; regionIds: readonly string[] }, loc: { country: string | null; regionId: string | null }): boolean {
  if (!s.countries.length && !s.regionIds.length) return true;
  return (!!loc.country && s.countries.includes(loc.country)) || (!!loc.regionId && s.regionIds.includes(loc.regionId));
}

/* ------------------------------------------------------------------ */
/* Purchase orders                                                     */
/* ------------------------------------------------------------------ */

export const PO_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'sent', 'confirmed', 'partially_received', 'received', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
/** Statuses where goods are still expected. */
export const PO_OPEN_STATUSES: readonly PoStatus[] = ['sent', 'confirmed', 'partially_received'];

export const poCreateSchema = z.object({
  locationId: z.uuid(),
  supplierId: z.uuid(),
  lines: z.array(z.object({ itemId: z.uuid(), quantity: z.number().int().min(1).max(100_000) })).min(1).max(200),
  requestedDeliveryDate: ymd.nullable().optional().default(null),
  notes: trimmed(2000).optional().default(''),
});
export type PoCreate = z.infer<typeof poCreateSchema>;

export interface PoLine {
  itemId: string; sku: string; name: string; packLabel: string; unitsPerPack: number;
  /** Packs ordered, confirmed by the supplier, and received in good condition so far. */
  quantity: number; confirmedQuantity: number | null; received: number;
  /** Packs that arrived damaged / unusable (not added to stock). */
  damaged: number;
  unitPriceMinor: number; totalMinor: number;
  variantId: string | null; ingredientId: string | null;
}

export const poTotal = (lines: ReadonlyArray<Pick<PoLine, 'totalMinor'>>) => lines.reduce((a, l) => a + l.totalMinor, 0);

/** HQ approval is needed when the order total exceeds the threshold set for its currency (no threshold = never). */
export function poNeedsApproval(totalMinor: number, currency: string, thresholds: Readonly<Record<string, number>>): boolean {
  const t = thresholds[currency];
  return t !== undefined && t !== null && totalMinor > t;
}

/** Lines below the supplier's minimum order quantity. */
export function moqViolations(lines: ReadonlyArray<{ itemId: string; quantity: number }>, items: ReadonlyMap<string, { moq: number }>): string[] {
  return lines.filter((l) => l.quantity < (items.get(l.itemId)?.moq ?? 1)).map((l) => l.itemId);
}

export const DISCREPANCY_KINDS = ['short', 'damaged', 'wrong_item', 'over', 'quality'] as const;
export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];

export const receiveSchema = z.object({
  lines: z.array(z.object({
    itemId: z.uuid(),
    /** Packs received in good condition (added to stock). */
    received: z.number().int().min(0).max(100_000),
    /** Packs that arrived damaged or unusable (recorded, not added to stock). */
    damaged: z.number().int().min(0).max(100_000).optional().default(0),
    issue: z.enum(DISCREPANCY_KINDS).nullable().optional().default(null),
    note: trimmed(500).optional().default(''),
  })).min(1).max(200),
  note: trimmed(2000).optional().default(''),
  /** Close the order even when lines are still short (nothing more will come). */
  closeShort: z.boolean().optional().default(false),
});
export type ReceiveInput = z.infer<typeof receiveSchema>;

export interface ReceiptLineResult { itemId: string; received: number; damaged: number; outstandingBefore: number; outstandingAfter: number; issue: DiscrepancyKind | null; note: string }

/**
 * Applies a delivery to the order's lines: good packs count toward the order, damaged packs are recorded as an issue,
 * and anything left outstanding is a shortfall. Receiving more than ordered is allowed and recorded as `over`.
 */
export function applyReceipt(lines: readonly PoLine[], input: ReceiveInput): { lines: PoLine[]; results: ReceiptLineResult[]; complete: boolean; goodPacks: number; issues: number } {
  const byItem = new Map(input.lines.map((l) => [l.itemId, l]));
  const results: ReceiptLineResult[] = [];
  let goodPacks = 0;
  const out = lines.map((l) => {
    const r = byItem.get(l.itemId);
    const outstandingBefore = Math.max(0, l.quantity - l.received);
    if (!r) return l;
    const received = r.received;
    const damaged = r.damaged ?? 0;
    goodPacks += received;
    const after = Math.max(0, l.quantity - l.received - received);
    let issue: DiscrepancyKind | null = r.issue ?? null;
    if (!issue && damaged > 0) issue = 'damaged';
    if (!issue && l.received + received > l.quantity) issue = 'over';
    results.push({ itemId: l.itemId, received, damaged, outstandingBefore, outstandingAfter: after, issue, note: r.note ?? '' });
    return { ...l, received: l.received + received, damaged: l.damaged + damaged };
  });
  const complete = out.every((l) => l.received >= l.quantity);
  // A shortfall at the moment of a delivery the location closes counts as an issue too.
  const issues = results.filter((r) => r.issue).length + (input.closeShort && !complete ? out.filter((l) => l.received < l.quantity && !results.some((r) => r.itemId === l.itemId && r.issue)).length : 0);
  return { lines: out, results, complete, goodPacks, issues };
}

/* ------------------------------------------------------------------ */
/* Rebates                                                             */
/* ------------------------------------------------------------------ */

export const REBATE_BASES = ['percent', 'per_unit'] as const;
export type RebateBasis = (typeof REBATE_BASES)[number];
export const REBATE_MEASURES = ['spend', 'units'] as const;
export const REBATE_PERIODS = ['month', 'quarter', 'year'] as const;
export type RebatePeriod = (typeof REBATE_PERIODS)[number];

export const rebateTierSchema = z.object({
  /** Volume at which the tier starts: spend in minor units, or packs. */
  from: z.number().int().min(0),
  /** percent: basis points of spend (250 = 2.5 %) · per_unit: minor units per pack. */
  rate: z.number().int().min(0).max(1_000_000),
});
export type RebateTier = z.infer<typeof rebateTierSchema>;

export const rebateProgrammeBodySchema = z.object({
  supplierId: z.uuid(),
  name: trimmed(160).min(1),
  basis: z.enum(REBATE_BASES),
  /** What the tiers are measured in. */
  measure: z.enum(REBATE_MEASURES).default('spend'),
  currency,
  tiers: z.array(rebateTierSchema).min(1).max(10),
  period: z.enum(REBATE_PERIODS).default('quarter'),
  startsOn: ymd,
  endsOn: ymd.nullable().optional().default(null),
  /** Catalogue items the programme covers (empty = every item from the supplier). */
  itemIds: z.array(z.uuid()).max(500).optional().default([]),
  /** Share of each claim booked into the marketing fund when the rebate is received (0–100 %). */
  fundSharePct: z.number().int().min(0).max(100).default(0),
  active: z.boolean().optional().default(true),
}).superRefine((b, ctx) => {
  const froms = b.tiers.map((t) => t.from);
  if (froms.some((f, i) => i > 0 && f <= froms[i - 1]!)) ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'Tiers must start at increasing volumes' });
  if (b.endsOn && b.endsOn < b.startsOn) ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'The end date must be after the start date' });
});
export type RebateProgrammeBody = z.infer<typeof rebateProgrammeBodySchema>;

export interface RebateResult {
  /** Index of the reached tier, or -1 below the first tier. */
  tierIndex: number;
  rate: number;
  volume: number;
  accruedMinor: number;
  /** The next tier and how much more volume reaches it. */
  next: { from: number; rate: number; remaining: number } | null;
}

/** The rebate earned in a period: the highest tier reached applies to the whole volume (all-units tiering). */
export function computeRebate(p: { basis: RebateBasis; measure: 'spend' | 'units'; tiers: readonly RebateTier[] }, v: { spendMinor: number; units: number }): RebateResult {
  const tiers = [...p.tiers].sort((a, b) => a.from - b.from);
  const volume = p.measure === 'spend' ? v.spendMinor : v.units;
  let tierIndex = -1;
  tiers.forEach((t, i) => { if (volume >= t.from) tierIndex = i; });
  const rate = tierIndex >= 0 ? tiers[tierIndex]!.rate : 0;
  const accruedMinor = tierIndex < 0 ? 0 : p.basis === 'percent' ? Math.round((v.spendMinor * rate) / 10_000) : v.units * rate;
  const n = tiers[tierIndex + 1];
  return { tierIndex, rate, volume, accruedMinor, next: n ? { from: n.from, rate: n.rate, remaining: n.from - volume } : null };
}

/** The period (inclusive dates) that contains `ymd`. */
export function rebatePeriodOf(period: RebatePeriod, date: string): { start: string; end: string; label: string } {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (period === 'year') return { start: `${y}-01-01`, end: `${y}-12-31`, label: `${y}` };
  if (period === 'month') return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last(y, m))}`, label: `${y}-${pad(m)}` };
  const q = Math.floor((m - 1) / 3);
  const sm = q * 3 + 1;
  return { start: `${y}-${pad(sm)}-01`, end: `${y}-${pad(sm + 2)}-${pad(last(y, sm + 2))}`, label: `${y}-Q${q + 1}` };
}

/** The share of a rebate booked into the marketing fund (rounded down to the minor unit). */
export const fundShareOf = (amountMinor: number, pct: number) => Math.floor((amountMinor * pct) / 100);

export const REBATE_CLAIM_STATUSES = ['draft', 'submitted', 'received', 'void'] as const;
export type RebateClaimStatus = (typeof REBATE_CLAIM_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Off-contract spend                                                  */
/* ------------------------------------------------------------------ */

export const OFF_CONTRACT_REASONS = ['urgent', 'out_of_stock', 'price', 'not_in_catalogue', 'other'] as const;
export const OFF_CONTRACT_STATUSES = ['flagged', 'accepted', 'action_required'] as const;

export const offContractSchema = z.object({
  locationId: z.uuid(),
  vendorName: trimmed(160).min(1),
  description: trimmed(500).min(1),
  category: trimmed(80).optional().default(''),
  amountMinor: z.number().int().min(1).max(1_000_000_000),
  currency,
  purchasedOn: ymd,
  reason: z.enum(OFF_CONTRACT_REASONS),
  note: trimmed(1000).optional().default(''),
});
export type OffContractInput = z.infer<typeof offContractSchema>;

/* ------------------------------------------------------------------ */
/* Scorecards                                                          */
/* ------------------------------------------------------------------ */

export interface ScorecardInput {
  /** Orders that reached the supplier (sent or later, not cancelled). */
  orders: ReadonlyArray<{ status: string; expectedOn: string | null; firstDeliveryOn: string | null; orderedPacks: number; receivedPacks: number; closed: boolean }>;
  /** Receiving issues (short, damaged, wrong item, quality) and late confirmations. */
  issues: number;
}

export interface Scorecard {
  orders: number;
  delivered: number;
  /** Share of delivered orders whose first delivery came on or before the expected date. */
  onTimePct: number | null;
  /** Good packs received ÷ packs ordered, over closed orders. */
  fillRatePct: number | null;
  issues: number;
  /** 0–100 blend (on time 40 %, fill rate 40 %, issues 20 %); null without deliveries. */
  score: number | null;
}

export function supplierScorecard(i: ScorecardInput): Scorecard {
  const sent = i.orders.filter((o) => o.status !== 'cancelled');
  const delivered = sent.filter((o) => o.firstDeliveryOn);
  const timed = delivered.filter((o) => o.expectedOn);
  const onTime = timed.filter((o) => o.firstDeliveryOn! <= o.expectedOn!).length;
  const closed = sent.filter((o) => o.closed);
  const ordered = closed.reduce((a, o) => a + o.orderedPacks, 0);
  const got = closed.reduce((a, o) => a + Math.min(o.receivedPacks, o.orderedPacks), 0);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const onTimePct = timed.length ? r1((onTime / timed.length) * 100) : null;
  const fillRatePct = ordered ? r1((got / ordered) * 100) : null;
  const issueRate = delivered.length ? Math.min(1, i.issues / delivered.length) : 0;
  const score = onTimePct === null && fillRatePct === null ? null : r1(0.4 * (onTimePct ?? 100) + 0.4 * (fillRatePct ?? 100) + 0.2 * (1 - issueRate) * 100);
  return { orders: sent.length, delivered: delivered.length, onTimePct, fillRatePct, issues: i.issues, score };
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const supplySettingsSchema = z.object({
  /** Purchase orders above this total (per currency, minor units) need HQ approval. Missing currency = never. */
  approvalThresholds: z.partialRecord(currency, z.number().int().min(0)).default({}),
});
export type SupplySettings = z.infer<typeof supplySettingsSchema>;

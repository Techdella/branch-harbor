/**
 * Royalty terms resolution.
 *
 * Order (highest wins): franchise agreement (through registered `AgreementTermsProvider`s) → owner-group terms →
 * organisation default terms. Owner-group and organisation terms live in `royalty_terms` (per currency, with
 * effective dates). An agreement provider usually only knows rates (royalty / marketing fund in basis points); every
 * field it leaves out falls back to the owner-group or organisation terms.
 *
 * The franchise agreements register is plugged in below (`franchise_agreements`). Another source would register like:
 *
 *   registerAgreementTermsProvider({
 *     name: 'franchise_agreements',
 *     async find(db, q) {
 *       const [a] = await db.select().from(franchiseAgreements).where(and(
 *         eq(franchiseAgreements.organizationId, q.organizationId), eq(franchiseAgreements.ownerGroupId, q.ownerGroupId!),
 *         lte(franchiseAgreements.effectiveFrom, q.onDate), or(isNull(franchiseAgreements.expiresOn), gt(franchiseAgreements.expiresOn, q.onDate)),
 *         eq(franchiseAgreements.status, 'signed')));
 *       return a ? { sourceId: a.id, royaltyBps: a.royaltyBps, marketingFundBps: a.marketingFundBps } : null;
 *     },
 *   });
 */
import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type { Exec } from '../../db/client.ts';
import { financeSettings, franchiseAgreements, locations, royaltyTerms } from '../../db/schema/index.ts';
import type { LateFeeTerms, RevenueBasis, RoyaltyTier } from '../../db/schema/finance.ts';
import { DEFAULT_BASIS, type RoyaltyTerms } from '../../domain/royalty.ts';

export interface AgreementTermsQuery {
  organizationId: string;
  ownerGroupId: string | null;
  locationId: string;
  currency: string;
  /** Local date (YYYY-MM-DD) the terms must be effective on: the period start. */
  onDate: string;
}

/** What an agreement can set. Monetary fields are in the query's currency. */
export interface AgreementTerms {
  sourceId: string;
  royaltyBps?: number;
  marketingFundBps?: number;
  tiers?: RoyaltyTier[];
  tierMode?: 'marginal' | 'whole';
  minimumRoyaltyMinor?: number;
  technologyFeeMinor?: number;
  basis?: Partial<RevenueBasis>;
  lateFee?: LateFeeTerms;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

export interface AgreementTermsProvider {
  name: string;
  find(db: Exec, q: AgreementTermsQuery): Promise<AgreementTerms | null>;
}

export const agreementTermsProviders: AgreementTermsProvider[] = [];

export function registerAgreementTermsProvider(p: AgreementTermsProvider) {
  const i = agreementTermsProviders.findIndex((x) => x.name === p.name);
  if (i >= 0) agreementTermsProviders[i] = p;
  else agreementTermsProviders.push(p);
}

/**
 * Built-in provider: the franchise agreements register (Legal → Franchise agreements). The active agreement of the
 * location's owner group (covering the location when it names locations) sets the royalty and marketing-fund rates;
 * everything else comes from the owner-group or organisation terms.
 */
registerAgreementTermsProvider({
  name: 'franchise_agreements',
  async find(db, q) {
    if (!q.ownerGroupId) return null;
    const rows = await db.select().from(franchiseAgreements).where(and(
      eq(franchiseAgreements.organizationId, q.organizationId), eq(franchiseAgreements.ownerGroupId, q.ownerGroupId), eq(franchiseAgreements.status, 'active'),
      lte(franchiseAgreements.startDate, q.onDate), gt(franchiseAgreements.endDate, q.onDate),
    )).orderBy(desc(franchiseAgreements.startDate));
    // An owner group can hold agreements for several brands: use the one for the location's brand.
    const [loc] = await db.select({ brandId: locations.brandId }).from(locations).where(eq(locations.id, q.locationId));
    const brandOk = (r: (typeof rows)[number]) => !r.brandId || r.brandId === (loc?.brandId ?? null);
    const a = rows.find((r) => (!r.locationIds.length || r.locationIds.includes(q.locationId)) && brandOk(r));
    if (!a || (a.royaltyBps == null && a.marketingFundBps == null)) return null;
    return { sourceId: a.id, ...(a.royaltyBps != null ? { royaltyBps: a.royaltyBps } : {}), ...(a.marketingFundBps != null ? { marketingFundBps: a.marketingFundBps } : {}) };
  },
});

type TermsRow = typeof royaltyTerms.$inferSelect;

function rowToTerms(r: TermsRow): RoyaltyTerms {
  return {
    source: r.ownerGroupId ? 'owner_group' : 'organization', sourceId: r.id, currency: r.currency,
    royaltyBps: r.royaltyBps, tiers: r.tiers ?? [], tierMode: r.tierMode === 'whole' ? 'whole' : 'marginal',
    minimumRoyaltyMinor: r.minimumRoyaltyMinor, marketingFundBps: r.marketingFundBps, technologyFeeMinor: r.technologyFeeMinor,
    basis: { ...DEFAULT_BASIS, ...r.basis }, lateFee: r.lateFee ?? { kind: 'none', graceDays: 0 }, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
  };
}

async function termsRow(db: Exec, organizationId: string, ownerGroupId: string | null, currency: string, onDate: string, brandId: string | null = null) {
  const [r] = await db.select().from(royaltyTerms).where(and(
    eq(royaltyTerms.organizationId, organizationId),
    ownerGroupId ? eq(royaltyTerms.ownerGroupId, ownerGroupId) : isNull(royaltyTerms.ownerGroupId),
    // Owner-group rows apply to every brand the group runs; organisation-level rows are per brand or the network default.
    ownerGroupId ? undefined : brandId ? eq(royaltyTerms.brandId, brandId) : isNull(royaltyTerms.brandId),
    eq(royaltyTerms.currency, currency),
    lte(royaltyTerms.effectiveFrom, onDate),
    or(isNull(royaltyTerms.effectiveTo), gt(royaltyTerms.effectiveTo, onDate)),
  )).orderBy(desc(royaltyTerms.effectiveFrom)).limit(1);
  return r ?? null;
}

/** The terms for a location's statement, or null when nothing is configured for its currency. */
export async function resolveTerms(db: Exec, q: AgreementTermsQuery): Promise<RoyaltyTerms | null> {
  const groupRow = q.ownerGroupId ? await termsRow(db, q.organizationId, q.ownerGroupId, q.currency, q.onDate) : null;
  // Multi-brand HQ: a brand's own default terms sit between the owner group's terms and the network default.
  const [loc] = await db.select({ brandId: locations.brandId }).from(locations).where(eq(locations.id, q.locationId));
  const brandRow = !groupRow && loc?.brandId ? await termsRow(db, q.organizationId, null, q.currency, q.onDate, loc.brandId) : null;
  const base = groupRow ?? brandRow ?? (await termsRow(db, q.organizationId, null, q.currency, q.onDate));
  let agreement: AgreementTerms | null = null;
  for (const p of agreementTermsProviders) {
    agreement = await p.find(db, q);
    if (agreement) break;
  }
  if (!base && !agreement) return null;
  const t: RoyaltyTerms = base ? rowToTerms(base) : {
    source: 'agreement', sourceId: null, currency: q.currency, royaltyBps: 0, tiers: [], tierMode: 'marginal', minimumRoyaltyMinor: 0, marketingFundBps: 0,
    technologyFeeMinor: 0, basis: DEFAULT_BASIS, lateFee: { kind: 'none', graceDays: 0 }, effectiveFrom: q.onDate, effectiveTo: null,
  };
  if (!agreement) return t;
  const { sourceId, basis, ...rest } = agreement;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return { ...t, ...defined, basis: { ...t.basis, ...(basis ?? {}) }, source: 'agreement', sourceId };
}

export type FinanceSettingsRow = typeof financeSettings.$inferSelect;

/** Finance settings for an organisation (created with defaults on first use). */
export async function getFinanceSettings(db: Exec, organizationId: string): Promise<FinanceSettingsRow> {
  const [row] = await db.select().from(financeSettings).where(eq(financeSettings.organizationId, organizationId));
  if (row) return row;
  await db.insert(financeSettings).values({ organizationId }).onConflictDoNothing();
  const [created] = await db.select().from(financeSettings).where(eq(financeSettings.organizationId, organizationId));
  return created!;
}

export function serializeTerms(r: TermsRow) {
  return {
    id: r.id, ownerGroupId: r.ownerGroupId, brandId: r.brandId, currency: r.currency, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
    royaltyBps: r.royaltyBps, tiers: r.tiers, tierMode: r.tierMode, minimumRoyaltyMinor: r.minimumRoyaltyMinor, marketingFundBps: r.marketingFundBps,
    technologyFeeMinor: r.technologyFeeMinor, basis: { ...DEFAULT_BASIS, ...r.basis }, lateFee: r.lateFee, notes: r.notes,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

export function serializeSettings(r: FinanceSettingsRow) {
  return {
    periodFrequency: r.periodFrequency as 'weekly' | 'monthly', weekStartsOn: r.weekStartsOn, invoicePrefix: r.invoicePrefix, nextInvoiceSeq: r.nextInvoiceSeq,
    paymentTermsDays: r.paymentTermsDays, taxLines: r.taxLines, dunning: r.dunning, autoCollect: r.autoCollect, collectionAccountId: r.collectionAccountId,
    issuerDetails: r.issuerDetails,
  };
}

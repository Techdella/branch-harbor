/**
 * Marketing fund ledger: contributions in (credited when a franchisee's invoice is paid), spend out (allocated to a
 * network campaign, with a receipt), adjustments. Balances, the transparency report and the annual statement are
 * always per currency.
 */
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Services } from '../../context.ts';
import type { Exec } from '../../db/client.ts';
import { marketingFundCampaigns, marketingFundEntries } from '../../db/schema/index.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { audit } from '../audit.ts';
import { saveDocument } from './statements.ts';

type Entry = typeof marketingFundEntries.$inferSelect;

export async function fundBalances(db: Exec, organizationId: string, before?: string) {
  const rows = await db.select({ currency: marketingFundEntries.currency, kind: marketingFundEntries.kind, total: sql<number>`coalesce(sum(${marketingFundEntries.amountMinor}), 0)::bigint` })
    .from(marketingFundEntries).where(and(eq(marketingFundEntries.organizationId, organizationId), before ? lt(marketingFundEntries.occurredOn, before) : undefined))
    .groupBy(marketingFundEntries.currency, marketingFundEntries.kind);
  const out = new Map<string, { currency: string; contributionsMinor: number; spendMinor: number; adjustmentsMinor: number; balanceMinor: number }>();
  for (const r of rows) {
    const b = out.get(r.currency) ?? { currency: r.currency, contributionsMinor: 0, spendMinor: 0, adjustmentsMinor: 0, balanceMinor: 0 };
    const v = Number(r.total);
    if (r.kind === 'contribution') b.contributionsMinor += v;
    else if (r.kind === 'spend') b.spendMinor += -v;
    else b.adjustmentsMinor += v;
    b.balanceMinor += v;
    out.set(r.currency, b);
  }
  return [...out.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export async function createCampaign(s: Services, organizationId: string, input: { name: string; description?: string | null }, actorUserId: string) {
  const [c] = await s.db.insert(marketingFundCampaigns).values({ organizationId, name: input.name, description: input.description ?? null, createdBy: actorUserId }).returning();
  await audit(s.db, { organizationId, actorUserId, action: 'finance.fund_campaign_created', scopeKind: 'organization', scopeId: organizationId, targetType: 'fund_campaign', targetId: c!.id });
  return c!;
}

/** Records fund spend on a campaign. A receipt is required, and spend may not exceed the balance in that currency. */
export async function recordSpend(s: Services, organizationId: string, input: { currency: string; amountMinor: number; campaignId: string; description: string; vendor?: string | null; occurredOn: string; receipt: { filename: string; contentType: string; dataBase64: string } }, actorUserId: string) {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw validationError('Amount must be a positive integer in minor units', { amountMinor: 'Must be > 0' });
  return s.db.transaction(async (tx) => {
    // Serialise spend per organisation so two concurrent entries cannot overdraw the fund.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fund:${organizationId}`}))`);
    const [c] = await tx.select().from(marketingFundCampaigns).where(and(eq(marketingFundCampaigns.id, input.campaignId), eq(marketingFundCampaigns.organizationId, organizationId)));
    if (!c) throw notFound('Campaign');
    const bal = (await fundBalances(tx, organizationId)).find((b) => b.currency === input.currency)?.balanceMinor ?? 0;
    if (input.amountMinor > bal) throw conflict('fund_insufficient', `The fund holds ${bal} ${input.currency} minor units`, { balanceMinor: bal, currency: input.currency });
    const doc = await saveDocument(tx, { organizationId, kind: 'receipt', locationId: null, ...input.receipt, uploadedBy: actorUserId });
    const [e] = await tx.insert(marketingFundEntries).values({
      organizationId, kind: 'spend', currency: input.currency, amountMinor: -input.amountMinor, occurredOn: input.occurredOn, description: input.description, campaignId: c.id,
      receiptDocumentId: doc.id, vendor: input.vendor ?? null, createdBy: actorUserId,
    }).returning();
    await audit(tx, { organizationId, actorUserId, action: 'finance.fund_spend_recorded', scopeKind: 'organization', scopeId: organizationId, targetType: 'fund_entry', targetId: e!.id, metadata: { amountMinor: input.amountMinor, currency: input.currency, campaignId: c.id } });
    return e!;
  });
}

export function serializeEntry(e: Entry, names: { campaigns: Map<string, string>; locations?: Map<string, { name: string }>; groups?: Map<string, { name: string }> }, showFranchisee: boolean) {
  return {
    id: e.id, kind: e.kind, currency: e.currency, amountMinor: e.amountMinor, occurredOn: e.occurredOn, description: e.description, vendor: e.vendor,
    campaign: e.campaignId ? { id: e.campaignId, name: names.campaigns.get(e.campaignId) ?? null } : null,
    location: showFranchisee && e.locationId ? { id: e.locationId, name: names.locations?.get(e.locationId)?.name ?? null } : null,
    ownerGroup: showFranchisee && e.ownerGroupId ? { id: e.ownerGroupId, name: names.groups?.get(e.ownerGroupId)?.name ?? null } : null,
    receiptDocumentId: e.receiptDocumentId, createdAt: e.createdAt.toISOString(),
  };
}

/**
 * Transparency report for a year: per currency, opening balance, contributions, spend by campaign, closing balance.
 * Contributions of other franchisees are only shown as totals; `ownLocations` adds the viewer's own contributions.
 */
export async function transparencyReport(db: Exec, organizationId: string, year: number, ownLocations: 'all' | Set<string>) {
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const opening = await fundBalances(db, organizationId, from);
  const entries = await db.select().from(marketingFundEntries).where(and(eq(marketingFundEntries.organizationId, organizationId), gte(marketingFundEntries.occurredOn, from), lt(marketingFundEntries.occurredOn, to))).orderBy(asc(marketingFundEntries.occurredOn));
  const campaigns = new Map((await db.select().from(marketingFundCampaigns).where(eq(marketingFundCampaigns.organizationId, organizationId))).map((c) => [c.id, c.name]));
  const currencies = [...new Set([...opening.map((o) => o.currency), ...entries.map((e) => e.currency)])].sort();
  return currencies.map((currency) => {
    const es = entries.filter((e) => e.currency === currency);
    const openingMinor = opening.find((o) => o.currency === currency)?.balanceMinor ?? 0;
    const contributions = es.filter((e) => e.kind === 'contribution');
    const spend = es.filter((e) => e.kind === 'spend');
    const adjustments = es.filter((e) => e.kind === 'adjustment').reduce((a, e) => a + e.amountMinor, 0);
    const byCampaign = new Map<string, number>();
    for (const e of spend) byCampaign.set(e.campaignId ?? '', (byCampaign.get(e.campaignId ?? '') ?? 0) - e.amountMinor);
    const contributionsMinor = contributions.reduce((a, e) => a + e.amountMinor, 0);
    const spendMinor = spend.reduce((a, e) => a - e.amountMinor, 0);
    const own = ownLocations === 'all' ? contributions : contributions.filter((e) => e.locationId && ownLocations.has(e.locationId));
    return {
      currency, year, openingBalanceMinor: openingMinor, contributionsMinor, contributorCount: new Set(contributions.map((e) => e.ownerGroupId ?? e.locationId)).size,
      spendMinor, adjustmentsMinor: adjustments, closingBalanceMinor: openingMinor + contributionsMinor - spendMinor + adjustments,
      spendByCampaign: [...byCampaign.entries()].map(([id, amountMinor]) => ({ campaignId: id || null, name: campaigns.get(id) ?? null, amountMinor })).sort((a, b) => b.amountMinor - a.amountMinor),
      yourContributionsMinor: own.reduce((a, e) => a + e.amountMinor, 0),
    };
  });
}

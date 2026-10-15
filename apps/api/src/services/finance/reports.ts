/** Finance reports: every total is grouped by currency (never converted or summed across currencies). */
import { and, eq, gte, inArray, lt, ne } from 'drizzle-orm';
import type { Exec } from '../../db/client.ts';
import { financeInvoices, royaltyPeriods, royaltyStatements } from '../../db/schema/index.ts';
import { AGEING_BUCKETS, ageingBucket, type AgeingBucket } from '../../domain/royalty.ts';
import { fundBalances } from './fund.ts';
import type { Directory } from './statements.ts';

interface RevenueRow { key: string; name: string | null; currency: string; statements: number; basisMinor: number; royaltyMinor: number; marketingFundMinor: number; technologyFeeMinor: number; totalMinor: number }

export async function financeReports(db: Exec, organizationId: string, f: { from: string; to: string }, dir: Directory, todayLocal: string) {
  const periods = await db.select().from(royaltyPeriods).where(and(eq(royaltyPeriods.organizationId, organizationId), gte(royaltyPeriods.startDate, f.from), lt(royaltyPeriods.startDate, f.to)));
  const sts = periods.length
    ? await db.select().from(royaltyStatements).where(and(eq(royaltyStatements.organizationId, organizationId), inArray(royaltyStatements.periodId, periods.map((p) => p.id)), ne(royaltyStatements.status, 'void')))
    : [];
  const group = (keyOf: (s: (typeof sts)[number]) => string, nameOf: (k: string) => string | null) => {
    const m = new Map<string, RevenueRow>();
    for (const s of sts) {
      const key = keyOf(s);
      const id = `${key}|${s.currency}`;
      const r = m.get(id) ?? { key, name: nameOf(key), currency: s.currency, statements: 0, basisMinor: 0, royaltyMinor: 0, marketingFundMinor: 0, technologyFeeMinor: 0, totalMinor: 0 };
      r.statements++;
      r.basisMinor += s.basisMinor;
      r.royaltyMinor += s.royaltyMinor;
      r.marketingFundMinor += s.marketingFundMinor;
      r.technologyFeeMinor += s.technologyFeeMinor;
      r.totalMinor += s.totalMinor;
      m.set(id, r);
    }
    return [...m.values()].sort((a, b) => a.currency.localeCompare(b.currency) || b.royaltyMinor - a.royaltyMinor);
  };
  const byLocation = group((s) => s.locationId, (k) => dir.locations.get(k)?.name ?? null);
  const byRegion = group((s) => dir.locations.get(s.locationId)?.regionId ?? '', (k) => (k ? dir.regions.get(k)?.name ?? null : null));

  const invs = await db.select().from(financeInvoices).where(and(eq(financeInvoices.organizationId, organizationId), ne(financeInvoices.status, 'void')));
  const inRange = invs.filter((i) => i.issueDate >= f.from && i.issueDate < f.to);
  const collection = new Map<string, { currency: string; invoices: number; invoicedMinor: number; collectedMinor: number; paidInvoices: number; paidOnTime: number; rate: number }>();
  for (const i of inRange) {
    const c = collection.get(i.currency) ?? { currency: i.currency, invoices: 0, invoicedMinor: 0, collectedMinor: 0, paidInvoices: 0, paidOnTime: 0, rate: 0 };
    c.invoices++;
    c.invoicedMinor += i.totalMinor;
    c.collectedMinor += i.paidMinor;
    if (i.status === 'paid') {
      c.paidInvoices++;
      if (i.paidAt && i.paidAt.toISOString().slice(0, 10) <= i.dueDate) c.paidOnTime++;
    }
    collection.set(i.currency, c);
  }
  for (const c of collection.values()) c.rate = c.invoicedMinor ? Math.round((c.collectedMinor / c.invoicedMinor) * 10_000) / 10_000 : 0;

  // Arrears: everything still owed today, whatever the issue date.
  const ageing = new Map<string, { currency: string; totalMinor: number; invoices: number } & Record<AgeingBucket, number>>();
  for (const i of invs.filter((x) => x.status !== 'paid' && x.totalMinor > x.paidMinor)) {
    const a = ageing.get(i.currency) ?? { currency: i.currency, totalMinor: 0, invoices: 0, ...Object.fromEntries(AGEING_BUCKETS.map((b) => [b, 0])) as Record<AgeingBucket, number> };
    const owed = i.totalMinor - i.paidMinor;
    a[ageingBucket(i.dueDate, todayLocal)] += owed;
    a.totalMinor += owed;
    a.invoices++;
    ageing.set(i.currency, a);
  }
  return {
    range: f,
    royaltyByLocation: byLocation,
    royaltyByRegion: byRegion,
    collectionRate: [...collection.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    arrearsAgeing: [...ageing.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    fundBalance: await fundBalances(db, organizationId),
  };
}

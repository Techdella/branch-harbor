/**
 * Accounting exports (CSV). Every row carries its currency; nothing is summed across currencies.
 *
 * Formats:
 * - `csv`: BranchHarbor's own columns.
 * - `xero`: Xero "Import invoices" (sales invoices) and "Import bank statement" CSV layouts.
 * - `quickbooks`: QuickBooks Online invoice import CSV and the 3-column bank transactions CSV (Date, Description,
 *   Amount). The QuickBooks bank layout has no currency column, so it needs one currency per file.
 * Files are produced for upload by the accountant (sandbox: no API push to Xero or QuickBooks). Account codes and
 * tax types are placeholders the accountant maps in the import screen (`ROYALTY`, `MKTFUND`, …, `Tax on Sales`).
 */
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import { minorUnitExponent, type Currency } from '@bh/shared';
import type { Exec } from '../../db/client.ts';
import { financeInvoices, financePayouts, marketingFundEntries, royaltyPeriods, royaltyStatements } from '../../db/schema/index.ts';
import { fundCampaignNames } from './fund.ts';
import { validationError } from '../../lib/errors.ts';
import type { Directory } from './statements.ts';

export type ExportFormat = 'csv' | 'xero' | 'quickbooks';
export type ExportDataset = 'statements' | 'invoices' | 'payouts' | 'fund';

/** RFC 4180 quoting, plus a leading quote on text that a spreadsheet would run as a formula. */
const esc = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+@]/.test(s) || (/^-/.test(s) && !/^-\d/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
/** Minor units → decimal string in the currency's exponent (no float drift). */
export function major(minor: number, currency: string): string {
  const e = minorUnitExponent(currency as Currency);
  if (e === 0) return String(minor);
  const neg = minor < 0;
  const abs = Math.abs(minor).toString().padStart(e + 1, '0');
  return `${neg ? '-' : ''}${abs.slice(0, -e)}.${abs.slice(-e)}`;
}

const LINE_LABEL: Record<string, string> = { royalty: 'Royalty', marketing_fund: 'Marketing fund contribution', technology_fee: 'Technology fee', adjustment: 'Adjustment', late_fee: 'Late fee' };
const LINE_ACCOUNT: Record<string, string> = { royalty: 'ROYALTY', marketing_fund: 'MKTFUND', technology_fee: 'TECHFEE', adjustment: 'ROYALTY', late_fee: 'LATEFEE' };

export interface ExportFilter { from?: string; to?: string; currency?: string; allowed: 'all' | Set<string> }
const inScope = (allowed: 'all' | Set<string>, loc: string | null) => allowed === 'all' || (!!loc && allowed.has(loc));

export async function buildExport(db: Exec, organizationId: string, dataset: ExportDataset, format: ExportFormat, f: ExportFilter, dir: Directory): Promise<{ filename: string; csv: string }> {
  const stamp = `${f.from ?? 'all'}_${f.to ?? 'now'}${f.currency ? `_${f.currency}` : ''}`;
  const locName = (id: string) => dir.locations.get(id)?.name ?? id;
  const contact = (groupId: string | null, locId: string) => (groupId ? dir.groups.get(groupId)?.legalName ?? dir.groups.get(groupId)?.name : null) ?? locName(locId);

  if (dataset === 'invoices') {
    const conds = [eq(financeInvoices.organizationId, organizationId)];
    if (f.from) conds.push(gte(financeInvoices.issueDate, f.from));
    if (f.to) conds.push(lt(financeInvoices.issueDate, f.to));
    if (f.currency) conds.push(eq(financeInvoices.currency, f.currency));
    const invs = (await db.select().from(financeInvoices).where(and(...conds)).orderBy(asc(financeInvoices.seq))).filter((i) => inScope(f.allowed, i.locationId));
    if (format === 'xero') {
      const headers = ['*ContactName', 'EmailAddress', '*InvoiceNumber', 'Reference', '*InvoiceDate', '*DueDate', 'Description', '*Quantity', '*UnitAmount', '*AccountCode', '*TaxType', 'TaxAmount', 'Currency'];
      const rows: unknown[][] = [];
      for (const i of invs) {
        const taxTotal = i.taxMinor;
        const base = i.lines.reduce((a, l) => a + Math.max(0, l.amountMinor), 0) || 1;
        let allocated = 0;
        i.lines.forEach((l, idx) => {
          // Spread the invoice tax over taxable lines in proportion (the last line takes the rounding remainder).
          const share = idx === i.lines.length - 1 ? taxTotal - allocated : Math.round((taxTotal * Math.max(0, l.amountMinor)) / base);
          allocated += share;
          rows.push([contact(i.ownerGroupId, i.locationId), '', i.number, locName(i.locationId), i.issueDate, i.dueDate, LINE_LABEL[l.kind] ?? l.kind, 1, major(l.amountMinor, i.currency), LINE_ACCOUNT[l.kind] ?? 'ROYALTY', taxTotal ? 'Tax on Sales' : 'Tax Exempt', major(share, i.currency), i.currency]);
        });
      }
      return { filename: `invoices_xero_${stamp}.csv`, csv: toCsv(headers, rows) };
    }
    if (format === 'quickbooks') {
      const headers = ['InvoiceNo', 'Customer', 'InvoiceDate', 'DueDate', 'Item(Product/Service)', 'ItemDescription', 'ItemQuantity', 'ItemRate', 'ItemAmount', 'ItemTaxAmount', 'Currency'];
      const rows: unknown[][] = [];
      for (const i of invs) {
        i.lines.forEach((l, idx) => rows.push([i.number, contact(i.ownerGroupId, i.locationId), i.issueDate, i.dueDate, LINE_LABEL[l.kind] ?? l.kind, `${locName(i.locationId)} — ${LINE_LABEL[l.kind] ?? l.kind}`, 1, major(l.amountMinor, i.currency), major(l.amountMinor, i.currency), idx === 0 ? major(i.taxMinor, i.currency) : major(0, i.currency), i.currency]));
      }
      return { filename: `invoices_quickbooks_${stamp}.csv`, csv: toCsv(headers, rows) };
    }
    const headers = ['number', 'location', 'franchisee', 'currency', 'issue_date', 'due_date', 'subtotal', 'tax', 'late_fee', 'total', 'paid', 'outstanding', 'status'];
    return { filename: `invoices_${stamp}.csv`, csv: toCsv(headers, invs.map((i) => [i.number, locName(i.locationId), contact(i.ownerGroupId, i.locationId), i.currency, i.issueDate, i.dueDate, major(i.subtotalMinor, i.currency), major(i.taxMinor, i.currency), major(i.lateFeeMinor, i.currency), major(i.totalMinor, i.currency), major(i.paidMinor, i.currency), major(i.totalMinor - i.paidMinor, i.currency), i.status])) };
  }

  if (dataset === 'payouts') {
    const conds = [eq(financePayouts.organizationId, organizationId)];
    if (f.from) conds.push(gte(financePayouts.arrivalDate, f.from));
    if (f.to) conds.push(lt(financePayouts.arrivalDate, f.to));
    if (f.currency) conds.push(eq(financePayouts.currency, f.currency));
    const pos = (await db.select().from(financePayouts).where(and(...conds)).orderBy(asc(financePayouts.arrivalDate))).filter((p) => inScope(f.allowed, p.locationId));
    if (format === 'quickbooks') {
      const currencies = new Set(pos.map((p) => p.currency));
      if (currencies.size > 1) throw validationError('QuickBooks bank files hold one currency: choose a currency', { currency: 'Required for this format' });
      return { filename: `payouts_quickbooks_${stamp}.csv`, csv: toCsv(['Date', 'Description', 'Amount'], pos.map((p) => [p.arrivalDate, `Stripe payout ${p.externalId} — ${locName(p.locationId)}`, major(p.amountMinor, p.currency)])) };
    }
    if (format === 'xero') {
      return { filename: `payouts_xero_${stamp}.csv`, csv: toCsv(['*Date', '*Amount', 'Payee', 'Description', 'Reference', 'Currency'], pos.map((p) => [p.arrivalDate, major(p.amountMinor, p.currency), 'Stripe', `Payout ${locName(p.locationId)}: gross ${major(p.grossMinor, p.currency)}, fees ${major(p.feesMinor, p.currency)}, refunds ${major(p.refundsMinor, p.currency)}, chargebacks ${major(p.chargebacksMinor, p.currency)}`, p.externalId, p.currency])) };
    }
    const headers = ['payout', 'location', 'currency', 'arrival_date', 'status', 'gross', 'fees', 'refunds', 'chargebacks', 'other', 'net', 'sandbox'];
    return { filename: `payouts_${stamp}.csv`, csv: toCsv(headers, pos.map((p) => [p.externalId, locName(p.locationId), p.currency, p.arrivalDate, p.status, major(p.grossMinor, p.currency), major(p.feesMinor, p.currency), major(p.refundsMinor, p.currency), major(p.chargebacksMinor, p.currency), major(p.otherMinor, p.currency), major(p.amountMinor, p.currency), p.sandbox ? 'yes' : 'no'])) };
  }

  if (dataset === 'statements') {
    const periods = await db.select().from(royaltyPeriods).where(eq(royaltyPeriods.organizationId, organizationId));
    const pIds = periods.filter((p) => (!f.from || p.startDate >= f.from) && (!f.to || p.startDate < f.to)).map((p) => p.id);
    if (!pIds.length) return { filename: `statements_${stamp}.csv`, csv: toCsv(['period_start'], []) };
    const sts = (await db.select().from(royaltyStatements).where(and(eq(royaltyStatements.organizationId, organizationId), inArray(royaltyStatements.periodId, pIds)))).filter((s) => inScope(f.allowed, s.locationId) && (!f.currency || s.currency === f.currency));
    const pById = new Map(periods.map((p) => [p.id, p]));
    const headers = ['period_start', 'period_end', 'location', 'franchisee', 'currency', 'status', 'gross_sales', 'refunds', 'tax_excluded', 'tips_excluded', 'external_sales', 'basis', 'royalty', 'marketing_fund', 'technology_fee', 'adjustments', 'total'];
    return { filename: `statements_${stamp}.csv`, csv: toCsv(headers, sts.map((s) => [pById.get(s.periodId)?.startDate, pById.get(s.periodId)?.endDate, locName(s.locationId), contact(s.ownerGroupId, s.locationId), s.currency, s.status, ...[s.grossSalesMinor, s.refundsMinor, s.taxMinor, s.tipsMinor, s.externalSalesMinor, s.basisMinor, s.royaltyMinor, s.marketingFundMinor, s.technologyFeeMinor, s.adjustmentsMinor, s.totalMinor].map((v) => major(v, s.currency))])) };
  }

  // fund ledger
  const conds = [eq(marketingFundEntries.organizationId, organizationId)];
  if (f.from) conds.push(gte(marketingFundEntries.occurredOn, f.from));
  if (f.to) conds.push(lt(marketingFundEntries.occurredOn, f.to));
  if (f.currency) conds.push(eq(marketingFundEntries.currency, f.currency));
  const entries = await db.select().from(marketingFundEntries).where(and(...conds)).orderBy(asc(marketingFundEntries.occurredOn));
  const campaigns = await fundCampaignNames(db, organizationId);
  const showWho = f.allowed === 'all';
  const visible = entries.filter((e) => e.kind !== 'contribution' || showWho || inScope(f.allowed, e.locationId));
  return { filename: `marketing_fund_${stamp}.csv`, csv: toCsv(['date', 'kind', 'currency', 'amount', 'description', 'campaign', 'vendor', 'location'], visible.map((e) => [e.occurredOn, e.kind, e.currency, major(e.amountMinor, e.currency), e.description, e.campaignId ? campaigns.get(e.campaignId) ?? '' : '', e.vendor ?? '', e.locationId ? locName(e.locationId) : ''])) };
}

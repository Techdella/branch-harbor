import { z } from 'zod';
import { defineTool } from '../types.ts';
import { fmtMoney, itemsOf, periodRange, table } from '../present.ts';
import { plural } from './_helpers.ts';

interface Invoice { id: string; number: string; location: { id: string; name: string } | null; ownerGroup: { name: string } | null; currency: string; issueDate: string; dueDate: string; totalMinor: number; paidMinor: number; outstandingMinor: number; status: string; state: string; daysOverdue: number | null; dunningStage: string | null }

const royaltyStatus = defineTool({
  name: 'royalty_status',
  kind: 'read',
  area: 'finance',
  modules: ['finance.royalties', 'finance.invoices'],
  networkOnly: true,
  description: 'Royalty and fee invoices per location with amount, amount outstanding, due date and state (paid, open, overdue). Use for "which locations missed royalties last month": period filters by invoice issue date; onlyOverdue keeps unpaid invoices past their due date. Amounts are per currency, never combined.',
  input: z.object({ period: z.enum(['this_month', 'last_month', 'this_quarter', 'last_quarter', 'year_to_date', 'last_30_days', 'all']).default('all'), onlyOverdue: z.boolean().default(false) }),
  async run(ctx, i) {
    const r = await ctx.api.get(ctx.o('/finance/invoices'), { limit: 500 });
    const p = i.period === 'all' ? null : periodRange(i.period);
    // A royalty for a month is invoiced early the next month: "last month" also matches invoices issued this month for it.
    const lastMonthAlso = i.period === 'last_month' ? periodRange('this_month') : null;
    const all = itemsOf<Invoice>(r).filter((x) => x.status !== 'void');
    const inPeriod = (x: Invoice) => !p || (x.issueDate >= p.from && x.issueDate <= p.to) || (!!lastMonthAlso && x.issueDate >= lastMonthAlso.from && x.issueDate <= lastMonthAlso.to);
    const overdue = (x: Invoice) => x.state === 'overdue' || ((x.status === 'open' || x.status === 'processing') && x.dueDate < new Date().toISOString().slice(0, 10) && x.outstandingMinor > 0);
    const items = all.filter((x) => inPeriod(x) && (!i.onlyOverdue || overdue(x)));
    // Still unpaid from earlier periods: a location that "missed" royalties may owe an older invoice.
    const earlier = i.onlyOverdue && p ? all.filter((x) => !inPeriod(x) && overdue(x)) : [];
    return { periodLabel: p?.label ?? 'all periods', items: [...items, ...earlier], inPeriod: items.length, earlier: earlier.length };
  },
  present: (r: { periodLabel: string; items: Invoice[]; inPeriod: number; earlier: number }, i, ctx) => {
    const items = r.items;
    const earlierNote = r.earlier ? ` ${r.inPeriod ? '' : `None issued for ${r.periodLabel} is overdue, but `}${plural(r.earlier, 'invoice')} from earlier periods ${r.earlier === 1 ? 'is' : 'are'} still overdue.` : '';
    const byCur = [...new Set(items.map((x) => x.currency))].map((c) => `${fmtMoney(items.filter((x) => x.currency === c).reduce((a, x) => a + x.outstandingMinor, 0), c, ctx.locale)} outstanding in ${c}`);
    const locs = [...new Set(items.map((x) => x.location?.name ?? x.ownerGroup?.name ?? '—'))];
    return {
      summary: items.length
        ? `${plural(items.length, i.onlyOverdue ? 'overdue invoice' : 'invoice')} across ${plural(locs.length, 'location')} (${locs.slice(0, 8).join(', ')}); ${byCur.join('; ')}.${earlierNote}`
        : i.onlyOverdue ? `No overdue royalty invoices for ${r.periodLabel}.` : `No royalty invoices for ${r.periodLabel}.`,
      blocks: items.length ? [table(i.onlyOverdue ? `Overdue royalties: ${r.periodLabel}` : `Royalty invoices: ${r.periodLabel}`, [
        { key: 'location', label: 'Location' }, { key: 'number', label: 'Invoice' }, { key: 'totalMinor', label: 'Total', kind: 'money' }, { key: 'outstandingMinor', label: 'Outstanding', kind: 'money' },
        { key: 'dueDate', label: 'Due', kind: 'date' }, { key: 'state', label: 'State', kind: 'status' }, { key: 'daysOverdue', label: 'Days overdue', kind: 'number' },
      ], items.map((x) => ({ ...x, location: x.location?.name ?? x.ownerGroup?.name ?? null })), { currencyKey: 'currency', note: 'Each amount is in its own currency.' })] : [],
      citations: [{ id: 'royalties', title: 'Statements & invoices', url: ctx.can('finance.royalties') ? '/finance/royalties' : '/finance/statements', sourceType: 'screen' }],
    };
  },
});

const listStatements = defineTool({
  name: 'list_royalty_statements',
  kind: 'read',
  area: 'finance',
  modules: ['finance.royalties', 'finance.invoices'],
  networkOnly: true,
  description: 'Monthly royalty statements per location: gross sales basis, royalty, marketing fund, technology fee, adjustments, total and status (draft, approved, invoiced, disputed). Amounts are per currency.',
  input: z.object({ status: z.string().max(30).optional() }),
  run: (ctx, i) => ctx.api.get(ctx.o('/finance/statements'), { status: i.status, limit: 200 }),
  present: (r) => {
    const items = itemsOf(r);
    return {
      summary: `${plural(items.length, 'statement')} (${[...new Set(items.map((x) => x.status))].join(', ')}).`,
      blocks: items.length ? [table('Royalty statements', [
        { key: 'location', label: 'Location' }, { key: 'period', label: 'Period' }, { key: 'basisMinor', label: 'Sales basis', kind: 'money' }, { key: 'royaltyMinor', label: 'Royalty', kind: 'money' },
        { key: 'marketingFundMinor', label: 'Fund', kind: 'money' }, { key: 'totalMinor', label: 'Total', kind: 'money' }, { key: 'status', label: 'Status', kind: 'status' },
      ], items.map((x) => ({ ...x, location: x.location?.name ?? x.ownerGroup?.name ?? null, period: x.period?.label ?? x.periodStartAt?.slice(0, 7) ?? null })), { currencyKey: 'currency' })] : [],
      citations: [{ id: 'statements', title: 'Royalty statements', url: '/finance/statements', sourceType: 'screen' }],
    };
  },
});

const fundSummary = defineTool({
  name: 'marketing_fund_summary',
  kind: 'read',
  area: 'finance',
  modules: ['finance.marketing_fund'],
  networkOnly: true,
  description: 'Marketing fund transparency for the year, per currency: opening balance, contributions, spend by campaign, adjustments and closing balance (and the person’s own contributions).',
  input: z.object({ year: z.number().int().min(2000).max(2100).optional() }),
  run: (ctx, i) => ctx.api.get(ctx.o('/finance/fund/transparency'), { year: i.year }),
  present: (r, _i, ctx) => {
    const cs = (r.currencies ?? []) as any[];
    return {
      summary: cs.length ? cs.map((c) => `${c.currency}: contributions ${fmtMoney(c.contributionsMinor, c.currency, ctx.locale)}, spend ${fmtMoney(c.spendMinor, c.currency, ctx.locale)}, balance ${fmtMoney(c.closingBalanceMinor, c.currency, ctx.locale)}`).join('; ') + '.' : 'No marketing fund activity yet.',
      blocks: cs.length ? [table(`Marketing fund ${r.year}`, [{ key: 'currency', label: 'Currency' }, { key: 'openingBalanceMinor', label: 'Opening', kind: 'money' }, { key: 'contributionsMinor', label: 'Contributions', kind: 'money' }, { key: 'spendMinor', label: 'Spend', kind: 'money' }, { key: 'closingBalanceMinor', label: 'Balance', kind: 'money' }], cs, { currencyKey: 'currency' })] : [],
      citations: [{ id: 'fund', title: 'Marketing fund', url: '/finance/marketing-fund', sourceType: 'screen' }],
    };
  },
});

export default [royaltyStatus, listStatements, fundSummary];

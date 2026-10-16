import { z } from 'zod';
import { defineTool } from '../types.ts';
import { fmtMoney, itemsOf, table } from '../present.ts';
import { ifAllowed, plural } from './_helpers.ts';

/**
 * Multi-brand and billing. Every assistant call carries the person's brand filter (X-BH-Brand), so these answers, like
 * every other tool's, cover the brand selected in the app. Billing is read-only: the assistant explains the plan, the
 * trial and who pays; changing a plan, a card or a payer is never offered.
 */

const listBrands = defineTool({
  name: 'list_brands',
  kind: 'read',
  area: 'network',
  modules: null,
  networkOnly: true,
  description: 'The brands this business runs that the person covers: name, whether it is the default brand, number of locations, site domain and languages. Also says which brand filter is active.',
  input: z.object({}),
  async run(ctx) {
    const r = await ctx.api.get(ctx.o('/brands'));
    return { multiBrand: !!r.multiBrand, filter: ctx.brand?.name ?? null, items: itemsOf(r).map((b) => ({ id: b.id, name: b.name, isDefault: b.isDefault, locationCount: b.locationCount, domain: b.domain, locales: (b.locales ?? []).join(', '), archived: !!b.archivedAt })) };
  },
  present: (r) => ({
    summary: r.multiBrand ? `${plural(r.items.length, 'brand')}: ${r.items.map((b: any) => `${b.name}${b.isDefault ? ' (default)' : ''}, ${b.locationCount} location(s)`).join('; ')}. ${r.filter ? `Filtered to ${r.filter}.` : 'Showing all brands.'}` : 'This business runs a single brand.',
    blocks: r.items.length > 1 ? [table('Brands', [{ key: 'name', label: 'Brand' }, { key: 'locationCount', label: 'Locations', kind: 'number' }, { key: 'domain', label: 'Domain' }, { key: 'locales', label: 'Languages' }], r.items)] : [],
    citations: [{ id: 'brands', title: 'Brands', url: '/settings/brands', sourceType: 'screen' }],
  }),
});

const brandComparison = defineTool({
  name: 'brand_comparison',
  kind: 'read',
  area: 'network',
  modules: ['network.reports'],
  networkOnly: true,
  description: 'Compares brands over a period (default 30 days): locations (operating, opening), revenue per currency (never added across currencies), franchise pipeline, available territories, active agreements and royalty terms per brand.',
  input: z.object({ days: z.number().int().min(1).max(366).default(30) }),
  async run(ctx, i) {
    const r = await ctx.api.get(ctx.o('/brands/comparison'), { days: i.days });
    const rows: any[] = [];
    for (const b of r.brands ?? []) {
      const rev = (b.revenue ?? []).length ? b.revenue : [{ currency: null, netMinor: null }];
      for (const x of rev) rows.push({ brand: b.name, operating: b.locations?.operating ?? 0, opening: b.locations?.opening ?? 0, currency: x.currency, netMinor: x.netMinor, openProspects: b.pipeline?.open ?? 0, availableTerritories: b.pipeline?.availableTerritories ?? 0, activeAgreements: b.activeAgreements ?? 0 });
    }
    return { days: i.days, multiBrand: !!r.multiBrand, brands: (r.brands ?? []).map((b: any) => ({ name: b.name, locations: b.locations, revenue: b.revenue, pipeline: b.pipeline, activeAgreements: b.activeAgreements, terms: b.terms })), rows };
  },
  present: (r, _i, ctx) => ({
    summary: `Brands over the last ${r.days} days: ${r.brands.map((b: any) => `${b.name}: ${b.locations?.operating ?? 0} operating, ${b.locations?.opening ?? 0} opening, revenue ${(b.revenue ?? []).map((x: any) => fmtMoney(x.netMinor, x.currency, ctx.locale)).join(' + ') || '—'}, ${b.pipeline?.open ?? 0} open prospect(s)`).join(' · ')}. Currencies are reported separately.`,
    blocks: r.rows.length ? [table(`Brand comparison (${r.days} days)`, [{ key: 'brand', label: 'Brand' }, { key: 'operating', label: 'Operating', kind: 'number' }, { key: 'opening', label: 'Opening', kind: 'number' }, { key: 'netMinor', label: 'Revenue', kind: 'money' }, { key: 'openProspects', label: 'Open prospects', kind: 'number' }, { key: 'availableTerritories', label: 'Available territories', kind: 'number' }, { key: 'activeAgreements', label: 'Agreements', kind: 'number' }], r.rows, { currencyKey: 'currency' })] : [],
    citations: [{ id: 'brand-report', title: 'Brand comparison', url: '/reports/brands', sourceType: 'screen' }],
  }),
});

const planStatus = defineTool({
  name: 'plan_status',
  kind: 'read',
  area: 'finance',
  modules: null,
  description: 'Read-only billing status: the plan, billing interval and status, paid trial days left, the next charge, the monthly total and who pays for each location (HQ or the franchisee). For franchisees, the location fees they pay. It never changes a plan, card or payer; point the person to Settings → Billing for that.',
  input: z.object({}),
  async run(ctx) {
    const hq = await ifAllowed(ctx.api.get(ctx.o('/billing')));
    if (hq) {
      const payers = (hq.locations ?? []).reduce((a: Record<string, number>, l: any) => ({ ...a, [l.payer]: (a[l.payer] ?? 0) + 1 }), {});
      return { view: 'hq', plan: hq.plan, interval: hq.interval, status: hq.status, trial: hq.trial ? { daysLeft: hq.trial.daysLeft, endsAt: hq.trial.endsAt } : null, nextChargeAt: hq.nextChargeAt, cancelAtPeriodEnd: !!hq.cancelAtPeriodEnd, total: hq.hqTotal, locations: (hq.locations ?? []).length, payers, pendingChange: hq.pendingChange ?? null, provider: hq.provider };
    }
    const fr = await ifAllowed(ctx.api.get(ctx.o('/franchisee-billing')));
    if (fr) return { view: 'franchisee', plan: fr.plan, interval: fr.interval, status: fr.hqStatus, locations: (fr.locations ?? []).map((l: any) => ({ name: l.name, payer: l.payer, franchiseePercent: l.franchiseePercent, amountMinor: l.amount?.amount ?? 0, currency: l.amount?.currency ?? null })), invoices: (fr.invoices ?? []).length };
    return { view: 'none' };
  },
  present: (r, _i, ctx) => {
    if (r.view === 'none') return { summary: 'Billing is managed by the business owner; you don’t have access to it.' };
    if (r.view === 'franchisee') {
      return {
        summary: `${r.plan} plan (${r.interval}ly), ${r.status}. Your locations: ${r.locations.map((l: any) => `${l.name}: ${l.payer === 'hq' ? 'paid by HQ' : `${l.franchiseePercent}% paid by you (${fmtMoney(l.amountMinor, l.currency, ctx.locale)})`}`).join('; ')}.`,
        blocks: r.locations.length ? [table('Location fees', [{ key: 'name', label: 'Location' }, { key: 'payer', label: 'Paid by', kind: 'status' }, { key: 'franchiseePercent', label: 'Your share %', kind: 'percent' }, { key: 'amountMinor', label: 'Amount', kind: 'money' }], r.locations, { currencyKey: 'currency' })] : [],
        citations: [{ id: 'fbilling', title: 'Franchisee billing', url: '/franchisee-billing', sourceType: 'screen' }],
      };
    }
    return {
      summary: `${r.plan} plan (${r.interval}ly), status ${String(r.status).replace(/_/g, ' ')}${r.trial?.daysLeft !== null && r.trial?.daysLeft !== undefined ? `, ${r.trial.daysLeft} trial day(s) left` : ''}${r.nextChargeAt ? `, next charge ${String(r.nextChargeAt).slice(0, 10)}` : ''}${r.total ? `, ${fmtMoney(r.total.amount, r.total.currency, ctx.locale)} per ${r.total.interval}` : ''}${r.cancelAtPeriodEnd ? ', cancels at the end of the period' : ''}. ${r.locations} location(s): ${Object.entries(r.payers).map(([k, v]) => `${v} paid by ${k === 'hq' ? 'HQ' : k}`).join(', ')}. Plan changes are made in Settings → Billing.`,
      citations: [{ id: 'billing', title: 'Billing', url: '/settings/billing', sourceType: 'screen' }],
    };
  },
});

export default [listBrands, brandComparison, planStatus];

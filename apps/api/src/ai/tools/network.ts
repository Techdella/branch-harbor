import { z } from 'zod';
import { ROLES } from '@bh/shared';
import { defineTool, ToolError } from '../types.ts';
import { barCharts, fmtMoney, itemsOf, PERIOD_KEYS, periodRange, table } from '../present.ts';
import { countBy, plural, resolveLocation } from './_helpers.ts';

const period = z.enum(PERIOD_KEYS).default('last_month').describe('Named period; comparisons use the period before it');

const listLocations = defineTool({
  name: 'list_locations',
  kind: 'read',
  area: 'network',
  modules: ['network.locations'],
  description: 'Locations the person can see: name, code, city, country, status (operating, opening_soon, onboarding, paused, closed), currency and time zone. Optional status filter.',
  input: z.object({ status: z.enum(['operating', 'opening_soon', 'onboarding', 'paused', 'closed']).optional() }),
  run: (ctx, i) => ctx.api.get(ctx.o('/locations'), { status: i.status }),
  present: (r) => {
    const items = itemsOf(r);
    const by = countBy(items, (l) => l.status);
    return {
      summary: `${plural(items.length, 'location')} (${Object.entries(by).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}).`,
      blocks: [table('Locations', [{ key: 'name', label: 'Location' }, { key: 'code', label: 'Code' }, { key: 'city', label: 'City' }, { key: 'country', label: 'Country' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'currency', label: 'Currency' }],
        items.map((l) => ({ name: l.name, code: l.code, city: l.address?.city ?? null, country: l.country, status: l.status, currency: l.currency })))],
    };
  },
});

interface LeagueRow { locationId: string; name: string; currency: string; revenueMinor: number | null; previousRevenueMinor: number | null; growthPct: number | null; activity: number; occupancyPct: number | null; auditScorePct: number | null; royaltyStatus: string | null; reviewRating: number | null; rank: number; rankOf: number; regionName: string | null }

const leagueTable = defineTool({
  name: 'league_table',
  kind: 'read',
  area: 'network',
  modules: ['network.league_table'],
  networkOnly: true,
  description: 'Locations ranked for a period by revenue (per currency), growth, activity (bookings/orders), occupancy, audit score, royalty status or review rating, with anonymised network quartiles. Franchise owners only see their own locations. Revenue is only shown where the person has payments access.',
  input: z.object({ period, sort: z.enum(['revenue', 'growth', 'activity', 'occupancy', 'auditScore', 'royaltyStatus', 'reviewRating']).default('revenue') }),
  async run(ctx, i) {
    const p = periodRange(i.period);
    return { ...(await ctx.api.get(ctx.o('/league-table'), { from: p.from, to: p.to, sort: i.sort })), periodLabel: p.label };
  },
  present: (r: { rows: LeagueRow[]; periodLabel: string }, i) => {
    const rows = r.rows ?? [];
    return {
      summary: `${plural(rows.length, 'location')} ranked by ${i.sort} for ${r.periodLabel}.${rows[0] ? ` Top: ${rows[0].name}.` : ''}`,
      blocks: [table(`League table: ${r.periodLabel}`, [
        { key: 'rank', label: '#', kind: 'number' }, { key: 'name', label: 'Location' }, { key: 'revenueMinor', label: 'Revenue', kind: 'money' }, { key: 'growthPct', label: 'Growth %', kind: 'percent' },
        { key: 'activity', label: 'Activity', kind: 'number' }, { key: 'auditScorePct', label: 'Audit %', kind: 'percent' }, { key: 'royaltyStatus', label: 'Royalties', kind: 'status' }, { key: 'reviewRating', label: 'Rating', kind: 'number' },
      ], rows.map((x) => ({ ...x, rank: x.rank || null })), { currencyKey: 'currency', note: i.sort === 'revenue' ? 'Revenue ranks per currency; amounts are never combined across currencies.' : undefined })],
      citations: [{ id: 'league', title: 'League table', url: '/league-table', sourceType: 'screen' }],
    };
  },
});

const revenueByLocation = defineTool({
  name: 'revenue_by_location',
  kind: 'read',
  area: 'network',
  modules: ['network.league_table'],
  networkOnly: true,
  description: 'Revenue per location for a period compared with the previous period of the same length (e.g. this quarter vs last quarter), in each location’s own currency. Use for "revenue by location", "sales this quarter vs last". Amounts are minor units; never add different currencies together.',
  input: z.object({ period: period.default('this_quarter') }),
  async run(ctx, i) {
    const p = periodRange(i.period);
    const r = await ctx.api.get(ctx.o('/league-table'), { from: p.from, to: p.to, sort: 'revenue' });
    return { periodLabel: p.label, period: r.period, rows: (r.rows as LeagueRow[]).map((x) => ({ locationId: x.locationId, name: x.name, currency: x.currency, revenueMinor: x.revenueMinor, previousRevenueMinor: x.previousRevenueMinor, growthPct: x.growthPct })) };
  },
  present: (r: { periodLabel: string; period: { previousFrom: string; previousTo: string }; rows: Array<{ name: string; currency: string; revenueMinor: number | null; previousRevenueMinor: number | null; growthPct: number | null }> }, _i, ctx) => {
    const visible = r.rows.filter((x) => x.revenueMinor !== null);
    if (!visible.length) return { summary: 'Revenue is not part of your access for these locations.' };
    const byCur = [...new Set(visible.map((x) => x.currency))];
    const totals = byCur.map((c) => {
      const rs = visible.filter((x) => x.currency === c);
      const now = rs.reduce((a, x) => a + (x.revenueMinor ?? 0), 0);
      const prev = rs.reduce((a, x) => a + (x.previousRevenueMinor ?? 0), 0);
      return `${c}: ${fmtMoney(now, c, ctx.locale)} vs ${fmtMoney(prev, c, ctx.locale)} before${prev ? ` (${now >= prev ? '+' : ''}${Math.round(((now - prev) / prev) * 1000) / 10}%)` : ''}`;
    });
    const down = visible.filter((x) => (x.growthPct ?? 0) < 0).sort((a, b) => (a.growthPct ?? 0) - (b.growthPct ?? 0));
    return {
      summary: `Revenue for ${r.periodLabel} by currency: ${totals.join('; ')}.${down.length ? ` Down most: ${down.slice(0, 3).map((x) => `${x.name} (${x.growthPct}%)`).join(', ')}.` : ''}`,
      blocks: [
        table(`Revenue by location: ${r.periodLabel} vs previous period`, [
          { key: 'name', label: 'Location' }, { key: 'revenueMinor', label: 'This period', kind: 'money' }, { key: 'previousRevenueMinor', label: 'Previous period', kind: 'money' }, { key: 'growthPct', label: 'Change %', kind: 'percent' },
        ], visible, { currencyKey: 'currency', note: 'Each amount is in the location’s own currency; currencies are never added together.' }),
        ...barCharts('Revenue by location', visible.map((x) => ({ label: x.name, value: x.revenueMinor, previous: x.previousRevenueMinor, currency: x.currency })), { unit: 'money', seriesName: 'This period', previousName: 'Previous period' }),
      ],
      citations: [{ id: 'league', title: 'League table (payments in BranchHarbor)', url: '/league-table', sourceType: 'screen' }],
    };
  },
});

const listApprovals = defineTool({
  name: 'list_approvals',
  kind: 'read',
  area: 'network',
  modules: ['network.approvals'],
  description: 'Requests waiting for a decision (refunds over the limit, local ad spend, shift swaps, website changes) that the person can see.',
  input: z.object({}),
  run: (ctx) => ctx.api.get(ctx.o('/approvals')),
  present: (r) => {
    const items = itemsOf(r).filter((a) => a.status === 'pending');
    return {
      summary: items.length ? `${plural(items.length, 'request')} waiting: ${items.slice(0, 5).map((a) => a.title).join('; ')}.` : 'No pending approvals.',
      blocks: items.length ? [table('Waiting for a decision', [{ key: 'title', label: 'Request' }, { key: 'kind', label: 'Type' }, { key: 'location', label: 'Location' }, { key: 'amountMinor', label: 'Amount', kind: 'money' }, { key: 'createdAt', label: 'Requested', kind: 'date' }],
        items.map((a) => ({ title: a.title, kind: a.kindLabel ?? a.kind, location: a.location?.name ?? null, amountMinor: a.amountMinor, currency: a.currency, createdAt: a.createdAt })), { currencyKey: 'currency' })] : [],
      citations: [{ id: 'approvals', title: 'Approvals', url: '/approvals', sourceType: 'screen' }],
    };
  },
});

const listProjects = defineTool({
  name: 'list_new_location_projects',
  kind: 'read',
  area: 'network',
  modules: ['network.onboarding'],
  networkOnly: true,
  description: 'New-location onboarding projects: target opening date, checklist progress, pre-opening checks and whether go-live can be requested.',
  input: z.object({}),
  run: (ctx) => ctx.api.get(ctx.o('/franchise/projects')),
  present: (r) => {
    const items = itemsOf(r);
    return {
      summary: items.length ? `${plural(items.length, 'opening project')}: ${items.map((p) => `${p.name} (target ${p.targetOpenDate ?? 'not set'})`).join('; ')}.` : 'No new-location projects.',
      blocks: items.length ? [table('New locations', [{ key: 'name', label: 'Project' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'targetOpenDate', label: 'Target opening', kind: 'date' }, { key: 'progress', label: 'Progress' }],
        items.map((p) => ({ name: p.name, status: p.status, targetOpenDate: p.targetOpenDate, progress: p.progress ? `${p.progress.done ?? p.progress.completed ?? '?'}/${p.progress.total ?? '?'}` : null })))] : [],
    };
  },
});

const listPeople = defineTool({
  name: 'list_people',
  kind: 'read',
  area: 'network',
  modules: ['settings.team'],
  description: 'People in the organisation the person can see in Team & access, with their roles and scopes.',
  input: z.object({ query: z.string().max(80).optional().describe('Filter by name') }),
  run: (ctx) => ctx.api.get(ctx.o('/members')),
  present: (r, i) => {
    const q = i.query?.toLocaleLowerCase();
    const items = itemsOf(r).filter((m) => !q || String(m.user?.name ?? '').toLocaleLowerCase().includes(q));
    return {
      summary: `${plural(items.length, 'person', 'people')}.`,
      blocks: [table('People', [{ key: 'name', label: 'Name' }, { key: 'roles', label: 'Roles' }],
        items.map((m) => ({ name: m.user?.name ?? null, roles: (m.assignments ?? []).map((a: { roleName: string; scope: { name: string | null; kind: string } }) => `${a.roleName} · ${a.scope?.name ?? a.scope?.kind}`).join('; ') })))],
    };
  },
});

const invitePerson = defineTool({
  name: 'invite_person',
  kind: 'write',
  area: 'network',
  modules: ['settings.team'],
  risk: 'outbound',
  description: 'Invite someone by email with a role at the organisation or at one location (sends an invitation email once confirmed). You can only grant access the person themselves holds.',
  input: z.object({ email: z.email(), role: z.enum(ROLES), location: z.string().max(120).optional().describe('Location name or id; omit for organisation-wide') }),
  async preview(ctx, i) {
    const loc = await resolveLocation(ctx, i.location);
    return {
      title: `Invite ${i.email} as ${i.role.replace(/_/g, ' ')}`,
      summary: loc ? `At ${loc.name}` : 'Organisation-wide',
      details: [{ label: 'Email', value: i.email }, { label: 'Role', value: i.role }, { label: 'Scope', value: loc ? loc.name : ctx.org.name }],
      link: '/team',
    };
  },
  async execute(ctx, i) {
    const loc = await resolveLocation(ctx, i.location);
    const scope = loc ? { kind: 'location', id: loc.id } : { kind: 'organization', id: ctx.orgId };
    if (i.role === 'customer') throw new ToolError('validation_failed', 'Customers cannot be invited to the team.');
    const r = await ctx.api.post(ctx.o('/invitations'), { email: i.email, role: i.role, scope });
    return { result: { invitationId: r.id ?? null }, link: '/team' };
  },
});

export default [listLocations, leagueTable, revenueByLocation, listApprovals, listProjects, listPeople, invitePerson];

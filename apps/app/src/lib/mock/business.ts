/**
 * Sample-data behaviour for independent businesses: the `business` API namespace and the few shared endpoints
 * that look different for a single-location business (team, settings, payment accounts, reports, AI scope).
 */
import { SOLO_PLAN, UPGRADE_CONSEQUENCES, LIST_PRICES_MINOR, type Currency } from '@bh/shared';
import type { BranchHarborApi } from '../api';
import { ApiError } from '../errors';
import type { BusinessApi, BusinessLocation, SiteStatus, WebsiteApprovalMode } from '../business';
import type { IndustryKey, Member, OrgSettings, Report, RequestContext } from '../types';
import { addDays, dateInZone } from '../format';
import { INDEPENDENT } from './independent';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();
const isIndependent = (ctx: RequestContext | undefined) => ctx?.business === 'independent';

interface BizState {
  location: BusinessLocation;
  approvals: WebsiteApprovalMode;
  site: SiteStatus;
  settings?: OrgSettings;
  team: Member[];
}
const state = new Map<IndustryKey, BizState>();

function priced(c: Currency) {
  return (SOLO_PLAN.priceMinor as Record<string, number>)[c] ?? null;
}

function st(ind: IndustryKey): BizState {
  let s = state.get(ind);
  if (!s) {
    const f = INDEPENDENT[ind];
    const l = f.location;
    s = {
      location: {
        id: l.id, name: f.org.name, line1: l.address.line1, city: l.address.city, region: l.address.region ?? '', postalCode: l.address.postalCode ?? '', country: l.address.country,
        timeZone: l.timeZone, currency: l.currency, phone: l.phone, email: `hello@${f.org.name.toLowerCase().replace(/[^a-z]+/g, '')}.example`, hours: l.hours, status: 'operating', publiclyVisible: true,
      },
      approvals: 'off',
      site: { address: `https://sites.branchharbor.com/${f.org.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, exists: true, published: true, publishedAt: new Date(Date.now() - 3 * 86400_000).toISOString(), version: 4, visible: true },
      team: [
        { id: 'mem_owner', name: f.owner, email: 'owner@…', assignments: [{ role: 'Owner', scopeLabel: f.org.name }], lastActive: 'Now', status: 'active' },
        { id: 'mem_staff', name: FIXTURES_STAFF[ind], email: 'staff@…', assignments: [{ role: 'Staff', scopeLabel: f.org.name }], lastActive: 'Yesterday', status: 'active' },
        { id: 'mem_inv', name: 'new.hire@…', email: 'new.hire@…', assignments: [{ role: 'Manager', scopeLabel: f.org.name }], lastActive: 'Invitation sent 2 days ago', status: 'invited' },
      ],
    };
    state.set(ind, s);
  }
  return s;
}
const FIXTURES_STAFF: Record<IndustryKey, string> = { studios: 'Theo Marsh', sports: 'Coach Ortiz', wellness: 'Tom Becker', commerce: 'Kim Lau', foods: 'Mei Lin', realty: 'Nadia Hassan' };

export const mockBusiness: BusinessApi = {
  location: async (ctx) => (await sleep(200), clone(st(ctx.industry).location)),
  saveLocation: async (ctx, input) => {
    await sleep(500);
    const s = st(ctx.industry);
    if (input.line1 !== undefined && !input.line1.trim()) throw new ApiError('validation_error', 'Check the highlighted fields.', 422, { line1: 'Enter the street address.' });
    s.location = { ...s.location, ...input };
    return clone(s.location);
  },
  billing: async (ctx) => {
    await sleep(200);
    const c = INDEPENDENT[ctx.industry].org.defaultCurrency;
    const amount = priced(c);
    return { plan: { key: 'solo', name: 'Solo', pricing: 'flat', price: amount != null ? { amount, currency: c, interval: 'month' } : null }, status: 'active', periodEnd: addDays(dateInZone(new Date(), 'UTC'), 17) };
  },
  approvals: async (ctx) => (await sleep(100), st(ctx.industry).approvals),
  setApprovals: async (ctx, mode) => (await sleep(300), (st(ctx.industry).approvals = mode)),
  upgradePreview: async (ctx) => {
    await sleep(250);
    const c = INDEPENDENT[ctx.industry].org.defaultCurrency;
    const solo = priced(c);
    const per = (LIST_PRICES_MINOR as Record<string, { network: number }>)[c]?.network ?? null;
    return {
      canUpgrade: true, consequences: [...UPGRADE_CONSEQUENCES], locationCount: 1,
      currentPlan: { key: 'solo', name: 'Solo', pricing: 'flat', price: solo != null ? { amount: solo, currency: c, interval: 'month' } : null },
      nextPlan: { key: 'network', name: 'Network', pricing: 'per_location', price: per != null ? { amount: per, currency: c, interval: 'month' } : null },
    };
  },
  upgrade: async (_ctx, input) => {
    await sleep(900);
    if (input.location && (!input.location.name.trim() || !input.location.line1.trim() || !input.location.city.trim())) {
      throw new ApiError('validation_error', 'Check the highlighted fields.', 422, { ...(!input.location.name.trim() ? { name: 'Enter a name.' } : {}), ...(!input.location.line1.trim() ? { line1: 'Enter the street address.' } : {}), ...(!input.location.city.trim() ? { city: 'Enter the city.' } : {}) });
    }
    return { upgraded: true, locationId: input.location ? `loc_${Date.now()}` : null };
  },
  site: async (ctx) => (await sleep(200), clone(st(ctx.industry).site)),
  publish: async (ctx) => {
    await sleep(900);
    const s = st(ctx.industry);
    s.site = { ...s.site, exists: true, published: true, publishedAt: now(), version: s.site.version + 1, visible: true };
    return clone(s.site);
  },
};

/** Wraps the sample API so independent-business requests get single-location answers. */
export function withIndependent(api: Omit<BranchHarborApi, 'business'>): BranchHarborApi {
  const only = <A extends unknown[], R>(fn: (...a: A) => Promise<R>, alt: (...a: A) => Promise<R>) => (...a: A) => (isIndependent(a[0] as RequestContext) ? alt(...a) : fn(...a));
  return {
    ...api,
    org: only(api.org, async (ctx) => (await sleep(120), clone(INDEPENDENT[ctx.industry].org))),
    locations: only(api.locations, async (ctx) => {
      await sleep(150);
      const { revenue7d: _r, ...l } = INDEPENDENT[ctx.industry].location;
      return [clone(l)];
    }),
    search: only(api.search, async (ctx, q) => (await api.search(ctx, q)).filter((g) => g.type !== 'Locations')),
    team: {
      ...api.team,
      members: only(api.team.members, async (ctx) => (await sleep(250), clone(st(ctx.industry).team))),
    },
    payments: {
      ...api.payments,
      accounts: only(api.payments.accounts, async (ctx) => {
        await sleep(200);
        const l = INDEPENDENT[ctx.industry].location;
        return [{ locationId: l.id, provider: ctx.industry === 'commerce' ? 'WooCommerce gateway' : 'Stripe Connect', arrangement: 'shared' as const, status: 'enabled' as const, capabilities: ['Card payments', 'Refunds', ...(l.currency === 'EUR' ? ['SEPA debit'] : [])] }];
      }),
    },
    reports: only(api.reports, async (ctx) => {
      const name = INDEPENDENT[ctx.industry].org.name;
      return (await api.reports(ctx))
        .filter((r: Report) => r.id !== 'cmb')
        .map((r: Report) => ({ ...r, title: r.title.replace(/ by location/i, ''), bars: r.bars.slice(0, 1).map((b) => ({ ...b, label: name })) }));
    }),
    settings: {
      get: only(api.settings.get, async (ctx) => {
        await sleep(250);
        const f = INDEPENDENT[ctx.industry];
        const s = st(ctx.industry);
        s.settings ??= {
          businessName: f.org.name, legalName: `${f.org.name} (sample)`, defaultLocale: f.org.defaultLocale, defaultCurrency: f.org.defaultCurrency, defaultTimeZone: f.org.defaultTimeZone, dataRegion: f.org.dataRegion,
          customerSharing: 'off', aiTraining: false,
          billing: { plan: 'Solo', perLocation: null, locations: [{ locationId: f.location.id, status: 'billed' }], nextInvoice: addDays(dateInZone(new Date(), 'UTC'), 17) },
        };
        return clone(s.settings);
      }),
      save: only(api.settings.save, async (ctx, input) => {
        await sleep(500);
        const s = st(ctx.industry);
        s.settings = { ...s.settings!, ...input };
        return clone(s.settings);
      }),
    },
    ai: {
      ...api.ai,
      ask: only(api.ai.ask, async (ctx, q) => {
        const a = await api.ai.ask(ctx, q);
        const name = INDEPENDENT[ctx.industry].org.name;
        return { ...a, assumptions: a.assumptions?.replace(/Scope: .*\.$/, `Scope: ${name}.`), action: a.action ? { ...a.action, affected: [name], excluded: [] } : undefined };
      }),
    },
    business: mockBusiness,
  };
}

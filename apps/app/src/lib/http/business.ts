/**
 * Live `business` API for independent (single-location) businesses:
 *   GET/PATCH /orgs/:id/locations/:locationId   — Settings → Business & location
 *   GET /orgs/:id/subscription                  — Solo plan
 *   GET/PATCH /orgs/:id (websiteApprovals)      — owner-controlled website approvals
 *   GET/POST /orgs/:id/upgrade-to-network       — the upgrade path (or POST /locations with upgradeToNetwork)
 *   POST /websites, /pages/:id/publish          — the single "Publish" flow
 */
import type { Currency } from '@bh/shared';
import { ApiError } from '../errors';
import type { BusinessApi, BusinessLocation, PlanInfo, SiteStatus, WebsiteApprovalMode } from '../business';
import { http } from './client';
import { orgId, refreshWorkspace, workspace, type ApiLocation } from './workspace';

const o = (path = '') => `/orgs/${orgId()}${path}`;

function primaryLocationId(): string {
  const w = workspace();
  const id = w?.orgs.find((x) => x.id === w.org?.id)?.primaryLocationId ?? w?.locations[0]?.id;
  if (!id) throw new ApiError('no_location', 'Add your business address first (Settings → Business & location).', 409);
  return id;
}

type ApiLoc = ApiLocation & { email: string | null; address: { line1?: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string } };

function toBusinessLocation(l: ApiLoc): BusinessLocation {
  return {
    id: l.id, name: l.name, line1: l.address?.line1 ?? '', city: l.address?.city ?? '', region: l.address?.region ?? '', postalCode: l.address?.postalCode ?? '',
    country: l.address?.country ?? l.country, timeZone: l.timeZone, currency: l.currency, phone: l.phone ?? '', email: l.email ?? '',
    hours: l.hours?.summary ?? '', status: l.status, publiclyVisible: !!l.publiclyVisible,
  };
}

interface ApiPlan { key: string; name: string; pricing: 'flat' | 'per_location'; price: { amount: number; currency: Currency; interval: string } | null }
const plan = (p: ApiPlan): PlanInfo => ({ key: p.key, name: p.name, pricing: p.pricing, price: p.price });

async function homePage(locationId: string): Promise<{ siteId: string; address: string; pageId: string } | null> {
  const w = workspace();
  const site = w?.websites.find((x) => x.locationId === locationId);
  if (!site) return null;
  const pages = await http.get<{ items: { id: string; slug: string }[] }>(o(`/websites/${site.id}/pages`));
  const home = pages.items.find((p) => p.slug === 'home') ?? pages.items[0];
  return home ? { siteId: site.id, address: site.includedAddress, pageId: home.id } : null;
}

async function siteStatus(): Promise<SiteStatus> {
  const locId = primaryLocationId();
  const [loc, home] = await Promise.all([http.get<ApiLoc>(o(`/locations/${locId}`)), homePage(locId)]);
  if (!home) return { address: '', exists: false, published: false, publishedAt: null, version: 0, visible: !!loc.publiclyVisible };
  const [page, versions] = await Promise.all([
    http.get<{ publishedAt: string | null; status: string }>(o(`/pages/${home.pageId}`)),
    http.get<{ items: { version: number }[] }>(o(`/pages/${home.pageId}/versions`)),
  ]);
  return { address: home.address, exists: true, published: !!page.publishedAt, publishedAt: page.publishedAt, version: versions.items[0]?.version ?? 0, visible: !!loc.publiclyVisible };
}

export const httpBusiness: BusinessApi = {
  location: async () => toBusinessLocation(await http.get<ApiLoc>(o(`/locations/${primaryLocationId()}`))),
  saveLocation: async (_ctx, input) => {
    const id = primaryLocationId();
    const current = await http.get<ApiLoc>(o(`/locations/${id}`));
    const addr = { ...current.address };
    const addressChanged = ['line1', 'city', 'region', 'postalCode', 'country'].some((k) => k in input);
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.timeZone !== undefined) body.timeZone = input.timeZone;
    if (input.currency !== undefined) body.currency = input.currency;
    if (input.phone !== undefined) body.phone = input.phone || null;
    if (input.email !== undefined) body.email = input.email || null;
    if (input.hours !== undefined) body.hours = { ...(current.hours ?? {}), summary: input.hours };
    if (addressChanged) {
      body.address = {
        line1: input.line1 ?? addr.line1 ?? '', city: input.city ?? addr.city ?? '', country: (input.country ?? addr.country ?? current.country).toUpperCase(),
        ...((input.region ?? addr.region) ? { region: input.region ?? addr.region } : {}),
        ...((input.postalCode ?? addr.postalCode) ? { postalCode: input.postalCode ?? addr.postalCode } : {}),
        ...(addr.line2 ? { line2: addr.line2 } : {}),
      };
    }
    const saved = await http.patch<ApiLoc>(o(`/locations/${id}`), body);
    await refreshWorkspace();
    return toBusinessLocation(saved);
  },
  billing: async () => {
    const s = await http.get<{ planDetails?: ApiPlan; plan: string; status: string; currentPeriodEnd: string | null }>(o('/subscription'));
    return { plan: s.planDetails ? plan(s.planDetails) : { key: s.plan, name: s.plan, pricing: 'per_location', price: null }, status: s.status, periodEnd: s.currentPeriodEnd };
  },
  approvals: async () => (await http.get<{ businessMode?: { websiteApprovals: string } }>(o())).businessMode?.websiteApprovals === 'staff' ? 'staff' : 'off',
  setApprovals: async (_ctx, mode) => {
    const r = await http.patch<{ businessMode?: { websiteApprovals: string } }>(o(), { websiteApprovals: mode });
    return (r.businessMode?.websiteApprovals === 'staff' ? 'staff' : 'off') as WebsiteApprovalMode;
  },
  upgradePreview: async () => {
    const r = await http.get<{ canUpgrade: boolean; consequences: string[]; locationCount: number; currentPlan: ApiPlan | null; nextPlan: ApiPlan }>(o('/upgrade-to-network'));
    return { canUpgrade: r.canUpgrade, consequences: r.consequences, locationCount: r.locationCount, currentPlan: r.currentPlan ? plan(r.currentPlan) : null, nextPlan: plan(r.nextPlan) };
  },
  upgrade: async (_ctx, input) => {
    let locationId: string | null = null;
    if (input.location) {
      const l = input.location;
      const created = await http.post<{ id: string }>(o('/locations'), {
        name: l.name, code: l.code, address: { line1: l.line1, city: l.city, ...(l.region ? { region: l.region } : {}), ...(l.postalCode ? { postalCode: l.postalCode } : {}), country: l.country },
        timeZone: l.timeZone, currency: l.currency, upgradeToNetwork: true,
      });
      locationId = created.id;
    } else {
      await http.post(o('/upgrade-to-network'), { confirm: true, ...(input.reason ? { reason: input.reason } : {}) });
    }
    // The caller reloads the workspace when the owner leaves the confirmation (the app then shows network tools).
    return { upgraded: true, locationId };
  },
  site: async () => siteStatus(),
  publish: async () => {
    const locId = primaryLocationId();
    let home = await homePage(locId);
    if (!home) {
      await http.post(o('/websites'), { locationId: locId, kind: 'hosted' });
      await refreshWorkspace();
      home = await homePage(locId);
    }
    if (!home) throw new ApiError('not_found', 'Your website could not be created. Try again.', 404);
    await http.post(o(`/pages/${home.pageId}/publish`));
    const loc = await http.get<ApiLoc>(o(`/locations/${locId}`));
    // Publishing an independent business makes it visible to customers (a network adds locations without publishing).
    if (!loc.publiclyVisible || !['operating', 'opening_soon'].includes(loc.status)) {
      await http.patch(o(`/locations/${locId}`), { publiclyVisible: true, status: loc.status === 'opening_soon' ? 'opening_soon' : 'operating' });
    }
    await refreshWorkspace();
    return siteStatus();
  },
};

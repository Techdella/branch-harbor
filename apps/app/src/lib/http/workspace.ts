/**
 * Live workspace: who is signed in, which organisation is selected, and the organisation's directory
 * (locations, regions, owner groups, websites, connections), all loaded from the API and adapted to the
 * app's view models. `AppContext` drives it; `httpApi` reads it to scope requests.
 */
import type { AccessSummary, Currency, Role, RoleAssignment } from '@bh/shared';
import { ApiError } from '../errors';
import type { IndustryKey, Location, Organization, ScopeOptionT, Session, ViewRole } from '../types';
import { APP_INDUSTRIES } from '../types';
import { http } from './client';

/* ---------------- API shapes (subset of /docs/json) ---------------- */

export interface ApiScope {
  kind: 'organization' | 'brand' | 'territory' | 'region' | 'portfolio' | 'owner_group' | 'location';
  id: string;
}
export interface ApiUser {
  id: string;
  email: string;
  name: string;
  locale: string;
  emailVerified: boolean;
}
export interface ApiMeOrg {
  id: string;
  name: string;
  slug: string;
  industry: string;
  /** Business mode (API ≥ independent-business support); absent on older APIs = network. */
  model?: 'independent' | 'network';
  isSingleLocation?: boolean;
  primaryLocationId?: string | null;
  roles: { id: string; role: string; customRoleId?: string | null; name?: string; label?: string | null; scope: ApiScope }[];
  /** What this person sees in the organisation (workspaces, landing workspace, capabilities). */
  access?: AccessSummary;
}
export interface ApiOrg {
  id: string;
  slug: string;
  name: string;
  industry: string;
  model: string;
  country: string;
  defaultCurrency: Currency;
  defaultLocale: string;
  defaultTimeZone: string;
  dataRegion: 'us' | 'eu' | 'apac';
  paymentAccountMode: string;
  myOrgPermissions?: string[];
}
export interface ApiLocation {
  id: string;
  regionId: string | null;
  ownerGroupId: string | null;
  name: string;
  code?: string;
  slug: string;
  address: { line1?: string; city?: string; region?: string; postalCode?: string; country?: string };
  country: string;
  timeZone: string;
  currency: Currency;
  locale: string;
  phone: string | null;
  status: string;
  publiclyVisible?: boolean;
  hours: { summary?: string } | null;
  templateId?: string | null;
  paymentsEnabled?: boolean;
}
export interface ApiNamed {
  id: string;
  name: string;
}
export interface ApiWebsite {
  id: string;
  locationId: string | null;
  kind: string;
  templateId: string | null;
  includedAddress: string;
  primaryDomainId: string | null;
  status: string;
}
export interface ApiConnection {
  id: string;
  locationId: string | null;
  provider: string;
  kind: string;
  direction: 'import' | 'export' | 'bidirectional';
  authoritative: string;
  state: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  mappingErrors?: number;
}

/* ---------------- state ---------------- */

export interface Workspace {
  user: ApiUser;
  orgs: ApiMeOrg[];
  org: ApiOrg | null;
  orgView: Organization | null;
  /** All roles the user holds in the selected organisation. */
  assignments: (RoleAssignment & { id: string })[];
  locations: Location[];
  regions: ApiNamed[];
  ownerGroups: ApiNamed[];
  websites: ApiWebsite[];
  connections: ApiConnection[];
  templates: ApiNamed[];
}

let ws: Workspace | null = null;
const listeners = new Set<(w: Workspace | null) => void>();

export function workspace(): Workspace | null {
  return ws;
}
export function onWorkspace(fn: (w: Workspace | null) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  listeners.forEach((l) => l(ws));
}
export function clearWorkspace() {
  ws = null;
  emit();
}

/** The selected organisation id, or a clear error when the user has none yet. */
export function orgId(): string {
  if (!ws?.org) throw new ApiError('no_organization', 'Finish setting up your business to use this screen.', 409);
  return ws.org.id;
}

const PASTELS = ['#E9DDF8', '#F7EDA8', '#CDEEEE', '#F8D6D8', '#D4E6D9', '#E2F5A6', '#EFE3D3'];

function asIndustry(v: string): IndustryKey {
  return (APP_INDUSTRIES as readonly string[]).includes(v) ? (v as IndustryKey) : 'studios';
}

function toLocation(l: ApiLocation, i: number, ctx: { websites: ApiWebsite[]; connections: ApiConnection[]; templates: ApiNamed[]; ownerGroups: ApiNamed[] }): Location {
  const site = ctx.websites.find((w) => w.locationId === l.id);
  const conns = ctx.connections.filter((c) => c.locationId === l.id || c.locationId === null);
  const tpl = ctx.templates.find((t) => t.id === (site?.templateId ?? l.templateId));
  return {
    id: l.id,
    code: l.code ?? l.slug.toUpperCase(),
    name: l.name,
    address: { line1: l.address?.line1 ?? '', city: l.address?.city ?? '', region: l.address?.region, postalCode: l.address?.postalCode, country: l.address?.country ?? l.country },
    regionId: l.regionId ?? '',
    ownerGroupId: l.ownerGroupId ?? '',
    ownership: l.ownerGroupId ? 'franchise' : 'company',
    currency: l.currency,
    timeZone: l.timeZone,
    locale: l.locale,
    phone: l.phone ?? '',
    hours: l.hours?.summary ?? '',
    template: tpl?.name ?? (site ? 'Hosted site' : 'No website yet'),
    site: site?.status === 'live' ? 'live' : 'unpublished',
    sync: conns.some((c) => c.state !== 'connected' && c.state !== 'initial_sync') ? 'attention' : 'ok',
    pastel: PASTELS[i % PASTELS.length]!,
  };
}

const settle = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p;
  } catch (e) {
    // Permission-limited roles can't read every directory list; that's expected. Network errors propagate.
    if (e instanceof ApiError && (e.isNetwork || e.isUnauthenticated)) throw e;
    return fallback;
  }
};

async function loadDirectory(meOrg: ApiMeOrg): Promise<Omit<Workspace, 'user' | 'orgs'>> {
  const id = meOrg.id;
  const items = <T>(p: Promise<{ items: T[] }>) => settle(p.then((r) => r.items), [] as T[]);
  // Only ask for directory lists the person's modules cover (the API refuses the rest with 403).
  const caps = new Set(meOrg.access?.capabilities ?? []);
  const holds = (...mods: string[]) => !meOrg.access || mods.some((m) => caps.has(`${m}:view`));
  const none = <T>() => Promise.resolve([] as T[]);
  const [org, locs, regions, ownerGroups, websites, connections, templates] = await Promise.all([
    http.get<ApiOrg>(`/orgs/${id}`),
    items(http.get<{ items: ApiLocation[] }>(`/orgs/${id}/locations`)),
    items(http.get<{ items: ApiNamed[] }>(`/orgs/${id}/regions`)),
    items(http.get<{ items: ApiNamed[] }>(`/orgs/${id}/owner-groups`)),
    holds('marketing.website_builder', 'network.templates') ? items(http.get<{ items: ApiWebsite[] }>(`/orgs/${id}/websites`)) : none<ApiWebsite>(),
    holds('settings.connections') ? items(http.get<{ items: ApiConnection[] }>(`/orgs/${id}/connections`)) : none<ApiConnection>(),
    holds('marketing.website_builder', 'network.templates') ? items(http.get<{ items: ApiNamed[] }>(`/orgs/${id}/templates`)) : none<ApiNamed>(),
  ]);
  const assignments = meOrg.roles.map((r) => ({ id: r.id, role: r.role as Role, scope: r.scope }));
  // Roles without locations.read (e.g. staff) get an empty directory; fill their assigned locations from the
  // public location finder so names, currencies and time zones still show.
  const assignedLocIds = assignments.filter((a) => a.scope.kind === 'location').map((a) => a.scope.id);
  const missing = assignedLocIds.filter((lid) => !locs.some((l) => l.id === lid));
  if (missing.length) {
    const pub = await settle(http.get<{ items: ApiLocation[] }>(`/public/locations/${org.slug}`, undefined, { auth: false }), { items: [] });
    for (const p of pub.items) if (missing.includes(p.id)) locs.push({ ...p, regionId: null, ownerGroupId: null });
  }
  locs.sort((a, b) => a.name.localeCompare(b.name));
  const dir = { websites, connections, templates, ownerGroups };
  return {
    org,
    orgView: {
      id: org.id,
      name: org.name,
      brand: org.name,
      industry: asIndustry(org.industry),
      sample: false,
      defaultCurrency: org.defaultCurrency,
      defaultTimeZone: org.defaultTimeZone,
      defaultLocale: org.defaultLocale,
      dataRegion: org.dataRegion,
      regions,
      ownerGroups,
      model: org.model === 'independent' ? 'independent' : 'network',
    },
    assignments,
    locations: locs.map((l, i) => toLocation(l, i, dir)),
    regions,
    ownerGroups,
    websites,
    connections,
    templates,
  };
}

/** Loads /auth/me and the selected organisation's directory. Throws ApiError(401) when signed out. */
export async function loadWorkspace(preferredOrgId?: string | null): Promise<Workspace> {
  const me = await http.get<{ user: ApiUser; organizations: ApiMeOrg[] }>('/auth/me', undefined, { redirectOnAuthLoss: false });
  const pick = me.organizations.find((o) => o.id === preferredOrgId) ?? me.organizations[0];
  const empty = { org: null, orgView: null, assignments: [], locations: [], regions: [], ownerGroups: [], websites: [], connections: [], templates: [] };
  ws = { user: me.user, orgs: me.organizations, ...(pick ? await loadDirectory(pick) : empty) };
  emit();
  return ws;
}

/** Reloads the directory (e.g. after creating a location or fixing a connection). */
export async function refreshWorkspace(): Promise<Workspace | null> {
  if (!ws) return null;
  return loadWorkspace(ws.org?.id);
}

/* ---------------- roles, sessions and scopes ---------------- */

const LOCAL_ROLES: Role[] = ['hq_admin', 'field_consultant', 'area_representative', 'master_franchisee', 'area_developer', 'multi_unit_operator', 'franchise_owner', 'location_manager', 'content_social', 'finance_lead', 'accountant', 'sales_lead', 'sales_rep', 'auditor'];

export function viewRoleOf(a: RoleAssignment): ViewRole {
  if (a.scope.kind === 'organization') return 'hq';
  if (LOCAL_ROLES.includes(a.role) || (a.role as string) === 'custom') return 'local';
  return 'staff';
}

/** The person's broad persona: their widest assignment (there is no "Viewing as" switch — access is what they hold). */
export function effectiveRole(_requested?: ViewRole, w: Workspace | null = ws): ViewRole {
  const set = new Set((w?.assignments ?? []).map(viewRoleOf));
  return (['hq', 'local', 'staff'] as const).find((r) => set.has(r)) ?? 'staff';
}

/** Every assignment counts: scopes and sessions cover everything the person holds in the organisation. */
function assignmentsFor(_role: ViewRole, w: Workspace) {
  return w.assignments;
}

/** The selected organisation's access summary from /auth/me. */
export function orgAccess(w: Workspace | null = ws): AccessSummary {
  const o = w?.orgs.find((x) => x.id === w.org?.id);
  return o?.access ?? { capabilities: [], workspaces: [], settings: [], primaryWorkspace: null };
}

function coveredLocationIds(assignments: RoleAssignment[], w: Workspace): string[] {
  if (assignments.some((a) => a.scope.kind === 'organization')) return w.locations.map((l) => l.id);
  // Brand, territory and portfolio scopes are resolved by the API: the location directory it returns is already
  // limited to the locations this person may see.
  if (assignments.some((a) => a.scope.kind === 'brand' || a.scope.kind === 'territory' || a.scope.kind === 'portfolio')) return w.locations.map((l) => l.id);
  const ids = new Set<string>();
  for (const a of assignments)
    for (const l of w.locations)
      if ((a.scope.kind === 'region' && l.regionId === a.scope.id) || (a.scope.kind === 'owner_group' && l.ownerGroupId === a.scope.id) || (a.scope.kind === 'location' && l.id === a.scope.id)) ids.add(l.id);
  return [...ids];
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
}

export function sessionOf(role: ViewRole, w: Workspace): Session {
  const assignments = assignmentsFor(role, w);
  const orgWide = assignments.some((a) => a.scope.kind === 'organization');
  return {
    user: { id: w.user.id, name: w.user.name, email: w.user.email, initials: initials(w.user.name) },
    role,
    assignments: assignments.map(({ role: r, scope }) => ({ role: r, scope })),
    locationIds: orgWide ? [] : coveredLocationIds(assignments, w),
  };
}

export function scopeOptionsOf(role: ViewRole, w: Workspace): ScopeOptionT[] {
  const assignments = assignmentsFor(role, w);
  const visible = new Set(coveredLocationIds(assignments, w));
  const locs = w.locations.filter((l) => visible.has(l.id));
  const out: ScopeOptionT[] = [{ id: 'all', kind: 'all', label: 'All authorised locations', locationIds: locs.map((l) => l.id) }];
  const orgWide = assignments.some((a) => a.scope.kind === 'organization');
  const regionIds = orgWide ? w.regions.map((r) => r.id) : assignments.filter((a) => a.scope.kind === 'region').map((a) => a.scope.id);
  const groupIds = orgWide ? w.ownerGroups.map((g) => g.id) : assignments.filter((a) => a.scope.kind === 'owner_group').map((a) => a.scope.id);
  for (const r of w.regions.filter((x) => regionIds.includes(x.id))) {
    const li = locs.filter((l) => l.regionId === r.id).map((l) => l.id);
    if (li.length) out.push({ id: `region:${r.id}`, kind: 'region', label: r.name, locationIds: li });
  }
  for (const g of w.ownerGroups.filter((x) => groupIds.includes(x.id))) {
    const li = locs.filter((l) => l.ownerGroupId === g.id).map((l) => l.id);
    if (li.length) out.push({ id: `group:${g.id}`, kind: 'owner_group', label: g.name, locationIds: li });
  }
  for (const l of locs) out.push({ id: `loc:${l.id}`, kind: 'location', label: l.name, locationIds: [l.id] });
  return out;
}

/* ---------------- request scoping ---------------- */

let activeRole: ViewRole = 'hq';
/** Set by AppContext whenever the effective "Viewing as" persona changes. */
export function setActiveRole(r: ViewRole) {
  activeRole = r;
}
export function activeViewRole() {
  return activeRole;
}

export function scopeOption(scopeId: string, role: ViewRole = activeRole): ScopeOptionT {
  if (!ws) return { id: 'all', kind: 'all', label: 'All authorised locations', locationIds: [] };
  const opts = scopeOptionsOf(role, ws);
  return opts.find((o) => o.id === scopeId) ?? opts[0]!;
}

export function scopeLocationIds(scopeId: string, role: ViewRole = activeRole): string[] {
  return scopeOption(scopeId, role).locationIds;
}

/** Maps an app scope id to the API's `scopeKind`/`scopeId` (reports, AI). */
export function apiScope(scopeId: string, role: ViewRole = activeRole): ApiScope {
  const id = orgId();
  const [kind, value] = scopeId.split(':') as [string, string | undefined];
  if (kind === 'region' && value) return { kind: 'region', id: value };
  if (kind === 'group' && value) return { kind: 'owner_group', id: value };
  if (kind === 'loc' && value) return { kind: 'location', id: value };
  if ((kind === 'territory' || kind === 'portfolio' || kind === 'brand') && value) return { kind, id: value };
  // "All authorised locations": the org for org-wide roles, otherwise the persona's own assignment.
  const own = ws ? assignmentsFor(role, ws) : [];
  if (!own.length || own.some((a) => a.scope.kind === 'organization')) return { kind: 'organization', id };
  return own[0]!.scope as ApiScope;
}

export function locationById(id: string | null | undefined): Location | undefined {
  return ws?.locations.find((l) => l.id === id);
}

export function asIndustryKey(v: string): IndustryKey {
  return asIndustry(v);
}

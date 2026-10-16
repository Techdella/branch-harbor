import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { capabilitiesAnywhere, type Assignment } from '../domain/scope.ts';
import type { AccessAction } from '@bh/shared';
import type { Services } from '../context.ts';
import { brands, organizations, users } from '../db/schema/index.ts';
import { signAccessToken, type AuthUser } from '../plugins/auth.ts';
import { BRAND_FILTER_HEADER, capabilityLocations, hasCapability, loadAssignments, type ScopeTarget } from '../services/authz.ts';
import { ToolError } from './types.ts';

type Query = Record<string, string | number | boolean | null | undefined>;

export interface AssistantApi {
  get<T = any>(path: string, query?: Query): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  put<T = any>(path: string, body?: unknown): Promise<T>;
  patch<T = any>(path: string, body?: unknown): Promise<T>;
  delete<T = any>(path: string): Promise<T>;
}

/**
 * Everything a tool needs, for ONE person in ONE organisation. `api` calls the REST routes in-process with that
 * person's own access token, so the assistant can never see or do more than the person can in the app.
 */
export interface AssistantContext {
  s: Services;
  orgId: string;
  user: AuthUser & { name: string };
  locale: string;
  org: { id: string; name: string; industry: string; model: string; defaultCurrency: string; defaultTimeZone: string; defaultLocale: string; slug: string };
  /**
   * The brand filter the person has on in the app (the top-bar switcher, `X-BH-Brand`), or null for all brands. Every
   * REST call the tools make carries it, so reads are narrowed exactly as in the app; it never widens access.
   */
  brand: { id: string; name: string } | null;
  /** Capabilities the person holds anywhere in the organisation (to decide which tools to offer). */
  caps: ReadonlySet<string>;
  assignments: Assignment[];
  /** True when the person has at least one organisation-wide assignment. */
  hq: boolean;
  api: AssistantApi;
  /** Does the person hold `module:action` anywhere? */
  can(module: string, action?: AccessAction): boolean;
  /** Location ids where the person holds `module:action` ('all' for organisation-wide), via the access model's scope resolution. */
  locationsWith(module: string, action?: AccessAction): Promise<'all' | Set<string>>;
  /** Does the person hold `module:action` at a scope (any kind: organisation, region, portfolio, territory, brand…)? */
  canAt(module: string, action: AccessAction, target: Omit<ScopeTarget, 'organizationId'>): Promise<boolean>;
  /** A request-shaped access context for the authz helpers (the person's user and their assignments). */
  req: FastifyRequest;
  /** `/orgs/:orgId` prefix for REST paths. */
  o(path: string): string;
}

function qs(q?: Query) {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const str = p.toString();
  return str ? `?${str}` : '';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function buildAssistantContext(s: Services, orgId: string, userId: string, opts: { locale?: string; brandId?: string | null } = {}): Promise<AssistantContext> {
  const [u] = await s.db.select({ id: users.id, email: users.email, name: users.name, emailVerifiedAt: users.emailVerifiedAt, locale: users.locale }).from(users).where(eq(users.id, userId));
  if (!u) throw new ToolError('not_found', 'User not found', 404);
  const [o] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!o) throw new ToolError('not_found', 'Organisation not found', 404);
  const assignments = await loadAssignments(s.db, userId, orgId);
  // Brand filter: passed on to every REST call exactly as the app sends it (the API narrows reads; an id that is not a
  // brand of this business, or one the person does not cover, gives empty lists there too).
  const brandId = opts.brandId && UUID_RE.test(opts.brandId) ? opts.brandId.toLowerCase() : null;
  const [brand] = brandId ? await s.db.select({ id: brands.id, name: brands.name }).from(brands).where(and(eq(brands.id, brandId), eq(brands.organizationId, orgId))) : [];
  const brandHeader: Record<string, string> = brandId ? { [BRAND_FILTER_HEADER]: brandId } : {};
  const caps = capabilitiesAnywhere(assignments);
  const user = { id: u.id, email: u.email, emailVerified: !!u.emailVerifiedAt, name: u.name ?? u.email };
  let token: string | null = null;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (!s.inject) throw new ToolError('unavailable', 'The assistant is not attached to the API', 503);
    token ??= await signAccessToken(s.cfg, user);
    const res = await s.inject({
      method: method as 'GET',
      url: `/v1${path}`,
      headers: { authorization: `Bearer ${token}`, 'x-bh-assistant': '1', 'x-bh-internal': s.internalKey, 'accept-language': opts.locale ?? u.locale ?? 'en', ...brandHeader, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    let json: any = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      json = { raw: res.body.slice(0, 2000) };
    }
    if (res.statusCode >= 400) {
      const e = json?.error ?? {};
      throw new ToolError(e.code ?? 'error', e.message ?? `Request failed (${res.statusCode})`, res.statusCode);
    }
    return json as T;
  };
  const o2 = (path: string) => `/orgs/${orgId}${path}`;
  // The same scope resolution as the REST routes (capabilityLocations / resolveScopeChain) for this person.
  const req = { user, assignmentCache: new Map([[orgId, assignments]]), server: { ctx: s }, headers: { ...brandHeader }, method: 'GET', log: s.log } as unknown as FastifyRequest;
  return {
    s,
    orgId,
    user,
    locale: opts.locale ?? u.locale ?? o.defaultLocale ?? 'en',
    org: { id: o.id, name: o.name, industry: o.industry, model: o.model, defaultCurrency: o.defaultCurrency, defaultTimeZone: o.defaultTimeZone, defaultLocale: o.defaultLocale, slug: o.slug },
    brand: brandId ? { id: brandId, name: brand?.name ?? 'a brand outside this business' } : null,
    caps,
    assignments,
    hq: assignments.some((a) => a.scopeKind === 'organization'),
    api: {
      get: (path, q) => call('GET', `${path}${qs(q)}`),
      post: (path, body) => call('POST', path, body ?? {}),
      put: (path, body) => call('PUT', path, body ?? {}),
      patch: (path, body) => call('PATCH', path, body ?? {}),
      delete: (path) => call('DELETE', path),
    },
    can: (module, action = 'view') => caps.has(`${module}:${action}`),
    locationsWith: (module, action = 'view') => capabilityLocations(req, s.db, orgId, module, action),
    canAt: (module, action, target) => hasCapability(req, s.db, module, action, { organizationId: orgId, ...target } as ScopeTarget),
    req,
    o: o2,
  };
}

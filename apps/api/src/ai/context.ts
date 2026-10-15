import { eq } from 'drizzle-orm';
import { capabilityLocationIds, capabilitiesAnywhere, type Assignment } from '../domain/scope.ts';
import type { AccessAction } from '@bh/shared';
import type { Services } from '../context.ts';
import { locations, organizations, users } from '../db/schema/index.ts';
import { signAccessToken, type AuthUser } from '../plugins/auth.ts';
import { loadAssignments } from '../services/authz.ts';
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
  /** Capabilities the person holds anywhere in the organisation (to decide which tools to offer). */
  caps: ReadonlySet<string>;
  assignments: Assignment[];
  /** True when the person has at least one organisation-wide assignment. */
  hq: boolean;
  api: AssistantApi;
  /** Does the person hold `module:action` anywhere? */
  can(module: string, action?: AccessAction): boolean;
  /** Location ids where the person holds `module:action` ('all' for organisation-wide). */
  locationsWith(module: string, action?: AccessAction): Promise<'all' | Set<string>>;
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

export async function buildAssistantContext(s: Services, orgId: string, userId: string, opts: { locale?: string } = {}): Promise<AssistantContext> {
  const [u] = await s.db.select({ id: users.id, email: users.email, name: users.name, emailVerifiedAt: users.emailVerifiedAt, locale: users.locale }).from(users).where(eq(users.id, userId));
  if (!u) throw new ToolError('not_found', 'User not found', 404);
  const [o] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!o) throw new ToolError('not_found', 'Organisation not found', 404);
  const assignments = await loadAssignments(s.db, userId, orgId);
  const caps = capabilitiesAnywhere(assignments);
  const user = { id: u.id, email: u.email, emailVerified: !!u.emailVerifiedAt, name: u.name ?? u.email };
  let token: string | null = null;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (!s.inject) throw new ToolError('unavailable', 'The assistant is not attached to the API', 503);
    token ??= await signAccessToken(s.cfg, user);
    const res = await s.inject({
      method: method as 'GET',
      url: `/v1${path}`,
      headers: { authorization: `Bearer ${token}`, 'x-bh-assistant': '1', 'x-bh-internal': s.internalKey, 'accept-language': opts.locale ?? u.locale ?? 'en', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
  return {
    s,
    orgId,
    user,
    locale: opts.locale ?? u.locale ?? o.defaultLocale ?? 'en',
    org: { id: o.id, name: o.name, industry: o.industry, model: o.model, defaultCurrency: o.defaultCurrency, defaultTimeZone: o.defaultTimeZone, defaultLocale: o.defaultLocale, slug: o.slug },
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
    locationsWith: async (module, action = 'view') => {
      const locs = await s.db.select({ id: locations.id, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId }).from(locations).where(eq(locations.organizationId, orgId));
      return capabilityLocationIds(assignments, module, action, orgId, locs);
    },
    o: o2,
  };
}

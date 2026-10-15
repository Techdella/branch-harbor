import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.ts';
import { capabilitiesAnywhere } from '../domain/scope.ts';
import { requireMember } from './authz.ts';

/**
 * Module guard (access model, "no padlocks"): every organisation route belongs to one or more modules. A member who
 * holds none of them anywhere in the organisation gets 403 `module_not_available` — the area simply isn't part of
 * their access, so lists are refused rather than returned empty.
 *
 * This is the first of two checks. Each route still checks the specific action (edit, publish, refund…) in the
 * target scope through its permission (`requirePerm` / `authorisedLocations`), and list endpoints filter records by
 * scope. Routes not listed here (organisation profile, directory lookups, onboarding, own access) rely on those
 * checks alone.
 *
 * Patterns: `area.*` = any module of that workspace. Features add their own prefixes here.
 */
export const ROUTE_MODULES: Record<string, readonly string[]> = {
  // Sales
  customers: ['sales.customers'],
  leads: ['sales.customers', 'sales.customer_pipeline'],
  // Marketing
  websites: ['marketing.website_builder', 'network.templates'],
  pages: ['marketing.website_builder', 'network.templates'],
  'publish-jobs': ['marketing.website_builder'],
  domains: ['marketing.website_builder'],
  templates: ['marketing.website_builder', 'network.templates'],
  sites: ['marketing.website_builder'],
  campaigns: ['marketing.campaigns', 'marketing.*'],
  'ad-spend-requests': ['marketing.campaigns', 'marketing.ads'],
  // Finance
  payments: ['finance.payments'],
  'refund-requests': ['finance.payments'],
  // Network
  reports: ['network.reports'],
  // The inbox holds refunds (finance), local ad spend (marketing), shift swaps and website changes; each decision is
  // checked per kind.
  approvals: ['network.approvals', 'finance.payments', 'marketing.campaigns'],
  // Operations (industry screens and the staff schedule)
  studios: ['operations.*'],
  sports: ['operations.*'],
  wellness: ['operations.*'],
  commerce: ['operations.*'],
  foods: ['operations.*'],
  realty: ['operations.*'],
  hospitality: ['operations.*'],
  shifts: ['operations.*'],
  'shift-swaps': ['operations.*'],
  'time-clock': ['operations.*'],
  // Settings
  members: ['settings.team'],
  invitations: ['settings.team'],
  'role-assignments': ['settings.team'],
  roles: ['settings.team'],
  connections: ['settings.connections'],
  'partner-connections': ['settings.connections'],
  subscription: ['settings.billing'],
  'audit-events': ['settings.audit'],
  ai: ['settings.ai'],
};

/** `access/assignments` and `access/preview` are Team & access; `access/me` is open to every member. */
const SUB_ROUTE_MODULES: Record<string, readonly string[]> = {
  'access/assignments': ['settings.team'],
  'access/preview': ['settings.team'],
};

const ORG_ROUTE = /^\/v1\/orgs\/:orgId\/([a-z-]+)(?:\/([a-z-]+))?/;

export function modulesForRoute(routeUrl: string | undefined): readonly string[] | null {
  const m = routeUrl ? ORG_ROUTE.exec(routeUrl) : null;
  if (!m) return null;
  return SUB_ROUTE_MODULES[`${m[1]}/${m[2]}`] ?? ROUTE_MODULES[m[1]!] ?? null;
}

function holdsAny(caps: ReadonlySet<string>, patterns: readonly string[]) {
  for (const p of patterns) {
    const prefix = p.endsWith('.*') ? p.slice(0, -1) : `${p}:`;
    for (const c of caps) if (c.startsWith(prefix) && c.endsWith(':view')) return true;
  }
  return false;
}

/** preHandler for all /v1 routes. Unauthenticated requests pass through (the route's own `authenticate` answers 401). */
export async function moduleGuard(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.user) return;
  const modules = modulesForRoute(req.routeOptions.url);
  if (!modules) return;
  const orgId = (req.params as { orgId?: string } | undefined)?.orgId;
  if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) return;
  const assignments = await requireMember(req, req.server.ctx.db, orgId);
  if (!holdsAny(capabilitiesAnywhere(assignments), modules)) {
    throw new AppError(403, 'module_not_available', 'This area is not part of your access in this business.', undefined, { modules });
  }
}

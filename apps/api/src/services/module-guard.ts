import type { FastifyReply, FastifyRequest } from 'fastify';
import { INDUSTRY_MODULES } from '@bh/shared';
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
  leads: ['sales.customers', 'sales.customer_pipeline', 'sales.course_leads'],
  sales: ['sales.customer_pipeline', 'sales.course_leads'],
  contacts: ['sales.customers', 'marketing.inbox'],
  segments: ['marketing.inbox', 'marketing.campaigns', 'marketing.email', 'sales.customer_pipeline', 'sales.customers'],
  // Marketing
  websites: ['marketing.website_builder', 'network.templates'],
  pages: ['marketing.website_builder', 'network.templates'],
  'publish-jobs': ['marketing.website_builder'],
  domains: ['marketing.website_builder'],
  templates: ['marketing.website_builder', 'network.templates'],
  sites: ['marketing.website_builder'],
  campaigns: ['marketing.campaigns', 'marketing.*'],
  'ad-spend-requests': ['marketing.campaigns', 'marketing.ads'],
  // Marketing workspace: website builder documents/themes, email, automations, forms, brand assets, settings and tasks.
  builder: ['marketing.website_builder', 'network.templates'],
  email: ['marketing.email'],
  automations: ['marketing.automations'],
  forms: ['marketing.forms'],
  assets: ['marketing.brand_assets', 'marketing.website_builder', 'marketing.email'],
  marketing: ['marketing.*'],
  tags: ['sales.customers', 'marketing.*'],
  inbox: ['marketing.inbox'],
  social: ['marketing.social'],
  reviews: ['marketing.reviews'],
  'ad-campaigns': ['marketing.ads', 'marketing.network_campaigns', 'finance.royalties'],
  // Franchise development (Sales), new locations (Network) and Legal. Franchise owners reach their own onboarding
  // projects and agreement through New locations; each route checks the module it needs.
  franchise: ['sales.franchise_pipeline', 'legal.agreements', 'legal.disclosure', 'network.onboarding'],
  legal: ['legal.agreements', 'legal.disclosure', 'network.onboarding'],
  // Community (announcements, discussions, events, coaching), resource library, Training academy (+ course leads), help desk.
  community: ['community.*'],
  resources: ['community.library'],
  training: ['training.*'],
  helpdesk: ['community.help_desk'],
  // Finance
  payments: ['finance.payments'],
  'refund-requests': ['finance.payments'],
  // Finance workspace (/finance/...): each endpoint then checks its own module action and scope.
  finance: ['finance.royalties', 'finance.invoices', 'finance.marketing_fund', 'finance.payouts', 'finance.payments'],
  // Network
  reports: ['network.reports'],
  // Field audits (Operations), compliance documents (Legal & compliance) and the league table (Network).
  audits: ['operations.audits'],
  compliance: ['legal.compliance_documents'],
  'league-table': ['network.league_table'],
  // Network data platform: sales connectors, bulk launch, benchmarks and the import wizard.
  'sales-connectors': ['network.sales_connectors'],
  launches: ['network.bulk_launch'],
  benchmarks: ['network.benchmarks'],
  imports: ['settings.import'],
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
  'access/coverage': ['settings.team'],
  'access/team-shape': ['settings.team'],
  'access/role-labels': ['settings.team'],
  'access/scopes': ['settings.team'],
  'access/portfolios': ['settings.team'],
  'access/territories': ['settings.team', 'network.locations'],
};

const ORG_ROUTE = /^(?:\/v1)?\/orgs\/:orgId\/([a-z-]+)(?:\/([a-z-]+))?/;

/**
 * Per-module enforcement for Operations (as for hospitality, services/hospitality.ts): each industry route belongs to
 * one Operations module by its second path segment. Routes not listed (overview, AI helpers, location settings, `me`)
 * belong to any Operations module of the industry. The guard requires the module, and `operations.read` / `write`
 * checks on these routes resolve to the module's view / edit at each location (services/authz.ts).
 */
const OPS_SUB_ROUTES: Record<string, Record<string, string>> = {
  studios: {
    ...Object.fromEntries(['occurrences', 'series', 'class-types', 'rooms', 'availability', 'bookings', 'cover-requests', 'instructors', 'policies'].map((k) => [k, 'operations.classes'])),
    ...Object.fromEntries(['members', 'memberships', 'membership-plans', 'pack-products', 'online', 'offers', 'fees'].map((k) => [k, 'operations.memberships'])),
    reports: 'operations.studio_insights',
  },
  sports: {
    ...Object.fromEntries(['programmes', 'registrations', 'balances', 'instalments', 'seasons', 'forms', 'disputes', 'age-preview', 'participants', 'relationships'].map((k) => [k, 'operations.programmes'])),
    ...Object.fromEntries(['teams', 'sessions', 'schedule-proposals', 'selections', 'announcements', 'guardians', 'coaches', 'venues', 'messages', 'notifications'].map((k) => [k, 'operations.teams'])),
    reports: 'operations.sports_reports',
  },
  wellness: {
    ...Object.fromEntries(['appointments', 'calendar', 'practitioners', 'exceptions', 'waitlist', 'resources', 'my-day', 'series', 'reminders', 'messages'].map((k) => [k, 'operations.appointments'])),
    ...Object.fromEntries(['services', 'variants', 'package-plans', 'client-packages', 'vouchers', 'intake-forms', 'charges'].map((k) => [k, 'operations.services'])),
    clients: 'operations.clients',
    reports: 'operations.wellness_insights',
    utilisation: 'operations.wellness_insights',
  },
  commerce: {
    ...Object.fromEntries(['orders', 'sales-orders', 'returns', 'gift-cards', 'store-credit', 'fulfilments', 'fulfilment-queue', 'fulfilment-settings', 'reservations'].map((k) => [k, 'operations.orders'])),
    ...Object.fromEntries(['catalogue', 'collections', 'distributions', 'products', 'variants'].map((k) => [k, 'operations.catalogue'])),
    ...Object.fromEntries(['inventory', 'stock-counts', 'stock-movements', 'transfers', 'purchase-orders', 'suppliers'].map((k) => [k, 'operations.inventory'])),
    reports: 'operations.commerce_insights',
  },
  foods: {
    ...Object.fromEntries(['menus', 'items', 'categories', 'modifier-groups', 'modifiers', 'builder', 'day-parts', 'ingredients', 'vocabulary'].map((k) => [k, 'operations.menu'])),
    ...Object.fromEntries(['orders', 'kds', 'stations', 'tables', 'tabs', 'deliveries', 'delivery-providers', 'delivery-zones', 'drivers', 'catering', 'meal-plans', 'production-dates'].map((k) => [k, 'operations.food_orders'])),
    settings: 'operations.ordering_settings',
    'pickup-settings': 'operations.ordering_settings',
    reports: 'operations.food_reports',
  },
  realty: {
    ...Object.fromEntries(['listings', 'syndication'].map((k) => [k, 'operations.listings'])),
    ...Object.fromEntries(['enquiries', 'viewings', 'viewing-slots', 'offers', 'open-houses', 'contacts'].map((k) => [k, 'operations.enquiries'])),
    ...Object.fromEntries(['agents', 'offices'].map((k) => [k, 'operations.agents'])),
  },
  shifts: { '': 'operations.schedule' },
  'shift-swaps': { '': 'operations.schedule' },
  'time-clock': { '': 'operations.schedule' },
};

/** The Operations module an industry route belongs to (null when it belongs to any, or isn't an Operations route). */
export function opsModuleForRoute(routeUrl: string | undefined): string | null {
  const m = routeUrl ? ORG_ROUTE.exec(routeUrl) : null;
  const subs = m ? OPS_SUB_ROUTES[m[1]!] : undefined;
  if (!subs) return null;
  return subs[''] ?? subs[m![2] ?? ''] ?? null;
}

/**
 * The Operations module that governs this route for a person: the route's module, unless the business is of another
 * industry (e.g. a hotel's restaurant outlet runs on the Foods engine) — then any Operations module, as before.
 */
export function opsModuleFor(routeUrl: string | undefined, caps: ReadonlySet<string>): string | null {
  const m = opsModuleForRoute(routeUrl);
  if (!m) return null;
  const industry = (Object.keys(INDUSTRY_MODULES) as (keyof typeof INDUSTRY_MODULES)[]).find((i) => INDUSTRY_MODULES[i].some((x) => x.key === m));
  if (!industry) return m; // shared Operations modules (the staff schedule)
  const own = INDUSTRY_MODULES[industry].map((x) => `${x.key}:`);
  for (const c of caps) if (own.some((p) => c.startsWith(p))) return m;
  return null;
}

export function modulesForRoute(routeUrl: string | undefined, caps?: ReadonlySet<string>): readonly string[] | null {
  const m = routeUrl ? ORG_ROUTE.exec(routeUrl) : null;
  if (!m) return null;
  const ops = caps ? opsModuleFor(routeUrl, caps) : opsModuleForRoute(routeUrl);
  if (ops) return [ops];
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
  if (!modulesForRoute(req.routeOptions.url)) return;
  const orgId = (req.params as { orgId?: string } | undefined)?.orgId;
  if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) return;
  const assignments = await requireMember(req, req.server.ctx.db, orgId);
  const caps = capabilitiesAnywhere(assignments);
  const modules = modulesForRoute(req.routeOptions.url, caps)!;
  if (!holdsAny(caps, modules)) {
    throw new AppError(403, 'module_not_available', 'This area is not part of your access in this business.', undefined, { modules });
  }
}

/**
 * Workspaces and navigation from capabilities (docs/PRODUCT_PLAN.md "Access model", "Workspaces in one app").
 *
 * The API returns, per organisation, the capabilities a person holds (`<module>:<action>`). This file maps modules to
 * the dashboard's screens: each workspace gets a home and a navigation built only from modules the person holds
 * ("no padlocks": anything else is absent). Modules without a screen yet are never shown.
 */
import type { IconName } from '@bh/icons';
import {
  WORKSPACES, capability, modulesFor, permissionsFromCapabilities, workspacesFor, settingsModulesFor, type Capability, type ModuleDef, type Permission, type WorkspaceKey,
} from '@bh/shared';
import { OPS } from './nav';
import type { IndustryKey } from './types';

export interface NavLink {
  /** Message key under `nav.*` (or `ops.<industry>.<screen>.title` for industry screens). */
  key: string;
  href: string;
  icon: IconName;
  module: string;
  /** Industry screen key (`/ops/<screen>`). */
  screen?: string;
  /** Full message key for the label, for screens whose words live in their own catalogue (e.g. `franchise.nav.pipeline`). */
  msg?: string;
}

/** Screens for the core modules. Modules not listed here (brand templates, audit log, AI) have no page of their own. */
const MODULE_LINKS: Record<string, Omit<NavLink, 'module'>[]> = {
  'network.locations': [{ key: 'locations', href: '/locations', icon: 'pin' }],
  'network.approvals': [{ key: 'approvals', href: '/approvals', icon: 'shield' }],
  'network.reports': [{ key: 'reports', href: '/reports', icon: 'chart' }],
  'network.onboarding': [{ key: 'onboarding', href: '/franchise/onboarding', icon: 'building', msg: 'franchise.nav.onboarding' }],
  'operations.schedule': [{ key: 'schedule', href: '/schedule', icon: 'clock' }],
  'sales.customers': [{ key: 'customers', href: '/customers', icon: 'users' }],
  'sales.franchise_pipeline': [
    { key: 'pipeline', href: '/franchise/pipeline', icon: 'flag', msg: 'franchise.nav.pipeline' },
    { key: 'territories', href: '/franchise/territories', icon: 'map', msg: 'franchise.nav.territories' },
  ],
  // Website builder (pages, themes, master pages) and the websites list (domains, publishing).
  'marketing.website_builder': [
    { key: 'builder', href: '/marketing/websites', icon: 'layers', msg: 'access.nav.builder' },
    { key: 'websites', href: '/websites', icon: 'globe' },
  ],
  'marketing.campaigns': [{ key: 'marketing', href: '/marketing', icon: 'megaphone' }],
  'marketing.email': [{ key: 'email', href: '/marketing/email', icon: 'mail', msg: 'mkt.nav.email' }],
  'marketing.automations': [{ key: 'automations', href: '/marketing/automations', icon: 'workflow', msg: 'mkt.nav.automations' }],
  'marketing.forms': [{ key: 'forms', href: '/marketing/forms', icon: 'file', msg: 'mkt.nav.forms' }],
  'marketing.brand_assets': [{ key: 'assets', href: '/marketing/assets', icon: 'image', msg: 'mkt.nav.assets' }],
  'marketing.inbox': [{ key: 'inbox', href: '/marketing/inbox', icon: 'message' }],
  'marketing.social': [{ key: 'social', href: '/marketing/social', icon: 'share' }],
  'marketing.reviews': [{ key: 'reviews', href: '/marketing/reviews', icon: 'star', msg: 'reviews.nav.reviews' }],
  'marketing.ads': [{ key: 'campaigns', href: '/marketing/campaigns', icon: 'target' }],
  'marketing.network_campaigns': [{ key: 'campaigns', href: '/marketing/campaigns', icon: 'target' }],
  'sales.customer_pipeline': [{ key: 'leads', href: '/sales/leads', icon: 'trending' }],
  'sales.course_leads': [{ key: 'leads', href: '/sales/leads', icon: 'trending' }],
  'finance.payments': [{ key: 'payments', href: '/payments', icon: 'card' }],
  'legal.agreements': [{ key: 'agreements', href: '/franchise/agreements', icon: 'scale', msg: 'franchise.nav.agreements' }],
  'legal.disclosure': [
    { key: 'agreements', href: '/franchise/agreements', icon: 'scale', msg: 'franchise.nav.agreements' },
    { key: 'rules', href: '/franchise/rules', icon: 'shield', msg: 'franchise.nav.rules' },
  ],
  'training.academy': [{ key: 'training', href: '/training', icon: 'book' }],
  'training.assignments': [{ key: 'training', href: '/training', icon: 'book' }],
  'community.announcements': [{ key: 'community', href: '/community', icon: 'message' }],
  'community.discussions': [{ key: 'community', href: '/community', icon: 'message' }],
  'community.library': [{ key: 'community', href: '/community', icon: 'message' }],
  'community.help_desk': [{ key: 'help', href: '/help', icon: 'help' }],
  // Finance workspace (/finance/...): royalties and reports for HQ, statements & invoices for anyone with them in scope.
  'finance.royalties': [{ key: 'financeRoyalties', href: '/finance/royalties', icon: 'receipt' }, { key: 'financeReports', href: '/finance/reports', icon: 'chart' }],
  'finance.invoices': [{ key: 'financeStatements', href: '/finance/statements', icon: 'file' }],
  'finance.marketing_fund': [{ key: 'financeFund', href: '/finance/marketing-fund', icon: 'megaphone' }],
  'finance.payouts': [{ key: 'financePayouts', href: '/finance/payouts', icon: 'wallet' }],
  'settings.team': [{ key: 'team', href: '/team', icon: 'user' }],
  'settings.connections': [{ key: 'connections', href: '/connections', icon: 'plug' }],
  'settings.business': [{ key: 'settings', href: '/settings', icon: 'settings' }],
  'settings.billing': [{ key: 'settings', href: '/settings', icon: 'settings' }],
};

/** Links a module contributes for this industry (industry screens come from the module's `screens`). */
export function linksFor(m: ModuleDef, industry: IndustryKey): NavLink[] {
  if (m.area === 'operations' && m.screens) {
    const ops = OPS[industry] ?? [];
    return m.screens
      .map((sc) => ops.find((o) => o.key === sc))
      .filter((o): o is (typeof ops)[number] => !!o && o.kind !== 'later')
      .map((o) => ({ key: o.key, href: `/ops/${o.key}`, icon: o.icon, module: m.key, screen: o.key }));
  }
  return (MODULE_LINKS[m.key] ?? []).map((l) => ({ ...l, module: m.key }));
}

const has = (caps: ReadonlySet<string>, module: string) => caps.has(capability(module, 'view'));

/** Navigation for one workspace: the person's available modules there, in catalogue order (deduplicated by href). */
export function workspaceNav(workspace: WorkspaceKey | 'settings', caps: ReadonlySet<string>, industry: IndustryKey): NavLink[] {
  const out: NavLink[] = [];
  for (const m of modulesFor(industry)) {
    if (m.area !== workspace || m.status !== 'available' || !has(caps, m.key)) continue;
    for (const l of linksFor(m, industry)) if (!out.some((o) => o.href === l.href)) out.push(l);
  }
  return out;
}

/** Workspaces that have at least one screen for this person (no empty workspaces, no placeholders). */
export function visibleWorkspaces(caps: ReadonlySet<string>, industry: IndustryKey): WorkspaceKey[] {
  return workspacesFor(caps, industry).map((w) => w.key).filter((w) => workspaceNav(w, caps, industry).length > 0);
}

/** Everything the person holds, flattened (independent businesses: one simple navigation, no workspace switcher). */
export function flatNav(caps: ReadonlySet<string>, industry: IndustryKey): NavLink[] {
  const out: NavLink[] = [];
  const networkOnly = new Set(modulesFor(industry).filter((m) => m.networkOnly).map((m) => m.key));
  for (const w of [...WORKSPACES, 'settings'] as const) for (const l of workspaceNav(w, caps, industry)) if (!networkOnly.has(l.module) && !out.some((o) => o.href === l.href)) out.push(l);
  return out;
}

export function settingsNav(caps: ReadonlySet<string>, industry: IndustryKey): NavLink[] {
  return settingsModulesFor(caps, industry).length ? workspaceNav('settings', caps, industry) : [];
}

/**
 * Routes reachable without a navigation entry of their own, or by more modules than the one whose navigation lists
 * them (the API applies the same rules): a prospect's page, a franchise owner's own agreement, the rules browser for
 * the franchise pipeline.
 */
const EXTRA_ROUTE_MODULES: Record<string, readonly string[]> = {
  '/franchise/prospect': ['sales.franchise_pipeline'],
  '/franchise/agreements': ['sales.franchise_pipeline', 'network.onboarding'],
  '/franchise/rules': ['sales.franchise_pipeline'],
};

/**
 * Modules that make a route available (any of them). `null` = not tied to a module (always available to members).
 * Routes for modules that are not built return an empty list, i.e. never available.
 */
export function routeModules(pathname: string, industry: IndustryKey): string[] | null {
  const seg = pathname.split('/').filter(Boolean);
  const first = seg[0] ?? '';
  if (first === 'ops') {
    const screen = seg[1] ?? '';
    const m = modulesFor(industry).find((x) => x.area === 'operations' && x.status === 'available' && x.screens?.includes(screen));
    return m ? [m.key] : [];
  }
  // The longest link (or extra route) that is the path or a prefix of it decides (`/marketing/inbox` before `/marketing`).
  const path = `/${seg.join('/')}`;
  const hrefs = Object.values(MODULE_LINKS).flat().map((l) => l.href);
  const best = [...new Set([...hrefs, ...Object.keys(EXTRA_ROUTE_MODULES)])].filter((h) => path === h || path.startsWith(`${h}/`)).sort((a, b) => b.length - a.length)[0];
  // Unknown sub-screens of a module area (e.g. /franchise/x) are never available; other unknown routes aren't tied to a module.
  if (!best) return seg.length > 1 && hrefs.some((h) => h.startsWith(`/${first}/`)) ? [] : null;
  const matches = [...Object.entries(MODULE_LINKS).filter(([, links]) => links.some((l) => l.href === best)).map(([k]) => k), ...(EXTRA_ROUTE_MODULES[best] ?? [])];
  return matches.length ? [...new Set(matches)] : null;
}

export function canSeeRoute(pathname: string, caps: ReadonlySet<string>, industry: IndustryKey): boolean {
  const mods = routeModules(pathname, industry);
  return mods === null || mods.some((m) => has(caps, m));
}

export function permissionsOf(caps: Iterable<string>): Set<Permission> {
  return permissionsFromCapabilities(new Set(caps));
}

/** The workspace a route belongs to (for highlighting); settings routes keep the current workspace. */
export function workspaceOfRoute(pathname: string, industry: IndustryKey): WorkspaceKey | null {
  const mods = routeModules(pathname, industry);
  const area = mods?.length ? modulesFor(industry).find((m) => m.key === mods[0])?.area : null;
  return area && area !== 'settings' ? area : null;
}

export const WORKSPACE_ICON: Record<WorkspaceKey, IconName> = {
  network: 'grid',
  operations: 'calendar',
  sales: 'users',
  marketing: 'megaphone',
  finance: 'card',
  legal: 'shield',
  training: 'flag',
  community: 'message',
};

export type { Capability };

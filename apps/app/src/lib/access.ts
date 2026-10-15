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
}

/** Screens for the core modules. Modules not listed here (brand templates, audit log, AI) have no page of their own. */
const MODULE_LINKS: Record<string, Omit<NavLink, 'module'>[]> = {
  'network.locations': [{ key: 'locations', href: '/locations', icon: 'pin' }],
  'network.approvals': [{ key: 'approvals', href: '/approvals', icon: 'shield' }],
  'network.reports': [{ key: 'reports', href: '/reports', icon: 'chart' }],
  'operations.schedule': [{ key: 'schedule', href: '/schedule', icon: 'clock' }],
  'sales.customers': [{ key: 'customers', href: '/customers', icon: 'users' }],
  'marketing.website_builder': [{ key: 'websites', href: '/websites', icon: 'globe' }],
  'marketing.campaigns': [{ key: 'marketing', href: '/marketing', icon: 'megaphone' }],
  'marketing.inbox': [{ key: 'inbox', href: '/marketing/inbox', icon: 'message' }],
  'marketing.social': [{ key: 'social', href: '/marketing/social', icon: 'share' }],
  'marketing.ads': [{ key: 'campaigns', href: '/marketing/campaigns', icon: 'target' }],
  'marketing.network_campaigns': [{ key: 'campaigns', href: '/marketing/campaigns', icon: 'target' }],
  'sales.customer_pipeline': [{ key: 'leads', href: '/sales/leads', icon: 'trending' }],
  'sales.course_leads': [{ key: 'leads', href: '/sales/leads', icon: 'trending' }],
  'finance.payments': [{ key: 'payments', href: '/payments', icon: 'card' }],
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
  for (const w of [...WORKSPACES, 'settings'] as const) for (const l of workspaceNav(w, caps, industry)) if (!out.some((o) => o.href === l.href)) out.push(l);
  return out;
}

export function settingsNav(caps: ReadonlySet<string>, industry: IndustryKey): NavLink[] {
  return settingsModulesFor(caps, industry).length ? workspaceNav('settings', caps, industry) : [];
}

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
  if (first === 'community') return [];
  // The longest link that is the path or a prefix of it decides (`/marketing/inbox` before `/marketing`).
  const path = `/${seg.join('/')}`;
  const hrefs = Object.values(MODULE_LINKS).flat().map((l) => l.href).filter((h) => path === h || path.startsWith(`${h}/`));
  const best = hrefs.sort((a, b) => b.length - a.length)[0];
  if (!best) return seg.length > 1 && Object.values(MODULE_LINKS).flat().some((l) => l.href.startsWith(`/${first}/`)) ? [] : null;
  const matches = Object.entries(MODULE_LINKS).filter(([, links]) => links.some((l) => l.href === best)).map(([k]) => k);
  return matches.length ? matches : null;
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

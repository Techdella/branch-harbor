/**
 * Access model (docs/PRODUCT_PLAN.md "Access model"): workspaces → modules → actions.
 *
 * - A **workspace** is an area of the app with its own home and navigation (Network, Operations, Sales, …).
 * - A **module** is a building block inside a workspace (e.g. `marketing.website_builder`). Operations modules come
 *   from the organisation's industry (one industry per business account).
 * - An **action** is what someone may do in a module: view, edit, publish (publish / approve) or export.
 *
 * A capability is `"<module>:<action>"`. Role templates (system roles) and custom roles are sets of capabilities;
 * a person's access is a role assignment (role + scope) plus optional per-person overrides. Holding any action in a
 * module implies `view`.
 *
 * The legacy `PERMISSIONS` (enforced by every existing endpoint) are derived from capabilities through
 * `PERMISSION_CAPABILITIES`, so endpoint checks keep working and follow custom roles and overrides.
 *
 * Modules with `status: 'planned'` are not built yet: they can sit in role templates (so access is ready the day
 * they ship) but clients never show them. Other features flip them to `available` when they ship.
 */
import type { Industry } from './industries.ts';
import { PERMISSIONS, type Permission, type Role, type RoleAssignment, type ScopeKind } from './permissions.ts';

/* ------------------------------------------------------------------ */
/* Workspaces and actions                                              */
/* ------------------------------------------------------------------ */

export const WORKSPACES = ['network', 'operations', 'sales', 'marketing', 'finance', 'legal', 'training', 'community'] as const;
export type WorkspaceKey = (typeof WORKSPACES)[number];

/** Modules live in a workspace, or in Settings (shown under every workspace, never a workspace of its own). */
export type ModuleArea = WorkspaceKey | 'settings';

export interface WorkspaceMeta {
  key: WorkspaceKey;
  name: string;
  description: string;
}

export const WORKSPACE_META: Record<WorkspaceKey, WorkspaceMeta> = {
  network: { key: 'network', name: 'Network', description: 'Locations, approvals and performance across the network.' },
  operations: { key: 'operations', name: 'Operations', description: 'Day-to-day work at your locations.' },
  sales: { key: 'sales', name: 'Sales', description: 'Customers, leads and franchise development.' },
  marketing: { key: 'marketing', name: 'Marketing', description: 'Websites, campaigns and brand.' },
  finance: { key: 'finance', name: 'Finance', description: 'Payments, refunds, royalties and payouts.' },
  legal: { key: 'legal', name: 'Legal & compliance', description: 'Agreements, disclosure and registrations.' },
  training: { key: 'training', name: 'Training', description: 'Courses and certification for the network.' },
  community: { key: 'community', name: 'Community', description: 'Announcements and support for the network.' },
};

export const ACCESS_ACTIONS = ['view', 'edit', 'publish', 'export'] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export const ACTION_META: Record<AccessAction, { name: string; description: string }> = {
  view: { name: 'View', description: 'See the screens and records.' },
  edit: { name: 'Edit', description: 'Create and change records.' },
  publish: { name: 'Publish / approve', description: 'Make changes live and decide requests.' },
  export: { name: 'Export', description: 'Download data and reports.' },
};

/* ------------------------------------------------------------------ */
/* Modules                                                             */
/* ------------------------------------------------------------------ */

export interface ModuleDef {
  /** `<area>.<name>`, e.g. `marketing.website_builder`. */
  key: string;
  area: ModuleArea;
  name: string;
  /** Plain-language description shown in "What can this person see?". */
  description: string;
  actions: readonly AccessAction[];
  /** What each action means for this module, where it differs from the generic meaning. */
  actionNotes?: Partial<Record<AccessAction, string>>;
  /** `planned` modules are never shown by clients (no placeholders). */
  status: 'available' | 'planned';
  /** HQ-private: only effective on organisation-wide assignments (never for franchisees or location roles). */
  hqOnly?: boolean;
  /** Franchise / multi-location only: independent businesses never see it. */
  networkOnly?: boolean;
  /** Sensitive data the module exposes; the API filters these fields by capability. */
  sensitive?: 'finance' | 'legal' | 'personal_data';
  /** Operations modules: the industry screens (dashboard route keys) the module covers. */
  screens?: readonly string[];
}

const V = ['view'] as const;
const VE = ['view', 'edit'] as const;
const VEP = ['view', 'edit', 'publish'] as const;
const VEX = ['view', 'edit', 'export'] as const;
const ALL = ['view', 'edit', 'publish', 'export'] as const;

/** Modules every business account has, whatever its industry. */
export const CORE_MODULES: readonly ModuleDef[] = [
  // Network (HQ)
  { key: 'network.locations', area: 'network', name: 'Locations', description: 'The location directory: addresses, opening hours, status and local details.', actions: VE, status: 'available' },
  { key: 'network.onboarding', area: 'network', name: 'New locations', description: 'Onboarding checklists, pre-opening checks and go-live requests for new locations. Franchise owners see the projects of their own locations and their own franchise agreement.', actions: VE, actionNotes: { edit: 'Complete checklist tasks and ask HQ to approve the opening.' }, networkOnly: true, status: 'available' },
  { key: 'network.franchisees', area: 'network', name: 'Franchisees & owner groups', description: 'Franchise owners, their companies and which locations they run.', actions: VE, networkOnly: true, status: 'planned', hqOnly: true },
  { key: 'network.approvals', area: 'network', name: 'Approvals', description: 'Requests waiting for a decision: refunds over the limit, local ad spend, shift swaps and website changes.', actions: ['view', 'publish'], actionNotes: { publish: 'Approve or reject website changes from locations.' }, status: 'available' },
  { key: 'network.reports', area: 'network', name: 'Reports', description: 'Performance reports for the locations in scope. Revenue figures also need Payments.', actions: ['view', 'export'], status: 'available' },
  { key: 'network.templates', area: 'network', name: 'Brand templates & policies', description: 'Website templates, locked brand fields and business policies set by HQ.', actions: VEP, status: 'available' },
  // Operations: shared across industries (industry modules are added per industry below)
  { key: 'operations.schedule', area: 'operations', name: 'Staff schedule', description: 'Shifts, clock-in and shift swaps.', actions: VE, status: 'available' },
  // Sales
  { key: 'sales.customers', area: 'sales', name: 'Customers', description: 'Customer records with contact details and history (personal data).', actions: VEX, status: 'available', sensitive: 'personal_data' },
  { key: 'sales.customer_pipeline', area: 'sales', name: 'Leads & enquiries', description: 'New enquiries and trial customers to follow up.', actions: ALL, status: 'planned', sensitive: 'personal_data' },
  { key: 'sales.franchise_pipeline', area: 'sales', name: 'Franchise pipeline', description: 'Franchise enquiries, qualification, disclosure and agreement steps, territories and new-location deals.', actions: ALL, networkOnly: true, status: 'available', hqOnly: true, sensitive: 'personal_data' },
  { key: 'sales.course_leads', area: 'sales', name: 'Course leads', description: 'People interested in teacher training and courses.', actions: VEX, status: 'planned', sensitive: 'personal_data' },
  // Marketing
  { key: 'marketing.website_builder', area: 'marketing', name: 'Websites', description: 'Location websites: pages, approvals, publishing and domains.', actions: VEP, status: 'available' },
  { key: 'marketing.campaigns', area: 'marketing', name: 'Campaigns', description: 'Marketing campaigns and offers for the locations in scope.', actions: VEP, status: 'available' },
  { key: 'marketing.email', area: 'marketing', name: 'Email', description: 'Email campaigns and newsletters.', actions: VEP, status: 'planned' },
  { key: 'marketing.automations', area: 'marketing', name: 'Automations', description: 'Automatic journeys: trigger, conditions and actions.', actions: VEP, status: 'planned' },
  { key: 'marketing.social', area: 'marketing', name: 'Social', description: 'Social posts and scheduling on brand accounts.', actions: VEP, status: 'planned' },
  { key: 'marketing.ads', area: 'marketing', name: 'Ads', description: 'Paid ad campaigns and budgets.', actions: ALL, status: 'planned' },
  { key: 'marketing.network_campaigns', area: 'marketing', name: 'Network campaigns', description: 'Campaigns HQ runs for all locations, including coming-soon locations.', actions: ALL, status: 'planned' },
  { key: 'marketing.brand_assets', area: 'marketing', name: 'Brand assets', description: 'Logos, photos and brand guidelines.', actions: VEP, status: 'planned' },
  // Finance
  { key: 'finance.payments', area: 'finance', name: 'Payments', description: 'Transactions, refunds, reconciliation and payment accounts (financial data).', actions: VEX, actionNotes: { edit: 'Issue refunds and fix reconciliation items.' }, status: 'available', sensitive: 'finance' },
  { key: 'finance.royalties', area: 'finance', name: 'Royalties', description: 'Royalty and marketing-fund invoices to franchisees.', actions: ALL, status: 'planned', hqOnly: true, sensitive: 'finance' },
  { key: 'finance.payouts', area: 'finance', name: 'Payouts', description: 'Payouts and settlements across the network.', actions: ALL, status: 'planned', hqOnly: true, sensitive: 'finance' },
  // Legal & compliance
  { key: 'legal.agreements', area: 'legal', name: 'Franchise agreements', description: 'The agreements register, executed agreements, the legal document vault, renewals and expiries.', actions: ALL, networkOnly: true, status: 'available', hqOnly: true, sensitive: 'legal' },
  { key: 'legal.disclosure', area: 'legal', name: 'Disclosure & jurisdiction rules', description: 'Disclosure documents, registrations and the jurisdiction rules (waiting and cooling-off periods) per jurisdiction.', actions: ALL, actionNotes: { publish: 'Record franchise counsel’s review of a jurisdiction rule.' }, networkOnly: true, status: 'available', hqOnly: true, sensitive: 'legal' },
  // Training
  { key: 'training.academy', area: 'training', name: 'Academy', description: 'Courses, lessons and certifications for staff and franchisees.', actions: ALL, status: 'planned' },
  // Community
  { key: 'community.announcements', area: 'community', name: 'Announcements', description: 'News and updates from HQ to the network.', actions: VEP, status: 'planned' },
  { key: 'community.help_desk', area: 'community', name: 'Help desk', description: 'Questions and support requests from locations.', actions: VE, status: 'planned' },
  // Settings (under every workspace)
  { key: 'settings.business', area: 'settings', name: 'Business settings', description: 'Business details, defaults, data sharing and AI preferences.', actions: VE, status: 'available' },
  { key: 'settings.team', area: 'settings', name: 'Team & access', description: 'Invite people and decide what each person can see.', actions: VE, status: 'available' },
  { key: 'settings.connections', area: 'settings', name: 'Connections', description: 'Connected systems and their sync health.', actions: VE, status: 'available' },
  { key: 'settings.billing', area: 'settings', name: 'Billing', description: 'Your BranchHarbor plan and invoices.', actions: VE, status: 'available', hqOnly: true, sensitive: 'finance' },
  { key: 'settings.audit', area: 'settings', name: 'Audit log', description: 'Who changed what, and when.', actions: V, status: 'available' },
  { key: 'settings.ai', area: 'settings', name: 'AI assistant', description: 'Ask BranchHarbor AI about the data this person can already see. It only drafts and proposes.', actions: V, status: 'available' },
];

const ops = (key: string, name: string, description: string, screens: readonly string[], status: ModuleDef['status'] = 'available'): ModuleDef => ({
  key: `operations.${key}`, area: 'operations', name, description, actions: VE, status, screens,
});

/** Industry operations modules. The industry chosen at sign-up decides which of these an account has. */
export const INDUSTRY_MODULES: Record<Industry, readonly ModuleDef[]> = {
  studios: [
    ops('classes', 'Classes & schedule', 'Class timetable, rooms, bookings, attendance and cover.', ['classes', 'schedule', 'rooms', 'cover']),
    ops('memberships', 'Members & pricing', 'Members, memberships, class packs, offers and on-demand classes.', ['members', 'pricing', 'offers', 'online']),
    ops('studio_insights', 'Studio insights', 'Occupancy, attendance and churn.', ['insights']),
  ],
  sports: [
    ops('programmes', 'Programmes & registrations', 'Seasons, programmes, registrations and balances.', ['overview', 'programmes', 'registrations', 'balances']),
    ops('teams', 'Teams & sessions', 'Teams, schedule, attendance, announcements and guardians.', ['teams', 'schedule', 'attendance', 'announcements', 'guardians']),
    ops('sports_reports', 'Sports reports', 'Enrolment and attendance reports.', ['reports']),
  ],
  wellness: [
    ops('appointments', 'Appointments', 'Calendar, practitioners and their hours.', ['calendar', 'practitioners']),
    ops('services', 'Services & packages', 'Services, packages, gift vouchers and intake forms.', ['services', 'packages', 'forms']),
    ops('clients', 'Clients', 'Client history, preferences and notes.', ['clients']),
    ops('wellness_insights', 'Wellness insights', 'Utilisation, cancellations and revenue.', ['insights']),
  ],
  commerce: [
    ops('orders', 'Orders', 'Orders, returns and gift cards.', ['pulse', 'orders', 'returns', 'giftcards']),
    ops('catalogue', 'Catalogue', 'Products, assortment per location and the online store.', ['catalogue', 'assortment', 'storefront']),
    ops('inventory', 'Inventory', 'Stock, transfers and purchasing.', ['inventory', 'transfers', 'purchasing']),
    ops('commerce_insights', 'Commerce insights', 'Sales and stock reports.', ['insights']),
  ],
  foods: [
    ops('menu', 'Menu', 'Menus, item builder, availability and ingredients.', ['menu', 'builder', 'availability', 'ingredients']),
    ops('food_orders', 'Orders & kitchen', 'Orders, kitchen display, pickup, delivery, tables, catering and meal plans.', ['orders', 'kitchen', 'pickup', 'delivery', 'tables', 'catering', 'mealplans']),
    ops('ordering_settings', 'Ordering settings', 'Online ordering rules per location.', ['ordering']),
    ops('food_reports', 'Food reports', 'Sales, prep times and waste.', ['foodreports']),
  ],
  realty: [
    ops('listings', 'Listings', 'Listings, approvals and portal feeds.', ['pulse', 'listings', 'portals']),
    ops('enquiries', 'Enquiries & viewings', 'Enquiries, viewings and offers.', ['enquiries', 'viewings', 'offers']),
    ops('agents', 'Agents & offices', 'Agents, offices and lead routing.', ['agents']),
  ],
  // Built by the Hospitality release: flip each module to 'available' (and list its screens) as it ships.
  hospitality: [
    ops('reservations', 'Reservations', 'Bookings, availability and the front desk.', [], 'planned'),
    ops('rooms', 'Rooms & rates', 'Room types, rates and restrictions.', [], 'planned'),
    ops('housekeeping', 'Housekeeping', 'Room status and cleaning tasks.', [], 'planned'),
    ops('outlets', 'Restaurant outlet', 'Restaurant and bar orders for guests.', [], 'planned'),
  ],
};

/** Every module an organisation of this industry has (core + its industry's operations modules). */
export function modulesFor(industry: Industry | string): ModuleDef[] {
  return [...CORE_MODULES, ...(INDUSTRY_MODULES[industry as Industry] ?? [])];
}

export function moduleDef(industry: Industry | string, key: string): ModuleDef | undefined {
  return modulesFor(industry).find((m) => m.key === key);
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

export type Capability = `${string}:${AccessAction}`;

export function capability(module: string, action: AccessAction): Capability {
  return `${module}:${action}`;
}

export function parseCapability(c: string): { module: string; action: AccessAction } | null {
  const i = c.lastIndexOf(':');
  if (i <= 0) return null;
  const action = c.slice(i + 1) as AccessAction;
  if (!(ACCESS_ACTIONS as readonly string[]).includes(action)) return null;
  return { module: c.slice(0, i), action };
}

/** Grants written per module (or `area.*` / `*` wildcards) with the actions allowed. */
export type GrantSpec = Record<string, readonly AccessAction[]>;

/**
 * Expands a grant spec for an industry into concrete capabilities: wildcards resolve against the industry's
 * catalogue, actions a module doesn't support are dropped, and any action implies `view`.
 */
export function expandGrants(spec: GrantSpec, industry: Industry | string): Set<Capability> {
  const mods = modulesFor(industry);
  const out = new Set<Capability>();
  for (const [key, actions] of Object.entries(spec)) {
    const targets = key === '*' ? mods : key.endsWith('.*') ? mods.filter((m) => m.area === key.slice(0, -2)) : mods.filter((m) => m.key === key);
    for (const m of targets) {
      const acts = key === '*' ? m.actions : actions.filter((a) => m.actions.includes(a));
      for (const a of acts) out.add(capability(m.key, a));
      if (acts.length) out.add(capability(m.key, 'view'));
    }
  }
  return out;
}

/** Keeps only valid capabilities of the industry's catalogue and adds the implied `view`. */
export function normalizeCapabilities(caps: Iterable<string>, industry: Industry | string): Set<Capability> {
  const mods = new Map(modulesFor(industry).map((m) => [m.key, m]));
  const out = new Set<Capability>();
  for (const c of caps) {
    const p = parseCapability(c);
    const m = p && mods.get(p.module);
    if (!p || !m || !m.actions.includes(p.action)) continue;
    out.add(capability(p.module, p.action));
    out.add(capability(p.module, 'view'));
  }
  return out;
}

/** Drops HQ-private modules unless the assignment covers the whole organisation. */
export function scopeFilter(caps: Set<Capability>, scopeKind: ScopeKind, industry: Industry | string): Set<Capability> {
  if (scopeKind === 'organization') return caps;
  const hq = new Set(modulesFor(industry).filter((m) => m.hqOnly).map((m) => m.key));
  return new Set([...caps].filter((c) => !hq.has(parseCapability(c)!.module)));
}

/* ------------------------------------------------------------------ */
/* Legacy permissions ↔ capabilities                                   */
/* ------------------------------------------------------------------ */

/**
 * Each legacy permission is held when the person holds any of these capabilities. `operations.*:view` means
 * "view on any Operations module" (the industry screens and the staff schedule).
 */
export const PERMISSION_CAPABILITIES: Record<Permission, readonly string[]> = {
  'org.manage': ['settings.business:edit'],
  'billing.manage': ['settings.billing:edit'],
  'members.manage': ['settings.team:edit'],
  'locations.read': ['network.locations:view'],
  'locations.write': ['network.locations:edit'],
  'templates.write': ['network.templates:edit'],
  'policies.write': ['network.templates:publish'],
  'website.edit': ['marketing.website_builder:edit'],
  'website.publish': ['marketing.website_builder:publish'],
  'website.approve': ['network.approvals:publish'],
  'marketing.draft': ['marketing.campaigns:edit'],
  'marketing.publish': ['marketing.campaigns:publish'],
  'customers.read': ['sales.customers:view'],
  'customers.write': ['sales.customers:edit'],
  'operations.read': ['operations.*:view'],
  'operations.write': ['operations.*:edit'],
  'payments.read': ['finance.payments:view'],
  'payments.refund': ['finance.payments:edit'],
  'reports.read': ['network.reports:view'],
  'connections.manage': ['settings.connections:edit'],
  'ai.use': ['settings.ai:view'],
  'audit.read': ['settings.audit:view'],
  'franchise.pipeline.view': ['sales.franchise_pipeline:view'],
  'franchise.pipeline.edit': ['sales.franchise_pipeline:edit'],
  'onboarding.view': ['network.onboarding:view'],
  'onboarding.edit': ['network.onboarding:edit'],
  'legal.view': ['legal.agreements:view'],
  'legal.edit': ['legal.agreements:edit'],
  'disclosure.view': ['legal.disclosure:view'],
  'disclosure.edit': ['legal.disclosure:edit'],
  'disclosure.approve': ['legal.disclosure:publish'],
};

function holds(caps: ReadonlySet<string>, pattern: string): boolean {
  if (!pattern.includes('*')) return caps.has(pattern);
  const [mod, action] = pattern.split(':') as [string, string];
  const prefix = mod.slice(0, -1); // "operations."
  for (const c of caps) if (c.startsWith(prefix) && c.endsWith(`:${action}`)) return true;
  return false;
}

/** Legacy permissions implied by a capability set. */
export function permissionsFromCapabilities(caps: ReadonlySet<string>): Set<Permission> {
  const out = new Set<Permission>();
  for (const p of PERMISSIONS) if (PERMISSION_CAPABILITIES[p].some((c) => holds(caps, c))) out.add(p);
  return out;
}

/* ------------------------------------------------------------------ */
/* Role templates                                                      */
/* ------------------------------------------------------------------ */

export interface RoleTemplate {
  key: Role;
  name: string;
  description: string;
  /** Where the person lands after signing in. */
  primaryWorkspace: WorkspaceKey;
  /** Typical scope when assigning this role. */
  defaultScope: ScopeKind;
  /** Only offered to networks (franchise / multi-location roles). */
  networkOnly?: boolean;
  /** Not offered when inviting team members. */
  hidden?: boolean;
  grants: GrantSpec;
}

const everyone: GrantSpec = { 'training.academy': V, 'community.*': V };

export const ROLE_TEMPLATES: Record<Role, RoleTemplate> = {
  org_owner: {
    key: 'org_owner', name: 'Owner', description: 'Everything, including billing, ownership and who has access.', primaryWorkspace: 'network', defaultScope: 'organization',
    grants: { '*': ALL },
  },
  hq_admin: {
    key: 'hq_admin', name: 'HQ admin', description: 'Runs the network: locations, brand templates, websites, marketing, approvals, reports, team and connections. No customer records or payments.',
    primaryWorkspace: 'network', defaultScope: 'organization', networkOnly: true,
    grants: {
      'network.locations': VE, 'network.franchisees': VE, 'network.onboarding': VE, 'network.templates': VEP, 'network.approvals': ['view', 'publish'], 'network.reports': ['view', 'export'],
      'marketing.*': ALL, 'operations.*': V, 'settings.team': VE, 'settings.connections': VE, 'settings.audit': V, 'settings.ai': V, 'training.*': ALL, 'community.*': ALL,
    },
  },
  vp_franchise: {
    key: 'vp_franchise', name: 'VP Franchise', description: 'Franchise development: the franchise pipeline, disclosure and agreements, new locations and franchisee training.',
    primaryWorkspace: 'sales', defaultScope: 'organization', networkOnly: true,
    grants: {
      'sales.franchise_pipeline': ALL, 'legal.disclosure': VE, 'legal.agreements': VE, 'training.*': ALL, 'network.locations': VE, 'network.franchisees': VE,
      'network.onboarding': VE, 'network.reports': V, 'sales.course_leads': V, 'community.*': V, 'settings.ai': V,
    },
  },
  cmo: {
    key: 'cmo', name: 'CMO', description: 'All marketing across the network, brand templates, marketing reports and coaching franchisees on local marketing.',
    primaryWorkspace: 'marketing', defaultScope: 'organization', networkOnly: true,
    grants: {
      'marketing.*': ALL, 'network.templates': VEP, 'network.reports': ['view', 'export'], 'network.approvals': V, 'network.locations': V, 'sales.customer_pipeline': V,
      'community.*': ALL, 'training.academy': VE, 'settings.ai': V,
    },
  },
  brand_lead: {
    key: 'brand_lead', name: 'Brand lead', description: 'Brand assets, brand templates and locked fields, websites and social content.',
    primaryWorkspace: 'marketing', defaultScope: 'organization', networkOnly: true,
    grants: {
      'marketing.brand_assets': VEP, 'network.templates': VEP, 'marketing.website_builder': VEP, 'marketing.social': VE, 'marketing.campaigns': V, 'network.locations': V,
      ...everyone, 'settings.ai': V,
    },
  },
  digital_marketer: {
    key: 'digital_marketer', name: 'Digital marketer', description: 'Websites, social, ads, email and network campaigns. No operations, customers or finance.',
    primaryWorkspace: 'marketing', defaultScope: 'organization',
    grants: {
      'marketing.website_builder': VEP, 'marketing.social': VEP, 'marketing.ads': ALL, 'marketing.network_campaigns': ALL, 'marketing.email': VE, 'marketing.automations': VE,
      'marketing.campaigns': VEP, 'network.locations': V, 'network.reports': V, ...everyone, 'settings.ai': V,
    },
  },
  instructor_trainer: {
    key: 'instructor_trainer', name: 'Instructor-trainer', description: 'Teacher training courses and course leads, plus read-only operations to see classes.',
    primaryWorkspace: 'training', defaultScope: 'organization', networkOnly: true,
    grants: { 'training.*': ALL, 'sales.course_leads': VE, 'operations.*': V, 'community.*': V, 'settings.ai': V },
  },
  operations_manager: {
    key: 'operations_manager', name: 'Operations manager', description: 'Payments and finance, websites, connections, customers and day-to-day operations.',
    primaryWorkspace: 'operations', defaultScope: 'organization',
    grants: {
      'finance.payments': VEX, 'finance.royalties': V, 'marketing.website_builder': VEP, 'settings.connections': VE, 'network.locations': VE, 'network.approvals': ['view', 'publish'],
      'network.reports': ['view', 'export'], 'sales.customers': VEX, 'sales.customer_pipeline': ALL, 'operations.*': VE, ...everyone, 'settings.ai': V,
    },
  },
  finance: {
    key: 'finance', name: 'Finance', description: 'Payments, refunds, reconciliation and financial reports. Royalties and payouts at HQ level.',
    primaryWorkspace: 'finance', defaultScope: 'organization',
    grants: { 'finance.*': ALL, 'network.reports': ['view', 'export'], 'network.approvals': V },
  },
  legal: {
    key: 'legal', name: 'Legal', description: 'Franchise agreements, disclosure and compliance across the network.',
    primaryWorkspace: 'legal', defaultScope: 'organization', networkOnly: true,
    grants: { 'legal.*': ALL, 'sales.franchise_pipeline': V, 'network.franchisees': V, 'network.locations': V, 'settings.ai': V },
  },
  regional_manager: {
    key: 'regional_manager', name: 'Regional manager', description: 'Oversight of the locations in a region: operations, reports, website approvals and campaign drafts.',
    primaryWorkspace: 'network', defaultScope: 'region', networkOnly: true,
    grants: {
      'network.locations': V, 'network.onboarding': V, 'network.approvals': ['view', 'publish'], 'network.reports': ['view', 'export'], 'marketing.campaigns': VE, 'marketing.website_builder': V,
      'operations.*': V, ...everyone, 'settings.ai': V,
    },
  },
  franchise_owner: {
    key: 'franchise_owner', name: 'Franchise owner', description: 'The full dashboard for their own locations: operations, marketing, customers, payments and their team. Nothing from other franchisees or HQ-private areas.',
    primaryWorkspace: 'operations', defaultScope: 'owner_group', networkOnly: true,
    grants: {
      'network.locations': V, 'network.onboarding': VE, 'network.approvals': V, 'network.reports': ['view', 'export'],
      'marketing.website_builder': VEP, 'marketing.campaigns': VEP, 'marketing.email': VEP, 'marketing.automations': VEP, 'marketing.social': VEP, 'marketing.ads': ALL, 'marketing.brand_assets': V,
      'sales.customers': VEX, 'sales.customer_pipeline': ALL, 'operations.*': VE, 'finance.payments': VEX,
      'settings.team': VE, 'settings.connections': V, 'settings.ai': V, ...everyone,
    },
  },
  location_manager: {
    key: 'location_manager', name: 'Location manager', description: 'Runs a location day to day: operations, customers, the local website and campaign drafts.',
    primaryWorkspace: 'operations', defaultScope: 'location',
    grants: {
      'network.locations': V, 'network.approvals': V, 'network.reports': V, 'marketing.website_builder': VEP, 'marketing.campaigns': VE,
      'sales.customers': VE, 'sales.customer_pipeline': VE, 'operations.*': VE, 'finance.payments': V, 'settings.ai': V, ...everyone,
    },
  },
  staff: {
    key: 'staff', name: 'Staff', description: 'Their assigned work: schedules, attendance and orders at their location.',
    primaryWorkspace: 'operations', defaultScope: 'location',
    grants: { 'operations.*': VE, ...everyone },
  },
  marketing_contributor: {
    key: 'marketing_contributor', name: 'Marketing contributor', description: 'Drafts website and campaign changes; publishing needs someone with publish rights.',
    primaryWorkspace: 'marketing', defaultScope: 'location',
    grants: { 'marketing.website_builder': VE, 'marketing.campaigns': VE, 'marketing.email': VE, 'marketing.social': VE, 'settings.ai': V },
  },
  customer: {
    key: 'customer', name: 'Customer', description: 'Their own bookings, orders and preferences in the customer app.', primaryWorkspace: 'operations', defaultScope: 'location', hidden: true,
    grants: {},
  },
};

/** System roles offered when inviting, in display order. */
export const TEAM_ROLE_ORDER: readonly Role[] = [
  'org_owner', 'hq_admin', 'vp_franchise', 'cmo', 'brand_lead', 'digital_marketer', 'instructor_trainer', 'operations_manager', 'finance', 'legal',
  'regional_manager', 'franchise_owner', 'location_manager', 'staff', 'marketing_contributor',
];

/** Capabilities of a system role for an industry (before scope filtering and overrides). */
export function templateCapabilities(role: Role | string, industry: Industry | string): Set<Capability> {
  const t = ROLE_TEMPLATES[role as Role];
  return t ? expandGrants(t.grants, industry) : new Set();
}

/**
 * Legacy permission sets per role, derived from the templates (industry-independent: every industry has
 * Operations modules). `test/access.test.ts` pins these to the original fixed lists.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = Object.fromEntries(
  (Object.keys(ROLE_TEMPLATES) as Role[]).map((r) => [r, [...permissionsFromCapabilities(templateCapabilities(r, 'studios'))]]),
) as unknown as Record<Role, readonly Permission[]>;

/** Client-side helper: does any assignment's role grant the permission (scope is enforced server-side). */
export function can(assignments: RoleAssignment[], permission: Permission): boolean {
  return assignments.some((a) => ROLE_PERMISSIONS[a.role]?.includes(permission));
}

/* ------------------------------------------------------------------ */
/* Effective access                                                    */
/* ------------------------------------------------------------------ */

export interface AccessInput {
  /** System role key, or `custom` with `customCapabilities`. */
  role: string;
  scopeKind: ScopeKind;
  customCapabilities?: Iterable<string> | null;
  /** Per-person overrides on this assignment. */
  grants?: Iterable<string> | null;
  revokes?: Iterable<string> | null;
}

/** The capabilities one role assignment gives, for an organisation of `industry`. */
export function effectiveCapabilities(a: AccessInput, industry: Industry | string): Set<Capability> {
  const base = a.role === 'custom' ? normalizeCapabilities(a.customCapabilities ?? [], industry) : templateCapabilities(a.role, industry);
  for (const g of normalizeCapabilities(a.grants ?? [], industry)) base.add(g);
  const revoked = new Set(a.revokes ?? []);
  // Revoking `view` removes the whole module; revoking another action removes just that action.
  const revokedModules = new Set([...revoked].map(parseCapability).filter((p) => p?.action === 'view').map((p) => p!.module));
  const kept = new Set([...base].filter((c) => !revoked.has(c) && !revokedModules.has(parseCapability(c)!.module)));
  return scopeFilter(kept, a.scopeKind, industry);
}

export interface WorkspaceView {
  key: WorkspaceKey;
  /** Available modules the person holds in this workspace. */
  modules: string[];
}

/**
 * Workspaces a person sees: those where they hold at least one *available* module. Planned modules never make a
 * workspace appear (no placeholders).
 */
export function workspacesFor(caps: ReadonlySet<string>, industry: Industry | string): WorkspaceView[] {
  const avail = modulesFor(industry).filter((m) => m.status === 'available');
  const out: WorkspaceView[] = [];
  for (const w of WORKSPACES) {
    const modules = avail.filter((m) => m.area === w && caps.has(capability(m.key, 'view'))).map((m) => m.key);
    if (modules.length) out.push({ key: w, modules });
  }
  return out;
}

/** Settings modules (shown under every workspace) the person holds. */
export function settingsModulesFor(caps: ReadonlySet<string>, industry: Industry | string): string[] {
  return modulesFor(industry).filter((m) => m.area === 'settings' && m.status === 'available' && caps.has(capability(m.key, 'view'))).map((m) => m.key);
}

/** Landing workspace: the first role's primary workspace when visible, otherwise the first visible one. */
export function primaryWorkspace(roles: readonly { role: string; primaryWorkspace?: WorkspaceKey | null }[], visible: readonly WorkspaceKey[]): WorkspaceKey | null {
  for (const r of roles) {
    const w = r.primaryWorkspace ?? ROLE_TEMPLATES[r.role as Role]?.primaryWorkspace;
    if (w && visible.includes(w)) return w;
  }
  return visible[0] ?? null;
}

/** Summary of a person's access in one organisation, as returned by the API (`/auth/me`, `/orgs/:id/access/me`). */
export interface AccessSummary {
  /** Union of capabilities across all the person's assignments (scope still applies per assignment). */
  capabilities: Capability[];
  workspaces: WorkspaceView[];
  settings: string[];
  primaryWorkspace: WorkspaceKey | null;
}

export function accessSummary(caps: ReadonlySet<Capability>, industry: Industry | string, roles: readonly { role: string; primaryWorkspace?: WorkspaceKey | null }[]): AccessSummary {
  const workspaces = workspacesFor(caps, industry);
  return {
    capabilities: [...caps].sort(),
    workspaces,
    settings: settingsModulesFor(caps, industry),
    primaryWorkspace: primaryWorkspace(roles, workspaces.map((w) => w.key)),
  };
}

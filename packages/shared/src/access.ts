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
import { PERMISSIONS, SENSITIVE_CLASSES, canonicalRole, type Permission, type Role, type RoleAssignment, type ScopeKind, type SensitiveClass } from './permissions.ts';

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
  /**
   * HQ-private module that a territory (sub-network) also runs for itself: effective on territory assignments too,
   * filtered to the territory's records (master franchisees, area developers). Franchise agreements and Disclosure are
   * not in any partner template: HQ grants them to a territory explicitly (its prospects, owner groups and country).
   */
  territoryOk?: boolean;
  /** Franchise / multi-location only: independent businesses never see it. */
  networkOnly?: boolean;
  /** Sensitive data the module exposes; the API filters these fields by capability. */
  sensitive?: SensitiveClass;
  /** Operations modules: the industry screens (dashboard route keys) the module covers. */
  screens?: readonly string[];
  /**
   * Only granted by name: area wildcards (`operations.*`) and the legacy `operations.read/write` permissions never
   * include it (e.g. audits are not part of every Operations role).
   */
  explicitGrant?: boolean;
  /**
   * Screen-level sub-module (see SCREEN_MODULES): the module whose front-line screens this management screen sits
   * beside. Holding the parent never implies the sub-module; `operations.*` grants include both.
   */
  parent?: string;
}

const V = ['view'] as const;
const VE = ['view', 'edit'] as const;
const VEP = ['view', 'edit', 'publish'] as const;
const VEX = ['view', 'edit', 'export'] as const;
const ALL = ['view', 'edit', 'publish', 'export'] as const;

/* ------------------------------------------------------------------ */
/* Field audits, compliance documents and the league table             */
/* ------------------------------------------------------------------ */

/**
 * Network quality modules (one block, appended after the other Operations, Legal & compliance and Network modules):
 * - `operations.audits`: checklist templates, scheduled audits, scoring, corrective actions and re-audits. Granted by
 *   name only (never through `operations.*`), so staff and read-only Operations roles don't get it.
 * - `legal.compliance_documents`: certificates of insurance, licences, permits and health certificates per location or
 *   owner group, HQ requirements, the compliance matrix and expiry reminders. Franchisees upload their own.
 * - `network.league_table`: locations ranked by revenue (per currency), growth, activity, audit score and royalty
 *   status. Franchise owners see their own locations against anonymised network quartiles.
 */
export const QUALITY_MODULES: readonly ModuleDef[] = [
  {
    key: 'operations.audits', area: 'operations', name: 'Audits', description: 'Field visits and audits: checklist templates, scheduled audits with photos and scores, corrective actions and re-audits for the locations in scope.',
    actions: ['view', 'edit', 'publish', 'export'], actionNotes: { view: 'See audit reports for the locations in scope.', edit: 'Conduct audits assigned to you and complete corrective actions.', publish: 'Manage checklist templates, schedule audits and verify corrective actions.', export: 'Download audit results.' },
    networkOnly: true, status: 'available', explicitGrant: true,
  },
  {
    key: 'legal.compliance_documents', area: 'legal', name: 'Compliance documents', description: 'Certificates of insurance, licences, permits and health certificates per location or owner group, with expiry reminders.',
    actions: ['view', 'edit', 'publish', 'export'], actionNotes: { edit: 'Upload documents for the locations in scope.', publish: 'Set requirements and approve or reject uploads.', export: 'Download the compliance matrix.' },
    networkOnly: true, status: 'available', sensitive: 'legal',
  },
  {
    key: 'network.league_table', area: 'network', name: 'League table', description: 'Locations in scope ranked by revenue, growth, bookings or orders, audit score and royalty status. Franchise owners see their own locations against anonymised network quartiles.',
    actions: ['view', 'publish', 'export'], actionNotes: { publish: 'Decide whether franchise owners see network quartiles.' }, networkOnly: true, status: 'available',
  },
];

/** Modules every business account has, whatever its industry. */
export const CORE_MODULES: readonly ModuleDef[] = [
  // Network (HQ)
  { key: 'network.locations', area: 'network', name: 'Locations', description: 'The location directory: addresses, opening hours, status and local details.', actions: VE, status: 'available' },
  { key: 'network.onboarding', area: 'network', name: 'New locations', description: 'Onboarding checklists, pre-opening checks and go-live requests for new locations. Franchise owners see the projects of their own locations and their own franchise agreement.', actions: VE, actionNotes: { edit: 'Complete checklist tasks and ask HQ to approve the opening.' }, networkOnly: true, status: 'available' },
  { key: 'network.franchisees', area: 'network', name: 'Franchisees & owner groups', description: 'Franchise owners, their companies and which locations they run.', actions: VE, networkOnly: true, status: 'planned', hqOnly: true, territoryOk: true },
  { key: 'network.approvals', area: 'network', name: 'Approvals', description: 'Requests waiting for a decision: refunds over the limit, local ad spend, shift swaps and website changes.', actions: ['view', 'publish'], actionNotes: { publish: 'Approve or reject website changes from locations.' }, status: 'available' },
  { key: 'network.reports', area: 'network', name: 'Reports', description: 'Performance reports for the locations in scope. Revenue figures also need Payments.', actions: ['view', 'export'], status: 'available' },
  { key: 'network.templates', area: 'network', name: 'Brand templates & policies', description: 'Website templates, locked brand fields and business policies set by HQ.', actions: VEP, status: 'available' },
  // Operations: shared across industries (industry modules are added per industry below)
  { key: 'operations.schedule', area: 'operations', name: 'Staff schedule', description: 'Shifts, clock-in and shift swaps.', actions: VE, status: 'available' },
  // Sales
  { key: 'sales.customers', area: 'sales', name: 'Customers', description: 'Customer records with contact details and history (personal data).', actions: VEX, status: 'available', sensitive: 'personal_data' },
  { key: 'sales.customer_pipeline', area: 'sales', name: 'Leads & enquiries', description: 'New enquiries, the customer sales pipeline (deals, tasks, activities) and lead routing.', actions: ALL, actionNotes: { publish: 'Change lead routing rules and pipeline stages.' }, status: 'available', sensitive: 'personal_data' },
  { key: 'sales.franchise_pipeline', area: 'sales', name: 'Franchise pipeline', description: 'Franchise enquiries, qualification, disclosure and agreement steps, territories and new-location deals.', actions: ALL, networkOnly: true, status: 'available', hqOnly: true, territoryOk: true, sensitive: 'personal_data' },
  { key: 'sales.course_leads', area: 'sales', name: 'Course leads', description: 'People interested in teacher training and public courses. Routed to the course’s trainers or by lead-routing rules; trainers see the leads at their locations and those assigned to them.', actions: VEX, status: 'available', sensitive: 'personal_data' },
  // Marketing
  { key: 'marketing.website_builder', area: 'marketing', name: 'Websites', description: 'Location websites: pages, approvals, publishing and domains.', actions: VEP, status: 'available' },
  { key: 'marketing.campaigns', area: 'marketing', name: 'Campaigns', description: 'Marketing campaigns and offers for the locations in scope.', actions: VEP, status: 'available' },
  { key: 'marketing.inbox', area: 'marketing', name: 'Inbox', description: 'One inbox per location for email, SMS, WhatsApp, Instagram and Messenger: replies, notes, assignment and contact segments.', actions: VEX, actionNotes: { edit: 'Reply, assign, add notes and manage segments.' }, status: 'available', sensitive: 'personal_data' },
  { key: 'marketing.email', area: 'marketing', name: 'Email', description: 'Email templates and campaigns built from blocks, sent to contact segments with consent.', actions: VEP, actionNotes: { publish: 'Send or schedule campaigns.' }, status: 'available' },
  { key: 'marketing.automations', area: 'marketing', name: 'Automations', description: 'Automatic journeys: trigger, conditions and actions.', actions: VEP, actionNotes: { edit: 'Build, test and switch journeys on or off.' }, status: 'available' },
  { key: 'marketing.forms', area: 'marketing', name: 'Forms & landing pages', description: 'Website forms and sign-ups that create leads (routed by the lead rules), record consent and start automations.', actions: VEP, status: 'available' },
  { key: 'marketing.social', area: 'marketing', name: 'Social', description: 'Social posts and scheduling on brand accounts.', actions: VEP, actionNotes: { publish: 'Approve local posts, connect accounts and hand over posting rights.' }, status: 'available' },
  { key: 'marketing.ads', area: 'marketing', name: 'Ads', description: 'Paid ad campaigns and budgets.', actions: ALL, status: 'available' },
  { key: 'marketing.network_campaigns', area: 'marketing', name: 'Network campaigns', description: 'Campaigns HQ runs for all locations, including coming-soon locations.', actions: ALL, status: 'available', hqOnly: true },
  { key: 'marketing.brand_assets', area: 'marketing', name: 'Brand assets', description: 'Logos, photos, files and brand guidelines used by websites and emails.', actions: VEP, actionNotes: { edit: 'Upload and organise assets.' }, status: 'available' },
  // Marketing → Reviews (review requests, Google review monitoring and replies, rating dashboard).
  {
    key: 'marketing.reviews', area: 'marketing', name: 'Reviews',
    description: 'Review requests after visits and orders, private feedback, Google reviews with replies, and ratings per location.',
    actions: VEP, actionNotes: { edit: 'Reply to reviews (with AI suggestions) and send review requests.', publish: 'Configure review requests, review links, Google connections and reply approval.' }, status: 'available',
  },
  // Finance
  { key: 'finance.payments', area: 'finance', name: 'Payments', description: 'Transactions, refunds, reconciliation and payment accounts (financial data).', actions: VEX, actionNotes: { edit: 'Issue refunds and fix reconciliation items.' }, status: 'available', sensitive: 'finance' },
  { key: 'finance.royalties', area: 'finance', name: 'Royalties', description: 'Royalty terms, period close, statements, disputes, approval, invoicing and collection across the network.', actions: ALL, actionNotes: { edit: 'Set terms, close periods, adjust statements, resolve disputes and run collection.', publish: 'Approve statements and issue invoices.' }, status: 'available', hqOnly: true, sensitive: 'finance' },
  { key: 'finance.invoices', area: 'finance', name: 'Statements & invoices', description: 'Royalty statements and invoices for the locations in scope, with disputes, external sales reports and the debit mandate.', actions: VEX, actionNotes: { edit: 'Raise disputes, report external sales, set up the debit mandate and pay invoices.' }, status: 'available', sensitive: 'finance' },
  { key: 'finance.marketing_fund', area: 'finance', name: 'Marketing fund', description: 'Fund contributions, spend on network campaigns with receipts, balance per currency and the transparency report.', actions: VEX, actionNotes: { view: 'See the transparency report and the contributions of the locations in scope.', edit: 'Record fund spend and campaigns (organisation-wide access only).' }, status: 'available', sensitive: 'finance' },
  { key: 'finance.payouts', area: 'finance', name: 'Payouts', description: 'Payouts, fees, refunds and chargebacks per location, reconciliation and accounting exports.', actions: ALL, status: 'available', hqOnly: true, sensitive: 'finance' },
  // Legal & compliance
  { key: 'legal.agreements', area: 'legal', name: 'Franchise agreements', description: 'The agreements register, executed agreements, the legal document vault, renewals and expiries.', actions: ALL, networkOnly: true, status: 'available', hqOnly: true, territoryOk: true, sensitive: 'legal' },
  { key: 'legal.disclosure', area: 'legal', name: 'Disclosure & jurisdiction rules', description: 'Disclosure documents, registrations and the jurisdiction rules (waiting and cooling-off periods) per jurisdiction.', actions: ALL, actionNotes: { publish: 'Record franchise counsel’s review of a jurisdiction rule.' }, networkOnly: true, status: 'available', hqOnly: true, territoryOk: true, sensitive: 'legal' },
  // Training
  { key: 'training.academy', area: 'training', name: 'Academy', description: 'Courses, lessons, quizzes and certificates for staff and franchisees, and public courses sold on the brand site.', actions: ALL, actionNotes: { view: 'Take courses and earn certificates.', edit: 'Write courses (your own and co-taught).', publish: 'Manage every course, learning path and certificate.', export: 'Training reports.' }, status: 'available' },
  { key: 'training.assignments', area: 'training', name: 'Assignments & progress', description: 'Assign courses to the people in your scope and follow their progress.', actions: VE, status: 'available' },
  // Community
  { key: 'community.announcements', area: 'community', name: 'Announcements', description: 'News and required reads from HQ to the network, with read receipts.', actions: VEP, actionNotes: { publish: 'Send announcements (within your own scope unless organisation-wide).' }, status: 'available' },
  { key: 'community.discussions', area: 'community', name: 'Discussions & events', description: 'Discussion spaces, events and private coaching threads between HQ and franchisees.', actions: VEP, actionNotes: { edit: 'Post and reply.', publish: 'Moderate; organisation-wide also manages spaces, events and account managers.' }, status: 'available' },
  { key: 'community.library', area: 'community', name: 'Resource library', description: 'Manuals, brand files and how-tos shared with the network.', actions: VE, actionNotes: { edit: 'Manage folders and files.' }, status: 'available' },
  { key: 'community.help_desk', area: 'community', name: 'Help desk', description: 'Questions and support requests from locations to HQ.', actions: VE, actionNotes: { view: 'Raise and follow your own requests.', edit: 'Answer requests as an HQ agent.' }, status: 'available' },
  // Settings (under every workspace)
  { key: 'settings.business', area: 'settings', name: 'Business settings', description: 'Business details, defaults, data sharing and AI preferences.', actions: VE, status: 'available' },
  { key: 'settings.team', area: 'settings', name: 'Team & access', description: 'Invite people and decide what each person can see.', actions: VE, status: 'available' },
  { key: 'settings.connections', area: 'settings', name: 'Connections', description: 'Connected systems and their sync health.', actions: VE, status: 'available' },
  { key: 'settings.billing', area: 'settings', name: 'Billing', description: 'Your BranchHarbor plan and invoices.', actions: VE, status: 'available', hqOnly: true, sensitive: 'finance' },
  { key: 'settings.audit', area: 'settings', name: 'Audit log', description: 'Who changed what, and when.', actions: V, status: 'available' },
  { key: 'settings.ai', area: 'settings', name: 'AI assistant', description: 'Ask BranchHarbor AI about the data this person can already see. It only drafts and proposes.', actions: V, status: 'available' },
  // Field audits, compliance documents and the league table (see QUALITY_MODULES).
  ...QUALITY_MODULES,
];

const ops = (key: string, name: string, description: string, screens: readonly string[], status: ModuleDef['status'] = 'available'): ModuleDef => ({
  key: `operations.${key}`, area: 'operations', name, description, actions: VE, status, screens,
});

/** Industry operations modules. The industry chosen at sign-up decides which of these an account has. */
export const INDUSTRY_MODULES: Record<Industry, readonly ModuleDef[]> = {
  studios: [
    ops('classes', 'Classes & schedule', 'Class timetable, bookings, check-in, attendance and cover. The schedule builder and rooms are their own screens (below).', ['classes', 'cover']),
    ops('memberships', 'Members & pricing', 'Members, memberships and on-demand classes. Pricing, packs and offers are their own screen (below).', ['members', 'online']),
    ops('studio_insights', 'Studio insights', 'Occupancy, attendance and churn.', ['insights']),
  ],
  sports: [
    ops('programmes', 'Programmes & registrations', 'Seasons, programmes, registrations and balances.', ['overview', 'programmes', 'registrations', 'balances']),
    ops('teams', 'Teams & sessions', 'Teams, attendance, announcements and guardians. The schedule builder is its own screen (below).', ['teams', 'attendance', 'announcements', 'guardians']),
    ops('sports_reports', 'Sports reports', 'Enrolment and attendance reports.', ['reports']),
  ],
  wellness: [
    ops('appointments', 'Appointments', 'The appointment calendar. Practitioners and their hours are their own screen (below).', ['calendar']),
    ops('services', 'Services & packages', 'Services, packages, gift vouchers and intake forms.', ['services', 'packages', 'forms']),
    ops('clients', 'Clients', 'Client history, preferences and notes.', ['clients']),
    ops('wellness_insights', 'Wellness insights', 'Utilisation, cancellations and revenue.', ['insights']),
  ],
  commerce: [
    ops('orders', 'Orders', 'Orders, returns and gift cards.', ['pulse', 'orders', 'returns', 'giftcards']),
    ops('catalogue', 'Catalogue', 'Products, assortment per location and the online store.', ['catalogue', 'assortment', 'storefront']),
    ops('inventory', 'Inventory', 'Stock levels and counts. Transfers and purchasing are their own screen (below).', ['inventory']),
    ops('commerce_insights', 'Commerce insights', 'Sales and stock reports.', ['insights']),
  ],
  foods: [
    ops('menu', 'Menu', 'Menus, item builder, availability and ingredients.', ['menu', 'builder', 'availability', 'ingredients']),
    ops('food_orders', 'Orders & kitchen', 'Orders, kitchen display, pickup, delivery and tables. Catering and meal plans are their own screen (below).', ['orders', 'kitchen', 'pickup', 'delivery', 'tables']),
    ops('ordering_settings', 'Ordering settings', 'Online ordering rules per location.', ['ordering']),
    ops('food_reports', 'Food reports', 'Sales, prep times and waste.', ['foodreports']),
  ],
  realty: [
    ops('listings', 'Listings', 'Listings and approvals. Portal feeds are their own screen (below).', ['pulse', 'listings']),
    ops('enquiries', 'Enquiries & viewings', 'Enquiries, viewings and offers.', ['enquiries', 'viewings', 'offers']),
    ops('agents', 'Agents & offices', 'Look up agents and offices. Managing them is its own screen (below).', []),
  ],
  hospitality: [
    ops('reservations', 'Front desk & reservations', 'Today at the property, the room grid, reservations, check-in and check-out, folios and guest registration.', ['pulse', 'grid', 'reservations']),
    ops('rooms', 'Rooms & rates', 'Room types, rooms, rate plans, seasons, restrictions, taxes, policies and channel exports. Changing them also needs Locations (edit).', ['rates', 'setup', 'channels']),
    ops('housekeeping', 'Housekeeping', 'Room status and cleaning tasks.', ['housekeeping']),
    ops('outlets', 'Restaurant outlet', 'Restaurant and bar orders for guests, charged to the room.', ['outlet']),
    ops('hotel_reports', 'Hotel reports', 'Occupancy, ADR, RevPAR, pickup and cancellations per property.', ['hotelreports']),
  ],
};

/* ------------------------------------------------------------------ */
/* Screen-level sub-modules (management screens)                       */
/* ------------------------------------------------------------------ */

const screen = (parent: string, key: string, name: string, description: string, screens: readonly string[]): ModuleDef => ({
  key: `${parent}.${key}`, area: 'operations', name, description, actions: VE, status: 'available', screens, parent,
});

/**
 * Management screens that sit inside a front-line Operations module, as their own capabilities. Staff hold the
 * front-line module (classes, check-in, kitchen orders…) but not these; `operations.*` (location manager, franchise
 * owner, operations lead and above) includes them. The API enforces them on changes (services/module-guard.ts
 * `OPS_SUB_ROUTES`); reads stay with the parent module, because front-line screens look up rooms, class types and
 * agents. Reports are already modules of their own (`operations.studio_insights`, `sports_reports`…).
 */
export const SCREEN_MODULES: Record<Industry, readonly ModuleDef[]> = {
  studios: [
    screen('operations.classes', 'schedule_builder', 'Schedule builder', 'Recurring class series, class types and booking policies.', ['schedule']),
    screen('operations.classes', 'rooms', 'Rooms', 'Rooms per location, their capacity and features.', ['rooms']),
    screen('operations.memberships', 'packs_offers', 'Pricing, packs & offers', 'Membership plans, class packs and introductory offers.', ['pricing', 'offers']),
  ],
  sports: [
    screen('operations.teams', 'schedule_builder', 'Schedule builder', 'Season schedules, schedule proposals and venues.', ['schedule']),
  ],
  wellness: [
    screen('operations.appointments', 'practitioners', 'Practitioners & hours', 'Practitioners, their working hours, and rooms or equipment.', ['practitioners']),
  ],
  commerce: [
    screen('operations.inventory', 'purchasing', 'Transfers & purchasing', 'Stock transfers between locations, purchase orders and suppliers.', ['transfers', 'purchasing']),
  ],
  foods: [
    screen('operations.food_orders', 'catering', 'Catering & meal plans', 'Catering menus and events, meal plans and production dates, delivery zones and providers.', ['catering', 'mealplans']),
  ],
  realty: [
    screen('operations.listings', 'portals', 'Portal feeds', 'Which listings go to which property portals.', ['portals']),
    screen('operations.agents', 'manage', 'Manage agents & offices', 'Add and change agents and offices.', ['agents']),
  ],
  hospitality: [],
};

/** Every Operations module of an industry, including its screen-level sub-modules. */
export function industryModules(industry: Industry | string): ModuleDef[] {
  return [...(INDUSTRY_MODULES[industry as Industry] ?? []), ...(SCREEN_MODULES[industry as Industry] ?? [])];
}

/** Every module an organisation of this industry has (core + its industry's operations modules). */
export function modulesFor(industry: Industry | string): ModuleDef[] {
  return [...CORE_MODULES, ...(INDUSTRY_MODULES[industry as Industry] ?? []), ...(SCREEN_MODULES[industry as Industry] ?? [])];
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
    const targets = key === '*' ? mods : key.endsWith('.*') ? mods.filter((m) => m.area === key.slice(0, -2) && !m.explicitGrant) : mods.filter((m) => m.key === key);
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

/**
 * Drops HQ-private modules unless the assignment covers the whole organisation; a territory (sub-network) keeps the
 * HQ-private modules it runs for itself (`territoryOk`).
 */
export function scopeFilter(caps: Set<Capability>, scopeKind: ScopeKind, industry: Industry | string): Set<Capability> {
  if (scopeKind === 'organization') return caps;
  const hq = new Set(modulesFor(industry).filter((m) => m.hqOnly && !(scopeKind === 'territory' && m.territoryOk)).map((m) => m.key));
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
  'community.read': ['community.announcements:view', 'community.discussions:view', 'community.library:view'],
  'community.post': ['community.discussions:edit'],
  'community.announce': ['community.announcements:publish'],
  'community.moderate': ['community.discussions:publish'],
  'community.manage': ['community.discussions:publish'],
  'library.manage': ['community.library:edit'],
  'training.learn': ['training.academy:view'],
  'training.author': ['training.academy:edit'],
  'training.manage': ['training.academy:publish'],
  'training.assign': ['training.assignments:edit'],
  'courseleads.read': ['sales.course_leads:view'],
  'courseleads.edit': ['sales.course_leads:edit'],
  'helpdesk.raise': ['community.help_desk:view'],
  'helpdesk.agent': ['community.help_desk:edit'],
  'website.design': ['network.templates:edit'],
  'email.draft': ['marketing.email:edit'],
  'email.send': ['marketing.email:publish'],
  'automations.manage': ['marketing.automations:edit'],
  'forms.manage': ['marketing.forms:edit'],
  'assets.manage': ['marketing.brand_assets:edit'],
};

/** Modules only granted by name: never matched by `area.*` wildcards. */
const EXPLICIT_GRANT_MODULES = new Set(CORE_MODULES.filter((m) => m.explicitGrant).map((m) => m.key));

function holds(caps: ReadonlySet<string>, pattern: string): boolean {
  if (!pattern.includes('*')) return caps.has(pattern);
  const [mod, action] = pattern.split(':') as [string, string];
  const prefix = mod.slice(0, -1); // "operations."
  for (const c of caps) if (c.startsWith(prefix) && c.endsWith(`:${action}`) && !EXPLICIT_GRANT_MODULES.has(c.slice(0, -action.length - 1))) return true;
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

/**
 * Teams the templates are grouped by. Templates are starting points, not an org chart: a small team combines them
 * (a person can hold several roles, access is the union), renames them, or builds its own roles from modules.
 */
export const ROLE_TEAMS = ['leadership', 'development', 'sales', 'marketing', 'operations', 'finance', 'legal', 'training', 'partners', 'locations', 'other'] as const;
export type RoleTeam = (typeof ROLE_TEAMS)[number];

export interface RoleTemplate {
  key: Role;
  name: string;
  description: string;
  team: RoleTeam;
  /** Where the person lands after signing in. */
  primaryWorkspace: WorkspaceKey;
  /** Typical scope when assigning this role. */
  defaultScope: ScopeKind;
  /** Only offered to networks (franchise / multi-location roles). */
  networkOnly?: boolean;
  /** Not offered when inviting team members. */
  hidden?: boolean;
  /**
   * Support role (field consultant, area representative, auditor): views and supports locations it doesn't own. Its
   * template never includes a sensitive data class (finance, legal, personal data); those need an explicit grant.
   */
  support?: boolean;
  grants: GrantSpec;
}

/** Everyone in a business (docs/PRODUCT_PLAN.md): read the community and take part, learn, ask HQ for help. */
const everyone: GrantSpec = { 'training.academy': V, 'community.*': V, 'community.discussions': VE };

/**
 * Capability keys of modules other features are building (the module is added to the catalogue when it ships). Templates
 * may name them; until the module exists, `expandGrants` ignores the key, so the grant is harmless.
 */
export const PENDING_MODULES = ['operations.audits'] as const;
/** Audits (Operations): run checklists and visits at locations. Key reserved here; the audits feature defines the module. */
export const AUDITS_MODULE = 'operations.audits';

/** What sales sells, per industry: memberships and packs, packages, registrations or enquiries. */
const SALES_PRODUCTS = ['operations.memberships', 'operations.memberships.packs_offers', 'operations.services', 'operations.programmes', 'operations.enquiries'] as const;
/**
 * Front-line operations for staff, per industry: classes and check-in, team sessions, appointments and the clients
 * they see, store orders and stock, kitchen orders, the front desk and housekeeping, listings and enquiries.
 */
const STAFF_FRONTLINE = [
  'operations.classes', 'operations.teams', 'operations.appointments', 'operations.clients', 'operations.orders', 'operations.inventory', 'operations.food_orders',
  'operations.reservations', 'operations.housekeeping', 'operations.listings', 'operations.enquiries', 'operations.agents',
] as const;
/** What staff look up but don't change: registrations, the catalogue, the menu and ordering hours. */
const STAFF_LOOKUP = ['operations.programmes', 'operations.catalogue', 'operations.menu', 'operations.ordering_settings'] as const;
const each = (keys: readonly string[], actions: readonly AccessAction[]): GrantSpec => Object.fromEntries(keys.map((k) => [k, actions]));

/** Franchise owners: the full dashboard for their own locations (also the base of area developers and multi-unit operators). */
const ownerGrants: GrantSpec = {
  'network.locations': V, 'network.onboarding': VE, 'network.approvals': V, 'network.reports': ['view', 'export'],
  'marketing.website_builder': VEP, 'marketing.campaigns': VEP, 'marketing.email': VEP, 'marketing.automations': VEP, 'marketing.social': VEP, 'marketing.ads': ALL, 'marketing.brand_assets': VE, 'marketing.inbox': VEX, 'marketing.forms': VEP, 'marketing.reviews': VEP,
  'sales.customers': VEX, 'sales.customer_pipeline': ALL, 'operations.*': VE, 'finance.payments': VEX, 'finance.invoices': VEX, 'finance.marketing_fund': V,
  'settings.team': VE, 'settings.connections': V, 'settings.ai': V, ...everyone, 'training.assignments': VE,
  // Field audits, compliance documents and the league table (own locations; network quartiles, never other franchisees).
  [AUDITS_MODULE]: VEX, 'legal.compliance_documents': VE, 'network.league_table': ['view', 'export'],
};

/** Support roles: see and support locations, coach, run audits. Never finance, legal or customers' personal data. */
const supportGrants: GrantSpec = {
  // Audits are granted by name (`operations.*` never includes them).
  'network.locations': V, 'network.onboarding': V, 'network.approvals': V, 'network.reports': V, 'operations.*': V, [AUDITS_MODULE]: VE, 'network.league_table': V,
  ...everyone, 'community.help_desk': VE, 'training.assignments': VE, 'settings.ai': V,
};

export const ROLE_TEMPLATES: Record<Role, RoleTemplate> = {
  // ── Leadership ──
  org_owner: {
    key: 'org_owner', name: 'Owner', team: 'leadership', description: 'Everything, including billing, ownership and who has access.', primaryWorkspace: 'network', defaultScope: 'organization',
    grants: { '*': ALL },
  },
  hq_admin: {
    key: 'hq_admin', name: 'HQ admin', team: 'leadership', description: 'Runs the network: locations, brand templates, websites, marketing, approvals, reports, team and connections. No customer records or payments.',
    primaryWorkspace: 'network', defaultScope: 'organization', networkOnly: true,
    grants: {
      'network.locations': VE, 'network.franchisees': VE, 'network.onboarding': VE, 'network.templates': VEP, 'network.approvals': ['view', 'publish'], 'network.reports': ['view', 'export'],
      'marketing.*': ALL, 'operations.*': V, 'settings.team': VE, 'settings.connections': VE, 'settings.audit': V, 'settings.ai': V, 'training.*': ALL, 'community.*': ALL,
      // Field audits, compliance documents and the league table.
      'operations.audits': ALL, 'legal.compliance_documents': ALL, 'network.league_table': ['view', 'publish', 'export'],
    },
  },
  // ── Franchise development ──
  development_lead: {
    key: 'development_lead', name: 'Development lead', team: 'development', description: 'Franchise development: the franchise pipeline and territories, disclosure and agreements, and new locations. No customer sales.',
    primaryWorkspace: 'sales', defaultScope: 'organization', networkOnly: true,
    grants: {
      'sales.franchise_pipeline': ALL, 'legal.disclosure': VE, 'legal.agreements': VE, 'network.locations': V, 'network.franchisees': VE, 'network.onboarding': VE, 'network.reports': V,
      ...everyone, 'settings.ai': V,
    },
  },
  development_rep: {
    key: 'development_rep', name: 'Development rep', team: 'development', description: 'Works franchise enquiries through the pipeline and sends disclosure. Agreements and approvals stay with the lead.',
    primaryWorkspace: 'sales', defaultScope: 'organization', networkOnly: true,
    grants: { 'sales.franchise_pipeline': VE, 'legal.disclosure': V, 'network.onboarding': V, 'network.locations': V, ...everyone, 'settings.ai': V },
  },
  // ── Sales ──
  sales_lead: {
    key: 'sales_lead', name: 'Sales lead', team: 'sales', description: 'Customer sales: leads and deals, routing rules, customers, memberships and packages, and course leads.',
    primaryWorkspace: 'sales', defaultScope: 'organization',
    grants: {
      'sales.customers': VEX, 'sales.customer_pipeline': ALL, 'sales.course_leads': VEX, ...each(SALES_PRODUCTS, VE), 'marketing.inbox': VE, 'marketing.forms': V,
      'network.locations': V, 'network.reports': V, ...everyone, 'settings.ai': V,
    },
  },
  sales_rep: {
    key: 'sales_rep', name: 'Sales rep', team: 'sales', description: 'Works leads and deals, follows up customers and course leads, and sells memberships and packages.',
    primaryWorkspace: 'sales', defaultScope: 'organization',
    grants: { 'sales.customers': VE, 'sales.customer_pipeline': VE, 'sales.course_leads': VE, ...each(SALES_PRODUCTS, V), 'marketing.inbox': VE, 'network.locations': V, ...everyone, 'settings.ai': V },
  },
  // ── Marketing ──
  marketing_lead: {
    key: 'marketing_lead', name: 'Marketing lead', team: 'marketing', description: 'All marketing across the network, brand templates, announcements, marketing reports and the marketing fund report.',
    primaryWorkspace: 'marketing', defaultScope: 'organization', networkOnly: true,
    grants: {
      'marketing.*': ALL, 'network.templates': VEP, 'network.reports': ['view', 'export'], 'network.approvals': V, 'network.locations': V, 'sales.customer_pipeline': V, 'finance.marketing_fund': V,
      ...everyone, 'community.announcements': VEP, 'settings.ai': V,
    },
  },
  brand_manager: {
    key: 'brand_manager', name: 'Brand manager', team: 'marketing', description: 'Brand assets, brand templates and locked fields, websites and social content.',
    primaryWorkspace: 'marketing', defaultScope: 'organization', networkOnly: true,
    grants: {
      'marketing.brand_assets': VEP, 'network.templates': VEP, 'marketing.website_builder': VEP, 'marketing.social': VE, 'marketing.campaigns': V, 'marketing.email': V, 'network.locations': V,
      ...everyone, 'settings.ai': V,
    },
  },
  digital_marketer: {
    key: 'digital_marketer', name: 'Digital marketer', team: 'marketing', description: 'Websites, social, ads, email and network campaigns. No operations, customers or finance.',
    primaryWorkspace: 'marketing', defaultScope: 'organization',
    grants: {
      'marketing.website_builder': VEP, 'marketing.social': VEP, 'marketing.ads': ALL, 'marketing.network_campaigns': ALL, 'marketing.email': VEP, 'marketing.automations': VEP, 'marketing.inbox': VE,
      'marketing.forms': VEP, 'marketing.brand_assets': V, 'marketing.reviews': VEP,
      'marketing.campaigns': VEP, 'network.locations': V, 'network.reports': V, ...everyone, 'settings.ai': V,
    },
  },
  content_social: {
    key: 'content_social', name: 'Content & social', team: 'marketing', description: 'Drafts posts, emails, website pages and campaigns; publishing needs someone with publish rights.',
    primaryWorkspace: 'marketing', defaultScope: 'organization',
    grants: { 'marketing.website_builder': VE, 'marketing.campaigns': VE, 'marketing.email': VE, 'marketing.social': VE, 'marketing.inbox': V, 'marketing.forms': VE, 'marketing.brand_assets': VE, 'marketing.reviews': VE, ...everyone, 'settings.ai': V },
  },
  // ── Operations ──
  operations_lead: {
    key: 'operations_lead', name: 'Operations lead', team: 'operations', description: 'Day-to-day operations across the network: locations, approvals, new locations, audits, support and the help desk. No finance.',
    primaryWorkspace: 'operations', defaultScope: 'organization',
    grants: {
      'operations.*': VE, 'network.locations': VE, 'network.onboarding': VE, 'network.approvals': ['view', 'publish'], 'network.reports': ['view', 'export'], 'sales.customers': V,
      ...everyone, 'community.announcements': VEP, 'community.discussions': VEP, 'community.help_desk': VE, 'community.library': VE, 'training.assignments': VE, 'settings.connections': VE, 'settings.ai': V,
      // Field audits, compliance documents and the league table.
      [AUDITS_MODULE]: ALL, 'legal.compliance_documents': ALL, 'network.league_table': ['view', 'export'],
    },
  },
  field_consultant: {
    key: 'field_consultant', name: 'Field consultant', team: 'operations', description: 'Business coach for a portfolio of locations: views and supports them, runs audits and coaching threads. No owner finances or customer data.',
    primaryWorkspace: 'network', defaultScope: 'portfolio', networkOnly: true, support: true,
    grants: supportGrants,
  },
  // ── Finance ──
  finance_lead: {
    key: 'finance_lead', name: 'Finance lead', team: 'finance', description: 'Payments, refunds, reconciliation, royalties, invoices, the marketing fund, payouts and financial reports.',
    primaryWorkspace: 'finance', defaultScope: 'organization',
    grants: { 'finance.*': ALL, 'network.reports': ['view', 'export'], 'network.approvals': ['view', 'publish'], 'network.locations': V, 'settings.billing': V, ...everyone },
  },
  accountant: {
    key: 'accountant', name: 'Accountant', team: 'finance', description: 'Reads and exports payments, statements, royalties, payouts and fund reports for the books. Changes nothing.',
    primaryWorkspace: 'finance', defaultScope: 'organization',
    grants: { 'finance.*': ['view', 'export'], 'network.reports': ['view', 'export'], 'network.locations': V, ...everyone },
  },
  // ── Legal & compliance ──
  legal_lead: {
    key: 'legal_lead', name: 'Legal lead', team: 'legal', description: 'Franchise agreements, disclosure, registrations and jurisdiction rules across the network.',
    primaryWorkspace: 'legal', defaultScope: 'organization', networkOnly: true,
    grants: { 'legal.*': ALL, 'sales.franchise_pipeline': V, 'network.franchisees': V, 'network.locations': V, ...everyone, 'settings.ai': V },
  },
  // ── Training ──
  training_lead: {
    key: 'training_lead', name: 'Training lead', team: 'training', description: 'The academy: every course, learning path and certificate, assignments and training reports.',
    primaryWorkspace: 'training', defaultScope: 'organization',
    grants: { ...everyone, 'training.*': ALL, 'community.library': VE, 'network.locations': V, 'settings.ai': V },
  },
  trainer: {
    key: 'trainer', name: 'Trainer', team: 'training', description: 'Writes and teaches courses, assigns them and follows learners’ progress.',
    primaryWorkspace: 'training', defaultScope: 'organization',
    // Trainers write their own (and co-taught) courses; managing every course is Academy publish.
    grants: { ...everyone, 'training.academy': ['view', 'edit', 'export'], 'training.assignments': VE, 'settings.ai': V },
  },
  // ── Franchise partners ──
  master_franchisee: {
    key: 'master_franchisee', name: 'Master franchisee', team: 'partners', description: 'Runs a territory (for example a country) like HQ: its locations, franchise pipeline, new locations, community, training, team and finances.',
    primaryWorkspace: 'network', defaultScope: 'territory', networkOnly: true,
    grants: {
      'network.locations': VE, 'network.onboarding': VE, 'network.approvals': ['view', 'publish'], 'network.reports': ['view', 'export'], 'network.franchisees': VE, 'sales.franchise_pipeline': ALL,
      'sales.customers': V, 'sales.customer_pipeline': V, 'marketing.campaigns': VEP, 'marketing.website_builder': VEP, 'marketing.email': VEP, 'marketing.social': VEP, 'marketing.brand_assets': V,
      'operations.*': V, [AUDITS_MODULE]: VEP, 'legal.compliance_documents': VE, 'network.league_table': ['view', 'export'], 'marketing.reviews': VEP, 'finance.payments': ['view', 'export'], 'finance.invoices': VEX, 'finance.marketing_fund': V,
      ...everyone, 'community.announcements': VEP, 'community.discussions': VEP, 'community.library': VE, 'community.help_desk': VE, 'training.academy': VE, 'training.assignments': VE,
      'settings.team': VE, 'settings.ai': V,
    },
  },
  area_developer: {
    key: 'area_developer', name: 'Area developer', team: 'partners', description: 'Owns the units of a development schedule: the full dashboard for their own units, plus the franchise pipeline of their territory.',
    primaryWorkspace: 'operations', defaultScope: 'territory', networkOnly: true,
    grants: { ...ownerGrants, 'sales.franchise_pipeline': VE },
  },
  area_representative: {
    key: 'area_representative', name: 'Area representative', team: 'partners', description: 'Supports franchisees in a territory they don’t own: views, supports and audits their locations. No owner finances unless granted.',
    primaryWorkspace: 'network', defaultScope: 'territory', networkOnly: true, support: true,
    grants: supportGrants,
  },
  multi_unit_operator: {
    key: 'multi_unit_operator', name: 'Multi-unit operator', team: 'partners', description: 'Runs an owner group with several units: the full dashboard for every unit of the group, its team and its finances.',
    primaryWorkspace: 'network', defaultScope: 'owner_group', networkOnly: true,
    grants: ownerGrants,
  },
  // ── Locations ──
  franchise_owner: {
    key: 'franchise_owner', name: 'Franchise owner', team: 'locations', description: 'The full dashboard for their own locations: operations, marketing, customers, payments and their team. Nothing from other franchisees or HQ-private areas.',
    primaryWorkspace: 'operations', defaultScope: 'owner_group', networkOnly: true,
    grants: ownerGrants,
  },
  location_manager: {
    key: 'location_manager', name: 'Location manager', team: 'locations', description: 'Runs a location day to day: operations, customers, the local website and campaign drafts.',
    primaryWorkspace: 'operations', defaultScope: 'location',
    grants: {
      'network.locations': V, 'network.approvals': V, 'network.reports': V, 'marketing.website_builder': VEP, 'marketing.campaigns': VE, 'marketing.inbox': VE, 'marketing.social': VE,
      'marketing.email': VE, 'marketing.forms': VE, 'marketing.brand_assets': VE, 'marketing.reviews': VE,
      'sales.customers': VE, 'sales.customer_pipeline': VE, 'operations.*': VE, 'finance.payments': V, 'settings.ai': V, ...everyone, 'training.assignments': VE,
      // Field audits, compliance documents and the league table.
      'operations.audits': VE, 'legal.compliance_documents': VE, 'network.league_table': V,
    },
  },
  staff: {
    key: 'staff', name: 'Staff', team: 'locations', description: 'Their own shifts, classes and appointments, cover requests and check-in at their location, plus community and training.',
    primaryWorkspace: 'operations', defaultScope: 'location',
    grants: { 'operations.schedule': VE, ...each(STAFF_LOOKUP, V), ...each(STAFF_FRONTLINE, VE), ...everyone },
  },
  // ── Other ──
  auditor: {
    key: 'auditor', name: 'Auditor', team: 'other', description: 'Read-only view of locations and operations, and runs audits. No finance, legal files or customer data.',
    primaryWorkspace: 'network', defaultScope: 'organization', support: true,
    grants: { 'network.locations': V, 'network.reports': V, 'operations.*': V, [AUDITS_MODULE]: ['view', 'edit', 'export'], 'network.league_table': V, 'settings.audit': V, ...everyone },
  },
  customer: {
    key: 'customer', name: 'Customer', team: 'other', description: 'Their own bookings, orders and preferences in the customer app.', primaryWorkspace: 'operations', defaultScope: 'location', hidden: true,
    grants: {},
  },
};

/** System roles offered when inviting, in display order (grouped by team). */
export const TEAM_ROLE_ORDER: readonly Role[] = (Object.keys(ROLE_TEMPLATES) as Role[]).filter((r) => !ROLE_TEMPLATES[r].hidden);

/** The templates of each team, in display order. */
export function rolesByTeam(roles: readonly Role[] = TEAM_ROLE_ORDER): { team: RoleTeam; roles: Role[] }[] {
  return ROLE_TEAMS.map((team) => ({ team, roles: roles.filter((r) => ROLE_TEMPLATES[r]?.team === team) })).filter((g) => g.roles.length > 0);
}

/** Capabilities of a system role for an industry (before scope filtering and overrides). Legacy keys resolve to their template. */
export function templateCapabilities(role: Role | string, industry: Industry | string): Set<Capability> {
  const t = ROLE_TEMPLATES[canonicalRole(role) as Role];
  return t ? expandGrants(t.grants, industry) : new Set();
}

/**
 * Legacy permission sets per role, derived from the templates (industry-independent: every industry has
 * Operations modules).
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = Object.fromEntries(
  (Object.keys(ROLE_TEMPLATES) as Role[]).map((r) => [r, [...permissionsFromCapabilities(templateCapabilities(r, 'studios'))]]),
) as unknown as Record<Role, readonly Permission[]>;

/** Client-side helper: does any assignment's role grant the permission (scope is enforced server-side). */
export function can(assignments: RoleAssignment[], permission: Permission): boolean {
  return assignments.some((a) => ROLE_PERMISSIONS[canonicalRole(a.role) as Role]?.includes(permission));
}

/* ------------------------------------------------------------------ */
/* Sensitive data classes (ownership vs support)                       */
/* ------------------------------------------------------------------ */

/** The sensitive class a module carries, if any. */
export function sensitiveClassOf(industry: Industry | string, module: string): SensitiveClass | null {
  return moduleDef(industry, module)?.sensitive ?? null;
}

/** Sensitive classes a capability set reaches (any action on a module carrying the class). */
export function sensitiveClassesIn(caps: ReadonlySet<string>, industry: Industry | string): Set<SensitiveClass> {
  const out = new Set<SensitiveClass>();
  for (const c of caps) {
    const cls = sensitiveClassOf(industry, parseCapability(c)?.module ?? '');
    if (cls) out.add(cls);
  }
  return out;
}

/** Removes every capability on a module of a denied sensitive class (explicit denies only apply to these classes). */
export function applyDenies(caps: ReadonlySet<Capability>, denied: Iterable<string> | null | undefined, industry: Industry | string): Set<Capability> {
  const d = new Set([...(denied ?? [])].filter((x): x is SensitiveClass => (SENSITIVE_CLASSES as readonly string[]).includes(x)));
  if (!d.size) return new Set(caps);
  return new Set([...caps].filter((c) => {
    const cls = sensitiveClassOf(industry, parseCapability(c)?.module ?? '');
    return !cls || !d.has(cls);
  }));
}

/* ------------------------------------------------------------------ */
/* Scopes                                                              */
/* ------------------------------------------------------------------ */

/** Display order of scope kinds, widest first (decides the landing workspace and grouping). */
export const SCOPE_ORDER: readonly ScopeKind[] = ['organization', 'brand', 'territory', 'region', 'portfolio', 'owner_group', 'location'];

/** Scope kinds offered when assigning a role, by business model (independent businesses have one location). */
export function scopeKindsFor(model: 'independent' | 'network'): ScopeKind[] {
  return model === 'independent' ? ['organization', 'location'] : [...SCOPE_ORDER];
}

/* ------------------------------------------------------------------ */
/* Team shape (onboarding and Team & access)                           */
/* ------------------------------------------------------------------ */

export const TEAM_SHAPES = ['full', 'small', 'solo', 'custom'] as const;
export type TeamShape = (typeof TEAM_SHAPES)[number];

/** A combined role a small team starts with: the union of templates, saved as one of the business's own roles. */
export interface CombinedRole {
  key: string;
  name: string;
  description: string;
  from: readonly Role[];
  primaryWorkspace: WorkspaceKey;
}

/** Combined roles for teams where people cover several areas ("Marketing & sales", "Operations & finance"…). */
export const COMBINED_ROLES: readonly CombinedRole[] = [
  { key: 'marketing_sales', name: 'Marketing & sales', description: 'Marketing across the network plus customer sales: leads, deals and memberships.', from: ['marketing_lead', 'sales_lead'], primaryWorkspace: 'marketing' },
  { key: 'operations_finance', name: 'Operations & finance', description: 'Day-to-day operations plus payments, royalties, invoices and payouts.', from: ['operations_lead', 'finance_lead'], primaryWorkspace: 'operations' },
  { key: 'development_training', name: 'Franchise development & training', description: 'The franchise pipeline, disclosure, agreements and new locations, plus the academy.', from: ['development_lead', 'training_lead'], primaryWorkspace: 'sales' },
];

/**
 * What each team shape suggests. Nothing is locked: the shape only pre-creates roles and can be changed later in Team
 * & access ("Team shape"). `templates` are the system templates to suggest when inviting; `combined` are created as
 * the business's own roles.
 */
export const TEAM_SHAPE_SUGGESTIONS: Record<TeamShape, { templates: readonly Role[]; combined: readonly string[] }> = {
  full: {
    templates: ['hq_admin', 'development_lead', 'development_rep', 'sales_lead', 'sales_rep', 'marketing_lead', 'brand_manager', 'digital_marketer', 'content_social', 'operations_lead', 'field_consultant', 'finance_lead', 'accountant', 'legal_lead', 'training_lead', 'trainer'],
    combined: [],
  },
  small: { templates: ['hq_admin', 'trainer', 'field_consultant'], combined: COMBINED_ROLES.map((c) => c.key) },
  solo: { templates: [], combined: [] },
  custom: { templates: [], combined: [] },
};

/** Capabilities of a combined role (the union of its templates, organisation-wide). */
export function combinedRoleCapabilities(key: string, industry: Industry | string): Set<Capability> {
  const c = COMBINED_ROLES.find((x) => x.key === key);
  const out = new Set<Capability>();
  for (const r of c?.from ?? []) for (const cap of templateCapabilities(r, industry)) out.add(cap);
  return out;
}

/* ------------------------------------------------------------------ */
/* Coverage: who handles each area                                     */
/* ------------------------------------------------------------------ */

export interface CoverageArea {
  key: string;
  /** The capability that means "handles this area". */
  capability: string;
  /** The template that usually handles it (suggested when assigning). */
  suggestedRole: Role;
  networkOnly?: boolean;
}

/**
 * Areas somebody should handle. An area nobody but the owner holds is "uncovered": Team & access shows it, and the
 * approvals and notifications for it go to the owner until someone is assigned.
 */
export const COVERAGE_AREAS: readonly CoverageArea[] = [
  { key: 'franchise_pipeline', capability: 'sales.franchise_pipeline:edit', suggestedRole: 'development_lead', networkOnly: true },
  { key: 'customer_sales', capability: 'sales.customer_pipeline:edit', suggestedRole: 'sales_lead' },
  { key: 'marketing', capability: 'marketing.campaigns:publish', suggestedRole: 'marketing_lead' },
  { key: 'websites', capability: 'marketing.website_builder:publish', suggestedRole: 'digital_marketer' },
  { key: 'approvals', capability: 'network.approvals:publish', suggestedRole: 'operations_lead', networkOnly: true },
  { key: 'new_locations', capability: 'network.onboarding:edit', suggestedRole: 'operations_lead', networkOnly: true },
  { key: 'help_desk', capability: 'community.help_desk:edit', suggestedRole: 'operations_lead', networkOnly: true },
  { key: 'payments', capability: 'finance.payments:edit', suggestedRole: 'finance_lead' },
  { key: 'royalties', capability: 'finance.royalties:edit', suggestedRole: 'finance_lead', networkOnly: true },
  { key: 'agreements', capability: 'legal.agreements:edit', suggestedRole: 'legal_lead', networkOnly: true },
  { key: 'disclosure', capability: 'legal.disclosure:publish', suggestedRole: 'legal_lead', networkOnly: true },
  { key: 'training', capability: 'training.academy:publish', suggestedRole: 'training_lead' },
];

/** Coverage areas that exist for this business (their module is in the industry's catalogue). */
export function coverageAreasFor(industry: Industry | string, model: 'independent' | 'network'): CoverageArea[] {
  return COVERAGE_AREAS.filter((a) => (model === 'network' || !a.networkOnly) && !!moduleDef(industry, parseCapability(a.capability)!.module));
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
  /** Person-level denies of sensitive data classes (apply to every role the person holds). */
  deniedClasses?: Iterable<string> | null;
}

/** The capabilities one role assignment gives, for an organisation of `industry`. */
export function effectiveCapabilities(a: AccessInput, industry: Industry | string): Set<Capability> {
  const base = a.role === 'custom' ? normalizeCapabilities(a.customCapabilities ?? [], industry) : templateCapabilities(a.role, industry);
  for (const g of normalizeCapabilities(a.grants ?? [], industry)) base.add(g);
  const revoked = new Set(a.revokes ?? []);
  // Revoking `view` removes the whole module; revoking another action removes just that action.
  const revokedModules = new Set([...revoked].map(parseCapability).filter((p) => p?.action === 'view').map((p) => p!.module));
  const kept = new Set([...base].filter((c) => !revoked.has(c) && !revokedModules.has(parseCapability(c)!.module)));
  return applyDenies(scopeFilter(kept, a.scopeKind, industry), a.deniedClasses, industry);
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
    const w = r.primaryWorkspace ?? ROLE_TEMPLATES[canonicalRole(r.role) as Role]?.primaryWorkspace;
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

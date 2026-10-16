/**
 * Roles and permissions. Enforced server-side; the client uses these only to hide controls.
 * Scopes: organisation (the whole network) → brand → territory (a sub-network) → region → portfolio (any named set of
 * locations) → owner group → location. Every scope below the organisation resolves to a set of locations.
 *
 * `PERMISSIONS` are the fine-grained checks every endpoint makes. They are derived from capabilities
 * (workspaces → modules → actions, see access.ts), so custom roles and per-person overrides apply everywhere.
 */

/**
 * System roles (role templates), grouped by team in `access.ts` (ROLE_TEAMS). Each is a set of capabilities defined
 * in `access.ts` (ROLE_TEMPLATES). Templates are starting points, not an org chart: organisations rename them, combine
 * them (a person can hold several), and create their own custom roles (stored as role `custom` + a custom role id).
 */
export const ROLES = [
  // Leadership
  'org_owner',
  'hq_admin',
  // Franchise development
  'development_lead',
  'development_rep',
  // Sales
  'sales_lead',
  'sales_rep',
  // Marketing
  'marketing_lead',
  'brand_manager',
  'digital_marketer',
  'content_social',
  // Operations
  'operations_lead',
  'field_consultant',
  // Finance
  'finance_lead',
  'accountant',
  // Legal & compliance
  'legal_lead',
  // Training
  'training_lead',
  'trainer',
  // Franchise partners
  'master_franchisee',
  'area_developer',
  'area_representative',
  'multi_unit_operator',
  // Locations
  'franchise_owner',
  'location_manager',
  'staff',
  // Other
  'auditor',
  'customer',
] as const;
export type Role = (typeof ROLES)[number];

/**
 * Role keys from before the team-based templates (they copied one franchisor's team). Stored assignments were migrated
 * to the nearest template (migration "team templates"); any key still found in old data resolves through this map.
 */
export const LEGACY_ROLE_MAP: Readonly<Record<string, Role>> = {
  vp_franchise: 'development_lead',
  cmo: 'marketing_lead',
  brand_lead: 'brand_manager',
  instructor_trainer: 'trainer',
  operations_manager: 'operations_lead',
  finance: 'finance_lead',
  legal: 'legal_lead',
  regional_manager: 'field_consultant',
  marketing_contributor: 'content_social',
};

/** A current role key for a stored key (legacy keys map to their nearest template). */
export function canonicalRole(role: string): string {
  return LEGACY_ROLE_MAP[role] ?? role;
}

export const PERMISSIONS = [
  'org.manage', 'billing.manage', 'members.manage',
  'locations.read', 'locations.write',
  'templates.write', 'policies.write',
  'website.edit', 'website.publish', 'website.approve',
  'marketing.draft', 'marketing.publish',
  'customers.read', 'customers.write',
  'operations.read', 'operations.write',
  'payments.read', 'payments.refund',
  'reports.read', 'connections.manage', 'ai.use', 'audit.read',
  // Franchise development (Sales → Franchise pipeline), new locations (Network → New locations) and Legal & compliance.
  'franchise.pipeline.view', 'franchise.pipeline.edit',
  'onboarding.view', 'onboarding.edit',
  'legal.view', 'legal.edit',
  'disclosure.view', 'disclosure.edit', 'disclosure.approve',
  // Community, Training academy and Help desk (network workspaces) and course leads (Sales).
  'community.read', 'community.post', 'community.announce', 'community.moderate', 'community.manage', 'library.manage',
  'training.learn', 'training.author', 'training.assign', 'training.manage',
  'courseleads.read', 'courseleads.edit',
  'helpdesk.raise', 'helpdesk.agent',
  // Marketing workspace (website builder themes/master pages, email, automations, forms, brand assets).
  'website.design', 'email.draft', 'email.send', 'automations.manage', 'forms.manage', 'assets.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const SCOPE_KINDS = ['organization', 'brand', 'territory', 'region', 'portfolio', 'owner_group', 'location'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/**
 * Sensitive data classes. Seeing a location never implies seeing its owner's finances, legal files or customers'
 * personal data: those need a module that carries the class (granted by an ownership template or explicitly).
 * A person-level deny on a class removes it from every role they hold.
 */
export const SENSITIVE_CLASSES = ['finance', 'legal', 'personal_data'] as const;
export type SensitiveClass = (typeof SENSITIVE_CLASSES)[number];
export interface Scope {
  kind: ScopeKind;
  id: string;
}

export interface RoleAssignment {
  role: Role;
  scope: Scope;
}

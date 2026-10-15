/**
 * Roles and permissions. Enforced server-side; the client uses these only to hide controls.
 * Scope hierarchy: organisation → region → owner group → location.
 *
 * `PERMISSIONS` are the fine-grained checks every endpoint makes. They are derived from capabilities
 * (workspaces → modules → actions, see access.ts), so custom roles and per-person overrides apply everywhere.
 */

/**
 * System roles (role templates). Each is a set of capabilities defined in `access.ts` (ROLE_TEMPLATES);
 * organisations can also create custom roles (stored as role `custom` + a custom role id).
 */
export const ROLES = [
  'org_owner',
  'hq_admin',
  'vp_franchise',
  'cmo',
  'brand_lead',
  'digital_marketer',
  'instructor_trainer',
  'operations_manager',
  'finance',
  'legal',
  'regional_manager',
  'franchise_owner',
  'location_manager',
  'staff',
  'marketing_contributor',
  'customer',
  /** Network instructor-trainer: authors courses (HQ approves publishing) and follows up course leads. */
  'instructor_trainer',
] as const;
export type Role = (typeof ROLES)[number];

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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type ScopeKind = 'organization' | 'region' | 'owner_group' | 'location';
export interface Scope {
  kind: ScopeKind;
  id: string;
}

export interface RoleAssignment {
  role: Role;
  scope: Scope;
}

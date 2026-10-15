/**
 * Roles and permissions. Enforced server-side; the client uses these only to hide controls.
 * Scope hierarchy: organisation → region → owner group → location.
 */

export const ROLES = [
  'org_owner',
  'hq_admin',
  'regional_manager',
  'franchise_owner',
  'location_manager',
  'staff',
  'marketing_contributor',
  'finance',
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
  // Community, Training academy and Help desk (network workspaces).
  'community.read', 'community.post', 'community.announce', 'community.moderate', 'community.manage',
  'training.learn', 'training.author', 'training.assign', 'training.manage',
  'helpdesk.raise', 'helpdesk.agent',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Everyone in the network (HQ, franchisees and their staff): read and take part, learn, ask HQ for help. */
const NETWORK_MEMBER = ['community.read', 'community.post', 'training.learn', 'helpdesk.raise'] as const satisfies readonly Permission[];
/** HQ teams run the network workspaces. */
const NETWORK_HQ = [...NETWORK_MEMBER, 'community.announce', 'community.moderate', 'community.manage', 'training.author', 'training.assign', 'training.manage', 'helpdesk.agent'] as const satisfies readonly Permission[];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  org_owner: PERMISSIONS,
  hq_admin: ['locations.read', 'locations.write', 'templates.write', 'policies.write', 'website.edit', 'website.publish', 'website.approve', 'marketing.draft', 'marketing.publish', 'reports.read', 'connections.manage', 'ai.use', 'operations.read', 'members.manage', 'audit.read', ...NETWORK_HQ],
  regional_manager: ['locations.read', 'website.approve', 'marketing.draft', 'reports.read', 'operations.read', 'ai.use', 'community.read', 'community.post', 'community.announce', 'community.moderate', 'training.learn', 'training.assign', 'helpdesk.raise'],
  franchise_owner: ['locations.read', 'website.edit', 'website.publish', 'marketing.draft', 'marketing.publish', 'customers.read', 'customers.write', 'operations.read', 'operations.write', 'payments.read', 'payments.refund', 'reports.read', 'members.manage', 'ai.use', ...NETWORK_MEMBER, 'training.assign'],
  location_manager: ['locations.read', 'website.edit', 'website.publish', 'marketing.draft', 'customers.read', 'customers.write', 'operations.read', 'operations.write', 'payments.read', 'reports.read', 'ai.use', ...NETWORK_MEMBER, 'training.assign'],
  staff: ['operations.read', 'operations.write', ...NETWORK_MEMBER],
  marketing_contributor: ['marketing.draft', 'website.edit', 'ai.use', ...NETWORK_MEMBER],
  finance: ['payments.read', 'payments.refund', 'reports.read', ...NETWORK_MEMBER],
  customer: [],
  instructor_trainer: [...NETWORK_MEMBER, 'training.author'],
};

export type ScopeKind = 'organization' | 'region' | 'owner_group' | 'location';
export interface Scope {
  kind: ScopeKind;
  id: string;
}

export interface RoleAssignment {
  role: Role;
  scope: Scope;
}

export function can(assignments: RoleAssignment[], permission: Permission): boolean {
  return assignments.some((a) => ROLE_PERMISSIONS[a.role].includes(permission));
}

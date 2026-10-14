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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  org_owner: PERMISSIONS,
  hq_admin: ['locations.read', 'locations.write', 'templates.write', 'policies.write', 'website.edit', 'website.publish', 'website.approve', 'marketing.draft', 'marketing.publish', 'reports.read', 'connections.manage', 'ai.use', 'operations.read', 'members.manage', 'audit.read'],
  regional_manager: ['locations.read', 'website.approve', 'marketing.draft', 'reports.read', 'operations.read', 'ai.use'],
  franchise_owner: ['locations.read', 'website.edit', 'website.publish', 'marketing.draft', 'marketing.publish', 'customers.read', 'customers.write', 'operations.read', 'operations.write', 'payments.read', 'payments.refund', 'reports.read', 'members.manage', 'ai.use'],
  location_manager: ['locations.read', 'website.edit', 'website.publish', 'marketing.draft', 'customers.read', 'customers.write', 'operations.read', 'operations.write', 'payments.read', 'reports.read', 'ai.use'],
  staff: ['operations.read', 'operations.write'],
  marketing_contributor: ['marketing.draft', 'website.edit', 'ai.use'],
  finance: ['payments.read', 'payments.refund', 'reports.read'],
  customer: [],
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

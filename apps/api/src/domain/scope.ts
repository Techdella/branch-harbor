import {
  ROLE_PERMISSIONS, capability, effectiveCapabilities, permissionsFromCapabilities, type AccessAction, type Capability, type Industry, type Permission, type Role, type ScopeKind,
} from '@bh/shared';

export interface Assignment {
  id?: string;
  /** System role key, or `custom` (see `customRoleId`). */
  role: Role | 'custom';
  scopeKind: ScopeKind;
  scopeId: string;
  expiresAt?: Date | null;
  customRoleId?: string | null;
  /**
   * Effective capabilities of this assignment (template or custom role + overrides, scope-filtered). Loaded from the
   * DB by `loadAssignments`. When absent (pure unit use), the system role's template is used.
   */
  capabilities?: ReadonlySet<Capability>;
  /** Legacy permissions derived from `capabilities`. */
  permissions?: ReadonlySet<Permission>;
}

/** The full ancestry of a target scope, resolved from the database. */
export interface ScopeChain {
  organizationId: string;
  regionId?: string | null;
  ownerGroupId?: string | null;
  locationId?: string | null;
  /** The kind of the target itself. */
  kind: ScopeKind;
}

/** Attaches effective capabilities + derived permissions to an assignment for an organisation of `industry`. */
export function withAccess<A extends Assignment>(
  a: A,
  industry: Industry | string,
  extra: { customCapabilities?: Iterable<string> | null; grants?: Iterable<string> | null; revokes?: Iterable<string> | null } = {},
): A & { capabilities: Set<Capability>; permissions: Set<Permission> } {
  const capabilities = effectiveCapabilities({ role: a.role, scopeKind: a.scopeKind, ...extra }, industry);
  return { ...a, capabilities, permissions: permissionsFromCapabilities(capabilities) };
}

export function permissionsOf(a: Assignment): ReadonlySet<Permission> {
  return a.permissions ?? new Set(ROLE_PERMISSIONS[a.role as Role] ?? []);
}

export function capabilitiesOf(a: Assignment): ReadonlySet<Capability> {
  return a.capabilities ?? effectiveCapabilities({ role: a.role, scopeKind: a.scopeKind }, 'studios');
}

/**
 * Does an assignment cover the target scope?
 * - organization assignment covers everything in the org.
 * - region assignment covers that region and locations in it.
 * - owner_group assignment covers that owner group and its locations.
 * - location assignment covers only that location.
 * A narrower assignment never covers a wider target (a location manager cannot act at org scope).
 */
export function assignmentCovers(a: Assignment, target: ScopeChain, now = new Date()): boolean {
  if (a.expiresAt && a.expiresAt <= now) return false;
  switch (a.scopeKind) {
    case 'organization':
      return a.scopeId === target.organizationId;
    case 'region':
      return (target.kind === 'region' || target.kind === 'location') && !!target.regionId && a.scopeId === target.regionId;
    case 'owner_group':
      return (target.kind === 'owner_group' || target.kind === 'location') && !!target.ownerGroupId && a.scopeId === target.ownerGroupId;
    case 'location':
      return target.kind === 'location' && !!target.locationId && a.scopeId === target.locationId;
  }
}

export function hasPermissionInScope(assignments: Assignment[], permission: Permission, target: ScopeChain, now = new Date()): boolean {
  return assignments.some((a) => permissionsOf(a).has(permission) && assignmentCovers(a, target, now));
}

export function permissionsInScope(assignments: Assignment[], target: ScopeChain, now = new Date()): Set<Permission> {
  const out = new Set<Permission>();
  for (const a of assignments) if (assignmentCovers(a, target, now)) for (const p of permissionsOf(a)) out.add(p);
  return out;
}

export function hasCapabilityInScope(assignments: Assignment[], module: string, action: AccessAction, target: ScopeChain, now = new Date()): boolean {
  const c = capability(module, action);
  return assignments.some((a) => capabilitiesOf(a).has(c) && assignmentCovers(a, target, now));
}

export function capabilitiesInScope(assignments: Assignment[], target: ScopeChain, now = new Date()): Set<Capability> {
  const out = new Set<Capability>();
  for (const a of assignments) if (assignmentCovers(a, target, now)) for (const c of capabilitiesOf(a)) out.add(c);
  return out;
}

/** Capabilities held anywhere in the organisation (any scope) — used for navigation, never for record access. */
export function capabilitiesAnywhere(assignments: Assignment[], now = new Date()): Set<Capability> {
  const out = new Set<Capability>();
  for (const a of assignments) if (!(a.expiresAt && a.expiresAt <= now)) for (const c of capabilitiesOf(a)) out.add(c);
  return out;
}

export interface LocationRef { id: string; regionId: string | null; ownerGroupId: string | null }

function locationIdsWhere(assignments: Assignment[], relevant: (a: Assignment) => boolean, organizationId: string, locations: LocationRef[], now: Date): 'all' | Set<string> {
  const rel = assignments.filter((a) => relevant(a) && !(a.expiresAt && a.expiresAt <= now));
  if (rel.some((a) => a.scopeKind === 'organization' && a.scopeId === organizationId)) return 'all';
  const ids = new Set<string>();
  for (const l of locations) {
    const chain: ScopeChain = { organizationId, kind: 'location', locationId: l.id, regionId: l.regionId, ownerGroupId: l.ownerGroupId };
    if (rel.some((a) => assignmentCovers(a, chain, now))) ids.add(l.id);
  }
  return ids;
}

/** Locations (from the given list) where the user holds `permission`. Returns 'all' for org-wide grants. */
export function authorisedLocationIds(
  assignments: Assignment[],
  permission: Permission,
  organizationId: string,
  locations: LocationRef[],
  now = new Date(),
): 'all' | Set<string> {
  return locationIdsWhere(assignments, (a) => permissionsOf(a).has(permission), organizationId, locations, now);
}

/** Locations where the user holds a module action. */
export function capabilityLocationIds(assignments: Assignment[], module: string, action: AccessAction, organizationId: string, locations: LocationRef[], now = new Date()): 'all' | Set<string> {
  const c = capability(module, action);
  return locationIdsWhere(assignments, (a) => capabilitiesOf(a).has(c), organizationId, locations, now);
}

/**
 * Granting access: only owners grant ownership; anyone else needs Team & access (edit) in the target scope and must
 * hold every capability they hand out in that scope ("you cannot grant what you don't hold").
 */
export function canGrantCapabilities(inviterAssignments: Assignment[], caps: Iterable<Capability>, target: ScopeChain): boolean {
  const held = capabilitiesInScope(inviterAssignments, target);
  if (!held.has('settings.team:edit')) return false;
  for (const c of caps) if (!held.has(c)) return false;
  return true;
}

/** An inviter may only grant a role whose capabilities they themselves hold in the target scope. */
export function canGrantRole(inviterAssignments: Assignment[], role: Role, target: ScopeChain, industry: Industry | string = 'studios'): boolean {
  if (role === 'org_owner') return inviterAssignments.some((a) => a.role === 'org_owner' && assignmentCovers(a, target));
  return canGrantCapabilities(inviterAssignments, effectiveCapabilities({ role, scopeKind: target.kind }, industry), target);
}

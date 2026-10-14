import { ROLE_PERMISSIONS, type Permission, type Role, type ScopeKind } from '@bh/shared';

export interface Assignment {
  id?: string;
  role: Role;
  scopeKind: ScopeKind;
  scopeId: string;
  expiresAt?: Date | null;
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
  return assignments.some((a) => ROLE_PERMISSIONS[a.role]?.includes(permission) && assignmentCovers(a, target, now));
}

export function permissionsInScope(assignments: Assignment[], target: ScopeChain, now = new Date()): Set<Permission> {
  const out = new Set<Permission>();
  for (const a of assignments) if (assignmentCovers(a, target, now)) for (const p of ROLE_PERMISSIONS[a.role] ?? []) out.add(p);
  return out;
}

export interface LocationRef { id: string; regionId: string | null; ownerGroupId: string | null }

/** Locations (from the given list) where the user holds `permission`. Returns 'all' for org-wide grants. */
export function authorisedLocationIds(
  assignments: Assignment[],
  permission: Permission,
  organizationId: string,
  locations: LocationRef[],
  now = new Date(),
): 'all' | Set<string> {
  const relevant = assignments.filter((a) => ROLE_PERMISSIONS[a.role]?.includes(permission) && !(a.expiresAt && a.expiresAt <= now));
  if (relevant.some((a) => a.scopeKind === 'organization' && a.scopeId === organizationId)) return 'all';
  const ids = new Set<string>();
  for (const l of locations) {
    const chain: ScopeChain = { organizationId, kind: 'location', locationId: l.id, regionId: l.regionId, ownerGroupId: l.ownerGroupId };
    if (relevant.some((a) => assignmentCovers(a, chain, now))) ids.add(l.id);
  }
  return ids;
}

/** An inviter may only grant a role whose permissions they themselves hold in the target scope. */
export function canGrantRole(inviterAssignments: Assignment[], role: Role, target: ScopeChain): boolean {
  if (role === 'org_owner') return inviterAssignments.some((a) => a.role === 'org_owner' && assignmentCovers(a, target));
  const held = permissionsInScope(inviterAssignments, target);
  if (!held.has('members.manage')) return false;
  return (ROLE_PERMISSIONS[role] ?? []).every((p) => held.has(p));
}

import { and, eq, inArray, isNull, or, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ROLE_TEMPLATES, accessSummary, type AccessAction, type AccessSummary, type Permission, type Role, type ScopeKind, type WorkspaceKey } from '@bh/shared';
import type { Exec } from '../db/client.ts';
import { customRoles, locations, memberAccessOverrides, organizations, ownerGroups, regions, roleAssignments, roleCapabilities } from '../db/schema/index.ts';
import {
  authorisedLocationIds, capabilitiesAnywhere, capabilitiesInScope, capabilityLocationIds, hasCapabilityInScope, hasPermissionInScope, permissionsInScope, withAccess,
  type Assignment, type ScopeChain,
} from '../domain/scope.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { requireUser } from '../plugins/auth.ts';

export interface ScopeTarget {
  organizationId: string;
  kind: ScopeKind;
  id: string;
}

type AssignmentRow = typeof roleAssignments.$inferSelect;

/**
 * Attaches effective access to raw role-assignment rows: the role template (or custom role capabilities) plus the
 * per-person overrides, filtered by scope (HQ-private modules only on organisation-wide assignments) and by the
 * organisation's industry catalogue.
 */
export async function withEffectiveAccess(db: Exec, organizationId: string, rows: AssignmentRow[], industry?: string): Promise<Assignment[]> {
  if (!rows.length) return [];
  const ind = industry ?? (await db.select({ industry: organizations.industry }).from(organizations).where(eq(organizations.id, organizationId)))[0]?.industry ?? 'studios';
  const customIds = [...new Set(rows.map((r) => r.customRoleId).filter((x): x is string => !!x))];
  const caps = customIds.length ? await db.select().from(roleCapabilities).where(inArray(roleCapabilities.roleId, customIds)) : [];
  const overrides = await db.select().from(memberAccessOverrides).where(inArray(memberAccessOverrides.assignmentId, rows.map((r) => r.id)));
  return rows.map((r) =>
    withAccess(
      { id: r.id, role: r.role as Role | 'custom', scopeKind: r.scopeKind as ScopeKind, scopeId: r.scopeId, expiresAt: r.expiresAt, customRoleId: r.customRoleId },
      ind,
      {
        customCapabilities: r.customRoleId ? caps.filter((c) => c.roleId === r.customRoleId).map((c) => c.capability) : null,
        grants: overrides.filter((o) => o.assignmentId === r.id && o.effect === 'grant').map((o) => o.capability),
        revokes: overrides.filter((o) => o.assignmentId === r.id && o.effect === 'revoke').map((o) => o.capability),
      },
    ),
  );
}

const active = () => or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, new Date()));

export async function loadAssignments(db: Exec, userId: string, organizationId: string): Promise<Assignment[]> {
  const rows = await db.select().from(roleAssignments).where(and(eq(roleAssignments.userId, userId), eq(roleAssignments.organizationId, organizationId), active()));
  return withEffectiveAccess(db, organizationId, rows);
}

/** Every active assignment in the organisation with effective access, grouped by user (who can approve, notify…). */
export async function loadOrgAssignments(db: Exec, organizationId: string): Promise<Map<string, Assignment[]>> {
  const rows = await db.select().from(roleAssignments).where(and(eq(roleAssignments.organizationId, organizationId), active()));
  const withAccessRows = await withEffectiveAccess(db, organizationId, rows);
  const byUser = new Map<string, Assignment[]>();
  rows.forEach((r, i) => byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), withAccessRows[i]!]));
  return byUser;
}

/** Primary workspace hints for a user's assignments (custom roles may set one). */
async function primaryHints(db: Exec, assignments: Assignment[]): Promise<{ role: string; primaryWorkspace?: WorkspaceKey | null }[]> {
  const ids = [...new Set(assignments.map((a) => a.customRoleId).filter((x): x is string => !!x))];
  const custom = ids.length ? await db.select({ id: customRoles.id, primaryWorkspace: customRoles.primaryWorkspace }).from(customRoles).where(inArray(customRoles.id, ids)) : [];
  // Widest scope first: an organisation-wide role decides where someone lands.
  const order: ScopeKind[] = ['organization', 'region', 'owner_group', 'location'];
  return [...assignments]
    .sort((a, b) => order.indexOf(a.scopeKind) - order.indexOf(b.scopeKind))
    .map((a) => ({ role: a.role, primaryWorkspace: (custom.find((c) => c.id === a.customRoleId)?.primaryWorkspace as WorkspaceKey | null | undefined) ?? ROLE_TEMPLATES[a.role as Role]?.primaryWorkspace ?? null }));
}

/** Workspaces, settings modules and landing workspace for a user in an organisation (for navigation only). */
export async function accessSummaryFor(db: Exec, assignments: Assignment[], industry: string): Promise<AccessSummary> {
  return accessSummary(capabilitiesAnywhere(assignments), industry, await primaryHints(db, assignments));
}

/** Resolve a target scope to its full ancestry, verifying it belongs to the organisation (tenant boundary). */
export async function resolveScopeChain(db: Exec, t: ScopeTarget): Promise<ScopeChain> {
  switch (t.kind) {
    case 'organization':
      if (t.id !== t.organizationId) throw notFound('Scope');
      return { organizationId: t.organizationId, kind: 'organization' };
    case 'region': {
      const [r] = await db.select({ id: regions.id }).from(regions).where(and(eq(regions.id, t.id), eq(regions.organizationId, t.organizationId)));
      if (!r) throw notFound('Region');
      return { organizationId: t.organizationId, kind: 'region', regionId: r.id };
    }
    case 'owner_group': {
      const [g] = await db.select({ id: ownerGroups.id }).from(ownerGroups).where(and(eq(ownerGroups.id, t.id), eq(ownerGroups.organizationId, t.organizationId)));
      if (!g) throw notFound('Owner group');
      return { organizationId: t.organizationId, kind: 'owner_group', ownerGroupId: g.id };
    }
    case 'location': {
      const [l] = await db
        .select({ id: locations.id, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId })
        .from(locations)
        .where(and(eq(locations.id, t.id), eq(locations.organizationId, t.organizationId)));
      if (!l) throw notFound('Location');
      return { organizationId: t.organizationId, kind: 'location', locationId: l.id, regionId: l.regionId, ownerGroupId: l.ownerGroupId };
    }
  }
}

export async function assignmentsFor(req: FastifyRequest, db: Exec, organizationId: string): Promise<Assignment[]> {
  const user = requireUser(req);
  const cached = req.assignmentCache.get(organizationId);
  if (cached) return cached;
  const a = await loadAssignments(db, user.id, organizationId);
  req.assignmentCache.set(organizationId, a);
  return a;
}

/** Throws 404 when the user has no assignment at all in the organisation (no tenant enumeration). */
export async function requireMember(req: FastifyRequest, db: Exec, organizationId: string): Promise<Assignment[]> {
  const a = await assignmentsFor(req, db, organizationId);
  if (a.length === 0) throw notFound('Organisation');
  return a;
}

/** Server-side permission check including the scope hierarchy. Returns the resolved chain. */
export async function requirePerm(req: FastifyRequest, db: Exec, permission: Permission, target: ScopeTarget): Promise<ScopeChain> {
  const assignments = await requireMember(req, db, target.organizationId);
  const chain = await resolveScopeChain(db, target);
  if (!hasPermissionInScope(assignments, permission, chain)) throw forbidden(`Missing permission ${permission} for this ${target.kind}`);
  return chain;
}

export async function hasPerm(req: FastifyRequest, db: Exec, permission: Permission, target: ScopeTarget): Promise<boolean> {
  const assignments = await assignmentsFor(req, db, target.organizationId);
  if (!assignments.length) return false;
  const chain = await resolveScopeChain(db, target).catch(() => null);
  return !!chain && hasPermissionInScope(assignments, permission, chain);
}

export async function permissionsAt(req: FastifyRequest, db: Exec, target: ScopeTarget) {
  const assignments = await assignmentsFor(req, db, target.organizationId);
  const chain = await resolveScopeChain(db, target);
  return [...permissionsInScope(assignments, chain)];
}

/**
 * preHandler factory: requirePermission('locations.write', (req) => ({ organizationId, kind, id })).
 * The resolved chain is attached to req for the handler.
 */
export function requirePermission(permission: Permission, resolve: (req: FastifyRequest) => ScopeTarget | Promise<ScopeTarget>) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const db = req.server.ctx.db;
    await requirePerm(req, db, permission, await resolve(req));
  };
}

/** Server-side capability check (module + action) including the scope hierarchy. */
export async function requireCapability(req: FastifyRequest, db: Exec, module: string, action: AccessAction, target: ScopeTarget): Promise<ScopeChain> {
  const assignments = await requireMember(req, db, target.organizationId);
  const chain = await resolveScopeChain(db, target);
  if (!hasCapabilityInScope(assignments, module, action, chain)) throw forbidden(`You don't have ${action} access to ${module} for this ${target.kind}`);
  return chain;
}

export async function hasCapability(req: FastifyRequest, db: Exec, module: string, action: AccessAction, target: ScopeTarget): Promise<boolean> {
  const assignments = await assignmentsFor(req, db, target.organizationId);
  if (!assignments.length) return false;
  const chain = await resolveScopeChain(db, target).catch(() => null);
  return !!chain && hasCapabilityInScope(assignments, module, action, chain);
}

export async function capabilitiesAt(req: FastifyRequest, db: Exec, target: ScopeTarget) {
  const assignments = await assignmentsFor(req, db, target.organizationId);
  const chain = await resolveScopeChain(db, target);
  return [...capabilitiesInScope(assignments, chain)].sort();
}

/** preHandler factory for capability checks, like `requirePermission`. */
export function requireCapabilityHook(module: string, action: AccessAction, resolve: (req: FastifyRequest) => ScopeTarget | Promise<ScopeTarget>) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    await requireCapability(req, req.server.ctx.db, module, action, await resolve(req));
  };
}

/** Location ids where the user holds a module action ('all' for organisation-wide grants). */
export async function capabilityLocations(req: FastifyRequest, db: Exec, organizationId: string, module: string, action: AccessAction): Promise<'all' | Set<string>> {
  const assignments = await requireMember(req, db, organizationId);
  const locs = await db.select({ id: locations.id, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId }).from(locations).where(eq(locations.organizationId, organizationId));
  return capabilityLocationIds(assignments, module, action, organizationId, locs);
}

/** The set of location ids in the organisation where the user holds `permission`. */
export async function authorisedLocations(req: FastifyRequest, db: Exec, organizationId: string, permission: Permission): Promise<'all' | Set<string>> {
  const assignments = await requireMember(req, db, organizationId);
  const locs = await db.select({ id: locations.id, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId }).from(locations).where(eq(locations.organizationId, organizationId));
  return authorisedLocationIds(assignments, permission, organizationId, locs);
}

export function locationAllowed(allowed: 'all' | Set<string>, locationId: string | null | undefined): boolean {
  if (allowed === 'all') return true;
  return !!locationId && allowed.has(locationId);
}

/** Look up a location within the org and require a permission at it. */
export async function requireLocationPerm(req: FastifyRequest, db: Exec, organizationId: string, locationId: string, permission: Permission) {
  await requirePerm(req, db, permission, { organizationId, kind: 'location', id: locationId });
  const [loc] = await db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!loc) throw notFound('Location');
  return loc;
}

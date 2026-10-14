import { and, eq, isNull, or, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission, Role, ScopeKind } from '@bh/shared';
import type { Exec } from '../db/client.ts';
import { locations, ownerGroups, regions, roleAssignments } from '../db/schema/index.ts';
import { authorisedLocationIds, hasPermissionInScope, permissionsInScope, type Assignment, type ScopeChain } from '../domain/scope.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { requireUser } from '../plugins/auth.ts';

export interface ScopeTarget {
  organizationId: string;
  kind: ScopeKind;
  id: string;
}

export async function loadAssignments(db: Exec, userId: string, organizationId: string): Promise<Assignment[]> {
  const rows = await db
    .select()
    .from(roleAssignments)
    .where(and(eq(roleAssignments.userId, userId), eq(roleAssignments.organizationId, organizationId), or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, new Date()))));
  return rows.map((r) => ({ id: r.id, role: r.role as Role, scopeKind: r.scopeKind as ScopeKind, scopeId: r.scopeId, expiresAt: r.expiresAt }));
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

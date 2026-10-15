import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Permission } from '@bh/shared';
import type { Exec } from '../db/client.ts';
import { locations, ownerGroups, regions, roleAssignments, users, type Audience } from '../db/schema/index.ts';
import { permissionsOf, type Assignment } from '../domain/scope.ts';
import { forbidden, notFound, validationError } from '../lib/errors.ts';
import { requireUser } from '../plugins/auth.ts';
import { assignmentsFor, withEffectiveAccess } from './authz.ts';

/**
 * Who is looking, from the network's point of view: HQ (an organisation-wide assignment) or a member of some
 * regions / owner groups / locations, with which roles and which network permissions. Used for audience targeting
 * (announcements, spaces, resources, events, training assignments) and for the private franchisee areas.
 */
export interface Viewer {
  userId: string;
  organizationId: string;
  assignments: Assignment[];
  roles: Set<string>;
  /** Holds an organisation-wide assignment (HQ). */
  hq: boolean;
  regionIds: Set<string>;
  ownerGroupIds: Set<string>;
  locationIds: Set<string>;
  /** Network permissions held in any scope. */
  perms: Set<Permission>;
  /** Network permissions held organisation-wide. */
  orgPerms: Set<Permission>;
}

type LocRow = { id: string; regionId: string | null; ownerGroupId: string | null };

export function buildViewer(userId: string, organizationId: string, assignments: Assignment[], locs: LocRow[], now = new Date()): Viewer {
  const live = assignments.filter((a) => !(a.expiresAt && a.expiresAt <= now) && a.role !== 'customer');
  const v: Viewer = {
    userId, organizationId, assignments: live, roles: new Set(live.map((a) => a.role)), hq: false,
    regionIds: new Set(), ownerGroupIds: new Set(), locationIds: new Set(), perms: new Set(), orgPerms: new Set(),
  };
  for (const a of live) {
    // Permissions derived from the assignment's capabilities (role template or custom role, plus overrides).
    const perms = [...permissionsOf(a)];
    for (const p of perms) v.perms.add(p);
    switch (a.scopeKind) {
      case 'organization':
        if (a.scopeId === organizationId) { v.hq = true; for (const p of perms) v.orgPerms.add(p); }
        break;
      case 'region':
        v.regionIds.add(a.scopeId);
        for (const l of locs) if (l.regionId === a.scopeId) v.locationIds.add(l.id);
        break;
      case 'owner_group':
        v.ownerGroupIds.add(a.scopeId);
        for (const l of locs) if (l.ownerGroupId === a.scopeId) { v.locationIds.add(l.id); if (l.regionId) v.regionIds.add(l.regionId); }
        break;
      case 'location': {
        const l = locs.find((x) => x.id === a.scopeId);
        if (l) { v.locationIds.add(l.id); if (l.regionId) v.regionIds.add(l.regionId); if (l.ownerGroupId) v.ownerGroupIds.add(l.ownerGroupId); }
        break;
      }
    }
  }
  return v;
}

export const orgLocations = (db: Exec, organizationId: string) =>
  db.select({ id: locations.id, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId }).from(locations).where(eq(locations.organizationId, organizationId));

/** The signed-in member's viewer. 404 when they are not a member (no tenant enumeration). */
export async function viewerFor(req: FastifyRequest, db: Exec, organizationId: string): Promise<Viewer> {
  const user = requireUser(req);
  const assignments = await assignmentsFor(req, db, organizationId);
  if (!assignments.length) throw notFound('Organisation');
  return buildViewer(user.id, organizationId, assignments, await orgLocations(db, organizationId));
}

export function requireNetworkPerm(v: Viewer, p: Permission, opts: { orgWide?: boolean } = {}) {
  if (!(opts.orgWide ? v.orgPerms : v.perms).has(p)) throw forbidden(`Missing permission ${p}`);
}

const nonEmpty = (xs?: string[]) => !!xs && xs.length > 0;
export const hasScopeFilter = (a: Audience) => nonEmpty(a.regionIds) || nonEmpty(a.ownerGroupIds) || nonEmpty(a.locationIds);

/**
 * Does the audience include this person?
 * - `hqSeesAll` (community content): HQ always sees everything, so they can moderate and answer.
 * - strict (training assignments): HQ people are included only when the audience is the whole network (or names them).
 */
export function audienceIncludes(a: Audience, v: Viewer, opts: { hqSeesAll: boolean }): boolean {
  if (opts.hqSeesAll && v.hq) return true;
  if (a.userIds?.includes(v.userId)) return true;
  if (a.hqOnly && !v.hq) return false;
  const scoped = hasScopeFilter(a);
  if (!scoped && nonEmpty(a.userIds) && !nonEmpty(a.roles) && !a.hqOnly) return false;
  if (scoped) {
    const inScope = (a.regionIds ?? []).some((id) => v.regionIds.has(id))
      || (a.ownerGroupIds ?? []).some((id) => v.ownerGroupIds.has(id))
      || (a.locationIds ?? []).some((id) => v.locationIds.has(id));
    if (!inScope) return false;
  }
  if (nonEmpty(a.roles) && !a.roles!.some((r) => v.roles.has(r))) return false;
  return true;
}

/** Validate ids belong to the organisation, and that a non-HQ sender only targets inside their own scope. */
export async function validateAudience(db: Exec, organizationId: string, a: Audience, sender?: Viewer): Promise<Audience> {
  const clean: Audience = {
    ...(nonEmpty(a.regionIds) ? { regionIds: [...new Set(a.regionIds)] } : {}),
    ...(nonEmpty(a.ownerGroupIds) ? { ownerGroupIds: [...new Set(a.ownerGroupIds)] } : {}),
    ...(nonEmpty(a.locationIds) ? { locationIds: [...new Set(a.locationIds)] } : {}),
    ...(nonEmpty(a.roles) ? { roles: [...new Set(a.roles)] } : {}),
    ...(a.hqOnly ? { hqOnly: true } : {}),
    ...(nonEmpty(a.userIds) ? { userIds: [...new Set(a.userIds)] } : {}),
  };
  const check = async (ids: string[] | undefined, table: typeof regions | typeof ownerGroups | typeof locations, field: string) => {
    if (!ids?.length) return;
    const rows = await db.select({ id: table.id }).from(table).where(and(eq(table.organizationId, organizationId), inArray(table.id, ids)));
    if (rows.length !== ids.length) throw validationError('Audience includes something outside this organisation', { [`audience.${field}`]: 'Unknown id' });
  };
  await check(clean.regionIds, regions, 'regionIds');
  await check(clean.ownerGroupIds, ownerGroups, 'ownerGroupIds');
  await check(clean.locationIds, locations, 'locationIds');
  if (clean.userIds?.length) {
    const rows = await db.selectDistinct({ id: roleAssignments.userId }).from(roleAssignments).where(and(eq(roleAssignments.organizationId, organizationId), inArray(roleAssignments.userId, clean.userIds)));
    if (rows.length !== clean.userIds.length) throw validationError('Audience includes people outside this organisation', { 'audience.userIds': 'Unknown person' });
  }
  if (sender && !sender.hq) {
    if (!hasScopeFilter(clean) || clean.hqOnly) throw forbidden('You can only address people in your own regions, owner groups or locations');
    const inside = (clean.regionIds ?? []).every((id) => sender.regionIds.has(id))
      && (clean.ownerGroupIds ?? []).every((id) => sender.ownerGroupIds.has(id))
      && (clean.locationIds ?? []).every((id) => sender.locationIds.has(id));
    if (!inside) throw forbidden('You can only address people in your own regions, owner groups or locations');
  }
  return clean;
}

/** Every member of the organisation as a viewer (one query for assignments, one for locations). */
export async function orgViewers(db: Exec, organizationId: string): Promise<Viewer[]> {
  const [rows, locs] = await Promise.all([
    db.select().from(roleAssignments).where(and(eq(roleAssignments.organizationId, organizationId), or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, new Date())))),
    orgLocations(db, organizationId),
  ]);
  const effective = await withEffectiveAccess(db, organizationId, rows);
  const byUser = new Map<string, Assignment[]>();
  rows.forEach((r, i) => byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), effective[i]!]));
  return [...byUser.entries()].map(([uid, a]) => buildViewer(uid, organizationId, a, locs)).filter((v) => v.assignments.length > 0);
}

/** People in the audience who also hold `permission` somewhere (e.g. community.read). */
export async function audienceUserIds(db: Exec, organizationId: string, a: Audience, permission: Permission, opts: { hqSeesAll: boolean }): Promise<string[]> {
  return (await orgViewers(db, organizationId)).filter((v) => v.perms.has(permission) && audienceIncludes(a, v, opts)).map((v) => v.userId);
}

/** Display names for a set of users. */
export async function userNames(db: Exec, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** A short role label for posts (HQ / Account manager / Franchisee / Staff …) computed from assignments. */
export function roleBadge(v: Viewer | undefined, managerIds: Set<string>): 'hq' | 'account_manager' | 'franchisee' | 'manager' | 'trainer' | 'staff' | 'member' {
  if (!v) return 'member';
  if (managerIds.has(v.userId)) return 'account_manager';
  if (v.hq) return 'hq';
  if (v.roles.has('franchise_owner')) return 'franchisee';
  if (v.roles.has('regional_manager') || v.roles.has('location_manager')) return 'manager';
  if (v.roles.has('instructor_trainer')) return 'trainer';
  if (v.roles.has('staff')) return 'staff';
  return 'member';
}

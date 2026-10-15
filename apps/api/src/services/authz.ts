import { and, eq, inArray, isNull, or, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ROLE_TEMPLATES, SCOPE_ORDER, accessSummary, canonicalRole, type AccessAction, type AccessSummary, type Permission, type Role, type ScopeKind, type WorkspaceKey } from '@bh/shared';
import type { Exec } from '../db/client.ts';
import {
  brands, customRoles, locations, memberAccessOverrides, memberProfiles, organizations, ownerGroups, portfolioLocations, portfolios, regions, roleAssignments, roleCapabilities, territories,
} from '../db/schema/index.ts';
import {
  authorisedLocationIds, capabilitiesAnywhere, capabilitiesInScope, capabilityLocationIds, capabilityTerritoryIds, coversLocation, hasCapabilityInScope, hasPermissionInScope, permissionsInScope, withAccess,
  type Assignment, type LocationRef, type ScopeChain,
} from '../domain/scope.ts';
import { opsModuleFor } from './module-guard.ts';
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
  // Person-level denies of sensitive classes apply to every role the person holds.
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const profiles = await db.select({ userId: memberProfiles.userId, denied: memberProfiles.deniedClasses }).from(memberProfiles)
    .where(and(eq(memberProfiles.organizationId, organizationId), inArray(memberProfiles.userId, userIds)));
  const denied = new Map(profiles.map((p) => [p.userId, p.denied]));
  return rows.map((r) =>
    withAccess(
      { id: r.id, role: canonicalRole(r.role) as Role | 'custom', scopeKind: r.scopeKind as ScopeKind, scopeId: r.scopeId, expiresAt: r.expiresAt, customRoleId: r.customRoleId },
      ind,
      {
        customCapabilities: r.customRoleId ? caps.filter((c) => c.roleId === r.customRoleId).map((c) => c.capability) : null,
        grants: overrides.filter((o) => o.assignmentId === r.id && o.effect === 'grant').map((o) => o.capability),
        revokes: overrides.filter((o) => o.assignmentId === r.id && o.effect === 'revoke').map((o) => o.capability),
        deniedClasses: denied.get(r.userId) ?? [],
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
  return [...assignments]
    .sort((a, b) => SCOPE_ORDER.indexOf(a.scopeKind) - SCOPE_ORDER.indexOf(b.scopeKind))
    .map((a) => ({ role: a.role, primaryWorkspace: (custom.find((c) => c.id === a.customRoleId)?.primaryWorkspace as WorkspaceKey | null | undefined) ?? ROLE_TEMPLATES[a.role as Role]?.primaryWorkspace ?? null }));
}

/** Workspaces, settings modules and landing workspace for a user in an organisation (for navigation only). */
export async function accessSummaryFor(db: Exec, assignments: Assignment[], industry: string): Promise<AccessSummary> {
  return accessSummary(capabilitiesAnywhere(assignments), industry, await primaryHints(db, assignments));
}

/** The business's default brand id (single-brand today: locations without a brand belong to it). */
export async function defaultBrandId(db: Exec, organizationId: string): Promise<string | null> {
  const find = async () => (await db.select({ id: brands.id }).from(brands).where(and(eq(brands.organizationId, organizationId), eq(brands.isDefault, true))))[0]?.id ?? null;
  const found = await find();
  if (found) return found;
  // Every business has a default brand (created on first use for businesses made after the brands migration).
  const [o] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId));
  if (!o) return null;
  await db.insert(brands).values({ organizationId, name: o.name, isDefault: true }).onConflictDoNothing();
  return find();
}

/**
 * Every location of the organisation with all the scopes it belongs to (region, owner group, territory, brand and
 * portfolios). Used wherever access is resolved to a set of locations.
 */
export async function scopedLocations(db: Exec, organizationId: string): Promise<LocationRef[]> {
  const [locs, members, brand] = await Promise.all([
    db.select({ id: locations.id, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId, territoryId: locations.territoryId, brandId: locations.brandId }).from(locations).where(eq(locations.organizationId, organizationId)),
    db.select({ portfolioId: portfolioLocations.portfolioId, locationId: portfolioLocations.locationId }).from(portfolioLocations).where(eq(portfolioLocations.organizationId, organizationId)),
    defaultBrandId(db, organizationId),
  ]);
  return locs.map((l) => ({ ...l, brandId: l.brandId ?? brand, portfolioIds: members.filter((m) => m.locationId === l.id).map((m) => m.portfolioId) }));
}

/** Location ids a scope (of any kind) holds, or 'all' for the organisation. */
export async function locationsInScope(db: Exec, organizationId: string, kind: string, id: string): Promise<'all' | Set<string>> {
  if (kind === 'organization') return 'all';
  const probe = { scopeKind: kind as ScopeKind, scopeId: id, role: 'custom' as const };
  return new Set((await scopedLocations(db, organizationId)).filter((l) => coversLocation(probe, organizationId, l)).map((l) => l.id));
}

/** Resolve a target scope to its full ancestry, verifying it belongs to the organisation (tenant boundary). */
export async function resolveScopeChain(db: Exec, t: ScopeTarget): Promise<ScopeChain> {
  switch (t.kind) {
    case 'organization':
      if (t.id !== t.organizationId) throw notFound('Scope');
      return { organizationId: t.organizationId, kind: 'organization' };
    case 'brand': {
      const [b] = await db.select({ id: brands.id }).from(brands).where(and(eq(brands.id, t.id), eq(brands.organizationId, t.organizationId)));
      if (!b) throw notFound('Brand');
      return { organizationId: t.organizationId, kind: 'brand', brandId: b.id };
    }
    case 'territory': {
      const [tr] = await db.select({ id: territories.id, brandId: territories.brandId }).from(territories).where(and(eq(territories.id, t.id), eq(territories.organizationId, t.organizationId)));
      if (!tr) throw notFound('Territory');
      return { organizationId: t.organizationId, kind: 'territory', territoryId: tr.id, brandId: tr.brandId ?? (await defaultBrandId(db, t.organizationId)) };
    }
    case 'portfolio': {
      const [p] = await db.select({ id: portfolios.id }).from(portfolios).where(and(eq(portfolios.id, t.id), eq(portfolios.organizationId, t.organizationId)));
      if (!p) throw notFound('Portfolio');
      return { organizationId: t.organizationId, kind: 'portfolio', portfolioId: p.id };
    }
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
        .select({ id: locations.id, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId, territoryId: locations.territoryId, brandId: locations.brandId })
        .from(locations)
        .where(and(eq(locations.id, t.id), eq(locations.organizationId, t.organizationId)));
      if (!l) throw notFound('Location');
      const inPortfolios = await db.select({ id: portfolioLocations.portfolioId }).from(portfolioLocations).where(eq(portfolioLocations.locationId, l.id));
      return {
        organizationId: t.organizationId, kind: 'location', locationId: l.id, regionId: l.regionId, ownerGroupId: l.ownerGroupId, territoryId: l.territoryId,
        brandId: l.brandId ?? (await defaultBrandId(db, t.organizationId)), portfolioIds: inPortfolios.map((p) => p.id),
      };
    }
  }
}

/**
 * Operations routes check their own module (access model): on a route that belongs to one Operations module (e.g.
 * `/studios/memberships` → Members & pricing), the generic `operations.read` / `operations.write` permissions mean
 * view / edit of that module, so holding another Operations module is not enough — at the guard and at every location.
 */
function opsCapabilityFor(req: FastifyRequest, permission: Permission, assignments: Assignment[]): { module: string; action: AccessAction } | null {
  if (permission !== 'operations.read' && permission !== 'operations.write') return null;
  const module = opsModuleFor(req.routeOptions?.url, capabilitiesAnywhere(assignments), req.method);
  return module ? { module, action: permission === 'operations.read' ? 'view' : 'edit' } : null;
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
  const ops = opsCapabilityFor(req, permission, assignments);
  const ok = ops ? hasCapabilityInScope(assignments, ops.module, ops.action, chain) : hasPermissionInScope(assignments, permission, chain);
  if (!ok) throw forbidden(`Missing permission ${permission} for this ${target.kind}`);
  return chain;
}

export async function hasPerm(req: FastifyRequest, db: Exec, permission: Permission, target: ScopeTarget): Promise<boolean> {
  const assignments = await assignmentsFor(req, db, target.organizationId);
  if (!assignments.length) return false;
  const chain = await resolveScopeChain(db, target).catch(() => null);
  if (!chain) return false;
  const ops = opsCapabilityFor(req, permission, assignments);
  return ops ? hasCapabilityInScope(assignments, ops.module, ops.action, chain) : hasPermissionInScope(assignments, permission, chain);
}

export async function permissionsAt(req: FastifyRequest, db: Exec, target: ScopeTarget) {
  const assignments = await assignmentsFor(req, db, target.organizationId);
  const chain = await resolveScopeChain(db, target);
  const perms = permissionsInScope(assignments, chain);
  for (const p of ['operations.read', 'operations.write'] as const) {
    const ops = opsCapabilityFor(req, p, assignments);
    if (ops && !hasCapabilityInScope(assignments, ops.module, ops.action, chain)) perms.delete(p);
  }
  return [...perms];
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
  return capabilityLocationIds(assignments, module, action, organizationId, await scopedLocations(db, organizationId));
}

/** Territories (sub-networks) where the user holds a module action ('all' for organisation-wide grants). */
export async function capabilityTerritories(req: FastifyRequest, db: Exec, organizationId: string, module: string, action: AccessAction): Promise<'all' | Set<string>> {
  return capabilityTerritoryIds(await requireMember(req, db, organizationId), module, action, organizationId);
}

/** The set of location ids in the organisation where the user holds `permission`. */
export async function authorisedLocations(req: FastifyRequest, db: Exec, organizationId: string, permission: Permission): Promise<'all' | Set<string>> {
  const assignments = await requireMember(req, db, organizationId);
  const locs = await scopedLocations(db, organizationId);
  const ops = opsCapabilityFor(req, permission, assignments);
  return ops ? capabilityLocationIds(assignments, ops.module, ops.action, organizationId, locs) : authorisedLocationIds(assignments, permission, organizationId, locs);
}

/**
 * Ownership vs support: of these locations, the ones whose finances (revenue, payments) the user may see. Seeing a
 * location — its schedule, bookings or reports — never implies seeing its owner's money: that needs Payments (view)
 * there. `all` is true when every location qualifies.
 */
export async function financeVisible(req: FastifyRequest, db: Exec, organizationId: string, ids: readonly string[]): Promise<{ all: boolean; ids: string[] }> {
  const fin = await capabilityLocations(req, db, organizationId, 'finance.payments', 'view');
  const visible = fin === 'all' ? [...ids] : ids.filter((id) => fin.has(id));
  return { all: visible.length === ids.length, ids: visible };
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

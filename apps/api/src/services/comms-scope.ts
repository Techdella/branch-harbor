import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AccessAction } from '@bh/shared';
import type { Exec } from '../db/client.ts';
import { locations } from '../db/schema/index.ts';
import { hasCapabilityInScope, type ScopeChain } from '../domain/scope.ts';
import { forbidden } from '../lib/errors.ts';
import { capabilityLocations, hasCapability, loadOrgAssignments, requireCapability, resolveScopeChain } from './authz.ts';

/** Scope target for a record: the location, or the organisation (HQ) when it has none. */
export const targetOf = (orgId: string, locationId: string | null | undefined) =>
  locationId ? { organizationId: orgId, kind: 'location' as const, id: locationId } : { organizationId: orgId, kind: 'organization' as const, id: orgId };

/** Require a module action on a location's record, or org-wide for HQ records. */
export const requireAt = (req: FastifyRequest, db: Exec, orgId: string, locationId: string | null | undefined, module: string, action: AccessAction) =>
  requireCapability(req, db, module, action, targetOf(orgId, locationId));

export const hasAt = (req: FastifyRequest, db: Exec, orgId: string, locationId: string | null | undefined, module: string, action: AccessAction) =>
  hasCapability(req, db, module, action, targetOf(orgId, locationId));

/** Holds any of the module actions at the scope. */
export async function requireAnyAt(req: FastifyRequest, db: Exec, orgId: string, locationId: string | null | undefined, options: Array<[string, AccessAction]>) {
  for (const [m, a] of options) if (await hasAt(req, db, orgId, locationId, m, a)) return;
  throw forbidden(`You don't have access to ${options.map(([m, a]) => `${m}:${a}`).join(' or ')} here`);
}

/**
 * Locations where the person holds a module action, plus whether they see HQ (organisation-level) records — only
 * organisation-wide holders do.
 */
export async function scopeFor(req: FastifyRequest, db: Exec, orgId: string, module: string, action: AccessAction = 'view') {
  const locs = await capabilityLocations(req, db, orgId, module, action);
  return { all: locs === 'all', hq: locs === 'all', locationIds: locs === 'all' ? null : [...locs] };
}

export function inScope(scope: { all: boolean; locationIds: string[] | null }, locationId: string | null | undefined) {
  if (scope.all) return true;
  return !!locationId && !!scope.locationIds?.includes(locationId);
}

/** Users holding a module action at a location (or org-wide when locationId is null). */
export async function usersWithCapabilityAt(db: Exec, orgId: string, locationId: string | null, module: string, action: AccessAction, opts: { excludeOwners?: boolean } = {}): Promise<string[]> {
  const chain: ScopeChain = locationId
    ? await resolveScopeChain(db, { organizationId: orgId, kind: 'location', id: locationId }).catch(() => ({ organizationId: orgId, kind: 'organization' as const }))
    : { organizationId: orgId, kind: 'organization' };
  const byUser = await loadOrgAssignments(db, orgId);
  return [...byUser.entries()]
    .filter(([, a]) => hasCapabilityInScope(a, module, action, chain) && !(opts.excludeOwners && a.some((x) => x.role === 'org_owner')))
    .map(([id]) => id).sort();
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

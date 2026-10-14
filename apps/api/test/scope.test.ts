import { describe, expect, it } from 'vitest';
import { assignmentCovers, authorisedLocationIds, canGrantRole, hasPermissionInScope, type Assignment, type ScopeChain } from '../src/domain/scope.ts';

const ORG = 'org-1';
const loc = (id: string, regionId: string | null = null, ownerGroupId: string | null = null): ScopeChain => ({ organizationId: ORG, kind: 'location', locationId: id, regionId, ownerGroupId });
const orgScope: ScopeChain = { organizationId: ORG, kind: 'organization' };

describe('scope resolution', () => {
  it('organisation assignment covers every location in that organisation only', () => {
    const a: Assignment = { role: 'hq_admin', scopeKind: 'organization', scopeId: ORG };
    expect(assignmentCovers(a, loc('L1'))).toBe(true);
    expect(assignmentCovers(a, orgScope)).toBe(true);
    expect(assignmentCovers(a, { organizationId: 'other-org', kind: 'location', locationId: 'L9' })).toBe(false);
  });

  it('location assignment covers only that location, never the organisation', () => {
    const a: Assignment = { role: 'location_manager', scopeKind: 'location', scopeId: 'L1' };
    expect(assignmentCovers(a, loc('L1'))).toBe(true);
    expect(assignmentCovers(a, loc('L2'))).toBe(false);
    expect(assignmentCovers(a, orgScope)).toBe(false);
  });

  it('region and owner-group assignments cover their locations', () => {
    const r: Assignment = { role: 'regional_manager', scopeKind: 'region', scopeId: 'R1' };
    const g: Assignment = { role: 'franchise_owner', scopeKind: 'owner_group', scopeId: 'G1' };
    expect(assignmentCovers(r, loc('L1', 'R1'))).toBe(true);
    expect(assignmentCovers(r, loc('L2', 'R2'))).toBe(false);
    expect(assignmentCovers(r, orgScope)).toBe(false);
    expect(assignmentCovers(g, loc('L1', null, 'G1'))).toBe(true);
    expect(assignmentCovers(g, loc('L1', 'R1', 'G2'))).toBe(false);
  });

  it('expired assignments grant nothing', () => {
    const a: Assignment = { role: 'org_owner', scopeKind: 'organization', scopeId: ORG, expiresAt: new Date(Date.now() - 1000) };
    expect(assignmentCovers(a, orgScope)).toBe(false);
  });

  it('permission requires both the role permission and scope coverage', () => {
    const staff: Assignment = { role: 'staff', scopeKind: 'location', scopeId: 'L1' };
    expect(hasPermissionInScope([staff], 'operations.write', loc('L1'))).toBe(true);
    expect(hasPermissionInScope([staff], 'payments.refund', loc('L1'))).toBe(false);
    expect(hasPermissionInScope([staff], 'operations.write', loc('L2'))).toBe(false);
  });

  it('HQ reporting access does not imply customer access', () => {
    const hq: Assignment = { role: 'hq_admin', scopeKind: 'organization', scopeId: ORG };
    expect(hasPermissionInScope([hq], 'reports.read', loc('L1'))).toBe(true);
    expect(hasPermissionInScope([hq], 'customers.read', loc('L1'))).toBe(false);
  });

  it('authorisedLocationIds returns all for org grants and a subset otherwise', () => {
    const locs = [{ id: 'L1', regionId: 'R1', ownerGroupId: null }, { id: 'L2', regionId: 'R2', ownerGroupId: 'G1' }, { id: 'L3', regionId: null, ownerGroupId: null }];
    expect(authorisedLocationIds([{ role: 'org_owner', scopeKind: 'organization', scopeId: ORG }], 'locations.read', ORG, locs)).toBe('all');
    const subset = authorisedLocationIds([{ role: 'regional_manager', scopeKind: 'region', scopeId: 'R1' }, { role: 'franchise_owner', scopeKind: 'owner_group', scopeId: 'G1' }], 'locations.read', ORG, locs);
    expect(subset).toEqual(new Set(['L1', 'L2']));
  });

  it('inviters can only grant roles whose permissions they hold in scope', () => {
    const fo: Assignment = { role: 'franchise_owner', scopeKind: 'location', scopeId: 'L1' };
    expect(canGrantRole([fo], 'staff', loc('L1'))).toBe(true);
    expect(canGrantRole([fo], 'location_manager', loc('L1'))).toBe(true);
    expect(canGrantRole([fo], 'staff', loc('L2'))).toBe(false);
    expect(canGrantRole([fo], 'hq_admin', loc('L1'))).toBe(false);
    expect(canGrantRole([fo], 'org_owner', orgScope)).toBe(false);
    const owner: Assignment = { role: 'org_owner', scopeKind: 'organization', scopeId: ORG };
    expect(canGrantRole([owner], 'org_owner', orgScope)).toBe(true);
  });
});

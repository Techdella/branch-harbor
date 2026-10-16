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
    const r: Assignment = { role: 'field_consultant', scopeKind: 'region', scopeId: 'R1' };
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
    const subset = authorisedLocationIds([{ role: 'field_consultant', scopeKind: 'region', scopeId: 'R1' }, { role: 'franchise_owner', scopeKind: 'owner_group', scopeId: 'G1' }], 'locations.read', ORG, locs);
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

describe('capabilities on assignments', () => {
  it('custom capabilities drive permissions, and HQ-private modules need an organisation-wide assignment', async () => {
    const { withAccess, hasCapabilityInScope, canGrantCapabilities } = await import('../src/domain/scope.ts');
    const custom = withAccess({ role: 'custom', scopeKind: 'location', scopeId: 'L1' }, 'studios', { customCapabilities: ['sales.customers:view', 'finance.royalties:view'] });
    expect([...custom.capabilities].sort()).toEqual(['sales.customers:view']);
    expect(hasPermissionInScope([custom], 'customers.read', loc('L1'))).toBe(true);
    expect(hasPermissionInScope([custom], 'customers.read', loc('L2'))).toBe(false);
    expect(hasCapabilityInScope([custom], 'sales.customers', 'view', loc('L1'))).toBe(true);
    const owner = withAccess({ role: 'org_owner', scopeKind: 'organization', scopeId: ORG }, 'studios');
    expect(canGrantCapabilities([owner], ['finance.royalties:view'], orgScope)).toBe(true);
    const fo = withAccess({ role: 'franchise_owner', scopeKind: 'owner_group', scopeId: 'G1' }, 'studios');
    expect(canGrantCapabilities([fo], ['operations.classes:edit'], loc('L1', null, 'G1'))).toBe(true);
    expect(canGrantCapabilities([fo], ['settings.connections:edit'], loc('L1', null, 'G1'))).toBe(false);
    expect(canGrantCapabilities([fo], ['operations.classes:edit'], loc('L2', null, 'G2'))).toBe(false);
  });
});

describe('portfolio, territory and brand scopes', () => {
  const L = (id: string, extra: Partial<ScopeChain> = {}): ScopeChain => ({ ...loc(id), ...extra });

  it('a portfolio covers the locations in it, across regions and owners, and nothing else', () => {
    const fc: Assignment = { role: 'field_consultant', scopeKind: 'portfolio', scopeId: 'P1' };
    expect(assignmentCovers(fc, L('L1', { regionId: 'R1', ownerGroupId: 'G1', portfolioIds: ['P1'] }))).toBe(true);
    expect(assignmentCovers(fc, L('L2', { regionId: 'R2', ownerGroupId: 'G2', portfolioIds: ['P2', 'P1'] }))).toBe(true);
    expect(assignmentCovers(fc, L('L3', { regionId: 'R1', portfolioIds: [] }))).toBe(false);
    expect(assignmentCovers(fc, { organizationId: ORG, kind: 'portfolio', portfolioId: 'P1' })).toBe(true);
    expect(assignmentCovers(fc, { organizationId: ORG, kind: 'region', regionId: 'R1' })).toBe(false);
    expect(assignmentCovers(fc, orgScope)).toBe(false);
  });

  it('a territory covers its locations and itself; a brand covers its territories and locations', () => {
    const mf: Assignment = { role: 'master_franchisee', scopeKind: 'territory', scopeId: 'T1' };
    expect(assignmentCovers(mf, L('L1', { territoryId: 'T1' }))).toBe(true);
    expect(assignmentCovers(mf, L('L2', { territoryId: 'T2' }))).toBe(false);
    expect(assignmentCovers(mf, { organizationId: ORG, kind: 'territory', territoryId: 'T1' })).toBe(true);
    expect(assignmentCovers(mf, orgScope)).toBe(false);
    const b: Assignment = { role: 'marketing_lead', scopeKind: 'brand', scopeId: 'B1' };
    expect(assignmentCovers(b, L('L1', { brandId: 'B1' }))).toBe(true);
    expect(assignmentCovers(b, L('L2', { brandId: 'B2' }))).toBe(false);
    expect(assignmentCovers(b, { organizationId: ORG, kind: 'territory', territoryId: 'T1', brandId: 'B1' })).toBe(true);
    expect(assignmentCovers(b, orgScope)).toBe(false);
  });

  it('location lists resolve every scope kind', () => {
    const locs = [
      { id: 'L1', regionId: 'R1', ownerGroupId: 'G1', territoryId: 'T1', brandId: 'B1', portfolioIds: ['P1'] },
      { id: 'L2', regionId: 'R2', ownerGroupId: 'G2', territoryId: null, brandId: 'B1', portfolioIds: [] },
      { id: 'L3', regionId: 'R1', ownerGroupId: null, territoryId: 'T1', brandId: 'B2', portfolioIds: ['P1'] },
    ];
    const ids = (a: Assignment) => authorisedLocationIds([a], 'locations.read', ORG, locs);
    expect(ids({ role: 'field_consultant', scopeKind: 'portfolio', scopeId: 'P1' })).toEqual(new Set(['L1', 'L3']));
    expect(ids({ role: 'master_franchisee', scopeKind: 'territory', scopeId: 'T1' })).toEqual(new Set(['L1', 'L3']));
    expect(ids({ role: 'hq_admin', scopeKind: 'brand', scopeId: 'B1' })).toEqual(new Set(['L1', 'L2']));
  });

  it('territory assignments run their own franchise pipeline; support roles never see finances', async () => {
    const { withAccess, capabilityTerritoryIds, hasCapabilityInScope } = await import('../src/domain/scope.ts');
    const mf = withAccess({ role: 'master_franchisee', scopeKind: 'territory', scopeId: 'T1' }, 'studios');
    expect(capabilityTerritoryIds([mf], 'sales.franchise_pipeline', 'view', ORG)).toEqual(new Set(['T1']));
    const hq = withAccess({ role: 'development_lead', scopeKind: 'organization', scopeId: ORG }, 'studios');
    expect(capabilityTerritoryIds([hq], 'sales.franchise_pipeline', 'view', ORG)).toBe('all');
    const fc = withAccess({ role: 'field_consultant', scopeKind: 'portfolio', scopeId: 'P1' }, 'studios');
    const l1 = L('L1', { portfolioIds: ['P1'] });
    expect(hasCapabilityInScope([fc], 'network.locations', 'view', l1)).toBe(true);
    expect(hasCapabilityInScope([fc], 'finance.payments', 'view', l1)).toBe(false);
    expect(hasCapabilityInScope([fc], 'sales.customers', 'view', l1)).toBe(false);
  });

  it('grant ceiling: a master franchisee grants only inside their territory and only what they hold', async () => {
    const { withAccess, canGrantCapabilities } = await import('../src/domain/scope.ts');
    const mf = withAccess({ role: 'master_franchisee', scopeKind: 'territory', scopeId: 'T1' }, 'studios');
    expect(canGrantRole([mf], 'staff', L('L1', { territoryId: 'T1' }))).toBe(false); // staff edit classes; MF only views operations
    expect(canGrantCapabilities([mf], ['network.locations:view', 'community.discussions:edit'], L('L1', { territoryId: 'T1' }))).toBe(true);
    expect(canGrantCapabilities([mf], ['network.locations:view'], L('L2', { territoryId: 'T2' }))).toBe(false);
    expect(canGrantCapabilities([mf], ['finance.royalties:view'], { organizationId: ORG, kind: 'territory', territoryId: 'T1' })).toBe(false);
    expect(canGrantCapabilities([mf], ['network.locations:view'], orgScope)).toBe(false);
  });
});

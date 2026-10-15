import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_PERMISSIONS, ROLE_TEMPLATES, effectiveCapabilities, expandGrants, modulesFor, permissionsFromCapabilities, primaryWorkspace, workspacesFor,
} from './access.ts';
import { INDUSTRIES } from './industries.ts';
import { ROLES, type Permission, type Role } from './permissions.ts';

/** The fixed role → permission lists before the access model; system templates must keep granting exactly these. */
const LEGACY: Partial<Record<Role, Permission[]>> = {
  hq_admin: ['locations.read', 'locations.write', 'templates.write', 'policies.write', 'website.edit', 'website.publish', 'website.approve', 'marketing.draft', 'marketing.publish', 'reports.read', 'connections.manage', 'ai.use', 'operations.read', 'members.manage', 'audit.read'],
  regional_manager: ['locations.read', 'website.approve', 'marketing.draft', 'reports.read', 'operations.read', 'ai.use'],
  franchise_owner: ['locations.read', 'website.edit', 'website.publish', 'marketing.draft', 'marketing.publish', 'customers.read', 'customers.write', 'operations.read', 'operations.write', 'payments.read', 'payments.refund', 'reports.read', 'members.manage', 'ai.use'],
  location_manager: ['locations.read', 'website.edit', 'website.publish', 'marketing.draft', 'customers.read', 'customers.write', 'operations.read', 'operations.write', 'payments.read', 'reports.read', 'ai.use'],
  staff: ['operations.read', 'operations.write'],
  marketing_contributor: ['marketing.draft', 'website.edit', 'ai.use'],
  finance: ['payments.read', 'payments.refund', 'reports.read'],
  customer: [],
};

test('system templates keep the legacy permission sets', () => {
  for (const [role, perms] of Object.entries(LEGACY)) assert.deepEqual([...ROLE_PERMISSIONS[role as Role]].sort(), [...perms].sort(), role);
  assert.equal(ROLE_PERMISSIONS.org_owner.length, 22);
});

test('every role has a template and every template only names real modules', () => {
  for (const r of ROLES) assert.ok(ROLE_TEMPLATES[r], r);
  for (const ind of INDUSTRIES) {
    const keys = new Set(modulesFor(ind).map((m) => m.key));
    for (const t of Object.values(ROLE_TEMPLATES))
      for (const k of Object.keys(t.grants)) if (k !== '*' && !k.endsWith('.*')) assert.ok(keys.has(k), `${t.key}: ${k}`);
  }
});

test('franchise owners never hold HQ-private modules, even through overrides', () => {
  const caps = effectiveCapabilities({ role: 'franchise_owner', scopeKind: 'owner_group', grants: ['finance.royalties:view', 'legal.agreements:view', 'sales.franchise_pipeline:view'] }, 'studios');
  assert.ok(!caps.has('finance.royalties:view'));
  assert.ok(!caps.has('legal.agreements:view'));
  assert.ok(!caps.has('sales.franchise_pipeline:view'));
  assert.ok(caps.has('operations.classes:edit'));
  assert.ok(caps.has('finance.payments:view'));
  const hq = effectiveCapabilities({ role: 'org_owner', scopeKind: 'organization' }, 'studios');
  assert.ok(hq.has('finance.royalties:view'));
});

test('custom roles give exactly what was ticked (plus implied view) and overrides apply', () => {
  const caps = effectiveCapabilities({ role: 'custom', scopeKind: 'organization', customCapabilities: ['marketing.website_builder:publish', 'sales.customers:view', 'bogus.module:view', 'operations.kitchen:view'] }, 'studios');
  assert.deepEqual([...caps].sort(), ['marketing.website_builder:publish', 'marketing.website_builder:view', 'sales.customers:view']);
  const perms = permissionsFromCapabilities(caps);
  assert.deepEqual([...perms].sort(), ['customers.read', 'website.publish']);
  const revoked = effectiveCapabilities({ role: 'location_manager', scopeKind: 'location', revokes: ['sales.customers:view'] }, 'studios');
  assert.ok(![...revoked].some((c) => c.startsWith('sales.customers')));
  assert.ok(!permissionsFromCapabilities(revoked).has('customers.read'));
});

test('workspaces only appear for available modules and industry modules follow the industry', () => {
  const marketer = expandGrants(ROLE_TEMPLATES.digital_marketer.grants, 'studios');
  assert.deepEqual(workspacesFor(marketer, 'studios').map((w) => w.key), ['network', 'marketing']);
  const trainer = expandGrants(ROLE_TEMPLATES.instructor_trainer.grants, 'studios');
  // Training is not built yet, so the trainer lands in Operations rather than an empty Training workspace.
  const ws = workspacesFor(trainer, 'studios').map((w) => w.key);
  assert.deepEqual(ws, ['operations']);
  assert.equal(primaryWorkspace([{ role: 'instructor_trainer' }], ws), 'operations');
  const foodsStaff = expandGrants(ROLE_TEMPLATES.staff.grants, 'foods');
  assert.ok(foodsStaff.has('operations.menu:edit'));
  assert.ok(!foodsStaff.has('operations.classes:view'));
});

test('finance workspace: franchise owners see their statements and the fund report, never royalties or payouts', () => {
  const fo = effectiveCapabilities({ role: 'franchise_owner', scopeKind: 'owner_group' }, 'studios');
  assert.ok(fo.has('finance.invoices:edit'));
  assert.ok(fo.has('finance.marketing_fund:view'));
  assert.ok(!fo.has('finance.marketing_fund:edit'));
  assert.ok(!fo.has('finance.royalties:view'));
  assert.ok(!fo.has('finance.payouts:view'));
  const fin = effectiveCapabilities({ role: 'finance', scopeKind: 'organization' }, 'studios');
  for (const m of ['finance.payments', 'finance.royalties', 'finance.invoices', 'finance.marketing_fund', 'finance.payouts']) assert.ok(fin.has(`${m}:view`), m);
  assert.ok(fin.has('finance.royalties:publish'));
  assert.deepEqual(workspacesFor(fin, 'studios').find((w) => w.key === 'finance')?.modules, ['finance.payments', 'finance.royalties', 'finance.invoices', 'finance.marketing_fund', 'finance.payouts']);
});

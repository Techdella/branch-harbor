import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMBINED_ROLES, COVERAGE_AREAS, PENDING_MODULES, ROLE_PERMISSIONS, ROLE_TEMPLATES, TEAM_ROLE_ORDER, TEAM_SHAPE_SUGGESTIONS, applyDenies, combinedRoleCapabilities, coverageAreasFor,
  effectiveCapabilities, expandGrants, modulesFor, parseCapability, permissionsFromCapabilities, primaryWorkspace, rolesByTeam, sensitiveClassesIn, templateCapabilities, workspacesFor,
} from './access.ts';
import { INDUSTRIES } from './industries.ts';
import { LEGACY_ROLE_MAP, PERMISSIONS, ROLES, canonicalRole, type Permission, type Role } from './permissions.ts';
import { inviteRolesFor } from './business-mode.ts';

/** The fixed role → permission lists before the access model; the unchanged system templates must keep granting exactly these. */
const LEGACY: Partial<Record<Role, Permission[]>> = {
  hq_admin: ['locations.read', 'locations.write', 'templates.write', 'policies.write', 'website.edit', 'website.publish', 'website.approve', 'marketing.draft', 'marketing.publish', 'reports.read', 'connections.manage', 'ai.use', 'operations.read', 'members.manage', 'audit.read'],
  franchise_owner: ['locations.read', 'website.edit', 'website.publish', 'marketing.draft', 'marketing.publish', 'customers.read', 'customers.write', 'operations.read', 'operations.write', 'payments.read', 'payments.refund', 'reports.read', 'members.manage', 'ai.use'],
  location_manager: ['locations.read', 'website.edit', 'website.publish', 'marketing.draft', 'customers.read', 'customers.write', 'operations.read', 'operations.write', 'payments.read', 'reports.read', 'ai.use'],
  staff: ['operations.read', 'operations.write'],
  customer: [],
};

const allModuleKeys = new Set([...INDUSTRIES.flatMap((i) => modulesFor(i).map((m) => m.key)), ...PENDING_MODULES]);
const caps = (role: string, scopeKind: Parameters<typeof effectiveCapabilities>[0]['scopeKind'] = 'organization', industry = 'studios') => effectiveCapabilities({ role, scopeKind }, industry);
const perms = (role: string, scopeKind: Parameters<typeof effectiveCapabilities>[0]['scopeKind'] = 'organization') => permissionsFromCapabilities(caps(role, scopeKind));

test('unchanged system templates keep the legacy permission sets', () => {
  const legacy = new Set(PERMISSIONS.slice(0, 22));
  for (const [role, p] of Object.entries(LEGACY)) assert.deepEqual([...ROLE_PERMISSIONS[role as Role]].filter((x) => legacy.has(x)).sort(), [...p].sort(), role);
  assert.equal(ROLE_PERMISSIONS.org_owner.length, PERMISSIONS.length);
});

test('every role has a template in a team, and templates only name real (or pending) modules', () => {
  for (const r of ROLES) assert.ok(ROLE_TEMPLATES[r]?.team, r);
  for (const t of Object.values(ROLE_TEMPLATES))
    for (const k of Object.keys(t.grants)) if (k !== '*' && !k.endsWith('.*')) assert.ok(allModuleKeys.has(k), `${t.key}: ${k}`);
  // Grouped by team in display order; every offered role appears once.
  const grouped = rolesByTeam().flatMap((g) => g.roles);
  assert.deepEqual([...grouped].sort(), [...TEAM_ROLE_ORDER].sort());
  assert.deepEqual(rolesByTeam().map((g) => g.team), ['leadership', 'development', 'sales', 'marketing', 'operations', 'finance', 'legal', 'training', 'partners', 'locations', 'other']);
  for (const r of inviteRolesFor('network')) assert.ok(TEAM_ROLE_ORDER.includes(r), r);
  for (const r of inviteRolesFor('independent')) assert.ok(ROLE_TEMPLATES[r] && !ROLE_TEMPLATES[r].networkOnly, r);
});

test('legacy role keys resolve to the nearest template', () => {
  assert.equal(canonicalRole('vp_franchise'), 'development_lead');
  assert.equal(canonicalRole('cmo'), 'marketing_lead');
  assert.equal(canonicalRole('instructor_trainer'), 'trainer');
  assert.equal(canonicalRole('staff'), 'staff');
  for (const [old, now] of Object.entries(LEGACY_ROLE_MAP)) assert.deepEqual([...templateCapabilities(old, 'studios')].sort(), [...templateCapabilities(now, 'studios')].sort(), old);
  assert.equal(primaryWorkspace([{ role: 'vp_franchise' }], ['sales', 'network']), 'sales');
});

test('franchise development and customer sales are separate teams', () => {
  const dev = perms('development_lead');
  for (const p of ['franchise.pipeline.view', 'franchise.pipeline.edit', 'onboarding.edit', 'legal.view', 'disclosure.edit'] as const) assert.ok(dev.has(p), p);
  assert.ok(!dev.has('disclosure.approve'));
  assert.ok(!dev.has('customers.read'), 'no general sales by default');
  assert.ok(!caps('development_lead').has('sales.customer_pipeline:view'));
  const rep = caps('development_rep');
  assert.ok(rep.has('sales.franchise_pipeline:edit') && !rep.has('sales.franchise_pipeline:publish') && !rep.has('legal.agreements:view'));
  const sales = caps('sales_rep');
  for (const c of ['sales.customers:edit', 'sales.customer_pipeline:edit', 'sales.course_leads:edit', 'operations.memberships:view']) assert.ok(sales.has(c as never), c);
  assert.ok(!sales.has('sales.franchise_pipeline:view'));
  assert.ok(caps('sales_lead').has('sales.customer_pipeline:publish'));
  assert.ok(caps('sales_lead', 'organization', 'wellness').has('operations.services:edit'), 'packages in wellness');
  const ws = workspacesFor(caps('development_lead'), 'studios').map((w) => w.key);
  assert.deepEqual(ws, ['network', 'sales', 'legal', 'training', 'community']);
});

test('franchise owners never hold HQ-private modules, even through overrides', () => {
  const c = effectiveCapabilities({ role: 'franchise_owner', scopeKind: 'owner_group', grants: ['finance.royalties:view', 'legal.agreements:view', 'sales.franchise_pipeline:view'] }, 'studios');
  assert.ok(!c.has('finance.royalties:view'));
  assert.ok(!c.has('legal.agreements:view'));
  assert.ok(!c.has('sales.franchise_pipeline:view'));
  assert.ok(c.has('operations.classes:edit'));
  assert.ok(c.has('finance.payments:view'));
  assert.ok(caps('org_owner').has('finance.royalties:view'));
});

test('territories run their own franchise pipeline; other HQ-private modules stay at HQ', () => {
  const mf = caps('master_franchisee', 'territory');
  assert.ok(mf.has('sales.franchise_pipeline:publish'));
  assert.ok(mf.has('network.onboarding:edit') && mf.has('finance.invoices:view') && mf.has('community.announcements:publish') && mf.has('settings.team:edit'));
  assert.ok(!mf.has('finance.royalties:view') && !mf.has('legal.agreements:view') && !mf.has('settings.billing:view'));
  const ad = caps('area_developer', 'territory');
  assert.ok(ad.has('sales.franchise_pipeline:view') && ad.has('operations.classes:edit') && ad.has('finance.payments:view'));
  // The same template at a region does not get the pipeline (it is not a sub-network).
  assert.ok(!caps('area_developer', 'region').has('sales.franchise_pipeline:view'));
});

test('support roles never include a sensitive data class; ownership roles do', () => {
  for (const t of Object.values(ROLE_TEMPLATES).filter((x) => x.support)) {
    for (const ind of INDUSTRIES) assert.deepEqual([...sensitiveClassesIn(templateCapabilities(t.key, ind), ind)], [], `${t.key} in ${ind}`);
  }
  for (const r of ['field_consultant', 'area_representative', 'auditor'] as const) assert.ok(ROLE_TEMPLATES[r].support, r);
  const fc = caps('field_consultant', 'portfolio');
  assert.ok(fc.has('network.locations:view') && fc.has('operations.classes:view') && fc.has('community.discussions:edit') && fc.has('community.help_desk:edit'));
  assert.ok(!fc.has('finance.payments:view') && !fc.has('finance.invoices:view') && !fc.has('sales.customers:view') && !fc.has('operations.classes:edit'));
  assert.deepEqual([...sensitiveClassesIn(caps('franchise_owner', 'owner_group'), 'studios')].sort(), ['finance', 'personal_data']);
  // A support role only gets finance through an explicit grant.
  assert.ok(effectiveCapabilities({ role: 'area_representative', scopeKind: 'territory', grants: ['finance.invoices:view'] }, 'studios').has('finance.invoices:view'));
});

test('audits: the capability key is reserved and harmless until the module exists', () => {
  assert.ok(PENDING_MODULES.includes('operations.audits'));
  const exists = modulesFor('studios').some((m) => m.key === 'operations.audits');
  assert.equal(caps('auditor').has('operations.audits:edit'), exists);
  assert.equal(caps('field_consultant', 'portfolio').has('operations.audits:edit'), exists);
  const auditor = caps('auditor');
  assert.ok(auditor.has('operations.classes:view') && !auditor.has('operations.classes:edit') && auditor.has('settings.audit:view'));
});

test('staff are narrow: their schedule and front-line work, community and training', () => {
  const s = caps('staff', 'location');
  assert.ok(s.has('operations.schedule:edit') && s.has('operations.classes:edit'));
  assert.ok(!s.has('operations.memberships:view') && !s.has('operations.studio_insights:view'));
  assert.ok(!s.has('sales.customers:view') && !s.has('finance.payments:view'));
  assert.deepEqual(workspacesFor(s, 'studios').map((w) => w.key), ['operations', 'training', 'community']);
  const foods = caps('staff', 'location', 'foods');
  assert.ok(foods.has('operations.food_orders:edit') && !foods.has('operations.menu:edit') && !foods.has('operations.classes:view'));
  assert.ok(caps('staff', 'location', 'hospitality').has('operations.housekeeping:edit'));
});

test('custom roles give exactly what was ticked (plus implied view) and overrides apply', () => {
  const c = effectiveCapabilities({ role: 'custom', scopeKind: 'organization', customCapabilities: ['marketing.website_builder:publish', 'sales.customers:view', 'bogus.module:view', 'operations.kitchen:view'] }, 'studios');
  assert.deepEqual([...c].sort(), ['marketing.website_builder:publish', 'marketing.website_builder:view', 'sales.customers:view']);
  assert.deepEqual([...permissionsFromCapabilities(c)].sort(), ['customers.read', 'website.publish']);
  assert.deepEqual([...effectiveCapabilities({ role: 'custom', scopeKind: 'organization', customCapabilities: [] }, 'studios')], [], 'a new custom role starts empty');
  const revoked = effectiveCapabilities({ role: 'location_manager', scopeKind: 'location', revokes: ['sales.customers:view'] }, 'studios');
  assert.ok(![...revoked].some((x) => x.startsWith('sales.customers')));
});

test('explicit denies only remove sensitive classes', () => {
  const denied = effectiveCapabilities({ role: 'franchise_owner', scopeKind: 'owner_group', deniedClasses: ['finance', 'operations' as never] }, 'studios');
  assert.ok(![...denied].some((c) => c.startsWith('finance.')));
  assert.ok(denied.has('operations.classes:edit') && denied.has('sales.customers:view'));
  const pd = applyDenies(caps('sales_lead'), ['personal_data'], 'studios');
  assert.ok(!pd.has('sales.customers:view') && !pd.has('marketing.inbox:view') && pd.has('operations.memberships:edit'));
});

test('workspaces only appear for available modules and industry modules follow the industry', () => {
  const marketer = expandGrants(ROLE_TEMPLATES.digital_marketer.grants, 'studios');
  assert.deepEqual(workspacesFor(marketer, 'studios').map((w) => w.key), ['network', 'marketing', 'training', 'community']);
  const trainer = expandGrants(ROLE_TEMPLATES.trainer.grants, 'studios');
  const ws = workspacesFor(trainer, 'studios').map((w) => w.key);
  assert.deepEqual(ws, ['training', 'community']);
  assert.equal(primaryWorkspace([{ role: 'trainer' }], ws), 'training');
});

test('everyone reads and posts in the community, learns and raises help requests; HQ teams run them', () => {
  for (const r of ['staff', 'location_manager', 'finance_lead', 'legal_lead', 'content_social', 'franchise_owner', 'sales_rep', 'field_consultant'] as const) {
    const scope = ROLE_TEMPLATES[r].defaultScope;
    const p = perms(r, scope);
    for (const k of ['community.read', 'community.post', 'training.learn', 'helpdesk.raise'] as const) assert.ok(p.has(k), `${r} ${k}`);
    assert.ok(!p.has('community.announce'), r);
  }
  const trainer = perms('trainer');
  assert.ok(trainer.has('training.author') && !trainer.has('courseleads.read') && !trainer.has('training.manage'));
  assert.ok(perms('training_lead').has('training.manage'));
  const ml = perms('marketing_lead');
  assert.ok(ml.has('community.announce') && !ml.has('helpdesk.agent'));
  assert.ok(perms('operations_lead').has('helpdesk.agent') && perms('field_consultant', 'portfolio').has('helpdesk.agent'));
  assert.ok(perms('location_manager', 'location').has('training.assign'));
});

test('finance workspace: franchise owners see their statements and the fund report, never royalties or payouts', () => {
  const fo = caps('franchise_owner', 'owner_group');
  assert.ok(fo.has('finance.invoices:edit') && fo.has('finance.marketing_fund:view') && !fo.has('finance.marketing_fund:edit'));
  assert.ok(!fo.has('finance.royalties:view') && !fo.has('finance.payouts:view'));
  const fin = caps('finance_lead');
  for (const m of ['finance.payments', 'finance.royalties', 'finance.invoices', 'finance.marketing_fund', 'finance.payouts']) assert.ok(fin.has(`${m}:view` as never), m);
  assert.ok(fin.has('finance.royalties:publish'));
  const acc = caps('accountant');
  assert.ok(acc.has('finance.royalties:export') && !acc.has('finance.royalties:edit') && !acc.has('finance.payments:edit'));
  assert.deepEqual(workspacesFor(fin, 'studios').find((w) => w.key === 'finance')?.modules, ['finance.payments', 'finance.royalties', 'finance.invoices', 'finance.marketing_fund', 'finance.payouts']);
});

test('team shapes and combined roles', () => {
  assert.deepEqual(Object.keys(TEAM_SHAPE_SUGGESTIONS), ['full', 'small', 'solo', 'custom']);
  for (const k of TEAM_SHAPE_SUGGESTIONS.small.combined) assert.ok(COMBINED_ROLES.some((c) => c.key === k), k);
  const ms = combinedRoleCapabilities('marketing_sales', 'studios');
  assert.ok(ms.has('marketing.campaigns:publish') && ms.has('sales.customer_pipeline:edit'));
  const of = combinedRoleCapabilities('operations_finance', 'studios');
  assert.ok(of.has('operations.classes:edit') && of.has('finance.royalties:edit'));
});

test('coverage areas name real capabilities and suggest a template that covers them', () => {
  for (const a of COVERAGE_AREAS) {
    const p = parseCapability(a.capability)!;
    assert.ok(allModuleKeys.has(p.module), a.key);
    assert.ok(caps(a.suggestedRole).has(a.capability as never), `${a.key} → ${a.suggestedRole}`);
  }
  assert.ok(!coverageAreasFor('studios', 'independent').some((a) => a.key === 'royalties'));
  assert.ok(coverageAreasFor('studios', 'network').some((a) => a.key === 'royalties'));
});

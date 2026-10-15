import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { auditEvents, customers, users } from '../src/db/schema/index.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

/**
 * Access model: workspaces → modules → actions, role templates, custom roles, per-person overrides and scope.
 * Every check here is server-side; the dashboard only hides what the API would refuse.
 */
describe.skipIf(!hasDb)('access model (DB)', () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof verifiedUser>>;
  let orgId: string;
  let groupA: string;
  let groupB: string;
  let locA1: string;
  let locA2: string;
  let locB: string;
  let hqLoc: string;

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Northlight CEO');
    orgId = (await createOrg(app, owner.token, { name: `Northlight ${uid()}`, industry: 'studios' })).id;
    groupA = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'Pacific Heat Studios' } })).body.id;
    groupB = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'Rose City Yoga' } })).body.id;
    locA1 = (await createLocation(app, owner.token, orgId, { name: 'Main Street', ownerGroupId: groupA })).id;
    locA2 = (await createLocation(app, owner.token, orgId, { name: 'Kitsilano', ownerGroupId: groupA })).id;
    locB = (await createLocation(app, owner.token, orgId, { name: 'Pearl', ownerGroupId: groupB })).id;
    hqLoc = (await createLocation(app, owner.token, orgId, { name: 'Annex (company-owned)' })).id;
    await app.ctx.db.insert(customers).values([
      { organizationId: orgId, locationId: locA1, name: 'Avery A1', email: `a1-${uid()}@example.com` },
      { organizationId: orgId, locationId: locA2, name: 'Blake A2', email: `a2-${uid()}@example.com` },
      { organizationId: orgId, locationId: locB, name: 'Casey B', email: `b-${uid()}@example.com` },
      { organizationId: orgId, locationId: hqLoc, name: 'Dana HQ', email: `hq-${uid()}@example.com` },
    ]);
  });
  // Sign-ups are rate limited per app instance; each test gets a fresh instance (same database and token secret).
  beforeEach(async () => {
    await app?.close();
    app = await makeApp();
  });
  afterAll(async () => { await app?.close(); });

  const names = (r: { body: Record<string, any> }) => (r.body.items as Array<{ name: string }>).map((c) => c.name).sort();

  it('publishes a catalogue of workspaces, modules, actions and role templates', async () => {
    const r = await call(app, 'GET', '/v1/access/catalogue?industry=studios');
    expect(r.status).toBe(200);
    expect(r.body.workspaces.map((w: any) => w.key)).toEqual(['network', 'operations', 'sales', 'marketing', 'finance', 'legal', 'training', 'community']);
    expect(r.body.modules.find((m: any) => m.key === 'operations.classes')).toMatchObject({ area: 'operations', status: 'available' });
    expect(r.body.modules.find((m: any) => m.key === 'sales.franchise_pipeline')).toMatchObject({ status: 'planned', hqOnly: true });
    expect(r.body.templates.map((t: any) => t.key)).toEqual(expect.arrayContaining(['org_owner', 'vp_franchise', 'cmo', 'digital_marketer', 'franchise_owner', 'location_manager', 'staff']));
    const hosp = await call(app, 'GET', '/v1/access/catalogue?industry=hospitality');
    expect(hosp.body.modules.some((m: any) => m.key === 'operations.reservations')).toBe(true);
    expect(hosp.body.modules.some((m: any) => m.key === 'operations.classes')).toBe(false);
  });

  it('location manager cannot fetch owner or HQ data', async () => {
    const lm = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: locA2 }, 'Mia Manager');
    // Own location only.
    expect(names(await call(app, 'GET', `/v1/orgs/${orgId}/customers`, { token: lm.token }))).toEqual(['Blake A2']);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/locations/${locA1}`, { token: lm.token })).status).toBe(403);
    // Owner-group and organisation reports, billing and the team are HQ / owner data.
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/reports/overview?scopeKind=owner_group&scopeId=${groupA}`, { token: lm.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/reports/overview`, { token: lm.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/subscription`, { token: lm.token })).body.error.code).toBe('module_not_available');
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/members`, { token: lm.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/roles`, { token: lm.token })).status).toBe(403);
    // Their own location's report works.
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/reports/overview?scopeKind=location&scopeId=${locA2}`, { token: lm.token })).status).toBe(200);
  });

  it('marketing-only user gets 403 on operations and finance, and sees only marketing workspaces', async () => {
    const dm = await memberWithRole(app, owner.token, orgId, 'digital_marketer', { kind: 'organization', id: orgId }, 'Priyanka Marketer');
    for (const path of ['studios/occurrences', 'shifts', 'payments', 'payments/reconciliation', 'customers', 'members']) {
      const r = await call(app, 'GET', `/v1/orgs/${orgId}/${path}`, { token: dm.token });
      expect(r.status, path).toBe(403);
    }
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/websites`, { token: dm.token })).status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/campaigns`, { token: dm.token })).status).toBe(200);
    const me = await call(app, 'GET', '/v1/auth/me', { token: dm.token });
    const access = me.body.organizations.find((o: any) => o.id === orgId).access;
    expect(access.workspaces.map((w: any) => w.key)).toEqual(['network', 'marketing']);
    expect(access.primaryWorkspace).toBe('marketing');
    expect(access.capabilities).not.toContain('finance.payments:view');
    // Reports without Payments: revenue is withheld server-side.
    const rep = await call(app, 'GET', `/v1/orgs/${orgId}/reports/overview`, { token: dm.token });
    expect(rep.status).toBe(200);
    expect(rep.body.metrics.revenue).toMatchObject({ value: null, unavailableCode: 'no_finance_access' });
    expect(rep.body.revenueByLocation).toEqual([]);
  });

  it('a custom role grants exactly what was ticked, and nobody can grant what they do not hold', async () => {
    const created = await call(app, 'POST', `/v1/orgs/${orgId}/roles`, {
      token: owner.token,
      body: { name: 'Community & reviews', description: 'Answers customers, drafts website copy', capabilities: ['sales.customers:view', 'marketing.website_builder:edit'] },
    });
    expect(created.status).toBe(201);
    expect(created.body.capabilities).toEqual(['marketing.website_builder:edit', 'marketing.website_builder:view', 'sales.customers:view']);
    expect(created.body.preview.permissions).toEqual(['customers.read', 'website.edit']);
    const roleId = created.body.id;

    const u = await verifiedUser(app, 'Riley Custom');
    const inv = await call(app, 'POST', `/v1/orgs/${orgId}/invitations`, { token: owner.token, body: { email: u.email, role: 'custom', customRoleId: roleId, scope: { kind: 'organization', id: orgId } } });
    expect(inv.status).toBe(201);
    expect((await call(app, 'POST', '/v1/invitations/accept', { token: u.token, body: { token: inv.body.devInvitationToken } })).status).toBe(200);

    const mine = await call(app, 'GET', `/v1/orgs/${orgId}/access/me`, { token: u.token });
    expect(mine.body.capabilities).toEqual(['marketing.website_builder:edit', 'marketing.website_builder:view', 'sales.customers:view']);
    expect(mine.body.workspaces.map((w: any) => w.key)).toEqual(['sales', 'marketing']);
    expect(names(await call(app, 'GET', `/v1/orgs/${orgId}/customers`, { token: u.token }))).toHaveLength(4);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/websites`, { token: u.token })).status).toBe(200);
    // Not ticked: payments, operations, locations directory edits, publishing, team.
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/payments`, { token: u.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/studios/occurrences`, { token: u.token })).status).toBe(403);
    expect((await call(app, 'PATCH', `/v1/orgs/${orgId}/locations/${hqLoc}`, { token: u.token, body: { phone: '+1 555 0100' } })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/members`, { token: u.token })).status).toBe(403);

    // A franchise owner holds Team & access for their group but cannot create org roles or grant HQ-private modules.
    const fo = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: groupA }, 'Liam Franchisee');
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/roles`, { token: fo.token, body: { name: `Mine ${uid()}`, capabilities: ['sales.customers:view'] } })).status).toBe(403);
    const staff = await memberWithRole(app, fo.token, orgId, 'staff', { kind: 'location', id: locA1 }, 'Chloe Staff');
    const members = await call(app, 'GET', `/v1/orgs/${orgId}/members/${staff.userId}/access`, { token: fo.token });
    expect(members.status).toBe(200);
    const assignmentId = members.body.assignments[0].id;
    const hqOnly = await call(app, 'PUT', `/v1/orgs/${orgId}/role-assignments/${assignmentId}/access`, { token: owner.token, body: { grants: ['finance.royalties:view'], revokes: [] } });
    expect(hqOnly.status).toBe(400);
    expect(hqOnly.body.error.code).toBe('hq_only_module');
    const escalate = await call(app, 'PUT', `/v1/orgs/${orgId}/role-assignments/${assignmentId}/access`, { token: fo.token, body: { grants: ['settings.connections:edit'], revokes: [] } });
    expect(escalate.status).toBe(403); // the franchise owner only views connections
    const ok = await call(app, 'PUT', `/v1/orgs/${orgId}/role-assignments/${assignmentId}/access`, { token: fo.token, body: { grants: ['sales.customers:view'], revokes: [] } });
    expect(ok.status).toBe(200);
    expect(ok.body.changes.added).toEqual(['sales.customers:view']);
    expect(names(await call(app, 'GET', `/v1/orgs/${orgId}/customers`, { token: staff.token }))).toEqual(['Avery A1']);
    // Invalid module names are rejected, not silently ignored.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/roles`, { token: owner.token, body: { name: `Bad ${uid()}`, capabilities: ['operations.kitchen:view'] } })).status).toBe(400);
  });

  it('franchisee A cannot see franchisee B or HQ-private areas', async () => {
    const foA = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: groupA }, 'Owner A');
    const foB = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: groupB }, 'Owner B');
    expect(names(await call(app, 'GET', `/v1/orgs/${orgId}/customers`, { token: foA.token }))).toEqual(['Avery A1', 'Blake A2']);
    expect(names(await call(app, 'GET', `/v1/orgs/${orgId}/customers`, { token: foB.token }))).toEqual(['Casey B']);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/locations`, { token: foA.token })).body.items.map((l: any) => l.id).sort()).toEqual([locA1, locA2].sort());
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/locations/${locB}`, { token: foA.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/reports/overview?scopeKind=owner_group&scopeId=${groupB}`, { token: foA.token })).status).toBe(403);
    const rep = await call(app, 'GET', `/v1/orgs/${orgId}/reports/overview?scopeKind=owner_group&scopeId=${groupA}`, { token: foA.token });
    expect(rep.status).toBe(200);
    expect(rep.body.scope.locationCount).toBe(2);
    // Members of the other group are invisible; billing (HQ-private) is refused.
    const team = await call(app, 'GET', `/v1/orgs/${orgId}/members`, { token: foA.token });
    expect(team.body.items.some((m: any) => m.user.id === foB.userId)).toBe(false);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/members/${foB.userId}/access`, { token: foA.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/subscription`, { token: foA.token })).status).toBe(403);
    const access = (await call(app, 'GET', `/v1/orgs/${orgId}/access/me`, { token: foA.token })).body;
    expect(access.capabilities.some((c: string) => c.startsWith('finance.royalties') || c.startsWith('legal.') || c.startsWith('sales.franchise_pipeline'))).toBe(false);
    expect(access.workspaces.map((w: any) => w.key)).toEqual(['network', 'operations', 'sales', 'marketing', 'finance']);
    expect(access.primaryWorkspace).toBe('operations');
  });

  it('removing a module revokes access on the very next request, for overrides and custom roles', async () => {
    const lm = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: locA1 }, 'Revoked Manager');
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/customers`, { token: lm.token })).status).toBe(200);
    const a = (await call(app, 'GET', `/v1/orgs/${orgId}/members/${lm.userId}/access`, { token: owner.token })).body.assignments[0];
    const r = await call(app, 'PUT', `/v1/orgs/${orgId}/role-assignments/${a.id}/access`, { token: owner.token, body: { revokes: ['sales.customers:view'], grants: [] } });
    expect(r.status).toBe(200);
    expect(r.body.changes.removed).toEqual(['sales.customers:edit', 'sales.customers:view']);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/customers`, { token: lm.token })).status).toBe(403); // same access token
    const audits = await app.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, orgId), eq(auditEvents.action, 'access.assignment_updated'), eq(auditEvents.targetId, lm.userId)));
    expect(audits).toHaveLength(1);

    // Custom role edits apply to everyone holding the role.
    const role = (await call(app, 'POST', `/v1/orgs/${orgId}/roles`, { token: owner.token, body: { name: `Payments desk ${uid()}`, capabilities: ['finance.payments:view'] } })).body;
    const u = await verifiedUser(app, 'Payments Desk');
    const inv = await call(app, 'POST', `/v1/orgs/${orgId}/invitations`, { token: owner.token, body: { email: u.email, role: 'custom', customRoleId: role.id, scope: { kind: 'organization', id: orgId } } });
    await call(app, 'POST', '/v1/invitations/accept', { token: u.token, body: { token: inv.body.devInvitationToken } });
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/payments`, { token: u.token })).status).toBe(200);
    expect((await call(app, 'PATCH', `/v1/orgs/${orgId}/roles/${role.id}`, { token: owner.token, body: { capabilities: ['network.reports:view'] } })).status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/payments`, { token: u.token })).status).toBe(403);
    expect((await call(app, 'DELETE', `/v1/orgs/${orgId}/roles/${role.id}`, { token: owner.token })).body.error.code).toBe('role_in_use');
  });

  it('keeps the industry fixed: normal API refuses, only an audited platform admin can change it', async () => {
    const patch = await call(app, 'PATCH', `/v1/orgs/${orgId}`, { token: owner.token, body: { industry: 'foods' } });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('industry_locked');
    expect((await call(app, 'PATCH', `/v1/orgs/${orgId}`, { token: owner.token, body: { industry: 'studios', name: 'Northlight Yoga' } })).status).toBe(200);
    expect((await call(app, 'PUT', `/v1/platform/orgs/${orgId}/industry`, { token: owner.token, body: { industry: 'wellness', reason: 'Signed up under the wrong industry' } })).status).toBe(403);

    const admin = await verifiedUser(app, 'Platform Admin');
    await app.ctx.db.update(users).set({ platformRole: 'admin' }).where(eq(users.id, admin.userId));
    const other = await createOrg(app, owner.token, { industry: 'studios' });
    const ch = await call(app, 'PUT', `/v1/platform/orgs/${other.id}/industry`, { token: admin.token, body: { industry: 'wellness', reason: 'Signed up under the wrong industry' } });
    expect(ch.status).toBe(200);
    expect(ch.body).toMatchObject({ industry: 'wellness', previousIndustry: 'studios' });
    const [ev] = await app.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, other.id), eq(auditEvents.action, 'platform.org_industry_changed')));
    expect(ev?.metadata).toMatchObject({ from: 'studios', to: 'wellness' });
    expect((await call(app, 'GET', '/v1/auth/me', { token: admin.token })).body.user.platformAdmin).toBe(true);
  });

  it('lists every business account of a login separately, each with its own industry and access', async () => {
    const second = await createOrg(app, owner.token, { name: `Northlight Kitchen ${uid()}`, industry: 'foods' });
    const me = await call(app, 'GET', '/v1/auth/me', { token: owner.token });
    const a = me.body.organizations.find((o: any) => o.id === orgId);
    const b = me.body.organizations.find((o: any) => o.id === second.id);
    expect(a.industry).toBe('studios');
    expect(b.industry).toBe('foods');
    expect(a.access.capabilities).toContain('operations.classes:view');
    expect(b.access.capabilities).toContain('operations.menu:view');
    expect(b.access.capabilities).not.toContain('operations.classes:view');
    expect(me.body.demoMode).toBe(false);
  });

  it('demo endpoints exist only in demo mode', async () => {
    expect((await call(app, 'GET', '/v1/demo/accounts')).status).toBe(404);
    expect((await call(app, 'POST', '/v1/demo/login', { body: { email: 'demo@branchharbor.com' } })).status).toBe(404);
    const demoApp = await makeApp({}, { DEMO_MODE: 'true' });
    try {
      const email = `pat.${uid()}@northlight.demo.branchharbor.com`;
      const u = await verifiedUser(demoApp, 'Pat Demo');
      await demoApp.ctx.db.update(users).set({ email }).where(eq(users.id, u.userId));
      const o = await createOrg(demoApp, u.token, { name: `Demo Org ${uid()}` });
      const list = await call(demoApp, 'GET', '/v1/demo/accounts');
      expect(list.status).toBe(200);
      const org = list.body.organizations.find((x: any) => x.id === o.id);
      expect(org.accounts[0]).toMatchObject({ email, roles: [{ role: 'org_owner', roleName: 'Owner', scope: null }] });
      const login = await call(demoApp, 'POST', '/v1/demo/login', { body: { email } });
      expect(login.status).toBe(200);
      expect(login.body.accessToken).toBeTruthy();
      expect((await call(demoApp, 'POST', '/v1/demo/login', { body: { email: owner.email } })).status).toBe(403);
      expect((await call(demoApp, 'GET', '/health')).body.demoMode).toBe(true);
    } finally {
      await demoApp.close();
    }
  });
});

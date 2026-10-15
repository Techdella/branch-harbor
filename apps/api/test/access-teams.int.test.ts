import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { customers, franchiseProspects, memberAccessOverrides, paymentReferences, roleAssignments } from '../src/db/schema/index.ts';
import { responsibleUsersAt } from '../src/services/notifications.ts';
import { call, createLocation, createOrg, grantCaps, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

/**
 * Team-based templates and the scopes beyond regions and owner groups (docs/PRODUCT_PLAN.md "Access model"):
 * portfolios, territories (sub-networks) and brands; ownership vs support (sensitive data classes); role mechanics
 * (rename, job titles, several roles, denies, the grant ceiling, preview); team shape, coverage and the owner fallback;
 * per-module enforcement for Operations; the migration of the old role keys.
 */
describe.skipIf(!hasDb)('team templates and scopes (DB)', () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof verifiedUser>>;
  let orgId: string;
  let west: any; let east: any; let dublin: any; let galway: any;
  let portfolio: string;
  let ireland: string;
  let consultant: Awaited<ReturnType<typeof verifiedUser>>;
  let master: Awaited<ReturnType<typeof verifiedUser>>;

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Team Owner');
    orgId = (await createOrg(app, owner.token, { name: `Teams ${uid()}`, industry: 'studios' })).id;
    west = await createLocation(app, owner.token, orgId, { name: 'West End' });
    east = await createLocation(app, owner.token, orgId, { name: 'East Side' });
    dublin = await createLocation(app, owner.token, orgId, { name: 'Dublin', currency: 'EUR', address: { line1: '1 Richmond St', city: 'Dublin', country: 'IE' }, timeZone: 'Europe/Dublin' });
    galway = await createLocation(app, owner.token, orgId, { name: 'Galway', currency: 'EUR', address: { line1: '3 Dock Rd', city: 'Galway', country: 'IE' }, timeZone: 'Europe/Dublin' });
    portfolio = (await call(app, 'POST', `/v1/orgs/${orgId}/access/portfolios`, { token: owner.token, body: { name: 'Coached studios', locationIds: [west.id, dublin.id] } })).body.id;
    ireland = (await call(app, 'POST', `/v1/orgs/${orgId}/access/territories`, { token: owner.token, body: { name: 'Ireland', kind: 'master', country: 'IE', locationIds: [dublin.id, galway.id] } })).body.id;
    for (const l of [west, east, dublin, galway]) {
      await app.ctx.db.insert(customers).values({ organizationId: orgId, locationId: l.id, name: `Customer ${uid()}`, email: `c-${uid()}@example.com` });
      await app.ctx.db.insert(paymentReferences).values({ organizationId: orgId, locationId: l.id, provider: 'stripe', externalId: `pi_${uid()}`, amountMinor: 2500, currency: 'CAD', state: 'succeeded', succeededAt: new Date(), sandbox: 1 });
    }
    consultant = await memberWithRole(app, owner.token, orgId, 'field_consultant', { kind: 'portfolio', id: portfolio }, 'Isabel Coach');
    master = await memberWithRole(app, owner.token, orgId, 'master_franchisee', { kind: 'territory', id: ireland }, 'Siobhan Master');
  });
  beforeEach(async () => {
    await app?.close();
    app = await makeApp();
  });
  afterAll(async () => { await app?.close(); });

  const locNames = async (token: string) => ((await call(app, 'GET', `/v1/orgs/${orgId}/locations`, { token })).body.items as Array<{ name: string }>).map((l) => l.name).sort();

  it('templates come grouped by team, with scope kinds, and a new custom role starts empty', async () => {
    const roles = await call(app, 'GET', `/v1/orgs/${orgId}/roles`, { token: owner.token });
    expect(roles.status).toBe(200);
    expect(roles.body.teams).toEqual(['leadership', 'development', 'sales', 'marketing', 'operations', 'finance', 'legal', 'training', 'partners', 'locations', 'other']);
    expect(roles.body.scopeKinds).toEqual(['organization', 'brand', 'territory', 'region', 'portfolio', 'owner_group', 'location']);
    const fc = roles.body.templates.find((t: any) => t.key === 'field_consultant');
    expect(fc).toMatchObject({ team: 'operations', support: true, defaultScope: 'portfolio', sensitive: [] });
    expect(roles.body.templates.find((t: any) => t.key === 'franchise_owner').sensitive).toEqual(['finance', 'personal_data']);
    const empty = await call(app, 'POST', `/v1/orgs/${orgId}/roles`, { token: owner.token, body: { name: `Empty ${uid()}`, capabilities: [] } });
    expect(empty.status).toBe(201);
    expect(empty.body.capabilities).toEqual([]);
    expect(empty.body.preview.workspaces).toEqual([]);
  });

  it('portfolio: a field consultant sees exactly their portfolio, and no owner finances or customer data', async () => {
    expect(await locNames(consultant.token)).toEqual(['Dublin', 'West End']);
    const report = await call(app, 'GET', `/v1/orgs/${orgId}/reports/overview?scopeKind=portfolio&scopeId=${portfolio}`, { token: consultant.token });
    expect(report.status).toBe(200);
    expect(report.body.scope.locationCount).toBe(2);
    expect(report.body.metrics.revenue.value).toBeNull();
    expect(report.body.revenueByLocation).toEqual([]);
    // Sensitive classes need an explicit grant even though the location is visible.
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/payments`, { token: consultant.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/finance/statements`, { token: consultant.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/customers`, { token: consultant.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/customers/export`, { token: consultant.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/legal/agreements`, { token: consultant.token })).status).toBe(403);
    // Revenue inside an industry report is filtered the same way.
    const studio = await call(app, 'GET', `/v1/orgs/${orgId}/studios/reports`, { token: consultant.token });
    expect(studio.status).toBe(200);
    expect(studio.body).toMatchObject({ revenue: [], revenueRestricted: true });
    // Moving a location into the portfolio applies on the next request.
    await call(app, 'PATCH', `/v1/orgs/${orgId}/access/portfolios/${portfolio}`, { token: owner.token, body: { locationIds: [west.id, dublin.id, east.id] } });
    expect(await locNames(consultant.token)).toEqual(['Dublin', 'East Side', 'West End']);
    await call(app, 'PATCH', `/v1/orgs/${orgId}/access/portfolios/${portfolio}`, { token: owner.token, body: { locationIds: [west.id, dublin.id] } });
  });

  it('ownership: an explicit grant opens one sensitive class, and only inside the scope', async () => {
    const rep = await memberWithRole(app, owner.token, orgId, 'area_representative', { kind: 'territory', id: ireland }, 'Area Rep');
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/customers/export`, { token: rep.token })).status).toBe(403);
    await grantCaps(app, owner.token, orgId, rep.userId, ['sales.customers:view', 'sales.customers:export']);
    const csv = await call(app, 'GET', `/v1/orgs/${orgId}/customers/export`, { token: rep.token });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const list = await call(app, 'GET', `/v1/orgs/${orgId}/customers`, { token: rep.token });
    expect(new Set(list.body.items.map((c: any) => c.locationId))).toEqual(new Set([dublin.id, galway.id]));
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/customers/export?locationId=${west.id}`, { token: rep.token })).status).toBe(403);
  });

  it('territory: a master franchisee runs their own sub-network and pipeline, nothing outside it', async () => {
    expect(await locNames(master.token)).toEqual(['Dublin', 'Galway']);
    const hqProspect = await call(app, 'POST', `/v1/orgs/${orgId}/franchise/prospects`, { token: owner.token, body: { name: 'HQ Prospect', email: `hq-${uid()}@example.com`, country: 'CA', region: 'ON' } });
    expect(hqProspect.status).toBe(201);
    const mine = await call(app, 'POST', `/v1/orgs/${orgId}/franchise/prospects`, { token: master.token, body: { name: 'Cork Prospect', email: `cork-${uid()}@example.com`, country: 'IE' } });
    expect(mine.status).toBe(201);
    expect(mine.body.scopeTerritoryId).toBe(ireland);
    const list = await call(app, 'GET', `/v1/orgs/${orgId}/franchise/prospects`, { token: master.token });
    expect(list.status).toBe(200);
    expect(list.body.items.map((p: any) => p.name)).toEqual(['Cork Prospect']);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/franchise/prospects/${hqProspect.body.id}`, { token: master.token })).status).toBe(404);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/franchise/prospects/${mine.body.id}`, { token: master.token })).status).toBe(200);
    // Can't move a prospect out of the territory.
    expect((await call(app, 'PATCH', `/v1/orgs/${orgId}/franchise/prospects/${mine.body.id}`, { token: master.token, body: { scopeTerritoryId: null } })).status).toBe(403);
    // HQ sees both; settings say the master franchisee may edit.
    const hq = await call(app, 'GET', `/v1/orgs/${orgId}/franchise/prospects`, { token: owner.token });
    expect(hq.body.items.length).toBeGreaterThanOrEqual(2);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/franchise/settings`, { token: master.token })).body).toMatchObject({ canEdit: true, territoryScoped: true });
    // HQ-only modules stay at HQ: royalties and agreements.
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/finance/terms`, { token: master.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/legal/agreements`, { token: master.token })).status).toBe(403);
    // Finances for the territory's own locations are theirs (statements & invoices, payments view).
    const me = await call(app, 'GET', `/v1/orgs/${orgId}/access/me`, { token: master.token });
    expect(me.body.capabilities).toEqual(expect.arrayContaining(['finance.invoices:view', 'finance.payments:view', 'sales.franchise_pipeline:publish', 'settings.team:edit']));
    expect(me.body.capabilities.some((c: string) => c.startsWith('finance.royalties'))).toBe(false);
    const report = await call(app, 'GET', `/v1/orgs/${orgId}/reports/overview?scopeKind=territory&scopeId=${ireland}`, { token: master.token });
    expect(report.status).toBe(200);
    expect(report.body.revenueByLocation.map((r: any) => r.name).sort()).toEqual(['Dublin', 'Galway']);
  });

  it('area developer: own units plus the pipeline of their development area', async () => {
    const area = (await call(app, 'POST', `/v1/orgs/${orgId}/access/territories`, { token: owner.token, body: { name: 'East development area', kind: 'development', locationIds: [east.id] } })).body.id;
    const dev = await memberWithRole(app, owner.token, orgId, 'area_developer', { kind: 'territory', id: area }, 'Ryan Developer');
    expect(await locNames(dev.token)).toEqual(['East Side']);
    const p = await call(app, 'POST', `/v1/orgs/${orgId}/franchise/prospects`, { token: dev.token, body: { name: 'Unit 2', email: `u2-${uid()}@example.com`, country: 'CA', region: 'ON' } });
    expect(p.status).toBe(201);
    const list = await call(app, 'GET', `/v1/orgs/${orgId}/franchise/prospects`, { token: dev.token });
    expect(list.body.items.map((x: any) => x.name)).toEqual(['Unit 2']);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/studios/members`, { token: dev.token })).status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/payments`, { token: dev.token })).status).toBe(200);
  });

  it('brand scope covers the brand’s locations (single-brand today: every location)', async () => {
    const scopes = await call(app, 'GET', `/v1/orgs/${orgId}/access/scopes`, { token: owner.token });
    expect(scopes.status).toBe(200);
    const brand = scopes.body.brands.find((b: any) => b.isDefault);
    expect(brand).toBeTruthy();
    expect(scopes.body.portfolios.find((p: any) => p.id === portfolio).locationIds.sort()).toEqual([west.id, dublin.id].sort());
    const ml = await memberWithRole(app, owner.token, orgId, 'brand_manager', { kind: 'brand', id: brand.id }, 'Brand Person');
    expect(await locNames(ml.token)).toEqual(['Dublin', 'East Side', 'Galway', 'West End']);
  });

  it('grant ceiling: you can only grant capabilities and scopes you hold yourself; the owner holds all', async () => {
    const inviteAs = (token: string, role: string, scope: { kind: string; id: string }) => call(app, 'POST', `/v1/orgs/${orgId}/invitations`, { token, body: { email: `g-${uid()}@example.com`, role, scope } });
    // The master franchisee manages their territory's team, but only with what they hold and only inside Ireland.
    expect((await inviteAs(master.token, 'area_representative', { kind: 'territory', id: ireland })).status).toBe(201);
    expect((await inviteAs(master.token, 'area_representative', { kind: 'location', id: galway.id })).status).toBe(201);
    expect((await inviteAs(master.token, 'area_representative', { kind: 'location', id: west.id })).status).toBe(403);
    expect((await inviteAs(master.token, 'location_manager', { kind: 'location', id: galway.id })).status).toBe(403); // edits operations: not held
    expect((await inviteAs(master.token, 'finance_lead', { kind: 'organization', id: orgId })).status).toBe(403);
    // People without Team & access grant nothing.
    expect((await inviteAs(consultant.token, 'staff', { kind: 'location', id: west.id })).status).toBe(403);
    // Overrides above the ceiling are refused; the owner can grant anything.
    const rep = await memberWithRole(app, master.token, orgId, 'area_representative', { kind: 'territory', id: ireland }, 'Rep by master');
    const acc = (await call(app, 'GET', `/v1/orgs/${orgId}/members/${rep.userId}/access`, { token: master.token })).body.assignments[0];
    const up = (token: string, grants: string[]) => call(app, 'PUT', `/v1/orgs/${orgId}/role-assignments/${acc.id}/access`, { token, body: { role: acc.role, customRoleId: null, grants, revokes: [] } });
    expect((await up(master.token, ['finance.invoices:view'])).status).toBe(200);
    expect((await up(master.token, ['sales.customers:export'])).status).toBe(403);
    expect((await up(owner.token, ['sales.customers:export'])).status).toBe(200);
    // Custom roles: you can only create what you hold organisation-wide.
    const ops = await memberWithRole(app, owner.token, orgId, 'operations_lead', { kind: 'organization', id: orgId }, 'Ops Lead');
    await grantCaps(app, owner.token, orgId, ops.userId, ['settings.team:view', 'settings.team:edit']);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/roles`, { token: ops.token, body: { name: `Ops ${uid()}`, capabilities: ['operations.classes:edit'] } })).status).toBe(201);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/roles`, { token: ops.token, body: { name: `Fin ${uid()}`, capabilities: ['finance.royalties:view'] } })).status).toBe(403);
  });

  it('several roles: access is the union; a sensitive-class deny applies across all of them', async () => {
    const person = await memberWithRole(app, owner.token, orgId, 'sales_rep', { kind: 'organization', id: orgId }, 'Two Hats');
    const add = await call(app, 'POST', `/v1/orgs/${orgId}/role-assignments`, { token: owner.token, body: { userId: person.userId, role: 'trainer', scope: { kind: 'organization', id: orgId }, grants: [], revokes: [] } });
    expect(add.status).toBe(201);
    const me = (await call(app, 'GET', `/v1/orgs/${orgId}/access/me`, { token: person.token })).body;
    expect(me.workspaces.map((w: any) => w.key)).toEqual(expect.arrayContaining(['sales', 'training']));
    expect(me.capabilities).toEqual(expect.arrayContaining(['sales.customers:edit', 'training.academy:edit']));
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/customers`, { token: person.token })).status).toBe(200);
    const prof = await call(app, 'PUT', `/v1/orgs/${orgId}/members/${person.userId}/profile`, { token: owner.token, body: { jobTitle: 'Sales & teacher training', deniedClasses: ['personal_data'] } });
    expect(prof.status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/customers`, { token: person.token })).status).toBe(403);
    const after = (await call(app, 'GET', `/v1/orgs/${orgId}/access/me`, { token: person.token })).body;
    expect(after.jobTitle).toBe('Sales & teacher training');
    expect(after.capabilities.some((c: string) => c.startsWith('sales.customers') || c.startsWith('marketing.inbox'))).toBe(false);
    expect(after.capabilities).toEqual(expect.arrayContaining(['training.academy:edit', 'operations.memberships:view']));
    const member = (await call(app, 'GET', `/v1/orgs/${orgId}/members`, { token: owner.token })).body.items.find((m: any) => m.user.id === person.userId);
    expect(member.jobTitle).toBe('Sales & teacher training');
    expect(member.assignments.map((a: any) => a.role).sort()).toEqual(['sales_rep', 'trainer']);
  });

  it('renames a role for the business (access unchanged) and previews effective access before saving', async () => {
    const rn = await call(app, 'PUT', `/v1/orgs/${orgId}/access/role-labels/development_lead`, { token: owner.token, body: { name: 'VP Franchise' } });
    expect(rn.status).toBe(200);
    const dev = await memberWithRole(app, owner.token, orgId, 'development_lead', { kind: 'organization', id: orgId }, 'Daniel Dev');
    const member = (await call(app, 'GET', `/v1/orgs/${orgId}/members`, { token: owner.token })).body.items.find((m: any) => m.user.id === dev.userId);
    expect(member.assignments[0]).toMatchObject({ role: 'development_lead', roleName: 'VP Franchise' });
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/roles`, { token: owner.token })).body.templates.find((t: any) => t.key === 'development_lead').label).toBe('VP Franchise');
    await call(app, 'PUT', `/v1/orgs/${orgId}/access/role-labels/development_lead`, { token: owner.token, body: { name: null } });

    const pv = await call(app, 'POST', `/v1/orgs/${orgId}/access/preview`, { token: owner.token, body: { role: 'field_consultant', scopeKind: 'portfolio', scopeId: portfolio } });
    expect(pv.status).toBe(200);
    expect(pv.body.locations).toEqual({ all: false, names: ['Dublin', 'West End'] });
    expect(pv.body.sensitive).toEqual([]);
    expect(pv.body.hidden).toEqual(expect.arrayContaining(['finance.payments', 'sales.customers', 'legal.agreements']));
    expect(pv.body.actions['network.locations']).toEqual(['view']);
    const denied = await call(app, 'POST', `/v1/orgs/${orgId}/access/preview`, { token: owner.token, body: { role: 'franchise_owner', scopeKind: 'owner_group', deniedClasses: ['finance'] } });
    expect(denied.body.sensitive).toEqual(['personal_data']);
  });

  it('team shape: a small team gets combined roles; changing it later never removes anything', async () => {
    const before = await call(app, 'GET', `/v1/orgs/${orgId}/access/team-shape`, { token: owner.token });
    expect(before.body.shape).toBeNull();
    const small = await call(app, 'PUT', `/v1/orgs/${orgId}/access/team-shape`, { token: owner.token, body: { shape: 'small', names: { marketing_sales: 'Marketing & sales' } } });
    expect(small.status).toBe(200);
    expect(small.body.shape).toBe('small');
    const ids = small.body.combined.map((c: any) => c.roleId);
    expect(ids.every(Boolean)).toBe(true);
    const roles = (await call(app, 'GET', `/v1/orgs/${orgId}/roles`, { token: owner.token })).body.custom;
    const ms = roles.find((r: any) => r.name === 'Marketing & sales');
    expect(ms.capabilities).toEqual(expect.arrayContaining(['marketing.campaigns:publish', 'sales.customer_pipeline:edit']));
    const full = await call(app, 'PUT', `/v1/orgs/${orgId}/access/team-shape`, { token: owner.token, body: { shape: 'full' } });
    expect(full.body.shape).toBe('full');
    expect(full.body.combined.map((c: any) => c.roleId)).toEqual(ids);
    const again = await call(app, 'PUT', `/v1/orgs/${orgId}/access/team-shape`, { token: owner.token, body: { shape: 'small' } });
    expect(again.body.combined.map((c: any) => c.roleId)).toEqual(ids);
  });

  it('coverage: uncovered areas go to the owner until someone is assigned', async () => {
    const cov = await call(app, 'GET', `/v1/orgs/${orgId}/access/coverage`, { token: owner.token });
    expect(cov.status).toBe(200);
    expect(cov.body.uncovered).toContain('royalties');
    // Nobody handles royalties: notifications for them go to the owner.
    const r1 = await responsibleUsersAt(app.ctx.db, orgId, null, 'disclosure.approve');
    expect(r1).toEqual({ userIds: [owner.userId], fallback: true });
    const acct = await memberWithRole(app, owner.token, orgId, 'accountant', { kind: 'organization', id: orgId }, 'Ann Accountant');
    const assigned = await call(app, 'POST', `/v1/orgs/${orgId}/access/coverage/royalties/assign`, { token: owner.token, body: { userId: acct.userId } });
    expect(assigned.status).toBe(200);
    expect(assigned.body.uncovered).not.toContain('royalties');
    expect(assigned.body.items.find((i: any) => i.key === 'royalties').holders.map((h: any) => h.name)).toEqual(['Ann Accountant']);
    // Someone handles legal now: the owner is no longer the fallback.
    const counsel = await memberWithRole(app, owner.token, orgId, 'legal_lead', { kind: 'organization', id: orgId }, 'Counsel');
    const r2 = await responsibleUsersAt(app.ctx.db, orgId, null, 'disclosure.approve');
    expect(r2).toEqual({ userIds: [counsel.userId], fallback: false });
    // Assigning needs the person to have an organisation-wide role.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/access/coverage/training/assign`, { token: owner.token, body: { userId: consultant.userId } })).status).toBe(400);
  });

  it('operations routes require their own module, at the guard and at each location', async () => {
    const staff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: west.id }, 'Sam Staff');
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/studios/occurrences`, { token: staff.token })).status).toBe(200);
    const members = await call(app, 'GET', `/v1/orgs/${orgId}/studios/members`, { token: staff.token });
    expect(members.status).toBe(403);
    expect(members.body.error.code).toBe('module_not_available');
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/studios/reports`, { token: staff.token })).status).toBe(403);
    const sales = await memberWithRole(app, owner.token, orgId, 'sales_rep', { kind: 'organization', id: orgId }, 'Sally Sales');
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/studios/members`, { token: sales.token })).status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/studios/occurrences`, { token: sales.token })).status).toBe(403);
    // One module at one location and another elsewhere: each route sees only its module's locations.
    const mixed = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: east.id }, 'Mixed');
    const roleId = (await call(app, 'POST', `/v1/orgs/${orgId}/roles`, { token: owner.token, body: { name: `Members only ${uid()}`, capabilities: ['operations.memberships:view'] } })).body.id;
    await call(app, 'POST', `/v1/orgs/${orgId}/role-assignments`, { token: owner.token, body: { userId: mixed.userId, role: 'custom', customRoleId: roleId, scope: { kind: 'location', id: west.id }, grants: [], revokes: [] } });
    // Classes at West End are not theirs (they only hold Members & pricing there): nothing from West End comes back.
    const occ = await call(app, 'GET', `/v1/orgs/${orgId}/studios/occurrences?locationId=${west.id}`, { token: mixed.token });
    if (occ.status === 200) expect(JSON.stringify(occ.body)).not.toContain(west.id);
    else expect([403, 404]).toContain(occ.status);
  });

  it('migrates the old role keys to the nearest template, keeping what the old template gave', async () => {
    const u = await verifiedUser(app, 'Legacy Trainer');
    const v = await verifiedUser(app, 'Legacy VP');
    const [a1] = await app.ctx.db.insert(roleAssignments).values({ organizationId: orgId, userId: u.userId, role: 'instructor_trainer', scopeKind: 'organization', scopeId: orgId }).returning();
    const [a2] = await app.ctx.db.insert(roleAssignments).values({ organizationId: orgId, userId: v.userId, role: 'vp_franchise', scopeKind: 'organization', scopeId: orgId }).returning();
    // Before the data migration runs, legacy keys still resolve to their nearest template.
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/access/me`, { token: v.token })).body.capabilities).toContain('sales.franchise_pipeline:publish');
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle/0023_migrate_legacy_roles.sql');
    // The migrator runs a file on one connection in one transaction; do the same.
    await app.ctx.db.transaction(async (tx) => {
      for (const stmt of readFileSync(file, 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await tx.execute(sql.raw(stmt));
    });
    const rows = await app.ctx.db.select().from(roleAssignments).where(and(eq(roleAssignments.organizationId, orgId), eq(roleAssignments.userId, u.userId)));
    expect(rows[0]!.role).toBe('trainer');
    expect((await app.ctx.db.select().from(roleAssignments).where(eq(roleAssignments.id, a2!.id)))[0]!.role).toBe('development_lead');
    const ov = await app.ctx.db.select().from(memberAccessOverrides).where(eq(memberAccessOverrides.assignmentId, a1!.id));
    expect(ov.map((o) => o.capability).sort()).toEqual(['sales.course_leads:edit', 'sales.course_leads:view']);
    const me = (await call(app, 'GET', `/v1/orgs/${orgId}/access/me`, { token: u.token })).body;
    expect(me.capabilities).toEqual(expect.arrayContaining(['training.academy:edit', 'sales.course_leads:edit']));
    // The prospect table holds the territory column used by the pipeline scope.
    expect((await app.ctx.db.select().from(franchiseProspects).where(eq(franchiseProspects.organizationId, orgId))).every((p) => p.scopeTerritoryId === null || p.scopeTerritoryId === ireland || typeof p.scopeTerritoryId === 'string')).toBe(true);
  });
});

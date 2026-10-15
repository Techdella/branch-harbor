import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { call, createLocation, createOrg, grantCaps, hasDb, makeApp, memberWithRole, verifiedUser, uid } from './helpers.ts';

/**
 * Access gaps closed after the team-templates release: screen-level sub-modules for management screens (staff keep
 * the front-line screens only), portfolio and territory management, and territory-scoped franchise legal.
 */
describe.skipIf(!hasDb)('screen-level sub-modules (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });

  it('staff can work classes but not the schedule builder or rooms; location managers can; a grant opens one screen', async () => {
    const owner = await verifiedUser(app, 'Screens Owner');
    const orgId = (await createOrg(app, owner.token, { name: `Screens ${uid()}`, industry: 'studios' })).id;
    const loc = await createLocation(app, owner.token, orgId, { name: 'Studio One' });
    const staff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: loc.id }, 'Sam Staff');
    const manager = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: loc.id }, 'Mia Manager');
    const room = { locationId: loc.id, name: `Room ${uid()}`, capacity: 12 };

    const me = await call(app, 'GET', `/v1/orgs/${orgId}/access/me`, { token: staff.token });
    expect(me.body.capabilities).toContain('operations.classes:edit');
    expect(me.body.capabilities).not.toContain('operations.classes.rooms:view');
    expect(me.body.capabilities).not.toContain('operations.classes.schedule_builder:view');

    // Front-line lookups still work (the class screen lists rooms and class types)…
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/studios/rooms`, { token: staff.token })).status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/studios/class-types`, { token: staff.token })).status).toBe(200);
    // …but changing what the management screens manage is refused.
    const denied = await call(app, 'POST', `/v1/orgs/${orgId}/studios/rooms`, { token: staff.token, body: room });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('module_not_available');
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/studios/class-types`, { token: staff.token, body: { locationId: loc.id, name: 'Flow', durationMinutes: 60, defaultCapacity: 10 } })).status).toBe(403);

    expect((await call(app, 'POST', `/v1/orgs/${orgId}/studios/rooms`, { token: manager.token, body: room })).status).toBe(201);

    // Granting the Rooms screen to one person opens exactly that screen.
    await grantCaps(app, owner.token, orgId, staff.userId, ['operations.classes.rooms:edit']);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/studios/rooms`, { token: staff.token, body: { ...room, name: `Room ${uid()}` } })).status).toBe(201);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/studios/class-types`, { token: staff.token, body: { locationId: loc.id, name: 'Flow', durationMinutes: 60, defaultCapacity: 10 } })).status).toBe(403);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { call, createLocation, createOrg, hasDb, makeApp, uid, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('organisations, locations, members and scoped permissions (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });

  it('creates an org with onboarding checklist and enforces location scopes', async () => {
    const owner = await verifiedUser(app, 'Owner');
    const org = await createOrg(app, owner.token);
    expect(org.dataRegion).toBe('us');

    const ob = await call(app, 'GET', `/v1/orgs/${org.id}/onboarding`, { token: owner.token });
    expect(ob.body.total).toBe(9);
    expect(ob.body.steps.find((st: any) => st.key === 'account').status).toBe('complete');
    expect(ob.body.steps.find((st: any) => st.key === 'first_location').status).toBe('not_started');
    expect((await call(app, 'PUT', `/v1/orgs/${org.id}/onboarding/connections`, { token: owner.token, body: { status: 'skipped' } })).status).toBe(200);
    expect((await call(app, 'PUT', `/v1/orgs/${org.id}/onboarding/first_location`, { token: owner.token, body: { status: 'skipped' } })).status).toBe(400);

    const a = await createLocation(app, owner.token, org.id, { name: 'Queen West' });
    const b = await createLocation(app, owner.token, org.id, { name: 'Seattle', currency: 'USD', timeZone: 'America/Los_Angeles', address: { line1: '1520 E Pine St', city: 'Seattle', region: 'WA', country: 'US' } });
    expect(a.publiclyVisible).toBe(false); // never auto-visible
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/locations`, { token: owner.token, body: { name: 'Bad', code: 'BAD1', address: { line1: 'x', city: 'y', country: 'CA' }, timeZone: 'Mars/Olympus', currency: 'CAD' } })).body.error.fields.timeZone).toBeTruthy();

    // Invite a location manager for location A only.
    const mgr = await verifiedUser(app, 'Manager');
    const inv = await call(app, 'POST', `/v1/orgs/${org.id}/invitations`, { token: owner.token, body: { email: mgr.email, role: 'location_manager', scope: { kind: 'location', id: a.id } } });
    expect(inv.status).toBe(201);
    const acc = await call(app, 'POST', '/v1/invitations/accept', { token: mgr.token, body: { token: inv.body.devInvitationToken } });
    expect(acc.status).toBe(200);

    const list = await call(app, 'GET', `/v1/orgs/${org.id}/locations`, { token: mgr.token });
    expect(list.body.items.map((l: any) => l.id)).toEqual([a.id]);
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/locations/${a.id}`, { token: mgr.token })).status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/locations/${b.id}`, { token: mgr.token })).status).toBe(403);
    expect((await call(app, 'PATCH', `/v1/orgs/${org.id}/locations/${a.id}`, { token: mgr.token, body: { phone: '+1 416 555 0142' } })).status).toBe(403); // no locations.write
    // Location managers cannot invite at org scope or grant roles they don't hold.
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/invitations`, { token: mgr.token, body: { email: `x-${uid()}@example.com`, role: 'staff', scope: { kind: 'location', id: a.id } } })).status).toBe(403);

    // A user from another organisation sees nothing.
    const outsider = await verifiedUser(app, 'Outsider');
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/locations`, { token: outsider.token })).status).toBe(404);

    // HQ admin sees reports but not customers.
    const hq = await verifiedUser(app, 'HQ');
    const inv2 = await call(app, 'POST', `/v1/orgs/${org.id}/invitations`, { token: owner.token, body: { email: hq.email, role: 'hq_admin', scope: { kind: 'organization', id: org.id } } });
    await call(app, 'POST', '/v1/invitations/accept', { token: hq.token, body: { token: inv2.body.devInvitationToken } });
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/reports/overview`, { token: hq.token })).status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/customers`, { token: hq.token })).body.items).toEqual([]);

    // Revocation removes access on the very next request (same access token).
    const members = await call(app, 'GET', `/v1/orgs/${org.id}/members`, { token: owner.token });
    const mgrAssignment = members.body.items.find((m: any) => m.user.id === mgr.userId).assignments[0];
    expect((await call(app, 'DELETE', `/v1/orgs/${org.id}/role-assignments/${mgrAssignment.id}`, { token: owner.token })).status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/locations/${a.id}`, { token: mgr.token })).status).toBe(404);

    // The last owner cannot be removed.
    const ownerAssignment = members.body.items.find((m: any) => m.user.id === owner.userId).assignments[0];
    expect((await call(app, 'DELETE', `/v1/orgs/${org.id}/role-assignments/${ownerAssignment.id}`, { token: owner.token })).body.error.code).toBe('last_owner');

    const audit = await call(app, 'GET', `/v1/orgs/${org.id}/audit-events?action=member.role_revoked`, { token: owner.token });
    expect(audit.body.items).toHaveLength(1);
  });

  it('imports locations from CSV with row-level validation errors', async () => {
    const owner = await verifiedUser(app);
    const org = await createOrg(app, owner.token);
    const csv = [
      'name,code,address_line1,city,state_region,postal_code,country,time_zone,currency,region,owner_group',
      'Shoreditch,LDN1,1 Rivington St,London,,EC2A 3DT,GB,Europe/London,GBP,Europe,Company-owned',
      'Mitte,BER1,Torstraße 1,Berlin,,10119,DE,Europe/Berlin,EUR,Europe,Company-owned',
      'Broken,LDN1,2 Somewhere,London,,,GB,Europe/Lundon,GBP,,',
      ',SYD1,"1 George St, Level 2",Sydney,NSW,2000,AU,Australia/Sydney,AUD,APAC,',
    ].join('\n');
    const dry = await call(app, 'POST', `/v1/orgs/${org.id}/locations/import`, { token: owner.token, body: { csv } });
    expect(dry.status).toBe(200);
    expect(dry.body.committed).toBe(false);
    expect(dry.body.validRows).toBe(2);
    expect(dry.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 4, field: 'code' }),
      expect.objectContaining({ row: 4, field: 'time_zone' }),
      expect.objectContaining({ row: 5, field: 'name' }),
    ]));
    const commit = await call(app, 'POST', `/v1/orgs/${org.id}/locations/import`, { token: owner.token, body: { csv, createValidRows: true } });
    expect(commit.body.committed).toBe(true);
    expect(commit.body.created).toHaveLength(2);
    const regions = await call(app, 'GET', `/v1/orgs/${org.id}/regions`, { token: owner.token });
    expect(regions.body.items.map((r: any) => r.name)).toEqual(['Europe']);
  });

  it('accepts demo requests, validates and rate-limits them', async () => {
    const body = { name: 'Priya', email: `demo-${uid()}@example.com`, business: 'Stillwater Yoga', industry: 'studios', locationCount: 6, country: 'CA', primaryDifficulty: 'Inconsistent sites' };
    const r = await call(app, 'POST', '/v1/public/demo-requests', { body });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('received');
    await app.ctx.jobs.drain();
    expect(app.ctx.mailer.outbox.some((m) => m.tag === 'demo-request' && m.subject.includes('Stillwater Yoga'))).toBe(true);
    const bad = await call(app, 'POST', '/v1/public/demo-requests', { body: { ...body, industry: 'mining', email: 'x' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields).toHaveProperty('industry');
    let limited = 0;
    for (let i = 0; i < 6; i++) if ((await call(app, 'POST', '/v1/public/demo-requests', { body })).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});

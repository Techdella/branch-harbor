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

const pdf = Buffer.from('%PDF-1.4\n% BranchHarbor test document\n').toString('base64');

describe.skipIf(!hasDb)('territory-scoped franchise legal (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });

  it('a master franchisee granted Disclosure and Agreements on their territory sends disclosure, manages agreements and edits their country’s rules; HQ keeps visibility', async () => {
    const owner = await verifiedUser(app, 'Legal HQ Owner');
    const O = (await createOrg(app, owner.token, { name: `Legal ${uid()}`, industry: 'studios', country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/New_York' })).id;
    const dublin = await createLocation(app, owner.token, O, { name: 'Dublin', currency: 'EUR', address: { line1: '1 Richmond St', city: 'Dublin', country: 'IE' }, timeZone: 'Europe/Dublin' });
    const ireland = (await call(app, 'POST', `/v1/orgs/${O}/access/territories`, { token: owner.token, body: { name: 'Ireland', kind: 'master', country: 'IE', locationIds: [dublin.id] } })).body.id;
    const master = await memberWithRole(app, owner.token, O, 'master_franchisee', { kind: 'territory', id: ireland }, 'Siobhan Master');
    const upload = (token: string, kind: string, jurisdictions: string[], over: Record<string, unknown> = {}) =>
      call(app, 'POST', `/v1/orgs/${O}/franchise/documents`, { token, body: { kind, title: `${kind} ${uid()}`, version: '2026', jurisdictions, fileName: `${uid()}.pdf`, contentType: 'application/pdf', contentBase64: pdf, ...over } });

    const hqDoc = (await upload(owner.token, 'disclosure', ['US'])).body.id;
    const ieDoc = (await upload(owner.token, 'disclosure', ['IE'])).body.id;
    const prospect = (await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects`, { token: master.token, body: { name: 'Cork Prospect', email: `cork-${uid()}@example.com`, country: 'IE' } })).body;
    expect(prospect.scopeTerritoryId).toBe(ireland);
    const hqProspect = (await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects`, { token: owner.token, body: { name: 'Boston Prospect', email: `bos-${uid()}@example.com`, country: 'US', region: 'MA' } })).body;

    // Without the grant: the pipeline is theirs, franchise legal is not.
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/documents`, { token: master.token })).status).toBe(403);
    const refused = await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${prospect.id}/disclosures`, { token: master.token, body: { documentId: ieDoc } });
    expect(refused.status).toBe(403);
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/rules`, { token: master.token, body: rule('IE') })).status).toBe(403);

    await grantCaps(app, owner.token, O, master.userId, ['legal.disclosure:edit', 'legal.disclosure:publish', 'legal.agreements:edit']);
    const settings = await call(app, 'GET', `/v1/orgs/${O}/franchise/settings`, { token: master.token });
    expect(settings.body).toMatchObject({ territoryScoped: true, disclosure: { view: true, edit: true }, legal: { view: true, edit: true }, legalCountries: ['IE'] });

    // Documents: only their country's disclosure; they upload for IE but not for the US.
    const docs = await call(app, 'GET', `/v1/orgs/${O}/franchise/documents?kind=disclosure`, { token: master.token });
    expect(docs.body.items.map((d: any) => d.id)).toEqual([ieDoc]);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/documents/${hqDoc}/download`, { token: master.token })).status).toBe(403);
    expect((await upload(master.token, 'disclosure', ['US'])).status).toBe(403);
    expect((await upload(master.token, 'disclosure', ['IE'], { supersedePrevious: false })).status).toBe(201);

    // Disclosure for their own prospect; HQ's prospects stay invisible.
    const sent = await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${prospect.id}/disclosures`, { token: master.token, body: { documentId: ieDoc } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${hqProspect.id}/disclosures`, { token: master.token, body: { documentId: ieDoc } })).status).toBe(404);

    // Jurisdiction rules and registrations of their country only.
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/rules`, { token: master.token, body: rule('IE') })).status).toBe(201);
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/rules`, { token: master.token, body: rule('US-CA') })).status).toBe(403);
    expect((await call(app, 'PUT', `/v1/orgs/${O}/franchise/registrations/IE`, { token: master.token, body: { status: 'exempt' } })).status).toBe(200);
    expect((await call(app, 'PUT', `/v1/orgs/${O}/franchise/registrations/US-NY`, { token: master.token, body: { status: 'registered' } })).status).toBe(403);
    await call(app, 'PUT', `/v1/orgs/${O}/franchise/registrations/US-NY`, { token: owner.token, body: { status: 'registered' } });
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/registrations`, { token: master.token })).body.items.map((r: any) => r.jurisdiction)).toEqual(['IE']);

    // Agreements: for owner groups of their territory only.
    const [group] = (await call(app, 'GET', `/v1/orgs/${O}/franchise/owner-groups`, { token: owner.token })).body.items;
    expect(group).toBeUndefined();
    const og = await call(app, 'POST', `/v1/orgs/${O}/owner-groups`, { token: owner.token, body: { name: 'Cork Fitness Ltd' } });
    const ogId = og.body.id ?? og.body.item?.id;
    const other = await call(app, 'POST', `/v1/orgs/${O}/owner-groups`, { token: owner.token, body: { name: 'Boston Fitness LLC' } });
    const otherId = other.body.id ?? other.body.item?.id;
    await call(app, 'PATCH', `/v1/orgs/${O}/locations/${dublin.id}`, { token: owner.token, body: { ownerGroupId: ogId } });
    const agreement = { startDate: '2026-01-01', endDate: '2036-01-01', jurisdiction: 'IE' };
    const mine = await call(app, 'POST', `/v1/orgs/${O}/legal/agreements`, { token: master.token, body: { ...agreement, ownerGroupId: ogId, locationIds: [dublin.id] } });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect((await call(app, 'POST', `/v1/orgs/${O}/legal/agreements`, { token: master.token, body: { ...agreement, ownerGroupId: otherId } })).status).toBe(403);
    const hqAgreement = await call(app, 'POST', `/v1/orgs/${O}/legal/agreements`, { token: owner.token, body: { startDate: '2026-01-01', endDate: '2036-01-01', ownerGroupId: otherId } });
    expect((await call(app, 'PATCH', `/v1/orgs/${O}/legal/agreements/${hqAgreement.body.id}`, { token: master.token, body: { renewalOption: 'x' } })).status).toBe(404);
    expect((await call(app, 'PATCH', `/v1/orgs/${O}/legal/agreements/${mine.body.id}`, { token: master.token, body: { renewalOption: 'One 10-year renewal' } })).status).toBe(200);
    const reg = await call(app, 'GET', `/v1/orgs/${O}/legal/agreements`, { token: master.token });
    expect(reg.body).toMatchObject({ scope: 'territory' });
    expect(reg.body.items.map((a: any) => a.id)).toEqual([mine.body.id]);

    // HQ keeps visibility of everything the territory did.
    expect((await call(app, 'GET', `/v1/orgs/${O}/legal/agreements`, { token: owner.token })).body.items).toHaveLength(2);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/rules`, { token: owner.token })).body.items.some((r: any) => r.code === 'IE' && r.version === 'mf-1')).toBe(true);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects/${prospect.id}`, { token: owner.token })).body.stage).toBe('disclosure_sent');
  });
});

function rule(code: string) {
  return {
    code, name: `${code} rule`, version: 'mf-1', effectiveFrom: '2026-01-01', status: 'no_statute', sources: [{ law: 'None' }],
    disclosure: { required: false, document: null, minDaysBeforeSigning: null, minDaysBeforePayment: null, dayCount: 'calendar' },
    registration: { kind: 'none', beforeOffer: false }, coolingOff: null, confidence: 'medium',
  };
}

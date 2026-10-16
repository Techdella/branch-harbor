import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { call, createOrg, hasDb, makeApp, memberWithRole, verifiedUser, uid } from './helpers.ts';

/**
 * Network → Locations → Add location: the form's options (brands, brand templates, owner groups, regions, territories,
 * industry details) and creating the location with all of them.
 */
describe.skipIf(!hasDb)('add location with brand, template, territory and industry details (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });

  const address = { line1: '1 Harbour St', city: 'Dublin', postalCode: 'D02 X285', country: 'IE' };

  it('offers the brand picker only with more than one brand and creates the location with everything chosen', async () => {
    const owner = await verifiedUser(app, 'Add Location Owner');
    const O = (await createOrg(app, owner.token, { name: `AddLoc ${uid()}`, industry: 'foods', country: 'IE', defaultCurrency: 'EUR', defaultTimeZone: 'Europe/Dublin' })).id;

    const single = await call(app, 'GET', `/v1/orgs/${O}/locations/form-options`, { token: owner.token });
    expect(single.status, JSON.stringify(single.body)).toBe(200);
    expect(single.body).toMatchObject({ industry: 'foods', organizationWide: true, brandPicker: false, defaults: { currency: 'EUR', timeZone: 'Europe/Dublin' } });
    expect(single.body.industryFields.map((f: any) => f.key)).toEqual(['serviceStyle', 'seats', 'alcoholLicence']);

    const B = (await call(app, 'POST', `/v1/orgs/${O}/brands`, { token: owner.token, body: { name: `Second ${uid()}` } })).body.id as string;
    const region = (await call(app, 'POST', `/v1/orgs/${O}/regions`, { token: owner.token, body: { name: 'Ireland' } })).body;
    const group = (await call(app, 'POST', `/v1/orgs/${O}/owner-groups`, { token: owner.token, body: { name: 'Liffey Foods Ltd' } })).body;
    const terr = (await call(app, 'POST', `/v1/orgs/${O}/access/territories`, { token: owner.token, body: { name: 'Second Ireland', kind: 'master', country: 'IE', brandId: B } })).body;
    const mainTerr = (await call(app, 'POST', `/v1/orgs/${O}/access/territories`, { token: owner.token, body: { name: 'Main Ireland', kind: 'master', country: 'IE' } })).body;
    const field = [{ key: 'headline', label: 'Headline', type: 'text', policy: 'editable', defaultValue: 'Hello' }];
    const brandTpl = (await call(app, 'POST', `/v1/orgs/${O}/templates`, { token: owner.token, body: { name: 'Second brand standard', industry: 'foods', fields: field, brandId: B } })).body;
    const mainTpl = (await call(app, 'POST', `/v1/orgs/${O}/templates`, { token: owner.token, body: { name: 'Main standard', industry: 'foods', fields: field } })).body;
    expect(brandTpl.brandId).toBe(B);

    const multi = await call(app, 'GET', `/v1/orgs/${O}/locations/form-options`, { token: owner.token });
    expect(multi.body.brandPicker).toBe(true);
    expect(multi.body.brands.map((b: any) => b.id)).toContain(B);
    expect(multi.body.templates.map((t: any) => t.id).sort()).toEqual([brandTpl.id, mainTpl.id].sort());
    expect(multi.body.ownerGroups.map((g: any) => g.id)).toEqual([group.id]);
    expect(multi.body.regions.map((r: any) => r.id)).toEqual([region.id]);
    expect(multi.body.territories.map((t: any) => t.id).sort()).toEqual([mainTerr.id, terr.id].sort());

    const body = {
      name: 'Grand Canal Dock', code: 'DUB-GC', address, timeZone: 'Europe/Dublin', currency: 'EUR', brandId: B, regionId: region.id, ownerGroupId: group.id, territoryId: terr.id, templateId: brandTpl.id,
      hours: 'Daily 11am–10pm', industryFields: { serviceStyle: 'table', seats: 64, alcoholLicence: true },
    };
    const created = await call(app, 'POST', `/v1/orgs/${O}/locations`, { token: owner.token, body });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ name: 'Grand Canal Dock', brandId: B, regionId: region.id, ownerGroupId: group.id, territoryId: terr.id, templateId: brandTpl.id, status: 'draft', publiclyVisible: false, hours: { summary: 'Daily 11am–10pm' }, industryDetails: { serviceStyle: 'table', seats: 64, alcoholLicence: true } });
    const read = await call(app, 'GET', `/v1/orgs/${O}/locations/${created.body.id}`, { token: owner.token });
    expect(read.body.industryDetails).toEqual({ serviceStyle: 'table', seats: 64, alcoholLicence: true });

    // A territory or a template of another brand, and details the industry doesn't have, are refused.
    const wrongTerr = await call(app, 'POST', `/v1/orgs/${O}/locations`, { token: owner.token, body: { ...body, code: 'DUB-X1', territoryId: mainTerr.id } });
    expect(wrongTerr.status).toBe(400);
    expect(wrongTerr.body.error?.fields ?? wrongTerr.body.fields ?? wrongTerr.body).toHaveProperty('territoryId');
    expect((await call(app, 'POST', `/v1/orgs/${O}/locations`, { token: owner.token, body: { ...body, code: 'DUB-X2', territoryId: undefined, templateId: mainTpl.id, brandId: undefined } })).status).toBe(201);
    const wrongTpl = await call(app, 'POST', `/v1/orgs/${O}/locations`, { token: owner.token, body: { ...body, code: 'DUB-X3', territoryId: undefined, brandId: undefined, templateId: brandTpl.id } });
    expect(wrongTpl.status).toBe(400);
    const badDetails = await call(app, 'POST', `/v1/orgs/${O}/locations`, { token: owner.token, body: { ...body, code: 'DUB-X4', industryFields: { seats: -3, rooms: 4 } } });
    expect(badDetails.status).toBe(400);
    expect(JSON.stringify(badDetails.body)).toContain('industryFields.seats');
    expect(JSON.stringify(badDetails.body)).toContain('industryFields.rooms');
  });

  it('an operations lead on one region is offered their own region only, without owner groups', async () => {
    const owner = await verifiedUser(app, 'Regional Owner');
    const O = (await createOrg(app, owner.token, { name: `Regional ${uid()}` })).id;
    const east = (await call(app, 'POST', `/v1/orgs/${O}/regions`, { token: owner.token, body: { name: 'East' } })).body;
    await call(app, 'POST', `/v1/orgs/${O}/regions`, { token: owner.token, body: { name: 'West' } });
    await call(app, 'POST', `/v1/orgs/${O}/owner-groups`, { token: owner.token, body: { name: 'Hidden Group' } });
    const rm = await memberWithRole(app, owner.token, O, 'operations_lead', { kind: 'region', id: east.id });
    const opts = await call(app, 'GET', `/v1/orgs/${O}/locations/form-options`, { token: rm.token });
    expect(opts.status).toBe(200);
    expect(opts.body.organizationWide).toBe(false);
    expect(opts.body.regions.map((r: any) => r.id)).toEqual([east.id]);
    expect(opts.body.ownerGroups).toEqual([]);
    const staff = await memberWithRole(app, owner.token, O, 'staff', { kind: 'region', id: east.id });
    expect((await call(app, 'GET', `/v1/orgs/${O}/locations/form-options`, { token: staff.token })).status).toBe(403);
  });
});

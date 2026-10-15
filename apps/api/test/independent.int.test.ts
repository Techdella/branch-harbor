import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { SOLO_PLAN } from '@bh/shared';
import { auditEvents } from '../src/db/schema/index.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

/** Independent (single-location) businesses: business mode, one-step setup, role limits, upgrade path, direct publishing. */
describe.skipIf(!hasDb)('independent businesses (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });

  const independentBody = (over: Record<string, unknown> = {}) => ({
    name: `Café ${uid()}`, industry: 'foods', model: 'independent', country: 'PT', defaultCurrency: 'EUR', defaultTimeZone: 'Europe/Lisbon', defaultLocale: 'en', dataRegion: 'eu',
    firstLocation: {
      address: { line1: 'Rua de São Miguel 12', city: 'Lisbon', postalCode: '1100-544', country: 'PT' },
      phone: '+351 21 555 0100',
      hours: { summary: 'Tue–Sun 08:00–18:00', weekly: [{ day: 2, opens: '08:00', closes: '18:00' }] },
    },
    ...over,
  });

  async function independentOrg(token: string, over: Record<string, unknown> = {}) {
    const r = await call(app, 'POST', '/v1/orgs', { token, body: independentBody(over) });
    expect(r.status).toBe(201);
    return r.body;
  }

  it('exposes the business mode on /auth/me and the organisation endpoints', async () => {
    const owner = await verifiedUser(app, 'Owner');
    const network = await createOrg(app, owner.token);
    const indep = await independentOrg(owner.token);
    const me = await call(app, 'GET', '/v1/auth/me', { token: owner.token });
    expect(me.status).toBe(200);
    const n = me.body.organizations.find((o: any) => o.id === network.id);
    const i = me.body.organizations.find((o: any) => o.id === indep.id);
    expect(n).toMatchObject({ model: 'network', isSingleLocation: false, primaryLocationId: null });
    expect(n.features.scopeSelector).toBe(true);
    expect(i).toMatchObject({ model: 'independent', isSingleLocation: true, primaryLocationId: indep.firstLocation.id, websiteApprovals: 'off' });
    expect(i.features).toMatchObject({ scopeSelector: false, regions: false, ownerGroups: false, groupPublish: false, locationsDirectory: false });
    expect(i.availableRoles).toEqual(['org_owner', 'location_manager', 'staff', 'content_social', 'finance_lead', 'accountant', 'sales_rep']);
    expect(n.availableRoles).toContain('franchise_owner');

    const g = await call(app, 'GET', `/v1/orgs/${indep.id}`, { token: owner.token });
    expect(g.body).toMatchObject({ model: 'independent', isSingleLocation: true, locationCount: 1 });
    expect(g.body.businessMode.primaryLocationId).toBe(indep.firstLocation.id);
    const list = await call(app, 'GET', '/v1/orgs', { token: owner.token });
    expect(list.body.items.find((o: any) => o.id === indep.id).isSingleLocation).toBe(true);
  });

  it('creates an independent business and its only location in one step, on the Solo plan', async () => {
    const owner = await verifiedUser(app, 'Owner');
    const org = await independentOrg(owner.token, { name: 'Café Alfama Test' });
    expect(org.model).toBe('independent');
    expect(org.firstLocation).toMatchObject({ name: 'Lisbon', code: 'MAIN', currency: 'EUR', timeZone: 'Europe/Lisbon', publiclyVisible: false });
    expect(org.firstLocation.hours.summary).toBe('Tue–Sun 08:00–18:00');

    const locs = await call(app, 'GET', `/v1/orgs/${org.id}/locations`, { token: owner.token });
    expect(locs.body.items).toHaveLength(1);

    const ob = await call(app, 'GET', `/v1/orgs/${org.id}/onboarding`, { token: owner.token });
    expect(ob.body.model).toBe('independent');
    const keys = ob.body.steps.map((st: any) => st.key);
    expect(keys).not.toContain('invite_staff');
    expect(keys).not.toContain('business_details');
    expect(ob.body.total).toBe(7);
    expect(ob.body.steps.find((st: any) => st.key === 'first_location').status).toBe('complete');
    // Progress still saves.
    expect((await call(app, 'PUT', `/v1/orgs/${org.id}/onboarding/website`, { token: owner.token, body: { status: 'in_progress', data: { kind: 'hosted' } } })).status).toBe(200);

    const sub = await call(app, 'GET', `/v1/orgs/${org.id}/subscription`, { token: owner.token });
    expect(sub.status).toBe(200);
    expect(sub.body.plan).toBe('solo');
    expect(sub.body.planDetails).toMatchObject({ key: 'solo', pricing: 'flat', maxLocations: 1, price: { amount: SOLO_PLAN.priceMinor.EUR, currency: 'EUR', interval: 'month' } });
    expect(sub.body.estimatedTotal).toEqual({ amount: SOLO_PLAN.priceMinor.EUR, currency: 'EUR', interval: 'month' });

    // Regions, owner groups and templates are hidden for independents.
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/regions`, { token: owner.token })).body).toMatchObject({ items: [], hidden: true });
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/owner-groups`, { token: owner.token })).body).toMatchObject({ items: [], hidden: true });
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/templates`, { token: owner.token })).body).toMatchObject({ items: [], hidden: true });
    const region = await call(app, 'POST', `/v1/orgs/${org.id}/regions`, { token: owner.token, body: { name: 'Europe' } });
    expect(region.status).toBe(409);
    expect(region.body.error.code).toBe('upgrade_required');

    // Reports carry no per-location breakdown.
    const rep = await call(app, 'GET', `/v1/orgs/${org.id}/reports/overview`, { token: owner.token });
    expect(rep.body.businessModel).toBe('independent');
    expect(rep.body.revenueByLocation).toEqual([]);
  });

  it('restricts invitation roles for independent businesses', async () => {
    const owner = await verifiedUser(app, 'Owner');
    const org = await independentOrg(owner.token);
    const loc = org.firstLocation.id;
    for (const role of ['hq_admin', 'field_consultant', 'franchise_owner', 'master_franchisee']) {
      const r = await call(app, 'POST', `/v1/orgs/${org.id}/invitations`, { token: owner.token, body: { email: `x-${uid()}@example.com`, role, scope: { kind: 'organization', id: org.id } } });
      expect(r.status, role).toBe(400);
      expect(r.body.error.code).toBe('role_not_available');
    }
    for (const role of ['location_manager', 'staff', 'content_social', 'finance_lead']) {
      const r = await call(app, 'POST', `/v1/orgs/${org.id}/invitations`, { token: owner.token, body: { email: `x-${uid()}@example.com`, role, scope: { kind: 'location', id: loc } } });
      expect(r.status, role).toBe(201);
    }
    const coOwner = await call(app, 'POST', `/v1/orgs/${org.id}/invitations`, { token: owner.token, body: { email: `x-${uid()}@example.com`, role: 'org_owner', scope: { kind: 'organization', id: org.id } } });
    expect(coOwner.status).toBe(201);
    // Networks keep every role.
    const net = await createOrg(app, owner.token);
    expect((await call(app, 'POST', `/v1/orgs/${net.id}/invitations`, { token: owner.token, body: { email: `x-${uid()}@example.com`, role: 'franchise_owner', scope: { kind: 'organization', id: net.id } } })).status).toBe(201);
  });

  it('requires an upgrade before adding a second location', async () => {
    const owner = await verifiedUser(app, 'Owner');
    const org = await independentOrg(owner.token);
    const second = { name: 'Second café', code: 'LIS2', address: { line1: 'Rua Augusta 1', city: 'Lisbon', country: 'PT' }, timeZone: 'Europe/Lisbon', currency: 'EUR' };
    const r = await call(app, 'POST', `/v1/orgs/${org.id}/locations`, { token: owner.token, body: second });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('upgrade_required');
    expect(r.body.error.message).toMatch(/upgrade to a network/i);
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/locations/import`, { token: owner.token, body: { csv: 'name,code\nx,y' } })).body.error.code).toBe('upgrade_required');
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/locations`, { token: owner.token })).body.items).toHaveLength(1);

    // With the explicit flag, the owner upgrades and adds the location in one step.
    const ok = await call(app, 'POST', `/v1/orgs/${org.id}/locations`, { token: owner.token, body: { ...second, upgradeToNetwork: true } });
    expect(ok.status).toBe(201);
    expect(ok.body.organizationUpgraded).toBe(true);
    const g = await call(app, 'GET', `/v1/orgs/${org.id}`, { token: owner.token });
    expect(g.body).toMatchObject({ model: 'network', isSingleLocation: false, locationCount: 2 });
  });

  it('upgrades to a network (owner only, audited) and keeps all data', async () => {
    const owner = await verifiedUser(app, 'Owner');
    const org = await independentOrg(owner.token, { industry: 'studios', name: `Lumen ${uid()}`, country: 'AU', defaultCurrency: 'AUD', defaultTimeZone: 'Australia/Melbourne', dataRegion: 'apac',
      firstLocation: { address: { line1: '12 Smith St', city: 'Melbourne', region: 'VIC', postalCode: '3065', country: 'AU' } } });
    const loc = org.firstLocation;
    const site = await call(app, 'POST', `/v1/orgs/${org.id}/websites`, { token: owner.token, body: { locationId: loc.id } });
    expect(site.status).toBe(201);
    expect(site.body.includedAddress).toMatch(new RegExp(`/${org.slug}$`)); // brand site IS the location site
    const mgr = await memberWithRole(app, owner.token, org.id, 'location_manager', { kind: 'location', id: loc.id });

    const preview = await call(app, 'GET', `/v1/orgs/${org.id}/upgrade-to-network`, { token: owner.token });
    expect(preview.status).toBe(200);
    expect(preview.body.canUpgrade).toBe(true);
    expect(preview.body.consequences.length).toBeGreaterThan(3);
    expect(preview.body.currentPlan.key).toBe('solo');
    expect(preview.body.nextPlan.price).toMatchObject({ currency: 'AUD' });

    expect((await call(app, 'POST', `/v1/orgs/${org.id}/upgrade-to-network`, { token: mgr.token, body: { confirm: true } })).status).toBe(403);
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/upgrade-to-network`, { token: owner.token, body: {} })).status).toBe(400);

    const up = await call(app, 'POST', `/v1/orgs/${org.id}/upgrade-to-network`, { token: owner.token, body: { confirm: true, reason: 'Opening a second studio' } });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ model: 'network', isSingleLocation: false, upgraded: true });
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/upgrade-to-network`, { token: owner.token, body: { confirm: true } })).body.error.code).toBe('already_network');

    // Data kept: same location, website (now at /{brand}/{location}), team.
    const locs = await call(app, 'GET', `/v1/orgs/${org.id}/locations`, { token: owner.token });
    expect(locs.body.items.map((l: any) => l.id)).toEqual([loc.id]);
    const sites = await call(app, 'GET', `/v1/orgs/${org.id}/websites`, { token: owner.token });
    expect(sites.body.items).toHaveLength(1);
    expect(sites.body.items[0].includedAddress).toMatch(new RegExp(`/${org.slug}/${loc.slug}$`));
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/locations/${loc.id}`, { token: mgr.token })).status).toBe(200);

    // Audited, and network features now work.
    const audit = await app.ctx.db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, org.id), eq(auditEvents.action, 'org.upgraded_to_network')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ from: 'independent', to: 'network', trigger: 'explicit', reason: 'Opening a second studio' });
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/regions`, { token: owner.token, body: { name: 'Victoria' } })).status).toBe(201);
    await createLocation(app, owner.token, org.id, { name: 'Fitzroy', currency: 'AUD', timeZone: 'Australia/Melbourne', address: { line1: '300 Brunswick St', city: 'Melbourne', country: 'AU' } });
    const sub = await call(app, 'GET', `/v1/orgs/${org.id}/subscription`, { token: owner.token });
    expect(sub.body.plan).toBe('network');
    expect(sub.body.planDetails.pricing).toBe('per_location');
    const me = await call(app, 'GET', '/v1/auth/me', { token: owner.token });
    expect(me.body.organizations.find((o: any) => o.id === org.id)).toMatchObject({ model: 'network', isSingleLocation: false });
  });

  it('lets independents publish their website directly; approvals only when the owner enables them', async () => {
    const owner = await verifiedUser(app, 'Owner');
    const org = await independentOrg(owner.token);
    const loc = org.firstLocation;
    // A template with locked/approval fields (e.g. copied from an industry starter) has no effect for independents.
    const tpl = await call(app, 'POST', `/v1/orgs/${org.id}/templates`, {
      token: owner.token,
      body: { name: 'Café', fields: [
        { key: 'hero_title', label: 'Headline', policy: 'locked', defaultValue: 'Welcome' },
        { key: 'about', label: 'About', policy: 'approval', defaultValue: 'Coffee and pastries' },
      ] },
    });
    expect(tpl.status).toBe(201);
    const site = await call(app, 'POST', `/v1/orgs/${org.id}/websites`, { token: owner.token, body: { locationId: loc.id, templateId: tpl.body.id } });
    const pageId = site.body.pages[0].id;

    const view = await call(app, 'GET', `/v1/orgs/${org.id}/pages/${pageId}`, { token: owner.token });
    expect(view.body.businessModel).toBe('independent');
    expect(view.body.fields.every((f: any) => f.editableLocally && !f.requiresApproval && f.origin === 'local')).toBe(true);

    const mgr = await memberWithRole(app, owner.token, org.id, 'location_manager', { kind: 'location', id: loc.id });
    const mkt = await memberWithRole(app, owner.token, org.id, 'content_social', { kind: 'location', id: loc.id });

    // Approvals off (default): edits apply, the manager publishes directly.
    const ed = await call(app, 'PATCH', `/v1/orgs/${org.id}/pages/${pageId}/fields`, { token: mkt.token, body: { fields: { hero_title: 'Pastéis every morning', about: 'Family café since 1998' } } });
    expect(ed.status).toBe(200);
    expect(ed.body.results.map((r: any) => r.result)).toEqual(['applied', 'applied']);
    const pub = await call(app, 'POST', `/v1/orgs/${org.id}/pages/${pageId}/publish`, { token: mgr.token });
    expect(pub.status).toBe(200);
    expect(pub.body.version.content).toMatchObject({ hero_title: 'Pastéis every morning', about: 'Family café since 1998' });

    // Owner turns approvals on for staff.
    expect((await call(app, 'PATCH', `/v1/orgs/${org.id}`, { token: owner.token, body: { websiteApprovals: 'staff' } })).body.businessMode.websiteApprovals).toBe('staff');
    const ed2 = await call(app, 'PATCH', `/v1/orgs/${org.id}/pages/${pageId}/fields`, { token: mkt.token, body: { fields: { about: 'New text' } } });
    expect(ed2.body.results[0].result).toBe('pending_approval');
    const blocked = await call(app, 'POST', `/v1/orgs/${org.id}/pages/${pageId}/publish`, { token: mgr.token });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('approval_required');
    const ownerEdit = await call(app, 'PATCH', `/v1/orgs/${org.id}/pages/${pageId}/fields`, { token: owner.token, body: { fields: { hero_title: 'Owner edit' } } });
    expect(ownerEdit.body.results[0].result).toBe('applied');
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/pages/${pageId}/publish`, { token: owner.token })).status).toBe(200);

    // Networks cannot use the independent approval switch.
    const net = await createOrg(app, owner.token);
    expect((await call(app, 'PATCH', `/v1/orgs/${net.id}`, { token: owner.token, body: { websiteApprovals: 'staff' } })).status).toBe(400);
  });

  it('serves the independent customer site at /{brand}', async () => {
    const owner = await verifiedUser(app, 'Owner');
    const org = await independentOrg(owner.token);
    const loc = org.firstLocation;
    await call(app, 'PATCH', `/v1/orgs/${org.id}/locations/${loc.id}`, { token: owner.token, body: { publiclyVisible: true, status: 'operating' } });
    const mode = await call(app, 'GET', `/v1/public/sites/resolve-brand?brand=${org.slug}`);
    expect(mode.body).toEqual({ brandSlug: org.slug, model: 'independent', singleLocationSlug: loc.slug });
    const brand = await call(app, 'GET', `/v1/public/sites/${org.slug}`);
    expect(brand.body.brand.model).toBe('independent');
    expect(brand.body.site.singleLocationSlug).toBe(loc.slug);
    expect(brand.body.locations[0].path).toBe(`/${org.slug}`);
    const site = await call(app, 'GET', `/v1/public/sites/${org.slug}/${loc.slug}`);
    expect(site.body.site).toMatchObject({ singleLocation: true, locationCount: 1 });
    expect(site.body.site.includedAddress).toMatch(new RegExp(`/${org.slug}$`));
    expect(site.body.module.kind).toBe('foods');
  });
});

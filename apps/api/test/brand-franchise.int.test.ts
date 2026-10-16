import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { call, createLocation, createOrg, grantCaps, hasDb, makeApp, memberWithRole, verifiedUser, uid } from './helpers.ts';

/**
 * Brand-scoped franchise work (multi-brand HQ): a person scoped to one brand works the franchise pipeline, disclosure
 * and agreements of that brand when they hold those modules, following the territory-scoped legal pattern.
 */
const pdf = Buffer.from('%PDF-1.4\n% BranchHarbor brand test document\n').toString('base64');

describe.skipIf(!hasDb)('brand-scoped franchise pipeline, disclosure and agreements (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });

  it('a brand’s development team works its own prospects, documents and agreements; other brands and HQ-only work stay closed', async () => {
    const owner = await verifiedUser(app, 'Brand HQ Owner');
    const O = (await createOrg(app, owner.token, { name: `Brands ${uid()}`, industry: 'studios', country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/New_York' })).id;
    const second = await call(app, 'POST', `/v1/orgs/${O}/brands`, { token: owner.token, body: { name: `Second Brand ${uid()}` } });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const B = second.body.id as string;
    const main = (await call(app, 'GET', `/v1/orgs/${O}/brands`, { token: owner.token })).body.items.find((b: any) => b.isDefault).id as string;
    const mainLoc = await createLocation(app, owner.token, O, { name: 'Main Boston', address: { line1: '1 Main St', city: 'Boston', region: 'MA', country: 'US' }, timeZone: 'America/New_York', currency: 'USD' });
    const brandLoc = await createLocation(app, owner.token, O, { name: 'Second Austin', brandId: B, address: { line1: '2 Congress Ave', city: 'Austin', region: 'TX', country: 'US' }, timeZone: 'America/Chicago', currency: 'USD' });
    expect(brandLoc.brandId).toBe(B);

    // A development rep scoped to the second brand: the pipeline (view, edit) and Disclosure (view) from the template.
    const rep = await memberWithRole(app, owner.token, O, 'development_rep', { kind: 'brand', id: B }, 'Brenda Brand');
    const settings = await call(app, 'GET', `/v1/orgs/${O}/franchise/settings`, { token: rep.token });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    expect(settings.body).toMatchObject({ canEdit: true, brandScoped: true, territoryScoped: false, brandIds: [B], disclosure: { view: true, edit: false }, legal: { view: false } });

    // Prospects: theirs are filed under their brand; HQ's main-brand prospects stay invisible.
    const mine = await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects`, { token: rep.token, body: { name: 'Austin Prospect', email: `aus-${uid()}@example.com`, country: 'US', region: 'TX' } });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(mine.body.brandId).toBe(B);
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects`, { token: rep.token, body: { name: 'Wrong brand', email: `x-${uid()}@example.com`, country: 'US', brandId: main } })).status).toBe(403);
    const hq = (await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects`, { token: owner.token, body: { name: 'Boston Prospect', email: `bos-${uid()}@example.com`, country: 'US', region: 'MA' } })).body;
    const list = await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects`, { token: rep.token });
    expect(list.body.items.map((p: any) => p.id)).toEqual([mine.body.id]);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects/${hq.id}`, { token: rep.token })).status).toBe(404);
    expect((await call(app, 'PATCH', `/v1/orgs/${O}/franchise/prospects/${mine.body.id}`, { token: rep.token, body: { brandId: main } })).status).toBe(403);
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${mine.body.id}/activities`, { token: rep.token, body: { kind: 'call', body: 'Discovery call booked' } })).status).toBe(201);
    const tasks = await call(app, 'GET', `/v1/orgs/${O}/franchise/tasks?status=all`, { token: rep.token });
    expect(tasks.status).toBe(200);
    expect(tasks.body.items.every((x: any) => x.prospectId === mine.body.id)).toBe(true);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/team`, { token: rep.token })).body.items.map((u: any) => u.id)).toContain(rep.userId);

    const upload = (token: string, kind: string, jurisdictions: string[], over: Record<string, unknown> = {}) =>
      call(app, 'POST', `/v1/orgs/${O}/franchise/documents`, { token, body: { kind, title: `${kind} ${uid()}`, version: '2026', jurisdictions, fileName: `${uid()}.pdf`, contentType: 'application/pdf', contentBase64: pdf, supersedePrevious: false, ...over } });
    const mainDoc = (await upload(owner.token, 'disclosure', ['US'], { brandId: main })).body.id;
    const sharedDoc = (await upload(owner.token, 'disclosure', ['US'])).body.id;

    // Without Disclosure (edit) they can read their brand's documents but not send disclosure or upload.
    expect((await upload(rep.token, 'disclosure', ['US'])).status).toBe(403);
    const before = await call(app, 'GET', `/v1/orgs/${O}/franchise/documents?kind=disclosure`, { token: rep.token });
    expect(before.status).toBe(200);
    expect(before.body.items.map((d: any) => d.id)).toEqual([sharedDoc]);
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${mine.body.id}/disclosures`, { token: rep.token, body: { documentId: sharedDoc } })).status).toBe(403);

    // HQ grants Disclosure and Franchise agreements (edit) on the brand assignment.
    await grantCaps(app, owner.token, O, rep.userId, ['legal.disclosure:edit', 'legal.agreements:edit']);
    const granted = await call(app, 'GET', `/v1/orgs/${O}/franchise/settings`, { token: rep.token });
    expect(granted.body).toMatchObject({ disclosure: { view: true, edit: true }, legal: { view: true, edit: true } });
    const brandDoc = await upload(rep.token, 'disclosure', ['US']);
    expect(brandDoc.status, JSON.stringify(brandDoc.body)).toBe(201);
    expect((await upload(rep.token, 'disclosure', ['US'], { brandId: main })).status).toBe(403);
    const docs = await call(app, 'GET', `/v1/orgs/${O}/franchise/documents?kind=disclosure`, { token: rep.token });
    expect(docs.body.items.map((d: any) => d.id).sort()).toEqual([brandDoc.body.id, sharedDoc].sort());
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/documents/${mainDoc}/download`, { token: rep.token })).status).toBe(403);
    // Documents shared by every brand are HQ's: readable, not changeable.
    expect((await call(app, 'PATCH', `/v1/orgs/${O}/franchise/documents/${sharedDoc}`, { token: rep.token, body: { status: 'superseded' } })).status).toBe(403);
    expect((await call(app, 'PATCH', `/v1/orgs/${O}/franchise/documents/${brandDoc.body.id}`, { token: rep.token, body: { status: 'current' } })).status).toBe(200);
    const template = await upload(rep.token, 'agreement_template', []);
    expect(template.status, JSON.stringify(template.body)).toBe(201);

    // Disclosure for their prospect with their brand's document; HQ's prospect is out of reach.
    const sent = await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${mine.body.id}/disclosures`, { token: rep.token, body: { documentId: brandDoc.body.id } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${hq.id}/disclosures`, { token: rep.token, body: { documentId: brandDoc.body.id } })).status).toBe(404);

    // Jurisdiction rules and registrations are the business's: readable, edited by HQ.
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/registrations`, { token: rep.token })).status).toBe(200);
    expect((await call(app, 'PUT', `/v1/orgs/${O}/franchise/registrations/US-NY`, { token: rep.token, body: { status: 'registered' } })).status).toBe(403);

    // Agreements: for owner groups of their brand's locations, filed under their brand.
    const og = (await call(app, 'POST', `/v1/orgs/${O}/owner-groups`, { token: owner.token, body: { name: 'Austin Studios LLC' } })).body;
    const other = (await call(app, 'POST', `/v1/orgs/${O}/owner-groups`, { token: owner.token, body: { name: 'Boston Studios LLC' } })).body;
    await call(app, 'PATCH', `/v1/orgs/${O}/locations/${brandLoc.id}`, { token: owner.token, body: { ownerGroupId: og.id } });
    await call(app, 'PATCH', `/v1/orgs/${O}/locations/${mainLoc.id}`, { token: owner.token, body: { ownerGroupId: other.id } });
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/owner-groups`, { token: rep.token })).body.items.map((g: any) => g.id)).toEqual([og.id]);
    const agreement = { startDate: '2026-01-01', endDate: '2036-01-01', jurisdiction: 'US-TX' };
    const ours = await call(app, 'POST', `/v1/orgs/${O}/legal/agreements`, { token: rep.token, body: { ...agreement, ownerGroupId: og.id, locationIds: [brandLoc.id] } });
    expect(ours.status, JSON.stringify(ours.body)).toBe(201);
    expect((await call(app, 'POST', `/v1/orgs/${O}/legal/agreements`, { token: rep.token, body: { ...agreement, ownerGroupId: other.id } })).status).toBe(403);
    const hqAgreement = await call(app, 'POST', `/v1/orgs/${O}/legal/agreements`, { token: owner.token, body: { ...agreement, ownerGroupId: other.id } });
    expect((await call(app, 'PATCH', `/v1/orgs/${O}/legal/agreements/${hqAgreement.body.id}`, { token: rep.token, body: { renewalOption: 'x' } })).status).toBe(404);
    const register = await call(app, 'GET', `/v1/orgs/${O}/legal/agreements`, { token: rep.token });
    expect(register.body.scope).toBe('brand');
    expect(register.body.items.map((a: any) => a.id)).toEqual([ours.body.id]);

    // HQ keeps the whole picture.
    expect((await call(app, 'GET', `/v1/orgs/${O}/legal/agreements`, { token: owner.token })).body.items).toHaveLength(2);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects/${mine.body.id}`, { token: owner.token })).body.stage).toBe('disclosure_sent');
  });

  it('brand-scoped assignments take the franchise modules; other HQ-private modules are still refused there', async () => {
    const owner = await verifiedUser(app, 'Brand Grants Owner');
    const O = (await createOrg(app, owner.token, { name: `Brand grants ${uid()}` })).id;
    const B = (await call(app, 'POST', `/v1/orgs/${O}/brands`, { token: owner.token, body: { name: `Grant Brand ${uid()}` } })).body.id;
    const person = await memberWithRole(app, owner.token, O, 'brand_manager', { kind: 'brand', id: B }, 'Grant Brand Person');
    const ok = await grantCaps(app, owner.token, O, person.userId, ['sales.franchise_pipeline:view', 'legal.agreements:view']);
    expect(ok).toBeTruthy();
    const acc = await call(app, 'GET', `/v1/orgs/${O}/members/${person.userId}/access`, { token: owner.token });
    const a = acc.body.assignments[0];
    const refused = await call(app, 'PUT', `/v1/orgs/${O}/role-assignments/${a.id}/access`, { token: owner.token, body: { role: a.role, customRoleId: a.customRoleId, grants: [...a.grants, 'finance.royalties:view'], revokes: a.revokes } });
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code ?? refused.body.code).toBe('hq_only_module');
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects`, { token: person.token })).status).toBe(200);
  });
});

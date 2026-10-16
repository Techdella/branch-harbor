import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';
import { fromHeader } from '../src/integrations/mailer.ts';
import { brandSiteSettings } from '../src/services/brands.ts';

/**
 * Multi-brand HQ: brands of the same industry under one franchisor, the brand switcher (X-BH-Brand), brand-scoped
 * people, brand-specific franchise terms, per-brand hosted sites and the brand comparison (never sums currencies).
 */
describe.skipIf(!hasDb)('multi-brand HQ (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string };
  let org: Record<string, any>;
  let yogaBrandId: string;
  let barre: Record<string, any>;
  let yogaLoc: Record<string, any>;
  let barreLoc: Record<string, any>;
  let barreLoc2: Record<string, any>;
  const H = (brandId: string) => ({ 'x-bh-brand': brandId });

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Brand Owner');
    org = await createOrg(app, owner.token, { name: `Northwind ${uid()}` });
    yogaLoc = await createLocation(app, owner.token, org.id, { name: `Yoga ${uid()}` });
  });
  afterAll(async () => app?.close());

  it('a single-brand business has one (main) brand and no brand UI', async () => {
    const r = await call(app, 'GET', `/v1/orgs/${org.id}/brands`, { token: owner.token });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.multiBrand).toBe(false);
    expect(r.body.items[0].isDefault).toBe(true);
    expect(r.body.items[0].slug).toBe(org.slug);
    yogaBrandId = r.body.items[0].id;
  });

  it('HQ adds a second brand with its own identity; the address must be free and valid', async () => {
    const bad = await call(app, 'POST', `/v1/orgs/${org.id}/brands`, { token: owner.token, body: { name: 'Barre', slug: org.slug } });
    expect(bad.status).toBe(400);
    const badColour = await call(app, 'POST', `/v1/orgs/${org.id}/brands`, { token: owner.token, body: { name: 'Barre', primaryColor: 'pink' } });
    expect(badColour.status).toBe(400);
    const r = await call(app, 'POST', `/v1/orgs/${org.id}/brands`, {
      token: owner.token,
      body: { name: 'Northwind Barre', slug: `nw-barre-${uid()}`, primaryColor: '#B4436C', headingFont: 'fraunces', themeId: SITE_THEME, locales: ['en', 'fr'], defaultCurrency: 'USD', emailFromName: 'Northwind Barre', emailReplyTo: 'hello@barre.example.com', domain: 'barre.example.com' },
    });
    expect(r.status).toBe(201);
    barre = r.body;
    expect(barre.isDefault).toBe(false);
    const list = await call(app, 'GET', `/v1/orgs/${org.id}/brands`, { token: owner.token });
    expect(list.body.multiBrand).toBe(true);
    expect(list.body.canManage).toBe(true);
  });

  it('each location belongs to one brand', async () => {
    barreLoc = await createLocation(app, owner.token, org.id, { name: `Barre One ${uid()}`, brandId: barre.id, currency: 'USD', address: { line1: '1 Pike St', city: 'Seattle', region: 'WA', postalCode: '98101', country: 'US' }, timeZone: 'America/Los_Angeles' });
    expect(barreLoc.brandId).toBe(barre.id);
    barreLoc2 = await createLocation(app, owner.token, org.id, { name: `Barre Two ${uid()}` });
    const moved = await call(app, 'PUT', `/v1/orgs/${org.id}/locations/${barreLoc2.id}/brand`, { token: owner.token, body: { brandId: barre.id } });
    expect(moved.status).toBe(200);
    const other = await createOrg(app, owner.token);
    const foreign = await call(app, 'POST', `/v1/orgs/${other.id}/locations`, { token: owner.token, body: { name: 'X', code: `X${uid()}`.slice(0, 8), brandId: barre.id, address: { line1: '1', city: 'T', country: 'CA' }, timeZone: 'America/Toronto', currency: 'CAD' } });
    expect(foreign.status).toBe(404);
  });

  it('the brand switcher filters lists: all brands, or one brand', async () => {
    const all = await call(app, 'GET', `/v1/orgs/${org.id}/locations`, { token: owner.token });
    expect(all.body.items.map((l: any) => l.id)).toEqual(expect.arrayContaining([yogaLoc.id, barreLoc.id, barreLoc2.id]));
    const onlyBarre = await call(app, 'GET', `/v1/orgs/${org.id}/locations`, { token: owner.token, headers: H(barre.id) });
    expect(onlyBarre.body.items.map((l: any) => l.id).sort()).toEqual([barreLoc.id, barreLoc2.id].sort());
    const onlyYoga = await call(app, 'GET', `/v1/orgs/${org.id}/locations`, { token: owner.token, headers: H(yogaBrandId) });
    expect(onlyYoga.body.items.map((l: any) => l.id)).toEqual([yogaLoc.id]);
    // An unknown brand shows nothing rather than everything.
    const unknown = await call(app, 'GET', `/v1/orgs/${org.id}/locations`, { token: owner.token, headers: H('00000000-0000-4000-8000-000000000000') });
    expect(unknown.body.items).toEqual([]);
    // The league table and reports follow it too.
    const league = await call(app, 'GET', `/v1/orgs/${org.id}/league-table`, { token: owner.token, headers: H(barre.id) });
    if (league.status === 200) expect((league.body.rows ?? league.body.items ?? []).every((r: any) => [barreLoc.id, barreLoc2.id].includes(r.locationId ?? r.id))).toBe(true);
    const rep = await call(app, 'GET', `/v1/orgs/${org.id}/reports/overview`, { token: owner.token, headers: H(barre.id) });
    expect(rep.status).toBe(200);
    expect(rep.body.scope.locationCount).toBe(2);
  });

  it('the filter only narrows reads: writes are still checked by scope', async () => {
    const r = await call(app, 'PATCH', `/v1/orgs/${org.id}/locations/${yogaLoc.id}`, { token: owner.token, headers: H(barre.id), body: { phone: '+1 555 0100' } });
    expect(r.status).toBe(200);
  });

  it('a brand-scoped person sees only their brand, whatever filter they send', async () => {
    const lead = await memberWithRole(app, owner.token, org.id, 'operations_lead', { kind: 'brand', id: barre.id });
    const brands = await call(app, 'GET', `/v1/orgs/${org.id}/brands`, { token: lead.token });
    expect(brands.body.items.map((b: any) => b.id)).toEqual([barre.id]);
    const locs = await call(app, 'GET', `/v1/orgs/${org.id}/locations`, { token: lead.token });
    expect(locs.body.items.map((l: any) => l.id).sort()).toEqual([barreLoc.id, barreLoc2.id].sort());
    const sneaky = await call(app, 'GET', `/v1/orgs/${org.id}/locations`, { token: lead.token, headers: H(yogaBrandId) });
    expect(sneaky.body.items).toEqual([]);
    const yoga = await call(app, 'GET', `/v1/orgs/${org.id}/locations/${yogaLoc.id}`, { token: lead.token });
    expect(yoga.status).toBe(403);
    // No brand management, no renaming.
    const create = await call(app, 'POST', `/v1/orgs/${org.id}/brands`, { token: lead.token, body: { name: 'Rogue' } });
    expect(create.status).toBe(403);
    const terms = await call(app, 'GET', `/v1/orgs/${org.id}/brands/${yogaBrandId}/franchise-terms`, { token: lead.token });
    expect(terms.status).toBe(404);
  });

  it('a brand manager on one brand edits that brand’s identity only', async () => {
    const bm = await memberWithRole(app, owner.token, org.id, 'brand_manager', { kind: 'brand', id: barre.id });
    const ok = await call(app, 'PATCH', `/v1/orgs/${org.id}/brands/${barre.id}`, { token: bm.token, body: { accentColor: '#222222' } });
    expect(ok.status).toBe(200);
    expect(ok.body.accentColor).toBe('#222222');
    const rename = await call(app, 'PATCH', `/v1/orgs/${org.id}/brands/${barre.id}`, { token: bm.token, body: { name: 'Renamed' } });
    expect(rename.status).toBe(403);
    const otherBrand = await call(app, 'PATCH', `/v1/orgs/${org.id}/brands/${yogaBrandId}`, { token: bm.token, body: { accentColor: '#222222' } });
    expect(otherBrand.status).toBe(403);
  });

  it('franchise terms are attached per brand: pipeline, territories, documents and royalty terms', async () => {
    const p1 = await call(app, 'POST', `/v1/orgs/${org.id}/franchise/prospects`, { token: owner.token, body: { name: 'Barre Buyer', email: `bb-${uid()}@example.com`, country: 'US', region: 'WA', brandId: barre.id } });
    expect(p1.status).toBe(201);
    expect(p1.body.brandId).toBe(barre.id);
    const p2 = await call(app, 'POST', `/v1/orgs/${org.id}/franchise/prospects`, { token: owner.token, body: { name: 'Yoga Buyer', email: `yb-${uid()}@example.com`, country: 'CA', region: 'ON' } });
    expect(p2.status).toBe(201);
    const barreList = await call(app, 'GET', `/v1/orgs/${org.id}/franchise/prospects`, { token: owner.token, headers: H(barre.id) });
    expect(barreList.body.items.map((p: any) => p.id)).toEqual([p1.body.id]);
    const yogaList = await call(app, 'GET', `/v1/orgs/${org.id}/franchise/prospects`, { token: owner.token, headers: H(yogaBrandId) });
    expect(yogaList.body.items.map((p: any) => p.id)).toEqual([p2.body.id]);

    const t = await call(app, 'POST', `/v1/orgs/${org.id}/franchise/territories`, { token: owner.token, body: { name: 'Puget Sound', country: 'US', region: 'WA', brandId: barre.id } });
    expect(t.status).toBe(201);
    const yogaMap = await call(app, 'GET', `/v1/orgs/${org.id}/franchise/territories`, { token: owner.token, headers: H(yogaBrandId) });
    expect(yogaMap.body.items.some((x: any) => x.id === t.body.id)).toBe(false);

    const pdf = Buffer.from('%PDF-1.4 barre disclosure').toString('base64');
    const doc = await call(app, 'POST', `/v1/orgs/${org.id}/franchise/documents`, { token: owner.token, body: { kind: 'disclosure', title: 'Barre FDD', jurisdictions: ['US'], fileName: 'fdd.pdf', contentType: 'application/pdf', contentBase64: pdf, brandId: barre.id } });
    expect(doc.status).toBe(201);
    expect(doc.body.brandId).toBe(barre.id);
    // A barre disclosure is never given to a yoga prospect.
    const wrong = await call(app, 'POST', `/v1/orgs/${org.id}/franchise/prospects/${p2.body.id}/disclosures`, { token: owner.token, body: { documentId: doc.body.id } });
    expect(wrong.status).toBe(400);

    const basis = { streams: ['bookings', 'memberships'], netOfRefunds: true, excludeTax: true, excludeTips: true, includeExternalSales: false };
    const terms = await call(app, 'POST', `/v1/orgs/${org.id}/finance/terms`, { token: owner.token, body: { brandId: barre.id, currency: 'USD', effectiveFrom: '2026-01-01', royaltyBps: 700, marketingFundBps: 250, basis } });
    expect(terms.status, JSON.stringify(terms.body)).toBe(201);
    const net = await call(app, 'POST', `/v1/orgs/${org.id}/finance/terms`, { token: owner.token, body: { currency: 'USD', effectiveFrom: '2026-01-01', royaltyBps: 500, marketingFundBps: 200, basis } });
    expect(net.status).toBe(201);
    const resolved = await call(app, 'GET', `/v1/orgs/${org.id}/finance/terms/resolve?locationId=${barreLoc.id}&date=2026-10-01`, { token: owner.token });
    expect(resolved.status).toBe(200);
    expect(JSON.stringify(resolved.body)).toContain('700');
    const ft = await call(app, 'GET', `/v1/orgs/${org.id}/brands/${barre.id}/franchise-terms`, { token: owner.token });
    expect(ft.status).toBe(200);
    expect(ft.body.disclosureDocuments.map((d: any) => d.id)).toContain(doc.body.id);
    expect(ft.body.royaltyTerms[0].royaltyBps).toBe(700);
  });

  it('the territory map takes a brand: the main brand is stored as none, overlaps only count within a brand', async () => {
    const sq = (x: number, y: number, s: number) => ({ type: 'Polygon', coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] });
    const T = (p = '') => `/v1/orgs/${org.id}/territories${p}`;
    const main = await call(app, 'POST', T(), { token: owner.token, body: { name: `Main ${uid()}`, country: 'US', region: 'OR', geometry: sq(-122.8, 45.4, 0.2), brandId: yogaBrandId } });
    expect(main.status, JSON.stringify(main.body)).toBe(201);
    expect(main.body.brandId).toBeNull();
    // The same area for another brand is no conflict; for the same brand it is.
    const check = await call(app, 'POST', T('/check'), { token: owner.token, body: { geometry: sq(-122.75, 45.45, 0.1), brandId: barre.id } });
    expect(check.status).toBe(200);
    expect(check.body.overlaps).toEqual([]);
    const sameBrand = await call(app, 'POST', T('/check'), { token: owner.token, body: { geometry: sq(-122.75, 45.45, 0.1) } });
    expect(sameBrand.body.overlaps.map((o: any) => o.id)).toContain(main.body.id);
    const b = await call(app, 'POST', T(), { token: owner.token, body: { name: `Barre ${uid()}`, country: 'US', region: 'OR', geometry: sq(-122.75, 45.45, 0.1), brandId: barre.id } });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.brandId).toBe(barre.id);
    // A brand of another business is refused; moving a territory to the main brand clears it.
    const foreign = await call(app, 'POST', T(), { token: owner.token, body: { name: `X ${uid()}`, country: 'US', geometry: sq(-100, 40, 0.1), brandId: '00000000-0000-4000-8000-000000000000' } });
    expect(foreign.status).toBe(404);
    const moved = await call(app, 'PATCH', T(`/${b.body.id}`), { token: owner.token, body: { geometry: sq(-121, 44, 0.1), brandId: yogaBrandId } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.brandId).toBeNull();
  });

  it('the brand comparison and network summary never add currencies together', async () => {
    const r = await call(app, 'GET', `/v1/orgs/${org.id}/brands/comparison`, { token: owner.token });
    expect(r.status).toBe(200);
    expect(r.body.network.combinedRevenue).toBeNull();
    expect(r.body.network.locations).toBe(3);
    const b = r.body.brands.find((x: any) => x.id === barre.id);
    expect(b.locations.total).toBe(2);
    expect(b.currencies).toEqual(['CAD', 'USD']);
    expect(b.pipeline.open).toBe(1);
    expect(b.terms.some((t: any) => t.source === 'brand' && t.royaltyBps === 700)).toBe(true);
    const filtered = await call(app, 'GET', `/v1/orgs/${org.id}/brands/comparison`, { token: owner.token, headers: H(yogaBrandId) });
    expect(filtered.body.brands.map((x: any) => x.id)).toEqual([yogaBrandId]);
    const staff = await memberWithRole(app, owner.token, org.id, 'staff', { kind: 'location', id: yogaLoc.id });
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/brands/comparison`, { token: staff.token })).status).toBe(403);
  });

  it('hosted sites serve /{brand}/{location} for every brand, with the brand’s theme', async () => {
    for (const l of [yogaLoc, barreLoc]) await call(app, 'PATCH', `/v1/orgs/${org.id}/locations/${l.id}`, { token: owner.token, body: { publiclyVisible: true } });
    const site = await call(app, 'GET', `/v1/public/sites/${barre.slug}`);
    expect(site.status).toBe(200);
    expect(site.body.brand.name).toBe('Northwind Barre');
    expect(site.body.brand.slug).toBe(barre.slug);
    expect(site.body.brand.theme.brandColor).toBe('#B4436C');
    expect(site.body.locations.map((l: any) => l.id)).toEqual([barreLoc.id]);
    expect(site.body.locations[0].path).toBe(`/${barre.slug}/${barreLoc.slug}`);
    const loc = await call(app, 'GET', `/v1/public/sites/${barre.slug}/${barreLoc.slug}`);
    expect(loc.status).toBe(200);
    expect(loc.body.site.includedAddress).toContain(`/${barre.slug}/${barreLoc.slug}`);
    // A location is only served under its own brand's address.
    expect((await call(app, 'GET', `/v1/public/sites/${barre.slug}/${yogaLoc.slug}`)).status).toBe(404);
    expect((await call(app, 'GET', `/v1/public/sites/${org.slug}/${barreLoc.slug}`)).status).toBe(404);
    const main = await call(app, 'GET', `/v1/public/sites/${org.slug}`);
    expect(main.body.locations.map((l: any) => l.id)).toEqual([yogaLoc.id]);
    const mode = await call(app, 'GET', `/v1/public/sites/resolve-brand?brand=${barre.slug}`);
    expect(mode.body.brandSlug).toBe(barre.slug);
  });

  it('a brand with locations cannot be archived; the main brand never', async () => {
    expect((await call(app, 'DELETE', `/v1/orgs/${org.id}/brands/${barre.id}`, { token: owner.token })).status).toBe(409);
    expect((await call(app, 'DELETE', `/v1/orgs/${org.id}/brands/${yogaBrandId}`, { token: owner.token })).status).toBe(409);
    const spare = await call(app, 'POST', `/v1/orgs/${org.id}/brands`, { token: owner.token, body: { name: `Spare ${uid()}` } });
    expect((await call(app, 'DELETE', `/v1/orgs/${org.id}/brands/${spare.body.id}`, { token: owner.token })).status).toBe(200);
    const list = await call(app, 'GET', `/v1/orgs/${org.id}/brands`, { token: owner.token });
    expect(list.body.items.some((b: any) => b.id === spare.body.id)).toBe(false);
  });
});

describe('brand identity helpers (pure)', () => {
  it('sends email as the brand, keeping the verified sender address', () => {
    expect(fromHeader('BranchHarbor <mail@branchharbor.com>', 'Northlight Barre')).toBe('"Northlight Barre" <mail@branchharbor.com>');
    expect(fromHeader('mail@branchharbor.com', 'Evil"\r\nBcc: x')).toBe('"EvilBcc: x" <mail@branchharbor.com>');
    expect(fromHeader('mail@branchharbor.com', null)).toBe('mail@branchharbor.com');
  });

  it('a brand’s identity overrides the business site settings; the main brand keeps them when unset', () => {
    const orgSite = { themeId: 'classic', primaryColor: '#141414', logoUrl: 'https://x.example/a.png', enabledLocales: ['en'] };
    const base = { id: 'b', organizationId: 'o', name: 'B', isDefault: false, slug: 'b', logoUrl: null, primaryColor: '#B4436C', accentColor: null, headingFont: 'fraunces', bodyFont: null, themeId: 'sage', tagline: null, domain: null, locales: ['fr'], defaultCurrency: null, emailFromName: null, emailReplyTo: null, onboardingTemplateKey: null, settings: {}, createdAt: new Date(), updatedAt: new Date(), archivedAt: null };
    const merged = brandSiteSettings(orgSite, base);
    expect(merged).toMatchObject({ themeId: 'sage', primaryColor: '#B4436C', headingFont: 'fraunces', logoUrl: 'https://x.example/a.png', enabledLocales: ['fr'] });
    const main = brandSiteSettings(orgSite, { ...base, isDefault: true, primaryColor: null, headingFont: null, themeId: null, locales: [] });
    expect(main).toMatchObject({ themeId: 'classic', primaryColor: '#141414', enabledLocales: ['en'] });
  });
});

const SITE_THEME = 'sage';

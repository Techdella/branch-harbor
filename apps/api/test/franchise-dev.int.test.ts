import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { financeInvoices, franchiseAgreements, franchiseSurveyResponses, royaltyPeriods, royaltyStatements } from '../src/db/schema/index.ts';
import { runLifecycleJobs } from '../src/routes/lifecycle.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

const sq = (x: number, y: number, s: number) => ({ type: 'Polygon', coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] });

/**
 * Franchise development: the territory map (exclusivity, overlaps, status from the pipeline, demographics with the
 * Census adapter mocked, exports, public map), surveys (anonymity threshold, scoped results), validation calls
 * (rotation, public scheduling link), the agreement lifecycle (transfer, notices with counsel gate, amendment,
 * renewal window, development schedule) and master franchise (own pipeline, split statements and payout).
 */
describe.skipIf(!hasDb)('franchise development (DB)', () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof verifiedUser>>;
  let vp: Awaited<ReturnType<typeof verifiedUser>>;
  let fo1: Awaited<ReturnType<typeof verifiedUser>>;
  let fo2: Awaited<ReturnType<typeof verifiedUser>>;
  let fo3: Awaited<ReturnType<typeof verifiedUser>>;
  let staff: Awaited<ReturnType<typeof verifiedUser>>;
  let master: Awaited<ReturnType<typeof verifiedUser>>;
  let orgId: string;
  let g1: string;
  let g2: string;
  let g3: string;
  let aus: string;
  let lon: string;
  const census: string[] = [];
  const O = (p: string) => `/v1/orgs/${orgId}${p}`;

  beforeAll(async () => {
    app = await makeApp({
      partnerFetch: async (url: string) => {
        census.push(url);
        return { ok: true, status: 200, text: async () => JSON.stringify([['B01003_001E', 'B11001_001E', 'B19013_001E', 'zip code tabulation area'], ['30000', '12000', '80000', '78701'], ['10000', '5000', '-666666666', '78702']]) };
      },
    }, { CENSUS_API_KEY: 'test-census-key' });
    owner = await verifiedUser(app, 'Franchisor CEO');
    orgId = (await createOrg(app, owner.token, { name: `Harbor ${uid()}`, country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/Chicago' })).id;
    g1 = (await call(app, 'POST', O('/owner-groups'), { token: owner.token, body: { name: 'Lone Star Studios' } })).body.id;
    g2 = (await call(app, 'POST', O('/owner-groups'), { token: owner.token, body: { name: 'Thames Master Ltd' } })).body.id;
    g3 = (await call(app, 'POST', O('/owner-groups'), { token: owner.token, body: { name: 'Hill Country Yoga' } })).body.id;
    aus = (await createLocation(app, owner.token, orgId, { name: 'Austin Downtown', ownerGroupId: g1, timeZone: 'America/Chicago', currency: 'USD', address: { line1: '1 Congress Ave', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' } })).id;
    await createLocation(app, owner.token, orgId, { name: 'San Antonio', ownerGroupId: g3, timeZone: 'America/Chicago', currency: 'USD', address: { line1: '1 Alamo', city: 'San Antonio', region: 'TX', postalCode: '78205', country: 'US' } });
    lon = (await createLocation(app, owner.token, orgId, { name: 'London Hackney', ownerGroupId: g2, timeZone: 'Europe/London', currency: 'GBP', address: { line1: '1 Mare St', city: 'London', postalCode: 'E8 3RD', country: 'GB' } })).id;
    vp = await memberWithRole(app, owner.token, orgId, 'vp_franchise', { kind: 'organization', id: orgId }, 'VP Franchise');
    fo1 = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: g1 }, 'Owner Lone Star');
    fo2 = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: g2 }, 'Owner Thames');
    fo3 = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: g3 }, 'Owner Hill Country');
    staff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: aus }, 'Staff Austin');
    // A master franchisee for the UK and Ireland: a custom role on their owner group.
    const role = await call(app, 'POST', O('/roles'), { token: owner.token, body: { name: 'Master franchisee', capabilities: ['sales.master_franchise:view', 'sales.master_franchise:edit', 'sales.master_franchise:publish', 'finance.royalty_splits:view'] } });
    expect(role.status).toBe(201);
    master = await verifiedUser(app, 'Master Thames');
    const inv = await call(app, 'POST', O('/invitations'), { token: owner.token, body: { email: master.email, role: 'custom', customRoleId: role.body.id, scope: { kind: 'owner_group', id: g2 } } });
    expect((await call(app, 'POST', '/v1/invitations/accept', { token: master.token, body: { token: inv.body.devInvitationToken } })).status).toBe(200);
  });
  afterAll(async () => { await app?.close(); });

  /* ------------------------------ territories ----------------------------- */

  let tA: string;
  let tZip: string;

  it('keeps the territory map away from franchise owners and staff', async () => {
    expect((await call(app, 'GET', O('/territories'), { token: fo1.token })).body.error.code).toBe('module_not_available');
    expect((await call(app, 'GET', O('/territories'), { token: staff.token })).status).toBe(403);
    expect((await call(app, 'GET', O('/lifecycle/overview'), { token: fo1.token })).status).toBe(403);
  });

  it('draws territories, detects overlaps and enforces exclusivity once a territory is taken', async () => {
    const a = await call(app, 'POST', O('/territories'), { token: vp.token, body: { name: 'Austin North', country: 'US', region: 'TX', geometry: sq(-97.8, 30.3, 0.2) } });
    expect(a.status).toBe(201);
    tA = a.body.id;
    expect(a.body.areaKm2).toBeGreaterThan(300);
    expect(a.body.centroid.lat).toBeCloseTo(30.4, 3);
    // Overlapping an available territory is allowed (and reported).
    const b = await call(app, 'POST', O('/territories'), { token: vp.token, body: { name: 'Austin Central', country: 'US', region: 'TX', geometry: sq(-97.7, 30.2, 0.2), exclusivity: 'protected' } });
    expect(b.status).toBe(201);
    expect(b.body.overlaps.map((o: any) => [o.name, o.conflict])).toEqual([['Austin North', false]]);
    expect((await call(app, 'PATCH', O(`/territories/${tA}`), { token: vp.token, body: { status: 'sold' } })).status).toBe(409);
    await call(app, 'DELETE', O(`/territories/${b.body.id}`), { token: vp.token });
    expect((await call(app, 'PATCH', O(`/territories/${tA}`), { token: vp.token, body: { status: 'sold' } })).status).toBe(200);
    const clash = await call(app, 'POST', O('/territories'), { token: vp.token, body: { name: 'Round Rock', country: 'US', geometry: sq(-97.75, 30.45, 0.2) } });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('territory_overlap');
    // Non-exclusive territories may overlap.
    expect((await call(app, 'POST', O('/territories'), { token: vp.token, body: { name: 'Round Rock delivery', country: 'US', exclusivity: 'non_exclusive', geometry: sq(-97.75, 30.45, 0.2) } })).status).toBe(201);
    const check = await call(app, 'POST', O('/territories/check'), { token: vp.token, body: { geometry: sq(-97.79, 30.31, 0.05) } });
    expect(check.body.overlaps.find((o: any) => o.id === tA).conflict).toBe(true);
  });

  it('builds territories from postcodes, fetches US Census demographics and scores them', async () => {
    const z = await call(app, 'POST', O('/territories'), { token: vp.token, body: { name: 'Downtown Austin ZIPs', country: 'US', region: 'TX', exclusivity: 'protected', postcodesText: '78701, 78702\n78701' } });
    expect(z.status).toBe(201);
    tZip = z.body.id;
    expect(z.body.postcodes).toEqual(['78701', '78702']);
    const d = await call(app, 'POST', O(`/territories/${tZip}/demographics`), { token: vp.token });
    expect(d.status).toBe(200);
    expect(census[0]).toContain('acs/acs5?get=B01003_001E,B11001_001E,B19013_001E&for=zip%20code%20tabulation%20area:78701,78702&key=test-census-key');
    expect(d.body.demographics).toMatchObject({ population: 40000, households: 17000, medianHouseholdIncomeMinor: 8_000_000, source: 'us_census_acs5', sandbox: false, areas: 2 });
    expect(d.body.score).toBeGreaterThan(0);
    // The Austin location (ZIP 78701) is inside: its performance is a scoring input when it has sales.
    expect(d.body.performance.nearbyLocations).toBe(1);
    // Overlapping postcode territory (protected + protected) with a taken one is refused.
    await call(app, 'PATCH', O(`/territories/${tZip}`), { token: vp.token, body: { status: 'reserved' } });
    const dup = await call(app, 'POST', O('/territories'), { token: vp.token, body: { name: 'East Austin', country: 'US', exclusivity: 'protected', postcodes: ['78702'] } });
    expect(dup.status).toBe(409);
    // Outside the US (no provider yet): sandbox figures, flagged.
    const uk = await call(app, 'POST', O('/territories'), { token: vp.token, body: { name: 'Hackney', country: 'GB', postcodes: ['E8 3RD', 'E8 1AA'] } });
    const ukd = await call(app, 'POST', O(`/territories/${uk.body.id}/demographics`), { token: vp.token });
    expect(ukd.body.demographics.sandbox).toBe(true);
    expect(ukd.body.demographics.currency).toBe('GBP');
  });

  it('follows the pipeline: a prospect reserves, an agreement sells', async () => {
    const p = await call(app, 'POST', O('/franchise/prospects'), { token: vp.token, body: { name: 'Riley Park', email: `riley-${uid()}@example.com`, country: 'US', region: 'TX', territoryId: tZip, source: 'referral' } });
    expect(p.status).toBe(201);
    const list = await call(app, 'GET', O('/territories'), { token: vp.token });
    const z = list.body.items.find((t: any) => t.id === tZip);
    expect(z.links.prospects.map((x: any) => x.name)).toEqual(['Riley Park']);
    expect(z.derivedStatus).toBe('reserved');
    expect((await call(app, 'POST', O('/legal/agreements'), { token: owner.token, body: { ownerGroupId: g1, territoryId: tZip, startDate: '2020-01-01', endDate: '2030-01-01', locationIds: [aus] } })).status).toBe(201);
    const sync = await call(app, 'POST', O('/territories/sync-status'), { token: vp.token, body: {} });
    // The agreement's location is operating, so the territory is open.
    expect(sync.body.changed.find((c: any) => c.id === tZip)).toMatchObject({ from: 'reserved', to: 'open' });
  });

  it('exports Item 12 descriptions and GeoJSON, and imports GeoJSON', async () => {
    const geo = await call(app, 'GET', O('/territories/export.geojson'), { token: vp.token });
    expect(geo.status).toBe(200);
    const fc = JSON.parse(geo.raw.body);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features.find((f: any) => f.properties.name === 'Austin North').geometry.type).toBe('Polygon');
    const csv = await call(app, 'GET', O('/territories/item12.csv'), { token: vp.token });
    expect(csv.raw.body).toContain('Exclusive territory: we will not operate');
    const pdf = await call(app, 'GET', O(`/territories/${tA}/item12.pdf`), { token: vp.token });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.raw.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const imp = await call(app, 'POST', O('/territories/import'), { token: vp.token, body: { country: 'US', data: { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: sq(-96.9, 32.7, 0.2), properties: { name: 'Dallas Uptown', region: 'TX' } },
      { type: 'Feature', geometry: sq(-97.79, 30.31, 0.05), properties: { name: 'Inside Austin North' } },
      { type: 'Feature', geometry: null, properties: { name: 'Nothing' } },
    ] } } });
    expect(imp.body).toMatchObject({ created: 1, updated: 0 });
    expect(imp.body.skipped.map((x: any) => x.reason)).toEqual(['territory_overlap', 'no_area']);
  });

  it('publishes the available territories map only when HQ opts in', async () => {
    const slug = (await call(app, 'GET', O('/territories'), { token: vp.token })).body.brandSlug;
    expect((await call(app, 'GET', `/v1/public/franchise/${slug}/territories-map`)).body.enabled).toBe(false);
    expect((await call(app, 'PUT', O('/territories/settings'), { token: vp.token, body: { publicMap: true, showTaken: false } })).status).toBe(200);
    const pub = await call(app, 'GET', `/v1/public/franchise/${slug}/territories-map`);
    expect(pub.body.enabled).toBe(true);
    expect(pub.body.map.kind).toBe('outline');
    const names = pub.body.territories.features.map((f: any) => f.properties.name);
    expect(names).toContain('Dallas Uptown');
    expect(names).not.toContain('Austin North');
    expect(JSON.stringify(pub.body)).not.toContain('demographics');
  });

  /* -------------------------------- surveys ------------------------------- */

  let surveyId: string;

  it('runs an anonymous survey: results only above the threshold, small slices hidden', async () => {
    const list = await call(app, 'GET', O('/surveys'), { token: owner.token });
    const sv = await call(app, 'POST', O('/surveys'), { token: owner.token, body: { ...list.body.starter, minResponses: 3, recurrence: 'quarterly' } });
    expect(sv.status).toBe(201);
    surveyId = sv.body.id;
    expect((await call(app, 'POST', O('/surveys'), { token: fo1.token, body: list.body.starter })).status).toBe(403);
    const launched = await call(app, 'POST', O(`/surveys/${surveyId}/launch`), { token: owner.token });
    expect(launched.status).toBe(200);
    expect(launched.body.rounds[0].invited).toBe(3); // the three franchise owners (the master's custom role has no Community access)
    expect((await call(app, 'GET', O(`/surveys/${surveyId}/respond`), { token: staff.token })).status).toBe(404);
    const answers = (enps: number) => ({ enps, support: 4, marketing: 3, training: 5, value: 2, invest_again: 'Yes', improve: enps > 8 ? 'More local marketing help' : '' });
    expect((await call(app, 'POST', O(`/surveys/${surveyId}/respond`), { token: fo1.token, body: { answers: { ...answers(10), enps: 11 } } })).body.error.fields.enps).toBe('Answer 0 to 10');
    expect((await call(app, 'POST', O(`/surveys/${surveyId}/respond`), { token: fo1.token, body: { answers: answers(10) } })).status).toBe(201);
    expect((await call(app, 'POST', O(`/surveys/${surveyId}/respond`), { token: fo1.token, body: { answers: answers(10) } })).body.error.code).toBe('already_answered');
    expect((await call(app, 'POST', O(`/surveys/${surveyId}/respond`), { token: fo2.token, body: { answers: answers(9) } })).status).toBe(201);
    const roundId = launched.body.openRoundId;
    let r = await call(app, 'GET', O(`/surveys/${surveyId}/results?roundId=${roundId}`), { token: owner.token });
    expect(r.body.round).toMatchObject({ responses: 2, visible: false, nps: null, comments: [] });
    expect((await call(app, 'POST', O(`/surveys/${surveyId}/respond`), { token: fo3.token, body: { answers: answers(5) } })).status).toBe(201);
    r = await call(app, 'GET', O(`/surveys/${surveyId}/results?roundId=${roundId}`), { token: owner.token });
    expect(r.body.round.visible).toBe(true);
    expect(r.body.round.nps).toMatchObject({ n: 3, promoters: 2, detractors: 1, score: 33 });
    expect(r.body.round.byOwnerGroup.every((g: any) => g.visible === false && g.nps === null)).toBe(true);
    expect(r.body.round.comments.map((c: any) => c.text).sort()).toEqual(['More local marketing help', 'More local marketing help']);
    expect(r.body.round.comments[0].userId).toBeUndefined();
    const stored = await app.ctx.db.select().from(franchiseSurveyResponses).where(eq(franchiseSurveyResponses.roundId, roundId));
    expect(stored.every((x) => x.userId === null)).toBe(true);
    expect(r.body.trend[0].nps).toBe(33);
    // Franchise owners answer but never see results.
    expect((await call(app, 'GET', O(`/surveys/${surveyId}/results`), { token: fo1.token })).status).toBe(403);
    expect((await call(app, 'POST', O(`/surveys/${surveyId}/actions`), { token: owner.token, body: { theme: 'value', title: 'Publish the fund report quarterly', dueOn: '2026-12-31', shared: true } })).status).toBe(201);
  });

  /* --------------------------- validation calls --------------------------- */

  it('rotates validators, sends the candidate a scheduling link and records outcomes', async () => {
    expect((await call(app, 'PUT', O('/validation/me'), { token: fo1.token, body: { active: true, bio: 'Opened in 2020.', schedulingUrl: 'https://cal.example.com/lonestar', maxCallsPerMonth: 2 } })).status).toBe(200);
    expect((await call(app, 'PUT', O('/validation/me'), { token: fo3.token, body: { active: true, maxCallsPerMonth: 2 } })).status).toBe(200);
    expect((await call(app, 'PUT', O('/validation/me'), { token: vp.token, body: { active: true } })).status).toBe(403);
    const p = await call(app, 'POST', O('/franchise/prospects'), { token: vp.token, body: { name: 'Casey Lin', email: `casey-${uid()}@example.com`, country: 'US', region: 'TX', city: 'Houston', liquidCapitalMinor: 50_000_000, source: 'referral' } });
    await call(app, 'POST', O(`/franchise/prospects/${p.body.id}/stage`), { token: vp.token, body: { stage: 'discovery_call' } });
    const a = await call(app, 'POST', O(`/validation/prospects/${p.body.id}/assign`), { token: vp.token, body: { count: 2 } });
    expect(a.status).toBe(201);
    expect(a.body.calls).toHaveLength(2);
    expect(a.body.link).toContain('/franchise/validation?token=');
    const again = await call(app, 'POST', O(`/validation/prospects/${p.body.id}/assign`), { token: vp.token, body: { count: 2 } });
    expect(again.body.error.code).toBe('no_validators');
    const pub = await call(app, 'GET', `/v1/public/franchise/validation/${a.body.devToken}`);
    expect(pub.body.calls).toHaveLength(2);
    expect(pub.body.calls.find((c: any) => c.validator.schedulingUrl).validator.firstName).toBe('Owner');
    expect(JSON.stringify(pub.body)).not.toContain('liquid');
    expect((await call(app, 'POST', `/v1/public/franchise/validation/${a.body.devToken}/calls/${pub.body.calls[0].id}`, { body: { proposedTimes: 'Tue or Wed after 5pm' } })).status).toBe(200);
    const me = await call(app, 'GET', O('/validation/me'), { token: fo1.token });
    expect(me.body.calls).toHaveLength(1);
    expect(JSON.stringify(me.body)).not.toContain('500000');
    const callId = me.body.calls[0].id;
    expect((await call(app, 'PATCH', O(`/validation/calls/${callId}`), { token: fo1.token, body: { status: 'completed' } })).body.error.fields.sentiment).toBe('Required');
    expect((await call(app, 'PATCH', O(`/validation/calls/${callId}`), { token: fo1.token, body: { status: 'completed', sentiment: 'positive', outcome: 'Asked about ramp-up' } })).status).toBe(200);
    const fo3Call = (await call(app, 'GET', O('/validation/me'), { token: fo3.token })).body.calls[0].id;
    expect((await call(app, 'PATCH', O(`/validation/calls/${fo3Call}`), { token: fo1.token, body: { status: 'cancelled' } })).status).toBe(404);
    const all = await call(app, 'GET', O('/validation/calls'), { token: vp.token });
    expect(all.body.items.find((c: any) => c.id === callId)).toMatchObject({ status: 'completed', sentiment: 'positive' });
  });

  /* --------------------------- agreement lifecycle ------------------------- */

  let agreementId: string;

  it('transfers an agreement to a new owner after the steps and HQ approval', async () => {
    const ag = await call(app, 'POST', O('/legal/agreements'), { token: owner.token, body: { ownerGroupId: g3, startDate: '2017-03-01', endDate: '2027-03-01', locationIds: [], royaltyBps: 600 } });
    agreementId = ag.body.id;
    const t = await call(app, 'POST', O('/lifecycle/transfers'), { token: owner.token, body: { agreementId, buyerName: 'Bluebonnet Holdings LLC', transferFeeMinor: 1_000_000 } });
    expect(t.status).toBe(201);
    expect((await call(app, 'POST', O('/lifecycle/transfers'), { token: owner.token, body: { agreementId, buyerName: 'Second' } })).body.error.code).toBe('transfer_in_progress');
    expect((await call(app, 'POST', O(`/lifecycle/transfers/${t.body.id}/decide`), { token: owner.token, body: { decision: 'approve' } })).body.error.code).toBe('transfer_steps_missing');
    for (const k of ['buyer_application', 'buyer_qualified', 'buyer_disclosure', 'financial_review']) await call(app, 'POST', O(`/lifecycle/transfers/${t.body.id}/steps/${k}`), { token: owner.token, body: { done: true } });
    expect((await call(app, 'POST', O(`/lifecycle/transfers/${t.body.id}/decide`), { token: vp.token, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(app, 'POST', O(`/lifecycle/transfers/${t.body.id}/decide`), { token: owner.token, body: { decision: 'approve' } })).body.status).toBe('approved');
    expect((await call(app, 'POST', O(`/lifecycle/transfers/${t.body.id}/complete`), { token: owner.token })).body.error.code).toBe('transfer_steps_missing');
    for (const k of ['buyer_training', 'release_signed', 'transfer_fee_paid', 'new_agreement_signed']) await call(app, 'POST', O(`/lifecycle/transfers/${t.body.id}/steps/${k}`), { token: owner.token, body: { done: true } });
    const done = await call(app, 'POST', O(`/lifecycle/transfers/${t.body.id}/complete`), { token: owner.token });
    expect(done.body.status).toBe('completed');
    expect(done.body.toOwnerGroupName).toBe('Bluebonnet Holdings LLC');
    const [a] = await app.ctx.db.select().from(franchiseAgreements).where(eq(franchiseAgreements.id, agreementId));
    expect(a!.ownerGroupId).toBe(done.body.toOwnerGroupId);
  });

  it('issues notices of default only after counsel review, runs the cure period and escalates', async () => {
    const ag = await call(app, 'POST', O('/legal/agreements'), { token: owner.token, body: { ownerGroupId: g1, startDate: '2019-06-01', endDate: '2027-06-30', locationIds: [aus], royaltyBps: 600, jurisdiction: 'US-TX' } });
    const n = await call(app, 'POST', O('/lifecycle/notices'), { token: owner.token, body: { agreementId: ag.body.id, reason: 'insurance', details: 'General liability certificate expired on 1 October' } });
    expect(n.status).toBe(201);
    expect(n.body.cureDays).toBe(10);
    expect(n.body.body).toContain('Lone Star Studios');
    expect(n.body.body).toContain('General liability certificate expired');
    expect((await call(app, 'POST', O(`/lifecycle/notices/${n.body.id}/issue`), { token: owner.token })).body.error.code).toBe('counsel_review_required');
    await call(app, 'POST', O(`/lifecycle/notices/${n.body.id}/counsel-review`), { token: owner.token, body: { reviewed: true, note: 'OK by Smith LLP' } });
    const issued = await call(app, 'POST', O(`/lifecycle/notices/${n.body.id}/issue`), { token: owner.token, body: { deliveredTo: 'owner@lonestar.example' } });
    expect(issued.body.status).toBe('issued');
    expect(issued.body.daysLeft).toBe(10);
    expect((await call(app, 'POST', O(`/lifecycle/notices/${n.body.id}/resolve`), { token: owner.token, body: { outcome: 'terminate' } })).body.error.code).toBe('cure_period_running');
    // The franchise owner sees the issued notice on their side.
    const mine = await call(app, 'GET', O('/lifecycle/mine'), { token: fo1.token });
    expect(mine.body.notices.map((x: any) => x.id)).toContain(n.body.id);
    expect((await call(app, 'GET', O('/lifecycle/mine'), { token: fo3.token })).body.notices).toHaveLength(0);
    // After the cure deadline the hourly job flags it to HQ once.
    expect((await runLifecycleJobs(app.ctx, new Date(Date.now() + 12 * 86_400_000), orgId)).flagged).toBe(1);
    expect((await runLifecycleJobs(app.ctx, new Date(Date.now() + 13 * 86_400_000), orgId)).flagged).toBe(0);
    const esc = await call(app, 'POST', O(`/lifecycle/notices/${n.body.id}/resolve`), { token: owner.token, body: { outcome: 'escalate', extendDays: 5 } });
    expect(esc.body).toMatchObject({ kind: 'cure_reminder', status: 'draft', parentId: n.body.id });
    const detail = await call(app, 'GET', O(`/lifecycle/notices/${n.body.id}`), { token: owner.token });
    expect(detail.body.status).toBe('escalated');
    expect(detail.body.history).toHaveLength(2);
    const pdf = await call(app, 'GET', O(`/lifecycle/notices/${esc.body.id}/pdf`), { token: owner.token });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    // Renewal: the agreement ends within two years, so its option window is tracked; notice outside it is refused.
    const ren = await call(app, 'GET', O('/lifecycle/renewals'), { token: owner.token });
    const r = ren.body.items.find((x: any) => x.agreementId === ag.body.id);
    expect(r).toMatchObject({ windowOpensOn: '2026-06-30', windowClosesOn: '2026-12-30' });
    expect((await call(app, 'POST', O(`/lifecycle/renewals/${ag.body.id}/notice`), { token: owner.token, body: { receivedOn: '2026-01-15' } })).body.error.code).toBe('outside_option_window');
    expect((await call(app, 'POST', O(`/lifecycle/renewals/${ag.body.id}/notice`), { token: owner.token, body: { receivedOn: '2026-09-01' } })).status).toBe(200);
    expect((await call(app, 'POST', O(`/lifecycle/renewals/${ag.body.id}/decide`), { token: owner.token, body: { decision: 'approve' } })).body.error.code).toBe('open_default');
    // Amendment: signing applies the new royalty rate to the register.
    const am = await call(app, 'POST', O('/lifecycle/amendments'), { token: owner.token, body: { agreementId: ag.body.id, title: 'Royalty relief 2026', changes: { royaltyBps: 450 }, effectiveDate: '2026-11-01' } });
    expect((await call(app, 'POST', O(`/lifecycle/amendments/${am.body.id}/sign`), { token: owner.token, body: { counselReviewed: true } })).body.previous).toEqual({ royaltyBps: 600 });
    const [a] = await app.ctx.db.select().from(franchiseAgreements).where(eq(franchiseAgreements.id, ag.body.id));
    expect(a!.royaltyBps).toBe(450);
  });

  it('tracks a multi-unit development schedule for an area developer', async () => {
    const d = await call(app, 'POST', O('/lifecycle/development'), { token: owner.token, body: { ownerGroupId: g1, name: 'Austin metro ADA', unitsTotal: 3, startDate: '2025-01-01', territoryIds: [tA], intervalMonths: 9 } });
    expect(d.status).toBe(201);
    expect(d.body.items.map((i: any) => [i.signByDate, i.openByDate])).toEqual([['2025-04-01', '2025-10-01'], ['2026-01-01', '2026-07-01'], ['2026-10-01', '2027-04-01']]);
    expect(d.body.progress.behind).toBe(true);
    let u = await call(app, 'PATCH', O(`/lifecycle/development/${d.body.id}/items/${d.body.items[0].id}`), { token: owner.token, body: { status: 'opened', locationId: aus } });
    u = await call(app, 'PATCH', O(`/lifecycle/development/${d.body.id}/items/${d.body.items[1].id}`), { token: owner.token, body: { status: 'opened' } });
    expect(u.body.progress).toMatchObject({ opened: 2, dueToOpen: 2 });
    expect(u.body.items[0].locationName).toBe('Austin Downtown');
    expect((await call(app, 'PATCH', O(`/lifecycle/development/${d.body.id}/items/${d.body.items[2].id}`), { token: vp.token, body: { status: 'waived' } })).status).toBe(403);
    const mine = await call(app, 'GET', O('/lifecycle/mine'), { token: fo1.token });
    expect(mine.body.development[0].name).toBe('Austin metro ADA');
  });

  /* ---------------------------- master franchise --------------------------- */

  let masterId: string;

  it('lets a master franchisee run the pipeline for their own countries only', async () => {
    const m = await call(app, 'POST', O('/master/agreements'), { token: owner.token, body: { ownerGroupId: g2, name: 'UK & Ireland master', countries: ['GB', 'IE'], homeCountry: 'GB', startDate: '2024-01-01', splits: [{ currency: null, royaltyShareBps: 4000, fundShareBps: 2500 }, { currency: 'EUR', royaltyShareBps: 5000, fundShareBps: 0 }], payoutMethod: 'stripe_transfer', stripeAccountId: 'acct_sandbox_thames' } });
    expect(m.status).toBe(201);
    masterId = m.body.id;
    expect((await call(app, 'POST', O('/master/agreements'), { token: owner.token, body: { ownerGroupId: g1, name: 'Clash', countries: ['IE'], homeCountry: 'IE', startDate: '2024-01-01' } })).body.error.code).toBe('master_overlap');
    const list = await call(app, 'GET', O('/master/agreements'), { token: master.token });
    expect(list.body.view).toBe('master');
    expect(list.body.items.map((x: any) => x.id)).toEqual([masterId]);
    expect(list.body.items[0].units).toBe(1);
    expect((await call(app, 'GET', O('/master/agreements'), { token: fo1.token })).status).toBe(403);
    expect((await call(app, 'POST', O(`/master/agreements/${masterId}/prospects`), { token: master.token, body: { name: 'Texan', email: 'tex@example.com', country: 'US' } })).status).toBe(400);
    const p = await call(app, 'POST', O(`/master/agreements/${masterId}/prospects`), { token: master.token, body: { name: 'Aoife Byrne', email: `aoife-${uid()}@example.com`, country: 'IE', city: 'Cork', source: 'website' } });
    expect(p.status).toBe(201);
    const pipe = await call(app, 'GET', O(`/master/agreements/${masterId}/pipeline`), { token: master.token });
    expect(pipe.body.prospects.map((x: any) => x.name)).toEqual(['Aoife Byrne']);
    expect(pipe.body.can).toEqual({ edit: true, disclose: true });
    // The master is the franchisor in their country for the jurisdiction rules.
    const rules = await call(app, 'GET', O(`/master/agreements/${masterId}/rules?country=IE`), { token: master.token });
    expect(rules.status).toBe(200);
    expect(rules.body.disclaimer).toBeTruthy();
    // HQ's pipeline still sees it; the master can't reach HQ's general pipeline.
    expect((await call(app, 'GET', O('/franchise/prospects'), { token: master.token })).status).toBe(403);
  });

  it('splits royalties per currency, pays the master by Stripe transfer (sandbox) and shows them their statement', async () => {
    const db = app.ctx.db;
    const [per] = await db.insert(royaltyPeriods).values({ organizationId: orgId, frequency: 'monthly', startDate: '2026-09-01', endDate: '2026-10-01', status: 'closed' }).returning();
    const stmt = async (locationId: string, currency: string, royalty: number, fund: number, paid: boolean) => {
      const [st] = await db.insert(royaltyStatements).values({ organizationId: orgId, periodId: per!.id, locationId, currency, timeZone: 'UTC', periodStartAt: new Date('2026-09-01'), periodEndAt: new Date('2026-10-01'), status: 'invoiced', royaltyMinor: royalty, marketingFundMinor: fund, totalMinor: royalty + fund } as any).returning();
      const [inv] = await db.insert(financeInvoices).values({ organizationId: orgId, statementId: st!.id, locationId, number: `T-${uid()}`, seq: 1, currency, issueDate: '2026-10-01', dueDate: '2026-10-15', subtotalMinor: royalty + fund, totalMinor: royalty + fund, paidMinor: paid ? royalty + fund : 0, status: paid ? 'paid' : 'open' }).returning();
      await db.update(royaltyStatements).set({ invoiceId: inv!.id }).where(eq(royaltyStatements.id, st!.id));
    };
    const dub = (await createLocation(app, owner.token, orgId, { name: 'Dublin Portobello', ownerGroupId: g2, timeZone: 'Europe/Dublin', currency: 'EUR', address: { line1: '14 S Richmond St', city: 'Dublin', country: 'IE' } })).id;
    await stmt(lon, 'GBP', 300_001, 100_000, true);
    await stmt(dub, 'EUR', 200_000, 50_000, false);
    await stmt(aus, 'USD', 999_999, 99_999, true); // not in the master's countries
    expect((await call(app, 'POST', O('/master/statements/generate'), { token: master.token, body: { periodId: per!.id } })).status).toBe(403);
    const gen = await call(app, 'POST', O('/master/statements/generate'), { token: owner.token, body: { periodId: per!.id } });
    expect(gen.status).toBe(200);
    const gbp = gen.body.items.find((x: any) => x.currency === 'GBP');
    const eur = gen.body.items.find((x: any) => x.currency === 'EUR');
    expect(gen.body.items).toHaveLength(2);
    expect(gbp).toMatchObject({ royaltyMinor: 300_001, masterRoyaltyMinor: 120_000, hqRoyaltyMinor: 180_001, masterFundMinor: 25_000, hqFundMinor: 75_000, payableMinor: 145_000, status: 'draft' });
    expect(eur).toMatchObject({ royaltyShareBps: 5000, masterRoyaltyMinor: 100_000, masterFundMinor: 0, payableMinor: 0 });
    expect((await call(app, 'POST', O(`/master/statements/${gbp.id}/pay`), { token: owner.token })).body.error.code).toBe('statement_not_approved');
    await call(app, 'POST', O(`/master/statements/${gbp.id}/approve`), { token: owner.token });
    const paid = await call(app, 'POST', O(`/master/statements/${gbp.id}/pay`), { token: owner.token });
    expect(paid.body).toMatchObject({ status: 'paid', payoutMethod: 'stripe_transfer', sandbox: true });
    expect(paid.body.transferId).toMatch(/^tr_sandbox_/);
    await call(app, 'POST', O(`/master/statements/${eur.id}/approve`), { token: owner.token });
    expect((await call(app, 'POST', O(`/master/statements/${eur.id}/pay`), { token: owner.token })).body.error.code).toBe('nothing_collected');
    // Regenerating keeps approved / paid statements as they are.
    expect((await call(app, 'POST', O('/master/statements/generate'), { token: owner.token, body: { periodId: per!.id } })).body.skipped).toHaveLength(2);
    const mine = await call(app, 'GET', O('/master/statements'), { token: master.token });
    expect(mine.body.view).toBe('master');
    expect(mine.body.items.map((x: any) => x.currency).sort()).toEqual(['EUR', 'GBP']);
    expect((await call(app, 'POST', O(`/master/statements/${gbp.id}/approve`), { token: master.token })).status).toBe(403);
    const pdf = await call(app, 'GET', O(`/master/statements/${gbp.id}/export?format=pdf`), { token: master.token });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((await call(app, 'GET', O(`/master/statements/${gbp.id}`), { token: fo1.token })).status).toBe(403);
  });
});

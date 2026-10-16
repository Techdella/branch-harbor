/**
 * DEMO SITE ONLY (called from seed-demo.ts, never `db:seed`): franchise development demo data for Northlight Yoga.
 *
 * - Territory map: the seeded franchise territories get drawn areas around their cities (US ones also ZIP codes),
 *   plus territories for the open, sold and in-development studios; the Washington and Ireland ones link to the
 *   access-model territories. Demographics are SANDBOX sample figures (flagged) and scored; statuses synced; the
 *   public "Available territories" map is on.
 * - Surveys: the franchisee satisfaction template with two closed quarterly rounds and an open one, action plans.
 * - Validation calls: three franchise owners volunteer; calls for two candidates (one completed, one scheduled, one
 *   with proposed times). Scheduling link token: printed by seed-demo.
 * - Agreement lifecycle: a transfer in review, an issued notice of default (counsel reviewed) in its cure period, a
 *   draft amendment, and the Washington development schedule for the area developer.
 * - Master franchise: Northlight Ireland's master agreement (Siobhán Kelly, access territory "Northlight Ireland") with
 *   a 40 % / 25 % split and split statements for the closed royalty periods (the oldest paid by sandbox transfer).
 */
import { and, asc, eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { STARTER_SURVEY, TRANSFER_STEPS, addDaysYmd, renderNotice, type TerritoryGeometry } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { generateSplitStatements } from '../routes/master.ts';
import { derivedStatus, refreshDemographics, territoryLinks } from '../services/franchise-dev/territories.ts';

const MAIL = 'northlight.demo.branchharbor.com';
const DAY = 86_400_000;

/** A rough hexagon (radius in km) around a point: a stand-in for a drawn territory. */
function hexagon(lat: number, lng: number, km: number, skew = 0): TerritoryGeometry {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + skew;
    const r = km * (i % 2 ? 0.85 : 1);
    pts.push([Math.round((lng + (r * Math.cos(a)) / (111.32 * Math.cos((lat * Math.PI) / 180))) * 1e5) / 1e5, Math.round((lat + (r * Math.sin(a)) / 111.32) * 1e5) / 1e5]);
  }
  return { type: 'Polygon', coordinates: [[...pts, pts[0]!]] };
}

const CITY: Record<string, { lat: number; lng: number; km: number; zips?: string[] }> = {
  'Calgary Beltline': { lat: 51.04, lng: -114.07, km: 4 },
  'Halifax Peninsula': { lat: 44.65, lng: -63.58, km: 3.5 },
  'Ottawa Glebe': { lat: 45.4, lng: -75.69, km: 3 },
  'Victoria Downtown': { lat: 48.43, lng: -123.36, km: 3 },
  'Austin North': { lat: 30.35, lng: -97.73, km: 6, zips: ['78751', '78752', '78756', '78757'] },
  'Phoenix East': { lat: 33.45, lng: -111.95, km: 7, zips: ['85008', '85018', '85034'] },
  'Minneapolis Uptown': { lat: 44.95, lng: -93.3, km: 4, zips: ['55405', '55408', '55409'] },
  'Denver LoHi': { lat: 39.76, lng: -105.01, km: 4, zips: ['80211', '80212'] },
  'Brisbane Fortitude Valley': { lat: -27.46, lng: 153.04, km: 4 },
  'Melbourne Fitzroy': { lat: -37.8, lng: 144.98, km: 3 },
};

export async function seedFranchiseDev({ db, today }: { db: Db; today: string }) {
  const [org] = await db.select().from(t.organizations).where(eq(t.organizations.slug, 'northlight-yoga'));
  if (!org) return null;
  const orgId = org.id;
  const s = { db, cfg: {}, partnerFetch: async () => ({ ok: false, status: 503, text: async () => '' }) } as unknown as Services;
  const user = async (local: string) => (await db.select().from(t.users).where(eq(t.users.email, `${local}@${MAIL}`)))[0]!;
  const ceo = await user('elena.marsh');
  const vp = await user('daniel.okafor');
  const legal = await user('amara.nwosu');
  const liam = await user('liam.oconnor');
  const ava = await user('ava.thompson');
  const oliver = await user('oliver.grant');
  const mia = await user('mia.rossi');
  const noah = await user('noah.williams');
  const siobhan = await user('siobhan.kelly');
  const ryan = await user('ryan.mitchell');
  const groups = await db.select().from(t.ownerGroups).where(eq(t.ownerGroups.organizationId, orgId));
  const G = (prefix: string) => groups.find((g) => g.name.startsWith(prefix))!;
  const locs = await db.select().from(t.locations).where(eq(t.locations.organizationId, orgId));
  const L = Object.fromEntries(locs.map((l) => [l.code, l])) as Record<string, (typeof locs)[number]>;
  const regions = await db.select().from(t.regions).where(eq(t.regions.organizationId, orgId));
  const accessTerr = await db.select().from(t.territories).where(eq(t.territories.organizationId, orgId));
  const ireland = accessTerr.find((x) => x.country === 'IE');
  const washington = accessTerr.find((x) => x.country === 'US');

  // Location coordinates (the demo locations have addresses but no geo yet).
  const GEO: Record<string, { lat: number; lng: number }> = {
    'TOR-AX': { lat: 43.6655, lng: -79.4106 }, 'YVR-MS': { lat: 49.2556, lng: -123.1009 }, 'YVR-KT': { lat: 49.2682, lng: -123.1555 }, 'PDX-PR': { lat: 45.5254, lng: -122.6834 },
    'LON-HK': { lat: 51.5432, lng: -0.0553 }, 'DUB-PB': { lat: 53.3318, lng: -6.2645 }, 'GWY-DK': { lat: 53.2707, lng: -9.0486 }, 'SEA-FR': { lat: 47.6505, lng: -122.3493 }, 'TAC-SD': { lat: 47.2652, lng: -122.4479 },
  };
  for (const [code, geo] of Object.entries(GEO)) if (L[code] && !L[code]!.geo) await db.update(t.locations).set({ geo }).where(eq(t.locations.id, L[code]!.id));

  /* ------------------------------- territories ------------------------------- */
  const existing = await db.select().from(t.franchiseTerritories).where(eq(t.franchiseTerritories.organizationId, orgId));
  for (const x of existing) {
    const c = CITY[x.name];
    if (!c) continue;
    const geometry = hexagon(c.lat, c.lng, c.km, x.name.length / 10);
    await db.update(t.franchiseTerritories).set({ geometry, centroid: { lat: c.lat, lng: c.lng }, postcodes: c.zips ?? [], exclusivity: x.name.startsWith('Austin') ? 'protected' : 'exclusive', description: `${x.name}: the area shown on the map${c.zips ? `, ZIP codes ${c.zips.join(', ')}` : ''}.` }).where(eq(t.franchiseTerritories.id, x.id));
  }
  const agreements = await db.select().from(t.franchiseAgreements).where(eq(t.franchiseAgreements.organizationId, orgId));
  const agreementOf = (groupId: string) => agreements.find((a) => a.ownerGroupId === groupId && a.status === 'active');
  const extra = [
    { name: 'Vancouver Mount Pleasant', country: 'CA', region: 'BC', geo: GEO['YVR-MS']!, km: 2.5, status: 'open', group: G('Pacific') },
    { name: 'Vancouver Kitsilano', country: 'CA', region: 'BC', geo: GEO['YVR-KT']!, km: 2.2, status: 'open', group: G('Pacific') },
    { name: 'Portland Pearl & Northwest', country: 'US', region: 'OR', geo: GEO['PDX-PR']!, km: 3, status: 'open', group: G('Rose'), zips: ['97209', '97210'] },
    { name: 'Toronto Annex', country: 'CA', region: 'ON', geo: GEO['TOR-AX']!, km: 3, status: 'open', group: null },
    { name: 'London Hackney', country: 'GB', region: null, geo: GEO['LON-HK']!, km: 3, status: 'open', group: G('Thames'), zips: ['E8', 'E9', 'E5'] },
    { name: 'Dublin South City', country: 'IE', region: null, geo: GEO['DUB-PB']!, km: 3, status: 'under_development', group: G('Thames'), scope: ireland?.id },
    { name: 'Galway City', country: 'IE', region: null, geo: GEO['GWY-DK']!, km: 4, status: 'open', group: G('Atlantic'), scope: ireland?.id },
    { name: 'Cork City', country: 'IE', region: null, geo: { lat: 51.8985, lng: -8.4756 }, km: 5, status: 'available', group: null, scope: ireland?.id },
    { name: 'Seattle Fremont & Wallingford', country: 'US', region: 'WA', geo: GEO['SEA-FR']!, km: 3, status: 'open', group: G('Cascade'), zips: ['98103', '98107'], scope: washington?.id },
    { name: 'Tacoma North End', country: 'US', region: 'WA', geo: GEO['TAC-SD']!, km: 4, status: 'under_development', group: G('Cascade'), zips: ['98403', '98405', '98406'], scope: washington?.id },
    { name: 'Spokane South Hill', country: 'US', region: 'WA', geo: { lat: 47.638, lng: -117.405 }, km: 4, status: 'reserved', group: null, zips: ['99203', '99223'], scope: washington?.id },
    { name: 'Bellevue Downtown', country: 'US', region: 'WA', geo: { lat: 47.6101, lng: -122.2015 }, km: 3.5, status: 'available', group: null, zips: ['98004'], scope: washington?.id },
  ];
  for (const x of extra) {
    await db.insert(t.franchiseTerritories).values({
      organizationId: orgId, name: x.name, country: x.country, region: x.region, status: x.status, ownerGroupId: x.group?.id ?? null, agreementId: x.group ? agreementOf(x.group.id)?.id ?? null : null,
      geometry: hexagon(x.geo.lat, x.geo.lng, x.km, x.name.length / 7), centroid: x.geo, postcodes: x.zips ?? [], exclusivity: x.status === 'open' ? 'protected' : 'exclusive',
      scopeTerritoryId: x.scope ?? null, statusChangedAt: new Date(Date.now() - 30 * DAY), showOnSite: true, description: x.group ? `Held by ${x.group.name}.` : null,
    });
  }
  const all = await db.select().from(t.franchiseTerritories).where(eq(t.franchiseTerritories.organizationId, orgId));
  for (const x of all) await refreshDemographics(s, x);
  const links = await territoryLinks(db, orgId, all.map((x) => x.id));
  for (const x of all) {
    const st = derivedStatus(x, links.get(x.id));
    if (st !== x.status && !['open', 'under_development'].includes(x.status)) await db.update(t.franchiseTerritories).set({ status: st }).where(eq(t.franchiseTerritories.id, x.id));
  }
  const fr = (org.settings.franchise ?? {}) as Record<string, unknown>;
  await db.update(t.organizations).set({ settings: { ...org.settings, franchise: { ...fr, enquiryFormEnabled: true, territoryMap: { publicMap: true, showTaken: true, targets: { population: 120_000, households: 45_000, incomeMinor: 8_500_000 } } } } }).where(eq(t.organizations.id, orgId));

  /* --------------------------------- surveys --------------------------------- */
  const [survey] = await db.insert(t.franchiseSurveys).values({ organizationId: orgId, ...STARTER_SURVEY, minResponses: 3, audience: 'owners_and_managers', status: 'active', nextRunOn: addDaysYmd(today, 70), createdBy: ceo.id }).returning();
  const na = regions.find((r) => r.name === 'North America')!;
  const eu = regions.find((r) => r.name === 'Europe')!;
  const slices = [
    { regionId: na.id, ownerGroupId: G('Pacific').id }, { regionId: na.id, ownerGroupId: G('Pacific').id }, { regionId: na.id, ownerGroupId: G('Rose').id }, { regionId: eu.id, ownerGroupId: G('Thames').id },
    { regionId: eu.id, ownerGroupId: G('Thames').id }, { regionId: eu.id, ownerGroupId: G('Atlantic').id }, { regionId: na.id, ownerGroupId: G('Cascade').id },
  ];
  const comments = ['More local marketing help before openings', 'The new booking app saves us hours', 'Royalty statements are clearer now', 'Faster answers from the help desk, please', 'Training for new instructors is excellent', 'Regional events would help us learn from each other', 'Please share the fund report every quarter'];
  const rounds = [
    { label: 'Apr 2026', opens: addDaysYmd(today, -190), n: 6, base: [9, 7, 6, 10, 8, 5], status: 'closed' },
    { label: 'Jul 2026', opens: addDaysYmd(today, -100), n: 7, base: [9, 9, 7, 10, 8, 6, 10], status: 'closed' },
    { label: 'Oct 2026', opens: addDaysYmd(today, -6), n: 2, base: [10, 8], status: 'open' },
  ];
  for (const [ri, r] of rounds.entries()) {
    const [round] = await db.insert(t.franchiseSurveyRounds).values({ organizationId: orgId, surveyId: survey!.id, label: r.label, opensOn: r.opens, closesOn: addDaysYmd(r.opens, 14), status: r.status, invitedCount: 8 }).returning();
    await db.insert(t.franchiseSurveyResponses).values(Array.from({ length: r.n }, (_, i) => ({
      organizationId: orgId, roundId: round!.id, respondentKey: createHash('sha256').update(`${round!.id}:${i}`).digest('hex'), ...slices[i % slices.length]!,
      answers: { enps: r.base[i]!, support: 3 + ((i + ri) % 3), marketing: 2 + ((i + ri * 2) % 3), training: 4 + (i % 2), value: 2 + ((i + 1) % 3), invest_again: ['Yes', 'Probably', 'Yes', 'Not sure'][i % 4]!, improve: comments[(i + ri * 3) % comments.length]! },
      npsScore: r.base[i]!, submittedAt: new Date(Date.parse(`${r.opens}T12:00:00Z`) + (i + 1) * DAY),
    })));
  }
  await db.insert(t.franchiseSurveyActions).values([
    { organizationId: orgId, surveyId: survey!.id, theme: 'marketing', title: 'Pre-opening marketing kit for every new studio', description: 'Coming-soon campaign, launch offers and a local PR template.', ownerUserId: vp.id, dueOn: addDaysYmd(today, 45), status: 'in_progress', shared: true, createdBy: ceo.id },
    { organizationId: orgId, surveyId: survey!.id, theme: 'value', title: 'Publish the marketing fund report every quarter', ownerUserId: ceo.id, dueOn: addDaysYmd(today, -10), status: 'done', shared: true, createdBy: ceo.id },
    { organizationId: orgId, surveyId: survey!.id, theme: 'support', title: 'Help desk: first answer within one business day', ownerUserId: legal.id, dueOn: addDaysYmd(today, 30), status: 'open', createdBy: ceo.id },
  ]);

  /* ----------------------------- validation calls ---------------------------- */
  const validators = await db.insert(t.franchiseValidators).values([
    { organizationId: orgId, userId: liam.id, ownerGroupId: G('Pacific').id, locationId: L['YVR-MS']!.id, country: 'CA', region: 'BC', bio: 'Two studios in Vancouver since 2019. Ask me about hiring instructors and the first year.', schedulingUrl: 'https://cal.example.com/liam-pacific-heat', maxCallsPerMonth: 4 },
    { organizationId: orgId, userId: ava.id, ownerGroupId: G('Rose').id, locationId: L['PDX-PR']!.id, country: 'US', region: 'OR', bio: 'Opened Portland Pearl in 2021 after ten years in corporate finance.', maxCallsPerMonth: 3 },
    { organizationId: orgId, userId: oliver.id, ownerGroupId: G('Thames').id, locationId: L['LON-HK']!.id, country: 'GB', region: null, bio: 'Running Hackney and opening Dublin. Happy to talk about multi-unit growth.', maxCallsPerMonth: 2 },
  ]).returning();
  const V = (uid: string) => validators.find((v) => v.userId === uid)!;
  const pros = await db.select().from(t.franchiseProspects).where(eq(t.franchiseProspects.organizationId, orgId));
  const ben = pros.find((p) => p.name === 'Ben Okafor');
  const sofia = pros.find((p) => p.name === 'Sofia Marquez');
  let validationToken: string | null = null;
  if (ben && sofia) {
    await db.insert(t.franchiseValidationCalls).values([
      { organizationId: orgId, prospectId: ben.id, validatorId: V(ava.id).id, status: 'completed', scheduledAt: new Date(Date.now() - 5 * DAY), completedAt: new Date(Date.now() - 5 * DAY), sentiment: 'positive', outcome: 'Asked about ramp-up time and staffing. Felt reassured about HQ support.', createdBy: vp.id, createdAt: new Date(Date.now() - 9 * DAY) },
      { organizationId: orgId, prospectId: ben.id, validatorId: V(liam.id).id, status: 'scheduled', scheduledAt: new Date(Date.now() + 2 * DAY), createdBy: vp.id, createdAt: new Date(Date.now() - 9 * DAY) },
      { organizationId: orgId, prospectId: sofia.id, validatorId: V(oliver.id).id, status: 'requested', proposedTimes: 'Tue or Thu after 4pm Phoenix time', createdBy: vp.id, createdAt: new Date(Date.now() - 2 * DAY) },
      { organizationId: orgId, prospectId: sofia.id, validatorId: V(ava.id).id, status: 'requested', createdBy: vp.id, createdAt: new Date(Date.now() - 2 * DAY) },
    ]);
    validationToken = `demo-validation-${randomBytes(12).toString('hex')}`;
    await db.insert(t.franchiseValidationLinks).values({ organizationId: orgId, prospectId: sofia.id, tokenHash: createHash('sha256').update(validationToken).digest('hex'), expiresAt: new Date(Date.now() + 60 * DAY) });
  }

  /* ---------------------------- agreement lifecycle --------------------------- */
  const rose = agreementOf(G('Rose').id);
  if (rose) {
    const done = new Set(['buyer_application', 'buyer_qualified', 'buyer_disclosure']);
    await db.insert(t.agreementTransfers).values({
      organizationId: orgId, agreementId: rose.id, fromOwnerGroupId: rose.ownerGroupId, buyerName: 'Willamette Wellness LLC', status: 'in_review', transferFeeMinor: 1_500_000, currency: 'USD', effectiveDate: addDaysYmd(today, 60),
      reason: 'Ava is relocating; the buyer runs two wellness clinics in Portland.', steps: TRANSFER_STEPS.map((key) => ({ key, done: done.has(key), doneAt: done.has(key) ? new Date(Date.now() - 12 * DAY).toISOString() : null, doneBy: done.has(key) ? legal.id : null, note: null })), createdBy: legal.id,
    });
  }
  const pacific = agreementOf(G('Pacific').id);
  if (pacific) {
    const issued = addDaysYmd(today, -6);
    const r = renderNotice('default', { franchisee: G('Pacific').name, brand: org.name, agreementDate: pacific.startDate, reason: 'insurance', details: 'the general liability certificate for Kitsilano expired on 30 September 2026 and no renewal has been provided', cureDays: 10, cureDeadline: addDaysYmd(issued, 10), date: issued });
    await db.insert(t.agreementNotices).values({
      organizationId: orgId, agreementId: pacific.id, ownerGroupId: pacific.ownerGroupId, kind: 'default', reason: 'insurance', details: 'the general liability certificate for Kitsilano expired on 30 September 2026 and no renewal has been provided',
      subject: r.subject, body: r.body, cureDays: 10, cureDeadline: addDaysYmd(issued, 10), status: 'issued', counselReviewed: true, counselReviewedBy: legal.id, counselReviewedAt: new Date(Date.now() - 7 * DAY), counselNote: 'Reviewed by Harlow & Finch LLP',
      issuedAt: new Date(Date.parse(`${issued}T15:00:00Z`)), issuedBy: legal.id, deliveredTo: 'liam.oconnor@northlight.demo.branchharbor.com', createdBy: legal.id,
    });
  }
  const thames = agreementOf(G('Thames').id);
  if (thames) await db.insert(t.agreementAmendments).values({ organizationId: orgId, agreementId: thames.id, title: 'Royalty relief during the Dublin opening', summary: 'Royalty at 4.5 % for six months while Dublin Portobello opens.', changes: { royaltyBps: 450 }, effectiveDate: addDaysYmd(today, 15), createdBy: legal.id });
  if (washington) {
    const [dev] = await db.insert(t.developmentAgreements).values({ organizationId: orgId, ownerGroupId: G('Cascade').id, scopeTerritoryId: washington.id, name: 'Washington State development agreement', unitsTotal: 4, startDate: '2025-03-01', developmentFeeMinor: 6_000_000, currency: 'USD', territoryIds: (await db.select({ id: t.franchiseTerritories.id }).from(t.franchiseTerritories).where(and(eq(t.franchiseTerritories.organizationId, orgId), eq(t.franchiseTerritories.scopeTerritoryId, washington.id)))).map((x) => x.id), createdBy: legal.id, notes: 'Four units in Washington by mid-2028; Ryan Mitchell (Cascade Development Group) is the area developer.' }).returning();
    const wa = (n: string) => all.find((x) => x.name === n)?.id ?? null;
    await db.insert(t.developmentScheduleItems).values([
      { organizationId: orgId, developmentAgreementId: dev!.id, sequence: 1, label: 'Seattle Fremont', territoryId: wa('Seattle Fremont & Wallingford'), signByDate: '2025-04-30', openByDate: '2025-12-31', status: 'opened', locationId: L['SEA-FR']!.id, signedOn: '2025-04-12', openedOn: '2025-11-08' },
      { organizationId: orgId, developmentAgreementId: dev!.id, sequence: 2, label: 'Tacoma Stadium District', territoryId: wa('Tacoma North End'), signByDate: '2026-01-31', openByDate: '2026-09-30', status: 'signed', locationId: L['TAC-SD']!.id, signedOn: '2026-01-20', note: 'Fit-out delayed by permits.' },
      { organizationId: orgId, developmentAgreementId: dev!.id, sequence: 3, label: 'Spokane South Hill', territoryId: wa('Spokane South Hill'), signByDate: '2027-01-31', openByDate: '2027-09-30', status: 'pending' },
      { organizationId: orgId, developmentAgreementId: dev!.id, sequence: 4, label: 'Bellevue Downtown', territoryId: wa('Bellevue Downtown'), signByDate: '2027-10-31', openByDate: '2028-06-30', status: 'pending' },
    ]);
  }

  /* ------------------------------ master franchise ----------------------------- */
  let statements = 0;
  if (ireland) {
    const [masterGroup] = await db.insert(t.ownerGroups).values({ organizationId: orgId, name: 'Northlight Ireland Master Ltd', legalName: 'Northlight Ireland Master Ltd' }).returning();
    const [m] = await db.insert(t.masterAgreements).values({
      organizationId: orgId, ownerGroupId: masterGroup!.id, scopeTerritoryId: ireland.id, kind: 'master_franchisee', name: 'Northlight Ireland master franchise', countries: ['IE'], homeCountry: 'IE', startDate: '2025-01-01', endDate: '2040-12-31',
      splits: [{ currency: null, royaltyShareBps: 4000, fundShareBps: 2500 }], payoutMethod: 'stripe_transfer', stripeAccountId: 'acct_sandbox_nl_ie_master', createdBy: ceo.id,
    }).returning();
    await db.update(t.franchiseTerritories).set({ masterAgreementId: m!.id }).where(and(eq(t.franchiseTerritories.organizationId, orgId), eq(t.franchiseTerritories.scopeTerritoryId, ireland.id)));
    const periods = await db.select().from(t.royaltyPeriods).where(and(eq(t.royaltyPeriods.organizationId, orgId), eq(t.royaltyPeriods.status, 'closed'))).orderBy(asc(t.royaltyPeriods.startDate));
    for (const [i, p] of periods.entries()) {
      const { out } = await generateSplitStatements(db, orgId, p.id, m!.id);
      statements += out.length;
      for (const x of out) {
        if (i === 0 && x.payableMinor > 0) await db.update(t.masterSplitStatements).set({ status: 'paid', approvedAt: new Date(Date.now() - 40 * DAY), approvedBy: ceo.id, payoutMethod: 'stripe_transfer', transferId: `tr_sandbox_${createHash('sha256').update(x.id).digest('hex').slice(0, 14)}`, sandbox: true, paidAt: new Date(Date.now() - 38 * DAY), paidBy: ceo.id }).where(eq(t.masterSplitStatements.id, x.id));
        else if (i === 1) await db.update(t.masterSplitStatements).set({ status: 'approved', approvedAt: new Date(Date.now() - 8 * DAY), approvedBy: ceo.id }).where(eq(t.masterSplitStatements.id, x.id));
      }
    }
  }
  return {
    territories: all.length, surveyRounds: rounds.length, validationToken, statements,
    logins: [siobhan.email, ryan.email, mia.email, noah.email],
  };
}

/**
 * Demo franchisor team for the access model (demo site only): "Northlight Yoga International", a hot-yoga
 * franchise with HQ in Toronto, company-owned and franchised studios in Canada, the US and the UK, and a team
 * whose jobs don't match the org chart — every person has a demo login listed in the demo sign-in picker.
 *
 * Generic brand, sample data only. Called from seed-demo.ts.
 */
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { addDays, zonedToUtc } from '../lib/tz.ts';

type User = typeof t.users.$inferSelect;

export const NORTHLIGHT_SLUG = 'northlight-yoga';
const MAIL = 'northlight.demo.branchharbor.com';

export interface NorthlightSeedInput {
  db: Db;
  today: string;
  sitesBaseUrl: string;
  upsertUser: (email: string, name: string, locale?: string) => Promise<User>;
}

export async function seedNorthlight({ db, today, sitesBaseUrl, upsertUser }: NorthlightSeedInput) {
  const [org] = await db.insert(t.organizations).values({
    slug: NORTHLIGHT_SLUG, name: 'Northlight Yoga International', industry: 'studios', model: 'network', country: 'CA', defaultCurrency: 'CAD', defaultLocale: 'en',
    defaultTimeZone: 'America/Toronto', dataRegion: 'us', applicationFeeBps: 100, paymentAccountMode: 'per_location',
    onboarding: Object.fromEntries(['industry', 'business_details', 'first_location', 'website', 'industry_data', 'connections', 'invite_staff', 'preview', 'publish'].map((k) => [k, { status: 'complete', updatedAt: new Date().toISOString() }])),
    settings: { refundApprovalThresholds: { CAD: 10000, USD: 10000, GBP: 8000 } },
  }).returning();
  const orgId = org!.id;
  const [na, eu] = await db.insert(t.regions).values([{ organizationId: orgId, name: 'North America' }, { organizationId: orgId, name: 'Europe' }]).returning();
  const [pacific, rose, thames, atlantic, cascade] = await db.insert(t.ownerGroups).values([
    { organizationId: orgId, name: 'Pacific Heat Studios Inc.', legalName: 'Pacific Heat Studios Inc.' },
    { organizationId: orgId, name: 'Rose City Yoga LLC', legalName: 'Rose City Yoga LLC' },
    { organizationId: orgId, name: 'Thames Hot Yoga Ltd', legalName: 'Thames Hot Yoga Ltd' },
    { organizationId: orgId, name: 'Atlantic Hot Yoga Ltd', legalName: 'Atlantic Hot Yoga Ltd' },
    { organizationId: orgId, name: 'Cascade Development Group LLC', legalName: 'Cascade Development Group LLC' },
  ]).returning();
  // Scopes beyond regions and owner groups: the default brand, two territories (sub-networks) and a portfolio.
  const [brand] = await db.insert(t.brands).values({ organizationId: orgId, name: 'Northlight Yoga', isDefault: true }).returning();
  const [ireland, washington] = await db.insert(t.territories).values([
    { organizationId: orgId, name: 'Northlight Ireland', kind: 'master', country: 'IE', brandId: brand!.id },
    { organizationId: orgId, name: 'Washington State development area', kind: 'development', country: 'US', brandId: brand!.id },
  ]).returning();
  const locs = await db.insert(t.locations).values([
    { organizationId: orgId, regionId: na!.id, name: 'Toronto Annex', code: 'TOR-AX', slug: 'toronto-annex', address: { line1: '488 Bloor St W', city: 'Toronto', region: 'ON', postalCode: 'M5S 1Y2', country: 'CA' }, country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', locale: 'en', phone: '+1 416 555 0190', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_nl_annex', hours: { summary: 'Daily 6am–9:30pm' } },
    { organizationId: orgId, regionId: na!.id, ownerGroupId: pacific!.id, name: 'Vancouver Main Street', code: 'YVR-MS', slug: 'vancouver-main-street', address: { line1: '3388 Main St', city: 'Vancouver', region: 'BC', postalCode: 'V5V 3M6', country: 'CA' }, country: 'CA', timeZone: 'America/Vancouver', currency: 'CAD', locale: 'en', phone: '+1 604 555 0133', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_nl_main', hours: { summary: 'Daily 6am–9pm' } },
    { organizationId: orgId, regionId: na!.id, ownerGroupId: pacific!.id, name: 'Kitsilano', code: 'YVR-KT', slug: 'kitsilano', address: { line1: '2190 W 4th Ave', city: 'Vancouver', region: 'BC', postalCode: 'V6K 1N6', country: 'CA' }, country: 'CA', timeZone: 'America/Vancouver', currency: 'CAD', locale: 'en', phone: '+1 604 555 0177', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_nl_kits', hours: { summary: 'Daily 6:30am–9pm' } },
    { organizationId: orgId, regionId: na!.id, ownerGroupId: rose!.id, name: 'Portland Pearl', code: 'PDX-PR', slug: 'portland-pearl', address: { line1: '1122 NW Everett St', city: 'Portland', region: 'OR', postalCode: '97209', country: 'US' }, country: 'US', timeZone: 'America/Los_Angeles', currency: 'USD', locale: 'en', phone: '+1 503 555 0148', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_nl_pearl', hours: { summary: 'Daily 6am–8:30pm' } },
    { organizationId: orgId, regionId: eu!.id, ownerGroupId: thames!.id, name: 'London Hackney', code: 'LON-HK', slug: 'london-hackney', address: { line1: '210 Mare St', city: 'London', postalCode: 'E8 3RD', country: 'GB' }, country: 'GB', timeZone: 'Europe/London', currency: 'GBP', locale: 'en-GB', phone: '+44 20 7946 0210', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_nl_hackney', hours: { summary: 'Daily 6:30am–9pm' } },
    { organizationId: orgId, regionId: eu!.id, ownerGroupId: thames!.id, name: 'Dublin Portobello', code: 'DUB-PB', slug: 'dublin-portobello', address: { line1: '14 South Richmond St', city: 'Dublin', postalCode: 'D02 YX80', country: 'IE' }, country: 'IE', timeZone: 'Europe/Dublin', currency: 'EUR', locale: 'en-GB', status: 'opening_soon', publiclyVisible: false, territoryId: ireland!.id },
    { organizationId: orgId, regionId: eu!.id, ownerGroupId: atlantic!.id, territoryId: ireland!.id, name: 'Galway Docks', code: 'GWY-DK', slug: 'galway-docks', address: { line1: '3 Dock Road', city: 'Galway', postalCode: 'H91 TK33', country: 'IE' }, country: 'IE', timeZone: 'Europe/Dublin', currency: 'EUR', locale: 'en-GB', phone: '+353 91 555 0133', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_nl_galway', hours: { summary: 'Daily 7am–9pm' } },
    { organizationId: orgId, regionId: na!.id, ownerGroupId: cascade!.id, territoryId: washington!.id, name: 'Seattle Fremont', code: 'SEA-FR', slug: 'seattle-fremont', address: { line1: '3410 Fremont Ave N', city: 'Seattle', region: 'WA', postalCode: '98103', country: 'US' }, country: 'US', timeZone: 'America/Los_Angeles', currency: 'USD', locale: 'en', phone: '+1 206 555 0177', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_nl_fremont', hours: { summary: 'Daily 6am–9pm' } },
    { organizationId: orgId, regionId: na!.id, ownerGroupId: cascade!.id, territoryId: washington!.id, name: 'Tacoma Stadium District', code: 'TAC-SD', slug: 'tacoma-stadium-district', address: { line1: '602 Tacoma Ave N', city: 'Tacoma', region: 'WA', postalCode: '98403', country: 'US' }, country: 'US', timeZone: 'America/Los_Angeles', currency: 'USD', locale: 'en', status: 'opening_soon', publiclyVisible: false },
  ]).returning();
  const L = Object.fromEntries(locs.map((l) => [l.code, l])) as Record<string, (typeof locs)[number]>;
  await db.insert(t.subscriptions).values({ organizationId: orgId, plan: 'network', status: 'active', billedLocationCount: 7, currency: 'CAD', pricePerLocationMinor: 11900 });

  // ── The team: jobs that don't match the org chart, each with a demo login ──
  const u = async (local: string, name: string, locale = 'en') => upsertUser(`${local}@${MAIL}`, name, locale);
  const team = {
    ceo: await u('elena.marsh', 'Elena Marsh'),
    vpFranchise: await u('daniel.okafor', 'Daniel Okafor'),
    trainer1: await u('sofia.lindqvist', 'Sofia Lindqvist'),
    trainer2: await u('marcus.bell', 'Marcus Bell'),
    cmo: await u('hannah.cho', 'Hannah Cho'),
    brand: await u('theo.laurent', 'Théo Laurent'),
    digital: await u('priyanka.shah', 'Priyanka Shah'),
    ops: await u('grace.kim', 'Grace Kim'),
    legal: await u('amara.nwosu', 'Amara Nwosu'),
    foPacific: await u('liam.oconnor', 'Liam O’Connor'),
    foRose: await u('ava.thompson', 'Ava Thompson'),
    foThames: await u('oliver.grant', 'Oliver Grant', 'en-GB'),
    lmKits: await u('mia.rossi', 'Mia Rossi'),
    lmHackney: await u('noah.williams', 'Noah Williams', 'en-GB'),
    staffKits: await u('chloe.martin', 'Chloe Martin'),
    staffAnnex: await u('ethan.brown', 'Ethan Brown'),
    deskLead: await u('zara.ahmed', 'Zara Ahmed'),
    // A full team: separate franchise development and customer sales, content, field and partner roles.
    devRep: await u('kofi.mensah', 'Kofi Mensah'),
    salesLead: await u('rafael.costa', 'Rafael Costa'),
    salesRep: await u('jade.wilson', 'Jade Wilson'),
    content: await u('lucy.zhang', 'Lucy Zhang'),
    consultant: await u('isabel.reyes', 'Isabel Reyes'),
    master: await u('siobhan.kelly', 'Siobhán Kelly', 'en-GB'),
    areaDev: await u('ryan.mitchell', 'Ryan Mitchell'),
    auditor: await u('nina.petrov', 'Nina Petrov'),
  };
  // Field consultant's portfolio: three west-coast studios across two franchisees.
  const [westCoast] = await db.insert(t.portfolios).values({ organizationId: orgId, name: 'West Coast studios', description: 'Vancouver and Portland franchisees coached by Isabel.', createdBy: team.ceo.id }).returning();
  await db.insert(t.portfolioLocations).values(['YVR-MS', 'YVR-KT', 'PDX-PR'].map((code) => ({ portfolioId: westCoast!.id, locationId: L[code]!.id, organizationId: orgId })));
  const org_ = (userId: string, role: string) => ({ organizationId: orgId, userId, role, scopeKind: 'organization', scopeId: orgId });
  const assignments = await db.insert(t.roleAssignments).values([
    org_(team.ceo.id, 'org_owner'),
    org_(team.vpFranchise.id, 'development_lead'),
    org_(team.devRep.id, 'development_rep'),
    org_(team.salesLead.id, 'sales_lead'),
    org_(team.salesRep.id, 'sales_rep'),
    org_(team.trainer1.id, 'training_lead'),
    org_(team.trainer2.id, 'trainer'),
    org_(team.cmo.id, 'marketing_lead'),
    org_(team.brand.id, 'brand_manager'),
    org_(team.digital.id, 'digital_marketer'),
    org_(team.content.id, 'content_social'),
    org_(team.ops.id, 'operations_lead'),
    org_(team.legal.id, 'legal_lead'),
    org_(team.auditor.id, 'auditor'),
    { organizationId: orgId, userId: team.consultant.id, role: 'field_consultant', scopeKind: 'portfolio', scopeId: westCoast!.id },
    { organizationId: orgId, userId: team.master.id, role: 'master_franchisee', scopeKind: 'territory', scopeId: ireland!.id },
    { organizationId: orgId, userId: team.areaDev.id, role: 'area_developer', scopeKind: 'territory', scopeId: washington!.id },
    { organizationId: orgId, userId: team.foPacific.id, role: 'franchise_owner', scopeKind: 'owner_group', scopeId: pacific!.id },
    { organizationId: orgId, userId: team.foRose.id, role: 'franchise_owner', scopeKind: 'owner_group', scopeId: rose!.id },
    { organizationId: orgId, userId: team.foThames.id, role: 'franchise_owner', scopeKind: 'owner_group', scopeId: thames!.id },
    { organizationId: orgId, userId: team.lmKits.id, role: 'location_manager', scopeKind: 'location', scopeId: L['YVR-KT']!.id },
    { organizationId: orgId, userId: team.lmHackney.id, role: 'location_manager', scopeKind: 'location', scopeId: L['LON-HK']!.id },
    { organizationId: orgId, userId: team.staffKits.id, role: 'staff', scopeKind: 'location', scopeId: L['YVR-KT']!.id },
    { organizationId: orgId, userId: team.staffAnnex.id, role: 'staff', scopeKind: 'location', scopeId: L['TOR-AX']!.id },
  ]).returning();

  // A custom role built from modules: the Annex front-desk lead runs classes and sees customers, nothing else.
  const [deskRole] = await db.insert(t.customRoles).values({
    organizationId: orgId, name: 'Front desk lead', description: 'Runs the class schedule and check-in, and looks after customer records at one studio.', baseRole: 'staff', primaryWorkspace: 'operations', createdBy: team.ceo.id,
  }).returning();
  await db.insert(t.roleCapabilities).values(['operations.classes:view', 'operations.classes:edit', 'operations.schedule:view', 'sales.customers:view', 'sales.customers:edit'].map((capability) => ({ roleId: deskRole!.id, organizationId: orgId, capability })));
  await db.insert(t.roleAssignments).values({ organizationId: orgId, userId: team.deskLead.id, role: 'custom', customRoleId: deskRole!.id, scopeKind: 'location', scopeId: L['TOR-AX']!.id, createdBy: team.ceo.id });
  // Per-person overrides: the operations lead also edits brand templates; Marcus (trainer) follows up course leads.
  const opsAssignment = assignments.find((a) => a.userId === team.ops.id)!;
  const trainerAssignment = assignments.find((a) => a.userId === team.trainer2.id)!;
  await db.insert(t.memberAccessOverrides).values([
    { organizationId: orgId, assignmentId: opsAssignment.id, capability: 'network.templates:edit', effect: 'grant', createdBy: team.ceo.id },
    ...['sales.course_leads:view', 'sales.course_leads:edit'].map((capability) => ({ organizationId: orgId, assignmentId: trainerAssignment.id, capability, effect: 'grant', createdBy: team.ceo.id })),
  ]);
  // Job titles are free text, separate from roles (the development lead's title is still VP Franchise).
  await db.insert(t.memberProfiles).values([
    [team.ceo, 'Founder & CEO'], [team.vpFranchise, 'VP Franchise Development'], [team.cmo, 'CMO'], [team.ops, 'Director of Operations'],
    [team.consultant, 'Franchise business coach'], [team.master, 'Master franchisee, Ireland'], [team.areaDev, 'Area developer, Washington'], [team.trainer1, 'Lead teacher trainer'],
  ].map(([u, jobTitle]) => ({ organizationId: orgId, userId: (u as User).id, jobTitle: jobTitle as string })));

  // ── Classes, customers, bookings and payments so every role lands on real numbers ──
  const types = await db.insert(t.classTypes).values([
    { organizationId: orgId, name: 'Northlight Flow (hot)', durationMinutes: 60, defaultCapacity: 30, description: 'Our signature heated flow, all levels.' },
    { organizationId: orgId, name: 'Yin (warm)', durationMinutes: 75, defaultCapacity: 24, description: 'Long holds in a warm room.' },
    { organizationId: orgId, name: 'Hot Pilates', durationMinutes: 45, defaultCapacity: 20, description: 'Strength and core in the heat.' },
    { organizationId: orgId, name: 'Community Class', durationMinutes: 60, defaultCapacity: 30, description: 'Pay-what-you-can class led by instructors in training.' },
  ]).returning();
  const slots = [
    { type: 0, time: '06:30', instructor: 'Sofia Lindqvist' },
    { type: 2, time: '12:00', instructor: 'Chloe Martin' },
    { type: 0, time: '17:45', instructor: 'Marcus Bell' },
    { type: 1, time: '19:30', instructor: 'Chloe Martin' },
  ];
  const price: Record<string, number> = { CAD: 2600, USD: 2400, GBP: 1700, EUR: 1900 };
  const operating = locs.filter((l) => l.status === 'operating');
  const occs: Array<typeof t.classOccurrences.$inferInsert> = [];
  for (const loc of operating) {
    for (let d = -14; d < 7; d++) {
      const date = addDays(today, d);
      for (const sl of slots) {
        const ty = types[sl.type]!;
        const startsAt = zonedToUtc(date, sl.time, loc.timeZone);
        occs.push({ organizationId: orgId, locationId: loc.id, classTypeId: ty.id, startsAt, endsAt: new Date(startsAt.getTime() + ty.durationMinutes * 60_000), capacity: ty.defaultCapacity, priceMinor: price[loc.currency] ?? 0, currency: loc.currency, instructorName: sl.instructor, room: 'Hot room' });
      }
    }
  }
  const occRows = await db.insert(t.classOccurrences).values(occs).returning();
  const names = ['Isabella Nguyen', 'Jack Robinson', 'Layla Haddad', 'Mason Clarke', 'Nora Fitzgerald', 'Owen Park', 'Ruby Singh', 'Samuel Ortiz', 'Tess Morgan', 'Victor Hale'];
  for (const [li, loc] of operating.entries()) {
    const custs = await db.insert(t.customers).values(names.map((n) => ({ organizationId: orgId, locationId: loc.id, name: n, email: `${n.toLowerCase().replace(/\s+/g, '.')}+${loc.code.toLowerCase()}@example.com` }))).returning();
    const mine = occRows.filter((o) => o.locationId === loc.id);
    for (const [oi, occ] of mine.entries()) {
      if (oi % 3 !== li % 3) continue;
      const past = occ.startsAt < new Date();
      for (const c of custs.slice(0, 3 + ((oi + li) % 6))) {
        const [b] = await db.insert(t.classBookings).values({ organizationId: orgId, locationId: loc.id, occurrenceId: occ.id, customerId: c.id, status: past ? 'attended' : 'confirmed', confirmedAt: new Date(occ.startsAt.getTime() - 2 * 86400_000), source: 'web' }).returning();
        const [p] = await db.insert(t.paymentReferences).values({
          organizationId: orgId, locationId: loc.id, provider: 'stripe', externalId: `pi_seed_nl_${randomBytes(8).toString('hex')}`, connectedAccountId: loc.stripeAccountId,
          amountMinor: occ.priceMinor, currency: loc.currency, applicationFeeMinor: Math.floor(occ.priceMinor / 100), state: 'succeeded',
          succeededAt: new Date(occ.startsAt.getTime() - 2 * 86400_000), createdAt: new Date(occ.startsAt.getTime() - 2 * 86400_000), targetType: 'class_booking', targetId: b!.id, sandbox: 1,
        }).returning();
        await db.update(t.classBookings).set({ paymentId: p!.id }).where(eq(t.classBookings.id, b!.id));
      }
    }
    await db.insert(t.leads).values(custs.slice(7).map((c) => ({ organizationId: orgId, locationId: loc.id, customerId: c.id, name: c.name, email: c.email, source: 'website', message: 'Interested in the intro month' })));
  }

  // ── Brand template and websites: HQ locks the brand, studios edit their own details ──
  const [tpl] = await db.insert(t.templates).values({ organizationId: orgId, name: 'Northlight studio home', industry: 'studios', fields: [
    { key: 'brand_tagline', label: 'Brand tagline', type: 'text', policy: 'locked', defaultValue: 'Hot yoga for a brighter you.' },
    { key: 'hero_title', label: 'Hero title', type: 'text', policy: 'editable', defaultValue: 'Your neighbourhood hot yoga studio' },
    { key: 'intro_offer', label: 'Intro offer', type: 'text', policy: 'approval', defaultValue: 'Intro month: 30 days unlimited' },
    { key: 'about', label: 'About this studio', type: 'richtext', policy: 'editable', defaultValue: 'Heated classes, friendly teachers and a community that shows up for each other.' },
  ] }).returning();
  for (const loc of locs) {
    const [site] = await db.insert(t.websites).values({ organizationId: orgId, locationId: loc.id, kind: 'hosted', templateId: tpl!.id, includedAddress: `${sitesBaseUrl}/${NORTHLIGHT_SLUG}/${loc.slug}`, status: loc.publiclyVisible ? 'live' : 'draft' }).returning();
    const [page] = await db.insert(t.pages).values({ organizationId: orgId, websiteId: site!.id, locationId: loc.id, templateId: tpl!.id, slug: 'home', title: `${loc.name} — Northlight Yoga` }).returning();
    await db.insert(t.fieldOverrides).values(tpl!.fields.map((f) => ({
      organizationId: orgId, pageId: page!.id, fieldKey: f.key, origin: (f.policy === 'locked' ? 'locked' : f.policy === 'approval' ? 'approval' : 'hq') as t.FieldOrigin, value: f.defaultValue, hqValue: f.defaultValue,
    })));
  }

  // ── Staff shifts (one running now at Kitsilano for clock-in) ──
  const kits = L['YVR-KT']!;
  const now = new Date();
  await db.insert(t.shifts).values([
    { organizationId: orgId, locationId: kits.id, userId: team.staffKits.id, startsAt: new Date(now.getTime() - 60 * 60_000), endsAt: new Date(now.getTime() + 3 * 3600_000), role: 'Instructor', createdBy: team.lmKits.id },
    { organizationId: orgId, locationId: L['TOR-AX']!.id, userId: team.staffAnnex.id, startsAt: zonedToUtc(addDays(today, 1), '06:00', 'America/Toronto'), endsAt: zonedToUtc(addDays(today, 1), '12:00', 'America/Toronto'), role: 'Front desk', createdBy: team.ops.id },
  ]);

  // ── Franchise development: Daniel (VP Franchise) owns the pipeline; Thames Hot Yoga is opening Dublin Portobello ──
  const { seedFranchise } = await import('./seed-franchise.ts');
  const franchise = await seedFranchise({
    db, orgId, demo: team.ceo, lead: team.vpFranchise, brand: 'Northlight', collectLocationCode: 'TOR-AX',
    onboarding: { ownerGroupId: thames!.id, locationId: L['DUB-PB']!.id, prospect: { name: team.foThames.name, email: team.foThames.email, country: 'IE', city: 'Dublin', currency: 'EUR' } },
  });
  // Territory pipelines: the master franchisee works Ireland, the area developer their development schedule.
  await db.update(t.franchiseProspects).set({ scopeTerritoryId: ireland!.id }).where(and(eq(t.franchiseProspects.organizationId, orgId), eq(t.franchiseProspects.email, team.foThames.email)));
  await db.insert(t.franchiseProspects).values([
    { organizationId: orgId, name: 'Ciara Byrne', email: 'ciara.byrne@example.com', country: 'IE', city: 'Cork', currency: 'EUR', stage: 'qualified', source: 'website', scopeTerritoryId: ireland!.id, ownerUserId: team.master.id, message: 'Looking at a site near the English Market.' },
    { organizationId: orgId, name: 'Declan Murphy', email: 'declan.murphy@example.com', country: 'IE', city: 'Limerick', currency: 'EUR', stage: 'enquiry', source: 'referral', scopeTerritoryId: ireland!.id, ownerUserId: team.master.id },
    { organizationId: orgId, name: 'Tacoma Stadium District (unit 2 of 4)', email: 'ryan.mitchell+tacoma@example.com', country: 'US', region: 'WA', city: 'Tacoma', currency: 'USD', stage: 'signed', source: 'other', scopeTerritoryId: washington!.id, ownerUserId: team.areaDev.id, units: 1, message: 'Second unit of the Washington development schedule.' },
    { organizationId: orgId, name: 'Spokane South Hill (unit 3 of 4)', email: 'ryan.mitchell+spokane@example.com', country: 'US', region: 'WA', city: 'Spokane', currency: 'USD', stage: 'enquiry', source: 'other', scopeTerritoryId: washington!.id, ownerUserId: team.areaDev.id, units: 1 },
  ]);

  // ── Community, Training academy, course leads and help desk ──
  const network = await (await import('./seed-northlight-network.ts')).seedNorthlightNetwork({
    db, orgId, team, regions: { na: na!.id, eu: eu!.id }, groups: { pacific: pacific!.id, thames: thames!.id }, L,
  });

  const logins = Object.values(team).map((x) => x.email);
  return { orgId, logins, franchise, network };
}

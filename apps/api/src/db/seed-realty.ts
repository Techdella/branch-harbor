/**
 * Real Estate demo (sample data only): Keystone Realty Network — offices in Toronto (CAD, sq ft), Vancouver (CAD),
 * London (GBP, sq ft), Madrid (EUR, m²), Dubai (AED, sq ft) and Sydney (AUD, m²), with agents, ~20 listings across
 * the lifecycle, enquiries, viewings (some today), feedback, an offer in negotiation and a consented saved search.
 * Disclosure texts are labelled samples — real ones are supplied by the business. Re-running replaces the org.
 */
import { eq, inArray } from 'drizzle-orm';
import { toSqm } from '@bh/shared';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { addDays, localDateParts, zonedToUtc } from '../lib/tz.ts';
import { sha256 } from '../lib/crypto.ts';

export const REALTY_DEMO_SLUG = 'keystone-realty';
type User = typeof t.users.$inferSelect;
const u = (id: string, w = 1400) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=70`;
const IMG = {
  modern: u('1600585154340-be6161a56a0c'), pool: u('1564013799919-ab600027ffc6'), living: u('1560448204-e02f11c3d0e2'), living2: u('1600566753190-17f0baa2a6c3'),
  house: u('1570129477492-45c003edd2be'), house2: u('1580587771525-78b9dba3b914'), apt: u('1554995207-c18c203602cb'), kitchen: u('1556909114-f6e7ad7d3136'),
  bedroom: u('1616594039964-ae9021a400a0'), bath: u('1552321554-5fefe8c9ef14'), tower: u('1545324418-cc1a3fa10c00'), terrace: u('1512917774080-9991f1c4c750'),
};
const PEOPLE = { w1: u('1573496359142-b8d87734a5a2', 400), m1: u('1507003211169-0a1dd7228f2d', 400), w2: u('1494790108377-be9c29b29330', 400), w3: u('1438761681033-6461ffad8d80', 400), m2: u('1500648767791-00dcc994a43e', 400), w4: u('1534528741775-53994a69daeb', 400), m3: u('1506794778202-cad84cf45f1d', 400), m4: u('1539571696357-5a69c17a67c6', 400), w5: u('1580489944761-15a19d654956', 400) };
const WEEKDAYS = (start: string, end: string, days = [1, 2, 3, 4, 5, 6]) => days.map((weekday) => ({ weekday, start, end }));

export async function clearRealtyDemo(db: Db) {
  const old = await db.select({ id: t.organizations.id }).from(t.organizations).where(eq(t.organizations.slug, REALTY_DEMO_SLUG));
  if (!old.length) return;
  const ids = old.map((o) => o.id);
  for (const tbl of [t.auditEvents, t.consentRecords, t.aiProposedActions, t.aiMessages] as const) await db.delete(tbl).where(inArray((tbl as typeof t.auditEvents).organizationId, ids));
  await db.delete(t.organizations).where(inArray(t.organizations.id, ids));
}

export async function seedRealty(c: { db: Db; today: string; upsertUser: (email: string, name: string, locale?: string) => Promise<User>; demo: User; sitesBaseUrl: string }) {
  const { db, today } = c;
  await clearRealtyDemo(db);
  const done = Object.fromEntries(['industry', 'business_details', 'first_location', 'website', 'industry_data', 'connections', 'invite_staff'].map((k) => [k, { status: 'complete' as const, updatedAt: new Date().toISOString() }]));
  const [org] = await db.insert(t.organizations).values({
    slug: REALTY_DEMO_SLUG, name: 'Keystone Realty Network', industry: 'realty', model: 'network', country: 'CA', defaultCurrency: 'CAD', defaultLocale: 'en', defaultTimeZone: 'America/Toronto',
    dataRegion: 'us', onboarding: done, settings: { site: { tagline: 'Local agents. One trusted network.', primaryColor: '#0F6E73', font: 'Plus Jakarta Sans', enabledLocales: ['en', 'fr', 'es'] } },
  }).returning();
  const orgId = org!.id;
  const [americas, emea, apac] = await db.insert(t.regions).values([{ organizationId: orgId, name: 'Americas' }, { organizationId: orgId, name: 'Europe & Middle East' }, { organizationId: orgId, name: 'Asia-Pacific' }]).returning();
  const [midtown, shoreline, hampstead, iberia, gulf, harbour] = await db.insert(t.ownerGroups).values([
    { organizationId: orgId, name: 'Keystone Midtown Inc.', legalName: 'Keystone Midtown Inc.' }, { organizationId: orgId, name: 'Shoreline Realty Group', legalName: 'Shoreline Realty Group Ltd.' },
    { organizationId: orgId, name: 'Keystone Hampstead Ltd', legalName: 'Keystone Hampstead Ltd' }, { organizationId: orgId, name: 'Keystone Iberia S.L.', legalName: 'Keystone Iberia S.L.' },
    { organizationId: orgId, name: 'Keystone Gulf Properties LLC', legalName: 'Keystone Gulf Properties LLC' }, { organizationId: orgId, name: 'Harbour Keystone Pty Ltd', legalName: 'Harbour Keystone Pty Ltd' },
  ]).returning();
  const L = (o: Partial<typeof t.locations.$inferInsert> & Pick<typeof t.locations.$inferInsert, 'name' | 'code' | 'slug' | 'address' | 'country' | 'timeZone' | 'currency'>) => ({ organizationId: orgId, status: 'operating', publiclyVisible: true, ...o });
  const locs = await db.insert(t.locations).values([
    L({ regionId: americas!.id, ownerGroupId: midtown!.id, name: 'Toronto Midtown', code: 'TOR', slug: 'toronto-midtown', address: { line1: '2300 Yonge St', city: 'Toronto', region: 'ON', postalCode: 'M4P 1E4', country: 'CA' }, country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', locale: 'en', phone: '+1 416 555 0120', email: 'midtown@keystone-demo.example', hours: { summary: 'Mon–Sat 9am–7pm' }, geo: { lat: 43.7069, lng: -79.3984 } }),
    L({ regionId: americas!.id, ownerGroupId: shoreline!.id, name: 'North Vancouver', code: 'VAN', slug: 'north-vancouver', address: { line1: '150 Lonsdale Ave', city: 'North Vancouver', region: 'BC', postalCode: 'V7M 2E8', country: 'CA' }, country: 'CA', timeZone: 'America/Vancouver', currency: 'CAD', locale: 'en', phone: '+1 604 555 0171', hours: { summary: 'Mon–Sat 9am–6pm' }, geo: { lat: 49.3128, lng: -123.0784 } }),
    L({ regionId: emea!.id, ownerGroupId: hampstead!.id, name: 'London Hampstead', code: 'LON', slug: 'london-hampstead', address: { line1: '27 Heath Street', city: 'London', postalCode: 'NW3 6TR', country: 'GB' }, country: 'GB', timeZone: 'Europe/London', currency: 'GBP', locale: 'en-GB', phone: '+44 20 7946 0270', hours: { summary: 'Mon–Sat 9am–6pm' }, geo: { lat: 51.5567, lng: -0.1781 } }),
    L({ regionId: emea!.id, ownerGroupId: iberia!.id, name: 'Madrid Salamanca', code: 'MAD', slug: 'madrid-salamanca', address: { line1: 'Calle de Serrano 41', city: 'Madrid', region: 'Madrid', postalCode: '28001', country: 'ES' }, country: 'ES', timeZone: 'Europe/Madrid', currency: 'EUR', locale: 'es', phone: '+34 910 555 041', hours: { summary: 'L–V 9:30–19:30 · S 10–14' }, geo: { lat: 40.4256, lng: -3.6869 } }),
    L({ regionId: emea!.id, ownerGroupId: gulf!.id, name: 'Dubai Marina', code: 'DXB', slug: 'dubai-marina', address: { line1: 'Marina Plaza, Office 1402', city: 'Dubai Marina', region: 'Dubai', country: 'AE' }, country: 'AE', timeZone: 'Asia/Dubai', currency: 'AED', locale: 'en-GB', phone: '+971 4 555 0142', hours: { summary: 'Sun–Fri 9am–7pm' }, geo: { lat: 25.0805, lng: 55.1403 } }),
    L({ regionId: apac!.id, ownerGroupId: harbour!.id, name: 'Sydney Paddington', code: 'SYD', slug: 'sydney-paddington', address: { line1: '312 Oxford St', city: 'Paddington', region: 'NSW', postalCode: '2021', country: 'AU' }, country: 'AU', timeZone: 'Australia/Sydney', currency: 'AUD', locale: 'en-GB', phone: '+61 2 5550 0312', hours: { summary: 'Mon–Sat 9am–5:30pm' }, geo: { lat: -33.8848, lng: 151.2262 } }),
  ]).returning();
  const by = Object.fromEntries(locs.map((l) => [l.code, l])) as Record<'TOR' | 'VAN' | 'LON' | 'MAD' | 'DXB' | 'SYD', typeof locs[number]>;

  await db.insert(t.realtyOffices).values([
    { organizationId: orgId, locationId: by.TOR.id, tier: 'standard', areaUnit: 'sqft', leadRouting: 'listing_agent', brokerageLicence: 'Keystone Midtown Inc., Brokerage (sample text — supplied by the business)', disclosures: [{ key: 'brokerage', label: 'Brokerage', text: 'Sample: Keystone Midtown Inc., Brokerage. Independently owned and operated.' }] },
    { organizationId: orgId, locationId: by.VAN.id, tier: 'managed', areaUnit: 'sqft', leadRouting: 'round_robin', brokerageLicence: 'Shoreline Realty Group Ltd. (sample)', disclosures: [] },
    { organizationId: orgId, locationId: by.LON.id, tier: 'flexible', areaUnit: 'sqft', leadRouting: 'listing_agent', brokerageLicence: null, disclosures: [{ key: 'redress', label: 'Redress scheme', text: 'Sample: member of a property redress scheme (details supplied by the business).' }] },
    { organizationId: orgId, locationId: by.MAD.id, tier: 'standard', areaUnit: 'sqm', leadRouting: 'listing_agent', brokerageLicence: null, disclosures: [{ key: 'registro', label: 'Registro', text: 'Muestra: datos registrales facilitados por la agencia.' }] },
    { organizationId: orgId, locationId: by.DXB.id, tier: 'managed', areaUnit: 'sqft', leadRouting: 'listing_agent', brokerageLicence: 'Sample ORN 00000 — supplied by the business', disclosures: [] },
    { organizationId: orgId, locationId: by.SYD.id, tier: 'flexible', areaUnit: 'sqm', leadRouting: 'round_robin', brokerageLicence: null, disclosures: [] },
  ]);

  // People: demo owner (org owner), an HQ admin, an office manager and two agents with accounts.
  const elena = await c.upsertUser('elena.vargas@demo.branchharbor.com', 'Elena Vargas', 'en');
  const marcus = await c.upsertUser('marcus.lee@demo.branchharbor.com', 'Marcus Lee', 'en');
  const nadia = await c.upsertUser('nadia.hassan@demo.branchharbor.com', 'Nadia Hassan', 'en');
  const james = await c.upsertUser('james.whitfield@demo.branchharbor.com', 'James Whitfield', 'en-GB');
  await db.insert(t.roleAssignments).values([
    { organizationId: orgId, userId: c.demo.id, role: 'org_owner', scopeKind: 'organization', scopeId: orgId },
    { organizationId: orgId, userId: elena.id, role: 'hq_admin', scopeKind: 'organization', scopeId: orgId },
    { organizationId: orgId, userId: marcus.id, role: 'location_manager', scopeKind: 'location', scopeId: by.TOR.id },
    { organizationId: orgId, userId: nadia.id, role: 'staff', scopeKind: 'location', scopeId: by.TOR.id },
    { organizationId: orgId, userId: james.id, role: 'staff', scopeKind: 'location', scopeId: by.LON.id },
  ]).onConflictDoNothing();
  await db.insert(t.subscriptions).values({ organizationId: orgId, plan: 'network', status: 'active', billedLocationCount: 6, currency: 'CAD' });

  const A = (loc: keyof typeof by, name: string, o: Partial<typeof t.realtyAgents.$inferInsert> = {}) => ({
    organizationId: orgId, locationId: by[loc].id, name, title: 'Sales representative', availability: WEEKDAYS('09:00', '18:00'), languages: ['en'], ...o,
  });
  const agents = await db.insert(t.realtyAgents).values([
    A('TOR', 'Nadia Hassan', { userId: nadia.id, email: nadia.email, phone: '+1 416 555 0131', photoUrl: PEOPLE.w5, licenceNumber: 'Sample #4471023', languages: ['en', 'ar', 'fr'], bio: 'Midtown and North York specialist.', availability: WEEKDAYS('08:00', '20:00', [0, 1, 2, 3, 4, 5, 6]) }),
    A('TOR', 'Daniel Okafor', { phone: '+1 416 555 0132', photoUrl: PEOPLE.m2, licenceNumber: 'Sample #4471088' }),
    A('TOR', 'Priscilla Tan', { phone: '+1 416 555 0133', photoUrl: PEOPLE.w2, title: 'Broker', languages: ['en', 'zh'] }),
    A('VAN', 'Ryan McAllister', { phone: '+1 604 555 0181', photoUrl: PEOPLE.m3 }),
    A('VAN', 'Sofia Lindqvist', { phone: '+1 604 555 0182', photoUrl: PEOPLE.w4, languages: ['en', 'sv'] }),
    A('LON', 'James Whitfield', { userId: james.id, email: james.email, phone: '+44 20 7946 0281', photoUrl: PEOPLE.m1, title: 'Senior negotiator', availability: WEEKDAYS('09:00', '18:00', [1, 2, 3, 4, 5, 6]) }),
    A('LON', 'Amara Okoye', { phone: '+44 20 7946 0282', photoUrl: PEOPLE.w3, title: 'Lettings negotiator' }),
    A('MAD', 'Lucía Romero', { phone: '+34 910 555 042', photoUrl: PEOPLE.w1, title: 'Agente inmobiliaria', languages: ['es', 'en'] }),
    A('MAD', 'Javier Molina', { phone: '+34 910 555 043', photoUrl: PEOPLE.m4, title: 'Agente inmobiliario', languages: ['es', 'en', 'fr'] }),
    A('DXB', 'Omar Al Mansoori', { phone: '+971 4 555 0151', photoUrl: PEOPLE.m3, title: 'Property consultant', languages: ['en', 'ar'], availability: WEEKDAYS('09:00', '19:00', [0, 1, 2, 3, 4, 5]) }),
    A('DXB', 'Hannah Pereira', { phone: '+971 4 555 0152', photoUrl: PEOPLE.w2, title: 'Property consultant', languages: ['en', 'pt'], availability: WEEKDAYS('09:00', '19:00', [0, 1, 2, 3, 4, 5]) }),
    A('SYD', 'Chloe Nguyen', { phone: '+61 2 5550 0321', photoUrl: PEOPLE.w4, languages: ['en', 'vi'] }),
    A('SYD', 'Liam Gallagher', { phone: '+61 2 5550 0322', photoUrl: PEOPLE.m2 }),
  ]).returning();
  const ag = Object.fromEntries(agents.map((a) => [a.name.split(' ')[0]!.toLowerCase(), a]));

  const vendors = await db.insert(t.realtyContacts).values([
    { organizationId: orgId, locationId: by.TOR.id, kind: 'vendor', name: 'Margaret & Paul Lindsay', email: 'lindsay.vendor@example.com', phone: '+1 416 555 0190', ownerAgentId: ag.nadia!.id },
    { organizationId: orgId, locationId: by.TOR.id, kind: 'landlord', name: 'Yonge Eglinton Holdings', email: 'landlord@example.com', ownerAgentId: ag.daniel!.id },
    { organizationId: orgId, locationId: by.LON.id, kind: 'vendor', name: 'Dr Helen Marsh', email: 'h.marsh@example.com', ownerAgentId: ag.james!.id },
    { organizationId: orgId, locationId: by.MAD.id, kind: 'vendor', name: 'Familia Ortega Ruiz', email: 'ortega.ruiz@example.com', ownerAgentId: ag['lucía']!.id },
  ]).returning();

  const days = (n: number) => new Date(Date.now() - n * 86400_000);
  type LI = typeof t.realtyListings.$inferInsert;
  const sale = (loc: keyof typeof by, ref: string, o: Omit<LI, 'organizationId' | 'locationId' | 'reference' | 'transaction' | 'currency' | 'country' | 'addressLine1' | 'city'> & { addressLine1: string; city: string }) =>
    ({ organizationId: orgId, locationId: by[loc].id, reference: ref, transaction: 'sale', currency: by[loc].currency, country: by[loc].country, ...o }) as LI;
  const rent = (loc: keyof typeof by, ref: string, o: Parameters<typeof sale>[2]) => ({ ...sale(loc, ref, o), transaction: 'rent', rentPeriod: 'month' }) as LI;
  const sq = (v: number, unit: 'sqft' | 'sqm') => Math.round(toSqm(v, unit) * 100) / 100;
  const live = (dom: number) => ({ status: 'active', firstActiveAt: days(dom), publishedAt: days(dom) });

  const listingRows: LI[] = [
    // Toronto (CAD, sq ft)
    sale('TOR', 'TOR-0001', { title: 'Detached family-sized home on Birchmount Crescent', description: 'Four-bedroom detached house with a renovated kitchen, finished basement and a private rear garden. Two-car driveway.', propertyType: 'house', addressLine1: '42 Birchmount Cres', city: 'Toronto', region: 'ON', postalCode: 'M1N 1A1', priceMinor: 1_649_000_00, bedrooms: 4, bathrooms: 3, areaSqm: sq(2350, 'sqft'), lotSqm: sq(4500, 'sqft'), yearBuilt: 1962, features: ['Finished basement', 'Renovated kitchen', 'Private garden', 'Two-car driveway'], photos: [{ url: IMG.house, alt: 'Front of the house' }, { url: IMG.kitchen, alt: 'Kitchen' }, { url: IMG.living, alt: 'Living room' }], floorPlans: [{ url: IMG.living2, caption: 'Main floor (sample image)' }], vendorContactId: vendors[0]!.id, ...live(18), approvalStatus: 'approved' }),
    sale('TOR', 'TOR-0002', { title: 'Corner suite 1806 with lake views', description: 'Two-bedroom corner condominium on the 18th floor with floor-to-ceiling windows, balcony and one parking space.', propertyType: 'condo', addressLine1: '88 Harbour St', addressLine2: 'Unit 1806', city: 'Toronto', region: 'ON', postalCode: 'M5J 0C3', priceMinor: 925_000_00, bedrooms: 2, bathrooms: 2, areaSqm: sq(910, 'sqft'), yearBuilt: 2019, features: ['Balcony', 'Concierge', 'Parking included', 'Gym'], photos: [{ url: IMG.apt }, { url: IMG.bedroom }, { url: IMG.bath }], virtualTourUrl: 'https://tours.example.com/keystone/tor-0002', ...live(9), approvalStatus: 'approved' }),
    sale('TOR', 'TOR-0003', { title: 'Semi-detached on Maple Grove Avenue', description: 'Three-bedroom semi-detached home with a new roof (2024) and a detached garage.', propertyType: 'house', addressLine1: '9 Maple Grove Ave', city: 'Toronto', region: 'ON', postalCode: 'M4E 2V5', priceMinor: 1_189_000_00, bedrooms: 3, bathrooms: 2, areaSqm: sq(1650, 'sqft'), yearBuilt: 1928, features: ['Detached garage', 'New roof (2024)'], photos: [{ url: IMG.house2 }, { url: IMG.living2 }], status: 'under_offer', firstActiveAt: days(31), publishedAt: days(31), approvalStatus: 'approved' }),
    rent('TOR', 'TOR-0004', { title: 'One-bedroom apartment near Eglinton station', description: 'Bright one-bedroom apartment with in-suite laundry, five minutes on foot from Eglinton station.', propertyType: 'apartment', addressLine1: '2181 Yonge St', addressLine2: 'Unit 905', city: 'Toronto', region: 'ON', postalCode: 'M4S 3H7', priceMinor: 2_650_00, bedrooms: 1, bathrooms: 1, areaSqm: sq(620, 'sqft'), features: ['In-suite laundry', 'Locker'], photos: [{ url: IMG.living }], vendorContactId: vendors[1]!.id, ...live(6), approvalStatus: 'approved' }),
    sale('TOR', 'TOR-0005', { title: 'Townhouse with rooftop terrace', description: 'Three-storey townhouse with a rooftop terrace and an integral garage.', propertyType: 'townhouse', addressLine1: '17 Merton St', city: 'Toronto', region: 'ON', postalCode: 'M4S 1A1', priceMinor: 1_349_000_00, bedrooms: 3, bathrooms: 3, areaSqm: sq(1780, 'sqft'), features: ['Rooftop terrace', 'Integral garage'], photos: [{ url: IMG.terrace }], status: 'draft', approvalStatus: 'pending', requestedStatus: 'active', approvalRequestedBy: nadia.id, approvalComment: 'Photos approved by the vendor' }),
    sale('TOR', 'TOR-0006', { title: 'Bungalow on Glenview Avenue', description: 'Three-bedroom bungalow on a 50 ft lot.', propertyType: 'house', addressLine1: '58 Glenview Ave', city: 'Toronto', region: 'ON', postalCode: 'M4R 1P6', priceMinor: 1_420_000_00, closedPriceMinor: 1_455_000_00, bedrooms: 3, bathrooms: 2, areaSqm: sq(1500, 'sqft'), photos: [{ url: IMG.house }], status: 'sold', firstActiveAt: days(70), publishedAt: days(70), closedAt: days(41), approvalStatus: 'approved' }),
    // Vancouver (CAD, sq ft, managed)
    sale('VAN', 'VAN-0001', { title: 'West-coast contemporary with mountain views', description: 'Four-bedroom contemporary home with vaulted ceilings, a covered deck and a pool.', propertyType: 'house', addressLine1: '3120 Edgemont Blvd', city: 'North Vancouver', region: 'BC', postalCode: 'V7R 2N8', priceMinor: 2_890_000_00, bedrooms: 4, bathrooms: 4, areaSqm: sq(3400, 'sqft'), features: ['Pool', 'Covered deck', 'Vaulted ceilings'], photos: [{ url: IMG.pool }, { url: IMG.modern }], ...live(23), approvalStatus: 'approved' }),
    sale('VAN', 'VAN-0002', { title: 'Lonsdale Quay two-bedroom condo', description: 'Two-bedroom condominium two blocks from the SeaBus.', propertyType: 'condo', addressLine1: '155 Victory Ship Way', addressLine2: '1203', city: 'North Vancouver', region: 'BC', postalCode: 'V7L 0B2', priceMinor: 1_049_000_00, bedrooms: 2, bathrooms: 2, areaSqm: sq(960, 'sqft'), photos: [{ url: IMG.tower }], status: 'coming_soon', publishedAt: days(2), approvalStatus: 'approved' }),
    sale('VAN', 'VAN-0003', { title: 'Upper Lonsdale family home', description: 'Five-bedroom home with a legal suite.', propertyType: 'house', addressLine1: '2245 St Georges Ave', city: 'North Vancouver', region: 'BC', postalCode: 'V7L 3J9', priceMinor: 2_150_000_00, closedPriceMinor: 2_100_000_00, bedrooms: 5, bathrooms: 4, areaSqm: sq(2900, 'sqft'), photos: [{ url: IMG.house2 }], status: 'sold', firstActiveAt: days(60), publishedAt: days(60), closedAt: days(12), approvalStatus: 'approved' }),
    // London (GBP, sq ft, flexible)
    sale('LON', 'LON-0001', { title: 'Victorian terrace on Flask Walk', description: 'Three-bedroom Victorian terraced house with a south-facing garden and original fireplaces.', propertyType: 'house', addressLine1: '14 Flask Walk', city: 'London', postalCode: 'NW3 1HE', priceMinor: 2_450_000_00, bedrooms: 3, bathrooms: 2, areaSqm: sq(1640, 'sqft'), features: ['Garden', 'Original fireplaces', 'Cellar'], photos: [{ url: IMG.house2 }, { url: IMG.living2 }], disclosures: [{ key: 'tenure', label: 'Tenure', text: 'Sample: Freehold' }, { key: 'council_tax', label: 'Council tax band', text: 'Sample: G' }, { key: 'epc', label: 'EPC rating', text: 'Sample: D' }], vendorContactId: vendors[2]!.id, ...live(27), approvalStatus: 'not_required' }),
    rent('LON', 'LON-0002', { title: 'Two-bedroom flat in a mansion block', description: 'Two-bedroom first-floor flat with high ceilings, close to Hampstead Heath.', propertyType: 'apartment', addressLine1: '5 Belsize Park Gardens', addressLine2: 'Flat 3', city: 'London', postalCode: 'NW3 4LB', priceMinor: 3_250_00, bedrooms: 2, bathrooms: 1, areaSqm: sq(850, 'sqft'), photos: [{ url: IMG.apt }], disclosures: [{ key: 'council_tax', label: 'Council tax band', text: 'Sample: E' }, { key: 'deposit', label: 'Deposit', text: 'Sample: five weeks’ rent' }], ...live(4), approvalStatus: 'not_required' }),
    rent('LON', 'LON-0003', { title: 'Studio flat on Heath Street', description: 'Studio flat with a separate kitchen.', propertyType: 'apartment', addressLine1: '40 Heath St', city: 'London', postalCode: 'NW3 6TE', priceMinor: 1_750_00, bedrooms: 0, bathrooms: 1, areaSqm: sq(410, 'sqft'), photos: [{ url: IMG.bedroom }], status: 'let', firstActiveAt: days(35), publishedAt: days(35), closedAt: days(20), closedPriceMinor: 1_750_00, approvalStatus: 'not_required' }),
    // Madrid (EUR, m²)
    sale('MAD', 'MAD-0001', { title: 'Piso exterior en el barrio de Salamanca', description: 'Piso exterior de tres dormitorios con balcones a la calle, ascensor y portero.', propertyType: 'apartment', addressLine1: 'Calle de Velázquez 58', addressLine2: '3º Izq.', city: 'Madrid', region: 'Madrid', postalCode: '28001', priceMinor: 1_150_000_00, bedrooms: 3, bathrooms: 2, areaSqm: 142, yearBuilt: 1950, features: ['Ascensor', 'Portero', 'Balcones'], photos: [{ url: IMG.living2 }, { url: IMG.kitchen }], disclosures: [{ key: 'energy', label: 'Certificado energético', text: 'Muestra: E (facilitado por la agencia)' }], vendorContactId: vendors[3]!.id, ...live(14), approvalStatus: 'approved' }),
    sale('MAD', 'MAD-0002', { title: 'Ático con terraza en Chamberí', description: 'Ático de dos dormitorios con terraza de 30 m².', propertyType: 'apartment', addressLine1: 'Calle de Eloy Gonzalo 12', city: 'Madrid', region: 'Madrid', postalCode: '28010', priceMinor: 795_000_00, bedrooms: 2, bathrooms: 2, areaSqm: 96, lotSqm: 30, features: ['Terraza'], photos: [{ url: IMG.terrace }], status: 'withdrawn', firstActiveAt: days(90), publishedAt: days(90), withdrawnAt: days(50), approvalStatus: 'approved' }),
    rent('MAD', 'MAD-0003', { title: 'Apartamento amueblado junto al Retiro', description: 'Apartamento de un dormitorio amueblado, a cinco minutos del Retiro.', propertyType: 'apartment', addressLine1: 'Calle de Alcalá 98', city: 'Madrid', region: 'Madrid', postalCode: '28009', priceMinor: 1_600_00, bedrooms: 1, bathrooms: 1, areaSqm: 58, photos: [{ url: IMG.apt }], ...live(3), approvalStatus: 'approved' }),
    // Dubai (AED, sq ft, managed)
    sale('DXB', 'DXB-0001', { title: 'Marina-view two-bedroom apartment', description: 'Two-bedroom apartment with a balcony overlooking the marina, covered parking and access to a shared pool.', propertyType: 'apartment', addressLine1: 'Marina Gate 1, Unit 2304', city: 'Dubai Marina', region: 'Dubai', priceMinor: 3_200_000_00, bedrooms: 2, bathrooms: 3, areaSqm: sq(1420, 'sqft'), features: ['Balcony', 'Shared pool', 'Covered parking'], photos: [{ url: IMG.tower }, { url: IMG.pool }], disclosures: [{ key: 'permit', label: 'Advertising permit', text: 'Sample permit number — supplied by the business' }], hideStreet: true, ...live(11), approvalStatus: 'approved' }),
    rent('DXB', 'DXB-0002', { title: 'Furnished one-bedroom in JBR', description: 'Furnished one-bedroom apartment with beach access.', propertyType: 'apartment', addressLine1: 'Rimal 4, Unit 1508', city: 'Dubai Marina', region: 'Dubai', priceMinor: 11_500_00, bedrooms: 1, bathrooms: 2, areaSqm: sq(880, 'sqft'), photos: [{ url: IMG.living }], hideStreet: true, status: 'draft', approvalStatus: 'not_required' }),
    // Sydney (AUD, m², flexible)
    sale('SYD', 'SYD-0001', { title: 'Paddington terrace with courtyard', description: 'Two-bedroom Victorian terrace with a rear courtyard and rear-lane access.', propertyType: 'townhouse', addressLine1: '21 Glenmore Rd', city: 'Paddington', region: 'NSW', postalCode: '2021', priceMinor: 2_350_000_00, bedrooms: 2, bathrooms: 1, areaSqm: 118, lotSqm: 120, features: ['Courtyard', 'Rear-lane access'], photos: [{ url: IMG.house }, { url: IMG.living }], ...live(21), approvalStatus: 'not_required' }),
    sale('SYD', 'SYD-0002', { title: 'Woollahra family home', description: 'Four-bedroom freestanding home with a pool.', propertyType: 'house', addressLine1: '8 Queen St', city: 'Woollahra', region: 'NSW', postalCode: '2025', priceMinor: 4_100_000_00, closedPriceMinor: 4_250_000_00, bedrooms: 4, bathrooms: 3, areaSqm: 265, photos: [{ url: IMG.pool }], status: 'sold', firstActiveAt: days(45), publishedAt: days(45), closedAt: days(8), approvalStatus: 'not_required' }),
    rent('SYD', 'SYD-0003', { title: 'Light-filled apartment near Five Ways', description: 'Two-bedroom apartment with a balcony and a lock-up garage.', propertyType: 'apartment', addressLine1: '2 Heeley St', addressLine2: 'Unit 6', city: 'Paddington', region: 'NSW', postalCode: '2021', priceMinor: 950_00, rentPeriod: 'week', bedrooms: 2, bathrooms: 1, areaSqm: 84, photos: [{ url: IMG.living2 }], ...live(5), approvalStatus: 'not_required' }),
  ];
  const listings = await db.insert(t.realtyListings).values(listingRows.map((l) => ({ ...l, createdBy: c.demo.id }))).returning();
  const L$ = Object.fromEntries(listings.map((l) => [l.reference, l])) as Record<string, typeof listings[number]>;
  const leadFor: Record<string, string[]> = {
    'TOR-0001': ['nadia', 'priscilla'], 'TOR-0002': ['nadia'], 'TOR-0003': ['daniel'], 'TOR-0004': ['daniel', 'nadia'], 'TOR-0005': ['nadia'], 'TOR-0006': ['priscilla'],
    'VAN-0001': ['ryan', 'sofia'], 'VAN-0002': ['sofia'], 'VAN-0003': ['ryan'], 'LON-0001': ['james'], 'LON-0002': ['amara', 'james'], 'LON-0003': ['amara'],
    'MAD-0001': ['lucía'], 'MAD-0002': ['javier'], 'MAD-0003': ['javier', 'lucía'], 'DXB-0001': ['omar', 'hannah'], 'DXB-0002': ['hannah'], 'SYD-0001': ['chloe'], 'SYD-0002': ['liam'], 'SYD-0003': ['chloe', 'liam'],
  };
  await db.insert(t.realtyListingAgents).values(Object.entries(leadFor).flatMap(([ref, names]) => names.map((n, i) => ({ organizationId: orgId, listingId: L$[ref]!.id, agentId: ag[n]!.id, role: i === 0 ? 'lead' : 'co' }))));
  await db.insert(t.realtyListingHistory).values(listings.flatMap((l) => {
    const h: Array<typeof t.realtyListingHistory.$inferInsert> = [{ organizationId: orgId, listingId: l.id, fromStatus: null, toStatus: 'draft', at: days(100) }];
    if (l.firstActiveAt) h.push({ organizationId: orgId, listingId: l.id, fromStatus: 'draft', toStatus: 'active', at: l.firstActiveAt });
    if (l.status === 'coming_soon') h.push({ organizationId: orgId, listingId: l.id, fromStatus: 'draft', toStatus: 'coming_soon', at: l.publishedAt ?? new Date() });
    if (['under_offer', 'sold'].includes(l.status)) h.push({ organizationId: orgId, listingId: l.id, fromStatus: 'active', toStatus: 'under_offer', at: l.closedAt ? new Date(l.closedAt.getTime() - 7 * 86400_000) : days(3) });
    if (l.status === 'sold' || l.status === 'let') h.push({ organizationId: orgId, listingId: l.id, fromStatus: l.status === 'sold' ? 'under_offer' : 'active', toStatus: l.status, at: l.closedAt! });
    if (l.status === 'withdrawn') h.push({ organizationId: orgId, listingId: l.id, fromStatus: 'active', toStatus: 'withdrawn', at: l.withdrawnAt! });
    return h;
  }));

  // Open houses (local time).
  const local = (loc: keyof typeof by, date: string, time: string) => zonedToUtc(date, time, by[loc].timeZone);
  const sat = (() => { for (let i = 1; i <= 7; i++) { const d = addDays(today, i); if (new Date(`${d}T12:00:00Z`).getUTCDay() === 6) return d; } return addDays(today, 3); })();
  await db.insert(t.realtyOpenHouses).values([
    { organizationId: orgId, locationId: by.TOR.id, listingId: L$['TOR-0001']!.id, agentId: ag.nadia!.id, startsAt: local('TOR', sat, '11:00'), endsAt: local('TOR', sat, '13:00'), rsvps: 14 },
    { organizationId: orgId, locationId: by.SYD.id, listingId: L$['SYD-0001']!.id, agentId: ag.chloe!.id, startsAt: local('SYD', sat, '10:00'), endsAt: local('SYD', sat, '10:45'), rsvps: 6 },
  ]);

  // Enquiries.
  type EI = typeof t.realtyEnquiries.$inferInsert;
  const E = (loc: keyof typeof by, o: Omit<EI, 'organizationId' | 'locationId'>) => ({ organizationId: orgId, locationId: by[loc].id, ...o }) as EI;
  const enquiries = await db.insert(t.realtyEnquiries).values([
    E('TOR', { listingId: L$['TOR-0001']!.id, source: 'website', kind: 'buyer', name: 'Aaron Patel', email: 'aaron.patel@example.com', phone: '+1 647 555 0101', message: 'Is the basement legal for a second unit?', assignedAgentId: ag.nadia!.id, routedBy: 'listing_agent', status: 'new', createdAt: new Date(Date.now() - 2 * 3600_000) }),
    E('TOR', { listingId: L$['TOR-0001']!.id, source: 'portal_realtor_ca', externalRef: 'rc-88231', kind: 'buyer', name: 'Omar & Sara Haddad', email: 'haddad@example.com', message: 'We would like to see it this weekend.', assignedAgentId: ag.nadia!.id, routedBy: 'listing_agent', status: 'viewing_booked', createdAt: days(5) }),
    E('TOR', { source: 'website', kind: 'valuation', name: 'Lena Fischer', email: 'lena.fischer@example.com', message: 'Thinking of selling next spring — can you value our townhouse?', assignedAgentId: null, routedBy: 'office_pool', status: 'new', createdAt: new Date(Date.now() - 5 * 3600_000) }),
    E('TOR', { listingId: L$['TOR-0002']!.id, source: 'mobile', kind: 'buyer', name: 'Grace Liu', email: 'grace.liu@example.com', assignedAgentId: ag.nadia!.id, routedBy: 'listing_agent', status: 'contacted', firstResponseAt: days(2), createdAt: days(3) }),
    E('TOR', { listingId: L$['TOR-0004']!.id, source: 'website', kind: 'tenant', name: 'Mateo Silva', email: 'mateo.silva@example.com', assignedAgentId: ag.daniel!.id, routedBy: 'listing_agent', status: 'viewing_booked', createdAt: days(4) }),
    E('TOR', { listingId: L$['TOR-0003']!.id, source: 'phone', kind: 'buyer', name: 'Benjamin Cho', phone: '+1 416 555 0177', assignedAgentId: ag.daniel!.id, routedBy: 'listing_agent', status: 'offer_made', createdAt: days(20) }),
    E('VAN', { listingId: L$['VAN-0001']!.id, source: 'website', kind: 'buyer', name: 'Harper Wilson', email: 'harper.w@example.com', assignedAgentId: ag.ryan!.id, routedBy: 'listing_agent', status: 'contacted', createdAt: days(6) }),
    E('VAN', { source: 'website', kind: 'valuation', name: 'Ethan Brooks', email: 'ethan.brooks@example.com', assignedAgentId: ag.sofia!.id, routedBy: 'round_robin', status: 'new', createdAt: days(1) }),
    E('LON', { listingId: L$['LON-0001']!.id, source: 'portal_rightmove', externalRef: 'rm-55120', kind: 'buyer', name: 'Charlotte Evans', email: 'c.evans@example.com', assignedAgentId: ag.james!.id, routedBy: 'listing_agent', status: 'viewing_booked', createdAt: days(8) }),
    E('LON', { listingId: L$['LON-0002']!.id, source: 'website', kind: 'tenant', name: 'Tomás Herrera', email: 'tomas.h@example.com', assignedAgentId: ag.amara!.id, routedBy: 'listing_agent', status: 'new', createdAt: new Date(Date.now() - 26 * 3600_000) }),
    E('MAD', { listingId: L$['MAD-0001']!.id, source: 'portal_idealista', externalRef: 'id-77310', kind: 'buyer', name: 'Carmen Díaz', email: 'carmen.diaz@example.com', assignedAgentId: ag['lucía']!.id, routedBy: 'listing_agent', status: 'viewing_booked', createdAt: days(7) }),
    E('MAD', { listingId: L$['MAD-0003']!.id, source: 'website', kind: 'tenant', name: 'Pierre Laurent', email: 'p.laurent@example.com', assignedAgentId: ag.javier!.id, routedBy: 'listing_agent', status: 'new', createdAt: days(1) }),
    E('DXB', { listingId: L$['DXB-0001']!.id, source: 'website', kind: 'buyer', name: 'Rahul Mehta', email: 'rahul.m@example.com', assignedAgentId: ag.omar!.id, routedBy: 'listing_agent', status: 'contacted', firstResponseAt: days(1), createdAt: days(2) }),
    E('SYD', { listingId: L$['SYD-0001']!.id, source: 'website', kind: 'buyer', name: 'Isla Thompson', email: 'isla.t@example.com', assignedAgentId: ag.chloe!.id, routedBy: 'listing_agent', status: 'viewing_booked', createdAt: days(9) }),
    E('SYD', { source: 'walk_in', kind: 'general', name: 'Noah Williams', assignedAgentId: ag.liam!.id, routedBy: 'round_robin', status: 'closed', createdAt: days(15) }),
  ]).returning();
  const enqBy = (name: string) => enquiries.find((e) => e.name === name)!;

  // Viewings: today for Nadia (Toronto local time), upcoming, and completed with feedback.
  const torToday = localDateParts(new Date(), by.TOR.timeZone).date;
  const V = (loc: keyof typeof by, listingRef: string, agent: string, startsAt: Date, o: Partial<typeof t.realtyViewings.$inferInsert>) => ({
    organizationId: orgId, locationId: by[loc].id, listingId: L$[listingRef]!.id, agentId: ag[agent]!.id, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    contactName: 'Buyer', manageTokenHash: sha256(`seed-viewing-${listingRef}-${startsAt.toISOString()}`), ...o,
  });
  const nowLocalHour = Number(localDateParts(new Date(), by.TOR.timeZone).time.slice(0, 2));
  const laterToday = (h: number) => zonedToUtc(torToday, `${String(Math.min(21, Math.max(nowLocalHour + h, 9))).padStart(2, '0')}:00`, by.TOR.timeZone);
  await db.insert(t.realtyViewings).values([
    V('TOR', 'TOR-0001', 'nadia', laterToday(1), { contactName: 'Omar & Sara Haddad', contactEmail: 'haddad@example.com', enquiryId: enqBy('Omar & Sara Haddad').id, status: 'confirmed', confirmedAt: days(1), source: 'website' }),
    V('TOR', 'TOR-0002', 'nadia', laterToday(2), { contactName: 'Grace Liu', contactEmail: 'grace.liu@example.com', enquiryId: enqBy('Grace Liu').id, status: 'requested', source: 'mobile' }),
    V('TOR', 'TOR-0001', 'nadia', zonedToUtc(addDays(torToday, -3), '17:00', by.TOR.timeZone), { contactName: 'Benjamin Cho', status: 'completed', interestLevel: 'medium', feedbackRating: 4, feedbackNotes: 'Liked the kitchen and garden; concerned about the basement ceiling height.', feedbackAt: days(3) }),
    V('TOR', 'TOR-0001', 'priscilla', zonedToUtc(addDays(torToday, -2), '11:00', by.TOR.timeZone), { contactName: 'Aisha Rahman', status: 'completed', interestLevel: 'high', feedbackRating: 5, feedbackNotes: 'Wants to bring a contractor for a second visit. Asked about closing dates.', feedbackAt: days(2) }),
    V('TOR', 'TOR-0001', 'nadia', zonedToUtc(addDays(torToday, -1), '18:30', by.TOR.timeZone), { contactName: 'Victor Hale', status: 'no_show', feedbackAt: days(1) }),
    V('TOR', 'TOR-0004', 'daniel', zonedToUtc(addDays(torToday, 1), '17:30', by.TOR.timeZone), { contactName: 'Mateo Silva', contactEmail: 'mateo.silva@example.com', enquiryId: enqBy('Mateo Silva').id, status: 'confirmed', confirmedAt: days(1) }),
    V('LON', 'LON-0001', 'james', zonedToUtc(addDays(localDateParts(new Date(), by.LON.timeZone).date, 1), '10:30', by.LON.timeZone), { contactName: 'Charlotte Evans', contactEmail: 'c.evans@example.com', enquiryId: enqBy('Charlotte Evans').id, status: 'confirmed', confirmedAt: days(2) }),
    V('LON', 'LON-0001', 'james', zonedToUtc(addDays(localDateParts(new Date(), by.LON.timeZone).date, -4), '12:00', by.LON.timeZone), { contactName: 'Marcus Webb', status: 'completed', interestLevel: 'low', feedbackRating: 3, feedbackNotes: 'Garden smaller than expected.', feedbackAt: days(4) }),
    V('MAD', 'MAD-0001', 'lucía', zonedToUtc(addDays(localDateParts(new Date(), by.MAD.timeZone).date, 2), '12:00', by.MAD.timeZone), { contactName: 'Carmen Díaz', contactEmail: 'carmen.diaz@example.com', enquiryId: enqBy('Carmen Díaz').id, status: 'confirmed', confirmedAt: days(1) }),
    V('SYD', 'SYD-0001', 'chloe', zonedToUtc(addDays(localDateParts(new Date(), by.SYD.timeZone).date, -1), '14:00', by.SYD.timeZone), { contactName: 'Isla Thompson', contactEmail: 'isla.t@example.com', enquiryId: enqBy('Isla Thompson').id, status: 'completed', interestLevel: 'high', feedbackRating: 5, feedbackNotes: 'Loved the courtyard; preparing finance.', feedbackAt: days(1) }),
  ]);

  // Offers: one in negotiation (countered) on TOR-0001, an accepted offer on TOR-0003 (under offer).
  const buyer = await db.insert(t.realtyContacts).values([
    { organizationId: orgId, locationId: by.TOR.id, kind: 'buyer', name: 'Aisha Rahman', email: 'aisha.rahman@example.com', ownerAgentId: ag.priscilla!.id },
    { organizationId: orgId, locationId: by.TOR.id, kind: 'buyer', name: 'Benjamin Cho', phone: '+1 416 555 0177', ownerAgentId: ag.daniel!.id },
  ]).returning();
  const [negotiating] = await db.insert(t.realtyOffers).values({ organizationId: orgId, locationId: by.TOR.id, listingId: L$['TOR-0001']!.id, buyerName: 'Aisha Rahman', buyerContactId: buyer[0]!.id, submittedByAgentId: ag.priscilla!.id, amountMinor: 1_625_000_00, currency: 'CAD', depositMinor: 75_000_00, conditions: ['Financing within 5 business days', 'Home inspection'], expiresAt: new Date(Date.now() + 2 * 86400_000), status: 'countered', createdBy: c.demo.id, createdAt: days(1) }).returning();
  await db.insert(t.realtyOfferEvents).values([
    { organizationId: orgId, offerId: negotiating!.id, action: 'submitted', party: 'buyer', amountMinor: 1_595_000_00, currency: 'CAD', conditions: ['Financing within 5 business days', 'Home inspection'], at: days(1) },
    { organizationId: orgId, offerId: negotiating!.id, action: 'countered', party: 'vendor', amountMinor: 1_625_000_00, currency: 'CAD', note: 'Vendor counter; conditions accepted', at: new Date(Date.now() - 6 * 3600_000) },
  ]);
  const [accepted] = await db.insert(t.realtyOffers).values({ organizationId: orgId, locationId: by.TOR.id, listingId: L$['TOR-0003']!.id, buyerName: 'Benjamin Cho', buyerContactId: buyer[1]!.id, enquiryId: enqBy('Benjamin Cho').id, submittedByAgentId: ag.daniel!.id, amountMinor: 1_175_000_00, currency: 'CAD', conditions: ['Firm'], status: 'accepted', createdBy: c.demo.id, createdAt: days(4) }).returning();
  await db.insert(t.realtyOfferEvents).values([
    { organizationId: orgId, offerId: accepted!.id, action: 'submitted', party: 'buyer', amountMinor: 1_175_000_00, currency: 'CAD', conditions: ['Firm'], at: days(4) },
    { organizationId: orgId, offerId: accepted!.id, action: 'accepted', party: 'vendor', at: days(3) },
  ]);

  // Syndication opt-ins (sandbox) and a consented saved search.
  await db.insert(t.realtySyndication).values([
    { organizationId: orgId, listingId: L$['TOR-0001']!.id, portal: 'realtor_ca_style', optedIn: true },
    { organizationId: orgId, listingId: L$['TOR-0002']!.id, portal: 'realtor_ca_style', optedIn: true },
    { organizationId: orgId, listingId: L$['LON-0001']!.id, portal: 'rightmove_style', optedIn: true },
    { organizationId: orgId, listingId: L$['MAD-0001']!.id, portal: 'idealista_style', optedIn: true },
  ]);
  await db.insert(t.realtySavedSearches).values({ organizationId: orgId, email: 'buyer.alerts@example.com', name: '3 bed in Toronto under $1.7M', criteria: { transaction: 'sale', minBedrooms: 3, maxPrice: 1_700_000_00, currency: 'CAD', city: 'Toronto' }, frequency: 'weekly', alertsConsent: true, manageTokenHash: sha256('seed-saved-search'), lastAlertedAt: days(2) });
  await db.insert(t.consentRecords).values({ organizationId: orgId, email: 'buyer.alerts@example.com', purpose: 'realty_search_alerts', version: '2026-10', granted: true, source: 'seed' });

  void c.sitesBaseUrl;
  return { orgId, users: [elena.email, marcus.email, nadia.email, james.email], listings: listings.length, offices: locs.length };
}

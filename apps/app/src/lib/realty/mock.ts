/**
 * Sample Real Estate data (Keystone Realty Network) for sample mode and offline fallback. Stateful in memory and
 * enforces the same visibility rules as the API per persona: HQ = organisation owner (approves listings),
 * Location manager = Toronto office manager (all Toronto client data, no approval), Staff = Nadia Hassan (agent).
 */
import { allowedListingTransitions, areaIn, areaUnitLabel, findProtectedTargeting, formatAddressLines, listingTransition, tierRequiresApproval, toSqm, type ListingStatus as LS } from '@bh/shared';
import { ApiError } from '../errors';
import type { RealtyApi, RealtyCtx } from './api';
import type { Agent, AreaUnit, Enquiry, ListingDetail, ListingInput, Offer, OfferEvent, Office, OfficeReport, Portal, RealtyListing, Viewing } from './types';

const u = (id: string, w = 1200) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=70`;
const IMG = { house: u('1570129477492-45c003edd2be'), apt: u('1554995207-c18c203602cb'), pool: u('1564013799919-ab600027ffc6'), living: u('1560448204-e02f11c3d0e2'), living2: u('1600566753190-17f0baa2a6c3'), house2: u('1580587771525-78b9dba3b914'), modern: u('1600585154340-be6161a56a0c') };
const delay = (ms = 220) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const ago = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
const inH = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const forbid = (m = 'You do not have permission to do that in this scope') => new ApiError('forbidden', m, 403);
const conflict = (code: string, m: string) => new ApiError(code, m, 409);

const OFFICES: Office[] = [
  { locationId: 'tor', name: 'Toronto Midtown', city: 'Toronto', country: 'CA', currency: 'CAD', timeZone: 'America/Toronto', tier: 'standard', areaUnit: 'sqft', leadRouting: 'listing_agent', viewingMinutes: 30, viewingBufferMinutes: 15, disclosures: [{ key: 'brokerage', label: 'Brokerage', text: 'Sample: Keystone Midtown Inc., Brokerage.' }], brokerageLicence: 'Keystone Midtown Inc., Brokerage (sample)', agentCount: 3 },
  { locationId: 'van', name: 'North Vancouver', city: 'North Vancouver', country: 'CA', currency: 'CAD', timeZone: 'America/Vancouver', tier: 'managed', areaUnit: 'sqft', leadRouting: 'round_robin', viewingMinutes: 30, viewingBufferMinutes: 15, disclosures: [], brokerageLicence: null, agentCount: 2 },
  { locationId: 'lon', name: 'London Hampstead', city: 'London', country: 'GB', currency: 'GBP', timeZone: 'Europe/London', tier: 'flexible', areaUnit: 'sqft', leadRouting: 'listing_agent', viewingMinutes: 30, viewingBufferMinutes: 15, disclosures: [], brokerageLicence: null, agentCount: 2 },
  { locationId: 'mad', name: 'Madrid Salamanca', city: 'Madrid', country: 'ES', currency: 'EUR', timeZone: 'Europe/Madrid', tier: 'standard', areaUnit: 'sqm', leadRouting: 'listing_agent', viewingMinutes: 30, viewingBufferMinutes: 15, disclosures: [], brokerageLicence: null, agentCount: 2 },
  { locationId: 'dxb', name: 'Dubai Marina', city: 'Dubai Marina', country: 'AE', currency: 'AED', timeZone: 'Asia/Dubai', tier: 'managed', areaUnit: 'sqft', leadRouting: 'listing_agent', viewingMinutes: 45, viewingBufferMinutes: 15, disclosures: [], brokerageLicence: null, agentCount: 1 },
  { locationId: 'syd', name: 'Sydney Paddington', city: 'Paddington', country: 'AU', currency: 'AUD', timeZone: 'Australia/Sydney', tier: 'flexible', areaUnit: 'sqm', leadRouting: 'round_robin', viewingMinutes: 30, viewingBufferMinutes: 10, disclosures: [], brokerageLicence: null, agentCount: 1 },
];
const office = (id: string) => OFFICES.find((o) => o.locationId === id)!;

const week = (start = '09:00', end = '18:00') => [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start, end }));
const AGENTS: Agent[] = [
  ['ag_nadia', 'tor', 'Nadia Hassan', 'u_staff'], ['ag_daniel', 'tor', 'Daniel Okafor', null], ['ag_priscilla', 'tor', 'Priscilla Tan', null], ['ag_ryan', 'van', 'Ryan McAllister', null], ['ag_sofia', 'van', 'Sofia Lindqvist', null],
  ['ag_james', 'lon', 'James Whitfield', null], ['ag_amara', 'lon', 'Amara Okoye', null], ['ag_lucia', 'mad', 'Lucía Romero', null], ['ag_javier', 'mad', 'Javier Molina', null], ['ag_omar', 'dxb', 'Omar Al Mansoori', null], ['ag_chloe', 'syd', 'Chloe Nguyen', null],
].map(([id, loc, name, userId]) => ({ id: id!, locationId: loc!, userId: userId ?? null, name: name!, email: `${name!.split(' ')[0]!.toLowerCase()}@keystone-sample.com`, phone: null, title: 'Sales representative', licenceNumber: null, photoUrl: null, languages: ['en'], availability: week(), acceptsLeads: true, active: true, workload: { upcomingViewings: 0, openEnquiries: 0, liveListings: 0 } }));
const agentName = (id: string | null) => AGENTS.find((a) => a.id === id)?.name ?? null;

interface MockListing { id: string; locationId: string; reference: string; title: string; description: string; transaction: 'sale' | 'rent'; propertyType: string; status: LS; priceMinor: number; rentPeriod: string | null; bedrooms: number | null; bathrooms: number | null; areaSqm: number | null; features: string[]; line1: string; city: string; region: string | null; postalCode: string | null; photos: string[]; agents: [string, ...string[]]; firstActive: number | null; closedPriceMinor?: number; closedAgo?: number; approval: RealtyListing['approval']['status']; requestedStatus?: LS | null; requestedBy?: string | null; pendingChanges?: Record<string, unknown> | null; history: ListingDetail['history']; syndication: ListingDetail['syndication'] }
const ML = (o: Omit<MockListing, 'history' | 'syndication' | 'approval'> & Partial<Pick<MockListing, 'approval' | 'syndication'>>): MockListing => ({ approval: 'approved', syndication: [], history: [{ from: null, to: 'draft', at: ago(60), note: null }, ...(o.firstActive != null ? [{ from: 'draft', to: 'active', at: ago(o.firstActive), note: null }] : [])], ...o });
const sq = (ft: number) => toSqm(ft, 'sqft');
let LISTINGS: MockListing[] = [
  ML({ id: 'l1', locationId: 'tor', reference: 'TOR-0001', title: 'Detached family-sized home on Birchmount Crescent', description: 'Four-bedroom detached house with a renovated kitchen, finished basement and a private rear garden.', transaction: 'sale', propertyType: 'house', status: 'active', priceMinor: 1_649_000_00, rentPeriod: null, bedrooms: 4, bathrooms: 3, areaSqm: sq(2350), features: ['Finished basement', 'Renovated kitchen', 'Private garden'], line1: '42 Birchmount Cres', city: 'Toronto', region: 'ON', postalCode: 'M1N 1A1', photos: [IMG.house, IMG.living], agents: ['ag_nadia', 'ag_priscilla'], firstActive: 18, syndication: [{ portal: 'reso_xml', optedIn: true, lastStatus: 'sandbox_exported', lastIssues: [], lastExportedAt: ago(1) }] }),
  ML({ id: 'l2', locationId: 'tor', reference: 'TOR-0002', title: 'Corner suite 1806 with lake views', description: 'Two-bedroom corner condominium with floor-to-ceiling windows, balcony and one parking space.', transaction: 'sale', propertyType: 'condo', status: 'active', priceMinor: 925_000_00, rentPeriod: null, bedrooms: 2, bathrooms: 2, areaSqm: sq(910), features: ['Balcony', 'Concierge'], line1: '88 Harbour St, Unit 1806', city: 'Toronto', region: 'ON', postalCode: 'M5J 0C3', photos: [IMG.apt], agents: ['ag_nadia'], firstActive: 9 }),
  ML({ id: 'l3', locationId: 'tor', reference: 'TOR-0003', title: 'Semi-detached on Maple Grove Avenue', description: 'Three-bedroom semi-detached home with a new roof (2024) and a detached garage.', transaction: 'sale', propertyType: 'house', status: 'under_offer', priceMinor: 1_189_000_00, rentPeriod: null, bedrooms: 3, bathrooms: 2, areaSqm: sq(1650), features: ['Detached garage'], line1: '9 Maple Grove Ave', city: 'Toronto', region: 'ON', postalCode: 'M4E 2V5', photos: [IMG.house2], agents: ['ag_daniel'], firstActive: 31 }),
  ML({ id: 'l4', locationId: 'tor', reference: 'TOR-0005', title: 'Townhouse with rooftop terrace', description: 'Three-storey townhouse with a rooftop terrace and an integral garage.', transaction: 'sale', propertyType: 'townhouse', status: 'draft', priceMinor: 1_349_000_00, rentPeriod: null, bedrooms: 3, bathrooms: 3, areaSqm: sq(1780), features: ['Rooftop terrace'], line1: '17 Merton St', city: 'Toronto', region: 'ON', postalCode: 'M4S 1A1', photos: [IMG.modern], agents: ['ag_nadia'], firstActive: null, approval: 'pending', requestedStatus: 'active', requestedBy: 'u_staff' }),
  ML({ id: 'l5', locationId: 'tor', reference: 'TOR-0006', title: 'Bungalow on Glenview Avenue', description: 'Three-bedroom bungalow on a 50 ft lot.', transaction: 'sale', propertyType: 'house', status: 'sold', priceMinor: 1_420_000_00, closedPriceMinor: 1_455_000_00, closedAgo: 41, rentPeriod: null, bedrooms: 3, bathrooms: 2, areaSqm: sq(1500), features: [], line1: '58 Glenview Ave', city: 'Toronto', region: 'ON', postalCode: 'M4R 1P6', photos: [IMG.house], agents: ['ag_priscilla'], firstActive: 70 }),
  ML({ id: 'l6', locationId: 'van', reference: 'VAN-0001', title: 'West-coast contemporary with mountain views', description: 'Four-bedroom contemporary home with vaulted ceilings, a covered deck and a pool.', transaction: 'sale', propertyType: 'house', status: 'active', priceMinor: 2_890_000_00, rentPeriod: null, bedrooms: 4, bathrooms: 4, areaSqm: sq(3400), features: ['Pool'], line1: '3120 Edgemont Blvd', city: 'North Vancouver', region: 'BC', postalCode: 'V7R 2N8', photos: [IMG.pool], agents: ['ag_ryan', 'ag_sofia'], firstActive: 23 }),
  ML({ id: 'l7', locationId: 'van', reference: 'VAN-0003', title: 'Upper Lonsdale family home', description: 'Five-bedroom home with a legal suite.', transaction: 'sale', propertyType: 'house', status: 'sold', priceMinor: 2_150_000_00, closedPriceMinor: 2_100_000_00, closedAgo: 12, rentPeriod: null, bedrooms: 5, bathrooms: 4, areaSqm: sq(2900), features: [], line1: '2245 St Georges Ave', city: 'North Vancouver', region: 'BC', postalCode: 'V7L 3J9', photos: [IMG.house2], agents: ['ag_ryan'], firstActive: 60 }),
  ML({ id: 'l8', locationId: 'lon', reference: 'LON-0001', title: 'Victorian terrace on Flask Walk', description: 'Three-bedroom Victorian terraced house with a south-facing garden and original fireplaces.', transaction: 'sale', propertyType: 'house', status: 'active', priceMinor: 2_450_000_00, rentPeriod: null, bedrooms: 3, bathrooms: 2, areaSqm: sq(1640), features: ['Garden'], line1: '14 Flask Walk', city: 'London', region: null, postalCode: 'NW3 1HE', photos: [IMG.house2], agents: ['ag_james'], firstActive: 27, approval: 'not_required' }),
  ML({ id: 'l9', locationId: 'lon', reference: 'LON-0002', title: 'Two-bedroom flat in a mansion block', description: 'Two-bedroom first-floor flat with high ceilings.', transaction: 'rent', propertyType: 'apartment', status: 'active', priceMinor: 3_250_00, rentPeriod: 'month', bedrooms: 2, bathrooms: 1, areaSqm: sq(850), features: [], line1: '5 Belsize Park Gardens', city: 'London', region: null, postalCode: 'NW3 4LB', photos: [IMG.apt], agents: ['ag_amara', 'ag_james'], firstActive: 4, approval: 'not_required' }),
  ML({ id: 'l10', locationId: 'mad', reference: 'MAD-0001', title: 'Piso exterior en el barrio de Salamanca', description: 'Piso exterior de tres dormitorios con balcones a la calle, ascensor y portero.', transaction: 'sale', propertyType: 'apartment', status: 'active', priceMinor: 1_150_000_00, rentPeriod: null, bedrooms: 3, bathrooms: 2, areaSqm: 142, features: ['Ascensor', 'Portero'], line1: 'Calle de Velázquez 58', city: 'Madrid', region: 'Madrid', postalCode: '28001', photos: [IMG.living2], agents: ['ag_lucia'], firstActive: 14 }),
  ML({ id: 'l11', locationId: 'dxb', reference: 'DXB-0001', title: 'Marina-view two-bedroom apartment', description: 'Two-bedroom apartment with a balcony overlooking the marina.', transaction: 'sale', propertyType: 'apartment', status: 'active', priceMinor: 3_200_000_00, rentPeriod: null, bedrooms: 2, bathrooms: 3, areaSqm: sq(1420), features: ['Balcony'], line1: 'Marina Gate 1, Unit 2304', city: 'Dubai Marina', region: 'Dubai', postalCode: null, photos: [IMG.modern], agents: ['ag_omar'], firstActive: 11 }),
  ML({ id: 'l12', locationId: 'syd', reference: 'SYD-0002', title: 'Woollahra family home', description: 'Four-bedroom freestanding home with a pool.', transaction: 'sale', propertyType: 'house', status: 'sold', priceMinor: 4_100_000_00, closedPriceMinor: 4_250_000_00, closedAgo: 8, rentPeriod: null, bedrooms: 4, bathrooms: 3, areaSqm: 265, features: [], line1: '8 Queen St', city: 'Woollahra', region: 'NSW', postalCode: '2025', photos: [IMG.pool], agents: ['ag_chloe'], firstActive: 45, approval: 'not_required' }),
];

const ENQUIRIES: Enquiry[] = [
  ['e1', 'tor', 'l1', 'website', 'buyer', 'Aaron Patel', 'ag_nadia', 'listing_agent', 'new', 0.1, 'Is the basement legal for a second unit?'],
  ['e2', 'tor', 'l1', 'portal_realtor_ca', 'buyer', 'Omar & Sara Haddad', 'ag_nadia', 'listing_agent', 'viewing_booked', 5, 'We would like to see it this weekend.'],
  ['e3', 'tor', null, 'website', 'valuation', 'Lena Fischer', null, 'office_pool', 'new', 0.2, 'Thinking of selling next spring.'],
  ['e4', 'tor', 'l3', 'phone', 'buyer', 'Benjamin Cho', 'ag_daniel', 'listing_agent', 'offer_made', 20, null],
  ['e5', 'lon', 'l8', 'portal_rightmove', 'buyer', 'Charlotte Evans', 'ag_james', 'listing_agent', 'viewing_booked', 8, null],
  ['e6', 'mad', 'l10', 'portal_idealista', 'buyer', 'Carmen Díaz', 'ag_lucia', 'listing_agent', 'viewing_booked', 7, null],
  ['e7', 'van', null, 'website', 'valuation', 'Ethan Brooks', 'ag_sofia', 'round_robin', 'new', 1, null],
].map(([id, loc, lid, source, kind, name, agent, routedBy, status, d, message]) => ({
  id: id as string, locationId: loc as string, listingId: lid as string | null, listing: lid ? { title: LISTINGS.find((l) => l.id === lid)!.title, reference: LISTINGS.find((l) => l.id === lid)!.reference } : null, source: source as string, kind: kind as string, name: name as string,
  email: `${(name as string).split(' ')[0]!.toLowerCase()}@example.com`, phone: null, message: message as string | null, assignedAgentId: agent as string | null, agentName: agentName(agent as string | null), routedBy: routedBy as string, status: status as Enquiry['status'], createdAt: ago(d as number),
}));

const VIEWINGS: Viewing[] = [
  ['v1', 'l1', 'ag_nadia', inH(2), 'confirmed', 'Omar & Sara Haddad', null],
  ['v2', 'l2', 'ag_nadia', inH(4), 'requested', 'Grace Liu', null],
  ['v3', 'l1', 'ag_nadia', ago(3), 'completed', 'Benjamin Cho', { interestLevel: 'medium', rating: 4, notes: 'Liked the kitchen and garden; asked about basement ceiling height.', at: ago(3) }],
  ['v4', 'l1', 'ag_priscilla', ago(2), 'completed', 'Aisha Rahman', { interestLevel: 'high', rating: 5, notes: 'Wants a second visit with a contractor.', at: ago(2) }],
  ['v5', 'l8', 'ag_james', inH(20), 'confirmed', 'Charlotte Evans', null],
  ['v6', 'l10', 'ag_lucia', inH(44), 'confirmed', 'Carmen Díaz', null],
].map(([id, lid, agent, at, status, name, feedback]) => {
  const l = LISTINGS.find((x) => x.id === lid)!;
  return { id: id as string, listingId: l.id, locationId: l.locationId, agentId: agent as string, agentName: agentName(agent as string), listing: { title: l.title, reference: l.reference }, startsAt: at as string, endsAt: new Date(new Date(at as string).getTime() + 30 * 60_000).toISOString(), timeZone: office(l.locationId).timeZone, kind: 'in_person', status: status as Viewing['status'], contact: { name: name as string, email: `${(name as string).split(' ')[0]!.toLowerCase()}@example.com`, phone: null }, feedback: feedback as Viewing['feedback'] };
});

const ev = (action: string, party: string, amount: number | null, at: string, note: string | null = null): OfferEvent => ({ id: Math.random().toString(36).slice(2), action, party, amount: amount ? { amount, currency: 'CAD' } : null, conditions: null, note, at });
const OFFERS: Offer[] = [
  { id: 'o1', listingId: 'l1', locationId: 'tor', buyerName: 'Aisha Rahman', submittedByAgentId: 'ag_priscilla', submittedByAgentName: 'Priscilla Tan', amount: { amount: 1_625_000_00, currency: 'CAD' }, deposit: { amount: 75_000_00, currency: 'CAD' }, conditions: ['Financing within 5 business days', 'Home inspection'], expiresAt: inH(48), status: 'countered', createdAt: ago(1), updatedAt: ago(0.25), events: [ev('submitted', 'buyer', 1_595_000_00, ago(1)), ev('countered', 'vendor', 1_625_000_00, ago(0.25), 'Vendor counter; conditions accepted')] },
  { id: 'o2', listingId: 'l3', locationId: 'tor', buyerName: 'Benjamin Cho', submittedByAgentId: 'ag_daniel', submittedByAgentName: 'Daniel Okafor', amount: { amount: 1_175_000_00, currency: 'CAD' }, deposit: null, conditions: ['Firm'], expiresAt: null, status: 'accepted', createdAt: ago(4), updatedAt: ago(3), events: [ev('submitted', 'buyer', 1_175_000_00, ago(4)), ev('accepted', 'vendor', null, ago(3))] },
];

const portalOffice = (locationId: string, name: string, country: string, status: 'sandbox' | 'not_configured'): Portal['offices'][number] => ({ locationId, name, country, connectionId: status === 'sandbox' ? `conn-${locationId}` : null, status, statusReason: status === 'sandbox' ? 'Sandbox — sample data, never connected' : 'Not configured', lastPush: null, lastFetchedAt: null });
const PORTALS: Portal[] = [
  { id: 'rightmove', name: 'Rightmove', description: 'Rightmove Real Time Datafeed (RTDF) — UK sales and lettings, pushed per listing', format: 'json', countries: ['GB'], delivery: 'push', mode: 'sandbox', live: false, status: 'Sandbox — nothing is transmitted', offices: [portalOffice('lon', 'London Hampstead', 'GB', 'sandbox')], optedInListings: 0, invalidListings: 0, lastExportedAt: null },
  { id: 'idealista', name: 'idealista', description: 'idealista JSON import file (Spain, Portugal, Italy) served at a signed URL', format: 'json', countries: ['ES', 'PT', 'IT'], delivery: 'pull', mode: 'sandbox', live: false, status: 'Not configured — sandbox preview only', offices: [portalOffice('mad', 'Madrid Salamanca', 'ES', 'not_configured')], optedInListings: 0, invalidListings: 0, lastExportedAt: null },
  { id: 'reso_xml', name: 'Zillow / RESO XML', description: 'Zillow-compatible listing feed (XML) for US and Canadian listings, served at a signed URL', format: 'xml', countries: ['US', 'CA'], delivery: 'pull', mode: 'sandbox', live: false, status: 'Not configured — sandbox preview only', offices: [portalOffice('tor', 'Toronto Midtown', 'CA', 'not_configured')], optedInListings: 1, invalidListings: 0, lastExportedAt: null },
  { id: 'reaxml', name: 'REAXML (realestate.com.au / Domain)', description: 'REAXML feed for Australian and New Zealand listings, served at a signed URL', format: 'xml', countries: ['AU', 'NZ'], delivery: 'pull', mode: 'sandbox', live: false, status: 'Not configured — sandbox preview only', offices: [], optedInListings: 0, invalidListings: 0, lastExportedAt: null },
];

// ───────── Persona rules ─────────
const myAgents = (c: RealtyCtx) => (c.role === 'staff' ? ['ag_nadia'] : []);
const isManager = (c: RealtyCtx, loc: string) => c.role === 'hq' || (c.role === 'local' && loc === 'tor');
const canApprove = (c: RealtyCtx) => c.role === 'hq';
const visibleLoc = (c: RealtyCtx, loc: string) => c.locationIds.includes(loc) && (c.role === 'hq' || loc === 'tor');
const canSeeOffer = (c: RealtyCtx, l: MockListing, o?: Offer) => isManager(c, l.locationId) || l.agents.some((a) => myAgents(c).includes(a)) || (!!o?.submittedByAgentId && myAgents(c).includes(o.submittedByAgentId));
const canEdit = (c: RealtyCtx, l: MockListing) => isManager(c, l.locationId) || l.agents.some((a) => myAgents(c).includes(a));

function view(c: RealtyCtx, l: MockListing): ListingDetail {
  const o = office(l.locationId);
  const unit: AreaUnit = o.areaUnit;
  const area = l.areaSqm != null ? { value: areaIn(l.areaSqm, unit)!, unit, label: areaUnitLabel(unit), sqm: Math.round(l.areaSqm * 10) / 10 } : null;
  return {
    id: l.id, locationId: l.locationId, reference: l.reference, title: l.title, description: l.description, transaction: l.transaction, propertyType: l.propertyType, status: l.status,
    price: { amount: l.priceMinor, currency: o.currency as 'CAD' }, rentPeriod: l.rentPeriod, bedrooms: l.bedrooms, bathrooms: l.bathrooms, area, lot: null, areaUnit: unit, yearBuilt: null, features: l.features,
    address: { line1: l.line1, line2: null, city: l.city, region: l.region, postalCode: l.postalCode, country: o.country }, addressLines: formatAddressLines({ line1: l.line1, city: l.city, region: l.region, postalCode: l.postalCode, country: o.country }),
    hideStreet: false, photos: l.photos.map((url) => ({ url })), floorPlans: [], virtualTourUrl: null, disclosures: [],
    approval: { status: l.approval, requestedStatus: l.requestedStatus ?? null, pendingChanges: l.pendingChanges ?? null, requestedBy: l.requestedBy ?? null, comment: null, decidedAt: null },
    tier: o.tier, agents: l.agents.map((id, i) => ({ id, name: agentName(id) ?? id, role: i === 0 ? 'lead' : 'co' })),
    daysOnMarket: l.firstActive != null ? l.firstActive - (l.closedAgo ?? 0) : null, closedPrice: l.closedPriceMinor ? { amount: l.closedPriceMinor, currency: o.currency as 'CAD' } : null,
    fairHousingWarnings: findProtectedTargeting(`${l.title}\n${l.description}`), updatedAt: now(),
    counts: { enquiries: ENQUIRIES.filter((e) => e.listingId === l.id).length, upcomingViewings: VIEWINGS.filter((v) => v.listingId === l.id && ['requested', 'confirmed'].includes(v.status)).length, openOffers: canSeeOffer(c, l) ? OFFERS.filter((x) => x.listingId === l.id && ['submitted', 'countered', 'accepted'].includes(x.status)).length : null },
    permissions: { canEdit: canEdit(c, l), canApprove: canApprove(c), canSeeOffers: canSeeOffer(c, l), canSeeClients: canEdit(c, l), isRequester: l.requestedBy === (c.role === 'staff' ? 'u_staff' : c.role === 'local' ? 'u_local' : 'u_hq') },
    office: { id: o.locationId, name: o.name, timeZone: o.timeZone, currency: o.currency, country: o.country, tier: o.tier, areaUnit: o.areaUnit, disclosures: o.disclosures },
    history: l.history, openHouses: [], syndication: l.syndication, vendor: null, allowedTransitions: allowedListingTransitions(l.status, l.transaction),
  };
}
const find = (id: string) => { const l = LISTINGS.find((x) => x.id === id); if (!l) throw new ApiError('not_found', 'Listing not found', 404); return l; };
const userId = (c: RealtyCtx) => (c.role === 'staff' ? 'u_staff' : c.role === 'local' ? 'u_local' : 'u_hq');

function report(c: RealtyCtx) {
  const locs = OFFICES.filter((o) => c.locationIds.includes(o.locationId) && (c.role !== 'staff'));
  if (!locs.length) throw forbid('Missing permission reports.read for this scope');
  const vol = (ls: MockListing[]) => { const m = new Map<string, { currency: string; count: number; volumeMinor: number }>(); for (const l of ls) { const cur = office(l.locationId).currency; const r = m.get(cur) ?? { currency: cur, count: 0, volumeMinor: 0 }; r.count++; r.volumeMinor += l.closedPriceMinor ?? l.priceMinor; m.set(cur, r); } return [...m.values()].sort((a, b) => a.currency.localeCompare(b.currency)); };
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
  const per: OfficeReport[] = locs.map((o) => {
    const ls = LISTINGS.filter((l) => l.locationId === o.locationId);
    const live = ls.filter((l) => ['active', 'under_offer'].includes(l.status) && l.firstActive != null).map((l) => l.firstActive!);
    const enq = ENQUIRIES.filter((e) => e.locationId === o.locationId).length, vw = VIEWINGS.filter((v) => v.locationId === o.locationId && v.status !== 'cancelled').length, of = OFFERS.filter((x) => x.locationId === o.locationId).length;
    return { locationId: o.locationId, name: o.name, country: o.country, currency: o.currency, listings: { comingSoon: ls.filter((l) => l.status === 'coming_soon').length, active: ls.filter((l) => l.status === 'active').length, underOffer: ls.filter((l) => l.status === 'under_offer').length, draft: ls.filter((l) => l.status === 'draft').length, awaitingApproval: ls.filter((l) => l.approval === 'pending').length },
      daysOnMarket: { liveMedian: med(live), liveCount: live.length, closedMedian: null, closedCount: 0 }, funnel: { enquiries: enq, viewings: vw, offers: of, acceptedOffers: OFFERS.filter((x) => x.locationId === o.locationId && x.status === 'accepted').length, enquiryToViewing: enq ? Math.round((vw / enq) * 1000) / 10 : null, viewingToOffer: vw ? Math.round((of / vw) * 1000) / 10 : null },
      sold: vol(ls.filter((l) => l.status === 'sold')), let: vol(ls.filter((l) => l.status === 'let')) };
  });
  const merge = (k: 'sold' | 'let') => { const m = new Map<string, { currency: string; count: number; volumeMinor: number }>(); for (const p of per) for (const v of p[k]) { const r = m.get(v.currency) ?? { ...v, count: 0, volumeMinor: 0 }; r.count += v.count; r.volumeMinor += v.volumeMinor; m.set(v.currency, r); } return [...m.values()]; };
  const sum = (f: (p: OfficeReport) => number) => per.reduce((n, p) => n + f(p), 0);
  return {
    period: { from: ago(90), to: now() }, generatedAt: now(), source: 'Sample data', definitions: { daysOnMarket: 'Days since the listing first became active.', funnel: 'Records created in the last 90 days.', volume: 'Final price of listings sold/let, per currency.' },
    locations: per,
    network: { listings: { active: sum((p) => p.listings.active), underOffer: sum((p) => p.listings.underOffer), comingSoon: sum((p) => p.listings.comingSoon), awaitingApproval: sum((p) => p.listings.awaitingApproval) }, daysOnMarket: { liveMedian: med(per.map((p) => p.daysOnMarket.liveMedian).filter((x): x is number => x != null)), liveCount: sum((p) => p.daysOnMarket.liveCount) }, funnel: { enquiries: sum((p) => p.funnel.enquiries), viewings: sum((p) => p.funnel.viewings), offers: sum((p) => p.funnel.offers), acceptedOffers: sum((p) => p.funnel.acceptedOffers) }, sold: merge('sold'), let: merge('let'), combinedVolume: null },
  };
}

function setStatus(c: RealtyCtx, l: MockListing, to: LS, viaApproval = false): 'applied' | 'pending_approval' {
  const t = listingTransition(l.status, to, l.transaction);
  if (!t.ok) throw conflict('invalid_transition', `A ${l.transaction} listing cannot move from ${l.status.replace('_', ' ')} to ${to.replace('_', ' ')}`);
  const publishing = !['coming_soon', 'active', 'under_offer'].includes(l.status) && ['coming_soon', 'active'].includes(to);
  if (publishing && tierRequiresApproval(office(l.locationId).tier) && !canApprove(c) && !viaApproval) {
    l.approval = 'pending'; l.requestedStatus = to; l.requestedBy = userId(c);
    return 'pending_approval';
  }
  l.history.push({ from: l.status, to, at: now(), note: null });
  if (to === 'active' && l.firstActive == null) l.firstActive = 0;
  if (to === 'sold' || to === 'let') { l.closedAgo = 0; l.closedPriceMinor = OFFERS.find((o) => o.listingId === l.id && o.status === 'accepted')?.amount.amount ?? l.priceMinor; }
  if (publishing) { l.approval = tierRequiresApproval(office(l.locationId).tier) ? 'approved' : 'not_required'; l.requestedStatus = null; }
  l.status = to;
  return 'applied';
}

export const mockRealty: RealtyApi = {
  async me(c) { await delay(80); return { agents: myAgents(c).map((id) => ({ id, name: agentName(id)!, locationId: 'tor' })), clients: c.role === 'hq' ? 'all' : c.role === 'local' ? ['tor'] : [], approve: c.role === 'hq' ? 'all' : [], reports: c.role === 'staff' ? [] : c.role === 'hq' ? 'all' : ['tor'] }; },
  async offices(c) { await delay(); return OFFICES.filter((o) => visibleLoc(c, o.locationId)); },
  async saveOffice(c, id, body) { await delay(); if (!isManager(c, id)) throw forbid('Only office managers or HQ can change office settings'); if (body.tier && c.role !== 'hq') throw forbid('Governance tier is set by HQ'); Object.assign(office(id), body); return office(id); },
  async listings(c, q = {}) {
    await delay();
    return LISTINGS.filter((l) => visibleLoc(c, l.locationId) && (!q.status || l.status === q.status) && (!q.approval || l.approval === 'pending') && (!q.mine || l.agents.some((a) => myAgents(c).includes(a)))).map((l) => view(c, l));
  },
  async listing(c, id) { await delay(); const l = find(id); if (!visibleLoc(c, l.locationId)) throw forbid(); return view(c, l); },
  async createListing(c, b) {
    await delay();
    const loc = b.locationId ?? 'tor';
    if (!isManager(c, loc) && c.role !== 'staff') throw forbid('Missing permission operations.write for this office');
    const l = ML({ id: `l${Date.now()}`, locationId: loc, reference: `${loc.toUpperCase()}-${String(LISTINGS.length + 1).padStart(4, '0')}`, title: b.title ?? 'New listing', description: b.description ?? '', transaction: b.transaction ?? 'sale', propertyType: b.propertyType ?? 'house', status: 'draft', priceMinor: b.priceMinor ?? 0, rentPeriod: b.transaction === 'rent' ? 'month' : null, bedrooms: b.bedrooms ?? null, bathrooms: b.bathrooms ?? null, areaSqm: b.area ? toSqm(b.area.value, b.area.unit) : null, features: b.features ?? [], line1: b.address?.line1 ?? '', city: b.address?.city ?? office(loc).city, region: b.address?.region ?? null, postalCode: b.address?.postalCode ?? null, photos: (b.photos ?? []).map((p) => p.url), agents: [c.role === 'staff' ? 'ag_nadia' : (b.leadAgentId ?? AGENTS.find((a) => a.locationId === loc)!.id)], firstActive: null, approval: 'not_required' });
    LISTINGS = [l, ...LISTINGS];
    return view(c, l);
  },
  async updateListing(c, id, b) {
    await delay();
    const l = find(id);
    if (!canEdit(c, l)) throw forbid('Only the listing agents or an office manager can edit this listing');
    const patch: Partial<MockListing> = {};
    if (b.title !== undefined) patch.title = b.title; if (b.description !== undefined) patch.description = b.description ?? ''; if (b.priceMinor !== undefined) patch.priceMinor = b.priceMinor;
    if (b.bedrooms !== undefined) patch.bedrooms = b.bedrooms; if (b.bathrooms !== undefined) patch.bathrooms = b.bathrooms; if (b.features) patch.features = b.features; if (b.area !== undefined) patch.areaSqm = b.area ? toSqm(b.area.value, b.area.unit) : null;
    if (b.photos) patch.photos = b.photos.map((p) => p.url); if (b.propertyType) patch.propertyType = b.propertyType;
    const governed = ['coming_soon', 'active', 'under_offer'].includes(l.status) && office(l.locationId).tier !== 'flexible' && !canApprove(c);
    if (governed) { l.pendingChanges = { ...(l.pendingChanges ?? {}), ...patch }; l.approval = 'pending'; l.requestedBy = userId(c); return { result: 'pending_approval', listing: view(c, l) }; }
    Object.assign(l, patch);
    return { result: 'applied', listing: view(c, l) };
  },
  async setStatus(c, id, to) { await delay(); const l = find(id); if (!canEdit(c, l)) throw forbid('Only the listing agents or an office manager can change the status'); const r = setStatus(c, l, to as LS); let cancelled = 0; if (['withdrawn', 'sold', 'let'].includes(to)) for (const v of VIEWINGS) if (v.listingId === l.id && ['requested', 'confirmed'].includes(v.status) && v.startsAt > now()) { v.status = 'cancelled'; cancelled++; } return { result: r, listing: view(c, l), cancelledViewings: cancelled }; },
  async decideApproval(c, id, decision, comment) {
    await delay();
    const l = find(id);
    if (!canApprove(c)) throw forbid('Missing permission website.approve for this location');
    if (l.requestedBy === userId(c)) throw forbid('You cannot approve your own request');
    if (decision === 'reject' && !comment?.trim()) throw new ApiError('validation_failed', 'Explain what needs to change', 400, { comment: 'A comment is required when rejecting' });
    if (decision === 'reject') { l.approval = 'rejected'; l.requestedStatus = null; l.pendingChanges = null; return view(c, l); }
    if (l.pendingChanges) { Object.assign(l, l.pendingChanges); l.pendingChanges = null; }
    if (l.requestedStatus) setStatus(c, l, l.requestedStatus, true);
    l.approval = 'approved'; l.requestedStatus = null;
    return view(c, l);
  },
  async setSyndication(c, id, portal, optedIn) { await delay(); const l = find(id); if (!canEdit(c, l)) throw forbid(); const p = PORTALS.find((x) => x.id === portal)!; if (optedIn && !p.countries.includes(office(l.locationId).country)) throw new ApiError('validation_failed', `${p.name} only accepts listings in ${p.countries.join(', ')}`, 400); l.syndication = [...l.syndication.filter((s) => s.portal !== portal), { portal, optedIn, lastStatus: 'not_exported', lastIssues: [], lastExportedAt: null }]; return { issues: [] }; },
  async enquiries(c, v) {
    await delay();
    if (c.role === 'hq') return ENQUIRIES.filter((e) => c.locationIds.includes(e.locationId) && (v !== 'pool' || !e.assignedAgentId));
    const mine = myAgents(c);
    return ENQUIRIES.filter((e) => e.locationId === 'tor' && c.locationIds.includes('tor'))
      .filter((e) => c.role === 'local' || !e.assignedAgentId || mine.includes(e.assignedAgentId))
      .filter((e) => v === 'all' || (v === 'mine' ? !!e.assignedAgentId && mine.includes(e.assignedAgentId) : !e.assignedAgentId));
  },
  async assignEnquiry(c, id, agentId) { await delay(); const e = ENQUIRIES.find((x) => x.id === id)!; const claiming = !e.assignedAgentId && !!agentId && myAgents(c).includes(agentId); if (!isManager(c, e.locationId) && !claiming) throw forbid('Agents can claim pool enquiries for themselves; reassigning needs an office manager'); e.assignedAgentId = agentId; e.agentName = agentName(agentId); e.routedBy = agentId ? 'manual' : 'office_pool'; return e; },
  async enquiryStatus(c, id, status) { await delay(); const e = ENQUIRIES.find((x) => x.id === id)!; if (!isManager(c, e.locationId) && !(e.assignedAgentId && myAgents(c).includes(e.assignedAgentId))) throw forbid(); e.status = status; return e; },
  async viewings(c, from, to) {
    await delay();
    return VIEWINGS.filter((v) => visibleLoc(c, v.locationId) && v.startsAt >= from && v.startsAt < to).map((v) => {
      const own = isManager(c, v.locationId) || myAgents(c).includes(v.agentId);
      return { ...v, mine: myAgents(c).includes(v.agentId), contact: own ? v.contact : { name: v.contact.name.split(' ')[0]!, email: null, phone: null }, feedback: v.feedback && !own ? { ...v.feedback, notes: null } : v.feedback };
    });
  },
  async confirmViewing(c, id) { await delay(); const v = VIEWINGS.find((x) => x.id === id)!; if (!isManager(c, v.locationId) && !myAgents(c).includes(v.agentId)) throw forbid('Only the agent or an office manager can confirm this viewing'); if (v.status !== 'requested') throw conflict('viewing_not_requested', `This viewing is ${v.status}`); v.status = 'confirmed'; return v; },
  async cancelViewing(c, id) { await delay(); const v = VIEWINGS.find((x) => x.id === id)!; if (!isManager(c, v.locationId) && !myAgents(c).includes(v.agentId)) throw forbid(); v.status = 'cancelled'; return v; },
  async viewingFeedback(c, id, b) { await delay(); const v = VIEWINGS.find((x) => x.id === id)!; if (!isManager(c, v.locationId) && !myAgents(c).includes(v.agentId)) throw forbid('Only the agent or an office manager can log feedback'); if (v.startsAt > now()) throw conflict('viewing_in_future', 'Feedback can be logged once the viewing has started'); v.status = b.outcome; v.feedback = { interestLevel: b.interestLevel ?? null, rating: b.rating ?? null, notes: b.notes ?? null, at: now() }; return v; },
  async offers(c) { await delay(); return OFFERS.filter((o) => { const l = find(o.listingId); return c.locationIds.includes(o.locationId) && canSeeOffer(c, l, o); }).map((o) => { const l = find(o.listingId); return { ...o, listing: { id: l.id, title: l.title, reference: l.reference, status: l.status, price: { amount: l.priceMinor, currency: o.amount.currency } } }; }); },
  async offer(c, id) { await delay(); const o = OFFERS.find((x) => x.id === id); if (!o || !canSeeOffer(c, find(o.listingId), o)) throw new ApiError('not_found', 'Offer not found', 404); return o; },
  async offerAction(c, id, b) {
    await delay();
    const o = OFFERS.find((x) => x.id === id)!;
    const l = find(o.listingId);
    const listingSide = isManager(c, l.locationId) || l.agents.some((a) => myAgents(c).includes(a));
    const buyerSide = isManager(c, l.locationId) || (!!o.submittedByAgentId && myAgents(c).includes(o.submittedByAgentId));
    if (['counter', 'accept', 'reject'].includes(b.action) && !listingSide) throw forbid('Only the listing agents or an office manager can respond for the vendor');
    if (['revise', 'withdraw'].includes(b.action) && !buyerSide) throw forbid('Only the buyer’s agent or an office manager can change or withdraw this offer');
    const to: Record<string, Offer['status']> = { counter: 'countered', revise: 'submitted', accept: 'accepted', reject: 'rejected', withdraw: 'withdrawn' };
    if (b.action === 'accept' && OFFERS.some((x) => x.listingId === o.listingId && x.status === 'accepted')) throw conflict('offer_already_accepted', 'Another offer on this listing is already accepted. Withdraw it first.');
    if (to[b.action] && ['accepted', 'rejected', 'withdrawn'].includes(o.status) && !(o.status === 'accepted' && b.action === 'withdraw')) throw conflict('invalid_offer_transition', `An offer that is ${o.status} cannot change`);
    if (to[b.action]) o.status = to[b.action]!;
    if (b.amountMinor) o.amount = { ...o.amount, amount: b.amountMinor };
    o.events = [...(o.events ?? []), ev(({ counter: 'countered', revise: 'revised', accept: 'accepted', reject: 'rejected', withdraw: 'withdrawn', note: 'note' } as Record<string, string>)[b.action] ?? 'note', b.action === 'note' ? 'agent' : ['counter', 'accept', 'reject'].includes(b.action) ? 'vendor' : 'buyer', b.amountMinor ?? null, now(), b.note ?? null)];
    if (b.action === 'accept' && l.status === 'active') l.status = 'under_offer';
    return o;
  },
  async agents(c) { await delay(); return AGENTS.filter((a) => visibleLoc(c, a.locationId)).map((a) => ({ ...a, isMe: myAgents(c).includes(a.id), workload: { upcomingViewings: VIEWINGS.filter((v) => v.agentId === a.id && ['requested', 'confirmed'].includes(v.status)).length, openEnquiries: ENQUIRIES.filter((e) => e.assignedAgentId === a.id && ['new', 'contacted'].includes(e.status)).length, liveListings: LISTINGS.filter((l) => l.agents.includes(a.id) && ['active', 'under_offer', 'coming_soon'].includes(l.status)).length } })); },
  async updateAgent(c, id, b) { await delay(); const a = AGENTS.find((x) => x.id === id)!; if (!isManager(c, a.locationId) && !myAgents(c).includes(id)) throw forbid(); Object.assign(a, b); return a; },
  async reports(c) { await delay(); return report(c); },
  async portals() { await delay(); return PORTALS; },
  async feed(_c, portal) { await delay(); const p = PORTALS.find((x) => x.id === portal)!; const ls = LISTINGS.filter((l) => l.syndication.some((s) => s.portal === portal && s.optedIn)); return { portal, name: p.name, format: p.format, notice: 'Sandbox preview. Nothing is sent to any portal and no integration is live.', included: ls.map((l) => ({ listingId: l.id, reference: l.reference })), excluded: [], content: p.format === 'json' ? JSON.stringify({ sandbox: true, listings: ls.map((l) => ({ ListingKey: l.reference, ListPrice: l.priceMinor / 100 })) }, null, 2) : `<?xml version="1.0"?>\n<!-- SANDBOX FEED: preview only -->\n<Listings>${ls.map((l) => `<Listing id="${l.reference}"/>`).join('')}</Listings>` }; },
  async exportFeed(_c, portal) { await delay(); const ls = LISTINGS.filter((l) => l.syndication.some((s) => s.portal === portal && s.optedIn)); return { transmitted: false, results: ls.map((l) => ({ listingId: l.id, reference: l.reference, status: 'sandbox_exported', issues: [] })) }; },
  async syndicationListings() { await delay(); return LISTINGS.flatMap((l) => l.syndication.filter((s) => s.optedIn).map((s) => ({ listingId: l.id, reference: l.reference, title: l.title, locationId: l.locationId, listingStatus: l.status, portal: s.portal, issues: s.lastIssues, lastStatus: s.lastStatus, lastIssues: s.lastIssues, lastExportedAt: s.lastExportedAt }))); },
  async aiDescription() { await delay(); throw new ApiError('ai_unavailable', 'BranchHarbor AI is not available in sample mode. Listings, viewings and offers keep working.', 503); },
  async aiFeedback() { await delay(); throw new ApiError('ai_unavailable', 'BranchHarbor AI is not available in sample mode.', 503); },
  async aiDecision() { await delay(); throw new ApiError('ai_unavailable', 'BranchHarbor AI is not available in sample mode.', 503); },
};


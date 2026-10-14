/**
 * Real Estate data for the mobile app (buyer, agent and owner experiences).
 * Live: /v1/public/realty/*, /v1/me/realty/*, /v1/orgs/:orgId/realty/* (EXPO_PUBLIC_REALTY_BRAND, default keystone-realty).
 * Mock: a small in-memory sample of the Keystone Realty Network so the app runs without the API.
 */
import { env } from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { GUEST_TOKEN, http } from '@/lib/http';
import { tokenStore } from '@/lib/storage';

export const REALTY_BRAND = process.env.EXPO_PUBLIC_REALTY_BRAND || 'keystone-realty';

export interface Money { amount: number; currency: string }
export interface RListing {
  id: string; reference: string; title: string; transaction: 'sale' | 'rent'; propertyType: string; status: string; price: Money; rentPeriod: string | null;
  bedrooms: number | null; bathrooms: number | null; area: { value: number; label: string } | null; city: string; addressLines: string[]; photo: { url: string } | null;
  office?: { name: string; timeZone: string };
}
export interface RListingDetail { listing: RListing & { description: string | null; features: string[]; photos: Array<{ url: string }>; areaAlt: { value: number; label: string } | null; disclosures: Array<{ key: string; label: string; text: string }> }; agents: Array<{ id: string; name: string; phone: string | null }>; office: { name: string; timeZone: string; phone: string | null } }
export interface RSlot { startsAt: string; endsAt: string; agentId: string; agentName: string }
export interface RViewing { id: string; startsAt: string; endsAt: string; timeZone: string | null; status: string; agentName: string | null; listing: { title: string; reference: string } | null; contact: { name: string; email: string | null; phone: string | null }; feedback: { interestLevel: string | null; rating: number | null } | null }
export interface REnquiry { id: string; name: string; kind: string; source: string; message: string | null; listingTitle: string | null; assignedToMe: boolean; createdAt: string; email: string | null; phone: string | null }
export interface RDay { agents: Array<{ id: string; name: string }>; viewings: RViewing[]; enquiries: REnquiry[]; offers: Array<{ id: string; buyerName: string; amount: Money; status: string; listing: { title: string } }>; note?: string }
export interface RVolume { currency: string; count: number; volumeMinor: number }
export interface RPulse { network: null | { listings: { active: number; underOffer: number; comingSoon: number; awaitingApproval: number }; daysOnMarket: { liveMedian: number | null }; funnel: { enquiries: number; viewings: number; offers: number; acceptedOffers: number }; sold: RVolume[]; let: RVolume[] }; locations: Array<{ locationId: string; name: string; currency: string; funnel: { enquiries: number; viewings: number; offers: number }; sold: RVolume[] }> }
export interface RFilters { transaction?: 'sale' | 'rent'; minBeds?: number; type?: string; office?: string; areaUnit?: 'sqm' | 'sqft' }

// ───────── Mock ─────────
const u = (id: string) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=900&q=70`;
const inH = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const MOCK: RListing[] = [
  { id: 'l1', reference: 'TOR-0001', title: 'Detached family-sized home on Birchmount Crescent', transaction: 'sale', propertyType: 'house', status: 'active', price: { amount: 1_649_000_00, currency: 'CAD' }, rentPeriod: null, bedrooms: 4, bathrooms: 3, area: { value: 2350, label: 'sq ft' }, city: 'Toronto', addressLines: ['42 Birchmount Cres', 'Toronto, ON M1N 1A1'], photo: { url: u('1570129477492-45c003edd2be') }, office: { name: 'Toronto Midtown', timeZone: 'America/Toronto' } },
  { id: 'l2', reference: 'TOR-0002', title: 'Corner suite 1806 with lake views', transaction: 'sale', propertyType: 'condo', status: 'active', price: { amount: 925_000_00, currency: 'CAD' }, rentPeriod: null, bedrooms: 2, bathrooms: 2, area: { value: 910, label: 'sq ft' }, city: 'Toronto', addressLines: ['88 Harbour St, Unit 1806', 'Toronto, ON'], photo: { url: u('1554995207-c18c203602cb') }, office: { name: 'Toronto Midtown', timeZone: 'America/Toronto' } },
  { id: 'l3', reference: 'LON-0002', title: 'Two-bedroom flat in a mansion block', transaction: 'rent', propertyType: 'apartment', status: 'active', price: { amount: 3_250_00, currency: 'GBP' }, rentPeriod: 'month', bedrooms: 2, bathrooms: 1, area: { value: 850, label: 'sq ft' }, city: 'London', addressLines: ['5 Belsize Park Gardens', 'London', 'NW3 4LB'], photo: { url: u('1560448204-e02f11c3d0e2') }, office: { name: 'London Hampstead', timeZone: 'Europe/London' } },
  { id: 'l4', reference: 'MAD-0001', title: 'Piso exterior en el barrio de Salamanca', transaction: 'sale', propertyType: 'apartment', status: 'active', price: { amount: 1_150_000_00, currency: 'EUR' }, rentPeriod: null, bedrooms: 3, bathrooms: 2, area: { value: 142, label: 'm²' }, city: 'Madrid', addressLines: ['Calle de Velázquez 58', '28001 Madrid'], photo: { url: u('1600566753190-17f0baa2a6c3') }, office: { name: 'Madrid Salamanca', timeZone: 'Europe/Madrid' } },
  { id: 'l5', reference: 'SYD-0001', title: 'Paddington terrace with courtyard', transaction: 'sale', propertyType: 'townhouse', status: 'under_offer', price: { amount: 2_350_000_00, currency: 'AUD' }, rentPeriod: null, bedrooms: 2, bathrooms: 1, area: { value: 118, label: 'm²' }, city: 'Paddington', addressLines: ['21 Glenmore Rd', 'Paddington, NSW 2021'], photo: { url: u('1580587771525-78b9dba3b914') }, office: { name: 'Sydney Paddington', timeZone: 'Australia/Sydney' } },
];
const favs = new Set<string>(['l2']);
const myViewings: RViewing[] = [];
const day: RDay = {
  agents: [{ id: 'ag_nadia', name: 'Nadia Hassan' }],
  viewings: [
    { id: 'v1', startsAt: inH(1), endsAt: inH(1.5), timeZone: 'America/Toronto', status: 'confirmed', agentName: 'Nadia Hassan', listing: { title: '42 Birchmount Cres', reference: 'TOR-0001' }, contact: { name: 'Omar & Sara Haddad', email: 'haddad@example.com', phone: null }, feedback: null },
    { id: 'v0', startsAt: inH(-2), endsAt: inH(-1.5), timeZone: 'America/Toronto', status: 'confirmed', agentName: 'Nadia Hassan', listing: { title: 'Suite 1806 – 88 Harbour St', reference: 'TOR-0002' }, contact: { name: 'Grace Liu', email: 'grace.liu@example.com', phone: null }, feedback: null },
  ],
  enquiries: [
    { id: 'e1', name: 'Aaron Patel', kind: 'buyer', source: 'website', message: 'Is the basement legal for a second unit?', listingTitle: '42 Birchmount Cres', assignedToMe: true, createdAt: inH(-2), email: 'aaron.patel@example.com', phone: null },
    { id: 'e3', name: 'Lena Fischer', kind: 'valuation', source: 'website', message: 'Thinking of selling next spring.', listingTitle: null, assignedToMe: false, createdAt: inH(-5), email: 'lena.fischer@example.com', phone: null },
  ],
  offers: [],
};
const pulse: RPulse = {
  network: { listings: { active: 11, underOffer: 1, comingSoon: 1, awaitingApproval: 1 }, daysOnMarket: { liveMedian: 13 }, funnel: { enquiries: 15, viewings: 10, offers: 2, acceptedOffers: 1 }, sold: [{ currency: 'AUD', count: 1, volumeMinor: 4_250_000_00 }, { currency: 'CAD', count: 2, volumeMinor: 3_555_000_00 }], let: [{ currency: 'GBP', count: 1, volumeMinor: 1_750_00 }] },
  locations: [],
};
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const slotsFor = (date: string): RSlot[] => ['10:00', '10:30', '11:30', '14:00', '16:30'].map((t) => ({ startsAt: `${date}T${t}:00.000Z`, endsAt: `${date}T${t}:00.000Z`, agentId: 'ag_nadia', agentName: 'Nadia Hassan' }));

const mock = {
  async search(f: RFilters): Promise<RListing[]> { await wait(); return MOCK.filter((l) => (!f.transaction || l.transaction === f.transaction) && (f.minBeds == null || (l.bedrooms ?? 0) >= f.minBeds)); },
  async listing(id: string): Promise<RListingDetail> { await wait(); const l = MOCK.find((x) => x.id === id); if (!l) throw new ApiError(404, 'not_found', 'Listing not found'); return { listing: { ...l, description: 'Sample listing for the demo build.', features: [], photos: l.photo ? [l.photo] : [], areaAlt: null, disclosures: [] }, agents: [{ id: 'ag_nadia', name: 'Nadia Hassan', phone: '+1 416 555 0131' }], office: { name: l.office?.name ?? '', timeZone: l.office?.timeZone ?? 'UTC', phone: null } }; },
  async slots(_id: string, date: string) { await wait(); return slotsFor(date); },
  async bookViewing(id: string, slot: RSlot, contact: { name: string; email: string }) { await wait(); const l = MOCK.find((x) => x.id === id)!; const v: RViewing = { id: `v${Date.now()}`, startsAt: slot.startsAt, endsAt: slot.endsAt, timeZone: l.office?.timeZone ?? 'UTC', status: 'requested', agentName: slot.agentName, listing: { title: l.title, reference: l.reference }, contact: { ...contact, phone: null }, feedback: null }; myViewings.unshift(v); return v; },
  async favourites() { await wait(); return MOCK.filter((l) => favs.has(l.id)); },
  async setFavourite(id: string, on: boolean) { await wait(100); if (on) favs.add(id); else favs.delete(id); },
  async myViewings() { await wait(); return myViewings; },
  async saveSearch(email: string, f: RFilters, consent: boolean) { await wait(); return { alerts: consent ? 'weekly' : 'off', email, f }; },
  async myDay(): Promise<RDay> { await wait(); return day; },
  async feedback(id: string, interestLevel: string, rating: number) { await wait(); const v = day.viewings.find((x) => x.id === id)!; v.status = 'completed'; v.feedback = { interestLevel, rating }; return v; },
  async confirm(id: string) { await wait(); const v = day.viewings.find((x) => x.id === id)!; v.status = 'confirmed'; return v; },
  async claim(id: string) { await wait(); const e = day.enquiries.find((x) => x.id === id)!; e.assignedToMe = true; return e; },
  async pulse(): Promise<RPulse> { await wait(); return pulse; },
};

// ───────── Live ─────────
let orgIdCache: string | null = null;
async function realtyOrgId(): Promise<string> {
  if (orgIdCache) return orgIdCache;
  const r = await http<{ items: Array<{ id: string; industry: string; slug: string }> } | Array<{ id: string; industry: string; slug: string }>>('GET', '/orgs');
  const list = Array.isArray(r) ? r : r.items;
  const o = list.find((x) => x.industry === 'realty');
  if (!o) throw new ApiError(404, 'no_realty_org', 'Your account isn’t part of a real-estate organisation.');
  orgIdCache = o.id;
  return o.id;
}
const O = async (p: string) => `/orgs/${await realtyOrgId()}/realty${p}`;
const signedIn = async () => { const t = await tokenStore.get(); return !!t && t !== GUEST_TOKEN; };

const live: typeof mock = {
  async search(f) {
    const q = new URLSearchParams();
    if (f.transaction) q.set('transaction', f.transaction);
    if (f.minBeds != null) q.set('minBeds', String(f.minBeds));
    if (f.type) q.set('type', f.type);
    if (f.office) q.set('office', f.office);
    if (f.areaUnit) q.set('areaUnit', f.areaUnit);
    return (await http<{ items: RListing[] }>('GET', `/public/realty/${REALTY_BRAND}/listings?${q}`, undefined, { auth: false })).items;
  },
  listing: (id) => http('GET', `/public/realty/listings/${id}`, undefined, { auth: false }),
  async slots(id, date) { return (await http<{ slots: RSlot[] }>('GET', `/public/realty/listings/${id}/viewing-slots?date=${date}`, undefined, { auth: false })).slots; },
  async bookViewing(id, slot, contact) { return (await http<{ viewing: RViewing }>('POST', `/public/realty/listings/${id}/viewings`, { startsAt: slot.startsAt, agentId: slot.agentId, contact, source: 'mobile' }, { auth: await signedIn() })).viewing; },
  async favourites() { if (!(await signedIn())) return []; return (await http<{ items: Array<{ available: boolean; listing: RListing }> }>('GET', '/me/realty/favourites')).items.filter((x) => x.available).map((x) => x.listing); },
  async setFavourite(id, on) { if (on) await http('POST', '/me/realty/favourites', { listingId: id }); else await http('DELETE', `/me/realty/favourites/${id}`); },
  async myViewings() { if (!(await signedIn())) return []; return (await http<{ items: RViewing[] }>('GET', '/me/realty/viewings')).items; },
  async saveSearch(email, f, consent) { return http('POST', `/public/realty/${REALTY_BRAND}/saved-searches`, { email, criteria: { ...(f.transaction ? { transaction: f.transaction } : {}), ...(f.minBeds != null ? { minBedrooms: f.minBeds } : {}) }, frequency: 'weekly', alertsConsent: consent }, { auth: await signedIn() }); },
  async myDay() { return http('GET', await O('/my-day')); },
  async feedback(id, interestLevel, rating) { return http('POST', await O(`/viewings/${id}/feedback`), { outcome: 'completed', interestLevel, rating }); },
  async confirm(id) { return http('POST', await O(`/viewings/${id}/confirm`)); },
  async claim(id) {
    const day = await http<RDay>('GET', await O('/my-day'));
    const agentId = day.agents[0]?.id;
    if (!agentId) throw new ApiError(403, 'forbidden', 'You need an agent profile to claim enquiries.');
    return http('POST', await O(`/enquiries/${id}/assign`), { agentId });
  },
  async pulse() { return http('GET', await O('/reports')); },
};

export const realtyApi = env.useMocks ? mock : live;

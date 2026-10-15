/**
 * Real Estate data for the mobile app (buyer, agent and owner experiences).
 * /v1/public/realty/*, /v1/me/realty/*, /v1/orgs/:orgId/realty/* (EXPO_PUBLIC_REALTY_BRAND: the brand this build shows).
 */
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

/** Real Estate client contract (buyer, agent and owner screens). */
interface RealtyApi {
  search(f: RFilters): Promise<RListing[]>;
  listing(id: string): Promise<RListingDetail>;
  slots(id: string, date: string): Promise<RSlot[]>;
  bookViewing(id: string, slot: RSlot, contact: { name: string; email: string }): Promise<RViewing>;
  favourites(): Promise<RListing[]>;
  setFavourite(id: string, on: boolean): Promise<void>;
  myViewings(): Promise<RViewing[]>;
  saveSearch(email: string, f: RFilters, consent: boolean): Promise<{ alerts: string; email: string; f: RFilters }>;
  myDay(): Promise<RDay>;
  feedback(id: string, interestLevel: string, rating: number): Promise<RViewing>;
  confirm(id: string): Promise<RViewing>;
  claim(id: string): Promise<REnquiry>;
  pulse(): Promise<RPulse>;
}

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

const live: RealtyApi = {
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

export const realtyApi: RealtyApi = live;

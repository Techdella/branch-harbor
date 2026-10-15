/**
 * Studios full product on mobile: entitlements (packs / membership), buying, booking with a credit or
 * membership, online classes, the staff check-in roster labels and the owner's forward occupancy.
 * Calls /v1/me/studios/* (signed-in customers), /v1/public/studios/* and /v1/orgs/:orgId/studios/*.
 */
import { http } from '@/lib/http';
import type { CustomerPolicy } from './policy';

export type Money = { amount: number; currency: string };
export interface Entitlements {
  memberships: Array<{ id: string; name: string; state: string; classesPerPeriod: number | null; usage: { used: number; limit: number | null } | null; price: (Money & { interval: string | null }) | null; graceUntil: string | null; cancelAt: string | null }>;
  packs: Array<{ id: string; name: string; creditsRemaining: number; creditsTotal: number; expiresAt: string | null; status: string }>;
  credits: { available: number };
  fees: Array<{ id: string; kind: string; amount: Money }>;
}
/** Facts behind the API's English `access` / `terms` lines (phrased in the app's language by lib `studioText`). */
export interface AccessDetail { policy: 'any_location' | 'same_currency' | 'listed' | 'home_only'; currency: string; locationCount: number; locationName: string }
export interface TermsDetail { billingCurrency: string; noticeDays: number; maxPauseDays: number | null; classesPerPeriod: number | null }
export interface Pricing {
  packs: Array<{ id: string; name: string; credits: number; validityDays: number; price: Money; access: string; accessDetail?: AccessDetail }>;
  memberships: Array<{ id: string; name: string; classesPerPeriod: number | null; price: Money; access: string; accessDetail?: AccessDetail; terms: string[]; termsDetail?: TermsDetail }>;
  offers: Array<{ id: string; name: string; credits: number | null; validDays: number; price: Money; newCustomersOnly: boolean }>;
  policy: CustomerPolicy;
  location: { paymentsEnabled: boolean };
}
export interface BookingOptions {
  signedIn: boolean; price: Money; policy: CustomerPolicy; outstandingFees: number;
  credits: Array<{ id: string; name: string; creditsRemaining: number; creditsNeeded: number; usable: boolean; reason: string | null }>;
  memberships: Array<{ id: string; name: string; usable: boolean; reason: string | null; usage: { used: number; limit: number | null } | null }>;
}
export type PayWith = { kind: 'credit'; packId: string } | { kind: 'membership'; membershipId: string };
export interface OnlineClass { id: string; kind: 'livestream' | 'on_demand'; title: string; instructorName: string | null; startsAt: string | null; durationMinutes: number | null; rules: string[]; ruleCodes?: string[]; access?: { access: boolean; registered: boolean; needsRegistration: boolean; canJoin: boolean; reasons: string[]; reasonCodes?: string[]; purchasable: Money | null } }
export interface OccupancyRow { locationId: string; locationName: string; classes: number; occupancyPct: number | null }

/** `${locationId}~${occurrenceId}` (see src/lib/live.ts). */
const occOf = (composite: string) => decodeURIComponent(composite).split('~')[1] ?? composite;

const live = {
  entitlements: (locationId: string) => http<Entitlements & { customer: unknown }>('GET', `/me/studios/account?locationId=${locationId}`),
  pricing: (locationId: string) => http<Pricing>('GET', `/public/studios/${locationId}/pricing`, undefined, { auth: false }),
  options: (occ: string) => http<BookingOptions>('GET', `/me/studios/occurrences/${occOf(occ)}/options`),
  book: (occ: string, payWith: PayWith, joinWaitlist: boolean) => http<{ outcome: string; bookingId?: string; position?: number }>('POST', `/me/studios/occurrences/${occOf(occ)}/bookings`, { payWith, joinWaitlist }),
  buy: (locationId: string, kind: 'pack' | 'membership' | 'offer' | 'online', id: string) => http<{ purchase: { id: string; status: string }; payment: { id: string; sandbox: boolean; clientSecret?: string | null } | null }>('POST', '/me/studios/purchases', { locationId, kind, ...(kind === 'offer' ? { offerId: id } : { productId: id }) }),
  confirmSandbox: async (paymentId: string) => { await http('POST', `/public/payments/${paymentId}/sandbox-confirm`, { outcome: 'succeeded' }, { auth: false }); },
  purchaseStatus: (id: string) => http<{ status: string }>('GET', `/me/studios/purchases/${id}`),
  online: (locationId: string) => http<{ items: OnlineClass[] }>('GET', `/me/studios/online?locationId=${locationId}`).then((r) => r.items),
  register: async (id: string, locationId: string) => { await http('POST', `/me/studios/online/${id}/register`, { locationId }); },
  join: (id: string, locationId: string) => http<{ url: string; provider: string }>('POST', `/me/studios/online/${id}/join`, { locationId }),
  occupancy: async (): Promise<OccupancyRow[]> => {
    const me = await http<{ organizations: Array<{ id: string; industry: string }> }>('GET', '/auth/me');
    const orgs = me.organizations.filter((o) => o.industry === 'studios');
    return (await Promise.all(orgs.map((o) => http<{ next7: OccupancyRow[] }>('GET', `/orgs/${o.id}/studios/pulse`).then((r) => r.next7).catch(() => [] as OccupancyRow[])))).flat();
  },
};

export const studioApi = live;

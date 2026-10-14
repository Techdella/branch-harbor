/**
 * Studios full product on mobile: entitlements (packs / membership), buying, booking with a credit or
 * membership, online classes, the staff check-in roster labels and the owner's forward occupancy.
 * Live mode calls /v1/me/studios/* (signed-in customers), /v1/public/studios/* and /v1/orgs/:orgId/studios/*;
 * mock mode serves in-memory sample data so the screens work without the API.
 */
import { env } from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { http } from '@/lib/http';
import type { CustomerPolicy } from './policy';

export type Money = { amount: number; currency: string };
export interface Entitlements {
  memberships: Array<{ id: string; name: string; state: string; classesPerPeriod: number | null; usage: { used: number; limit: number | null } | null; price: (Money & { interval: string | null }) | null; graceUntil: string | null; cancelAt: string | null }>;
  packs: Array<{ id: string; name: string; creditsRemaining: number; creditsTotal: number; expiresAt: string | null; status: string }>;
  credits: { available: number };
  fees: Array<{ id: string; kind: string; amount: Money }>;
}
export interface Pricing {
  packs: Array<{ id: string; name: string; credits: number; validityDays: number; price: Money; access: string }>;
  memberships: Array<{ id: string; name: string; classesPerPeriod: number | null; price: Money; access: string; terms: string[] }>;
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
export interface OnlineClass { id: string; kind: 'livestream' | 'on_demand'; title: string; instructorName: string | null; startsAt: string | null; durationMinutes: number | null; rules: string[]; access?: { access: boolean; registered: boolean; needsRegistration: boolean; canJoin: boolean; reasons: string[]; purchasable: Money | null } }
export interface OccupancyRow { locationId: string; locationName: string; classes: number; occupancyPct: number | null }

/** `${locationId}~${occurrenceId}` (see src/lib/live.ts). */
const occOf = (composite: string) => decodeURIComponent(composite).split('~')[1] ?? composite;

const live = {
  entitlements: (locationId: string) => http<Entitlements & { customer: unknown }>('GET', `/me/studios/account?locationId=${locationId}`),
  pricing: (locationId: string) => http<Pricing>('GET', `/public/studios/${locationId}/pricing`, undefined, { auth: false }),
  options: (occ: string) => http<BookingOptions>('GET', `/me/studios/occurrences/${occOf(occ)}/options`),
  book: (occ: string, payWith: PayWith, joinWaitlist: boolean) => http<{ outcome: string; bookingId?: string; position?: number }>('POST', `/me/studios/occurrences/${occOf(occ)}/bookings`, { payWith, joinWaitlist }),
  buy: (locationId: string, kind: 'pack' | 'membership' | 'offer' | 'online', id: string) => http<{ purchase: { id: string; status: string }; payment: { id: string; sandbox: boolean } | null }>('POST', '/me/studios/purchases', { locationId, kind, ...(kind === 'offer' ? { offerId: id } : { productId: id }) }),
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

// ───────── Sample data ─────────
const wait = <T,>(v: T, ms = 300) => new Promise<T>((r) => setTimeout(() => r(JSON.parse(JSON.stringify(v)) as T), ms));
const CUR: Record<string, string> = { 'sw-qw': 'CAD', 'sw-ch': 'USD', 'sw-sd': 'GBP', 'sw-pb': 'EUR', 'sw-sh': 'AUD' };
const cur = (l: string) => CUR[l] ?? 'CAD';
const ent: Entitlements = {
  memberships: [], packs: [{ id: 'pk1', name: '5-class pack', creditsRemaining: 3, creditsTotal: 5, expiresAt: new Date(Date.now() + 40 * 86400_000).toISOString(), status: 'active' }], credits: { available: 3 }, fees: [],
};
const onlineMock: OnlineClass[] = [
  { id: 'on1', kind: 'livestream', title: 'Morning Vinyasa — live', instructorName: 'Maya Rao', startsAt: new Date(Date.now() + 86400_000).toISOString(), durationMinutes: 60, rules: ['Included with a membership', 'Included for class pack holders'], access: { access: true, registered: false, needsRegistration: true, canJoin: false, reasons: [], purchasable: null } },
  { id: 'on2', kind: 'on_demand', title: 'Hip Mobility for Desk Days', instructorName: 'Priya Shah', startsAt: null, durationMinutes: 30, rules: ['Included with a membership', 'Available to buy'], access: { access: false, registered: false, needsRegistration: false, canJoin: false, reasons: ['Members only'], purchasable: { amount: 900, currency: 'CAD' } } },
];
const mock: typeof live = {
  entitlements: async () => wait({ ...ent, customer: null }),
  pricing: async (l) => wait<Pricing>({
    location: { paymentsEnabled: true }, policy: { lines: ['Cancel at least 12 hours before the class starts to avoid a late cancellation.', 'Late cancellations with a class pack use the credit.'] },
    packs: [{ id: 'pp5', name: '5-class pack', credits: 5, validityDays: 90, price: { amount: 12500, currency: cur(l) }, access: 'Valid at every location in your currency' }, { id: 'pp10', name: '10-class pack', credits: 10, validityDays: 180, price: { amount: 23000, currency: cur(l) }, access: 'Valid at every location' }],
    memberships: [{ id: 'mpu', name: 'Unlimited', classesPerPeriod: null, price: { amount: 18900, currency: cur(l) }, access: 'Valid at every location in your currency', terms: ['Billed monthly until cancelled.', "Cancel with 30 days' notice."] }],
    offers: [{ id: 'of1', name: 'Intro week — 3 classes', credits: 3, validDays: 7, price: { amount: 2500, currency: cur(l) }, newCustomersOnly: true }],
  }),
  options: async () => wait<BookingOptions>({ signedIn: true, price: { amount: 2800, currency: 'CAD' }, outstandingFees: 0, policy: { lines: ['Cancel at least 12 hours before the class starts to avoid a late cancellation.'] }, memberships: [], credits: ent.packs.map((p) => ({ id: p.id, name: p.name, creditsRemaining: p.creditsRemaining, creditsNeeded: 1, usable: p.creditsRemaining > 0, reason: p.creditsRemaining > 0 ? null : 'No credits left' })) }),
  book: async (_o, pw) => { if (pw.kind === 'credit') { const p = ent.packs.find((x) => x.id === pw.packId); if (!p || p.creditsRemaining < 1) throw new ApiError(409, 'credit_not_usable', 'No credits left'); p.creditsRemaining -= 1; ent.credits.available -= 1; } return wait({ outcome: 'confirmed', bookingId: `b${Date.now()}` }); },
  buy: async (_l, kind, id) => { if (kind === 'pack') { const n = id === 'pp10' ? 10 : 5; ent.packs.push({ id: `pk${Date.now()}`, name: `${n}-class pack`, creditsRemaining: n, creditsTotal: n, expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString(), status: 'active' }); ent.credits.available += n; } if (kind === 'membership') ent.memberships.push({ id: `m${Date.now()}`, name: 'Unlimited', state: 'active', classesPerPeriod: null, usage: { used: 0, limit: null }, price: { amount: 18900, currency: 'CAD', interval: 'month' }, graceUntil: null, cancelAt: null }); return wait({ purchase: { id: 'pu1', status: 'paid' }, payment: null }); },
  confirmSandbox: async () => { await wait(null); },
  purchaseStatus: async () => wait({ status: 'paid' }),
  online: async () => wait(onlineMock),
  register: async (id) => { const c = onlineMock.find((x) => x.id === id); if (c?.access) { c.access.registered = true; c.access.canJoin = true; } await wait(null); },
  join: async () => wait({ url: 'https://zoom.us/j/0000000000?pwd=sample', provider: 'zoom' }),
  occupancy: async () => wait([{ locationId: 'sw-qw', locationName: 'Queen West', classes: 31, occupancyPct: 58.2 }, { locationId: 'sw-ch', locationName: 'Capitol Hill', classes: 31, occupancyPct: 61.4 }, { locationId: 'sw-sd', locationName: 'Shoreditch', classes: 29, occupancyPct: null }]),
};

export const studioApi = env.useMocks ? mock : live;

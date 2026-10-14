/**
 * Wellness (mobile): customer booking / reschedule / packages, practitioner day + check-in + notes, owner utilisation.
 * Live: /v1 wellness routes (see apps/api/README.md). Mock: small in-memory sample so the screens run without the API.
 */
import { env } from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { http } from '@/lib/http';
import { payPayment, type PayablePayment, type Translate } from '@/lib/cardPayment';
/** Money as returned by the API (currency is any ISO code). */
export type Money = { amount: number; currency: string };

export interface WLocation { id: string; name: string; timeZone: string; currency: string; city: string }
export interface WVariant { id: string; name: string; durationMinutes: number; price: Money; deposit: Money }
export interface WService { id: string; name: string; description: string | null; category: string | null; durationMinutes: number; price: Money; deposit: Money; practitionersRequired: number; variants: WVariant[]; cancellationPolicy: string | null; practitioners: { id: string; name: string }[] }
export interface WSlot { startsAt: string; endsAt: string; practitionerIds: string[] }
export interface Preview { window: string; fee: Money; deposit: { paid: number; refund: number; retained: number; currency: string }; packageSession: string | null; outstanding: Money }
export interface MyAppointment { id: string; startsAt: string; endsAt: string; status: string; serviceName: string; practitionerName: string; businessName: string; serviceId: string; variantId: string | null; location: { id: string; name: string; timeZone: string }; price: Money; cancellation: Preview | null; canReschedule: boolean; cancellationPolicy: string | null }
export interface MyPackage { id: string; name: string | null; sessionsRemaining: number; sessionsTotal: number; expiresAt: string | null; status: string; sharedWithMe?: boolean; price: Money }
export interface MyVoucher { id: string; code: string; balance: Money; expiresAt: string; status: string }
export interface DayItem { id: string; startsAt: string; endsAt: string; status: string; serviceName: string; clientName: string; checkedInAt: string | null; customerId: string; location: { id: string; name: string; timeZone: string }; orgId: string }
export interface UtilLoc { orgId: string; orgName: string; locationId: string; locationName: string; currency: string; practitioners: { name: string; rate: number | null; bookedMinutes: number }[]; rooms: { name: string; rate: number | null }[]; avgRate: number | null }

interface RawOrg { id: string; name: string; slug: string; industry: string; roles: { role: string }[] }

const today = () => new Date().toISOString().slice(0, 10);
const sleep = <T,>(v: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(v), ms));

const live = {
  async locations(): Promise<WLocation[]> {
    const r = await http<{ locations?: Array<{ id: string; name: string; timeZone: string; currency: string; address?: { city?: string } }>; items?: Array<{ id: string; name: string; timeZone: string; currency: string; address?: { city?: string } }> }>('GET', `/public/locations/${env.wellnessSlug}`, undefined, { auth: false });
    return (r.locations ?? r.items ?? []).map((l) => ({ id: l.id, name: l.name, timeZone: l.timeZone, currency: l.currency, city: l.address?.city ?? '' }));
  },
  async services(locationId: string): Promise<WService[]> {
    return (await http<{ items: WService[] }>('GET', `/public/wellness/${locationId}/services`, undefined, { auth: false })).items;
  },
  async slots(locationId: string, serviceId: string, date: string, variantId?: string): Promise<WSlot[]> {
    const q = new URLSearchParams({ serviceId, date, ...(variantId ? { variantId } : {}) });
    return (await http<{ slots: WSlot[] }>('GET', `/public/wellness/${locationId}/availability?${q}`, undefined, { auth: false })).slots;
  },
  async book(locationId: string, input: { serviceId: string; variantId?: string; startsAt: string; contact: { name: string; email: string }; voucherCode?: string; packageId?: string }) {
    return http<{ appointment: { id: string }; payment: { id: string; sandbox: boolean; amount: number; currency: string; clientSecret?: string | null } | null; summary: { depositDue: Money; dueAtVisit: Money } }>('POST', `/public/wellness/${locationId}/appointments`, input, { auth: false });
  },
  /** Deposit: PaymentSheet on iOS/Android (sandbox: simulated); resolves once the API has the signed webhook. */
  async pay(payment: PayablePayment, t?: Translate) {
    return payPayment(payment, t);
  },
  async myAppointments(): Promise<MyAppointment[]> {
    return (await http<{ items: MyAppointment[] }>('GET', '/me/wellness/appointments')).items;
  },
  async cancel(id: string, acceptPolicy: boolean) {
    return http<{ cancellation: Preview; payment: { action: string } }>('POST', `/me/wellness/appointments/${id}/cancel`, { acceptPolicy });
  },
  async reschedule(id: string, startsAt: string) {
    return http<{ appointment: { id: string } }>('POST', `/me/wellness/appointments/${id}/reschedule`, { startsAt });
  },
  async myPackages(): Promise<{ packages: MyPackage[]; vouchers: MyVoucher[] }> {
    return http('GET', '/me/wellness/packages');
  },
  async orgs(): Promise<RawOrg[]> {
    return (await http<{ organizations: RawOrg[] }>('GET', '/auth/me')).organizations.filter((o) => o.industry === 'wellness');
  },
  async myDay(date?: string): Promise<DayItem[]> {
    const out: DayItem[] = [];
    for (const o of await live.orgs()) {
      const r = await http<{ items: Omit<DayItem, 'orgId' | 'clientName'> & { clientName: string }[] }>('GET', `/orgs/${o.id}/wellness/my-day${date ? `?date=${date}` : ''}`).catch(() => ({ items: [] as never[] }));
      out.push(...(r.items as unknown as DayItem[]).map((x) => ({ ...x, orgId: o.id })));
    }
    return out;
  },
  async checkIn(orgId: string, id: string) {
    await http('POST', `/orgs/${orgId}/wellness/appointments/${id}/check-in`, {});
  },
  async addNote(orgId: string, customerId: string, locationId: string, body: string, confidential: boolean) {
    await http('POST', `/orgs/${orgId}/wellness/clients/${customerId}/notes`, { locationId, body, confidential });
  },
  async utilisation(): Promise<UtilLoc[]> {
    const out: UtilLoc[] = [];
    const to = today();
    const from = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
    for (const o of await live.orgs()) {
      const locs = await http<{ items: { id: string; name: string; currency: string }[] }>('GET', `/orgs/${o.id}/locations`).catch(() => ({ items: [] }));
      for (const l of locs.items) {
        const u = await http<{ practitioners: { name: string; rate: number | null; bookedMinutes: number; availableMinutes: number }[]; rooms: { name: string; rate: number | null }[] }>('GET', `/orgs/${o.id}/wellness/utilisation?from=${from}&to=${to}&locationId=${l.id}`).catch(() => null);
        if (!u) continue;
        const booked = u.practitioners.reduce((s, p) => s + p.bookedMinutes, 0);
        const avail = u.practitioners.reduce((s, p) => s + p.availableMinutes, 0);
        out.push({ orgId: o.id, orgName: o.name, locationId: l.id, locationName: l.name, currency: l.currency, practitioners: u.practitioners, rooms: u.rooms, avgRate: avail ? booked / avail : null });
      }
    }
    return out;
  },
};

// ───────────── mock ─────────────
const M = {
  locs: [{ id: 'hw-tor', name: 'Harbourline Yorkville', timeZone: 'America/Toronto', currency: 'CAD', city: 'Toronto' }, { id: 'hw-dub', name: 'Harbourline Dublin 2', timeZone: 'Europe/Dublin', currency: 'EUR', city: 'Dublin' }],
  appts: [] as MyAppointment[],
  day: [] as DayItem[],
};
const svcFor = (l: WLocation): WService[] => {
  const p = (n: number) => ({ amount: n, currency: l.currency });
  return [
    { id: `${l.id}-m`, name: 'Restorative massage', description: 'Slow, full-body massage in a private room.', category: 'Massage', durationMinutes: 60, price: p(11000), deposit: p(2200), practitionersRequired: 1, cancellationPolicy: 'Free cancellation up to 24 hours before.', practitioners: [{ id: 'p1', name: 'Priya Shah' }, { id: 'p2', name: 'Daniel Moreau' }], variants: [{ id: `${l.id}-m60`, name: '60 min', durationMinutes: 60, price: p(11000), deposit: p(2200) }, { id: `${l.id}-m90`, name: '90 min', durationMinutes: 90, price: p(15500), deposit: p(3100) }] },
    { id: `${l.id}-b`, name: 'Guided breathwork (1:1)', description: 'A guided breathing session.', category: 'Breathwork', durationMinutes: 30, price: p(5500), deposit: p(0), practitionersRequired: 1, cancellationPolicy: 'Free cancellation up to 12 hours before.', practitioners: [{ id: 'p1', name: 'Priya Shah' }], variants: [] },
  ];
};
(() => {
  const s = new Date(Date.now() + 2 * 86400_000); s.setUTCMinutes(0, 0, 0);
  const tor = M.locs[0]!;
  M.appts.push({ id: 'ma1', startsAt: s.toISOString(), endsAt: new Date(s.getTime() + 3600_000).toISOString(), status: 'confirmed', serviceName: 'Restorative massage', practitionerName: 'Priya Shah', businessName: 'Harbourline Wellness', serviceId: `${tor.id}-m`, variantId: null, location: tor, price: { amount: 11000, currency: 'CAD' }, cancellation: { window: 'free', fee: { amount: 0, currency: 'CAD' }, deposit: { paid: 2200, refund: 2200, retained: 0, currency: 'CAD' }, packageSession: null, outstanding: { amount: 0, currency: 'CAD' } }, canReschedule: true, cancellationPolicy: 'Free cancellation up to 24 hours before.' });
  for (const [i, h] of [1, 3, 5].entries()) {
    const st = new Date(Date.now() + h * 3600_000 - (i === 0 ? 2 * 3600_000 : 0)); st.setUTCMinutes(0, 0, 0);
    M.day.push({ id: `d${i}`, startsAt: st.toISOString(), endsAt: new Date(st.getTime() + 3600_000).toISOString(), status: 'confirmed', serviceName: ['Restorative massage', 'Reflexology', 'Hot stone massage'][i]!, clientName: ['Clara Byrne', 'Hugo Lambert', 'Mei Tanaka'][i]!, checkedInAt: null, customerId: `c${i}`, location: tor, orgId: 'org' });
  }
})();
const mock: typeof live = {
  locations: async () => sleep(M.locs),
  services: async (id) => sleep(svcFor(M.locs.find((l) => l.id === id) ?? M.locs[0]!)),
  slots: async (_l, _s, date) => sleep([10, 11, 13, 15, 16].map((h) => ({ startsAt: `${date}T${String(h + 4).padStart(2, '0')}:00:00.000Z`, endsAt: `${date}T${String(h + 5).padStart(2, '0')}:00:00.000Z`, practitionerIds: ['p1'] })).filter((s) => Date.parse(s.startsAt) > Date.now())),
  book: async (locationId, input) => {
    const l = M.locs.find((x) => x.id === locationId)!;
    const s = svcFor(l).find((x) => x.id === input.serviceId)!;
    const v = s.variants.find((x) => x.id === input.variantId);
    const price = v?.price ?? s.price;
    M.appts.unshift({ id: `ma${Date.now()}`, startsAt: input.startsAt, endsAt: new Date(Date.parse(input.startsAt) + (v?.durationMinutes ?? s.durationMinutes) * 60_000).toISOString(), status: 'confirmed', serviceName: s.name, practitionerName: s.practitioners[0]!.name, businessName: 'Harbourline Wellness', serviceId: s.id, variantId: v?.id ?? null, location: l, price, cancellation: null, canReschedule: true, cancellationPolicy: s.cancellationPolicy });
    const dep = (v?.deposit ?? s.deposit);
    return sleep({ appointment: { id: M.appts[0]!.id }, payment: dep.amount ? { id: 'pay_mock', sandbox: true, amount: dep.amount, currency: dep.currency } : null, summary: { depositDue: dep, dueAtVisit: { amount: price.amount - dep.amount, currency: price.currency } } });
  },
  pay: async () => sleep({ ok: true as const }),
  myAppointments: async () => sleep(M.appts),
  cancel: async (id, accept) => {
    const a = M.appts.find((x) => x.id === id);
    if (!a) throw new ApiError(404, 'not_found', 'Appointment not found');
    if (a.cancellation && a.cancellation.fee.amount > 0 && !accept) throw new ApiError(409, 'policy_acceptance_required', 'A late-cancellation fee applies.');
    a.status = 'cancelled';
    return sleep({ cancellation: a.cancellation!, payment: { action: 'refunded' } });
  },
  reschedule: async (id, startsAt) => { const a = M.appts.find((x) => x.id === id)!; a.startsAt = startsAt; a.endsAt = new Date(Date.parse(startsAt) + 3600_000).toISOString(); return sleep({ appointment: { id } }); },
  myPackages: async () => sleep({ packages: [{ id: 'pk1', name: '5 × Restorative massage (60 min)', sessionsRemaining: 3, sessionsTotal: 5, expiresAt: new Date(Date.now() + 140 * 86400_000).toISOString(), status: 'active', price: { amount: 49500, currency: 'CAD' } }], vouchers: [{ id: 'v1', code: 'GV-YORK-4821', balance: { amount: 7500, currency: 'CAD' }, expiresAt: new Date(Date.now() + 300 * 86400_000).toISOString(), status: 'active' }] }),
  orgs: async () => sleep([{ id: 'org', name: 'Harbourline Wellness', slug: 'harbourline-wellness', industry: 'wellness', roles: [] }]),
  myDay: async () => sleep(M.day),
  checkIn: async (_o, id) => { const d = M.day.find((x) => x.id === id); if (d) d.checkedInAt = new Date().toISOString(); await sleep(null); },
  addNote: async () => { await sleep(null); },
  utilisation: async () => sleep(M.locs.map((l, i) => ({ orgId: 'org', orgName: 'Harbourline Wellness', locationId: l.id, locationName: l.name, currency: l.currency, practitioners: [{ name: 'Priya Shah', rate: 0.72 - i * 0.1, bookedMinutes: 1200 }, { name: 'Daniel Moreau', rate: 0.48, bookedMinutes: 800 }], rooms: [{ name: 'Treatment room 1', rate: 0.55 }, { name: 'Couples suite', rate: i ? null : 0.2 }], avgRate: 0.6 - i * 0.05 }))),
};

export const wellnessApi = env.useMocks ? mock : live;

/**
 * Wellness (mobile): customer booking / reschedule / packages, practitioner day + check-in + notes, owner utilisation.
 * /v1 wellness routes (see apps/api/README.md).
 */
import { env } from '@/lib/env';
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

export const wellnessApi = live;

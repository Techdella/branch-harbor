/**
 * Sample wellness data (no API). Stateful in memory, built from the organisation's locations so currencies and time
 * zones match. Implements the same rules as the server in simplified form: buffers, practitioner/room conflicts,
 * policy previews, package/voucher balances, confidential notes, AI drafts marked as samples.
 */
import { ApiError } from '../errors';
import { addDays, dateInZone, zonedToUtc } from '../format';
import type { Location } from '../types';
import type { WellnessApi } from './api';
import type {
  CalAppointment, CalendarDay, CancellationPreview, ClientNote, ClientPackage, ClientRow, Draft, ImpactItem, PackagePlan, Policy, Voucher, WaitlistEntry, WException, WPractitioner,
  WReport, WResource, WService, Window,
} from './types';

const MIN = 60_000;
const DAY = 86400_000;
const delay = <T,>(v: T, ms = 220) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const POLICY: Policy = { freeCancelHours: 24, lateCancelFeePercent: 50, noShowFeePercent: 100, depositRefundable: true };
const POLICY_TEXT = 'Free cancellation or changes up to 24 hours before. Later cancellations are charged 50%; missed appointments 100%. Any deposit is used towards that charge.';
const BASE: Record<string, number> = { CAD: 11000, USD: 9500, GBP: 7000, EUR: 8500, AUD: 13000 };
const notFoundErr = (what: string) => new ApiError('not_found', `${what} not found`, 404);

interface Appt { id: string; locationId: string; serviceId: string; variantId: string | null; practitionerId: string; resourceId: string | null; customerId: string; startsAt: number; endsAt: number; from: number; until: number; status: string; priceMinor: number; currency: string; depositMinor: number; voucherAppliedMinor: number; clientPackageId: string | null; groupId: string | null; checkedInAt: string | null; cancellationKind: string | null; paid: number }

export function createWellnessMock(locations: Location[]): WellnessApi {
  const locs = locations.filter((l) => l.site === 'live' || locations.length < 3).slice(0, 6);
  const L = locs.length ? locs : locations;
  const services: WService[] = [];
  const mkSvc = (name: string, category: string, minutes: number, after: number, factor: number, extra: Partial<WService> = {}): WService => {
    const svc: WService = {
      id: uid('svc'), locationId: null, name, description: null, category, durationMinutes: minutes, bufferBeforeMinutes: 0, bufferAfterMinutes: after, priceMinor: 0, depositMinor: 0, currency: L[0]?.currency ?? 'CAD',
      requiredResourceType: 'room', equipmentTypes: [], cancellationPolicy: POLICY_TEXT, onlineBookable: true, practitionersRequired: 1, depositRule: null, policy: POLICY, rebookAfterWeeks: 6, active: true, variants: [], ...extra,
    };
    const durations = name === 'Restorative massage' ? [60, 90] : [minutes];
    svc.variants = durations.map((d, i) => ({ id: uid('var'), name: `${d} min`, durationMinutes: d, bufferBeforeMinutes: null, bufferAfterMinutes: d > 60 ? 20 : null, sortOrder: i, active: true, prices: L.map((l) => ({ locationId: l.id, priceMinor: Math.round(((BASE[l.currency] ?? 10000) * factor * d) / 60 / 500) * 500, depositMinor: null, currency: l.currency })) }));
    services.push(svc);
    return svc;
  };
  const massage = mkSvc('Restorative massage', 'Massage', 60, 15, 1, { depositRule: { kind: 'percent', value: 20 }, description: 'Slow, full-body massage with warm oils in a private treatment room.' });
  const reflex = mkSvc('Reflexology', 'Massage', 45, 10, 0.95, { description: 'Focused pressure work on the feet in a reclining chair.' });
  const breath = mkSvc('Guided breathwork (1:1)', 'Breathwork', 30, 5, 1, { requiredResourceType: null, description: 'A guided one-to-one breathing session.' });
  const duo = mkSvc('Side-by-side massage', 'Massage', 60, 15, 0.95, { practitionersRequired: 2, depositRule: { kind: 'percent', value: 25 }, description: 'Two guests, two practitioners, one shared suite. Price per guest.' });
  const stone = mkSvc('Hot stone massage', 'Massage', 75, 20, 1.2, { equipmentTypes: ['stone_kit'], description: 'Massage using smooth, heated stones.' });

  const names = [['Priya Shah', 'Daniel Moreau', 'Aiko Tanaka'], ['Niamh Byrne', 'Cian Walsh', 'Róisín Kelly'], ['Grace Nguyen', 'Oliver Hart', 'Mia Russo'], ['Hannah Weiss', 'Tom Becker', 'Lea Fischer'], ['Ana Costa', 'Rui Silva', 'Inês Matos']];
  const pracs: WPractitioner[] = [];
  const resources: WResource[] = [];
  L.forEach((l, i) => {
    names[i % names.length]!.forEach((n, k) => pracs.push({ id: uid('prac'), name: n, locationId: l.id, userId: null, active: true, serviceIds: services.map((s) => s.id).filter((s) => k === 0 || s !== reflex.id), locations: [{ locationId: l.id, home: true, availability: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: k === 1 ? '12:00' : '09:00', end: k === 1 ? '20:00' : '17:00' })) }] }));
    for (const r of ['Treatment room 1', 'Treatment room 2', 'Couples suite']) resources.push({ id: uid('res'), locationId: l.id, name: r, type: 'room', active: true });
    resources.push({ id: uid('res'), locationId: l.id, name: 'Hot stone kit A', type: 'stone_kit', active: true });
  });
  const clients: Array<ClientRow & { notes: ClientNote[]; prefs: { preferredPractitionerIds: string[]; preferredChannel: 'email' | 'sms'; comfort: string[]; preferredLocationId: string | null } | null }> = [];
  L.forEach((l) => ['Clara Byrne', 'Hugo Lambert', 'Mei Tanaka', 'Rosa Alvarez', 'Finn O’Brien', 'Ines Duarte'].forEach((n, i) => clients.push({
    id: uid('cus'), name: n, email: `${n.split(' ')[0]!.toLowerCase()}@example.com`, phone: null, locationId: l.id, visits: 0, nextAppointmentAt: null, lastVisitAt: null, activePackages: 0,
    notes: i === 0 ? [{ id: uid('note'), body: 'Likes a 5-minute heads-up before the session ends.', confidential: false, locationId: l.id, appointmentId: null, mine: false, createdAt: new Date().toISOString() }, { id: uid('note'), body: 'Asked us to keep visits private from a family member. Do not mention visits.', confidential: true, locationId: l.id, appointmentId: null, mine: true, createdAt: new Date().toISOString() }] : [],
    prefs: i === 0 ? { preferredPractitionerIds: [], preferredChannel: 'sms', comfort: ['Quiet room', 'Prefers mornings'], preferredLocationId: l.id } : null,
  })));

  const appts: Appt[] = [];
  const variantFor = (svc: WService, variantId?: string | null) => svc.variants.find((v) => v.id === variantId) ?? svc.variants[0]!;
  const priceAt = (svc: WService, variantId: string | null | undefined, locationId: string) => {
    const v = variantFor(svc, variantId);
    const p = v.prices.find((x) => x.locationId === locationId);
    if (!p) throw new ApiError('not_offered_here', 'This service option is not offered at this location', 409);
    const dep = svc.depositRule?.kind === 'percent' ? Math.round((p.priceMinor * svc.depositRule.value) / 100) : svc.depositRule?.kind === 'fixed' ? svc.depositRule.value : 0;
    return { v, price: p.priceMinor, currency: p.currency, deposit: dep };
  };
  const exceptions: Array<WException> = [];
  const locOf = (id: string) => L.find((l) => l.id === id)!;
  const pracsAt = (lid: string) => pracs.filter((p) => p.locations.some((x) => x.locationId === lid));
  const winsAt = (p: WPractitioner, lid: string) => p.locations.find((x) => x.locationId === lid)?.availability ?? [];
  const inWindows = (wins: Window[], tz: string, s: number, e: number) => {
    const d = dateInZone(new Date(s), tz);
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    return wins.some((w) => w.weekday === wd && Date.parse(zonedToUtc(d, w.start, tz)) <= s && e <= Date.parse(zonedToUtc(d, w.end === '24:00' ? '23:59' : w.end, tz)) + (w.end === '24:00' ? MIN : 0));
  };
  const pracBusy = (pid: string, from: number, until: number, ignore: string[] = []) => appts.some((a) => a.status === 'confirmed' && a.practitionerId === pid && !ignore.includes(a.id) && a.from < until && a.until > from);
  const resBusy = (rid: string, from: number, until: number, ignore: string[] = []) => appts.some((a) => a.status === 'confirmed' && a.resourceId === rid && !ignore.includes(a.id) && a.from < until && a.until > from);
  const onLeave = (pid: string, s: number, e: number) => exceptions.some((x) => x.practitionerId === pid && Date.parse(x.startsAt) < e && Date.parse(x.endsAt) > s);

  function reserve(input: { locationId: string; serviceId: string; variantId?: string | null; practitionerId?: string | null; customerId: string; startsAt: number; resourceId?: string | null; enforce?: boolean; ignore?: string[] }): Appt[] {
    const svc = services.find((s) => s.id === input.serviceId);
    if (!svc) throw notFoundErr('Service');
    const loc = locOf(input.locationId);
    const p = priceAt(svc, input.variantId, loc.id);
    const after = (p.v.bufferAfterMinutes ?? svc.bufferAfterMinutes) * MIN;
    const s = input.startsAt;
    const e = s + p.v.durationMinutes * MIN;
    const from = s - svc.bufferBeforeMinutes * MIN;
    const until = e + after;
    if (s <= Date.now()) throw new ApiError('validation_failed', 'Choose a time in the future', 400);
    const need = svc.practitionersRequired;
    const cands = pracsAt(loc.id).filter((x) => x.serviceIds.includes(svc.id) && (!input.practitionerId || x.id === input.practitionerId) && (input.enforce === false || (inWindows(winsAt(x, loc.id), loc.timeZone, s, e) && !onLeave(x.id, s, e))) && !pracBusy(x.id, from, until, input.ignore));
    if (cands.length < need) throw new ApiError('slot_unavailable', need > 1 ? 'Two practitioners are not available at that time' : 'No practitioner is available at that time', 409);
    let room: WResource | null = null;
    if (svc.requiredResourceType) {
      const rooms = resources.filter((r) => r.locationId === loc.id && r.type === 'room' && !resBusy(r.id, from, until, input.ignore)).sort((a, b) => (a.id === input.resourceId ? -1 : b.id === input.resourceId ? 1 : 0));
      room = rooms[0] ?? null;
      if (!room) throw new ApiError('slot_unavailable', 'No room is free at that time', 409);
    }
    const groupId = need > 1 ? uid('grp') : null;
    return cands.slice(0, need).map((c, i) => {
      const a: Appt = { id: uid('ap'), locationId: loc.id, serviceId: svc.id, variantId: p.v.id, practitionerId: c.id, resourceId: i === 0 ? room?.id ?? null : null, customerId: input.customerId, startsAt: s, endsAt: e, from, until, status: 'confirmed', priceMinor: p.price, currency: p.currency, depositMinor: p.deposit, voucherAppliedMinor: 0, clientPackageId: null, groupId, checkedInAt: null, cancellationKind: null, paid: 0 };
      appts.push(a);
      return a;
    });
  }
  // Seed a working week per location.
  L.forEach((l) => {
    const cs = clients.filter((c) => c.locationId === l.id);
    for (let d = -2; d <= 6; d++) {
      const date = addDays(dateInZone(new Date(), l.timeZone), d);
      for (const [k, slot] of [['10:00', massage], ['12:30', reflex], ['13:00', breath], ['15:00', massage], ['17:00', stone]].entries()) {
        const [time, svc] = slot as [string, WService];
        const start = Date.parse(zonedToUtc(date, time, l.timeZone));
        try {
          const made = start > Date.now() ? reserve({ locationId: l.id, serviceId: svc.id, customerId: cs[(d + k + 6) % cs.length]!.id, startsAt: start, enforce: false }) : (() => {
            const p = priceAt(svc, null, l.id);
            const a: Appt = { id: uid('ap'), locationId: l.id, serviceId: svc.id, variantId: p.v.id, practitionerId: pracsAt(l.id)[k % 3]!.id, resourceId: resources.find((r) => r.locationId === l.id && r.type === 'room')!.id, customerId: cs[(d + k + 6) % cs.length]!.id, startsAt: start, endsAt: start + p.v.durationMinutes * MIN, from: start, until: start + (p.v.durationMinutes + 10) * MIN, status: (d + k) % 7 === 0 ? 'no_show' : 'completed', priceMinor: p.price, currency: p.currency, depositMinor: 0, voucherAppliedMinor: 0, clientPackageId: null, groupId: null, checkedInAt: null, cancellationKind: (d + k) % 7 === 0 ? 'no_show' : null, paid: 0 };
            appts.push(a);
            return [a];
          })();
          if (k === 0 && d === 1) made.forEach((a) => (a.paid = a.depositMinor));
        } catch { /* busy */ }
      }
    }
  });
  const first = L[0]!;
  const daniel = pracsAt(first.id)[1];
  if (daniel) {
    const date = addDays(dateInZone(new Date(), first.timeZone), 3);
    exceptions.push({ id: uid('ex'), practitionerId: daniel.id, practitionerName: daniel.name, locationId: null, startsAt: zonedToUtc(date, '00:00', first.timeZone), endsAt: zonedToUtc(addDays(date, 1), '00:00', first.timeZone), kind: 'leave', reason: 'Annual leave', affected: 0 });
  }
  const plans: PackagePlan[] = L.flatMap((l) => {
    const p = priceAt(massage, null, l.id).price;
    const b = priceAt(breath, null, l.id).price;
    return [
      { id: uid('plan'), locationId: l.id, name: '5 × Restorative massage (60 min)', description: 'Five sessions, valid 6 months.', serviceId: massage.id, variantId: null, sessions: 5, price: { amount: Math.round((p * 4.5) / 500) * 500, currency: l.currency }, perSession: { amount: Math.round((p * 0.9) / 100) * 100, currency: l.currency }, validityDays: 180, sharing: 'personal', maxSharedWith: 0, onlinePurchasable: true, active: true, sold: 4 },
      { id: uid('plan'), locationId: l.id, name: '3 × Guided breathwork', description: 'Share with one other person.', serviceId: breath.id, variantId: null, sessions: 3, price: { amount: Math.round((b * 2.7) / 500) * 500, currency: l.currency }, perSession: { amount: Math.round((b * 0.9) / 100) * 100, currency: l.currency }, validityDays: 120, sharing: 'shareable', maxSharedWith: 1, onlinePurchasable: true, active: true, sold: 2 },
    ];
  });
  const packages: ClientPackage[] = L.flatMap((l) => {
    const cs = clients.filter((c) => c.locationId === l.id);
    const pl = plans.filter((p) => p.locationId === l.id);
    return [
      { id: uid('cp'), planId: pl[0]!.id, name: pl[0]!.name, serviceId: massage.id, customerId: cs[0]!.id, clientName: cs[0]!.name, locationId: l.id, sessionsTotal: 5, sessionsUsed: 2, sessionsRemaining: 3, price: pl[0]!.price, purchasedAt: new Date(Date.now() - 40 * DAY).toISOString(), expiresAt: new Date(Date.now() + 140 * DAY).toISOString(), status: 'active', sharing: 'personal', sharedWithCustomerIds: [] },
      { id: uid('cp'), planId: pl[1]!.id, name: pl[1]!.name, serviceId: breath.id, customerId: cs[1]!.id, clientName: cs[1]!.name, locationId: l.id, sessionsTotal: 3, sessionsUsed: 1, sessionsRemaining: 2, price: pl[1]!.price, purchasedAt: new Date(Date.now() - 20 * DAY).toISOString(), expiresAt: new Date(Date.now() + 9 * DAY).toISOString(), status: 'active', sharing: 'shareable', sharedWithCustomerIds: [cs[2]!.id] },
      { id: uid('cp'), planId: pl[0]!.id, name: pl[0]!.name, serviceId: massage.id, customerId: cs[3]!.id, clientName: cs[3]!.name, locationId: l.id, sessionsTotal: 5, sessionsUsed: 3, sessionsRemaining: 2, price: pl[0]!.price, purchasedAt: new Date(Date.now() - 200 * DAY).toISOString(), expiresAt: new Date(Date.now() - 20 * DAY).toISOString(), status: 'expired', sharing: 'personal', sharedWithCustomerIds: [] },
    ];
  });
  const vouchers: Voucher[] = L.map((l, i) => ({ id: uid('gv'), code: `GV-${l.code.replace(/[^A-Z]/g, '').slice(0, 4).padEnd(4, 'X')}-48${i}1`, locationId: l.id, initial: { amount: 15000, currency: l.currency }, balance: { amount: 7500, currency: l.currency }, expiresAt: new Date(Date.now() + 300 * DAY).toISOString(), status: 'active', recipientName: 'A friend', recipientEmail: null, message: null, createdAt: new Date(Date.now() - 60 * DAY).toISOString(), transactions: [] }));
  const waitlist: WaitlistEntry[] = L.map((l) => ({ id: uid('wl'), locationId: l.id, serviceId: massage.id, serviceName: massage.name, clientName: 'Tom Gallagher', windowStart: zonedToUtc(addDays(dateInZone(new Date(), l.timeZone), 2), '09:00', l.timeZone), windowEnd: zonedToUtc(addDays(dateInZone(new Date(), l.timeZone), 2), '13:00', l.timeZone), status: 'waiting', offeredStartsAt: null }));

  const ser = (a: Appt) => ({ id: a.id, locationId: a.locationId, serviceId: a.serviceId, variantId: a.variantId, practitionerId: a.practitionerId, resourceId: a.resourceId, customerId: a.customerId, startsAt: new Date(a.startsAt).toISOString(), endsAt: new Date(a.endsAt).toISOString(), status: a.status, price: { amount: a.priceMinor, currency: a.currency }, deposit: { amount: a.depositMinor, currency: a.currency }, voucherApplied: { amount: a.voucherAppliedMinor, currency: a.currency }, clientPackageId: a.clientPackageId, groupId: a.groupId, seriesId: null, source: 'web', checkedInAt: a.checkedInAt, cancellationKind: a.cancellationKind, paymentId: a.paid ? 'pay_sample' : null });
  const apptById = (id: string) => { const a = appts.find((x) => x.id === id); if (!a) throw notFoundErr('Appointment'); return a; };
  const preview = (a: Appt, mode: 'auto' | 'business' | 'no_show', waive = false): CancellationPreview => {
    const hours = (a.startsAt - Date.now()) / 3600_000;
    const window = mode === 'business' ? 'business' : mode === 'no_show' ? 'no_show' : hours >= POLICY.freeCancelHours ? 'free' : 'late';
    const c = a.currency;
    const fee = window === 'late' || window === 'no_show' ? (waive || a.clientPackageId ? 0 : Math.round((a.priceMinor * (window === 'no_show' ? 100 : 50)) / 100)) : 0;
    const ret = Math.min(a.paid, fee);
    const vRet = Math.min(a.voucherAppliedMinor, fee - ret);
    return { window, hoursBeforeStart: Math.round(hours * 10) / 10, policy: POLICY, policyText: POLICY_TEXT, price: { amount: a.priceMinor, currency: c }, fee: { amount: fee, currency: c }, deposit: { paid: a.paid, refund: a.paid - ret, retained: ret, currency: c, paymentState: a.paid ? 'succeeded' : null }, voucher: { applied: a.voucherAppliedMinor, returned: a.voucherAppliedMinor - vRet, retained: vRet, currency: c }, packageSession: a.clientPackageId ? (window === 'free' || window === 'business' ? 'returned' : 'forfeited') : null, outstanding: { amount: fee - ret - vRet, currency: c } };
  };
  const minutesIn = (wins: { start: string; end: string }[]) => wins.reduce((s, w) => s + (Number(w.end.slice(0, 2)) * 60 + Number(w.end.slice(3))) - (Number(w.start.slice(0, 2)) * 60 + Number(w.start.slice(3))), 0);
  const dayOf = (locationId: string, date: string): CalendarDay => {
    const l = locOf(locationId);
    const from = Date.parse(zonedToUtc(date, '00:00', l.timeZone));
    const until = from + DAY;
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
    const list = appts.filter((a) => a.locationId === l.id && a.startsAt >= from && a.startsAt < until && a.status !== 'rescheduled');
    const cal: CalAppointment[] = list.map((a) => {
      const svc = services.find((s) => s.id === a.serviceId)!;
      const room = resources.find((r) => r.id === (a.resourceId ?? list.find((x) => x.groupId && x.groupId === a.groupId && x.resourceId)?.resourceId));
      return { ...ser(a), serviceName: svc.name, variantName: svc.variants.find((v) => v.id === a.variantId)?.name ?? null, practitionerName: pracs.find((p) => p.id === a.practitionerId)!.name, clientName: clients.find((c) => c.id === a.customerId)?.name ?? null, clientVisible: true, roomId: room?.id ?? null, roomName: room?.name ?? null, equipment: svc.equipmentTypes.length ? [{ id: 'kit', name: 'Hot stone kit A' }] : [], mine: false };
    });
    const booked = (pred: (a: CalAppointment) => boolean) => cal.filter((a) => ['confirmed', 'completed', 'no_show'].includes(a.status) && pred(a)).reduce((s, a) => s + (Date.parse(a.endsAt) - Date.parse(a.startsAt)) / MIN, 0);
    const pr = pracsAt(l.id).map((p) => {
      const wins = winsAt(p, l.id).filter((w) => w.weekday === wd).map((w) => ({ start: w.start, end: w.end }));
      const exc = exceptions.filter((x) => x.practitionerId === p.id && Date.parse(x.startsAt) < until && Date.parse(x.endsAt) > from);
      const avail = exc.length ? 0 : minutesIn(wins);
      const b = booked((a) => a.practitionerId === p.id);
      return { id: p.id, name: p.name, kind: 'practitioner' as const, home: true, userId: null, windows: wins, exceptions: exc.map((x) => ({ id: x.id, kind: x.kind, startsAt: x.startsAt, endsAt: x.endsAt, reason: x.reason })), utilisation: { bookedMinutes: b, availableMinutes: avail, rate: avail ? Math.round((b / avail) * 1000) / 1000 : null } };
    });
    const open = 11 * 60;
    const rooms = resources.filter((r) => r.locationId === l.id).map((r) => { const b = booked((a) => a.roomId === r.id); return { id: r.id, name: r.name, kind: r.type === 'room' ? 'room' as const : 'equipment' as const, type: r.type, utilisation: { bookedMinutes: b, availableMinutes: open, rate: Math.round((b / open) * 1000) / 1000 } }; });
    return { location: { id: l.id, name: l.name, timeZone: l.timeZone, currency: l.currency }, date, practitioners: pr, rooms, appointments: cal };
  };
  const impactOf = (ex: WException): ImpactItem[] => appts.filter((a) => a.status === 'confirmed' && a.practitionerId === ex.practitionerId && a.startsAt < Date.parse(ex.endsAt) && a.endsAt > Date.parse(ex.startsAt)).map((a) => {
    const l = locOf(a.locationId);
    return { appointment: ser(a), serviceName: services.find((s) => s.id === a.serviceId)!.name, clientName: clients.find((c) => c.id === a.customerId)?.name ?? 'Client', location: { id: l.id, name: l.name, timeZone: l.timeZone }, alternatives: pracsAt(a.locationId).filter((p) => p.id !== ex.practitionerId && p.serviceIds.includes(a.serviceId) && !pracBusy(p.id, a.from, a.until)).map((p) => ({ id: p.id, name: p.name })) };
  });
  const moveAppt = (a: Appt, startsAt: number, practitionerId?: string, resourceId?: string) => {
    a.status = 'rescheduled';
    try {
      const [n] = reserve({ locationId: a.locationId, serviceId: a.serviceId, variantId: a.variantId, practitionerId: practitionerId ?? a.practitionerId, customerId: a.customerId, startsAt, resourceId: resourceId ?? a.resourceId });
      Object.assign(n!, { priceMinor: a.priceMinor, paid: a.paid, voucherAppliedMinor: a.voucherAppliedMinor, clientPackageId: a.clientPackageId, depositMinor: a.depositMinor });
      return n!;
    } catch (e) {
      a.status = 'confirmed';
      throw e;
    }
  };
  const drafts: Draft[] = [];
  const draft = (kind: string, output: string, sources: string[]): Promise<Draft> => { const d: Draft = { id: uid('dr'), kind, output, removedClaims: [], sources, status: 'proposed', createdAt: new Date().toISOString(), sample: true }; drafts.push(d); return delay(d, 500); };

  return {
    mode: 'mock',
    services: () => delay(services),
    createService: (input) => { const svc = mkSvc(input.name, input.category ?? 'Other', input.durationMinutes, input.bufferAfterMinutes, input.priceMinor / Math.max(1, BASE[L[0]!.currency] ?? 10000), { ...input, policy: input.policy, depositRule: input.depositRule, rebookAfterWeeks: input.rebookAfterWeeks ?? null, description: input.description ?? null, cancellationPolicy: input.cancellationPolicy ?? POLICY_TEXT, locationId: input.locationId } as Partial<WService>); return delay(svc); },
    updateService: async (id, patch) => { const svc = services.find((s) => s.id === id); if (!svc) throw notFoundErr('Service'); const { practitionerIds, ...rest } = patch; Object.assign(svc, rest); if (practitionerIds) for (const p of pracs) p.serviceIds = practitionerIds.includes(p.id) ? [...new Set([...p.serviceIds, id])] : p.serviceIds.filter((x) => x !== id); await delay(null); },
    addVariant: async (serviceId, input) => { const svc = services.find((s) => s.id === serviceId)!; svc.variants.push({ id: uid('var'), name: input.name, durationMinutes: input.durationMinutes, bufferBeforeMinutes: null, bufferAfterMinutes: input.bufferAfterMinutes ?? null, sortOrder: svc.variants.length, active: true, prices: input.prices.map((p) => ({ ...p, depositMinor: null, currency: locOf(p.locationId).currency })) }); await delay(null); },
    setPrice: async (variantId, locationId, priceMinor, depositMinor) => { for (const s of services) for (const v of s.variants) if (v.id === variantId) { const p = v.prices.find((x) => x.locationId === locationId); if (p) Object.assign(p, { priceMinor, depositMinor }); else v.prices.push({ locationId, priceMinor, depositMinor, currency: locOf(locationId).currency }); } await delay(null); },
    practitioners: () => delay(pracs),
    resources: () => delay(resources),
    saveTemplate: async (pid, lid, availability) => {
      const p = pracs.find((x) => x.id === pid)!;
      for (const other of p.locations.filter((x) => x.locationId !== lid)) for (const a of availability) for (const b of other.availability) if (a.weekday === b.weekday && a.start < b.end && b.start < a.end) throw new ApiError('schedule_overlap', `This schedule overlaps ${p.name}’s hours at ${locOf(other.locationId).name}`, 409);
      const t = p.locations.find((x) => x.locationId === lid);
      if (t) t.availability = availability; else p.locations.push({ locationId: lid, home: false, availability });
      await delay(null);
    },
    removeTemplate: async (pid, lid) => { const p = pracs.find((x) => x.id === pid)!; p.locations = p.locations.filter((x) => x.home || x.locationId !== lid); await delay(null); },
    exceptions: () => delay(exceptions.map((e) => ({ ...e, affected: impactOf(e).length }))),
    createException: (input) => { const p = pracs.find((x) => x.id === input.practitionerId)!; const ex: WException = { id: uid('ex'), practitionerId: p.id, practitionerName: p.name, locationId: input.locationId ?? null, startsAt: input.startsAt, endsAt: input.endsAt, kind: input.kind, reason: input.reason ?? null, affected: 0 }; exceptions.push(ex); return delay({ exceptionId: ex.id, impact: impactOf(ex) }); },
    impact: (id) => { const ex = exceptions.find((x) => x.id === id); if (!ex) throw notFoundErr('Exception'); return delay(impactOf(ex)); },
    rebook: (id, actions) => {
      const ex = exceptions.find((x) => x.id === id)!;
      const results = actions.map((act) => {
        try {
          const a = apptById(act.appointmentId);
          if (act.action === 'cancel') { a.status = 'cancelled'; a.cancellationKind = 'business'; return { appointmentId: a.id, action: act.action, status: 'done' as const }; }
          const alt = act.practitionerId ?? impactOf(ex).find((i) => i.appointment.id === a.id)?.alternatives[0]?.id;
          if (!alt && act.action === 'reassign') throw new ApiError('no_alternative', 'No other practitioner is free at that time', 409);
          const n = moveAppt(a, act.action === 'reschedule' ? Date.parse(act.startsAt) : a.startsAt, alt);
          return { appointmentId: a.id, action: act.action, status: 'done' as const, newAppointmentId: n.id };
        } catch (e) { return { appointmentId: act.appointmentId, action: act.action, status: 'failed' as const, error: { code: (e as ApiError).code ?? 'error', message: (e as Error).message } }; }
      });
      return delay({ results, done: results.filter((r) => r.status === 'done').length, failed: results.filter((r) => r.status === 'failed').length }, 500);
    },
    withdrawException: async (id) => { const i = exceptions.findIndex((x) => x.id === id); if (i >= 0) exceptions.splice(i, 1); await delay(null); },
    calendar: (locationId, date) => delay(dayOf(locationId, date)),
    slots: async (locationId, serviceId, date) => {
      const l = locOf(locationId);
      const out = [];
      for (let m = 9 * 60; m < 19 * 60; m += 30) {
        const s = Date.parse(zonedToUtc(date, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, l.timeZone));
        if (s <= Date.now()) continue;
        const free = pracsAt(l.id).filter((p) => p.serviceIds.includes(serviceId) && !pracBusy(p.id, s - 10 * MIN, s + 75 * MIN) && inWindows(winsAt(p, l.id), l.timeZone, s, s + 60 * MIN));
        if (free.length) out.push({ startsAt: new Date(s).toISOString(), endsAt: new Date(s + 60 * MIN).toISOString(), practitionerIds: free.map((p) => p.id) });
      }
      return delay(out);
    },
    move: async (id, input) => {
      const a = apptById(id);
      const members = a.groupId ? appts.filter((x) => x.groupId === a.groupId) : [a];
      const s = Date.parse(input.startsAt);
      const pid = input.practitionerId ?? a.practitionerId;
      const dur = a.endsAt - a.startsAt;
      const conflicts = [];
      if (pracBusy(pid, s - (a.startsAt - a.from), s + dur + (a.until - a.endsAt), members.map((m) => m.id))) conflicts.push({ kind: 'practitioner_busy', message: 'Practitioner already booked (buffers included)' });
      if (input.resourceId && resBusy(input.resourceId, s, s + dur, members.map((m) => m.id))) conflicts.push({ kind: 'room_busy', message: 'Room already reserved (buffers included)' });
      if (onLeave(pid, s, s + dur)) conflicts.push({ kind: 'exception', message: 'Practitioner on leave' });
      const p = pracs.find((x) => x.id === pid)!;
      if (!inWindows(winsAt(p, a.locationId), locOf(a.locationId).timeZone, s, s + dur)) conflicts.push({ kind: 'outside_hours', message: `Outside ${p.name}’s working hours` });
      if (s <= Date.now()) conflicts.push({ kind: 'past', message: 'The new time is in the past' });
      if (input.dryRun) return delay({ ok: !conflicts.length, conflicts, error: conflicts.length ? { code: 'slot_unavailable', message: conflicts[0]!.message } : null });
      if (conflicts.length) return delay({ ok: false, conflicts, error: { code: 'slot_unavailable', message: 'That time is no longer available. The original appointment is unchanged.' } }, 400);
      moveAppt(a, s, input.practitionerId, input.resourceId);
      return delay({ ok: true, conflicts: [], error: null }, 400);
    },
    book: async (input) => {
      const cust = input.customerId ?? (() => { const c = { id: uid('cus'), name: input.contact!.name, email: input.contact!.email, phone: null, locationId: input.locationId, visits: 0, nextAppointmentAt: null, lastVisitAt: null, activePackages: 0, notes: [], prefs: null }; clients.push(c); return c.id; })();
      const made = reserve({ locationId: input.locationId, serviceId: input.serviceId, variantId: input.variantId, practitionerId: input.practitionerId, customerId: cust, startsAt: Date.parse(input.startsAt), enforce: !input.outsideAvailability });
      return delay({ appointmentId: made[0]!.id });
    },
    cancelPreview: (id, mode) => delay(preview(apptById(id), mode)),
    cancel: (id, input) => { const a = apptById(id); const p = preview(a, input.byBusiness ? 'business' : 'auto', input.waiveFee); (a.groupId ? appts.filter((x) => x.groupId === a.groupId) : [a]).forEach((m) => { m.status = 'cancelled'; m.cancellationKind = p.window; }); return delay(p, 400); },
    checkIn: async (id) => { apptById(id).checkedInAt = new Date().toISOString(); await delay(null); },
    complete: async (id) => { const a = apptById(id); if (a.startsAt > Date.now()) throw new ApiError('not_started', 'An appointment can be completed once it has started', 409); a.status = 'completed'; await delay(null); },
    noShow: (id, waive) => { const a = apptById(id); if (a.startsAt > Date.now()) throw new ApiError('not_started', 'A no-show can only be recorded after the start time', 409); const p = preview(a, 'no_show', waive); a.status = 'no_show'; a.cancellationKind = 'no_show'; return delay(p); },
    applyVoucher: async (id, code) => {
      const a = apptById(id);
      const v = vouchers.find((x) => x.code === code.trim().toUpperCase());
      if (!v) throw new ApiError('voucher_not_found', 'That voucher code was not recognised', 409);
      if (v.balance.currency !== a.currency) throw new ApiError('voucher_currency_mismatch', `This voucher is in ${v.balance.currency}; this booking is in ${a.currency}`, 409);
      const amt = Math.min(v.balance.amount, a.priceMinor - a.voucherAppliedMinor);
      if (amt <= 0) throw new ApiError('voucher_nothing_to_apply', 'Nothing left to apply', 409);
      v.balance.amount -= amt; a.voucherAppliedMinor += amt; if (!v.balance.amount) v.status = 'redeemed';
      return delay({ applied: { amount: amt, currency: a.currency }, balance: { ...v.balance } });
    },
    clients: (q) => {
      const now = Date.now();
      return delay(clients.filter((c) => !q || `${c.name} ${c.email}`.toLowerCase().includes(q.toLowerCase())).map(({ notes: _n, prefs: _p, ...c }) => {
        const xs = appts.filter((a) => a.customerId === c.id);
        return { ...c, visits: xs.filter((a) => a.status === 'completed').length, nextAppointmentAt: xs.filter((a) => a.status === 'confirmed' && a.startsAt > now).map((a) => new Date(a.startsAt).toISOString()).sort()[0] ?? null, lastVisitAt: xs.filter((a) => a.status === 'completed').map((a) => new Date(a.startsAt).toISOString()).sort().pop() ?? null, activePackages: packages.filter((p) => p.customerId === c.id && p.status === 'active').length };
      }));
    },
    client: async (id) => {
      const c = clients.find((x) => x.id === id);
      if (!c) throw notFoundErr('Client');
      const xs = appts.filter((a) => a.customerId === id && a.status !== 'rescheduled').sort((a, b) => b.startsAt - a.startsAt);
      return delay({
        client: { id: c.id, name: c.name, email: c.email, phone: c.phone, locationId: c.locationId, createdAt: new Date(Date.now() - 90 * DAY).toISOString() }, preferences: c.prefs,
        appointments: xs.map((a) => ({ ...ser(a), serviceName: services.find((s) => s.id === a.serviceId)!.name, practitionerName: pracs.find((p) => p.id === a.practitionerId)!.name, locationName: locOf(a.locationId).name, timeZone: locOf(a.locationId).timeZone })),
        packages: packages.filter((p) => p.customerId === id || p.sharedWithCustomerIds.includes(id)), vouchersPurchased: [], notes: c.notes, charges: [],
        intake: { responses: c.notes.length ? 1 : 0, restricted: true as const, canView: true, aiContext: 'excluded' as const }, stats: { visits: xs.filter((a) => a.status === 'completed').length, noShows: xs.filter((a) => a.status === 'no_show').length, lateCancellations: xs.filter((a) => a.cancellationKind === 'late').length },
      });
    },
    savePreferences: async (id, prefs) => { const c = clients.find((x) => x.id === id)!; c.prefs = { ...prefs, preferredLocationId: prefs.preferredLocationId ?? c.locationId }; await delay(null); },
    addNote: async (id, input) => { clients.find((x) => x.id === id)!.notes.unshift({ id: uid('note'), body: input.body, confidential: input.confidential, locationId: input.locationId, appointmentId: null, mine: true, createdAt: new Date().toISOString() }); await delay(null); },
    plans: () => delay(plans),
    createPlan: async (input) => { plans.push({ id: uid('plan'), locationId: input.locationId, name: input.name, description: null, serviceId: input.serviceId, variantId: null, sessions: input.sessions, price: { amount: input.priceMinor, currency: input.currency }, perSession: { amount: Math.round(input.priceMinor / input.sessions), currency: input.currency }, validityDays: input.validityDays, sharing: input.sharing, maxSharedWith: input.maxSharedWith, onlinePurchasable: true, active: true, sold: 0 }); await delay(null); },
    clientPackages: () => delay(packages),
    sellPackage: async (input) => { const pl = plans.find((p) => p.id === input.planId)!; const c = clients.find((x) => x.id === input.customerId)!; packages.unshift({ id: uid('cp'), planId: pl.id, name: pl.name, serviceId: pl.serviceId, customerId: c.id, clientName: c.name, locationId: input.locationId, sessionsTotal: pl.sessions, sessionsUsed: 0, sessionsRemaining: pl.sessions, price: pl.price, purchasedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + pl.validityDays * DAY).toISOString(), status: 'active', sharing: pl.sharing, sharedWithCustomerIds: [] }); await delay(null); },
    vouchers: () => delay(vouchers),
    voucher: (id) => { const v = vouchers.find((x) => x.id === id); if (!v) throw notFoundErr('Voucher'); return delay({ ...v, transactions: [{ id: 't1', kind: 'issue', amount: v.initial, balanceAfter: v.initial, appointmentId: null, createdAt: v.createdAt }, ...(v.balance.amount < v.initial.amount ? [{ id: 't2', kind: 'redeem', amount: { amount: v.balance.amount - v.initial.amount, currency: v.balance.currency }, balanceAfter: v.balance, appointmentId: null, createdAt: new Date().toISOString() }] : [])] }); },
    issueVoucher: (input) => { const l = locOf(input.locationId); const v: Voucher = { id: uid('gv'), code: `GV-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, locationId: l.id, initial: { amount: input.amountMinor, currency: l.currency }, balance: { amount: input.amountMinor, currency: l.currency }, expiresAt: new Date(Date.now() + input.validityDays * DAY).toISOString(), status: 'active', recipientName: input.recipientName ?? null, recipientEmail: null, message: null, createdAt: new Date().toISOString() }; vouchers.unshift(v); return delay(v); },
    waitlist: () => delay(waitlist),
    report: (from, to, locationId) => {
      const ids = locationId ? [locationId] : L.map((l) => l.id);
      const inR = (a: Appt) => { const l = locOf(a.locationId); const d = dateInZone(new Date(a.startsAt), l.timeZone); return ids.includes(a.locationId) && d >= from && d <= to; };
      const xs = appts.filter(inR);
      const byCur = new Map<string, WReport['revenue'][number]>();
      for (const a of xs.filter((x) => ['completed', 'confirmed'].includes(x.status))) { const r = byCur.get(a.currency) ?? { currency: a.currency, appointmentValueMinor: 0, packageSessionsUsed: 0, depositsCollectedMinor: 0, packagesSoldMinor: 0, vouchersSoldMinor: 0, feesRetainedMinor: 0, feesOutstandingMinor: 0, refundsMinor: 0 }; r.appointmentValueMinor += a.priceMinor; r.depositsCollectedMinor += a.paid; byCur.set(a.currency, r); }
      const util = ids.flatMap((lid) => { const d = dayOf(lid, dateInZone(new Date(), locOf(lid).timeZone)); return d.practitioners.map((p) => ({ id: p.id, name: p.name, locationId: lid, locationName: d.location.name, bookedMinutes: p.utilisation.bookedMinutes, availableMinutes: p.utilisation.availableMinutes, rate: p.utilisation.rate })); });
      const rooms = ids.flatMap((lid) => { const d = dayOf(lid, dateInZone(new Date(), locOf(lid).timeZone)); return d.rooms.map((p) => ({ id: p.id, name: p.name, type: p.type, locationId: lid, locationName: d.location.name, bookedMinutes: p.utilisation.bookedMinutes, availableMinutes: p.utilisation.availableMinutes, rate: p.utilisation.rate })); });
      const curOf = (lid: string) => locOf(lid).currency;
      const liab = new Map<string, { currency: string; packages: number; sessionsRemaining: number; valueMinor: number }>();
      for (const p of packages.filter((x) => x.status === 'active' && ids.includes(x.locationId))) { const r = liab.get(p.price.currency) ?? { currency: p.price.currency, packages: 0, sessionsRemaining: 0, valueMinor: 0 }; r.packages++; r.sessionsRemaining += p.sessionsRemaining; r.valueMinor += Math.round((p.price.amount * p.sessionsRemaining) / p.sessionsTotal); liab.set(p.price.currency, r); }
      return delay({
        range: { from, to, timeZones: [...new Set(ids.map((i) => locOf(i).timeZone))] }, asOf: new Date().toISOString(), source: 'Sample data',
        cancellations: ids.map((lid) => { const ys = xs.filter((a) => a.locationId === lid); const c = ys.filter((a) => a.status === 'cancelled').length; return { locationId: lid, locationName: locOf(lid).name, booked: ys.length, completed: ys.filter((a) => a.status === 'completed').length, cancelled: c, freeCancellations: ys.filter((a) => a.cancellationKind === 'free').length, lateCancellations: ys.filter((a) => a.cancellationKind === 'late').length, businessCancellations: ys.filter((a) => a.cancellationKind === 'business').length, noShows: ys.filter((a) => a.status === 'no_show').length, cancellationRate: ys.length ? Math.round((c / ys.length) * 1000) / 1000 : null }; }),
        revenue: [...byCur.values()], revenueDefinition: 'Per currency, never combined (sample data).', combinedRevenue: null,
        utilisation: { definition: 'Booked minutes ÷ scheduled minutes (today, sample).', practitioners: util, rooms },
        packageLiability: [...liab.values()], voucherLiability: [...new Set(ids.map(curOf))].map((c) => ({ currency: c, vouchers: vouchers.filter((v) => v.balance.currency === c && v.status === 'active').length, balanceMinor: vouchers.filter((v) => v.balance.currency === c && v.status === 'active').reduce((s, v) => s + v.balance.amount, 0) })),
        liabilityDefinition: 'Unused, unexpired package sessions at the price paid per session, and unexpired voucher balances.',
      } satisfies WReport);
    },
    draftServiceCopy: (serviceId) => { const svc = services.find((s) => s.id === serviceId)!; return draft('service_copy', `${svc.name}: ${svc.variants.map((v) => v.durationMinutes).join(' or ')} unhurried minutes in a private room. Arrive a few minutes early to settle in; everything you need is provided.`, ['Service configuration']); },
    draftPolicyReply: () => draft('policy_reply', `Thanks for getting in touch! You can cancel or move your appointment free of charge up to ${POLICY.freeCancelHours} hours before it starts. After that, a 50% charge applies, and any deposit is used towards it. A team member will confirm anything not covered here.`, ['Approved cancellation and deposit policies']),
    draftSummary: () => draft('appointment_summary', '• Observation: most practitioners are above 50% utilisation this week.\n• Observation: late cancellations are a small share of bookings.\n• Hypothesis: morning slots fill first.\n• Unavailable: marketing attribution is not measured.', ['Sample data']),
    decideDraft: async (id, decision, edited) => { const d = drafts.find((x) => x.id === id); if (d) { d.status = decision === 'apply' ? 'applied' : 'discarded'; if (decision === 'apply' && d.kind === 'service_copy') { const svc = services.find((s) => d.output.startsWith(s.name)); if (svc) svc.description = edited ?? d.output; } } await delay(null); },
    runReminders: () => delay({ reminders: { email_logged: 3, sms_skipped_no_consent: 2 }, rebookPrompts: { logged: 1 }, expired: { packages: 0, vouchers: 0 } }),
  };
}

/**
 * Wellness booking engine (administrative scope only).
 *
 * - Pricing: service base price, or a variant (30/60/90 min) priced per location in that location's currency.
 * - Availability: weekly templates per location (home location in `practitioners.availability`, other locations in
 *   `wellness_practitioner_locations`), minus exceptions (leave/absence), existing reservations (all locations —
 *   one practitioner can never be in two places), buffers, rooms and equipment.
 * - Reservation: practitioner + room + equipment are secured together inside one savepoint per candidate
 *   combination; the database exclusion constraints are the final arbiter (both secured or neither).
 * - Couples/duo services reserve two practitioners and ONE shared room in one savepoint.
 * - Reschedule secures the replacement before releasing the original; failure keeps the original.
 */
import { and, asc, eq, gt, gte, inArray, lt } from 'drizzle-orm';
import type { Db, Exec, Tx } from '../db/client.ts';
import {
  appointments, locations, paymentReferences, practitioners, resources, services, wellnessAvailabilityExceptions, wellnessPackageRedemptions,
  wellnessPractitionerLocations, wellnessResourceReservations, wellnessServiceVariants, wellnessVariantPrices,
  type ServiceDepositRule, type ServicePolicy, type WeeklyAvailability,
} from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { isExclusionViolation } from '../lib/pg.ts';
import { localDateParts, weekdayOf, zonedToUtc } from '../lib/tz.ts';
import { audit } from './audit.ts';

type Service = typeof services.$inferSelect;
type Practitioner = typeof practitioners.$inferSelect;
type Location = typeof locations.$inferSelect;
export type AppointmentRow = typeof appointments.$inferSelect;

const SLOT_STEP_MINUTES = 15;
const MIN = 60_000;

export const DEFAULT_POLICY: ServicePolicy = { freeCancelHours: 24, lateCancelFeePercent: 50, noShowFeePercent: 100, depositRefundable: true };
export const policyOf = (svc: Pick<Service, 'policy'>): ServicePolicy => ({ ...DEFAULT_POLICY, ...(svc.policy ?? {}) });

export interface Pricing {
  serviceId: string;
  variantId: string | null;
  variantName: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceMinor: number;
  depositMinor: number;
  currency: string;
}

export function depositFor(rule: ServiceDepositRule | null | undefined, fixedDeposit: number, price: number): number {
  if (!rule) return Math.max(0, Math.min(fixedDeposit, price));
  if (rule.kind === 'none') return 0;
  if (rule.kind === 'fixed') return Math.max(0, Math.min(Math.round(rule.value), price));
  return Math.max(0, Math.min(price, Math.round((price * rule.value) / 100)));
}

export function reservationWindow(p: Pick<Pricing, 'durationMinutes' | 'bufferBeforeMinutes' | 'bufferAfterMinutes'>, startsAt: Date) {
  const endsAt = new Date(startsAt.getTime() + p.durationMinutes * MIN);
  return {
    startsAt,
    endsAt,
    blockedFrom: new Date(startsAt.getTime() - p.bufferBeforeMinutes * MIN),
    blockedUntil: new Date(endsAt.getTime() + p.bufferAfterMinutes * MIN),
  };
}

/** Is [start,end) inside one of the weekly windows (location-local time)? */
export function withinWindows(windows: WeeklyAvailability, timeZone: string, startsAt: Date, endsAt: Date): boolean {
  const st = localDateParts(startsAt, timeZone);
  const en = localDateParts(endsAt, timeZone);
  if (en.date !== st.date && en.time !== '00:00') return false;
  const endTime = en.date === st.date ? en.time : '24:00';
  return windows.some((w) => w.weekday === st.weekday && w.start <= st.time && endTime <= w.end);
}

/** Back-compat helper: the practitioner's home-location template. */
export function withinAvailability(p: Practitioner, timeZone: string, startsAt: Date, endsAt: Date): boolean {
  return withinWindows(p.availability, timeZone, startsAt, endsAt);
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** Two weekly templates overlap if any same-weekday windows intersect. */
export function templatesOverlap(a: WeeklyAvailability, b: WeeklyAvailability): Array<{ weekday: number; a: string; b: string }> {
  const out: Array<{ weekday: number; a: string; b: string }> = [];
  for (const x of a) for (const y of b) {
    if (x.weekday === y.weekday && toMin(x.start) < toMin(y.end) && toMin(y.start) < toMin(x.end)) out.push({ weekday: x.weekday, a: `${x.start}–${x.end}`, b: `${y.start}–${y.end}` });
  }
  return out;
}

/**
 * Clashes between a weekly template and the practitioner's templates at other locations. Same time zone: compare
 * wall-clock windows; different zones: compare real instants over the next two weeks (DST-aware).
 */
export function scheduleClashes(windows: WeeklyAvailability, timeZone: string, others: Array<{ locationId: string; availability: WeeklyAvailability; timeZone: string }>, fromDate: string) {
  const out: Array<{ otherLocationId: string; weekday: number; a: string; b: string }> = [];
  const instants = (ws: WeeklyAvailability, tz: string) => {
    const xs: Array<{ from: number; until: number; w: WeeklyAvailability[number] }> = [];
    for (let d = 0; d < 14; d++) {
      const [y, m, dd] = fromDate.split('-').map(Number) as [number, number, number];
      const date = new Date(Date.UTC(y, m - 1, dd + d)).toISOString().slice(0, 10);
      const wd = weekdayOf(date);
      for (const w of ws.filter((x) => x.weekday === wd)) {
        const from = zonedToUtc(date, w.start, tz).getTime();
        const until = w.end === '24:00' ? from + (toMin('24:00') - toMin(w.start)) * MIN : zonedToUtc(date, w.end, tz).getTime();
        xs.push({ from, until, w });
      }
    }
    return xs;
  };
  for (const o of others) {
    if (o.timeZone === timeZone) {
      for (const c of templatesOverlap(windows, o.availability)) out.push({ otherLocationId: o.locationId, ...c });
      continue;
    }
    const mine = instants(windows, timeZone);
    const theirs = instants(o.availability, o.timeZone);
    const seen = new Set<string>();
    for (const x of mine) for (const y of theirs) {
      if (x.from < y.until && y.from < x.until) {
        const key = [x.w.weekday, x.w.start, y.w.weekday, y.w.start].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ otherLocationId: o.locationId, weekday: x.w.weekday, a: x.w.start + '–' + x.w.end, b: y.w.start + '–' + y.w.end + ' (local time there)' });
      }
    }
  }
  return out;
}

export async function loadServiceAt(db: Exec, organizationId: string, locationId: string, serviceId: string) {
  const [svc] = await db.select().from(services).where(and(eq(services.id, serviceId), eq(services.organizationId, organizationId)));
  if (!svc || !svc.active || (svc.locationId && svc.locationId !== locationId)) throw notFound('Service');
  const [loc] = await db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!loc) throw notFound('Location');
  return { svc, loc };
}

/** Duration, buffers, price and deposit for a service (optionally a variant) at a location. */
export async function resolvePricing(db: Exec, svc: Service, loc: Location, variantId?: string | null): Promise<Pricing> {
  const variants = await db.select().from(wellnessServiceVariants).where(and(eq(wellnessServiceVariants.serviceId, svc.id), eq(wellnessServiceVariants.active, true))).orderBy(asc(wellnessServiceVariants.sortOrder));
  if (variantId || variants.length) {
    const prices = variants.length ? await db.select().from(wellnessVariantPrices).where(and(inArray(wellnessVariantPrices.variantId, variants.map((v) => v.id)), eq(wellnessVariantPrices.locationId, loc.id))) : [];
    const v = variantId ? variants.find((x) => x.id === variantId) : variants.find((x) => prices.some((p) => p.variantId === x.id));
    if (variantId && !v) throw validationError('Unknown option for this service', { variantId: 'Not found' });
    const price = v ? prices.find((p) => p.variantId === v.id) : undefined;
    if (!v || !price) throw conflict('not_offered_here', 'This service option is not offered at this location');
    const fallbackFixed = svc.currency === price.currency ? svc.depositMinor : 0;
    return {
      serviceId: svc.id, variantId: v.id, variantName: v.name, durationMinutes: v.durationMinutes,
      bufferBeforeMinutes: v.bufferBeforeMinutes ?? svc.bufferBeforeMinutes, bufferAfterMinutes: v.bufferAfterMinutes ?? svc.bufferAfterMinutes,
      priceMinor: price.priceMinor, depositMinor: price.depositMinor ?? depositFor(svc.depositRule, fallbackFixed, price.priceMinor), currency: price.currency,
    };
  }
  if (svc.currency !== loc.currency) throw conflict('not_offered_here', 'This service is not priced for this location');
  return {
    serviceId: svc.id, variantId: null, variantName: null, durationMinutes: svc.durationMinutes, bufferBeforeMinutes: svc.bufferBeforeMinutes, bufferAfterMinutes: svc.bufferAfterMinutes,
    priceMinor: svc.priceMinor, depositMinor: depositFor(svc.depositRule, svc.depositMinor, svc.priceMinor), currency: svc.currency,
  };
}

export interface PracAt { p: Practitioner; windows: WeeklyAvailability; home: boolean }

/** Active practitioners working at a location: home practitioners plus those with a template there. */
export async function practitionersAt(db: Exec, organizationId: string, locationId: string): Promise<PracAt[]> {
  const home = await db.select().from(practitioners).where(and(eq(practitioners.organizationId, organizationId), eq(practitioners.locationId, locationId), eq(practitioners.active, true)));
  const extra = await db.select({ p: practitioners, pl: wellnessPractitionerLocations }).from(wellnessPractitionerLocations)
    .innerJoin(practitioners, eq(practitioners.id, wellnessPractitionerLocations.practitionerId))
    .where(and(eq(wellnessPractitionerLocations.organizationId, organizationId), eq(wellnessPractitionerLocations.locationId, locationId), eq(wellnessPractitionerLocations.active, true), eq(practitioners.active, true)));
  return [...home.map((p) => ({ p, windows: p.availability, home: true })), ...extra.filter((x) => x.p.locationId !== locationId).map((x) => ({ p: x.p, windows: x.pl.availability, home: false }))];
}

async function eligibleAt(db: Exec, organizationId: string, locationId: string, serviceId: string, practitionerIds?: string[] | null) {
  const all = (await practitionersAt(db, organizationId, locationId)).filter((x) => x.p.serviceIds.includes(serviceId));
  if (practitionerIds?.length) {
    const chosen = all.filter((x) => practitionerIds.includes(x.p.id));
    if (chosen.length !== new Set(practitionerIds).size) throw validationError('This practitioner does not offer this service here', { practitionerId: 'Not eligible' });
    return chosen;
  }
  return all;
}

type Busy = { practitionerId: string; from: Date; until: Date };
type Excp = { practitionerId: string; locationId: string | null; from: Date; until: Date };
type ResBusy = { resourceId: string; from: Date; until: Date };
const overlaps = (a: { from: Date; until: Date }, from: Date, until: Date) => a.from < until && a.until > from;

async function busyData(db: Exec, practitionerIds: string[], resourceIds: string[], from: Date, until: Date) {
  const busy: Busy[] = practitionerIds.length
    ? await db.select({ practitionerId: appointments.practitionerId, from: appointments.blockedFrom, until: appointments.blockedUntil }).from(appointments)
      .where(and(inArray(appointments.practitionerId, practitionerIds), eq(appointments.status, 'confirmed'), lt(appointments.blockedFrom, until), gt(appointments.blockedUntil, from)))
    : [];
  const excp: Excp[] = practitionerIds.length
    ? await db.select({ practitionerId: wellnessAvailabilityExceptions.practitionerId, locationId: wellnessAvailabilityExceptions.locationId, from: wellnessAvailabilityExceptions.startsAt, until: wellnessAvailabilityExceptions.endsAt }).from(wellnessAvailabilityExceptions)
      .where(and(inArray(wellnessAvailabilityExceptions.practitionerId, practitionerIds), eq(wellnessAvailabilityExceptions.status, 'active'), lt(wellnessAvailabilityExceptions.startsAt, until), gt(wellnessAvailabilityExceptions.endsAt, from)))
    : [];
  const res: ResBusy[] = resourceIds.length
    ? await db.select({ resourceId: wellnessResourceReservations.resourceId, from: wellnessResourceReservations.blockedFrom, until: wellnessResourceReservations.blockedUntil }).from(wellnessResourceReservations)
      .where(and(inArray(wellnessResourceReservations.resourceId, resourceIds), eq(wellnessResourceReservations.active, true), lt(wellnessResourceReservations.blockedFrom, until), gt(wellnessResourceReservations.blockedUntil, from)))
    : [];
  return { busy, excp, res };
}

const onException = (excp: Excp[], practitionerId: string, locationId: string, from: Date, until: Date) =>
  excp.some((e) => e.practitionerId === practitionerId && (!e.locationId || e.locationId === locationId) && overlaps(e, from, until));

async function resourcesFor(db: Exec, svc: Service, locationId: string) {
  const types = [...(svc.requiredResourceType ? [svc.requiredResourceType] : []), ...svc.equipmentTypes];
  const rows = types.length ? await db.select().from(resources).where(and(eq(resources.locationId, locationId), inArray(resources.type, types), eq(resources.active, true))).orderBy(asc(resources.name)) : [];
  return {
    rooms: svc.requiredResourceType ? rows.filter((r) => r.type === svc.requiredResourceType) : null,
    equipment: svc.equipmentTypes.map((type) => ({ type, items: rows.filter((r) => r.type === type) })),
  };
}

export interface AvailabilityQuery { organizationId: string; locationId: string; serviceId: string; variantId?: string; date: string; practitionerId?: string }

/** Open slots for a service on a local date, honouring templates, exceptions, buffers, reservations, rooms and equipment. */
export async function availability(db: Exec, q: AvailabilityQuery) {
  const { svc, loc } = await loadServiceAt(db, q.organizationId, q.locationId, q.serviceId);
  const pricing = await resolvePricing(db, svc, loc, q.variantId);
  const pracs = await eligibleAt(db, q.organizationId, q.locationId, q.serviceId, q.practitionerId ? [q.practitionerId] : null);
  const need = Math.max(1, svc.practitionersRequired);
  const { rooms, equipment } = await resourcesFor(db, svc, q.locationId);
  const dayStart = zonedToUtc(q.date, '00:00', loc.timeZone);
  const from = new Date(dayStart.getTime() - 12 * 3600_000);
  const until = new Date(dayStart.getTime() + 36 * 3600_000);
  const allRes = [...(rooms ?? []), ...equipment.flatMap((e) => e.items)].map((r) => r.id);
  const { busy, excp, res } = await busyData(db, pracs.map((x) => x.p.id), allRes, from, until);
  const weekday = weekdayOf(q.date);
  const now = new Date();
  const times = new Set<number>();
  for (const x of pracs) {
    for (const w of x.windows.filter((y) => y.weekday === weekday)) {
      const ws = zonedToUtc(q.date, w.start, loc.timeZone).getTime();
      const we = zonedToUtc(q.date, w.end === '24:00' ? '23:59' : w.end, loc.timeZone).getTime();
      for (let t = ws; t + pricing.durationMinutes * MIN <= we; t += SLOT_STEP_MINUTES * MIN) times.add(t);
    }
  }
  const slots: Array<{ startsAt: string; endsAt: string; practitionerIds: string[]; roomsFree: number | null }> = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const win = reservationWindow(pricing, new Date(t));
    if (win.startsAt <= now) continue;
    const free = pracs.filter((x) => withinWindows(x.windows, loc.timeZone, win.startsAt, win.endsAt)
      && !busy.some((b) => b.practitionerId === x.p.id && overlaps(b, win.blockedFrom, win.blockedUntil))
      && !onException(excp, x.p.id, loc.id, win.startsAt, win.endsAt));
    if (free.length < need) continue;
    let roomsFree: number | null = null;
    if (rooms) {
      roomsFree = rooms.filter((r) => !res.some((b) => b.resourceId === r.id && overlaps(b, win.blockedFrom, win.blockedUntil))).length;
      if (!roomsFree) continue;
    }
    const equipOk = equipment.every((e) => e.items.filter((r) => !res.some((b) => b.resourceId === r.id && overlaps(b, win.blockedFrom, win.blockedUntil))).length >= need);
    if (!equipOk) continue;
    slots.push({ startsAt: win.startsAt.toISOString(), endsAt: win.endsAt.toISOString(), practitionerIds: free.map((x) => x.p.id), roomsFree });
  }
  const policy = policyOf(svc);
  return {
    service: {
      id: svc.id, name: svc.name, durationMinutes: pricing.durationMinutes, variantId: pricing.variantId, variantName: pricing.variantName,
      price: { amount: pricing.priceMinor, currency: pricing.currency }, deposit: { amount: pricing.depositMinor, currency: pricing.currency },
      cancellationPolicy: svc.cancellationPolicy, policy, practitionersRequired: need,
    },
    location: { id: loc.id, name: loc.name, timeZone: loc.timeZone },
    date: q.date,
    slots,
  };
}

export interface ReserveInput {
  organizationId: string;
  locationId: string;
  serviceId: string;
  variantId?: string | null;
  practitionerId?: string | null;
  /** Couples: the two practitioners (optional — any available otherwise). */
  practitionerIds?: string[] | null;
  customerId: string;
  /** Couples: the second guest (defaults to the booking customer). */
  partnerCustomerId?: string | null;
  startsAt: Date;
  rescheduledFromId?: string;
  enforceAvailability?: boolean;
  /** Preferred room (calendar drag to a room column). */
  resourceId?: string | null;
  source?: string;
  seriesId?: string | null;
  /** Customer-facing booking: the service must be online-bookable. */
  online?: boolean;
  /** Keep the manage token of an existing booking (reschedule). */
  manageTokenHash?: string | null;
}

class SkipCombination extends Error {}

/** Least-loaded first ("any available" allocation), stable by name. */
async function orderByLoad(db: Exec, cands: PracAt[], timeZone: string, startsAt: Date) {
  if (cands.length < 2) return cands;
  const day = localDateParts(startsAt, timeZone).date;
  const from = zonedToUtc(day, '00:00', timeZone);
  const until = new Date(from.getTime() + 24 * 3600_000);
  const rows = await db.select({ practitionerId: appointments.practitionerId, s: appointments.startsAt, e: appointments.endsAt }).from(appointments)
    .where(and(inArray(appointments.practitionerId, cands.map((c) => c.p.id)), eq(appointments.status, 'confirmed'), gte(appointments.startsAt, from), lt(appointments.startsAt, until)));
  const load = new Map<string, number>();
  for (const r of rows) load.set(r.practitionerId, (load.get(r.practitionerId) ?? 0) + (r.e.getTime() - r.s.getTime()));
  return [...cands].sort((a, b) => (load.get(a.p.id) ?? 0) - (load.get(b.p.id) ?? 0) || a.p.name.localeCompare(b.p.name));
}

/**
 * Secure practitioner(s) + room + equipment for a slot inside the caller's transaction. Each candidate combination is
 * tried in a savepoint; the exclusion constraints decide races, so two requests can never both win.
 */
export async function reserveAppointment(tx: Tx, input: ReserveInput) {
  const { svc, loc } = await loadServiceAt(tx, input.organizationId, input.locationId, input.serviceId);
  if (input.online && !svc.onlineBookable) throw conflict('not_bookable_online', 'This service is booked by phone or at reception');
  const pricing = await resolvePricing(tx, svc, loc, input.variantId);
  const win = reservationWindow(pricing, input.startsAt);
  if (win.startsAt <= new Date()) throw validationError('Choose a time in the future', { startsAt: 'Must be in the future' });
  const need = Math.max(1, svc.practitionersRequired);
  const explicit = input.practitionerIds?.length ? input.practitionerIds : input.practitionerId ? [input.practitionerId] : null;
  if (explicit && explicit.length > need) throw validationError(`This service needs ${need} practitioner(s)`, { practitionerIds: 'Too many' });
  let cands = await eligibleAt(tx, input.organizationId, input.locationId, input.serviceId, explicit);
  if (input.enforceAvailability !== false) {
    const { excp } = await busyData(tx, cands.map((c) => c.p.id), [], win.startsAt, win.endsAt);
    cands = cands.filter((c) => withinWindows(c.windows, loc.timeZone, win.startsAt, win.endsAt) && !onException(excp, c.p.id, loc.id, win.startsAt, win.endsAt));
  }
  // Skip practitioners already busy (the constraint would reject them anyway).
  const { busy } = await busyData(tx, cands.map((c) => c.p.id), [], win.blockedFrom, win.blockedUntil);
  cands = cands.filter((c) => !busy.some((b) => b.practitionerId === c.p.id));
  if (cands.length < need) throw conflict('slot_unavailable', need > 1 ? 'Two practitioners are not available at that time' : 'No practitioner is available at that time');
  cands = explicit ? explicit.map((id) => cands.find((c) => c.p.id === id)!).filter(Boolean).concat(cands.filter((c) => !explicit.includes(c.p.id))) : await orderByLoad(tx, cands, loc.timeZone, win.startsAt);

  const { rooms, equipment } = await resourcesFor(tx, svc, input.locationId);
  if (rooms && !rooms.length) throw conflict('no_resource', `This service needs a ${svc.requiredResourceType} and none is configured`);
  for (const e of equipment) if (e.items.length < need) throw conflict('no_resource', `This service needs ${need} × ${e.type} and not enough are configured`);
  const roomOrder = rooms ? [...rooms].sort((a, b) => (a.id === input.resourceId ? -1 : b.id === input.resourceId ? 1 : 0)) : [null];

  const combos: PracAt[][] = [];
  if (need === 1) for (const c of cands) combos.push([c]);
  else for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) combos.push([cands[i]!, cands[j]!]);
  if (explicit && explicit.length === need) combos.splice(1); // exactly the requested practitioner(s)
  else if (explicit) for (let i = combos.length - 1; i >= 0; i--) if (!explicit.every((id) => combos[i]!.some((c) => c.p.id === id))) combos.splice(i, 1);

  const manageToken = randomToken();
  const tokenHash = input.manageTokenHash ?? sha256(manageToken);
  const groupId = need > 1 ? crypto.randomUUID() : null;

  for (const combo of combos) {
    for (const room of roomOrder) {
      try {
        const rows = await tx.transaction(async (sp) => {
          const out: AppointmentRow[] = [];
          for (const [idx, c] of combo.entries()) {
            const [a] = await sp.insert(appointments).values({
              organizationId: input.organizationId, locationId: input.locationId, serviceId: svc.id, practitionerId: c.p.id,
              resourceId: idx === 0 ? room?.id ?? null : null, customerId: idx === 0 ? input.customerId : input.partnerCustomerId ?? input.customerId,
              ...win, status: 'confirmed', priceMinor: pricing.priceMinor, currency: pricing.currency, depositMinor: pricing.depositMinor,
              variantId: pricing.variantId, groupId, seriesId: input.seriesId ?? null, source: input.source ?? 'web',
              rescheduledFromId: idx === 0 ? input.rescheduledFromId ?? null : null, manageTokenHash: tokenHash,
            }).returning();
            out.push(a!);
          }
          // Equipment: each guest needs one item of every required type, secured in the same savepoint.
          const used = new Set<string>();
          for (const a of out) {
            for (const e of equipment) {
              let ok = false;
              for (const item of e.items) {
                if (used.has(item.id)) continue;
                try {
                  await sp.transaction(async (sp2) => {
                    await sp2.insert(wellnessResourceReservations).values({ organizationId: input.organizationId, locationId: input.locationId, resourceId: item.id, appointmentId: a.id, blockedFrom: win.blockedFrom, blockedUntil: win.blockedUntil, role: 'equipment' });
                  });
                  used.add(item.id);
                  ok = true;
                  break;
                } catch (err) {
                  if (isExclusionViolation(err)) continue;
                  throw err;
                }
              }
              if (!ok) throw new SkipCombination(e.type);
            }
          }
          return out;
        });
        return { appointment: rows[0]!, appointments: rows, manageToken, service: svc, location: loc, pricing };
      } catch (err) {
        if (isExclusionViolation(err) || err instanceof SkipCombination) continue; // taken — try the next combination
        throw err;
      }
    }
  }
  throw new AppError(409, 'slot_unavailable', 'That time is no longer available. Please choose another slot.');
}

/** All members of a couples group (or just the appointment). */
export async function groupMembers(db: Exec, a: AppointmentRow): Promise<AppointmentRow[]> {
  if (!a.groupId) return [a];
  return db.select().from(appointments).where(and(eq(appointments.groupId, a.groupId), eq(appointments.organizationId, a.organizationId))).orderBy(asc(appointments.createdAt));
}

export interface RescheduleOptions {
  organizationId?: string;
  startsAt: Date;
  practitionerId?: string | null;
  practitionerIds?: string[] | null;
  resourceId?: string | null;
  actorUserId: string | null;
  enforceAvailability?: boolean;
}

/**
 * Reschedule: the replacement is secured BEFORE the original is released, atomically. The original is marked
 * 'rescheduled' inside the transaction (so it doesn't block its own replacement under the exclusion constraints);
 * if the replacement cannot be secured the transaction rolls back and the original appointment is untouched.
 * Couples groups move together. Payment, package redemption and voucher value move to the replacement.
 */
export async function rescheduleAppointment(db: Exec, appointmentId: string, opts: RescheduleOptions) {
  return db.transaction(async (tx) => {
    const [old] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId)).for('update');
    if (!old || (opts.organizationId && old.organizationId !== opts.organizationId)) throw notFound('Appointment');
    if (old.status !== 'confirmed') throw conflict('appointment_not_active', `Appointment is ${old.status}`);
    const members = await groupMembers(tx, old);
    if (members.some((m) => m.status !== 'confirmed')) throw conflict('appointment_not_active', 'Part of this group booking is no longer active');
    const ids = members.map((m) => m.id);
    await tx.update(appointments).set({ status: 'rescheduled', updatedAt: new Date() }).where(inArray(appointments.id, ids));
    const primary = members[0]!;
    const keepPracs = opts.practitionerIds ?? (opts.practitionerId === undefined ? members.map((m) => m.practitionerId) : opts.practitionerId ? [opts.practitionerId] : null);
    const next = await reserveAppointment(tx, {
      organizationId: old.organizationId, locationId: old.locationId, serviceId: old.serviceId, variantId: old.variantId, customerId: primary.customerId,
      partnerCustomerId: members[1]?.customerId ?? null, practitionerIds: keepPracs, startsAt: opts.startsAt, rescheduledFromId: primary.id,
      resourceId: opts.resourceId === undefined ? primary.resourceId : opts.resourceId, source: primary.source, seriesId: primary.seriesId,
      enforceAvailability: opts.enforceAvailability, manageTokenHash: primary.manageTokenHash,
    });
    for (const [i, m] of members.entries()) {
      const repl = next.appointments[i] ?? next.appointment;
      await tx.update(appointments).set({ rescheduledToId: repl.id, paymentId: null }).where(eq(appointments.id, m.id));
      await tx.update(appointments).set({
        rescheduledFromId: m.id, paymentId: m.paymentId, depositMinor: m.depositMinor, voucherAppliedMinor: m.voucherAppliedMinor, clientPackageId: m.clientPackageId,
        // a moved appointment keeps the price agreed at booking; the new list price is reported as priceChange
        priceMinor: m.priceMinor, checkedInAt: null,
      }).where(eq(appointments.id, repl.id));
      if (m.clientPackageId) await tx.update(wellnessPackageRedemptions).set({ appointmentId: repl.id }).where(eq(wellnessPackageRedemptions.appointmentId, m.id));
    }
    const [fresh] = await tx.select().from(appointments).where(eq(appointments.id, next.appointment.id));
    const priceChange = next.pricing.priceMinor - old.priceMinor;
    await audit(tx, { organizationId: old.organizationId, actorUserId: opts.actorUserId, action: 'appointment.rescheduled', scopeKind: 'location', scopeId: old.locationId, targetType: 'appointment', targetId: next.appointment.id, metadata: { from: old.id, oldStartsAt: old.startsAt.toISOString(), newStartsAt: next.appointment.startsAt.toISOString(), group: members.length > 1 } });
    return { previous: { ...old, status: 'rescheduled' }, appointment: fresh!, appointments: next.appointments, manageToken: next.manageToken, priceChange: { amount: priceChange, currency: old.currency } };
  });
}

/** Deposit actually collected for an appointment (succeeded payment minus refunds). */
export async function depositPaid(db: Exec, paymentId: string | null) {
  if (!paymentId) return { paid: 0, state: null as string | null, payment: null as typeof paymentReferences.$inferSelect | null };
  const [p] = await db.select().from(paymentReferences).where(eq(paymentReferences.id, paymentId));
  if (!p) return { paid: 0, state: null, payment: null };
  return { paid: p.state === 'succeeded' ? p.amountMinor - p.refundedMinor : 0, state: p.state, payment: p };
}

export type CancelMode = 'auto' | 'business' | 'no_show';

export interface CancellationPreview {
  window: 'free' | 'late' | 'no_show' | 'business';
  hoursBeforeStart: number;
  policy: ServicePolicy;
  policyText: string | null;
  price: { amount: number; currency: string };
  fee: { amount: number; currency: string };
  deposit: { paid: number; refund: number; retained: number; currency: string; paymentState: string | null };
  voucher: { applied: number; returned: number; retained: number; currency: string };
  packageSession: 'returned' | 'forfeited' | null;
  outstanding: { amount: number; currency: string };
}

/** What cancelling now would mean under the service policy (pure, after loading the inputs). */
export function computeCancellation(input: { members: AppointmentRow[]; svc: Service; depositPaidMinor: number; paymentState: string | null; now: Date; mode: CancelMode; waiveFee?: boolean }): CancellationPreview {
  const policy = policyOf(input.svc);
  const first = input.members[0]!;
  const currency = first.currency;
  const price = input.members.reduce((a, m) => a + m.priceMinor, 0);
  const voucherApplied = input.members.reduce((a, m) => a + m.voucherAppliedMinor, 0);
  const usesPackage = input.members.some((m) => !!m.clientPackageId);
  const hours = (first.startsAt.getTime() - input.now.getTime()) / 3600_000;
  const window: CancellationPreview['window'] = input.mode === 'business' ? 'business' : input.mode === 'no_show' ? 'no_show' : hours >= policy.freeCancelHours ? 'free' : 'late';
  const paid = input.depositPaidMinor;
  const base = { hoursBeforeStart: Math.round(hours * 10) / 10, policy, policyText: input.svc.cancellationPolicy, price: { amount: price, currency } };
  if (window === 'business' || window === 'free') {
    const keepDeposit = window === 'free' && !policy.depositRefundable;
    return {
      ...base, window, fee: { amount: 0, currency },
      deposit: { paid, refund: keepDeposit ? 0 : paid, retained: keepDeposit ? paid : 0, currency, paymentState: input.paymentState },
      voucher: { applied: voucherApplied, returned: voucherApplied, retained: 0, currency },
      packageSession: usesPackage ? 'returned' : null, outstanding: { amount: 0, currency },
    };
  }
  const percent = window === 'no_show' ? policy.noShowFeePercent : policy.lateCancelFeePercent;
  // A package session that is forfeited is the fee; no money is charged on top.
  const fee = input.waiveFee || usesPackage ? 0 : Math.round((price * percent) / 100);
  const fromDeposit = Math.min(paid, fee);
  const fromVoucher = Math.min(voucherApplied, fee - fromDeposit);
  return {
    ...base, window, fee: { amount: fee, currency },
    deposit: { paid, refund: paid - fromDeposit, retained: fromDeposit, currency, paymentState: input.paymentState },
    voucher: { applied: voucherApplied, returned: voucherApplied - fromVoucher, retained: fromVoucher, currency },
    packageSession: usesPackage ? (input.waiveFee ? 'returned' : 'forfeited') : null,
    outstanding: { amount: fee - fromDeposit - fromVoucher, currency },
  };
}

export async function cancellationPreview(db: Exec, appointmentId: string, mode: CancelMode = 'auto', opts: { waiveFee?: boolean; now?: Date } = {}) {
  const [a] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
  if (!a) throw notFound('Appointment');
  const members = await groupMembers(db, a);
  const [svc] = await db.select().from(services).where(eq(services.id, a.serviceId));
  const paymentId = members.find((m) => m.paymentId)?.paymentId ?? null;
  const dep = await depositPaid(db, paymentId);
  return { appointment: a, members, svc: svc!, payment: dep.payment, preview: computeCancellation({ members, svc: svc!, depositPaidMinor: dep.paid, paymentState: dep.state, now: opts.now ?? new Date(), mode, waiveFee: opts.waiveFee }) };
}

export function serializeAppointment(a: AppointmentRow) {
  return {
    id: a.id, locationId: a.locationId, serviceId: a.serviceId, variantId: a.variantId, practitionerId: a.practitionerId, resourceId: a.resourceId, customerId: a.customerId,
    startsAt: a.startsAt.toISOString(), endsAt: a.endsAt.toISOString(), blockedFrom: a.blockedFrom.toISOString(), blockedUntil: a.blockedUntil.toISOString(), status: a.status,
    price: { amount: a.priceMinor, currency: a.currency }, deposit: { amount: a.depositMinor, currency: a.currency }, voucherApplied: { amount: a.voucherAppliedMinor, currency: a.currency },
    clientPackageId: a.clientPackageId, groupId: a.groupId, seriesId: a.seriesId, source: a.source, checkedInAt: a.checkedInAt?.toISOString() ?? null,
    cancellationKind: a.cancellationKind, cancelledAt: a.cancelledAt?.toISOString() ?? null,
    rescheduledFromId: a.rescheduledFromId, rescheduledToId: a.rescheduledToId, paymentId: a.paymentId, createdAt: a.createdAt.toISOString(),
  };
}

/** Appointments of one practitioner overlapping a range (any location unless given). */
export async function practitionerAppointmentsIn(db: Exec, practitionerId: string, from: Date, until: Date, locationId?: string | null) {
  const conds = [eq(appointments.practitionerId, practitionerId), eq(appointments.status, 'confirmed'), lt(appointments.startsAt, until), gt(appointments.endsAt, from)];
  if (locationId) conds.push(eq(appointments.locationId, locationId));
  return db.select().from(appointments).where(and(...conds)).orderBy(asc(appointments.startsAt));
}


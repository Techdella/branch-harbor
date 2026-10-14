import { and, eq, gt, lt } from 'drizzle-orm';
import type { Db, Exec, Tx } from '../db/client.ts';
import { appointments, locations, practitioners, resources, services } from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { isExclusionViolation } from '../lib/pg.ts';
import { localDateParts, weekdayOf, zonedToUtc } from '../lib/tz.ts';
import { audit } from './audit.ts';

type Service = typeof services.$inferSelect;
type Practitioner = typeof practitioners.$inferSelect;

const SLOT_STEP_MINUTES = 15;

export function reservationWindow(svc: Pick<Service, 'durationMinutes' | 'bufferBeforeMinutes' | 'bufferAfterMinutes'>, startsAt: Date) {
  const endsAt = new Date(startsAt.getTime() + svc.durationMinutes * 60_000);
  return {
    startsAt,
    endsAt,
    blockedFrom: new Date(startsAt.getTime() - svc.bufferBeforeMinutes * 60_000),
    blockedUntil: new Date(endsAt.getTime() + svc.bufferAfterMinutes * 60_000),
  };
}

/** Is [start,end) inside one of the practitioner's weekly windows (location-local time)? */
export function withinAvailability(p: Practitioner, timeZone: string, startsAt: Date, endsAt: Date): boolean {
  const st = localDateParts(startsAt, timeZone);
  const en = localDateParts(endsAt, timeZone);
  if (en.date !== st.date && en.time !== '00:00') return false;
  const endTime = en.date === st.date ? en.time : '24:00';
  return p.availability.some((w) => w.weekday === st.weekday && w.start <= st.time && endTime <= w.end);
}

async function loadService(db: Exec, organizationId: string, locationId: string, serviceId: string) {
  const [svc] = await db.select().from(services).where(and(eq(services.id, serviceId), eq(services.organizationId, organizationId)));
  if (!svc || !svc.active || (svc.locationId && svc.locationId !== locationId)) throw notFound('Service');
  const [loc] = await db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!loc) throw notFound('Location');
  return { svc, loc };
}

async function eligiblePractitioners(db: Exec, locationId: string, serviceId: string, practitionerId?: string | null) {
  const rows = await db.select().from(practitioners).where(and(eq(practitioners.locationId, locationId), eq(practitioners.active, true)));
  const eligible = rows.filter((p) => p.serviceIds.includes(serviceId) && (!practitionerId || p.id === practitionerId));
  if (practitionerId && !eligible.length) throw validationError('This practitioner does not offer this service', { practitionerId: 'Not eligible' });
  return eligible;
}

/** Open slots for a service on a local date, honouring availability, buffers, existing reservations and resources. */
export async function availability(db: Exec, q: { organizationId: string; locationId: string; serviceId: string; date: string; practitionerId?: string }) {
  const { svc, loc } = await loadService(db, q.organizationId, q.locationId, q.serviceId);
  const pracs = await eligiblePractitioners(db, q.locationId, q.serviceId, q.practitionerId);
  const dayStart = zonedToUtc(q.date, '00:00', loc.timeZone);
  const dayEnd = new Date(dayStart.getTime() + 36 * 3600_000);
  const busy = pracs.length
    ? await db.select({ practitionerId: appointments.practitionerId, resourceId: appointments.resourceId, from: appointments.blockedFrom, until: appointments.blockedUntil }).from(appointments)
      .where(and(eq(appointments.locationId, q.locationId), eq(appointments.status, 'confirmed'), lt(appointments.blockedFrom, dayEnd), gt(appointments.blockedUntil, new Date(dayStart.getTime() - 12 * 3600_000))))
    : [];
  const resRows = svc.requiredResourceType
    ? await db.select().from(resources).where(and(eq(resources.locationId, q.locationId), eq(resources.type, svc.requiredResourceType), eq(resources.active, true)))
    : [];
  const weekday = weekdayOf(q.date);
  const now = new Date();
  const slots = new Map<string, { startsAt: string; endsAt: string; practitionerIds: string[] }>();
  for (const p of pracs) {
    for (const w of p.availability.filter((x) => x.weekday === weekday)) {
      const winStart = zonedToUtc(q.date, w.start, loc.timeZone);
      const winEnd = zonedToUtc(q.date, w.end === '24:00' ? '23:59' : w.end, loc.timeZone);
      for (let t = winStart.getTime(); t + svc.durationMinutes * 60_000 <= winEnd.getTime(); t += SLOT_STEP_MINUTES * 60_000) {
        const win = reservationWindow(svc, new Date(t));
        if (win.startsAt <= now) continue;
        const overlaps = (b: { from: Date; until: Date }) => b.from < win.blockedUntil && b.until > win.blockedFrom;
        if (busy.some((b) => b.practitionerId === p.id && overlaps(b))) continue;
        if (svc.requiredResourceType && !resRows.some((r) => !busy.some((b) => b.resourceId === r.id && overlaps(b)))) continue;
        const key = win.startsAt.toISOString();
        const slot = slots.get(key) ?? { startsAt: key, endsAt: win.endsAt.toISOString(), practitionerIds: [] };
        slot.practitionerIds.push(p.id);
        slots.set(key, slot);
      }
    }
  }
  return {
    service: { id: svc.id, name: svc.name, durationMinutes: svc.durationMinutes, price: { amount: svc.priceMinor, currency: svc.currency }, deposit: { amount: svc.depositMinor, currency: svc.currency }, cancellationPolicy: svc.cancellationPolicy },
    location: { id: loc.id, name: loc.name, timeZone: loc.timeZone },
    date: q.date,
    slots: [...slots.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
  };
}

export interface ReserveInput {
  organizationId: string;
  locationId: string;
  serviceId: string;
  practitionerId?: string | null;
  customerId: string;
  startsAt: Date;
  rescheduledFromId?: string;
  enforceAvailability?: boolean;
}

/**
 * Secure practitioner + resource for a slot inside the caller's transaction. Each candidate is tried in a
 * savepoint; the database exclusion constraints are the final arbiter, so two requests can never both win.
 */
export async function reserveAppointment(tx: Tx, input: ReserveInput) {
  const { svc, loc } = await loadService(tx, input.organizationId, input.locationId, input.serviceId);
  const win = reservationWindow(svc, input.startsAt);
  if (win.startsAt <= new Date()) throw validationError('Choose a time in the future', { startsAt: 'Must be in the future' });
  const pracs = (await eligiblePractitioners(tx, input.locationId, input.serviceId, input.practitionerId))
    .filter((p) => input.enforceAvailability === false || withinAvailability(p, loc.timeZone, win.startsAt, win.endsAt));
  if (!pracs.length) throw conflict('slot_unavailable', 'No practitioner is available at that time');
  const resRows = svc.requiredResourceType
    ? await tx.select().from(resources).where(and(eq(resources.locationId, input.locationId), eq(resources.type, svc.requiredResourceType), eq(resources.active, true)))
    : [null];
  if (!resRows.length) throw conflict('no_resource', `This service needs a ${svc.requiredResourceType} and none is configured`);

  const manageToken = randomToken();
  for (const p of pracs) {
    for (const r of resRows) {
      try {
        const row = await tx.transaction(async (sp) => {
          const [a] = await sp.insert(appointments).values({
            organizationId: input.organizationId, locationId: input.locationId, serviceId: svc.id, practitionerId: p.id, resourceId: r?.id ?? null,
            customerId: input.customerId, ...win, status: 'confirmed', priceMinor: svc.priceMinor, currency: svc.currency,
            rescheduledFromId: input.rescheduledFromId ?? null, manageTokenHash: sha256(manageToken),
          }).returning();
          return a!;
        });
        return { appointment: row, manageToken, service: svc, location: loc };
      } catch (err) {
        if (isExclusionViolation(err)) continue; // practitioner or resource taken — try next combination
        throw err;
      }
    }
  }
  throw new AppError(409, 'slot_unavailable', 'That time is no longer available. Please choose another slot.');
}

/**
 * Reschedule: the replacement is secured BEFORE the original is released, atomically. The original is
 * marked 'rescheduled' inside the transaction (so it doesn't block its own replacement under the
 * exclusion constraint); if the replacement cannot be secured the transaction rolls back and the
 * original appointment is untouched.
 */
export async function rescheduleAppointment(db: Db, appointmentId: string, opts: { organizationId?: string; startsAt: Date; practitionerId?: string | null; actorUserId: string | null }) {
  return db.transaction(async (tx) => {
    const [old] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId)).for('update');
    if (!old || (opts.organizationId && old.organizationId !== opts.organizationId)) throw notFound('Appointment');
    if (old.status !== 'confirmed') throw conflict('appointment_not_active', `Appointment is ${old.status}`);
    await tx.update(appointments).set({ status: 'rescheduled', updatedAt: new Date() }).where(eq(appointments.id, old.id));
    const next = await reserveAppointment(tx, {
      organizationId: old.organizationId, locationId: old.locationId, serviceId: old.serviceId, customerId: old.customerId,
      practitionerId: opts.practitionerId === undefined ? old.practitionerId : opts.practitionerId, startsAt: opts.startsAt, rescheduledFromId: old.id,
    });
    await tx.update(appointments).set({ rescheduledToId: next.appointment.id, paymentId: null }).where(eq(appointments.id, old.id));
    if (old.paymentId) await tx.update(appointments).set({ paymentId: old.paymentId }).where(eq(appointments.id, next.appointment.id));
    const priceChange = next.appointment.priceMinor - old.priceMinor;
    await audit(tx, { organizationId: old.organizationId, actorUserId: opts.actorUserId, action: 'appointment.rescheduled', scopeKind: 'location', scopeId: old.locationId, targetType: 'appointment', targetId: next.appointment.id, metadata: { from: old.id, oldStartsAt: old.startsAt.toISOString(), newStartsAt: next.appointment.startsAt.toISOString() } });
    return { previous: { ...old, status: 'rescheduled' }, appointment: next.appointment, manageToken: next.manageToken, priceChange: { amount: priceChange, currency: old.currency } };
  });
}

export function serializeAppointment(a: typeof appointments.$inferSelect) {
  return {
    id: a.id, locationId: a.locationId, serviceId: a.serviceId, practitionerId: a.practitionerId, resourceId: a.resourceId, customerId: a.customerId,
    startsAt: a.startsAt.toISOString(), endsAt: a.endsAt.toISOString(), status: a.status, price: { amount: a.priceMinor, currency: a.currency },
    rescheduledFromId: a.rescheduledFromId, rescheduledToId: a.rescheduledToId, paymentId: a.paymentId, createdAt: a.createdAt.toISOString(),
  };
}


/**
 * Wellness operations: availability exceptions with impact + rebook, recurring series, waitlist, calendar views,
 * utilisation, reports, consent-aware reminders and rebooking prompts, and client-note visibility.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, ne, notInArray, or } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Db, Exec } from '../db/client.ts';
import {
  appointments, consentRecords, customers, locations, paymentReferences, practitioners, resources, services, wellnessAppointmentCharges,
  wellnessAvailabilityExceptions, wellnessClientPackages, wellnessGiftVouchers, wellnessLocationSettings, wellnessMessageLog, wellnessPackagePlans,
  wellnessPractitionerLocations, wellnessResourceReservations, wellnessSeries, wellnessServiceVariants, wellnessWaitlist, type WeeklyAvailability,
} from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { addDays, localDateParts, weekdayOf, zonedToUtc } from '../lib/tz.ts';
import { audit } from './audit.ts';
import { liabilities } from './wellness-commerce.ts';
import { availability, practitionersAt, reserveAppointment, rescheduleAppointment, serializeAppointment, type AppointmentRow } from './wellness.ts';

const MIN = 60_000;
type Location = typeof locations.$inferSelect;
type Customer = typeof customers.$inferSelect;

// ───────────────────────── payments reconciliation helper ─────────────────────────

export async function purchaseStates(db: Exec, packageIds: string[], voucherIds: string[]) {
  const out = new Map<string, { status: string; expected: { amount: number; currency: string } }>();
  if (packageIds.length) for (const p of await db.select().from(wellnessClientPackages).where(inArray(wellnessClientPackages.id, packageIds))) out.set(p.id, { status: p.status, expected: { amount: p.priceMinor, currency: p.currency } });
  if (voucherIds.length) for (const v of await db.select().from(wellnessGiftVouchers).where(inArray(wellnessGiftVouchers.id, voucherIds))) out.set(v.id, { status: v.status, expected: { amount: v.initialMinor, currency: v.currency } });
  return out;
}

// ───────────────────────── consent + messages ─────────────────────────

export const REMINDER_PURPOSES = { email: 'appointment_reminders_email', sms: 'appointment_reminders_sms' } as const;

/** Latest consent decision for a purpose: true / false / null (never asked). */
export async function consentState(db: Exec, customerId: string, purpose: string): Promise<boolean | null> {
  const [r] = await db.select().from(consentRecords).where(and(eq(consentRecords.customerId, customerId), eq(consentRecords.purpose, purpose))).orderBy(desc(consentRecords.recordedAt)).limit(1);
  return r ? r.granted : null;
}

export interface ClientMessage {
  organizationId: string;
  locationId: string | null;
  customer: Customer;
  appointmentId?: string | null;
  kind: 'reminder' | 'rebook_prompt' | 'waitlist_offer' | 'schedule_change' | 'voucher_issued';
  channel: 'email' | 'sms';
  subject: string;
  text: string;
  dedupeKey: string;
  /** opt_in: needs a granted record; opt_out: allowed unless withdrawn; transactional: always (service messages). */
  consent: { purpose: string; model: 'opt_in' | 'opt_out' } | 'transactional';
}

/** Sends through the existing adapters (log/sandbox without keys). One row per dedupe key — retries never double-send. */
export async function sendClientMessage(s: Services, m: ClientMessage) {
  const to = m.channel === 'email' ? m.customer.email : m.customer.phone;
  let status: string | null = null;
  if (m.customer.erasedAt || !to) status = 'skipped_no_contact';
  else if (m.consent !== 'transactional') {
    const c = await consentState(s.db, m.customer.id, m.consent.purpose);
    if (m.consent.model === 'opt_in' ? c !== true : c === false) status = 'skipped_no_consent';
  }
  const [row] = await s.db.insert(wellnessMessageLog).values({
    organizationId: m.organizationId, locationId: m.locationId, appointmentId: m.appointmentId ?? null, customerId: m.customer.id, kind: m.kind, channel: m.channel,
    status: status ?? 'sending', dedupeKey: m.dedupeKey, detail: status ? null : m.subject,
  }).onConflictDoNothing().returning();
  if (!row) return { status: 'duplicate' as const };
  if (status) return { status };
  try {
    const r = m.channel === 'email' ? await s.mailer.send({ to: to!, subject: m.subject, text: m.text, tag: `wellness_${m.kind}` }) : await s.messaging.sendSms(to!, m.text);
    status = r.delivered ? 'sent' : 'logged';
  } catch (err) {
    s.log.warn({ err }, 'wellness message failed');
    status = 'failed';
  }
  await s.db.update(wellnessMessageLog).set({ status }).where(eq(wellnessMessageLog.id, row.id));
  return { status };
}

const fmtLocal = (d: Date, loc: Location) => new Intl.DateTimeFormat(loc.locale ?? 'en', { timeZone: loc.timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);

async function locationSettings(db: Exec, locationId: string) {
  const [r] = await db.select().from(wellnessLocationSettings).where(eq(wellnessLocationSettings.locationId, locationId));
  return r ?? { reminderHoursBefore: 24, smsReminders: true, emailReminders: true, rebookPrompts: true };
}

/** Appointment reminders for the next N hours per location (email unless withdrawn; SMS only with opt-in). */
export async function runReminders(s: Services, opts: { organizationId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const conds = [eq(appointments.status, 'confirmed'), gt(appointments.startsAt, now), lt(appointments.startsAt, new Date(now.getTime() + 72 * 3600_000))];
  if (opts.organizationId) conds.push(eq(appointments.organizationId, opts.organizationId));
  const rows = await s.db.select({ a: appointments, c: customers, l: locations, svc: services.name }).from(appointments)
    .innerJoin(customers, eq(customers.id, appointments.customerId)).innerJoin(locations, eq(locations.id, appointments.locationId)).innerJoin(services, eq(services.id, appointments.serviceId))
    .where(and(...conds));
  const counts: Record<string, number> = {};
  const settings = new Map<string, Awaited<ReturnType<typeof locationSettings>>>();
  for (const r of rows) {
    if (!settings.has(r.l.id)) settings.set(r.l.id, await locationSettings(s.db, r.l.id));
    const st = settings.get(r.l.id)!;
    if (r.a.startsAt.getTime() - now.getTime() > st.reminderHoursBefore * 3600_000) continue;
    const when = `${fmtLocal(r.a.startsAt, r.l)} (${r.l.timeZone})`;
    const text = `Reminder: ${r.svc} at ${r.l.name} on ${when}. To change or cancel, use the link in your confirmation email. Our cancellation policy applies.`;
    for (const channel of ['email', 'sms'] as const) {
      if ((channel === 'email' && !st.emailReminders) || (channel === 'sms' && !st.smsReminders)) continue;
      const res = await sendClientMessage(s, {
        organizationId: r.a.organizationId, locationId: r.l.id, customer: r.c, appointmentId: r.a.id, kind: 'reminder', channel, subject: `Your appointment at ${r.l.name}`, text,
        dedupeKey: `reminder:${r.a.id}:${channel}`, consent: { purpose: REMINDER_PURPOSES[channel], model: channel === 'email' ? 'opt_out' : 'opt_in' },
      });
      counts[`${channel}_${res.status}`] = (counts[`${channel}_${res.status}`] ?? 0) + 1;
    }
  }
  return counts;
}

/** Retention: invite clients to rebook N weeks after their last visit — only with marketing consent. */
export async function runRebookPrompts(s: Services, opts: { organizationId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const svcConds = [gt(services.rebookAfterWeeks, 0), eq(services.active, true)];
  if (opts.organizationId) svcConds.push(eq(services.organizationId, opts.organizationId));
  const svcs = await s.db.select().from(services).where(and(...svcConds));
  const counts: Record<string, number> = {};
  for (const svc of svcs) {
    const cutoff = new Date(now.getTime() - svc.rebookAfterWeeks! * 7 * 86400_000);
    const past = await s.db.select({ a: appointments, c: customers, l: locations }).from(appointments)
      .innerJoin(customers, eq(customers.id, appointments.customerId)).innerJoin(locations, eq(locations.id, appointments.locationId))
      .where(and(eq(appointments.serviceId, svc.id), inArray(appointments.status, ['completed', 'confirmed']), lt(appointments.startsAt, now))).orderBy(desc(appointments.startsAt));
    const latest = new Map<string, (typeof past)[number]>();
    for (const r of past) if (!latest.has(r.c.id)) latest.set(r.c.id, r);
    for (const r of latest.values()) {
      if (r.a.startsAt > cutoff) continue;
      const settings = await locationSettings(s.db, r.l.id);
      if (!settings.rebookPrompts) continue;
      const [future] = await s.db.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.customerId, r.c.id), eq(appointments.status, 'confirmed'), gt(appointments.startsAt, now))).limit(1);
      if (future) continue;
      const res = await sendClientMessage(s, {
        organizationId: svc.organizationId, locationId: r.l.id, customer: r.c, appointmentId: r.a.id, kind: 'rebook_prompt', channel: 'email',
        subject: `Time for your next ${svc.name}?`, text: `It has been a while since your ${svc.name} at ${r.l.name}. Book your next visit online whenever suits you. You can unsubscribe from these messages at any time.`,
        dedupeKey: `rebook:${r.a.id}:email`, consent: { purpose: 'marketing_email', model: 'opt_in' },
      });
      counts[res.status] = (counts[res.status] ?? 0) + 1;
    }
  }
  return counts;
}

// ───────────────────────── templates & exceptions ─────────────────────────

export async function templatesOf(db: Exec, practitionerId: string) {
  const [p] = await db.select().from(practitioners).where(eq(practitioners.id, practitionerId));
  if (!p) throw notFound('Practitioner');
  const extra = await db.select().from(wellnessPractitionerLocations).where(and(eq(wellnessPractitionerLocations.practitionerId, p.id), eq(wellnessPractitionerLocations.active, true)));
  return { practitioner: p, templates: [{ locationId: p.locationId, home: true, availability: p.availability }, ...extra.filter((x) => x.locationId !== p.locationId).map((x) => ({ locationId: x.locationId, home: false, availability: x.availability }))] };
}

export async function exceptionImpact(db: Exec, ex: typeof wellnessAvailabilityExceptions.$inferSelect) {
  const conds = [eq(appointments.practitionerId, ex.practitionerId), eq(appointments.status, 'confirmed'), lt(appointments.startsAt, ex.endsAt), gt(appointments.endsAt, ex.startsAt)];
  if (ex.locationId) conds.push(eq(appointments.locationId, ex.locationId));
  const rows = await db.select({ a: appointments, svc: services.name, c: customers.name, l: locations }).from(appointments)
    .innerJoin(services, eq(services.id, appointments.serviceId)).innerJoin(customers, eq(customers.id, appointments.customerId)).innerJoin(locations, eq(locations.id, appointments.locationId))
    .where(and(...conds)).orderBy(asc(appointments.startsAt));
  const items = [];
  for (const r of rows) {
    // Alternatives at the same time with another eligible practitioner (availability excludes the absent one).
    let sameTime: string[] = [];
    try {
      const day = localDateParts(r.a.startsAt, r.l.timeZone).date;
      const av = await availability(db, { organizationId: r.a.organizationId, locationId: r.a.locationId, serviceId: r.a.serviceId, variantId: r.a.variantId ?? undefined, date: day });
      const slot = av.slots.find((x) => x.startsAt === r.a.startsAt.toISOString());
      sameTime = (slot?.practitionerIds ?? []).filter((id) => id !== ex.practitionerId);
    } catch { /* service no longer offered: no alternatives */ }
    const names = sameTime.length ? await db.select({ id: practitioners.id, name: practitioners.name }).from(practitioners).where(inArray(practitioners.id, sameTime)) : [];
    items.push({ appointment: serializeAppointment(r.a), serviceName: r.svc, clientName: r.c, location: { id: r.l.id, name: r.l.name, timeZone: r.l.timeZone }, alternatives: names });
  }
  return items;
}

export type RebookAction =
  | { appointmentId: string; action: 'reassign'; practitionerId?: string }
  | { appointmentId: string; action: 'reschedule'; startsAt: string; practitionerId?: string }
  | { appointmentId: string; action: 'cancel'; notify?: boolean };

/** Applies each action independently (partial failures are reported per appointment). Originals are kept on failure. */
export async function rebookAffected(s: Services, exceptionId: string, organizationId: string, actions: RebookAction[], actorUserId: string) {
  const [ex] = await s.db.select().from(wellnessAvailabilityExceptions).where(and(eq(wellnessAvailabilityExceptions.id, exceptionId), eq(wellnessAvailabilityExceptions.organizationId, organizationId)));
  if (!ex) throw notFound('Exception');
  const affected = new Set((await exceptionImpact(s.db, ex)).map((i) => i.appointment.id));
  const { applyCancellation } = await import('./wellness-commerce.ts');
  const results: Array<{ appointmentId: string; action: string; status: 'done' | 'failed'; newAppointmentId?: string; error?: { code: string; message: string } }> = [];
  for (const act of actions) {
    if (!affected.has(act.appointmentId)) {
      results.push({ appointmentId: act.appointmentId, action: act.action, status: 'failed', error: { code: 'not_affected', message: 'This appointment is not affected by the exception' } });
      continue;
    }
    try {
      const [a] = await s.db.select().from(appointments).where(eq(appointments.id, act.appointmentId));
      if (act.action === 'cancel') {
        await applyCancellation(s, a!.id, { organizationId, mode: 'business', actorUserId, reason: `Practitioner unavailable (${ex.kind})` });
        if (act.notify !== false) await notifyScheduleChange(s, a!, 'cancelled');
        results.push({ appointmentId: a!.id, action: act.action, status: 'done' });
      } else {
        let practitionerId = act.practitionerId ?? null;
        if (act.action === 'reassign' && !practitionerId) {
          const alt = (await exceptionImpact(s.db, ex)).find((i) => i.appointment.id === a!.id)?.alternatives[0];
          if (!alt) throw conflict('no_alternative', 'No other practitioner is free at that time');
          practitionerId = alt.id;
        }
        const startsAt = act.action === 'reschedule' ? new Date(act.startsAt) : a!.startsAt;
        const r = await rescheduleAppointment(s.db, a!.id, { organizationId, startsAt, practitionerIds: practitionerId ? [practitionerId] : null, actorUserId });
        await notifyScheduleChange(s, r.appointment, 'changed');
        results.push({ appointmentId: a!.id, action: act.action, status: 'done', newAppointmentId: r.appointment.id });
      }
    } catch (err) {
      const e = err as AppError;
      results.push({ appointmentId: act.appointmentId, action: act.action, status: 'failed', error: { code: e.code ?? 'error', message: e.message } });
    }
  }
  await audit(s.db, { organizationId, actorUserId, action: 'wellness.exception_rebook', targetType: 'wellness_exception', targetId: ex.id, metadata: { results: results.map((r) => ({ id: r.appointmentId, action: r.action, status: r.status })) } });
  return { results, done: results.filter((r) => r.status === 'done').length, failed: results.filter((r) => r.status === 'failed').length };
}

async function notifyScheduleChange(s: Services, a: AppointmentRow, what: 'changed' | 'cancelled') {
  const [row] = await s.db.select({ c: customers, l: locations }).from(customers).innerJoin(locations, eq(locations.id, a.locationId)).where(eq(customers.id, a.customerId));
  if (!row) return;
  await sendClientMessage(s, {
    organizationId: a.organizationId, locationId: a.locationId, customer: row.c, appointmentId: a.id, kind: 'schedule_change', channel: 'email', consent: 'transactional', dedupeKey: `change:${a.id}:${what}`,
    subject: what === 'cancelled' ? `Your appointment at ${row.l.name} was cancelled` : `Your appointment at ${row.l.name} has changed`,
    text: what === 'cancelled' ? `We're sorry — we had to cancel your appointment on ${fmtLocal(a.startsAt, row.l)}. Any deposit is refunded in full. Please book a new time online.` : `Your appointment is now on ${fmtLocal(a.startsAt, row.l)} (${row.l.timeZone}). Reply or use your booking link if this doesn't suit you.`,
  });
}

// ───────────────────────── recurring series ─────────────────────────

export interface SeriesInput {
  organizationId: string;
  locationId: string;
  serviceId: string;
  variantId?: string | null;
  practitionerId?: string | null;
  customerId: string;
  firstDate: string;
  localTime: string;
  intervalWeeks: number;
  occurrences: number;
  mode: 'all_or_nothing' | 'skip_conflicts';
  dryRun: boolean;
  actorUserId: string;
}

class DryRun extends Error { constructor(public readonly payload: unknown) { super('dry_run'); } }

/** Weekly series in the location's wall-clock time (DST-safe). Conflicts are reported per occurrence. */
export async function createSeries(db: Db, input: SeriesInput) {
  const [loc] = await db.select().from(locations).where(and(eq(locations.id, input.locationId), eq(locations.organizationId, input.organizationId)));
  if (!loc) throw notFound('Location');
  const dates = Array.from({ length: input.occurrences }, (_, i) => addDays(input.firstDate, i * 7 * input.intervalWeeks));
  try {
    return await db.transaction(async (tx) => {
      const [series] = await tx.insert(wellnessSeries).values({
        organizationId: input.organizationId, locationId: loc.id, customerId: input.customerId, serviceId: input.serviceId, variantId: input.variantId ?? null, practitionerId: input.practitionerId ?? null,
        intervalWeeks: input.intervalWeeks, occurrences: input.occurrences, firstDate: input.firstDate, localTime: input.localTime, createdBy: input.actorUserId,
      }).returning();
      const occurrences: Array<{ date: string; startsAt: string; status: 'booked' | 'conflict'; appointment?: ReturnType<typeof serializeAppointment>; error?: { code: string; message: string } }> = [];
      let token: string | null = null;
      for (const date of dates) {
        const startsAt = zonedToUtc(date, input.localTime, loc.timeZone);
        try {
          const r = await tx.transaction((sp) => reserveAppointment(sp, { organizationId: input.organizationId, locationId: loc.id, serviceId: input.serviceId, variantId: input.variantId, practitionerId: input.practitionerId, customerId: input.customerId, startsAt, source: 'series', seriesId: series!.id }));
          token ??= r.manageToken;
          occurrences.push({ date, startsAt: startsAt.toISOString(), status: 'booked', appointment: serializeAppointment(r.appointment) });
        } catch (err) {
          if (!(err instanceof AppError) || err.status >= 500) throw err;
          occurrences.push({ date, startsAt: startsAt.toISOString(), status: 'conflict', error: { code: err.code, message: err.message } });
        }
      }
      const conflicts = occurrences.filter((o) => o.status === 'conflict');
      const result = { series: { id: series!.id, intervalWeeks: input.intervalWeeks, occurrences: input.occurrences, firstDate: input.firstDate, localTime: input.localTime, timeZone: loc.timeZone }, occurrences, booked: occurrences.length - conflicts.length, conflicts: conflicts.length, dryRun: input.dryRun };
      if (input.dryRun) throw new DryRun({ ...result, series: { ...result.series, id: null } });
      if (conflicts.length && input.mode === 'all_or_nothing') throw conflict('series_conflicts', `${conflicts.length} of ${dates.length} dates are not available — nothing was booked`, { occurrences });
      if (!result.booked) throw conflict('series_conflicts', 'None of the dates are available', { occurrences });
      await audit(tx, { organizationId: input.organizationId, actorUserId: input.actorUserId, action: 'wellness.series_created', scopeKind: 'location', scopeId: loc.id, targetType: 'wellness_series', targetId: series!.id, metadata: { booked: result.booked, conflicts: result.conflicts } });
      return result;
    });
  } catch (err) {
    if (err instanceof DryRun) return err.payload as Record<string, unknown>;
    throw err;
  }
}

// ───────────────────────── waitlist ─────────────────────────

export async function joinWaitlist(db: Exec, input: { organizationId: string; locationId: string; serviceId: string; variantId?: string | null; practitionerId?: string | null; customerId: string; windowStart: Date; windowEnd: Date; note?: string | null }) {
  if (input.windowEnd <= input.windowStart) throw validationError('The window must end after it starts', { windowEnd: 'Must be after the start' });
  if (input.windowEnd <= new Date()) throw validationError('Choose a window in the future', { windowEnd: 'In the past' });
  const token = randomToken();
  const [w] = await db.insert(wellnessWaitlist).values({ ...input, variantId: input.variantId ?? null, practitionerId: input.practitionerId ?? null, note: input.note ?? null, manageTokenHash: sha256(token) }).returning();
  return { entry: w!, manageToken: token };
}

/** When time frees up, offer it to the first waiting client whose window fits (FIFO). */
export async function offerFreedTime(s: Services, a: Pick<AppointmentRow, 'organizationId' | 'locationId' | 'serviceId' | 'startsAt' | 'endsAt'>) {
  const now = new Date();
  await s.db.update(wellnessWaitlist).set({ status: 'expired', updatedAt: now }).where(and(eq(wellnessWaitlist.locationId, a.locationId), inArray(wellnessWaitlist.status, ['waiting', 'offered']), lt(wellnessWaitlist.windowEnd, now)));
  const waiting = await s.db.select().from(wellnessWaitlist).where(and(eq(wellnessWaitlist.locationId, a.locationId), eq(wellnessWaitlist.serviceId, a.serviceId), eq(wellnessWaitlist.status, 'waiting'), lt(wellnessWaitlist.windowStart, a.endsAt), gt(wellnessWaitlist.windowEnd, a.startsAt))).orderBy(asc(wellnessWaitlist.createdAt));
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, a.locationId));
  if (!loc) return null;
  for (const w of waiting) {
    const day = localDateParts(a.startsAt, loc.timeZone).date;
    const av = await availability(s.db, { organizationId: a.organizationId, locationId: a.locationId, serviceId: a.serviceId, variantId: w.variantId ?? undefined, date: day, practitionerId: w.practitionerId ?? undefined }).catch(() => null);
    const slot = av?.slots.find((x) => new Date(x.startsAt) >= w.windowStart && new Date(x.endsAt) <= w.windowEnd);
    if (!slot) continue;
    await s.db.update(wellnessWaitlist).set({ status: 'offered', offeredAt: now, offeredStartsAt: new Date(slot.startsAt), offeredPractitionerId: slot.practitionerIds[0] ?? null, updatedAt: now }).where(eq(wellnessWaitlist.id, w.id));
    const [c] = await s.db.select().from(customers).where(eq(customers.id, w.customerId));
    if (c) await sendClientMessage(s, { organizationId: w.organizationId, locationId: w.locationId, customer: c, kind: 'waitlist_offer', channel: 'email', consent: 'transactional', dedupeKey: `waitlist:${w.id}:${slot.startsAt}`, subject: `A time opened up at ${loc.name}`, text: `Good news — ${fmtLocal(new Date(slot.startsAt), loc)} (${loc.timeZone}) is now free. Use your waitlist link to claim it; it goes to the next person if someone else books first.` });
    return { waitlistId: w.id, startsAt: slot.startsAt };
  }
  return null;
}

export function serializeWaitlist(w: typeof wellnessWaitlist.$inferSelect) {
  return {
    id: w.id, locationId: w.locationId, serviceId: w.serviceId, variantId: w.variantId, practitionerId: w.practitionerId, customerId: w.customerId,
    windowStart: w.windowStart.toISOString(), windowEnd: w.windowEnd.toISOString(), status: w.status, offeredStartsAt: w.offeredStartsAt?.toISOString() ?? null,
    offeredPractitionerId: w.offeredPractitionerId, appointmentId: w.appointmentId, note: w.note, createdAt: w.createdAt.toISOString(),
  };
}

// ───────────────────────── calendar & utilisation ─────────────────────────

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
const overlapMs = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

function windowsOn(windows: WeeklyAvailability, date: string, tz: string) {
  const wd = weekdayOf(date);
  return windows.filter((w) => w.weekday === wd).map((w) => ({ start: w.start, end: w.end, from: zonedToUtc(date, w.start, tz).getTime(), until: w.end === '24:00' ? zonedToUtc(addDays(date, 1), '00:00', tz).getTime() : zonedToUtc(date, w.end, tz).getTime() }));
}

export interface Viewer { userId: string; customersAt: 'all' | Set<string> }
const canSeeClient = (v: Viewer, locationId: string, practitionerUserId: string | null) => v.customersAt === 'all' || v.customersAt.has(locationId) || (!!practitionerUserId && practitionerUserId === v.userId);

/** One location's day: columns (practitioners or rooms) with working windows, exceptions and appointments. */
export async function calendarDay(db: Exec, q: { organizationId: string; locationId: string; date: string; viewer: Viewer }) {
  const [loc] = await db.select().from(locations).where(and(eq(locations.id, q.locationId), eq(locations.organizationId, q.organizationId)));
  if (!loc) throw notFound('Location');
  const from = zonedToUtc(q.date, '00:00', loc.timeZone);
  const until = zonedToUtc(addDays(q.date, 1), '00:00', loc.timeZone);
  const pracs = await practitionersAt(db, q.organizationId, loc.id);
  const rooms = await db.select().from(resources).where(and(eq(resources.locationId, loc.id), eq(resources.active, true))).orderBy(asc(resources.type), asc(resources.name));
  const rows = await db.select({ a: appointments, svc: services, c: customers, p: practitioners }).from(appointments)
    .innerJoin(services, eq(services.id, appointments.serviceId)).innerJoin(customers, eq(customers.id, appointments.customerId)).innerJoin(practitioners, eq(practitioners.id, appointments.practitionerId))
    .where(and(eq(appointments.locationId, loc.id), ne(appointments.status, 'rescheduled'), lt(appointments.startsAt, until), gt(appointments.endsAt, from))).orderBy(asc(appointments.startsAt));
  const ids = rows.map((r) => r.a.id);
  const holds = ids.length ? await db.select().from(wellnessResourceReservations).where(inArray(wellnessResourceReservations.appointmentId, ids)) : [];
  const variantIds = [...new Set(rows.map((r) => r.a.variantId).filter(Boolean))] as string[];
  const variants = variantIds.length ? await db.select().from(wellnessServiceVariants).where(inArray(wellnessServiceVariants.id, variantIds)) : [];
  const pracIds = pracs.map((x) => x.p.id);
  const exc = pracIds.length ? await db.select().from(wellnessAvailabilityExceptions).where(and(inArray(wellnessAvailabilityExceptions.practitionerId, pracIds), eq(wellnessAvailabilityExceptions.status, 'active'), lt(wellnessAvailabilityExceptions.startsAt, until), gt(wellnessAvailabilityExceptions.endsAt, from), or(isNull(wellnessAvailabilityExceptions.locationId), eq(wellnessAvailabilityExceptions.locationId, loc.id)))) : [];
  const groupRoom = new Map<string, string>();
  for (const r of rows) if (r.a.groupId && r.a.resourceId) groupRoom.set(r.a.groupId, r.a.resourceId);
  const appts = rows.map((r) => {
    const visible = canSeeClient(q.viewer, loc.id, r.p.userId);
    const roomId = r.a.resourceId ?? (r.a.groupId ? groupRoom.get(r.a.groupId) ?? null : null);
    return {
      ...serializeAppointment(r.a), serviceName: r.svc.name, variantName: variants.find((v) => v.id === r.a.variantId)?.name ?? null, practitionerName: r.p.name,
      clientName: visible ? r.c.name : null, clientVisible: visible, roomId, roomName: rooms.find((x) => x.id === roomId)?.name ?? null,
      equipment: holds.filter((h) => h.appointmentId === r.a.id && h.role === 'equipment').map((h) => ({ id: h.resourceId, name: rooms.find((x) => x.id === h.resourceId)?.name ?? null })),
      mine: !!r.p.userId && r.p.userId === q.viewer.userId,
    };
  });
  const booked = (pred: (a: (typeof appts)[number]) => boolean) => appts.filter((a) => ['confirmed', 'completed', 'no_show'].includes(a.status) && pred(a)).reduce((s, a) => s + overlapMs(new Date(a.startsAt).getTime(), new Date(a.endsAt).getTime(), from.getTime(), until.getTime()), 0) / MIN;
  const pracCols = pracs.map((x) => {
    const wins = windowsOn(x.windows, q.date, loc.timeZone);
    const ex = exc.filter((e) => e.practitionerId === x.p.id);
    const available = wins.reduce((s, w) => s + (w.until - w.from) - ex.reduce((t, e) => t + overlapMs(w.from, w.until, e.startsAt.getTime(), e.endsAt.getTime()), 0), 0) / MIN;
    const b = booked((a) => a.practitionerId === x.p.id);
    return {
      id: x.p.id, name: x.p.name, kind: 'practitioner' as const, home: x.home, userId: x.p.userId, windows: wins.map((w) => ({ start: w.start, end: w.end })),
      exceptions: ex.map((e) => ({ id: e.id, kind: e.kind, startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString(), reason: e.reason })),
      utilisation: { bookedMinutes: b, availableMinutes: available, rate: available > 0 ? Math.round((b / available) * 1000) / 1000 : null },
    };
  });
  const openMinutes = (() => {
    const spans = pracCols.flatMap((c) => c.windows.map((w) => [minutesOf(w.start), minutesOf(w.end)] as [number, number])).sort((a, b) => a[0] - b[0]);
    let total = 0; let cur: [number, number] | null = null;
    for (const s of spans) { if (!cur || s[0] > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [...s]; } else cur[1] = Math.max(cur[1], s[1]); }
    if (cur) total += cur[1] - cur[0];
    return total;
  })();
  const roomCols = rooms.map((r) => {
    const b = appts.filter((a) => ['confirmed', 'completed', 'no_show'].includes(a.status) && (a.resourceId === r.id || a.equipment.some((e) => e.id === r.id))).reduce((s, a) => s + (new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / MIN, 0);
    return { id: r.id, name: r.name, kind: r.type === 'room' ? 'room' as const : 'equipment' as const, type: r.type, utilisation: { bookedMinutes: b, availableMinutes: openMinutes, rate: openMinutes > 0 ? Math.round((b / openMinutes) * 1000) / 1000 : null } };
  });
  return { location: { id: loc.id, name: loc.name, timeZone: loc.timeZone, currency: loc.currency }, date: q.date, practitioners: pracCols, rooms: roomCols, appointments: appts };
}

/** Utilisation across a date range for every practitioner/room in the given locations. */
export async function utilisation(db: Exec, q: { organizationId: string; locationIds: string[]; from: string; to: string; viewer: Viewer }) {
  const days: string[] = [];
  for (let d = q.from; d <= q.to && days.length < 62; d = addDays(d, 1)) days.push(d);
  const pr = new Map<string, { id: string; name: string; locationId: string; locationName: string; bookedMinutes: number; availableMinutes: number }>();
  const rm = new Map<string, { id: string; name: string; type: string; locationId: string; locationName: string; bookedMinutes: number; availableMinutes: number }>();
  for (const locationId of q.locationIds) {
    for (const date of days) {
      const day = await calendarDay(db, { organizationId: q.organizationId, locationId, date, viewer: q.viewer });
      for (const c of day.practitioners) {
        const key = `${c.id}:${locationId}`;
        const r = pr.get(key) ?? { id: c.id, name: c.name, locationId, locationName: day.location.name, bookedMinutes: 0, availableMinutes: 0 };
        r.bookedMinutes += c.utilisation.bookedMinutes; r.availableMinutes += c.utilisation.availableMinutes;
        pr.set(key, r);
      }
      for (const c of day.rooms) {
        const r = rm.get(c.id) ?? { id: c.id, name: c.name, type: c.type, locationId, locationName: day.location.name, bookedMinutes: 0, availableMinutes: 0 };
        r.bookedMinutes += c.utilisation.bookedMinutes; r.availableMinutes += c.utilisation.availableMinutes;
        rm.set(c.id, r);
      }
    }
  }
  const rate = (b: number, a: number) => (a > 0 ? Math.round((b / a) * 1000) / 1000 : null);
  return {
    from: q.from, to: q.to,
    definition: 'Booked appointment minutes (confirmed, completed and no-show) divided by scheduled working minutes (weekly templates minus leave). Rooms use the location’s combined working hours.',
    practitioners: [...pr.values()].map((r) => ({ ...r, rate: rate(r.bookedMinutes, r.availableMinutes) })),
    rooms: [...rm.values()].map((r) => ({ ...r, rate: rate(r.bookedMinutes, r.availableMinutes) })),
  };
}

// ───────────────────────── reports ─────────────────────────

export async function wellnessReport(db: Exec, q: { organizationId: string; locationIds: string[]; from: string; to: string; viewer: Viewer }) {
  const locs = await db.select().from(locations).where(and(eq(locations.organizationId, q.organizationId), inArray(locations.id, q.locationIds.length ? q.locationIds : ['00000000-0000-0000-0000-000000000000'])));
  const tzOf = new Map(locs.map((l) => [l.id, l.timeZone]));
  const ranges = locs.map((l) => ({ id: l.id, from: zonedToUtc(q.from, '00:00', l.timeZone), until: zonedToUtc(addDays(q.to, 1), '00:00', l.timeZone) }));
  const inRange = (locId: string, d: Date) => { const r = ranges.find((x) => x.id === locId); return !!r && d >= r.from && d < r.until; };
  const appts = q.locationIds.length ? (await db.select().from(appointments).where(and(eq(appointments.organizationId, q.organizationId), inArray(appointments.locationId, q.locationIds), ne(appointments.status, 'rescheduled')))).filter((a) => inRange(a.locationId, a.startsAt)) : [];
  const perLoc = locs.map((l) => {
    const xs = appts.filter((a) => a.locationId === l.id);
    const c = (k: string) => xs.filter((a) => a.cancellationKind === k).length;
    const total = xs.length;
    const cancelled = xs.filter((a) => a.status === 'cancelled').length;
    return { locationId: l.id, locationName: l.name, booked: total, completed: xs.filter((a) => a.status === 'completed').length, cancelled, freeCancellations: c('free'), lateCancellations: c('late'), businessCancellations: c('business'), noShows: xs.filter((a) => a.status === 'no_show').length, cancellationRate: total ? Math.round((cancelled / total) * 1000) / 1000 : null };
  });
  const rev = new Map<string, { currency: string; appointmentValueMinor: number; packageSessionsUsed: number; depositsCollectedMinor: number; packagesSoldMinor: number; vouchersSoldMinor: number; feesRetainedMinor: number; feesOutstandingMinor: number; refundsMinor: number }>();
  const row = (cur: string) => { let r = rev.get(cur); if (!r) { r = { currency: cur, appointmentValueMinor: 0, packageSessionsUsed: 0, depositsCollectedMinor: 0, packagesSoldMinor: 0, vouchersSoldMinor: 0, feesRetainedMinor: 0, feesOutstandingMinor: 0, refundsMinor: 0 }; rev.set(cur, r); } return r; };
  for (const a of appts) {
    if (!['confirmed', 'completed'].includes(a.status)) continue;
    if (a.clientPackageId) row(a.currency).packageSessionsUsed += 1; else row(a.currency).appointmentValueMinor += a.priceMinor;
  }
  const lowest = ranges.reduce((m, r) => (r.from < m ? r.from : m), new Date(8.64e15));
  const highest = ranges.reduce((m, r) => (r.until > m ? r.until : m), new Date(0));
  if (q.locationIds.length) {
    const pays = await db.select().from(paymentReferences).where(and(eq(paymentReferences.organizationId, q.organizationId), inArray(paymentReferences.locationId, q.locationIds), eq(paymentReferences.state, 'succeeded'), gte(paymentReferences.createdAt, lowest), lt(paymentReferences.createdAt, highest), inArray(paymentReferences.targetType, ['appointment', 'wellness_package', 'wellness_voucher'])));
    for (const p of pays) {
      if (!inRange(p.locationId!, p.createdAt)) continue;
      const r = row(p.currency);
      if (p.targetType === 'appointment') r.depositsCollectedMinor += p.amountMinor;
      if (p.targetType === 'wellness_package') r.packagesSoldMinor += p.amountMinor;
      if (p.targetType === 'wellness_voucher') r.vouchersSoldMinor += p.amountMinor;
      r.refundsMinor += p.refundedMinor;
    }
    const inPerson = await db.select().from(wellnessClientPackages).where(and(eq(wellnessClientPackages.organizationId, q.organizationId), inArray(wellnessClientPackages.locationId, q.locationIds), eq(wellnessClientPackages.paidVia, 'in_person')));
    for (const cp of inPerson) if (cp.purchasedAt && inRange(cp.locationId, cp.purchasedAt)) row(cp.currency).packagesSoldMinor += cp.priceMinor;
    const vIn = await db.select().from(wellnessGiftVouchers).where(and(eq(wellnessGiftVouchers.organizationId, q.organizationId), inArray(wellnessGiftVouchers.locationId, q.locationIds), isNull(wellnessGiftVouchers.paymentId), notInArray(wellnessGiftVouchers.status, ['pending_payment', 'cancelled'])));
    for (const v of vIn) if (v.locationId && inRange(v.locationId, v.createdAt)) row(v.currency).vouchersSoldMinor += v.initialMinor;
    const charges = await db.select().from(wellnessAppointmentCharges).where(and(eq(wellnessAppointmentCharges.organizationId, q.organizationId), inArray(wellnessAppointmentCharges.locationId, q.locationIds)));
    for (const c of charges) {
      if (!inRange(c.locationId, c.createdAt) || c.status === 'waived') continue;
      const r = row(c.currency);
      r.feesRetainedMinor += c.retainedFromDepositMinor + c.retainedFromVoucherMinor;
      r.feesOutstandingMinor += c.outstandingMinor;
    }
  }
  const util = await utilisation(db, { organizationId: q.organizationId, locationIds: q.locationIds, from: q.from, to: q.to, viewer: q.viewer });
  const liab = await liabilities(db, q.organizationId, q.locationIds);
  const plans = await db.select().from(wellnessPackagePlans).where(eq(wellnessPackagePlans.organizationId, q.organizationId));
  return {
    range: { from: q.from, to: q.to, timeZones: [...new Set(tzOf.values())] },
    asOf: new Date().toISOString(),
    source: 'BranchHarbor appointments, payments, packages and vouchers',
    cancellations: perLoc,
    revenue: [...rev.values()],
    revenueDefinition: 'Per currency, never combined. Appointment value = list price of confirmed/completed appointments starting in the range (package sessions counted separately). Deposits, package and voucher sales = succeeded online payments plus in-person sales recorded in BranchHarbor.',
    combinedRevenue: null,
    utilisation: util,
    packageLiability: liab.packages,
    voucherLiability: liab.vouchers,
    liabilityDefinition: liab.definition,
    plansOnSale: plans.filter((p) => p.active).length,
  };
}

// ───────────────────────── client notes ─────────────────────────

export interface NoteViewer { userId: string; readersAt: 'all' | Set<string>; managersAt: 'all' | Set<string>; myClientLocations: Set<string> }
const at = (s: 'all' | Set<string>, id: string) => s === 'all' || s.has(id);

/** Confidential: author + managers (customers.write at the location). Others: readers at the location or the client's practitioner. */
export function noteVisible(n: { authorUserId: string; confidential: boolean; locationId: string }, v: NoteViewer) {
  if (n.authorUserId === v.userId) return true;
  if (n.confidential) return at(v.managersAt, n.locationId);
  return at(v.readersAt, n.locationId) || v.myClientLocations.has(n.locationId);
}

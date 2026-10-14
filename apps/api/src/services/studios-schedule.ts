import { and, asc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import {
  classBookings, classOccurrences, classSeries, classTypes, instructorAvailability, locations, studioRooms, users, waitlistEntries,
  type SeriesRecurrence,
} from '../db/schema/index.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { expandRecurrence, localToUtc, toRRule, validateRecurrence } from '../lib/recurrence.ts';
import { addDays, localDateParts } from '../lib/tz.ts';
import { audit } from './audit.ts';
import { reverseTargetPayment } from './payments.ts';
import { returnCredits } from './studios-entitlements.ts';
import { dispatchCustomerNotifications, enqueueCustomerNotifications } from './studios-notify.ts';

type Occ = typeof classOccurrences.$inferSelect;
type Loc = typeof locations.$inferSelect;
type Series = typeof classSeries.$inferSelect;

export interface SeriesInput {
  locationId: string;
  classTypeId: string;
  recurrence: SeriesRecurrence;
  durationMinutes?: number;
  instructorUserId?: string | null;
  instructorName?: string | null;
  roomId?: string | null;
  capacity?: number;
  priceMinor: number;
  creditCost?: number;
  allowCredits: boolean;
  allowMembership: boolean;
  online: boolean;
}

export interface Conflict { kind: 'room_busy' | 'instructor_busy' | 'instructor_unavailable' | 'room_capacity'; message: string; occurrenceId?: string }

const fmtLocal = (d: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz, hourCycle: 'h23' }).format(d);

// ───────────── Conflicts ─────────────

function minutesOf(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** Room / instructor double bookings and instructor availability for a set of proposed slots. */
export async function findConflicts(db: Exec, organizationId: string, slots: Array<{ startsAt: Date; endsAt: Date }>, opts: { roomId?: string | null; roomCapacity?: number | null; capacity?: number; instructorUserId?: string | null; excludeIds?: string[] }): Promise<Conflict[][]> {
  const result: Conflict[][] = slots.map(() => []);
  if (!slots.length) return result;
  const from = new Date(Math.min(...slots.map((x) => x.startsAt.getTime())));
  const to = new Date(Math.max(...slots.map((x) => x.endsAt.getTime())));
  const exclude = new Set(opts.excludeIds ?? []);
  const others = (opts.roomId || opts.instructorUserId)
    ? await db.select({ id: classOccurrences.id, startsAt: classOccurrences.startsAt, endsAt: classOccurrences.endsAt, roomId: classOccurrences.roomId, instructorUserId: classOccurrences.instructorUserId, name: classTypes.name })
      .from(classOccurrences).innerJoin(classTypes, eq(classTypes.id, classOccurrences.classTypeId))
      .where(and(eq(classOccurrences.organizationId, organizationId), eq(classOccurrences.status, 'scheduled'), lt(classOccurrences.startsAt, to), gt(classOccurrences.endsAt, from)))
    : [];
  const rules = opts.instructorUserId ? await db.select().from(instructorAvailability).where(and(eq(instructorAvailability.organizationId, organizationId), eq(instructorAvailability.userId, opts.instructorUserId))) : [];
  slots.forEach((slot, i) => {
    for (const o of others) {
      if (exclude.has(o.id) || !(o.startsAt < slot.endsAt && o.endsAt > slot.startsAt)) continue;
      if (opts.roomId && o.roomId === opts.roomId) result[i]!.push({ kind: 'room_busy', message: `Room already booked for ${o.name}`, occurrenceId: o.id });
      if (opts.instructorUserId && o.instructorUserId === opts.instructorUserId) result[i]!.push({ kind: 'instructor_busy', message: `Instructor already teaching ${o.name}`, occurrenceId: o.id });
    }
    if (opts.roomCapacity && opts.capacity && opts.capacity > opts.roomCapacity) result[i]!.push({ kind: 'room_capacity', message: `Capacity ${opts.capacity} exceeds the room's ${opts.roomCapacity}` });
    if (rules.length) {
      const blockedBy = (r: typeof rules[number]) => {
        const s = localDateParts(slot.startsAt, r.timeZone);
        const e = localDateParts(slot.endsAt, r.timeZone);
        const applies = r.onDate ? r.onDate === s.date : r.weekday === s.weekday;
        if (!applies) return null;
        const a = minutesOf(s.time);
        const b = e.date === s.date ? minutesOf(e.time) : 24 * 60;
        return { inside: a >= minutesOf(r.startTime) && b <= minutesOf(r.endTime), overlaps: a < minutesOf(r.endTime) && b > minutesOf(r.startTime) };
      };
      const unavailable = rules.filter((r) => r.kind === 'unavailable').some((r) => blockedBy(r)?.overlaps);
      const avail = rules.filter((r) => r.kind === 'available');
      const outside = avail.length > 0 && !avail.some((r) => blockedBy(r)?.inside);
      if (unavailable || outside) result[i]!.push({ kind: 'instructor_unavailable', message: unavailable ? 'Instructor marked unavailable' : 'Outside the instructor’s availability' });
    }
  });
  return result;
}

// ───────────── Series create / preview / publish ─────────────

async function resolveRoom(db: Exec, organizationId: string, locationId: string, roomId: string | null | undefined) {
  if (!roomId) return null;
  const [r] = await db.select().from(studioRooms).where(and(eq(studioRooms.id, roomId), eq(studioRooms.organizationId, organizationId)));
  if (!r || r.locationId !== locationId) throw validationError('Room not found at this location', { roomId: 'Unknown room' });
  return r;
}

async function instructorLabel(db: Exec, userId: string | null | undefined, name: string | null | undefined) {
  if (name) return name;
  if (!userId) return null;
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return u?.name ?? null;
}

export async function previewSeries(db: Exec, organizationId: string, loc: Loc, input: SeriesInput) {
  const errors = validateRecurrence(input.recurrence);
  if (Object.keys(errors).length) throw validationError('Check the repeat settings', Object.fromEntries(Object.entries(errors).map(([k, v]) => [`recurrence.${k}`, v])));
  const [ct] = await db.select().from(classTypes).where(and(eq(classTypes.id, input.classTypeId), eq(classTypes.organizationId, organizationId)));
  if (!ct || (ct.locationId && ct.locationId !== loc.id)) throw notFound('Class type');
  const room = await resolveRoom(db, organizationId, loc.id, input.roomId);
  const duration = input.durationMinutes ?? ct.durationMinutes;
  const capacity = input.capacity ?? Math.min(ct.defaultCapacity, room?.capacity ?? ct.defaultCapacity);
  const occ = expandRecurrence(input.recurrence, loc.timeZone, duration).filter((o) => o.startsAt > new Date());
  const conflicts = await findConflicts(db, organizationId, occ, { roomId: room?.id, roomCapacity: room?.capacity, capacity, instructorUserId: input.instructorUserId ?? null });
  const offsets = new Set(occ.map((o) => o.utcOffsetMinutes));
  return {
    classType: { id: ct.id, name: ct.name },
    timeZone: loc.timeZone,
    rrule: toRRule(input.recurrence, loc.timeZone),
    durationMinutes: duration, capacity, room: room ? { id: room.id, name: room.name, capacity: room.capacity } : null,
    instructorName: await instructorLabel(db, input.instructorUserId, input.instructorName),
    price: { amount: input.priceMinor, currency: loc.currency }, creditCost: input.creditCost ?? ct.creditCost,
    summary: {
      count: occ.length, first: occ[0]?.startsAt.toISOString() ?? null, last: occ.at(-1)?.startsAt.toISOString() ?? null,
      /** The series crosses a daylight-saving change: UTC times shift, local times do not. */
      crossesDst: offsets.size > 1, conflicts: conflicts.filter((c) => c.length).length, dstAdjusted: occ.filter((o) => o.dstAdjusted).length,
    },
    occurrences: occ.map((o, i) => ({ localDate: o.localDate, localTime: o.localTime, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(), utcOffsetMinutes: o.utcOffsetMinutes, dstAdjusted: o.dstAdjusted, conflicts: conflicts[i]! })),
    _ct: ct, _room: room, _expanded: occ, _conflicts: conflicts,
  };
}

export function serializeSeries(sr: Series, extra: { className?: string; locationName?: string; upcoming?: number; bookings?: number } = {}) {
  return {
    id: sr.id, locationId: sr.locationId, classTypeId: sr.classTypeId, status: sr.status, recurrence: sr.recurrence, timeZone: sr.timeZone, rrule: toRRule(sr.recurrence, sr.timeZone),
    durationMinutes: sr.durationMinutes, instructorUserId: sr.instructorUserId, instructorName: sr.instructorName, roomId: sr.roomId, roomName: sr.roomName, capacity: sr.capacity,
    price: { amount: sr.priceMinor, currency: sr.currency }, creditCost: sr.creditCost, allowCredits: sr.allowCredits, allowMembership: sr.allowMembership, online: sr.online,
    splitFromId: sr.splitFromId, publishedAt: sr.publishedAt?.toISOString() ?? null, createdAt: sr.createdAt.toISOString(), updatedAt: sr.updatedAt.toISOString(),
    className: extra.className ?? null, locationName: extra.locationName ?? null, upcoming: extra.upcoming ?? null, bookings: extra.bookings ?? null,
  };
}

/** Insert the occurrences of a published series (idempotent per series slot). */
async function generateOccurrences(tx: Exec, sr: Series, loc: Loc) {
  const expanded = expandRecurrence(sr.recurrence, sr.timeZone, sr.durationMinutes).filter((o) => o.startsAt > new Date());
  if (!expanded.length) return 0;
  const rows = expanded.map((o) => ({
    organizationId: sr.organizationId, locationId: sr.locationId, classTypeId: sr.classTypeId, seriesId: sr.id, seriesSlotAt: o.startsAt, startsAt: o.startsAt, endsAt: o.endsAt,
    capacity: sr.capacity, priceMinor: sr.priceMinor, currency: loc.currency, creditCost: sr.creditCost, instructorUserId: sr.instructorUserId, instructorName: sr.instructorName,
    roomId: sr.roomId, room: sr.roomName, online: sr.online,
  }));
  let n = 0;
  for (let i = 0; i < rows.length; i += 300) n += (await tx.insert(classOccurrences).values(rows.slice(i, i + 300)).onConflictDoNothing().returning({ id: classOccurrences.id })).length;
  return n;
}

export async function createSeries(s: Services, organizationId: string, loc: Loc, input: SeriesInput, opts: { publish: boolean; actorUserId: string; allowConflicts: boolean }) {
  if (input.priceMinor < 0) throw validationError('Price cannot be negative', { priceMinor: 'Invalid' });
  const pv = await previewSeries(s.db, organizationId, loc, input);
  if (!pv.occurrences.length) throw validationError('No future classes match this schedule', { 'recurrence.startDate': 'Adjust the dates' });
  if (opts.publish && !opts.allowConflicts && pv.summary.conflicts > 0) {
    throw new AppError(409, 'schedule_conflicts', `${pv.summary.conflicts} class${pv.summary.conflicts === 1 ? '' : 'es'} clash with the room or instructor schedule`, undefined, { conflicts: pv.occurrences.filter((o) => o.conflicts.length).slice(0, 20) });
  }
  return s.db.transaction(async (tx) => {
    const [sr] = await tx.insert(classSeries).values({
      organizationId, locationId: loc.id, classTypeId: input.classTypeId, status: opts.publish ? 'published' : 'draft', recurrence: input.recurrence, timeZone: loc.timeZone,
      durationMinutes: pv.durationMinutes, instructorUserId: input.instructorUserId ?? null, instructorName: pv.instructorName, roomId: pv.room?.id ?? null, roomName: pv.room?.name ?? null,
      capacity: pv.capacity, priceMinor: input.priceMinor, currency: loc.currency, creditCost: pv.creditCost, allowCredits: input.allowCredits, allowMembership: input.allowMembership,
      online: input.online, createdBy: opts.actorUserId, publishedAt: opts.publish ? new Date() : null,
    }).returning();
    const generated = opts.publish ? await generateOccurrences(tx, sr!, loc) : 0;
    await audit(tx, { organizationId, actorUserId: opts.actorUserId, action: opts.publish ? 'series.published' : 'series.drafted', scopeKind: 'location', scopeId: loc.id, targetType: 'class_series', targetId: sr!.id, metadata: { generated, rrule: pv.rrule } });
    return { series: sr!, generated };
  });
}

export async function publishSeries(s: Services, sr: Series, loc: Loc, opts: { actorUserId: string; allowConflicts: boolean }) {
  if (sr.status !== 'draft') throw conflict('series_not_draft', `Series is already ${sr.status}`);
  const pv = await previewSeries(s.db, sr.organizationId, loc, { ...sr, capacity: sr.capacity, roomId: sr.roomId, instructorUserId: sr.instructorUserId, instructorName: sr.instructorName });
  if (!opts.allowConflicts && pv.summary.conflicts > 0) throw new AppError(409, 'schedule_conflicts', `${pv.summary.conflicts} classes clash with the room or instructor schedule`, undefined, { conflicts: pv.occurrences.filter((o) => o.conflicts.length).slice(0, 20) });
  return s.db.transaction(async (tx) => {
    const [u] = await tx.update(classSeries).set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() }).where(and(eq(classSeries.id, sr.id), eq(classSeries.status, 'draft'))).returning();
    if (!u) throw conflict('series_not_draft', 'Series was published by someone else');
    const generated = await generateOccurrences(tx, u, loc);
    await audit(tx, { organizationId: sr.organizationId, actorUserId: opts.actorUserId, action: 'series.published', scopeKind: 'location', scopeId: loc.id, targetType: 'class_series', targetId: sr.id, metadata: { generated } });
    return { series: u, generated };
  });
}

// ───────────── Editing one / following / series ─────────────

export type EditScope = 'one' | 'following' | 'series';
export interface EditChanges {
  time?: string;
  weekday?: number;
  durationMinutes?: number;
  instructorUserId?: string | null;
  instructorName?: string | null;
  roomId?: string | null;
  capacity?: number;
  priceMinor?: number;
  creditCost?: number;
  online?: boolean;
  cancel?: boolean;
}

interface Target {
  occ: Occ;
  after: { startsAt: Date; endsAt: Date; dstAdjusted: boolean };
  bookings: Array<{ id: string; customerId: string; status: string; paymentMethod: string; packId: string | null; creditsUsed: number; paymentId: string | null }>;
  waitlist: number;
}

async function targetsFor(db: Exec, occ: Occ, scope: EditScope, changes: EditChanges, tz: string): Promise<Target[]> {
  if (scope !== 'one' && !occ.seriesId) throw validationError('This class is not part of a series', { scope: 'Use "this class only"' });
  if (scope === 'one' && changes.weekday !== undefined && changes.weekday !== localDateParts(occ.startsAt, tz).weekday) {
    // Allowed: moving a single class to another day of the same week.
  }
  let rows: Occ[];
  if (scope === 'one') rows = [occ];
  else {
    const conds = [eq(classOccurrences.seriesId, occ.seriesId!), eq(classOccurrences.status, 'scheduled'), gt(classOccurrences.startsAt, new Date())];
    if (scope === 'following') conds.push(gte(classOccurrences.startsAt, occ.startsAt));
    rows = await db.select().from(classOccurrences).where(and(...conds)).orderBy(asc(classOccurrences.startsAt));
    // A weekday change moves only the classes on the edited class's weekday (e.g. the Monday of a Mon/Wed series).
    if (changes.weekday !== undefined) {
      const wd = localDateParts(occ.startsAt, tz).weekday;
      rows = rows.filter((r) => localDateParts(r.startsAt, tz).weekday === wd);
    }
    if (!rows.some((r) => r.id === occ.id) && occ.status === 'scheduled' && occ.startsAt > new Date()) rows.unshift(occ);
  }
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const bks = await db.select({ id: classBookings.id, occurrenceId: classBookings.occurrenceId, customerId: classBookings.customerId, status: classBookings.status, paymentMethod: classBookings.paymentMethod, packId: classBookings.packId, creditsUsed: classBookings.creditsUsed, paymentId: classBookings.paymentId, holdExpiresAt: classBookings.holdExpiresAt })
    .from(classBookings).where(and(inArray(classBookings.occurrenceId, ids), inArray(classBookings.status, ['held', 'confirmed'])));
  const wl = await db.select({ id: waitlistEntries.occurrenceId, n: sql<number>`count(*)::int` }).from(waitlistEntries).where(and(inArray(waitlistEntries.occurrenceId, ids), inArray(waitlistEntries.status, ['waiting', 'offered']))).groupBy(waitlistEntries.occurrenceId);
  return rows.map((o) => {
    let startsAt = o.startsAt;
    let dstAdjusted = false;
    if (changes.time !== undefined || changes.weekday !== undefined) {
      const cur = localDateParts(o.startsAt, tz);
      const date = changes.weekday === undefined ? cur.date : addDays(cur.date, changes.weekday - cur.weekday);
      const r = localToUtc(date, changes.time ?? cur.time, tz);
      startsAt = r.at;
      dstAdjusted = r.dstAdjusted;
    }
    const duration = changes.durationMinutes ?? Math.round((o.endsAt.getTime() - o.startsAt.getTime()) / 60_000);
    return {
      occ: o, after: { startsAt, endsAt: new Date(startsAt.getTime() + duration * 60_000), dstAdjusted },
      bookings: bks.filter((b) => b.occurrenceId === o.id && (b.status === 'confirmed' || (b.holdExpiresAt && b.holdExpiresAt > new Date()))),
      waitlist: wl.find((w) => w.id === o.id)?.n ?? 0,
    };
  });
}

function describeChange(o: Occ, after: Target['after'], changes: EditChanges, tz: string, names: { instructor?: string | null; room?: string | null }): string[] {
  const parts: string[] = [];
  if (after.startsAt.getTime() !== o.startsAt.getTime()) parts.push(`now starts ${fmtLocal(after.startsAt, tz)} (was ${fmtLocal(o.startsAt, tz)})`);
  else if (changes.durationMinutes && after.endsAt.getTime() !== o.endsAt.getTime()) parts.push(`now ${changes.durationMinutes} minutes long`);
  if (changes.instructorUserId !== undefined || changes.instructorName !== undefined) if ((names.instructor ?? null) !== (o.instructorName ?? null)) parts.push(`instructor: ${names.instructor ?? 'to be confirmed'}`);
  if (changes.roomId !== undefined && (names.room ?? null) !== (o.room ?? null)) parts.push(`room: ${names.room ?? 'to be confirmed'}`);
  if (changes.online !== undefined && changes.online !== o.online) parts.push(changes.online ? 'now online' : 'now in the studio');
  return parts;
}

export async function editPreview(db: Exec, occ: Occ, loc: Loc, scope: EditScope, changes: EditChanges) {
  const targets = await targetsFor(db, occ, scope, changes, loc.timeZone);
  const room = changes.roomId ? await resolveRoom(db, occ.organizationId, occ.locationId, changes.roomId) : null;
  const instructor = changes.instructorUserId !== undefined || changes.instructorName !== undefined ? await instructorLabel(db, changes.instructorUserId, changes.instructorName) : undefined;
  const timeChanged = changes.time !== undefined || changes.weekday !== undefined || changes.durationMinutes !== undefined;
  const needsConflictCheck = !changes.cancel && (timeChanged || changes.roomId !== undefined || changes.instructorUserId !== undefined);
  const conflicts = needsConflictCheck
    ? await findConflicts(db, occ.organizationId, targets.map((t) => t.after), {
      roomId: changes.roomId !== undefined ? changes.roomId : targets[0]?.occ.roomId, roomCapacity: room?.capacity ?? null, capacity: changes.capacity,
      instructorUserId: changes.instructorUserId !== undefined ? changes.instructorUserId : targets[0]?.occ.instructorUserId, excludeIds: targets.map((t) => t.occ.id),
    })
    : targets.map(() => []);
  const customers = new Set(targets.flatMap((t) => t.bookings.map((b) => b.customerId)));
  const items = targets.map((t, i) => {
    const booked = t.bookings.length;
    const newCap = changes.capacity ?? t.occ.capacity;
    return {
      occurrenceId: t.occ.id, detached: t.occ.detached,
      before: { startsAt: t.occ.startsAt.toISOString(), endsAt: t.occ.endsAt.toISOString(), instructorName: t.occ.instructorName, room: t.occ.room, capacity: t.occ.capacity, price: { amount: t.occ.priceMinor, currency: t.occ.currency }, online: t.occ.online },
      after: changes.cancel ? null : {
        startsAt: t.after.startsAt.toISOString(), endsAt: t.after.endsAt.toISOString(), dstAdjusted: t.after.dstAdjusted, instructorName: instructor !== undefined ? instructor : t.occ.instructorName,
        room: changes.roomId !== undefined ? room?.name ?? null : t.occ.room, capacity: newCap, price: { amount: changes.priceMinor ?? t.occ.priceMinor, currency: t.occ.currency }, online: changes.online ?? t.occ.online,
      },
      bookings: booked, waitlist: t.waitlist, overCapacity: changes.cancel ? 0 : Math.max(0, booked - newCap), conflicts: conflicts[i]!,
      changes: changes.cancel ? ['cancelled'] : describeChange(t.occ, t.after, changes, loc.timeZone, { instructor: instructor !== undefined ? instructor : t.occ.instructorName, room: changes.roomId !== undefined ? room?.name ?? null : t.occ.room }),
    };
  });
  const warnings: string[] = [];
  if (items.some((i) => i.overCapacity > 0)) warnings.push('Capacity would be below existing bookings for some classes. Existing bookings are kept; new bookings stop until places free up.');
  if (items.some((i) => i.conflicts.length)) warnings.push(`${items.filter((i) => i.conflicts.length).length} class(es) clash with another class's room or instructor, or the instructor's availability.`);
  if (scope !== 'one' && items.some((i) => i.detached && i.occurrenceId !== occ.id)) warnings.push('Some classes were edited individually before; this change overwrites them.');
  if (changes.priceMinor !== undefined) warnings.push('Price changes apply to new bookings only; existing bookings keep what they paid.');
  if (items.some((i) => i.after?.dstAdjusted)) warnings.push('Some new times fall in a daylight-saving gap and were moved to the next valid time.');
  return {
    scope, changes, timeZone: loc.timeZone,
    totals: { occurrences: items.length, bookings: items.reduce((a, i) => a + i.bookings, 0), customers: customers.size, waitlisted: items.reduce((a, i) => a + i.waitlist, 0), conflicts: items.filter((i) => i.conflicts.length).length },
    notify: { customers: customers.size, channels: ['email (unless opted out)', 'SMS (only with SMS consent)', 'app push (if signed in, unless turned off)'] },
    warnings, items,
    _targets: targets, _room: room, _instructor: instructor,
  };
}

export async function applyEdit(s: Services, occ: Occ, loc: Loc, scope: EditScope, changes: EditChanges, opts: { actorUserId: string; notify: boolean; reason?: string; allowConflicts: boolean; allowOverCapacity: boolean }) {
  const pv = await editPreview(s.db, occ, loc, scope, changes);
  if (!pv.items.length) throw conflict('nothing_to_change', 'No upcoming classes in this scope');
  if (!opts.allowConflicts && pv.totals.conflicts > 0) throw new AppError(409, 'schedule_conflicts', `${pv.totals.conflicts} class(es) would clash`, undefined, { items: pv.items.filter((i) => i.conflicts.length).slice(0, 20) });
  if (!opts.allowOverCapacity && pv.items.some((i) => i.overCapacity > 0)) throw new AppError(409, 'capacity_below_bookings', 'Capacity is below existing bookings for some classes', undefined, { items: pv.items.filter((i) => i.overCapacity > 0).map((i) => ({ occurrenceId: i.occurrenceId, bookings: i.bookings })) });
  if (changes.cancel && !opts.reason) throw validationError('Give a reason for the cancellation (customers see it)', { reason: 'Required' });

  const [ct] = await s.db.select({ name: classTypes.name }).from(classTypes).where(eq(classTypes.id, occ.classTypeId));
  const className = ct?.name ?? 'Your class';
  const refunds: Array<{ bookingId: string; paymentId: string }> = [];

  const result = await s.db.transaction(async (tx) => {
    let newSeriesId: string | null = null;
    // "This and following" splits the series so earlier classes keep the old rule.
    if (scope !== 'one' && occ.seriesId) {
      const [sr] = await tx.select().from(classSeries).where(eq(classSeries.id, occ.seriesId)).for('update');
      if (sr) {
        const first = pv._targets[0]!.occ;
        const firstLocal = localDateParts(first.seriesSlotAt ?? first.startsAt, sr.timeZone).date;
        const [earlier] = await tx.select({ n: sql<number>`count(*)::int` }).from(classOccurrences).where(and(eq(classOccurrences.seriesId, sr.id), lt(classOccurrences.startsAt, first.startsAt)));
        const recurrenceAfter = { ...sr.recurrence };
        if (changes.time) recurrenceAfter.time = changes.time;
        if (changes.weekday !== undefined) {
          const wd = localDateParts(occ.startsAt, sr.timeZone).weekday;
          recurrenceAfter.byWeekday = [...new Set(sr.recurrence.byWeekday.map((d) => (d === wd ? changes.weekday! : d)))];
        }
        const seriesFields = {
          ...(changes.durationMinutes ? { durationMinutes: changes.durationMinutes } : {}),
          ...(changes.instructorUserId !== undefined || changes.instructorName !== undefined ? { instructorUserId: changes.instructorUserId ?? null, instructorName: pv._instructor ?? null } : {}),
          ...(changes.roomId !== undefined ? { roomId: changes.roomId, roomName: pv._room?.name ?? null } : {}),
          ...(changes.capacity !== undefined ? { capacity: changes.capacity } : {}),
          ...(changes.priceMinor !== undefined ? { priceMinor: changes.priceMinor } : {}),
          ...(changes.creditCost !== undefined ? { creditCost: changes.creditCost } : {}),
          ...(changes.online !== undefined ? { online: changes.online } : {}),
        };
        if (scope === 'following' && (earlier?.n ?? 0) > 0) {
          const untilOld = addDays(firstLocal, -1);
          await tx.update(classSeries).set({ recurrence: { ...sr.recurrence, untilDate: untilOld, count: null }, status: changes.cancel ? 'ended' : sr.status, updatedAt: new Date() }).where(eq(classSeries.id, sr.id));
          if (!changes.cancel) {
            const lastLocal = localDateParts(pv._targets.at(-1)!.after.startsAt, sr.timeZone).date;
            const [ns] = await tx.insert(classSeries).values({
              ...sr, id: undefined, createdAt: undefined, updatedAt: new Date(), splitFromId: sr.id, createdBy: opts.actorUserId,
              recurrence: { ...recurrenceAfter, startDate: firstLocal, untilDate: sr.recurrence.untilDate && sr.recurrence.untilDate > lastLocal ? sr.recurrence.untilDate : lastLocal, count: null },
              ...seriesFields,
            }).returning();
            newSeriesId = ns!.id;
          }
        } else if (changes.cancel) {
          await tx.update(classSeries).set({ status: 'ended', recurrence: { ...sr.recurrence, untilDate: addDays(firstLocal, -1) < sr.recurrence.startDate ? sr.recurrence.startDate : addDays(firstLocal, -1), count: null }, updatedAt: new Date() }).where(eq(classSeries.id, sr.id));
        } else {
          await tx.update(classSeries).set({ recurrence: recurrenceAfter, ...seriesFields, updatedAt: new Date() }).where(eq(classSeries.id, sr.id));
        }
      }
    }

    let cancelledBookings = 0;
    for (const t of pv._targets) {
      const [cur] = await tx.select().from(classOccurrences).where(eq(classOccurrences.id, t.occ.id)).for('update');
      if (!cur || cur.status !== 'scheduled') continue;
      if (changes.cancel) {
        await tx.update(classOccurrences).set({ status: 'cancelled', cancelReason: opts.reason ?? null, updatedAt: new Date() }).where(eq(classOccurrences.id, cur.id));
        const bks = await tx.update(classBookings).set({ status: 'cancelled', cancelledAt: new Date(), creditReturned: sql`case when ${classBookings.packId} is not null then true else null end` })
          .where(and(eq(classBookings.occurrenceId, cur.id), inArray(classBookings.status, ['held', 'confirmed']))).returning();
        for (const b of bks) {
          if (b.packId && b.creditsUsed) await returnCredits(tx, b.packId, b.creditsUsed);
          if (b.paymentId && b.paymentMethod === 'pay_per_class') refunds.push({ bookingId: b.id, paymentId: b.paymentId });
        }
        cancelledBookings += bks.length;
        await tx.update(waitlistEntries).set({ status: 'removed' }).where(and(eq(waitlistEntries.occurrenceId, cur.id), inArray(waitlistEntries.status, ['waiting', 'offered'])));
      } else {
        await tx.update(classOccurrences).set({
          startsAt: t.after.startsAt, endsAt: t.after.endsAt,
          ...(changes.instructorUserId !== undefined || changes.instructorName !== undefined ? { instructorUserId: changes.instructorUserId ?? null, instructorName: pv._instructor ?? null } : {}),
          ...(changes.roomId !== undefined ? { roomId: changes.roomId, room: pv._room?.name ?? null } : {}),
          ...(changes.capacity !== undefined ? { capacity: changes.capacity } : {}),
          ...(changes.priceMinor !== undefined ? { priceMinor: changes.priceMinor } : {}),
          ...(changes.creditCost !== undefined ? { creditCost: changes.creditCost } : {}),
          ...(changes.online !== undefined ? { online: changes.online } : {}),
          ...(newSeriesId ? { seriesId: newSeriesId } : {}),
          detached: scope === 'one' ? true : false, updatedAt: new Date(),
        }).where(eq(classOccurrences.id, cur.id));
      }
    }

    // Outbox: one message per affected booking, committed with the change.
    let notified = 0;
    if (opts.notify) {
      const item = new Map(pv.items.map((i) => [i.occurrenceId, i]));
      for (const t of pv._targets) {
        const it = item.get(t.occ.id)!;
        if (!t.bookings.length || (!changes.cancel && !it.changes.length)) continue;
        const when = fmtLocal(t.occ.startsAt, loc.timeZone);
        const subject = changes.cancel ? `Cancelled: ${className}, ${when}` : `Changed: ${className}, ${when}`;
        const body = changes.cancel
          ? `${className} on ${when} at ${loc.name} has been cancelled${opts.reason ? ` (${opts.reason})` : ''}. Your booking is cancelled; class pack credits are returned and single-class payments refunded.`
          : `${className} on ${when} at ${loc.name}: ${it.changes.join('; ')}.${opts.reason ? ` ${opts.reason}` : ''} Your booking is kept — cancel from your account if it no longer suits you.`;
        const r = await enqueueCustomerNotifications(tx, { organizationId: occ.organizationId, locationId: occ.locationId, customerIds: t.bookings.map((b) => b.customerId), occurrenceId: t.occ.id, seriesId: t.occ.seriesId, kind: changes.cancel ? 'class_cancelled' : it.changes.some((c) => c.startsWith('instructor')) && it.changes.length === 1 ? 'instructor_changed' : 'class_changed', subject, body });
        notified += r.customers;
      }
    }
    await audit(tx, { organizationId: occ.organizationId, actorUserId: opts.actorUserId, action: changes.cancel ? 'class.cancelled' : 'class.edited', scopeKind: 'location', scopeId: occ.locationId, targetType: scope === 'one' ? 'class_occurrence' : 'class_series', targetId: scope === 'one' ? occ.id : occ.seriesId,
      metadata: { scope, changes, occurrences: pv.items.length, bookings: pv.totals.bookings, cancelledBookings, notified, newSeriesId, reason: opts.reason } });
    return { cancelledBookings, notified, newSeriesId };
  });

  const payments = [];
  for (const r of refunds) payments.push({ bookingId: r.bookingId, ...(await reverseTargetPayment(s, r.paymentId, opts.actorUserId, `Class cancelled: ${opts.reason ?? ''}`)) });
  const delivery = opts.notify ? await dispatchCustomerNotifications(s) : { sent: 0, skipped: 0 };
  return { scope, occurrences: pv.items.length, bookingsAffected: pv.totals.bookings, cancelledBookings: result.cancelledBookings, customersNotified: result.notified, newSeriesId: result.newSeriesId, payments, delivery, items: pv.items };
}

/** Upcoming series counts for listings. */
export async function seriesStats(db: Exec, ids: string[]) {
  if (!ids.length) return new Map<string, { upcoming: number; bookings: number }>();
  const rows = await db.select({ id: classOccurrences.seriesId, n: sql<number>`count(distinct ${classOccurrences.id})::int`, b: sql<number>`count(${classBookings.id}) filter (where ${classBookings.status} in ('confirmed','held'))::int` })
    .from(classOccurrences).leftJoin(classBookings, eq(classBookings.occurrenceId, classOccurrences.id))
    .where(and(inArray(classOccurrences.seriesId, ids), eq(classOccurrences.status, 'scheduled'), gt(classOccurrences.startsAt, new Date()))).groupBy(classOccurrences.seriesId);
  return new Map(rows.map((r) => [r.id!, { upcoming: r.n, bookings: r.b }]));
}


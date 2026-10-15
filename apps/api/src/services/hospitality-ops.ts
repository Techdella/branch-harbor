/**
 * Hospitality operations: room grid, housekeeping board and tasks, guest messages (consent-based), the restaurant
 * outlet add-on (Foods engine, charge-to-room), reports per property and per currency, and the owner pulse.
 */
import { and, asc, desc, eq, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';
import { addDaysIso, hotelKpis, stayNights, taskTransitionAllowed, type HkTaskStatus } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import {
  customers, foodOrders, hospAssignments, hospBeds, hospFolioLines, hospHkTasks, hospMessageLog, hospReservationRooms, hospReservations, hospRoomBlocks, hospRooms, hospRoomTypes,
  locations, users,
} from '../db/schema/index.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { randomToken } from '../lib/crypto.ts';
import { audit } from './audit.ts';
import { computeTotals, effectiveMenu, foodOrderTransitionHooks, priceFoodOrderLines } from './foods.ts';
import { loadFoodConfig } from './foods-menu.ts';
import { consentState } from './wellness-ops.ts';
import { availabilityMatrix, localToday, propertyFor, sellableUnits, STAY_CONSENT, type Location, type Reservation } from './hospitality.ts';
import { requiresRefund } from '../domain/foodOrderState.ts';

// ───────────────────────── grid ─────────────────────────

export async function roomGrid(db: Exec, loc: Location, from: string, nights: number) {
  const dates = Array.from({ length: nights }, (_, i) => addDaysIso(from, i));
  const to = addDaysIso(from, nights);
  const types = await db.select().from(hospRoomTypes).where(and(eq(hospRoomTypes.locationId, loc.id), eq(hospRoomTypes.active, true))).orderBy(asc(hospRoomTypes.sortOrder), asc(hospRoomTypes.name));
  const rooms = await db.select().from(hospRooms).where(and(eq(hospRooms.locationId, loc.id), eq(hospRooms.active, true))).orderBy(asc(hospRooms.sortOrder), asc(hospRooms.number));
  const beds = rooms.length ? await db.select().from(hospBeds).where(and(inArray(hospBeds.roomId, rooms.map((r) => r.id)), eq(hospBeds.active, true))).orderBy(asc(hospBeds.label)) : [];
  const assignments = await db.select({ a: hospAssignments, rr: hospReservationRooms, r: hospReservations }).from(hospAssignments)
    .innerJoin(hospReservationRooms, eq(hospReservationRooms.id, hospAssignments.reservationRoomId)).innerJoin(hospReservations, eq(hospReservations.id, hospReservationRooms.reservationId))
    .where(and(eq(hospAssignments.locationId, loc.id), gte(hospAssignments.date, from), lt(hospAssignments.date, to)));
  const blocks = await db.select().from(hospRoomBlocks).where(and(eq(hospRoomBlocks.locationId, loc.id), eq(hospRoomBlocks.active, true), lt(hospRoomBlocks.startDate, to), sql`${hospRoomBlocks.endDate} > ${from}`));
  // Stays overlapping the window that still need a room.
  const unassigned = await db.select({ rr: hospReservationRooms, r: hospReservations }).from(hospReservationRooms).innerJoin(hospReservations, eq(hospReservations.id, hospReservationRooms.reservationId))
    .where(and(eq(hospReservations.locationId, loc.id), inArray(hospReservations.status, ['hold', 'confirmed', 'checked_in']), lt(hospReservations.arrival, to), sql`${hospReservations.departure} > ${from}`, sql`${hospReservationRooms.roomId} is null`))
    .orderBy(asc(hospReservations.arrival));
  const inventory = await availabilityMatrix(db, types.map((t) => t.id), dates);
  const cell = (x: { a: typeof hospAssignments.$inferSelect; rr: typeof hospReservationRooms.$inferSelect; r: Reservation }) => ({
    date: x.a.date, reservationId: x.r.id, reservationRoomId: x.rr.id, code: x.r.code, guestName: x.r.guestName, status: x.r.status, arrival: x.r.arrival, departure: x.r.departure, bedId: x.a.bedId, groupName: x.r.groupName,
  });
  return {
    locationId: loc.id, from, nights, dates, today: localToday(loc), currency: loc.currency,
    roomTypes: types.map((t) => ({ id: t.id, code: t.code, name: t.name, kind: t.kind, inventory: dates.map((d) => ({ date: d, ...inventory.get(t.id)!.get(d)! })) })),
    rooms: rooms.map((r) => ({
      id: r.id, number: r.number, floor: r.floor, roomTypeId: r.roomTypeId, hkStatus: r.hkStatus,
      beds: beds.filter((b) => b.roomId === r.id).map((b) => ({ id: b.id, label: b.label })),
      cells: assignments.filter((x) => x.a.roomId === r.id).map(cell),
      blocks: blocks.filter((b) => b.roomId === r.id).map((b) => ({ id: b.id, startDate: b.startDate, endDate: b.endDate, reason: b.reason })),
    })),
    unassigned: unassigned.map((x) => ({ reservationId: x.r.id, reservationRoomId: x.rr.id, code: x.r.code, guestName: x.r.guestName, status: x.r.status, arrival: x.r.arrival, departure: x.r.departure, roomTypeId: x.rr.roomTypeId, adults: x.rr.adults, children: x.rr.children })),
  };
}

// ───────────────────────── housekeeping ─────────────────────────

/** Creates the day's departure cleans and stayover services (idempotent). */
export async function generateTasks(db: Exec, loc: Location, date: string) {
  const rows = await db.select({ a: hospAssignments, r: hospReservations }).from(hospAssignments)
    .innerJoin(hospReservationRooms, eq(hospReservationRooms.id, hospAssignments.reservationRoomId)).innerJoin(hospReservations, eq(hospReservations.id, hospReservationRooms.reservationId))
    .where(and(eq(hospAssignments.locationId, loc.id), eq(hospAssignments.date, addDaysIso(date, -1)), inArray(hospReservations.status, ['confirmed', 'checked_in'])));
  const values = new Map<string, typeof hospHkTasks.$inferInsert>();
  for (const x of rows) {
    const kind = x.r.departure === date ? 'departure_clean' : 'stayover';
    values.set(`${x.a.roomId}:${kind}`, { organizationId: loc.organizationId, locationId: loc.id, roomId: x.a.roomId, date, kind, reservationId: x.r.id, priority: kind === 'departure_clean' ? 1 : 0 });
  }
  if (values.size) await db.insert(hospHkTasks).values([...values.values()]).onConflictDoNothing();
  return values.size;
}

export async function housekeepingBoard(db: Exec, loc: Location, date: string) {
  const rooms = await db.select({ room: hospRooms, type: hospRoomTypes }).from(hospRooms).innerJoin(hospRoomTypes, eq(hospRoomTypes.id, hospRooms.roomTypeId))
    .where(and(eq(hospRooms.locationId, loc.id), eq(hospRooms.active, true))).orderBy(asc(hospRooms.sortOrder), asc(hospRooms.number));
  const tasks = await db.select({ t: hospHkTasks, assignee: { id: users.id, name: users.name } }).from(hospHkTasks).leftJoin(users, eq(users.id, hospHkTasks.assigneeUserId))
    .where(and(eq(hospHkTasks.locationId, loc.id), eq(hospHkTasks.date, date))).orderBy(desc(hospHkTasks.priority), asc(hospHkTasks.createdAt));
  const tonight = await db.select({ roomId: hospAssignments.roomId }).from(hospAssignments).where(and(eq(hospAssignments.locationId, loc.id), eq(hospAssignments.date, date)));
  const lastNight = await db.select({ roomId: hospAssignments.roomId }).from(hospAssignments).where(and(eq(hospAssignments.locationId, loc.id), eq(hospAssignments.date, addDaysIso(date, -1))));
  const occ = new Set(tonight.map((x) => x.roomId));
  const prev = new Set(lastNight.map((x) => x.roomId));
  const numberOf = new Map(rooms.map((r) => [r.room.id, r.room.number]));
  return {
    locationId: loc.id, date,
    rooms: rooms.map(({ room, type }) => ({
      id: room.id, number: room.number, floor: room.floor, roomType: type.name, hkStatus: room.hkStatus,
      occupancy: prev.has(room.id) && occ.has(room.id) ? 'stayover' : prev.has(room.id) ? 'departure' : occ.has(room.id) ? 'arrival' : 'vacant',
    })),
    tasks: tasks.map(({ t, assignee }) => serializeTask(t, numberOf.get(t.roomId) ?? '', assignee?.id ? assignee : null)),
    counts: {
      dirty: rooms.filter((r) => r.room.hkStatus === 'dirty').length, clean: rooms.filter((r) => r.room.hkStatus === 'clean').length,
      inspected: rooms.filter((r) => r.room.hkStatus === 'inspected').length, outOfOrder: rooms.filter((r) => r.room.hkStatus === 'out_of_order').length,
      todo: tasks.filter((x) => x.t.status === 'todo').length, inProgress: tasks.filter((x) => x.t.status === 'in_progress').length, done: tasks.filter((x) => x.t.status === 'done').length,
    },
  };
}

export function serializeTask(t: typeof hospHkTasks.$inferSelect, roomNumber: string, assignee: { id: string; name: string } | null) {
  return { id: t.id, locationId: t.locationId, roomId: t.roomId, roomNumber, date: t.date, kind: t.kind, status: t.status, priority: t.priority, assignee, reservationId: t.reservationId, notes: t.notes, completedAt: t.completedAt?.toISOString() ?? null };
}

/** Task status / assignment. Finishing a clean makes a dirty room clean; finishing an inspection makes a clean room inspected. */
export async function updateTask(s: Services, orgId: string, taskId: string, input: { status?: HkTaskStatus; assigneeUserId?: string | null; notes?: string | null }, actorUserId: string, allowed: (locationId: string) => boolean) {
  return s.db.transaction(async (tx) => {
    const [t] = await tx.select().from(hospHkTasks).where(and(eq(hospHkTasks.id, taskId), eq(hospHkTasks.organizationId, orgId))).for('update');
    if (!t || !allowed(t.locationId)) throw notFound('Task');
    const patch: Partial<typeof hospHkTasks.$inferInsert> = { updatedAt: new Date() };
    if (input.status && input.status !== t.status) {
      if (!taskTransitionAllowed(t.status as HkTaskStatus, input.status)) throw conflict('invalid_transition', `A ${t.status.replace('_', ' ')} task cannot become ${input.status.replace('_', ' ')}`);
      patch.status = input.status;
      if (input.status === 'done') {
        patch.completedAt = new Date();
        patch.completedBy = actorUserId;
        const [room] = await tx.select().from(hospRooms).where(eq(hospRooms.id, t.roomId)).for('update');
        if (room && ['departure_clean', 'stayover', 'turndown'].includes(t.kind) && room.hkStatus === 'dirty') await tx.update(hospRooms).set({ hkStatus: 'clean', updatedAt: new Date() }).where(eq(hospRooms.id, room.id));
        if (room && t.kind === 'inspection' && room.hkStatus === 'clean') await tx.update(hospRooms).set({ hkStatus: 'inspected', updatedAt: new Date() }).where(eq(hospRooms.id, room.id));
      }
    }
    if (input.assigneeUserId !== undefined) patch.assigneeUserId = input.assigneeUserId;
    if (input.notes !== undefined) patch.notes = input.notes;
    const [u] = await tx.update(hospHkTasks).set(patch).where(eq(hospHkTasks.id, t.id)).returning();
    await audit(tx, { organizationId: orgId, actorUserId, action: 'hospitality.task.updated', scopeKind: 'location', scopeId: t.locationId, targetType: 'hosp_hk_task', targetId: t.id, metadata: { ...input } });
    return u!;
  });
}

// ───────────────────────── guest messages ─────────────────────────

/** Pre-arrival (N days before) and check-in information (arrival day), only with the guest's consent; logged once. */
export async function runGuestMessages(s: Services, now = new Date()) {
  const ids = await s.db.selectDistinct({ id: hospReservations.locationId }).from(hospReservations).where(eq(hospReservations.status, 'confirmed'));
  const locs = ids.length ? await s.db.select().from(locations).where(inArray(locations.id, ids.map((x) => x.id))) : [];
  const results: Array<{ reservationId: string; kind: string; channel: string; status: string }> = [];
  for (const loc of locs) {
    const prop = await propertyFor(s.db, loc);
    const today = localToday(loc, now);
    const targets = [{ kind: 'pre_arrival', date: addDaysIso(today, prop.preArrivalDays) }, { kind: 'checkin_info', date: today }];
    for (const tgt of targets) {
      const rows = await s.db.select().from(hospReservations).where(and(eq(hospReservations.locationId, loc.id), eq(hospReservations.status, 'confirmed'), eq(hospReservations.arrival, tgt.date)));
      for (const r of rows) {
        for (const channel of ['email', 'sms'] as const) {
          const to = channel === 'email' ? r.guestEmail : r.guestPhone;
          if (!to || !r.customerId) continue;
          const granted = (await consentState(s.db, r.customerId, STAY_CONSENT[channel])) === true && r.messageConsent[channel];
          const status = granted ? 'sending' : 'skipped_no_consent';
          const [row] = await s.db.insert(hospMessageLog).values({ organizationId: r.organizationId, locationId: loc.id, reservationId: r.id, kind: tgt.kind, channel, status, dedupeKey: `${r.id}:${tgt.kind}:${channel}` }).onConflictDoNothing().returning();
          if (!row) continue;
          let final = status;
          if (granted) {
            const subject = tgt.kind === 'pre_arrival' ? `Your stay at ${loc.name} on ${r.arrival}` : `Check-in information — ${loc.name}`;
            const text = tgt.kind === 'pre_arrival'
              ? `Hello ${r.guestName}, we look forward to welcoming you on ${r.arrival} (booking ${r.code}). Check-in from ${prop.checkInTime}.${prop.registrationFields.length ? ' You can add your registration details in advance from your booking link.' : ''}`
              : `Hello ${r.guestName}, check-in at ${loc.name} is from ${prop.checkInTime} today (booking ${r.code}).${prop.arrivalInstructions ? ` ${prop.arrivalInstructions}` : ''}`;
            try {
              const sent = channel === 'email' ? await s.mailer.send({ to, subject, text, tag: `hospitality_${tgt.kind}` }) : await s.messaging.sendSms(to, text);
              final = sent.delivered ? 'sent' : 'logged';
            } catch (err) {
              s.log.warn({ err }, 'guest message failed');
              final = 'failed';
            }
            await s.db.update(hospMessageLog).set({ status: final }).where(eq(hospMessageLog.id, row.id));
          }
          results.push({ reservationId: r.id, kind: tgt.kind, channel, status: final });
        }
      }
    }
  }
  return results;
}

// ───────────────────────── outlet (Foods engine) ─────────────────────────

export async function outletMenu(s: Services, loc: Location, lang?: string | null) {
  const prop = await propertyFor(s.db, loc);
  if (!prop.outletEnabled) throw conflict('outlet_disabled', 'This property has no restaurant outlet enabled');
  return { name: prop.outletName ?? `${loc.name} restaurant`, currency: loc.currency, items: await effectiveMenu(s.db, loc.organizationId, loc, { at: new Date(), lang }) };
}

export async function inHouseGuests(db: Exec, loc: Location) {
  const rows = await db.select({ r: hospReservations, rr: hospReservationRooms, room: hospRooms }).from(hospReservations)
    .innerJoin(hospReservationRooms, eq(hospReservationRooms.reservationId, hospReservations.id)).leftJoin(hospRooms, eq(hospRooms.id, hospReservationRooms.roomId))
    .where(and(eq(hospReservations.locationId, loc.id), eq(hospReservations.status, 'checked_in'))).orderBy(asc(hospRooms.number));
  return rows.map((x) => ({ reservationId: x.r.id, code: x.r.code, guestName: x.r.guestName, roomNumber: x.room?.number ?? null, departure: x.r.departure }));
}

/** Outlet staff charge an order to an in-house reservation: the food order (on the room's tab) and the folio line are created together. */
export async function chargeToRoom(s: Services, loc: Location, input: { reservationId: string; lines: Array<{ menuItemId: string; quantity: number; modifierIds: string[]; notes?: string }>; notes?: string | null }, actorUserId: string | null) {
  const prop = await propertyFor(s.db, loc);
  if (!prop.outletEnabled) throw conflict('outlet_disabled', 'This property has no restaurant outlet enabled');
  const priced = await priceFoodOrderLines(s.db, loc.organizationId, loc, input.lines.map((l) => ({ ...l, modifierIds: l.modifierIds ?? [] })), { at: new Date() });
  const cfg = await loadFoodConfig(s.db, loc.id);
  const totals = computeTotals({ subtotal: priced.subtotal, taxRateBps: priced.taxRateBps, cfg, channel: 'dine_in', deliveryFeeMinor: 0, tipMinor: 0 });
  return s.db.transaction(async (tx) => {
    const [r] = await tx.select().from(hospReservations).where(and(eq(hospReservations.id, input.reservationId), eq(hospReservations.locationId, loc.id))).for('update');
    if (!r) throw notFound('Reservation');
    if (r.status !== 'checked_in') throw conflict('not_in_house', 'Only guests who are checked in can charge to their room');
    const [rr] = await tx.select({ number: hospRooms.number }).from(hospReservationRooms).leftJoin(hospRooms, eq(hospRooms.id, hospReservationRooms.roomId)).where(eq(hospReservationRooms.reservationId, r.id)).limit(1);
    const roomNumber = rr?.number ?? null;
    const [o] = await tx.insert(foodOrders).values({
      organizationId: loc.organizationId, locationId: loc.id, customerId: r.customerId, orderNumber: `${loc.code}-R${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 4)}`,
      status: 'awaiting_acceptance', paymentStatus: 'on_tab', channel: 'dine_in',
      fulfilment: { tableLabel: roomNumber ? `Room ${roomNumber}` : `Booking ${r.code}`, roomCharge: { reservationId: r.id, reservationCode: r.code, roomNumber }, ...(totals.serviceChargeLabel ? { serviceChargeLabel: totals.serviceChargeLabel } : {}) },
      lines: priced.lines, subtotalMinor: totals.subtotal, taxMinor: totals.tax, serviceChargeMinor: totals.serviceCharge, deliveryFeeMinor: 0, tipMinor: 0, totalMinor: totals.total, currency: loc.currency,
      contact: { name: r.guestName }, notes: input.notes ?? null, statusHistory: [{ at: new Date().toISOString(), from: null, to: 'awaiting_acceptance', by: actorUserId, note: 'Charged to room' }],
    }).returning();
    const [line] = await tx.insert(hospFolioLines).values({
      organizationId: r.organizationId, locationId: r.locationId, reservationId: r.id, kind: 'outlet', description: `${prop.outletName ?? 'Restaurant'} — order ${o!.orderNumber}`,
      serviceDate: localToday(loc), amountMinor: totals.total, currency: r.currency, sourceType: 'food_order', sourceId: o!.id, createdBy: actorUserId,
    }).returning();
    await audit(tx, { organizationId: r.organizationId, actorUserId, action: 'hospitality.outlet.charged_to_room', scopeKind: 'location', scopeId: r.locationId, targetType: 'food_order', targetId: o!.id, metadata: { reservationId: r.id, totalMinor: totals.total, currency: r.currency } });
    return { order: o!, folioLine: line! };
  });
}

// Rejected or cancelled outlet orders come off the folio (reversal line, append-only).
foodOrderTransitionHooks.push(async (tx: Tx, order, _from, to) => {
  const rc = order.fulfilment.roomCharge;
  if (!rc || !requiresRefund(to)) return;
  const [orig] = await tx.select().from(hospFolioLines).where(and(eq(hospFolioLines.kind, 'outlet'), eq(hospFolioLines.sourceType, 'food_order'), eq(hospFolioLines.sourceId, order.id)));
  if (!orig) return;
  await tx.insert(hospFolioLines).values({
    organizationId: orig.organizationId, locationId: orig.locationId, reservationId: orig.reservationId, kind: 'adjustment', description: `Order ${order.orderNumber} ${to} — charge reversed`,
    serviceDate: orig.serviceDate, amountMinor: -orig.amountMinor, currency: orig.currency, sourceType: 'food_order_reversal', sourceId: order.id, reversesId: orig.id,
  }).onConflictDoNothing();
});

// ───────────────────────── reports ─────────────────────────

type Kpis = ReturnType<typeof hotelKpis>;
interface PropertyFigures { roomNightsAvailable: number; roomNightsSold: number; roomRevenueMinor: number; bedNightsAvailable: number; bedNightsSold: number; bedRevenueMinor: number }

async function figuresFor(db: Exec, loc: Location, dates: string[]): Promise<PropertyFigures> {
  const types = await db.select().from(hospRoomTypes).where(and(eq(hospRoomTypes.locationId, loc.id), eq(hospRoomTypes.active, true)));
  const units = await sellableUnits(db, types.map((t) => t.id), dates);
  const out: PropertyFigures = { roomNightsAvailable: 0, roomNightsSold: 0, roomRevenueMinor: 0, bedNightsAvailable: 0, bedNightsSold: 0, bedRevenueMinor: 0 };
  const dorm = new Set(types.filter((t) => t.kind === 'dorm').map((t) => t.id));
  for (const t of types) for (const d of dates) {
    const n = units.get(t.id)?.get(d) ?? 0;
    if (dorm.has(t.id)) out.bedNightsAvailable += n; else out.roomNightsAvailable += n;
  }
  if (!dates.length) return out;
  const rows = await db.select({ rr: hospReservationRooms }).from(hospReservationRooms).innerJoin(hospReservations, eq(hospReservations.id, hospReservationRooms.reservationId))
    .where(and(eq(hospReservations.locationId, loc.id), inArray(hospReservations.status, ['confirmed', 'checked_in', 'checked_out']), lte(hospReservations.arrival, dates[dates.length - 1]!), sql`${hospReservations.departure} > ${dates[0]!}`));
  const inRange = new Set(dates);
  for (const { rr } of rows) for (const n of rr.nights) {
    if (!inRange.has(n.date)) continue;
    if (dorm.has(rr.roomTypeId)) { out.bedNightsSold += 1; out.bedRevenueMinor += n.amountMinor; } else { out.roomNightsSold += 1; out.roomRevenueMinor += n.amountMinor; }
  }
  return out;
}

const kpiView = (f: { roomNightsAvailable: number; roomNightsSold: number; roomRevenueMinor: number }, currency: string) => {
  const k: Kpis = hotelKpis(f);
  const m = (v: number | null) => (v === null ? null : { amount: v, currency });
  return { roomNightsAvailable: f.roomNightsAvailable, roomNightsSold: f.roomNightsSold, roomRevenue: { amount: f.roomRevenueMinor, currency }, occupancy: k.occupancy, adr: m(k.adrMinor), revpar: m(k.revparMinor) };
};

/** Occupancy, ADR, RevPAR per property and per currency (never combined), plus pickup and cancellations, for stay nights [from, to). */
export async function hospitalityReport(db: Exec, locs: Location[], from: string, to: string, pickupDays = 14) {
  const dates = stayNights(from, to);
  if (!dates.length || dates.length > 366) throw validationError('Choose a period of 1 to 366 nights', { to: 'Invalid period' });
  const properties = [];
  const byCurrency = new Map<string, PropertyFigures>();
  for (const loc of locs) {
    const f = await figuresFor(db, loc, dates);
    properties.push({
      locationId: loc.id, name: loc.name, currency: loc.currency, ...kpiView(f, loc.currency),
      beds: f.bedNightsAvailable ? { bedNightsAvailable: f.bedNightsAvailable, bedNightsSold: f.bedNightsSold, bedRevenue: { amount: f.bedRevenueMinor, currency: loc.currency }, occupancy: hotelKpis({ roomNightsAvailable: f.bedNightsAvailable, roomNightsSold: f.bedNightsSold, roomRevenueMinor: f.bedRevenueMinor }).occupancy } : null,
    });
    const acc = byCurrency.get(loc.currency) ?? { roomNightsAvailable: 0, roomNightsSold: 0, roomRevenueMinor: 0, bedNightsAvailable: 0, bedNightsSold: 0, bedRevenueMinor: 0 };
    for (const k of Object.keys(acc) as Array<keyof PropertyFigures>) acc[k] += f[k];
    byCurrency.set(loc.currency, acc);
  }
  const locIds = locs.map((l) => l.id);
  const currencyOf = new Map(locs.map((l) => [l.id, l.currency]));
  const tzOf = new Map(locs.map((l) => [l.id, l]));
  // Pickup: bookings made in the last N days for stays in the window (room nights and room revenue per booking day).
  const since = new Date(Date.now() - pickupDays * 86_400_000);
  const booked = locIds.length ? await db.select({ r: hospReservations, rr: hospReservationRooms }).from(hospReservations).innerJoin(hospReservationRooms, eq(hospReservationRooms.reservationId, hospReservations.id))
    .where(and(inArray(hospReservations.locationId, locIds), gte(hospReservations.createdAt, since), ne(hospReservations.status, 'expired'), ne(hospReservations.status, 'hold'), lt(hospReservations.arrival, to), sql`${hospReservations.departure} > ${from}`)) : [];
  const pickup = new Map<string, { date: string; currency: string; roomNights: number; revenueMinor: number; bookings: Set<string> }>();
  for (const { r, rr } of booked) {
    const day = localToday(tzOf.get(r.locationId)!, r.createdAt);
    const key = `${day}|${r.currency}`;
    const p = pickup.get(key) ?? { date: day, currency: r.currency, roomNights: 0, revenueMinor: 0, bookings: new Set<string>() };
    for (const n of rr.nights) if (n.date >= from && n.date < to) { p.roomNights += 1; p.revenueMinor += n.amountMinor; }
    p.bookings.add(r.id);
    pickup.set(key, p);
  }
  // Cancellations and no-shows for stays in the window.
  const lost = locIds.length ? await db.select({ r: hospReservations, rr: hospReservationRooms }).from(hospReservations).innerJoin(hospReservationRooms, eq(hospReservationRooms.reservationId, hospReservations.id))
    .where(and(inArray(hospReservations.locationId, locIds), inArray(hospReservations.status, ['cancelled', 'no_show']), lt(hospReservations.arrival, to), sql`${hospReservations.departure} > ${from}`)) : [];
  const canc = new Map<string, { currency: string; cancelled: Set<string>; noShows: Set<string>; roomNightsLost: number; revenueLostMinor: number; feesMinor: number; feeSeen: Set<string> }>();
  for (const { r, rr } of lost) {
    const c = canc.get(r.currency) ?? { currency: r.currency, cancelled: new Set<string>(), noShows: new Set<string>(), roomNightsLost: 0, revenueLostMinor: 0, feesMinor: 0, feeSeen: new Set<string>() };
    (r.status === 'no_show' ? c.noShows : c.cancelled).add(r.id);
    for (const n of rr.nights) if (n.date >= from && n.date < to) { c.roomNightsLost += 1; c.revenueLostMinor += n.amountMinor; }
    if (!c.feeSeen.has(r.id)) { c.feeSeen.add(r.id); c.feesMinor += r.cancellationFeeMinor ?? 0; }
    canc.set(r.currency, c);
  }
  void currencyOf;
  return {
    from, to, nights: dates.length,
    definitions: {
      occupancy: 'Room nights sold ÷ room nights available (out-of-order rooms excluded); dorm beds reported separately',
      adr: 'Room revenue (excluding taxes) ÷ room nights sold', revpar: 'Room revenue (excluding taxes) ÷ room nights available',
      pickup: `Bookings made in the last ${pickupDays} days for nights in the period`, source: 'BranchHarbor reservations (confirmed, in-house, departed)',
    },
    properties,
    byCurrency: [...byCurrency.entries()].map(([currency, f]) => ({ currency, ...kpiView(f, currency) })),
    combinedRevenue: null,
    pickup: [...pickup.values()].sort((a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency)).map((p) => ({ date: p.date, currency: p.currency, bookings: p.bookings.size, roomNights: p.roomNights, revenue: { amount: p.revenueMinor, currency: p.currency } })),
    cancellations: [...canc.values()].map((c) => ({ currency: c.currency, cancelled: c.cancelled.size, noShows: c.noShows.size, roomNightsLost: c.roomNightsLost, revenueLost: { amount: c.revenueLostMinor, currency: c.currency }, feesRetained: { amount: c.feesMinor, currency: c.currency } })),
    generatedAt: new Date().toISOString(),
  };
}

/** Today at each property: occupancy tonight, arrivals, departures, in-house, rooms to clean. */
export async function pulse(db: Exec, locs: Location[]) {
  const out = [];
  for (const loc of locs) {
    const today = localToday(loc);
    const f = await figuresFor(db, loc, [today]);
    const res = await db.select({ status: hospReservations.status, arrival: hospReservations.arrival, departure: hospReservations.departure }).from(hospReservations)
      .where(and(eq(hospReservations.locationId, loc.id), inArray(hospReservations.status, ['confirmed', 'checked_in', 'checked_out']), lte(hospReservations.arrival, today), gte(hospReservations.departure, today)));
    const rooms = await db.select({ s: hospRooms.hkStatus }).from(hospRooms).where(and(eq(hospRooms.locationId, loc.id), eq(hospRooms.active, true)));
    const tasks = await db.select({ status: hospHkTasks.status }).from(hospHkTasks).where(and(eq(hospHkTasks.locationId, loc.id), eq(hospHkTasks.date, today)));
    out.push({
      locationId: loc.id, name: loc.name, currency: loc.currency, date: today, ...kpiView(f, loc.currency),
      arrivals: res.filter((r) => r.arrival === today && r.status !== 'checked_out').length, arrivalsCheckedIn: res.filter((r) => r.arrival === today && r.status === 'checked_in').length,
      departures: res.filter((r) => r.departure === today).length, departuresCheckedOut: res.filter((r) => r.departure === today && r.status === 'checked_out').length,
      inHouse: res.filter((r) => r.status === 'checked_in').length,
      dirtyRooms: rooms.filter((r) => r.s === 'dirty').length, outOfOrder: rooms.filter((r) => r.s === 'out_of_order').length, openTasks: tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').length,
    });
  }
  return out;
}

export async function guestReservations(db: Exec, userId: string, email: string) {
  const own = await db.select({ id: customers.id }).from(customers).where(eq(customers.userId, userId));
  const rows = await db.select({ r: hospReservations, loc: locations }).from(hospReservations).innerJoin(locations, eq(locations.id, hospReservations.locationId))
    .where(own.length ? sql`(${inArray(hospReservations.customerId, own.map((c) => c.id))} or lower(${hospReservations.guestEmail}) = ${email.toLowerCase()})` : sql`lower(${hospReservations.guestEmail}) = ${email.toLowerCase()}`)
    .orderBy(desc(hospReservations.arrival)).limit(50);
  return rows;
}

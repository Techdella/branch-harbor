/**
 * Kitchen display (KDS): stations (grill, cold, bar…) per location, items routed to stations by their
 * station key, one ticket per order and station with a prep-time target, bump/recall acknowledged by the
 * server, and an expo view that shows when every station is done. Order status changes still go through
 * transitionFoodOrder (server-acknowledged, never optimistic).
 */
import { and, asc, eq, gte, inArray, or } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import { foodKdsTickets, foodOrders, foodStations, locations, menuItems } from '../db/schema/index.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { loadFoodConfig } from './foods-menu.ts';
import { transitionFoodOrder } from './foods.ts';

type OrderRow = typeof foodOrders.$inferSelect;
type Station = typeof foodStations.$inferSelect;
type Ticket = typeof foodKdsTickets.$inferSelect;

/** Kitchen-visible payment states (unpaid online orders stay hidden until payment confirms). */
export const KITCHEN_PAYMENT_STATES = ['paid', 'not_required', 'on_tab', 'refund_pending', 'refunded', 'voided'];

export const DEFAULT_STATIONS = [
  { key: 'grill', name: 'Grill', prepTargetMinutes: 14, sortOrder: 1, isExpo: false },
  { key: 'cold', name: 'Cold', prepTargetMinutes: 8, sortOrder: 2, isExpo: false },
  { key: 'bar', name: 'Bar', prepTargetMinutes: 4, sortOrder: 3, isExpo: false },
  { key: 'expo', name: 'Expo / pass', prepTargetMinutes: 2, sortOrder: 9, isExpo: true },
];

/** Which station makes a line: its station key at this location, else the first (non-expo) station. */
export function routeLines(lines: OrderRow['lines'], stations: Station[]) {
  const cooking = stations.filter((st) => st.active && !st.isExpo).sort((a, b) => a.sortOrder - b.sortOrder);
  const out = new Map<string, Array<{ index: number; line: OrderRow['lines'][number] }>>();
  if (!cooking.length) return out;
  lines.forEach((line, index) => {
    const st = cooking.find((x) => x.key === line.stationKey) ?? cooking[0]!;
    out.set(st.id, [...(out.get(st.id) ?? []), { index, line }]);
  });
  return out;
}

/** Create tickets when an order is accepted (idempotent). */
export async function createKdsTickets(db: Exec, order: OrderRow) {
  const stations = await db.select().from(foodStations).where(and(eq(foodStations.locationId, order.locationId), eq(foodStations.active, true)));
  const routed = routeLines(order.lines, stations);
  if (!routed.size) return [];
  const itemIds = [...new Set(order.lines.map((l) => l.menuItemId))];
  const prep = new Map((await db.select({ id: menuItems.id, prep: menuItems.prepMinutes }).from(menuItems).where(inArray(menuItems.id, itemIds))).map((r) => [r.id, r.prep]));
  const cfg = await loadFoodConfig(db, order.locationId);
  const now = Date.now();
  const values = [...routed.entries()].map(([stationId, entries]) => {
    const st = stations.find((x) => x.id === stationId)!;
    const minutes = Math.max(st.prepTargetMinutes || cfg.kds.defaultPrepMinutes, ...entries.map((e) => prep.get(e.line.menuItemId) ?? 0));
    const earliest = now + minutes * 60_000;
    const promised = order.promisedAt?.getTime() ?? 0;
    return {
      organizationId: order.organizationId, locationId: order.locationId, orderId: order.id, stationId,
      lines: entries.map((e) => ({ index: e.index, name: e.line.name, quantity: e.line.quantity, modifiers: e.line.modifiers.map((m) => m.name), notes: e.line.notes })),
      targetAt: new Date(promised > earliest ? promised : earliest),
    };
  });
  return db.insert(foodKdsTickets).values(values).onConflictDoNothing().returning();
}

export async function cancelKdsTickets(tx: Tx, orderId: string) {
  await tx.delete(foodKdsTickets).where(eq(foodKdsTickets.orderId, orderId));
}

/** Orders accepted before stations existed (or before an upgrade) get their tickets on first view. */
async function ensureTickets(db: Exec, locationId: string, orders: OrderRow[]) {
  const accepted = orders.filter((o) => o.status === 'accepted' || o.status === 'preparing');
  if (!accepted.length) return;
  const have = new Set((await db.select({ orderId: foodKdsTickets.orderId }).from(foodKdsTickets).where(inArray(foodKdsTickets.orderId, accepted.map((o) => o.id)))).map((r) => r.orderId));
  for (const o of accepted) if (!have.has(o.id)) await createKdsTickets(db, o);
}

function minutesBetween(a: number, b: number) {
  return Math.floor((a - b) / 60_000);
}

/** KDS feed for a location: one station's tickets, or the expo view of every order with station progress. */
export async function kdsFeed(db: Exec, organizationId: string, locationId: string, stationId?: string | null) {
  const [loc] = await db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!loc) throw notFound('Location');
  const stations = (await db.select().from(foodStations).where(eq(foodStations.locationId, locationId))).filter((x) => x.active).sort((a, b) => a.sortOrder - b.sortOrder);
  const station = stationId ? stations.find((x) => x.id === stationId) : undefined;
  if (stationId && !station) throw notFound('Station');
  const cfg = await loadFoodConfig(db, locationId);
  const orders = await db.select().from(foodOrders).where(and(
    eq(foodOrders.locationId, locationId), inArray(foodOrders.paymentStatus, KITCHEN_PAYMENT_STATES),
    or(inArray(foodOrders.status, ['awaiting_acceptance', 'accepted', 'preparing', 'ready']), and(inArray(foodOrders.status, ['collected', 'served', 'out_for_delivery', 'delivered']), gte(foodOrders.updatedAt, new Date(Date.now() - 15 * 60_000)))),
  )).orderBy(asc(foodOrders.promisedAt), asc(foodOrders.createdAt)).limit(300);
  await ensureTickets(db, locationId, orders);
  const tickets = orders.length ? await db.select().from(foodKdsTickets).where(inArray(foodKdsTickets.orderId, orders.map((o) => o.id))) : [];
  const now = Date.now();
  const byOrder = new Map(orders.map((o) => [o.id, o]));
  const stationName = new Map(stations.map((x) => [x.id, x.name]));
  const view = (t: Ticket) => {
    const o = byOrder.get(t.orderId)!;
    const overdueMinutes = t.status !== 'done' ? minutesBetween(now, t.targetAt.getTime()) : 0;
    return {
      id: t.id, orderId: o.id, orderNumber: o.orderNumber, firstName: o.contact.name.split(' ')[0] ?? '', channel: o.channel, tableLabel: o.fulfilment.tableLabel ?? null,
      stationId: t.stationId, stationName: stationName.get(t.stationId) ?? '', status: t.status, orderStatus: o.status, lines: t.lines, orderNotes: o.notes,
      promisedAt: o.promisedAt?.toISOString() ?? null, targetAt: t.targetAt.toISOString(), createdAt: t.createdAt.toISOString(),
      startedAt: t.startedAt?.toISOString() ?? null, bumpedAt: t.bumpedAt?.toISOString() ?? null, ageMinutes: minutesBetween(now, t.createdAt.getTime()),
      overdue: overdueMinutes > 0, overdueMinutes: Math.max(0, overdueMinutes), recalledCount: t.recalledCount,
    };
  };
  const base = {
    location: { id: loc.id, name: loc.name, timeZone: loc.timeZone }, refreshedAt: new Date().toISOString(), audibleDefault: cfg.kds.audibleDefault,
    stations: stations.map((x) => ({ id: x.id, key: x.key, name: x.name, prepTargetMinutes: x.prepTargetMinutes, isExpo: x.isExpo, open: tickets.filter((t) => t.stationId === x.id && t.status !== 'done').length })),
  };
  if (station && !station.isExpo) {
    const recentCut = now - 15 * 60_000;
    const mine = tickets.filter((t) => t.stationId === station.id && ['accepted', 'preparing', 'ready'].includes(byOrder.get(t.orderId)!.status) && (t.status !== 'done' || (t.bumpedAt?.getTime() ?? 0) > recentCut));
    return { ...base, view: 'station' as const, station: { id: station.id, name: station.name, key: station.key }, tickets: mine.sort((a, b) => a.targetAt.getTime() - b.targetAt.getTime()).map(view), orders: [] };
  }
  return {
    ...base, view: 'expo' as const, station: station ? { id: station.id, name: station.name, key: station.key } : null, tickets: [],
    orders: orders.filter((o) => ['awaiting_acceptance', 'accepted', 'preparing', 'ready'].includes(o.status)).map((o) => {
      const ts = tickets.filter((t) => t.orderId === o.id);
      const overdueMinutes = o.promisedAt && ['accepted', 'preparing'].includes(o.status) ? minutesBetween(now, o.promisedAt.getTime()) : 0;
      return {
        id: o.id, orderNumber: o.orderNumber, firstName: o.contact.name.split(' ')[0] ?? '', channel: o.channel, tableLabel: o.fulfilment.tableLabel ?? null, status: o.status,
        promisedAt: o.promisedAt?.toISOString() ?? null, createdAt: o.createdAt.toISOString(), notes: o.notes,
        lines: o.lines.map((l) => ({ name: l.name, quantity: l.quantity, modifiers: l.modifiers.map((m) => m.name), notes: l.notes })),
        stations: ts.map((t) => ({ ticketId: t.id, stationId: t.stationId, name: stationName.get(t.stationId) ?? '', status: t.status })),
        allStationsDone: ts.length > 0 && ts.every((t) => t.status === 'done'), overdue: overdueMinutes > 0, overdueMinutes: Math.max(0, overdueMinutes),
      };
    }),
  };
}

async function loadTicket(db: Exec, organizationId: string, ticketId: string) {
  const [t] = await db.select().from(foodKdsTickets).where(and(eq(foodKdsTickets.id, ticketId), eq(foodKdsTickets.organizationId, organizationId)));
  if (!t) throw notFound('Ticket');
  return t;
}

/**
 * Start / bump / recall a station ticket. `expectedStatus` guards against two screens acting on stale data.
 * Starting or bumping the first ticket moves an accepted order to "preparing" (server-acknowledged).
 */
export async function actOnTicket(s: Services, organizationId: string, ticketId: string, action: 'start' | 'bump' | 'recall', opts: { expectedStatus?: string; actorUserId: string | null }) {
  const t0 = await loadTicket(s.db, organizationId, ticketId);
  const result = await s.db.transaction(async (tx) => {
    const [t] = await tx.select().from(foodKdsTickets).where(eq(foodKdsTickets.id, ticketId)).for('update');
    const [o] = await tx.select().from(foodOrders).where(eq(foodOrders.id, t!.orderId));
    if (opts.expectedStatus && opts.expectedStatus !== t!.status) throw new AppError(409, 'stale_status', `Ticket is now ${t!.status.replace('_', ' ')}. Refresh and try again.`, undefined, { currentStatus: t!.status });
    const now = new Date();
    let patch: Partial<Ticket>;
    if (action === 'start') {
      if (t!.status !== 'queued') throw new AppError(409, 'invalid_transition', 'Only queued tickets can be started');
      patch = { status: 'in_progress', startedAt: now };
    } else if (action === 'bump') {
      if (t!.status === 'done') throw new AppError(409, 'invalid_transition', 'Ticket already bumped');
      patch = { status: 'done', bumpedAt: now, startedAt: t!.startedAt ?? now };
    } else {
      if (t!.status !== 'done') throw new AppError(409, 'invalid_transition', 'Only bumped tickets can be recalled');
      if (!['accepted', 'preparing'].includes(o!.status)) throw new AppError(409, 'order_already_ready', `Order is ${o!.status.replace(/_/g, ' ')}; it can no longer be recalled to a station`);
      patch = { status: 'in_progress', bumpedAt: null, recalledCount: t!.recalledCount + 1 };
    }
    const [u] = await tx.update(foodKdsTickets).set({ ...patch, updatedAt: now }).where(eq(foodKdsTickets.id, ticketId)).returning();
    await audit(tx, { organizationId, actorUserId: opts.actorUserId, action: `kds.${action}`, scopeKind: 'location', scopeId: t!.locationId, targetType: 'food_order', targetId: t!.orderId, metadata: { ticketId, stationId: t!.stationId } });
    return { ticket: u!, order: o! };
  });
  let orderStatus = result.order.status;
  if (action !== 'recall' && orderStatus === 'accepted') {
    const r = await transitionFoodOrder(s, t0.orderId, 'preparing', { organizationId, actorUserId: opts.actorUserId, expectedFrom: 'accepted', note: 'Kitchen started' });
    orderStatus = r.order.status;
  }
  const all = await s.db.select({ status: foodKdsTickets.status }).from(foodKdsTickets).where(eq(foodKdsTickets.orderId, t0.orderId));
  return { ticket: { id: result.ticket.id, status: result.ticket.status, bumpedAt: result.ticket.bumpedAt?.toISOString() ?? null }, orderStatus, allStationsDone: all.length > 0 && all.every((x) => x.status === 'done') };
}

/** Seed default stations for a location (idempotent). */
export async function ensureDefaultStations(db: Exec, organizationId: string, locationId: string) {
  await db.insert(foodStations).values(DEFAULT_STATIONS.map((d) => ({ ...d, organizationId, locationId }))).onConflictDoNothing();
  return db.select().from(foodStations).where(eq(foodStations.locationId, locationId));
}



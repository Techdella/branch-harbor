/**
 * Foods reports: orders by channel, prep times, sold-out frequency, revenue per currency (never summed
 * across currencies) and the catering pipeline. Each section states its definition and source; sections
 * without a data source say so instead of showing zero.
 */
import { and, eq, gte, inArray, lt, or, isNull, gt } from 'drizzle-orm';
import type { Exec } from '../db/client.ts';
import {
  foodCateringEnquiries, foodKdsTickets, foodMealPlanSubscriptions, foodOrders, foodSoldOutEvents, foodStations, locations, menuItems, modifiers,
} from '../db/schema/index.ts';

const REVENUE_EXCLUDED = ['cancelled', 'rejected'];
const PAID = ['paid', 'not_required', 'on_tab'];

function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}
function pct(xs: number[], p: number) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export async function foodsReport(db: Exec, organizationId: string, locationIds: string[], from: Date, to: Date) {
  const generatedAt = new Date().toISOString();
  const source = { name: 'BranchHarbor orders', freshness: generatedAt };
  if (!locationIds.length) return { range: { from: from.toISOString(), to: to.toISOString() }, generatedAt, empty: true, ordersByChannel: [], revenueByCurrency: [], prepTimes: null, soldOut: [], catering: null, mealPlans: [] };
  const locs = await db.select({ id: locations.id, name: locations.name, currency: locations.currency }).from(locations).where(inArray(locations.id, locationIds));
  const orders = await db.select().from(foodOrders).where(and(eq(foodOrders.organizationId, organizationId), inArray(foodOrders.locationId, locationIds), gte(foodOrders.createdAt, from), lt(foodOrders.createdAt, to)));
  const counted = orders.filter((o) => !REVENUE_EXCLUDED.includes(o.status) && PAID.includes(o.paymentStatus));

  // Orders by channel (counts across currencies are fine; money stays per currency).
  const channels = new Map<string, { orders: number; cancelled: number; revenue: Map<string, number> }>();
  for (const o of orders) {
    const c = channels.get(o.channel) ?? { orders: 0, cancelled: 0, revenue: new Map() };
    if (REVENUE_EXCLUDED.includes(o.status)) c.cancelled++;
    else if (PAID.includes(o.paymentStatus)) {
      c.orders++;
      c.revenue.set(o.currency, (c.revenue.get(o.currency) ?? 0) + o.totalMinor);
    }
    channels.set(o.channel, c);
  }
  const ordersByChannel = [...channels.entries()].map(([channel, c]) => ({ channel, orders: c.orders, cancelledOrRejected: c.cancelled, revenue: [...c.revenue.entries()].map(([currency, amount]) => ({ amount, currency })) }));

  // Revenue per currency (gross order totals incl. tax/fees/tips, refunded orders excluded).
  const cur = new Map<string, { gross: number; tax: number; tips: number; deliveryFees: number; serviceCharges: number; orders: number }>();
  for (const o of counted) {
    const r = cur.get(o.currency) ?? { gross: 0, tax: 0, tips: 0, deliveryFees: 0, serviceCharges: 0, orders: 0 };
    r.gross += o.totalMinor; r.tax += o.taxMinor; r.tips += o.tipMinor; r.deliveryFees += o.deliveryFeeMinor; r.serviceCharges += o.serviceChargeMinor; r.orders++;
    cur.set(o.currency, r);
  }
  const revenueByCurrency = [...cur.entries()].map(([currency, r]) => ({
    currency, orders: r.orders, gross: { amount: r.gross, currency }, tax: { amount: r.tax, currency }, tips: { amount: r.tips, currency },
    deliveryFees: { amount: r.deliveryFees, currency }, serviceCharges: { amount: r.serviceCharges, currency }, averageOrder: { amount: Math.round(r.gross / r.orders), currency },
  }));

  // Prep times: accepted → ready from the server-acknowledged status history.
  const perLoc = new Map<string, { mins: number[]; onTime: number; late: number }>();
  for (const o of orders) {
    const acc = o.statusHistory.find((h) => h.to === 'accepted');
    const ready = o.statusHistory.find((h) => h.to === 'ready');
    if (!acc || !ready) continue;
    const mins = Math.max(0, Math.round((Date.parse(ready.at) - Date.parse(acc.at)) / 60_000));
    const r = perLoc.get(o.locationId) ?? { mins: [], onTime: 0, late: 0 };
    r.mins.push(mins);
    if (o.promisedAt) (Date.parse(ready.at) <= o.promisedAt.getTime() ? r.onTime++ : r.late++);
    perLoc.set(o.locationId, r);
  }
  const tickets = orders.length ? await db.select().from(foodKdsTickets).where(and(inArray(foodKdsTickets.orderId, orders.map((o) => o.id)))) : [];
  const stations = tickets.length ? await db.select().from(foodStations).where(inArray(foodStations.id, [...new Set(tickets.map((t) => t.stationId))])) : [];
  const perStation = stations.map((st) => {
    const done = tickets.filter((t) => t.stationId === st.id && t.bumpedAt);
    const mins = done.map((t) => Math.round((t.bumpedAt!.getTime() - (t.startedAt ?? t.createdAt).getTime()) / 60_000));
    return { stationId: st.id, locationId: st.locationId, name: st.name, targetMinutes: st.prepTargetMinutes, tickets: done.length, medianMinutes: median(mins), overTarget: done.filter((t) => t.bumpedAt! > t.targetAt).length };
  }).filter((x) => x.tickets > 0);
  const prepTimes = {
    definition: 'Minutes from acceptance to ready (server-acknowledged status changes); on time = ready before the promised time. Station times run from start (or ticket creation) to bump.',
    locations: locs.map((l) => {
      const r = perLoc.get(l.id);
      return { locationId: l.id, name: l.name, orders: r?.mins.length ?? 0, medianMinutes: r ? median(r.mins) : null, p90Minutes: r ? pct(r.mins, 90) : null, onTimeRate: r && r.onTime + r.late ? Math.round((r.onTime / (r.onTime + r.late)) * 100) / 100 : null };
    }),
    stations: perStation.length ? perStation : null,
    stationsUnavailableReason: perStation.length ? null : 'No KDS station tickets were bumped in this period',
  };

  // Sold-out frequency.
  const events = await db.select().from(foodSoldOutEvents).where(and(inArray(foodSoldOutEvents.locationId, locationIds), lt(foodSoldOutEvents.startedAt, to), or(isNull(foodSoldOutEvents.endedAt), gt(foodSoldOutEvents.endedAt, from))));
  const itemIds = [...new Set(events.map((e) => e.menuItemId).filter((x): x is string => !!x))];
  const modIds = [...new Set(events.map((e) => e.modifierId).filter((x): x is string => !!x))];
  const itemNames = new Map((itemIds.length ? await db.select({ id: menuItems.id, name: menuItems.name }).from(menuItems).where(inArray(menuItems.id, itemIds)) : []).map((r) => [r.id, r.name]));
  const modNames = new Map((modIds.length ? await db.select({ id: modifiers.id, name: modifiers.name }).from(modifiers).where(inArray(modifiers.id, modIds)) : []).map((r) => [r.id, r.name]));
  const so = new Map<string, { name: string; kind: string; times: number; minutes: number; sources: Set<string>; locations: Set<string> }>();
  for (const e of events) {
    const key = e.modifierId ?? e.menuItemId ?? 'unknown';
    const r = so.get(key) ?? { name: e.modifierId ? modNames.get(e.modifierId) ?? 'Option' : itemNames.get(e.menuItemId ?? '') ?? 'Item', kind: e.modifierId ? 'modifier' : 'item', times: 0, minutes: 0, sources: new Set(), locations: new Set() };
    r.times++;
    const end = Math.min((e.endedAt ?? new Date()).getTime(), to.getTime());
    r.minutes += Math.max(0, Math.round((end - Math.max(e.startedAt.getTime(), from.getTime())) / 60_000));
    r.sources.add(e.source);
    r.locations.add(e.locationId);
    so.set(key, r);
  }
  const soldOut = [...so.entries()].map(([id, r]) => ({ id, name: r.name, kind: r.kind, times: r.times, minutesSoldOut: r.minutes, sources: [...r.sources], locations: r.locations.size })).sort((a, b) => b.times - a.times);

  // Catering pipeline: enquiries created in the period, by status, quoted value per currency.
  const enq = await db.select().from(foodCateringEnquiries).where(and(eq(foodCateringEnquiries.organizationId, organizationId), inArray(foodCateringEnquiries.locationId, locationIds), gte(foodCateringEnquiries.createdAt, from), lt(foodCateringEnquiries.createdAt, to)));
  const stages = ['new', 'quoted', 'accepted', 'deposit_paid', 'confirmed', 'completed', 'declined', 'cancelled', 'expired'];
  const catering = {
    definition: 'Catering enquiries created in the period by current status; value = latest quote total per currency.',
    stages: stages.map((st) => {
      const rows = enq.filter((e) => (e.status === 'quoted' && e.quote && new Date(e.quote.validUntil) < new Date() ? 'expired' : e.status) === st);
      const val = new Map<string, number>();
      for (const e of rows) if (e.quote) val.set(e.currency, (val.get(e.currency) ?? 0) + e.quote.totalMinor);
      return { status: st, count: rows.length, value: [...val.entries()].map(([currency, amount]) => ({ amount, currency })) };
    }),
    conversionRate: enq.length ? Math.round((enq.filter((e) => ['deposit_paid', 'confirmed', 'completed'].includes(e.status)).length / enq.length) * 100) / 100 : null,
  };

  // Meal plans: active subscriptions and weekly recurring revenue per currency.
  const subs = await db.select().from(foodMealPlanSubscriptions).where(and(eq(foodMealPlanSubscriptions.organizationId, organizationId), inArray(foodMealPlanSubscriptions.locationId, locationIds)));
  const mp = new Map<string, { active: number; weekly: number; paused: number; cancelled: number }>();
  for (const s of subs) {
    const r = mp.get(s.currency) ?? { active: 0, weekly: 0, paused: 0, cancelled: 0 };
    if (s.status === 'active') { r.active++; r.weekly += s.priceMinor; }
    if (s.status === 'paused') r.paused++;
    if (s.status === 'cancelled') r.cancelled++;
    mp.set(s.currency, r);
  }
  const mealPlans = [...mp.entries()].map(([currency, r]) => ({ currency, active: r.active, paused: r.paused, cancelled: r.cancelled, weeklyRecurring: { amount: r.weekly, currency } }));

  return {
    range: { from: from.toISOString(), to: to.toISOString() }, generatedAt, source, empty: orders.length === 0,
    combinedRevenue: null, combinedRevenueReason: 'Amounts in different currencies are never added together; no conversion method is defined.',
    ordersByChannel, revenueByCurrency, prepTimes, soldOut, catering, mealPlans,
  };
}

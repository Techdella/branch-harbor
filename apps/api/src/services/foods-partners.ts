/**
 * Foods partner integrations:
 *  - Uber Direct: checkout quote (fee passed through or absorbed per location), courier booking with idempotency
 *    (external_id = our delivery id), cancellation, signed status webhooks mapped to delivery + order states, and the
 *    courier tracking link on customer pages. Country availability is checked first; elsewhere own drivers deliver.
 *  - Deliverect: POS injection of accepted BranchHarbor orders, marketplace orders inbound (HMAC-verified,
 *    idempotent per channel order id), status updates both ways, menu snapshot push with sold-out snoozes and busy mode.
 * Every call is sandboxed (logged, nothing transmitted) unless the location's connection is complete and live.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { minorUnitExponent, type Currency } from '@bh/shared';
import type { Services } from '../context.ts';
import { connections, externalMappings, foodDeliveries, foodOrders, locations, menuItems, modifiers, partnerWebhookEvents, type FoodLocationConfig, type FoodOrderFulfilment, type FoodOrderLine } from '../db/schema/index.ts';
import type { FoodOrderState } from '../domain/foodOrderState.ts';
import { AppError, conflict } from '../lib/errors.ts';
import { deliveryProvider } from '../integrations/foods-delivery.ts';
import {
  buildChannelOrder, buildMenuSnapshot, createDeliverectClient, DELIVERECT_SIGNATURE_HEADER, deliverectWebhookKind, OUR_TO_DELIVERECT_STATUS, parseInboundOrder, pluToId,
  verifyDeliverectSignature, type DeliverectConfig, type MenuSnapshotItem,
} from '../integrations/partners/deliverect.ts';
import { createUberDirectClient, parseUberWebhook, UBER_STATUS_MAP, uberAvailableIn, verifyUberSignature, type OurDeliveryStatus } from '../integrations/partners/uber-direct.ts';
import { audit } from './audit.ts';
import { loadFoodConfig } from './foods-menu.ts';
import { callsAllowed, errInfo, logSync, partnerConnection, partnerCredentials } from './partner-connections.ts';

type Location = typeof locations.$inferSelect;
type Connection = typeof connections.$inferSelect;
type OrderRow = typeof foodOrders.$inferSelect;
type DeliveryRow = typeof foodDeliveries.$inferSelect;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const expOf = (c: string) => minorUnitExponent(c as Currency);
const addr = (a: Record<string, unknown>, country: string) => ({ line1: String(a.line1 ?? ''), line2: (a.line2 as string) ?? null, city: String(a.city ?? ''), region: (a.region as string) ?? null, postalCode: (a.postalCode as string) ?? null, country: String(a.country ?? country) });

// ───────────────────────── Uber Direct ─────────────────────────

export async function uberFor(s: Services, loc: Location) {
  const conn = await partnerConnection(s, 'uber_direct', loc.id);
  const creds = conn ? partnerCredentials(s, conn) : {};
  const enabled = !!conn && conn.config.enabled !== false;
  const live = enabled && callsAllowed(conn, creds);
  const client = live ? createUberDirectClient({ creds: { clientId: creds.clientId!, clientSecret: creds.clientSecret!, customerId: String(conn!.config.customerId) }, fetch: s.partnerFetch, authUrl: s.cfg.UBER_DIRECT_AUTH_URL, apiUrl: s.cfg.UBER_DIRECT_API_URL }) : null;
  return { conn, creds, enabled, live, client, available: uberAvailableIn(loc.country, s.cfg.UBER_DIRECT_COUNTRIES), feeMode: (conn?.config.feeMode === 'pass_through' ? 'pass_through' : 'absorb') as 'absorb' | 'pass_through' };
}

/** Pickup ready time from the kitchen's prep time: never before now + prep, aimed so the food arrives by the slot. */
export function pickupReadyAt(now: Date, prepMinutes: number, deliverBy: Date | null, travelMinutes = 20) {
  const earliest = now.getTime() + prepMinutes * 60_000;
  const target = deliverBy ? deliverBy.getTime() - travelMinutes * 60_000 : earliest;
  return new Date(Math.max(earliest, target));
}

export interface ProviderQuote { provider: 'uber_direct'; quoteId: string | null; feeMinor: number; currency: string; expiresAt: string | null; feeMode: 'absorb' | 'pass_through'; sandbox: boolean }

/**
 * Checkout: when the location delivers with Uber Direct, get a quote and decide the customer fee. Returns null when the
 * location doesn't use a partner (zone fee applies). Falls back to own drivers with an honest notice when Uber Direct is
 * unavailable in the country or the quote fails.
 */
export async function providerDeliveryQuote(s: Services, loc: Location, cfg: FoodLocationConfig, input: { address: Record<string, unknown> & { lat?: number; lng?: number }; deliverBy: Date | null; dropoffDeadline: Date | null; subtotalMinor: number; zoneFeeMinor: number; contactPhone?: string | null }) {
  if (cfg.delivery.provider !== 'uber_direct') return null;
  const u = await uberFor(s, loc);
  if (!u.conn || !u.enabled) return null;
  if (!u.available) return { customerFeeMinor: input.zoneFeeMinor, quote: null, notice: `Uber Direct isn’t available in ${loc.country}; your order will be delivered by our own drivers.` };
  const readyAt = pickupReadyAt(new Date(), cfg.kds.defaultPrepMinutes, input.deliverBy);
  let quote: ProviderQuote;
  if (u.client) {
    try {
      const q = await u.client.quote({
        pickup: { address: addr(loc.address as Record<string, unknown>, loc.country), phone: loc.phone ?? null, lat: loc.geo?.lat, lng: loc.geo?.lng },
        dropoff: { address: addr(input.address, loc.country), phone: input.contactPhone ?? null, lat: input.address.lat, lng: input.address.lng },
        pickupReadyAt: readyAt, dropoffDeadlineAt: input.dropoffDeadline, valueMinor: input.subtotalMinor, externalStoreId: (u.conn.config.externalStoreId as string) || undefined,
      });
      quote = { provider: 'uber_direct', quoteId: q.id, feeMinor: q.feeMinor, currency: q.currency || loc.currency, expiresAt: q.expiresAt, feeMode: u.feeMode, sandbox: false };
      await logSync(s, { organizationId: loc.organizationId, connectionId: u.conn.id, provider: 'uber_direct', locationId: loc.id, action: 'quote', status: 'ok', detail: { quoteId: q.id, feeMinor: q.feeMinor, currency: quote.currency } });
    } catch (err) {
      await logSync(s, { organizationId: loc.organizationId, connectionId: u.conn.id, provider: 'uber_direct', locationId: loc.id, action: 'quote', status: 'error', ...errInfo(err) });
      return { customerFeeMinor: input.zoneFeeMinor, quote: null, notice: 'A courier quote isn’t available for this address right now; your order will be delivered by our own drivers.' };
    }
  } else {
    const q = await deliveryProvider('uber_direct').quote({ currency: loc.currency });
    quote = { provider: 'uber_direct', quoteId: null, feeMinor: q.feeMinor, currency: q.currency, expiresAt: null, feeMode: u.feeMode, sandbox: true };
  }
  // Fees in another currency are never shown or charged; the zone fee applies instead.
  const pass = u.feeMode === 'pass_through' && quote.currency === loc.currency;
  return { customerFeeMinor: pass ? quote.feeMinor : input.zoneFeeMinor, quote, notice: null as string | null };
}

const RANK: Record<string, number> = { pending: 0, assigned: 1, picked_up: 2, delivered: 3 };

/** Book a courier for a delivery row (called by dispatch). Idempotent via external_id = delivery id (+ attempt). */
export async function createProviderDelivery(s: Services, o: OrderRow, loc: Location, provider: 'uber_direct' | 'deliverect', deliveryId: string, attempt: number) {
  if (provider === 'deliverect') {
    const r = await deliveryProvider('deliverect').createDelivery({ reference: o.orderNumber, pickup: { name: loc.name, address: loc.address as Record<string, unknown>, phone: loc.phone ?? null }, dropoff: { name: o.contact.name, phone: o.contact.phone ?? null, address: (o.fulfilment.address ?? {}) as Record<string, unknown> }, readyAt: o.promisedAt ?? new Date(), valueMinor: o.totalMinor, currency: o.currency });
    return r;
  }
  const u = await uberFor(s, loc);
  if (!u.available) throw conflict('provider_unavailable_in_country', `Uber Direct isn’t available in ${loc.country}. Assign one of your own drivers instead.`);
  if (u.conn && !u.enabled) throw conflict('provider_disabled', 'Uber Direct is switched off for this location. Assign one of your own drivers or switch it on in Integrations.');
  const externalId = attempt > 1 ? `${deliveryId}-${attempt}` : deliveryId;
  if (!u.client) {
    const r = await deliveryProvider('uber_direct').createDelivery({ reference: o.orderNumber, pickup: { name: loc.name, address: {}, phone: null }, dropoff: { name: '', phone: null, address: {} }, readyAt: new Date(), valueMinor: o.totalMinor, currency: o.currency });
    if (u.conn) await logSync(s, { organizationId: o.organizationId, connectionId: u.conn.id, provider: 'uber_direct', locationId: loc.id, action: 'create_delivery', targetType: 'food_order', targetId: o.id, status: 'sandbox', message: 'Sandbox courier booked (nothing sent to Uber)' });
    return r;
  }
  const cfg = await loadFoodConfig(s.db, loc.id);
  const q = o.fulfilment.providerQuote;
  const quoteValid = q?.quoteId && q.expiresAt && new Date(q.expiresAt).getTime() > Date.now() + 30_000;
  const a = (o.fulfilment.address ?? {}) as Record<string, unknown> & { lat?: number; lng?: number; instructions?: string };
  try {
    const d = await u.client.createDelivery({
      quoteId: quoteValid ? q!.quoteId : null, externalId, pickupName: loc.name, dropoffName: o.contact.name,
      pickup: { address: addr(loc.address as Record<string, unknown>, loc.country), phone: loc.phone ?? null, lat: loc.geo?.lat, lng: loc.geo?.lng },
      dropoff: { address: addr(a, loc.country), phone: o.contact.phone ?? null, lat: a.lat, lng: a.lng },
      pickupReadyAt: pickupReadyAt(new Date(), o.status === 'ready' ? 0 : cfg.kds.defaultPrepMinutes, o.promisedAt), valueMinor: o.subtotalMinor,
      items: o.lines.map((l) => ({ name: l.name, quantity: l.quantity, priceMinor: l.unitPriceMinor })), notes: a.instructions ?? null,
      externalStoreId: (u.conn!.config.externalStoreId as string) || undefined,
    });
    await logSync(s, { organizationId: o.organizationId, connectionId: u.conn!.id, provider: 'uber_direct', locationId: loc.id, action: 'create_delivery', targetType: 'food_order', targetId: o.id, status: 'ok', detail: { deliveryId: d.id, externalId, status: d.status, liveMode: d.liveMode } });
    return { externalId: d.id, trackingUrl: d.trackingUrl, feeMinor: d.currency && d.currency !== o.currency ? null : d.feeMinor, sandbox: false };
  } catch (err) {
    await logSync(s, { organizationId: o.organizationId, connectionId: u.conn!.id, provider: 'uber_direct', locationId: loc.id, action: 'create_delivery', targetType: 'food_order', targetId: o.id, status: 'error', ...errInfo(err) });
    throw new AppError(502, 'provider_error', `Uber Direct could not book a courier: ${(err as Error).message}. Assign one of your own drivers or try again.`);
  }
}

async function advanceOrderFor(s: Services, o: OrderRow, target: 'out_for_delivery' | 'delivered', note: string) {
  const { transitionFoodOrder } = await import('./foods.ts');
  const path: FoodOrderState[] = ['accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered'];
  let cur = o.status as FoodOrderState;
  if (!path.includes(cur)) return cur; // awaiting acceptance, cancelled …: never moved by a courier event
  const goal = path.indexOf(target);
  while (path.indexOf(cur) < goal) {
    const next = path[path.indexOf(cur) + 1]!;
    await transitionFoodOrder(s, o.id, next, { organizationId: o.organizationId, actorUserId: null, expectedFrom: cur, note });
    cur = next;
  }
  return cur;
}

/** Apply a provider-reported delivery status (monotonic; late or repeated events are ignored). */
export async function applyProviderDeliveryStatus(s: Services, d: DeliveryRow, to: OurDeliveryStatus, opts: { note: string; trackingUrl?: string | null }) {
  if (['delivered', 'cancelled', 'failed'].includes(d.status)) return { applied: false, reason: `delivery already ${d.status}` };
  if (to in RANK && RANK[to]! <= (RANK[d.status] ?? -1) && !(opts.trackingUrl && opts.trackingUrl !== d.trackingUrl)) return { applied: false, reason: 'not newer' };
  const [o] = await s.db.select().from(foodOrders).where(eq(foodOrders.id, d.orderId));
  if (o && (to === 'picked_up' || to === 'delivered')) await advanceOrderFor(s, o, to === 'picked_up' ? 'out_for_delivery' : 'delivered', opts.note);
  const status = to in RANK && RANK[to]! < (RANK[d.status] ?? -1) ? d.status : to;
  const [u] = await s.db.update(foodDeliveries).set({
    status, trackingUrl: opts.trackingUrl ?? d.trackingUrl, events: [...d.events, { at: new Date().toISOString(), status, by: null, note: opts.note }], updatedAt: new Date(),
  }).where(eq(foodDeliveries.id, d.id)).returning();
  await audit(s.db, { organizationId: d.organizationId, actorUserId: null, actorType: 'system', action: `food_delivery.${status}`, scopeKind: 'location', scopeId: d.locationId, targetType: 'food_order', targetId: d.orderId, metadata: { provider: d.provider, note: opts.note } });
  return { applied: true, delivery: u! };
}

/** POST /v1/webhooks/uber-direct — signature first, then idempotent processing. */
export async function handleUberWebhook(s: Services, raw: Buffer, headers: Record<string, unknown>) {
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw new AppError(400, 'invalid_payload', 'Body is not JSON'); }
  const ev = parseUberWebhook(body);
  // Find the connection: by Uber customer id, else via the delivery's location.
  const uberConns = await s.db.select().from(connections).where(eq(connections.provider, 'uber_direct'));
  let [d] = ev.deliveryId ? await s.db.select().from(foodDeliveries).where(and(eq(foodDeliveries.provider, 'uber_direct'), eq(foodDeliveries.externalId, ev.deliveryId))) : [];
  const conn = uberConns.find((c) => ev.customerId && c.config.customerId === ev.customerId) ?? (d ? uberConns.find((c) => c.locationId === d!.locationId) : undefined);
  const secrets = [conn ? partnerCredentials(s, conn).webhookSigningKey : undefined, s.cfg.UBER_DIRECT_WEBHOOK_SIGNING_KEY].filter((x): x is string => !!x);
  if (!secrets.length || !secrets.some((k) => verifyUberSignature(raw, headers, k))) throw new AppError(401, 'invalid_signature', 'Uber Direct webhook signature verification failed');
  const eventKey = ev.id || `${ev.deliveryId}:${ev.status}:${String(body.created ?? '')}`;
  const [fresh] = await s.db.insert(partnerWebhookEvents).values({ provider: 'uber_direct', eventKey, organizationId: d?.organizationId ?? conn?.organizationId ?? null, connectionId: conn?.id ?? null, kind: ev.kind || 'unknown', payload: body }).onConflictDoNothing().returning();
  if (!fresh) return { received: true, duplicate: true };
  const finish = async (outcome: string, detail: string) => { await s.db.update(partnerWebhookEvents).set({ outcome, detail }).where(eq(partnerWebhookEvents.id, fresh.id)); return { received: true, outcome, detail }; };
  if (!d && ev.externalId) [d] = await s.db.select().from(foodDeliveries).where(eq(foodDeliveries.id, ev.externalId.slice(0, 36)));
  if (!d) return finish('ignored', 'Unknown delivery');
  if (ev.kind === 'event.courier_update') {
    if (ev.trackingUrl && ev.trackingUrl !== d.trackingUrl) await s.db.update(foodDeliveries).set({ trackingUrl: ev.trackingUrl, updatedAt: new Date() }).where(eq(foodDeliveries.id, d.id));
    return finish('processed', 'Courier update');
  }
  if (!ev.status || !(ev.status in UBER_STATUS_MAP)) return finish('ignored', `Unhandled status ${String(ev.status)}`);
  const to = UBER_STATUS_MAP[ev.status];
  const note = `Uber Direct: ${ev.status.replace('_', ' ')}${ev.courierName ? ` (courier ${ev.courierName.split(' ')[0]})` : ''}`;
  const r = await applyProviderDeliveryStatus(s, d, to, { note, trackingUrl: ev.trackingUrl });
  return finish(r.applied ? 'processed' : 'ignored', r.applied ? `Delivery ${to}` : r.reason!);
}

/** Cancel the courier when the order is cancelled (live Uber deliveries only). */
async function cancelCourierFor(s: Services, o: OrderRow) {
  const [d] = await s.db.select().from(foodDeliveries).where(eq(foodDeliveries.orderId, o.id));
  if (!d || d.provider !== 'uber_direct' || d.sandbox || !d.externalId || d.events.some((e) => e.note === 'Courier cancelled with Uber Direct')) return;
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, o.locationId));
  const u = await uberFor(s, loc!);
  if (!u.client) return;
  try {
    await u.client.cancel(d.externalId);
    await s.db.update(foodDeliveries).set({ status: 'cancelled', events: [...d.events, { at: new Date().toISOString(), status: 'cancelled', by: null, note: 'Courier cancelled with Uber Direct' }], updatedAt: new Date() }).where(eq(foodDeliveries.id, d.id));
    await logSync(s, { organizationId: o.organizationId, connectionId: u.conn!.id, provider: 'uber_direct', locationId: o.locationId, action: 'cancel_delivery', targetType: 'food_order', targetId: o.id, status: 'ok' });
  } catch (err) {
    await logSync(s, { organizationId: o.organizationId, connectionId: u.conn!.id, provider: 'uber_direct', locationId: o.locationId, action: 'cancel_delivery', targetType: 'food_order', targetId: o.id, status: 'error', ...errInfo(err) });
  }
}

// ───────────────────────── Deliverect ─────────────────────────

export async function deliverectFor(s: Services, loc: Pick<Location, 'id'>) {
  const conn = await partnerConnection(s, 'deliverect', loc.id);
  const creds = conn ? partnerCredentials(s, conn) : {};
  const enabled = !!conn && conn.config.enabled !== false;
  const live = enabled && callsAllowed(conn, creds);
  const config = (conn?.config ?? {}) as DeliverectConfig & Record<string, unknown>;
  const client = live ? createDeliverectClient({ creds: { clientId: creds.clientId!, clientSecret: creds.clientSecret! }, config, fetch: s.partnerFetch, baseUrl: s.cfg.DELIVERECT_API_URL }) : null;
  return { conn, creds, enabled, live, client, config };
}

/** (a) Accepted BranchHarbor order → location POS via Deliverect. Idempotent: sent once per order. */
export async function pushOrderToPos(s: Services, o: OrderRow) {
  if (o.fulfilment.marketplace || o.fulfilment.pos?.status === 'sent' || o.fulfilment.pos?.status === 'sandbox') return null;
  const dv = await deliverectFor(s, { id: o.locationId });
  if (!dv.conn || !dv.enabled || !dv.config.posInjection) return null;
  const payload = buildChannelOrder({
    id: o.id, orderNumber: o.orderNumber, channel: o.channel, currency: o.currency, currencyExponent: expOf(o.currency),
    lines: o.lines, subtotalMinor: o.subtotalMinor, taxMinor: o.taxMinor, deliveryFeeMinor: o.deliveryFeeMinor, serviceChargeMinor: o.serviceChargeMinor, tipMinor: o.tipMinor, totalMinor: o.totalMinor,
    paid: o.paymentStatus === 'paid', contact: o.contact, notes: o.notes, promisedAt: o.promisedAt, address: o.fulfilment.address ?? null, tableLabel: o.fulfilment.tableLabel ?? null,
  });
  let pos: NonNullable<FoodOrderFulfilment['pos']>;
  if (!dv.client) {
    pos = { provider: 'deliverect', status: 'sandbox', at: new Date().toISOString() };
    await logSync(s, { organizationId: o.organizationId, connectionId: dv.conn.id, provider: 'deliverect', locationId: o.locationId, action: 'pos_push', targetType: 'food_order', targetId: o.id, status: 'sandbox', message: 'Sandbox: order not sent to the POS', detail: { payload } });
  } else {
    try {
      await dv.client.injectOrder(payload);
      pos = { provider: 'deliverect', status: 'sent', at: new Date().toISOString() };
      await logSync(s, { organizationId: o.organizationId, connectionId: dv.conn.id, provider: 'deliverect', locationId: o.locationId, action: 'pos_push', targetType: 'food_order', targetId: o.id, status: 'ok' });
    } catch (err) {
      pos = { provider: 'deliverect', status: 'failed', at: new Date().toISOString(), error: (err as Error).message };
      await logSync(s, { organizationId: o.organizationId, connectionId: dv.conn.id, provider: 'deliverect', locationId: o.locationId, action: 'pos_push', targetType: 'food_order', targetId: o.id, status: 'error', ...errInfo(err) });
    }
  }
  const [cur] = await s.db.select({ f: foodOrders.fulfilment }).from(foodOrders).where(eq(foodOrders.id, o.id));
  await s.db.update(foodOrders).set({ fulfilment: { ...(cur?.f ?? o.fulfilment), pos } }).where(eq(foodOrders.id, o.id));
  return pos;
}

/** (b) Our status change on a marketplace order → Deliverect → marketplace. */
export async function syncMarketplaceStatus(s: Services, o: OrderRow, to: string) {
  const mp = o.fulfilment.marketplace;
  const code = OUR_TO_DELIVERECT_STATUS[to];
  if (!mp || code === undefined) return null;
  const dv = await deliverectFor(s, { id: o.locationId });
  if (!dv.conn) return null;
  const base = { organizationId: o.organizationId, connectionId: dv.conn.id, provider: 'deliverect', locationId: o.locationId, action: 'order_status', targetType: 'food_order', targetId: o.id };
  if (!dv.client || mp.testOrder && !dv.live) { await logSync(s, { ...base, status: 'sandbox', message: `Sandbox: status ${code} not sent`, detail: { status: code, to } }); return { sent: false, status: code }; }
  try {
    await dv.client.updateOrderStatus(mp.deliverectOrderId, code, { receiptId: o.orderNumber, reason: to === 'rejected' ? o.rejectionReason ?? undefined : undefined });
    await logSync(s, { ...base, status: 'ok', detail: { status: code, to } });
    return { sent: true, status: code };
  } catch (err) {
    await logSync(s, { ...base, status: 'error', ...errInfo(err), detail: { status: code, to } });
    return { sent: false, status: code };
  }
}

/** Job handler for every partner-relevant order transition. */
export async function onFoodOrderTransition(s: Services, orderId: string, to: string) {
  const [o] = await s.db.select().from(foodOrders).where(eq(foodOrders.id, orderId));
  if (!o) return;
  if (o.fulfilment.marketplace) await syncMarketplaceStatus(s, o, to);
  else if (to === 'accepted') await pushOrderToPos(s, o);
  if (to === 'cancelled' || to === 'rejected') await cancelCourierFor(s, o);
}

const findDeliverectConnection = async (s: Services, p: Record<string, unknown>) => {
  const rows = await s.db.select().from(connections).where(eq(connections.provider, 'deliverect'));
  return rows.find((c) => p.location && c.config.deliverectLocationId === p.location) ?? rows.find((c) => p.channelLink && c.config.channelLinkId === p.channelLink)
    ?? rows.find((c) => p.locationId && c.config.deliverectLocationId === p.locationId);
};

/** POST /v1/webhooks/deliverect */
export async function handleDeliverectWebhook(s: Services, raw: Buffer, headers: Record<string, unknown>) {
  let p: Record<string, unknown>;
  try { p = JSON.parse(raw.toString('utf8')); } catch { throw new AppError(400, 'invalid_payload', 'Body is not JSON'); }
  const conn = await findDeliverectConnection(s, p);
  const creds = conn ? partnerCredentials(s, conn) : {};
  const staging = (conn?.config.environment ?? 'staging') !== 'production';
  // Production: the partner secret. Staging: Deliverect signs with the channel link id (or location id).
  const secrets = [creds.webhookSecret, s.cfg.DELIVERECT_WEBHOOK_SECRET, ...(staging ? [p.channelLink as string, p.location as string, p.locationId as string] : [])];
  if (!verifyDeliverectSignature(raw, headers[DELIVERECT_SIGNATURE_HEADER] as string | undefined, secrets)) throw new AppError(401, 'invalid_signature', 'Deliverect webhook signature verification failed');
  if (!conn) throw new AppError(404, 'unknown_location', 'No BranchHarbor location is connected to this Deliverect location');
  const kind = deliverectWebhookKind(p);
  const eventKey = kind === 'order' ? `order:${String(p._id)}:${String(p.status ?? 10)}` : `${kind}:${String(p._id ?? p.channelOrderId ?? '')}:${String(p.status ?? '')}:${raw.length}:${String(p._updated ?? '')}`;
  const [fresh] = await s.db.insert(partnerWebhookEvents).values({ provider: 'deliverect', eventKey, organizationId: conn.organizationId, connectionId: conn.id, kind, payload: p }).onConflictDoNothing().returning();
  const finish = async (outcome: string, detail: string, extra: Record<string, unknown> = {}) => { if (fresh) await s.db.update(partnerWebhookEvents).set({ outcome, detail }).where(eq(partnerWebhookEvents.id, fresh.id)); return { received: true, outcome, detail, ...extra }; };
  if (conn.config.enabled === false) return finish('ignored', 'Deliverect is switched off for this location');

  if (kind === 'busy_mode') {
    const paused = /PAUSED|BUSY/i.test(String(p.status));
    await s.db.update(connections).set({ config: { ...conn.config, busy: { paused, at: new Date().toISOString(), source: 'deliverect' } }, updatedAt: new Date() }).where(eq(connections.id, conn.id));
    return finish('processed', paused ? 'Busy mode on (from Deliverect)' : 'Busy mode off (from Deliverect)');
  }
  if (kind === 'channel_status') {
    // Status of an order we injected into the POS: recorded for staff, BranchHarbor stays the source of truth.
    await logSync(s, { organizationId: conn.organizationId, connectionId: conn.id, provider: 'deliverect', locationId: conn.locationId, action: 'pos_status', targetType: 'food_order', targetId: String(p.channelOrderId), status: Number(p.status) >= 110 ? 'error' : 'ok', message: `POS status ${String(p.status)}` });
    return finish('processed', `POS status ${String(p.status)}`);
  }
  if (kind !== 'order') return finish('ignored', 'Unrecognised payload');
  if (!fresh) return { received: true, duplicate: true };
  if (conn.config.channelLinkId && p.channelLink === conn.config.channelLinkId) return finish('ignored', 'Echo of an order BranchHarbor injected');
  if (!conn.config.marketplaceOrders) return finish('ignored', 'Marketplace orders are not enabled for this location');
  const r = await ingestMarketplaceOrder(s, conn, p);
  return finish(r.outcome, r.detail, { orderId: r.orderId ?? null, duplicate: r.duplicate ?? false });
}

/** Create (or cancel) a BranchHarbor food order from a Deliverect marketplace order. Idempotent per channel order id. */
export async function ingestMarketplaceOrder(s: Services, conn: Connection, p: Record<string, unknown>): Promise<{ outcome: string; detail: string; orderId?: string; duplicate?: boolean }> {
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, conn.locationId!));
  if (!loc) return { outcome: 'failed', detail: 'Location not found' };
  const inb = parseInboundOrder(p, expOf(loc.currency));
  const key = `${inb.channel.id}:${inb.channelOrderId}`;
  const [existing] = await s.db.select().from(externalMappings).where(and(eq(externalMappings.connectionId, conn.id), eq(externalMappings.entityType, 'deliverect_order'), eq(externalMappings.externalId, key)));

  if (inb.isCancellation) {
    if (!existing?.internalId) return { outcome: 'ignored', detail: 'Cancellation for an unknown order' };
    const [o] = await s.db.select().from(foodOrders).where(eq(foodOrders.id, existing.internalId));
    if (!o || ['cancelled', 'rejected'].includes(o.status)) return { outcome: 'ignored', detail: 'Already cancelled', orderId: o?.id };
    const { transitionFoodOrder } = await import('./foods.ts');
    try {
      await transitionFoodOrder(s, o.id, 'cancelled', { organizationId: o.organizationId, actorUserId: null, note: `Cancelled by ${inb.channel.name}` });
      return { outcome: 'processed', detail: 'Order cancelled by the marketplace', orderId: o.id };
    } catch (err) {
      await audit(s.db, { organizationId: o.organizationId, actorUserId: null, actorType: 'system', action: 'food_order.marketplace_cancel_failed', scopeKind: 'location', scopeId: o.locationId, targetType: 'food_order', targetId: o.id, metadata: { reason: (err as Error).message } });
      return { outcome: 'failed', detail: `Could not cancel: ${(err as Error).message}`, orderId: o.id };
    }
  }
  if (existing?.internalId) return { outcome: 'ignored', detail: 'Duplicate channel order', orderId: existing.internalId, duplicate: true };

  // Lines: PLUs we published map back to menu items/modifiers; anything else is kept by name (never dropped).
  const itemIds = inb.lines.map((l) => pluToId(l.plu)).filter((x) => x?.kind === 'item').map((x) => x!.id);
  const modIds = inb.lines.flatMap((l) => l.subItems.map((si) => pluToId(si.plu))).filter((x) => x?.kind === 'modifier').map((x) => x!.id);
  const items = itemIds.length ? await s.db.select({ id: menuItems.id, stationKey: menuItems.stationKey }).from(menuItems).where(and(inArray(menuItems.id, itemIds), eq(menuItems.organizationId, loc.organizationId))) : [];
  const mods = modIds.length ? await s.db.select({ id: modifiers.id }).from(modifiers).where(and(inArray(modifiers.id, modIds), eq(modifiers.organizationId, loc.organizationId))) : [];
  const unmatched: string[] = [];
  const lines: FoodOrderLine[] = inb.lines.map((l) => {
    const ref = pluToId(l.plu);
    const item = ref?.kind === 'item' ? items.find((i) => i.id === ref.id) : undefined;
    if (!item) unmatched.push(`${l.name} (${l.plu || 'no PLU'})`);
    const lineMods = l.subItems.map((si) => { const r = pluToId(si.plu); const m = r?.kind === 'modifier' ? mods.find((x) => x.id === r.id) : undefined; return { id: m?.id ?? NIL_UUID, name: si.quantity > 1 ? `${si.quantity}× ${si.name}` : si.name, priceMinor: si.priceMinor * si.quantity }; });
    return {
      menuItemId: item?.id ?? NIL_UUID, name: l.name, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, modifiers: lineMods,
      lineTotalMinor: l.quantity * (l.unitPriceMinor + lineMods.reduce((a, m) => a + m.priceMinor, 0)), notes: l.remark ?? undefined, stationKey: item?.stationKey ?? null,
    };
  });
  const prefix = { uber_eats: 'UE', deliveroo: 'DR', doordash: 'DD', just_eat: 'JE' }[inb.channel.key] ?? 'MP';
  const promised = inb.orderType === 'delivery' ? inb.deliveryTime ?? inb.pickupTime : inb.pickupTime;
  const fulfilment: FoodOrderFulfilment = {
    ...(inb.address && inb.orderType === 'delivery' ? { address: inb.address } : {}),
    marketplace: {
      via: 'deliverect', channel: inb.channel.key, channelName: inb.channel.name, channelOrderId: inb.channelOrderId, channelOrderDisplayId: inb.channelOrderDisplayId,
      deliverectOrderId: inb.deliverectId, courier: inb.orderType === 'delivery' ? 'channel' : 'restaurant', discountMinor: inb.discountMinor, driverTipMinor: inb.driverTipMinor,
      dueMinor: inb.dueMinor, testOrder: inb.testOrder, unmatchedItems: unmatched,
    },
  };
  const note = [inb.note, inb.customer.note].filter(Boolean).join(' · ') || null;
  const { depleteForOrder } = await import('./foods-inventory.ts');
  const created = await s.db.transaction(async (tx) => {
    const [m] = await tx.insert(externalMappings).values({ organizationId: loc.organizationId, connectionId: conn.id, entityType: 'deliverect_order', externalId: key, status: 'mapped', externalData: { deliverectOrderId: inb.deliverectId, channel: inb.channel.key } }).onConflictDoNothing().returning();
    if (!m) return null;
    const [o] = await tx.insert(foodOrders).values({
      organizationId: loc.organizationId, locationId: loc.id, customerId: null, orderNumber: `${loc.code}-${prefix}${inb.channelOrderDisplayId}`.slice(0, 40),
      status: 'awaiting_acceptance', paymentStatus: inb.paid ? 'paid' : 'not_required', channel: inb.orderType, fulfilment, lines,
      subtotalMinor: inb.subtotalMinor, taxMinor: inb.taxMinor, serviceChargeMinor: inb.serviceChargeMinor, deliveryFeeMinor: inb.deliveryFeeMinor, tipMinor: inb.tipMinor, totalMinor: inb.totalMinor,
      currency: loc.currency, contact: { name: inb.customer.name, ...(inb.customer.phone ? { phone: inb.customer.phone } : {}) }, notes: note,
      promisedAt: promised ? new Date(promised) : null,
      statusHistory: [{ at: new Date().toISOString(), from: null, to: 'awaiting_acceptance', by: null, note: `Received from ${inb.channel.name} via Deliverect` }],
    }).returning();
    await tx.update(externalMappings).set({ internalId: o!.id }).where(eq(externalMappings.id, m.id));
    const matched = lines.filter((l) => l.menuItemId !== NIL_UUID).map((l) => ({ ...l, modifiers: l.modifiers.filter((x) => x.id !== NIL_UUID) }));
    if (matched.length) await depleteForOrder(tx, { organizationId: loc.organizationId, locationId: loc.id, orderId: o!.id, lines: matched });
    await audit(tx, { organizationId: loc.organizationId, actorUserId: null, actorType: 'system', action: 'food_order.created', scopeKind: 'location', scopeId: loc.id, targetType: 'food_order', targetId: o!.id, metadata: { channel: inb.channel.key, via: 'deliverect', totalMinor: inb.totalMinor, currency: loc.currency } });
    return o!;
  });
  if (!created) {
    const [again] = await s.db.select().from(externalMappings).where(and(eq(externalMappings.connectionId, conn.id), eq(externalMappings.entityType, 'deliverect_order'), eq(externalMappings.externalId, key)));
    return { outcome: 'ignored', detail: 'Duplicate channel order', orderId: again?.internalId ?? undefined, duplicate: true };
  }
  if (conn.config.autoAccept) {
    const { transitionFoodOrder } = await import('./foods.ts');
    await transitionFoodOrder(s, created.id, 'accepted', { organizationId: created.organizationId, actorUserId: null, note: 'Auto-accepted (Deliverect)' }).catch(() => {});
  }
  return { outcome: 'processed', detail: `Order created from ${inb.channel.name}${unmatched.length ? ` (${unmatched.length} item(s) not matched to the menu)` : ''}`, orderId: created.id };
}

/** Snapshot of the location's menu (prices, availability, sold-out, declared allergens) in Deliverect's model. */
export async function deliverectMenuSnapshot(s: Services, loc: Location) {
  const { effectiveMenu } = await import('./foods.ts');
  const dv = await deliverectFor(s, loc);
  const menu = await effectiveMenu(s.db, loc.organizationId, loc);
  const declared = menu.length ? new Map((await s.db.select({ id: menuItems.id, d: menuItems.allergensDeclared }).from(menuItems).where(inArray(menuItems.id, menu.map((i) => i.id)))).map((r) => [r.id, r.d])) : new Map<string, boolean>();
  const items: MenuSnapshotItem[] = menu.map((i) => ({
    id: i.id, name: i.name, description: i.description, category: i.category, categoryId: i.categoryId, price: i.price, imageUrl: i.imageUrl,
    available: i.available || i.unavailableCode === 'outside_day_part', soldOut: i.unavailableCode === 'sold_out', allergens: i.allergens, allergensDeclared: declared.get(i.id) === true,
    modifierGroups: i.modifierGroups.map((g) => ({ id: g.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, modifiers: g.modifiers.map((m) => ({ id: m.id, name: m.name, price: m.price, available: m.available, soldOut: m.soldOut, allergens: m.allergens })) })),
  }));
  const tax = typeof loc.settings.taxRateBps === 'number' ? (loc.settings.taxRateBps as number) : 0;
  return { connection: dv, snapshot: buildMenuSnapshot(items, { accountId: String(dv.config.accountId ?? ''), locationId: String(dv.config.deliverectLocationId ?? '') }, tax) };
}

export async function pushMenuToDeliverect(s: Services, loc: Location, actorUserId: string | null) {
  const { connection: dv, snapshot } = await deliverectMenuSnapshot(s, loc);
  if (!dv.conn) throw conflict('not_configured', 'Deliverect is not configured for this location');
  if (!dv.enabled) throw conflict('disabled', 'Deliverect is switched off for this location');
  const { _meta, ...body } = snapshot;
  const base = { organizationId: loc.organizationId, connectionId: dv.conn.id, provider: 'deliverect', locationId: loc.id, action: 'menu_push', targetType: 'location', targetId: loc.id };
  const summary = { products: body.products.filter((p) => p.productType === 1).length, categories: body.categories.length, soldOut: _meta!.soldOutPlus.length, unmappedAllergens: _meta!.unmappedAllergens, skipped: _meta!.skipped };
  let status: 'ok' | 'sandbox' | 'error' = 'sandbox';
  let message = 'Sandbox: menu snapshot built, nothing sent to Deliverect';
  if (dv.client) {
    try {
      await dv.client.pushMenu(body as never);
      if (_meta!.soldOutPlus.length) await dv.client.snooze(_meta!.soldOutPlus, true);
      status = 'ok'; message = 'Menu sent to Deliverect';
    } catch (err) {
      status = 'error'; message = (err as Error).message;
    }
  }
  await logSync(s, { ...base, status, message, detail: summary });
  await audit(s.db, { organizationId: loc.organizationId, actorUserId, action: 'deliverect.menu_push', scopeKind: 'location', scopeId: loc.id, targetType: 'location', targetId: loc.id, metadata: { status, ...summary } });
  return { status, message, ...summary, snapshot: body };
}

export async function setDeliverectBusyMode(s: Services, loc: Location, paused: boolean, minutes: number | undefined, actorUserId: string | null) {
  const dv = await deliverectFor(s, loc);
  if (!dv.conn) throw conflict('not_configured', 'Deliverect is not configured for this location');
  let status: 'ok' | 'sandbox' | 'error' = 'sandbox';
  let message = paused ? 'Sandbox: busy mode recorded, marketplaces not paused' : 'Sandbox: busy mode cleared';
  if (dv.client) {
    try { await dv.client.busyMode(paused, minutes); status = 'ok'; message = paused ? 'Marketplaces paused via Deliverect' : 'Marketplaces back online'; } catch (err) { status = 'error'; message = (err as Error).message; }
  }
  if (status !== 'error') {
    const until = paused && minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
    await s.db.update(connections).set({ config: { ...dv.conn.config, busy: { paused, until, at: new Date().toISOString(), source: 'branchharbor' } }, updatedAt: new Date() }).where(eq(connections.id, dv.conn.id));
  }
  await logSync(s, { organizationId: loc.organizationId, connectionId: dv.conn.id, provider: 'deliverect', locationId: loc.id, action: 'busy_mode', status, message, detail: { paused, minutes: minutes ?? null } });
  await audit(s.db, { organizationId: loc.organizationId, actorUserId, action: 'deliverect.busy_mode', scopeKind: 'location', scopeId: loc.id, targetType: 'location', targetId: loc.id, metadata: { paused, minutes, status } });
  return { status, message, paused };
}

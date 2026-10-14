/**
 * Local delivery: zones (radius from the location or postcode prefixes) with fee and minimum order,
 * delivery slots with capacity (generated from the location's delivery hours in local time), and the
 * delivery handoff to own drivers or a provider adapter (Uber Direct / Deliverect, sandbox by default).
 */
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { foodDeliveries, foodDeliverySlots, foodDeliveryZones, foodDrivers, foodOrders, locations } from '../db/schema/index.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { deliveryProvider } from '../integrations/foods-delivery.ts';
import { audit } from './audit.ts';
import { loadFoodConfig } from './foods-menu.ts';
import { planPickupSlots, type PickupConfig } from './pickup.ts';

type Location = typeof locations.$inferSelect;
type Zone = typeof foodDeliveryZones.$inferSelect;

/** Postcodes compared without spaces/case; a zone entry matches as a prefix ("SW1A" matches "SW1A 1AA"). */
export const normalizePostcode = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface ZoneMatch { zone: Zone; distanceMeters: number | null; matchedBy: 'postcode' | 'radius' }

/**
 * Find the delivery zone for an address: postcode zones first (exact prefix), then radius zones when the
 * address has coordinates (from the customer's device or the geocoder). Cheapest matching zone wins.
 */
export async function resolveDeliveryZone(s: Pick<Services, 'db' | 'geocoder'>, loc: Location, addr: { postalCode?: string; lat?: number; lng?: number; line1?: string; city?: string }): Promise<ZoneMatch | null> {
  const zones = await s.db.select().from(foodDeliveryZones).where(and(eq(foodDeliveryZones.locationId, loc.id), eq(foodDeliveryZones.active, true))).orderBy(asc(foodDeliveryZones.sortOrder));
  if (!zones.length) return null;
  const pc = addr.postalCode ? normalizePostcode(addr.postalCode) : '';
  const matches: ZoneMatch[] = [];
  if (pc) for (const z of zones.filter((x) => x.kind === 'postcode')) if (z.postcodes.some((p) => pc.startsWith(normalizePostcode(p)))) matches.push({ zone: z, distanceMeters: null, matchedBy: 'postcode' });
  let coords = addr.lat !== undefined && addr.lng !== undefined ? { lat: addr.lat, lng: addr.lng } : null;
  const radiusZones = zones.filter((x) => x.kind === 'radius' && x.radiusMeters);
  if (!coords && radiusZones.length && s.geocoder.enabled && addr.line1) coords = await s.geocoder.geocode([addr.line1, addr.city, addr.postalCode].filter(Boolean).join(', '));
  const origin = loc.geo && typeof loc.geo.lat === 'number' && typeof loc.geo.lng === 'number' ? { lat: loc.geo.lat, lng: loc.geo.lng } : null;
  if (coords && origin) {
    const d = haversineMeters(origin, coords);
    for (const z of radiusZones) if (d <= z.radiusMeters!) matches.push({ zone: z, distanceMeters: Math.round(d), matchedBy: 'radius' });
  }
  if (!matches.length) return null;
  return matches.sort((a, b) => a.zone.feeMinor - b.zone.feeMinor)[0]!;
}

export function deliveryFeeFor(zone: Zone, subtotalMinor: number) {
  if (zone.freeDeliveryAboveMinor !== null && subtotalMinor >= zone.freeDeliveryAboveMinor) return 0;
  return zone.feeMinor;
}

export function serializeZone(z: Zone) {
  const money = (amount: number | null) => (amount === null ? null : { amount, currency: z.currency });
  return {
    id: z.id, locationId: z.locationId, name: z.name, kind: z.kind, radiusMeters: z.radiusMeters, postcodes: z.postcodes,
    fee: money(z.feeMinor), minimumOrder: money(z.minimumOrderMinor), freeDeliveryAbove: money(z.freeDeliveryAboveMinor), active: z.active, sortOrder: z.sortOrder,
  };
}

/** Delivery slot config from the location settings (delivery hours drive slot generation). */
export async function deliveryConfig(db: Exec, loc: Pick<Location, 'id'>): Promise<PickupConfig & { enabled: boolean }> {
  const cfg = await loadFoodConfig(db, loc.id);
  const d = cfg.delivery;
  return { enabled: cfg.channels.delivery, hours: d.hours, slotMinutes: d.slotMinutes, slotCapacity: d.slotCapacity, prepBufferMinutes: d.leadMinutes, cutoffMinutes: d.cutoffMinutes, horizonDays: d.horizonDays, closedDates: [], acceptingOrders: cfg.channels.delivery };
}

/** Generate the delivery slot horizon on demand (existing slots and their bookings are kept). */
export async function ensureDeliverySlots(db: Exec, loc: Location, now = new Date()) {
  const cfg = await deliveryConfig(db, loc);
  if (!cfg.enabled || !cfg.hours.length) return { created: 0, cfg };
  const plan = planPickupSlots(cfg, loc.timeZone, now);
  const created = plan.length
    ? (await db.insert(foodDeliverySlots).values(plan.map((p) => ({ organizationId: loc.organizationId, locationId: loc.id, ...p }))).onConflictDoNothing().returning({ id: foodDeliverySlots.id })).length
    : 0;
  return { created, cfg };
}

export async function listDeliverySlots(db: Exec, loc: Location, from: Date, to: Date) {
  const { cfg } = await ensureDeliverySlots(db, loc);
  const rows = await db.select().from(foodDeliverySlots).where(and(eq(foodDeliverySlots.locationId, loc.id), gte(foodDeliverySlots.startsAt, from), lt(foodDeliverySlots.startsAt, to))).orderBy(asc(foodDeliverySlots.startsAt));
  const now = Date.now();
  const earliest = now + cfg.prepBufferMinutes * 60_000;
  return rows.map((r) => ({ id: r.id, startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(), remaining: Math.max(0, r.capacity - r.booked), cutoffAt: r.cutoffAt.toISOString(), available: cfg.enabled && r.booked < r.capacity && r.cutoffAt.getTime() > now && r.startsAt.getTime() >= earliest }));
}

// ───────── Handoff ─────────

export function serializeDelivery(d: typeof foodDeliveries.$inferSelect, driver?: { id: string; name: string; phone: string | null } | null) {
  return {
    id: d.id, orderId: d.orderId, locationId: d.locationId, provider: d.provider, status: d.status, externalId: d.externalId, trackingUrl: d.trackingUrl, sandbox: d.sandbox,
    feeQuote: d.feeQuoteMinor === null ? null : { amount: d.feeQuoteMinor, currency: d.currency }, driver: driver ?? null, events: d.events,
    createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
  };
}

/** Hand a delivery order to an own driver or a provider. Only delivery-channel orders that are accepted or later. */
export async function dispatchOrder(s: Services, organizationId: string, orderId: string, input: { provider: 'own' | 'uber_direct' | 'deliverect'; driverId?: string | null; actorUserId: string | null }) {
  const [o] = await s.db.select().from(foodOrders).where(and(eq(foodOrders.id, orderId), eq(foodOrders.organizationId, organizationId)));
  if (!o) throw notFound('Order');
  if (o.channel !== 'delivery' && o.channel !== 'meal_plan' && o.channel !== 'catering') throw conflict('not_a_delivery', 'Only delivery orders can be dispatched');
  if (!['accepted', 'preparing', 'ready'].includes(o.status)) throw conflict('invalid_state', `Order is ${o.status}; accept it before dispatching`);
  let driver: typeof foodDrivers.$inferSelect | undefined;
  if (input.provider === 'own') {
    if (!input.driverId) throw validationError('Choose a driver', { driverId: 'Required for own drivers' });
    [driver] = await s.db.select().from(foodDrivers).where(and(eq(foodDrivers.id, input.driverId), eq(foodDrivers.locationId, o.locationId), eq(foodDrivers.active, true)));
    if (!driver) throw validationError('Driver not found at this location', { driverId: 'Unknown driver' });
  }
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, o.locationId));
  let external: { externalId: string; trackingUrl: string | null; feeMinor: number | null; sandbox: boolean } | null = null;
  if (input.provider !== 'own') {
    const adapter = deliveryProvider(input.provider);
    if (adapter.mode === 'disabled') throw new AppError(503, 'provider_unavailable', `${adapter.name} is not configured`);
    external = await adapter.createDelivery({
      reference: o.orderNumber, pickup: { name: loc!.name, address: loc!.address as Record<string, unknown>, phone: loc!.phone ?? null },
      dropoff: { name: o.contact.name, phone: o.contact.phone ?? null, address: (o.fulfilment.address ?? {}) as Record<string, unknown> },
      readyAt: o.promisedAt ?? new Date(), valueMinor: o.totalMinor, currency: o.currency,
    });
  }
  const now = new Date().toISOString();
  const values = {
    organizationId, locationId: o.locationId, orderId: o.id, provider: input.provider, driverId: driver?.id ?? null, externalId: external?.externalId ?? null,
    status: input.provider === 'own' ? 'assigned' : 'pending', trackingUrl: external?.trackingUrl ?? null, feeQuoteMinor: external?.feeMinor ?? null, currency: o.currency,
    sandbox: external?.sandbox ?? false, events: [{ at: now, status: input.provider === 'own' ? 'assigned' : 'pending', by: input.actorUserId, note: driver ? `Assigned to ${driver.name}` : `Requested from ${input.provider}` }],
    updatedAt: new Date(),
  };
  const [existing] = await s.db.select().from(foodDeliveries).where(eq(foodDeliveries.orderId, o.id));
  if (existing && !['cancelled', 'failed'].includes(existing.status)) throw conflict('already_dispatched', 'This order already has an active delivery');
  const [d] = existing
    ? await s.db.update(foodDeliveries).set({ ...values, events: [...existing.events, ...values.events] }).where(eq(foodDeliveries.id, existing.id)).returning()
    : await s.db.insert(foodDeliveries).values(values).returning();
  await audit(s.db, { organizationId, actorUserId: input.actorUserId, action: 'food_delivery.dispatched', scopeKind: 'location', scopeId: o.locationId, targetType: 'food_order', targetId: o.id, metadata: { provider: input.provider, driverId: driver?.id ?? null } });
  return serializeDelivery(d!, driver ? { id: driver.id, name: driver.name, phone: driver.phone } : null);
}

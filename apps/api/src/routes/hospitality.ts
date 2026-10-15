/**
 * Hospitality — staff routes: properties, room types, rooms/beds, rate plans, seasons, prices, daily rates,
 * taxes, cancellation policies, availability, reservations (create/modify/cancel/no-show/assign/check-in/out),
 * folio, room grid, housekeeping, outlet charge-to-room, reports, pulse and sandbox channel managers.
 * Public and guest routes live in hospitality-public.ts. Registered with one line in routes/index.ts.
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  BED_TYPES, DEPOSIT_RULES, FEE_TYPES, HK_STATUSES, HK_TASK_KINDS, HK_TASK_STATUSES, RATE_PLAN_KINDS, REGISTRATION_FIELD_KINDS, RESERVATION_SOURCES, RESERVATION_STATUSES, ROOM_TYPE_KINDS, TAX_KINDS,
  addDaysIso, nightlyPrice, stayNights, type HkStatus,
} from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  hospBeds, hospCancellationPolicies, hospChannelExports, hospDailyRates, hospHkTasks, hospProperties, hospRatePlans, hospRatePrices, hospReservationRooms, hospReservations, hospRooms, hospRoomTypes,
  hospSeasons, hospTaxes, locations, roleAssignments, users,
} from '../db/schema/index.ts';
import { forbidden, notFound, validationError, conflict } from '../lib/errors.ts';
import { isUniqueViolation } from '../lib/pg.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { locationAllowed } from '../services/authz.ts';
import {
  assignRoom, availabilityMatrix, cancelReservation, cancellationQuote, checkIn, checkOut, cleanRegistration, createReservation, dailyRowsFor, expireHolds, folioView, hospAccess, localToday,
  markNoShow, modifyReservation, postFolioLine, propertyFor, rateContext, recomputeInventory, reservationRooms, searchAvailability, setRoomStatus, type HospAccess, type Location, type Reservation,
} from '../services/hospitality.ts';
import { chargeToRoom, generateTasks, hospitalityReport, housekeepingBoard, inHouseGuests, outletMenu, pulse, roomGrid, serializeTask, updateTask } from '../services/hospitality-ops.ts';
import { CHANNEL_ADAPTERS, CHANNEL_PROVIDERS, type AriDay } from '../integrations/hospitality-channels.ts';
import { idParams, orgParams, secured } from './_common.ts';
import { hospitalityPublicRoutes } from './hospitality-public.ts';
import { isoDate, reservationRoomsView, reservationView } from './hospitality-views.ts';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const media = z.object({ url: z.url().max(2000), alt: z.string().max(200).nullish() });
const fee = z.object({ type: z.enum(FEE_TYPES), percentBps: z.number().int().min(0).max(10_000).nullish(), amountMinor: z.number().int().min(0).nullish() });
const roomReq = z.object({ roomTypeId: z.uuid(), ratePlanId: z.uuid(), adults: z.number().int().min(1).max(20), children: z.number().int().min(0).max(20).default(0) });
const guest = z.object({ name: z.string().min(1).max(120), email: z.email(), phone: z.string().max(40).nullish() });
const locParams = z.object({ orgId: z.uuid(), locationId: z.uuid() });
const m = (amount: number, currency: string) => ({ amount, currency });

export const hospitalityRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  await app.register(hospitalityPublicRoutes);

  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    const loadLoc = async (orgId: string, id: string): Promise<Location> => {
      const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, id), eq(locations.organizationId, orgId), isNull(locations.archivedAt)));
      if (!loc) throw notFound('Property');
      return loc;
    };
    const need = (set: 'all' | Set<string>, locationId: string, what: string) => {
      if (!locationAllowed(set, locationId)) throw forbidden(`Missing permission ${what} for this property`);
    };
    const loadRes = async (orgId: string, id: string) => {
      const [r] = await s.db.select().from(hospReservations).where(and(eq(hospReservations.id, id), eq(hospReservations.organizationId, orgId)));
      if (!r) throw notFound('Reservation');
      return r;
    };
    const visibleLocs = async (orgId: string, set: 'all' | Set<string>, locationId?: string) => {
      const locs = await s.db.select().from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt))).orderBy(asc(locations.name));
      return locs.filter((l) => locationAllowed(set, l.id) && (!locationId || l.id === locationId));
    };
    const detail = async (a: HospAccess, r: Reservation) => {
      const contact = locationAllowed(a.guests, r.locationId);
      const loc = await loadLoc(r.organizationId, r.locationId);
      const prop = await propertyFor(s.db, loc);
      return {
        ...reservationView(r, { contact }), rooms: await reservationRoomsView(s.db, r), folio: await folioView(s.db, r), timeline: r.timeline,
        registration: contact ? r.registration ?? {} : null, registrationFields: prop.registrationFields, property: { name: loc.name, currency: loc.currency, timeZone: loc.timeZone, today: localToday(loc), checkInTime: prop.checkInTime, checkOutTime: prop.checkOutTime, requireInspected: prop.requireInspected },
        canRefund: locationAllowed(a.refunds, r.locationId),
      };
    };

    // ───────── Me ─────────
    priv.get('/orgs/:orgId/hospitality/me', { schema: { tags: ['hospitality'], security: secured, params: orgParams, summary: 'Hospitality capabilities of the signed-in user per property' } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const list = (x: 'all' | Set<string>) => (x === 'all' ? 'all' : [...x]);
      return { operations: list(a.ops), operationsWrite: list(a.opsWrite), guests: list(a.guests), configure: list(a.config), refunds: list(a.refunds), reports: list(a.reports) };
    });

    // ───────── Properties ─────────
    priv.get('/orgs/:orgId/hospitality/properties', { schema: { tags: ['hospitality'], security: secured, params: orgParams } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const locs = (await visibleLocs(req.params.orgId, 'all')).filter((l) => locationAllowed(a.ops, l.id) || locationAllowed(a.reports, l.id) || locationAllowed(a.config, l.id));
      const out = [];
      for (const l of locs) {
        const p = await propertyFor(s.db, l);
        const [c] = await s.db.select({ n: sql<number>`count(*)::int` }).from(hospRooms).where(and(eq(hospRooms.locationId, l.id), eq(hospRooms.active, true)));
        out.push({ ...p, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(), locationId: l.id, name: l.name, code: l.code, city: l.address.city, country: l.country, currency: l.currency, timeZone: l.timeZone, today: localToday(l), publiclyVisible: l.publiclyVisible, paymentsEnabled: l.paymentsEnabled, roomCount: c?.n ?? 0 });
      }
      return { items: out };
    });

    priv.put('/orgs/:orgId/hospitality/properties/:locationId', {
      schema: {
        tags: ['hospitality'], security: secured, params: locParams, summary: 'Property settings (needs locations.write)',
        body: z.object({
          kind: z.enum(['hotel', 'guesthouse', 'serviced_apartments', 'hostel']), description: z.string().max(4000).nullable(), amenities: z.array(z.string().min(1).max(60)).max(60), photos: z.array(media).max(40),
          checkInTime: hhmm, checkOutTime: hhmm, holdMinutes: z.number().int().min(5).max(120), requireInspected: z.boolean(),
          registrationFields: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), label: z.string().min(1).max(80), kind: z.enum(REGISTRATION_FIELD_KINDS), required: z.boolean() })).max(12),
          registrationRetentionDays: z.number().int().min(1).max(3650), preArrivalDays: z.number().int().min(0).max(30), houseRules: z.string().max(4000).nullable(), arrivalInstructions: z.string().max(2000).nullable(),
          outletEnabled: z.boolean(), outletName: z.string().max(80).nullable(),
        }).partial(),
      },
    }, async (req) => {
      const { orgId, locationId } = req.params;
      const loc = await loadLoc(orgId, locationId);
      need((await hospAccess(req, s.db, orgId)).config, loc.id, 'locations.write');
      const p = await propertyFor(s.db, loc);
      const [u] = await s.db.update(hospProperties).set({ ...req.body, updatedAt: new Date() }).where(eq(hospProperties.id, p.id)).returning();
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'hospitality.property.updated', scopeKind: 'location', scopeId: loc.id, targetType: 'hosp_property', targetId: p.id, metadata: { fields: Object.keys(req.body) } });
      return u!;
    });

    // ───────── Room types ─────────
    const roomTypeBody = z.object({
      code: z.string().min(1).max(20), name: z.string().min(1).max(120), kind: z.enum(ROOM_TYPE_KINDS), description: z.string().max(4000).nullable(),
      beds: z.array(z.object({ type: z.enum(BED_TYPES), count: z.number().int().min(1).max(20) })).max(10), baseOccupancy: z.number().int().min(1).max(20), maxOccupancy: z.number().int().min(1).max(30), maxAdults: z.number().int().min(1).max(30).nullable(),
      sizeSqm: z.number().min(1).max(10_000).nullable(), amenities: z.array(z.string().min(1).max(60)).max(60), photos: z.array(media).max(30), bookableOnline: z.boolean(), active: z.boolean(), sortOrder: z.number().int(),
    }).partial();

    priv.get('/orgs/:orgId/hospitality/room-types', { schema: { tags: ['hospitality'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid() }) } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const loc = await loadLoc(req.params.orgId, req.query.locationId);
      if (!locationAllowed(a.ops, loc.id) && !locationAllowed(a.config, loc.id)) throw forbidden();
      const types = await s.db.select().from(hospRoomTypes).where(eq(hospRoomTypes.locationId, loc.id)).orderBy(asc(hospRoomTypes.sortOrder), asc(hospRoomTypes.name));
      const counts = await s.db.select({ t: hospRooms.roomTypeId, n: sql<number>`count(*)::int` }).from(hospRooms).where(and(eq(hospRooms.locationId, loc.id), eq(hospRooms.active, true))).groupBy(hospRooms.roomTypeId);
      return { items: types.map((t) => ({ ...t, createdAt: t.createdAt.toISOString(), roomCount: counts.find((c) => c.t === t.id)?.n ?? 0 })) };
    });

    priv.post('/orgs/:orgId/hospitality/room-types', { schema: { tags: ['hospitality'], security: secured, params: orgParams, body: roomTypeBody.extend({ locationId: z.uuid(), code: z.string().min(1).max(20), name: z.string().min(1).max(120) }) } }, async (req, reply) => {
      const { orgId } = req.params;
      const loc = await loadLoc(orgId, req.body.locationId);
      need((await hospAccess(req, s.db, orgId)).config, loc.id, 'locations.write');
      await propertyFor(s.db, loc);
      try {
        const [row] = await s.db.insert(hospRoomTypes).values({ organizationId: orgId, ...req.body }).returning();
        await audit(s.db, { organizationId: orgId, ...actor(req), action: 'hospitality.room_type.created', scopeKind: 'location', scopeId: loc.id, targetType: 'hosp_room_type', targetId: row!.id });
        return reply.code(201).send(row);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('duplicate_code', 'A room type with this code already exists at this property');
        throw err;
      }
    });

    priv.patch('/orgs/:orgId/hospitality/room-types/:id', { schema: { tags: ['hospitality'], security: secured, params: idParams, body: roomTypeBody } }, async (req) => {
      const { orgId, id } = req.params;
      const [t] = await s.db.select().from(hospRoomTypes).where(and(eq(hospRoomTypes.id, id), eq(hospRoomTypes.organizationId, orgId)));
      if (!t) throw notFound('Room type');
      need((await hospAccess(req, s.db, orgId)).config, t.locationId, 'locations.write');
      if (req.body.kind && req.body.kind !== t.kind) throw conflict('kind_locked', 'Create a new room type to change between rooms and dorm beds');
      const [u] = await s.db.update(hospRoomTypes).set(req.body).where(eq(hospRoomTypes.id, id)).returning();
      return u!;
    });

    // ───────── Rooms & beds ─────────
    priv.get('/orgs/:orgId/hospitality/rooms', { schema: { tags: ['hospitality'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid() }) } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const loc = await loadLoc(req.params.orgId, req.query.locationId);
      need(a.ops, loc.id, 'operations.read');
      const rooms = await s.db.select().from(hospRooms).where(eq(hospRooms.locationId, loc.id)).orderBy(asc(hospRooms.sortOrder), asc(hospRooms.number));
      const beds = rooms.length ? await s.db.select().from(hospBeds).where(inArray(hospBeds.roomId, rooms.map((r) => r.id))).orderBy(asc(hospBeds.label)) : [];
      return { items: rooms.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), beds: beds.filter((b) => b.roomId === r.id) })) };
    });

    priv.post('/orgs/:orgId/hospitality/rooms', {
      schema: { tags: ['hospitality'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), roomTypeId: z.uuid(), number: z.string().min(1).max(20), floor: z.string().max(20).nullish(), beds: z.number().int().min(0).max(40).default(0), sortOrder: z.number().int().default(0) }) },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const loc = await loadLoc(orgId, req.body.locationId);
      need((await hospAccess(req, s.db, orgId)).config, loc.id, 'locations.write');
      const [t] = await s.db.select().from(hospRoomTypes).where(and(eq(hospRoomTypes.id, req.body.roomTypeId), eq(hospRoomTypes.locationId, loc.id)));
      if (!t) throw validationError('Unknown room type', { roomTypeId: 'Not a room type at this property' });
      if (t.kind === 'dorm' && req.body.beds < 1) throw validationError('A dorm room needs at least one bed', { beds: 'At least 1' });
      try {
        const room = await s.db.transaction(async (tx) => {
          const [r] = await tx.insert(hospRooms).values({ organizationId: orgId, locationId: loc.id, roomTypeId: t.id, number: req.body.number, floor: req.body.floor ?? null, sortOrder: req.body.sortOrder }).returning();
          if (t.kind === 'dorm') await tx.insert(hospBeds).values(Array.from({ length: req.body.beds }, (_, i) => ({ organizationId: orgId, roomId: r!.id, label: String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '') })));
          await recomputeInventory(tx, t.id, localToday(loc));
          return r!;
        });
        await audit(s.db, { organizationId: orgId, ...actor(req), action: 'hospitality.room.created', scopeKind: 'location', scopeId: loc.id, targetType: 'hosp_room', targetId: room.id });
        return reply.code(201).send(room);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('duplicate_number', 'A room with this number already exists at this property');
        throw err;
      }
    });

    priv.patch('/orgs/:orgId/hospitality/rooms/:id', { schema: { tags: ['hospitality'], security: secured, params: idParams, body: z.object({ number: z.string().min(1).max(20), floor: z.string().max(20).nullable(), notes: z.string().max(1000).nullable(), active: z.boolean(), sortOrder: z.number().int() }).partial() } }, async (req) => {
      const { orgId, id } = req.params;
      const [r] = await s.db.select().from(hospRooms).where(and(eq(hospRooms.id, id), eq(hospRooms.organizationId, orgId)));
      if (!r) throw notFound('Room');
      const loc = await loadLoc(orgId, r.locationId);
      need((await hospAccess(req, s.db, orgId)).config, r.locationId, 'locations.write');
      return s.db.transaction(async (tx) => {
        const [u] = await tx.update(hospRooms).set({ ...req.body, updatedAt: new Date() }).where(eq(hospRooms.id, id)).returning();
        if (req.body.active !== undefined && req.body.active !== r.active) await recomputeInventory(tx, r.roomTypeId, localToday(loc));
        return u!;
      });
    });

    priv.post('/orgs/:orgId/hospitality/rooms/:id/status', {
      schema: { tags: ['hospitality'], security: secured, params: idParams, summary: 'Housekeeping status. Out of order needs a reason and a back-in-service date and reduces inventory.', body: z.object({ status: z.enum(HK_STATUSES), reason: z.string().max(300).nullish(), until: isoDate.nullish() }) },
    }, async (req) => {
      const { orgId, id } = req.params;
      const [r] = await s.db.select().from(hospRooms).where(and(eq(hospRooms.id, id), eq(hospRooms.organizationId, orgId)));
      if (!r) throw notFound('Room');
      need((await hospAccess(req, s.db, orgId)).opsWrite, r.locationId, 'operations.write');
      return setRoomStatus(s, await loadLoc(orgId, r.locationId), r.id, req.body.status as HkStatus, { reason: req.body.reason ?? null, until: req.body.until ?? null }, req.user!.id);
    });

    // ───────── Policies & taxes ─────────
    const policyBody = z.object({ name: z.string().min(1).max(120), nonRefundable: z.boolean(), freeUntilHours: z.number().int().min(0).max(24 * 90).nullable(), lateFee: fee, noShowFee: fee }).partial();
    priv.get('/orgs/:orgId/hospitality/policies', { schema: { tags: ['hospitality'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid() }) } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      if (!locationAllowed(a.ops, req.query.locationId) && !locationAllowed(a.config, req.query.locationId)) throw forbidden();
      return { items: await s.db.select().from(hospCancellationPolicies).where(and(eq(hospCancellationPolicies.locationId, req.query.locationId), eq(hospCancellationPolicies.organizationId, req.params.orgId))).orderBy(asc(hospCancellationPolicies.name)) };
    });
    priv.post('/orgs/:orgId/hospitality/policies', { schema: { tags: ['hospitality'], security: secured, params: orgParams, body: policyBody.extend({ locationId: z.uuid(), name: z.string().min(1).max(120) }) } }, async (req, reply) => {
      const loc = await loadLoc(req.params.orgId, req.body.locationId);
      need((await hospAccess(req, s.db, req.params.orgId)).config, loc.id, 'locations.write');
      const [row] = await s.db.insert(hospCancellationPolicies).values({ organizationId: req.params.orgId, ...req.body }).returning();
      return reply.code(201).send(row);
    });
    priv.patch('/orgs/:orgId/hospitality/policies/:id', { schema: { tags: ['hospitality'], security: secured, params: idParams, body: policyBody } }, async (req) => {
      const [p] = await s.db.select().from(hospCancellationPolicies).where(and(eq(hospCancellationPolicies.id, req.params.id), eq(hospCancellationPolicies.organizationId, req.params.orgId)));
      if (!p) throw notFound('Policy');
      need((await hospAccess(req, s.db, req.params.orgId)).config, p.locationId, 'locations.write');
      const [u] = await s.db.update(hospCancellationPolicies).set(req.body).where(eq(hospCancellationPolicies.id, p.id)).returning();
      return u!;
    });

    const taxBody = z.object({ name: z.string().min(1).max(120), kind: z.enum(TAX_KINDS), rateBps: z.number().int().min(0).max(10_000).nullable(), amountMinor: z.number().int().min(0).nullable(), inclusive: z.boolean(), maxNights: z.number().int().min(1).max(365).nullable(), appliesToChildren: z.boolean(), note: z.string().max(500).nullable(), active: z.boolean() }).partial();
    const checkTax = (t: { kind?: string; rateBps?: number | null; amountMinor?: number | null }) => {
      if (t.kind === 'percent' && t.rateBps == null) throw validationError('Enter the tax rate', { rateBps: 'Required for a percentage tax' });
      if (t.kind && t.kind !== 'percent' && t.amountMinor == null) throw validationError('Enter the tax amount', { amountMinor: 'Required' });
    };
    priv.get('/orgs/:orgId/hospitality/taxes', { schema: { tags: ['hospitality'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid() }) } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      if (!locationAllowed(a.ops, req.query.locationId) && !locationAllowed(a.config, req.query.locationId)) throw forbidden();
      return { items: await s.db.select().from(hospTaxes).where(and(eq(hospTaxes.locationId, req.query.locationId), eq(hospTaxes.organizationId, req.params.orgId))).orderBy(asc(hospTaxes.name)) };
    });
    priv.post('/orgs/:orgId/hospitality/taxes', { schema: { tags: ['hospitality'], security: secured, params: orgParams, summary: 'Taxes are entered by the business (BranchHarbor never supplies rates)', body: taxBody.extend({ locationId: z.uuid(), name: z.string().min(1).max(120), kind: z.enum(TAX_KINDS) }) } }, async (req, reply) => {
      const loc = await loadLoc(req.params.orgId, req.body.locationId);
      need((await hospAccess(req, s.db, req.params.orgId)).config, loc.id, 'locations.write');
      checkTax(req.body);
      const [row] = await s.db.insert(hospTaxes).values({ organizationId: req.params.orgId, currency: loc.currency, ...req.body }).returning();
      await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'hospitality.tax.created', scopeKind: 'location', scopeId: loc.id, targetType: 'hosp_tax', targetId: row!.id, metadata: { ...req.body } });
      return reply.code(201).send(row);
    });
    priv.patch('/orgs/:orgId/hospitality/taxes/:id', { schema: { tags: ['hospitality'], security: secured, params: idParams, body: taxBody } }, async (req) => {
      const [t] = await s.db.select().from(hospTaxes).where(and(eq(hospTaxes.id, req.params.id), eq(hospTaxes.organizationId, req.params.orgId)));
      if (!t) throw notFound('Tax');
      need((await hospAccess(req, s.db, req.params.orgId)).config, t.locationId, 'locations.write');
      checkTax({ ...t, ...req.body });
      const [u] = await s.db.update(hospTaxes).set(req.body).where(eq(hospTaxes.id, t.id)).returning();
      return u!;
    });

    // ───────── Rate plans, seasons, prices, daily rates ─────────
    const planBody = z.object({
      code: z.string().min(1).max(20), name: z.string().min(1).max(120), kind: z.enum(RATE_PLAN_KINDS), description: z.string().max(2000).nullable(), includesBreakfast: z.boolean(), inclusions: z.array(z.string().min(1).max(80)).max(20),
      derivedFromId: z.uuid().nullable(), adjustmentBps: z.number().int().min(-9000).max(10_000).nullable(), minStay: z.number().int().min(1).max(365).nullable(), maxStay: z.number().int().min(1).max(365).nullable(),
      depositRule: z.enum(DEPOSIT_RULES), depositPercentBps: z.number().int().min(0).max(10_000).nullable(), cancellationPolicyId: z.uuid().nullable(), bookableOnline: z.boolean(), active: z.boolean(), sortOrder: z.number().int(),
    }).partial();
    const checkPlan = async (locationId: string, b: z.infer<typeof planBody>, selfId?: string) => {
      if (b.derivedFromId) {
        if (b.derivedFromId === selfId) throw validationError('A plan cannot derive from itself', { derivedFromId: 'Invalid' });
        const [p] = await s.db.select().from(hospRatePlans).where(and(eq(hospRatePlans.id, b.derivedFromId), eq(hospRatePlans.locationId, locationId)));
        if (!p || p.derivedFromId) throw validationError('Derive from a plan at this property that has its own prices', { derivedFromId: 'Invalid' });
      }
      if (b.cancellationPolicyId) {
        const [p] = await s.db.select().from(hospCancellationPolicies).where(and(eq(hospCancellationPolicies.id, b.cancellationPolicyId), eq(hospCancellationPolicies.locationId, locationId)));
        if (!p) throw validationError('Unknown cancellation policy', { cancellationPolicyId: 'Invalid' });
      }
      if (b.depositRule === 'percent' && b.depositPercentBps == null) throw validationError('Enter the deposit percentage', { depositPercentBps: 'Required' });
    };
    priv.get('/orgs/:orgId/hospitality/rate-plans', { schema: { tags: ['hospitality'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid() }) } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      if (!locationAllowed(a.ops, req.query.locationId) && !locationAllowed(a.config, req.query.locationId)) throw forbidden();
      const ctx = await rateContext(s.db, req.query.locationId);
      return { plans: ctx.plans, seasons: ctx.seasons, prices: ctx.prices, policies: ctx.policies, taxes: ctx.taxes, roomTypes: ctx.roomTypes };
    });
    priv.post('/orgs/:orgId/hospitality/rate-plans', { schema: { tags: ['hospitality'], security: secured, params: orgParams, body: planBody.extend({ locationId: z.uuid(), code: z.string().min(1).max(20), name: z.string().min(1).max(120), kind: z.enum(RATE_PLAN_KINDS) }) } }, async (req, reply) => {
      const loc = await loadLoc(req.params.orgId, req.body.locationId);
      need((await hospAccess(req, s.db, req.params.orgId)).config, loc.id, 'locations.write');
      await checkPlan(loc.id, req.body);
      try {
        const [row] = await s.db.insert(hospRatePlans).values({ organizationId: req.params.orgId, currency: loc.currency, ...req.body }).returning();
        await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'hospitality.rate_plan.created', scopeKind: 'location', scopeId: loc.id, targetType: 'hosp_rate_plan', targetId: row!.id });
        return reply.code(201).send(row);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('duplicate_code', 'A rate plan with this code already exists at this property');
        throw err;
      }
    });
    priv.patch('/orgs/:orgId/hospitality/rate-plans/:id', { schema: { tags: ['hospitality'], security: secured, params: idParams, body: planBody } }, async (req) => {
      const [p] = await s.db.select().from(hospRatePlans).where(and(eq(hospRatePlans.id, req.params.id), eq(hospRatePlans.organizationId, req.params.orgId)));
      if (!p) throw notFound('Rate plan');
      need((await hospAccess(req, s.db, req.params.orgId)).config, p.locationId, 'locations.write');
      await checkPlan(p.locationId, { ...p, ...req.body } as z.infer<typeof planBody>, p.id);
      const [u] = await s.db.update(hospRatePlans).set(req.body).where(eq(hospRatePlans.id, p.id)).returning();
      return u!;
    });

    const seasonBody = z.object({ name: z.string().min(1).max(80), startDate: isoDate, endDate: isoDate, minStay: z.number().int().min(1).max(365).nullable(), maxStay: z.number().int().min(1).max(365).nullable(), priority: z.number().int() }).partial();
    priv.post('/orgs/:orgId/hospitality/seasons', { schema: { tags: ['hospitality'], security: secured, params: orgParams, body: seasonBody.extend({ locationId: z.uuid(), name: z.string().min(1).max(80), startDate: isoDate, endDate: isoDate }) } }, async (req, reply) => {
      const loc = await loadLoc(req.params.orgId, req.body.locationId);
      need((await hospAccess(req, s.db, req.params.orgId)).config, loc.id, 'locations.write');
      if (req.body.endDate < req.body.startDate) throw validationError('The season must end on or after its start', { endDate: 'Before start' });
      const [row] = await s.db.insert(hospSeasons).values({ organizationId: req.params.orgId, ...req.body }).returning();
      return reply.code(201).send(row);
    });
    priv.patch('/orgs/:orgId/hospitality/seasons/:id', { schema: { tags: ['hospitality'], security: secured, params: idParams, body: seasonBody } }, async (req) => {
      const [se] = await s.db.select().from(hospSeasons).where(and(eq(hospSeasons.id, req.params.id), eq(hospSeasons.organizationId, req.params.orgId)));
      if (!se) throw notFound('Season');
      need((await hospAccess(req, s.db, req.params.orgId)).config, se.locationId, 'locations.write');
      if ((req.body.endDate ?? se.endDate) < (req.body.startDate ?? se.startDate)) throw validationError('The season must end on or after its start', { endDate: 'Before start' });
      const [u] = await s.db.update(hospSeasons).set(req.body).where(eq(hospSeasons.id, se.id)).returning();
      return u!;
    });
    priv.delete('/orgs/:orgId/hospitality/seasons/:id', { schema: { tags: ['hospitality'], security: secured, params: idParams } }, async (req) => {
      const [se] = await s.db.select().from(hospSeasons).where(and(eq(hospSeasons.id, req.params.id), eq(hospSeasons.organizationId, req.params.orgId)));
      if (!se) throw notFound('Season');
      need((await hospAccess(req, s.db, req.params.orgId)).config, se.locationId, 'locations.write');
      await s.db.delete(hospSeasons).where(eq(hospSeasons.id, se.id));
      return { deleted: true };
    });

    priv.put('/orgs/:orgId/hospitality/rate-plans/:id/prices', {
      schema: {
        tags: ['hospitality'], security: secured, params: idParams, summary: 'Set base or season nightly prices for room types (property currency, minor units). amountMinor null removes the price.',
        body: z.object({ prices: z.array(z.object({ roomTypeId: z.uuid(), seasonId: z.uuid().nullable(), amountMinor: z.number().int().min(0).nullable(), weekdayAmounts: z.partialRecord(z.enum(['0', '1', '2', '3', '4', '5', '6']), z.number().int().min(0)).default({}), extraAdultMinor: z.number().int().min(0).nullish(), extraChildMinor: z.number().int().min(0).nullish(), currency: z.string().length(3).optional() })).min(1).max(200) }),
      },
    }, async (req) => {
      const [p] = await s.db.select().from(hospRatePlans).where(and(eq(hospRatePlans.id, req.params.id), eq(hospRatePlans.organizationId, req.params.orgId)));
      if (!p) throw notFound('Rate plan');
      need((await hospAccess(req, s.db, req.params.orgId)).config, p.locationId, 'locations.write');
      if (p.derivedFromId) throw conflict('derived_plan', 'This plan takes its prices from another plan; edit that plan or its adjustment');
      const loc = await loadLoc(req.params.orgId, p.locationId);
      const types = new Set((await s.db.select({ id: hospRoomTypes.id }).from(hospRoomTypes).where(eq(hospRoomTypes.locationId, loc.id))).map((t) => t.id));
      const seasons = new Set((await s.db.select({ id: hospSeasons.id }).from(hospSeasons).where(eq(hospSeasons.locationId, loc.id))).map((t) => t.id));
      req.body.prices.forEach((x, i) => {
        if (!types.has(x.roomTypeId)) throw validationError('Unknown room type', { [`prices.${i}.roomTypeId`]: 'Not at this property' });
        if (x.seasonId && !seasons.has(x.seasonId)) throw validationError('Unknown season', { [`prices.${i}.seasonId`]: 'Not at this property' });
        if (x.currency && x.currency !== loc.currency) throw validationError(`Prices at this property are in ${loc.currency}`, { [`prices.${i}.currency`]: `Use ${loc.currency}` });
      });
      await s.db.transaction(async (tx) => {
        for (const x of req.body.prices) {
          const cond = and(eq(hospRatePrices.ratePlanId, p.id), eq(hospRatePrices.roomTypeId, x.roomTypeId), x.seasonId ? eq(hospRatePrices.seasonId, x.seasonId) : isNull(hospRatePrices.seasonId));
          await tx.delete(hospRatePrices).where(cond);
          if (x.amountMinor !== null) await tx.insert(hospRatePrices).values({ organizationId: req.params.orgId, ratePlanId: p.id, roomTypeId: x.roomTypeId, seasonId: x.seasonId, currency: loc.currency, amountMinor: x.amountMinor, weekdayAmounts: x.weekdayAmounts, extraAdultMinor: x.extraAdultMinor ?? null, extraChildMinor: x.extraChildMinor ?? null });
        }
        await audit(tx, { organizationId: req.params.orgId, ...actor(req), action: 'hospitality.prices.updated', scopeKind: 'location', scopeId: loc.id, targetType: 'hosp_rate_plan', targetId: p.id, metadata: { count: req.body.prices.length } });
      });
      return { items: await s.db.select().from(hospRatePrices).where(eq(hospRatePrices.ratePlanId, p.id)) };
    });

    priv.put('/orgs/:orgId/hospitality/daily-rates', {
      schema: {
        tags: ['hospitality'], security: secured, params: orgParams, summary: 'Bulk set price overrides and restrictions for a date range (inclusive) and optional weekdays',
        body: z.object({
          ratePlanId: z.uuid(), roomTypeIds: z.array(z.uuid()).min(1).max(50), from: isoDate, to: isoDate, weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
          set: z.object({ amountMinor: z.number().int().min(0).nullable(), minStay: z.number().int().min(1).max(365).nullable(), maxStay: z.number().int().min(1).max(365).nullable(), closed: z.boolean(), closedToArrival: z.boolean(), closedToDeparture: z.boolean() }).partial(),
        }),
      },
    }, async (req) => {
      const { orgId } = req.params;
      const [p] = await s.db.select().from(hospRatePlans).where(and(eq(hospRatePlans.id, req.body.ratePlanId), eq(hospRatePlans.organizationId, orgId)));
      if (!p) throw notFound('Rate plan');
      need((await hospAccess(req, s.db, orgId)).config, p.locationId, 'locations.write');
      if (req.body.to < req.body.from) throw validationError('The end date must be on or after the start date', { to: 'Before start' });
      const dates = stayNights(req.body.from, addDaysIso(req.body.to, 1)).filter((d) => !req.body.weekdays || req.body.weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay()));
      if (dates.length > 400) throw validationError('Up to 400 nights at a time', { to: 'Too long' });
      const types = await s.db.select({ id: hospRoomTypes.id }).from(hospRoomTypes).where(and(eq(hospRoomTypes.locationId, p.locationId), inArray(hospRoomTypes.id, req.body.roomTypeIds)));
      if (types.length !== new Set(req.body.roomTypeIds).size) throw validationError('Unknown room type', { roomTypeIds: 'Not at this property' });
      const setFields = req.body.set;
      if (!Object.keys(setFields).length) throw validationError('Nothing to change', { set: 'Required' });
      await s.db.transaction(async (tx) => {
        for (const rt of req.body.roomTypeIds) {
          const values = dates.map((d) => ({ organizationId: orgId, ratePlanId: p.id, roomTypeId: rt, date: d, ...setFields }));
          for (let i = 0; i < values.length; i += 200) {
            await tx.insert(hospDailyRates).values(values.slice(i, i + 200)).onConflictDoUpdate({
              target: [hospDailyRates.ratePlanId, hospDailyRates.roomTypeId, hospDailyRates.date],
              set: Object.fromEntries(Object.keys(setFields).map((k) => [k, sql.raw(`excluded.${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`)])),
            });
          }
        }
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'hospitality.daily_rates.updated', scopeKind: 'location', scopeId: p.locationId, targetType: 'hosp_rate_plan', targetId: p.id, metadata: { from: req.body.from, to: req.body.to, nights: dates.length, set: setFields } });
      });
      return { updated: dates.length * req.body.roomTypeIds.length };
    });

    priv.get('/orgs/:orgId/hospitality/rates-grid', {
      schema: { tags: ['hospitality'], security: secured, params: orgParams, summary: 'Rates & availability: room types × nights with inventory, and per plan price + restrictions', querystring: z.object({ locationId: z.uuid(), from: isoDate, nights: z.coerce.number().int().min(1).max(62).default(14) }) },
    }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const loc = await loadLoc(req.params.orgId, req.query.locationId);
      if (!locationAllowed(a.ops, loc.id) && !locationAllowed(a.config, loc.id)) throw forbidden();
      const dates = Array.from({ length: req.query.nights }, (_, i) => addDaysIso(req.query.from, i));
      const ctx = await rateContext(s.db, loc.id);
      const daily = await dailyRowsFor(s.db, ctx.plans.map((p) => p.id), dates[0]!, dates[dates.length - 1]!);
      const inv = await availabilityMatrix(s.db, ctx.roomTypes.map((t) => t.id), dates);
      const seasons = ctx.seasons.map((x) => ({ id: x.id, name: x.name, startDate: x.startDate, endDate: x.endDate, minStay: x.minStay, maxStay: x.maxStay, priority: x.priority }));
      return {
        locationId: loc.id, currency: loc.currency, dates, seasons: ctx.seasons,
        roomTypes: ctx.roomTypes.filter((t) => t.active).map((t) => ({
          id: t.id, code: t.code, name: t.name, kind: t.kind,
          inventory: dates.map((d) => ({ date: d, ...inv.get(t.id)!.get(d)! })),
          plans: ctx.plans.filter((p) => p.active).map((p) => {
            const src = p.derivedFromId ?? p.id;
            const prices = ctx.prices.filter((x) => x.ratePlanId === src && x.roomTypeId === t.id).map((x) => ({ seasonId: x.seasonId, amountMinor: x.amountMinor, weekdayAmounts: x.weekdayAmounts }));
            const dPrices = daily.filter((x) => x.ratePlanId === src && x.roomTypeId === t.id).map((x) => ({ date: x.date, amountMinor: x.amountMinor }));
            return {
              ratePlanId: p.id, code: p.code, name: p.name, derived: !!p.derivedFromId,
              days: dates.map((d) => {
                const np = nightlyPrice(d, prices, seasons, dPrices);
                const r = daily.find((x) => x.ratePlanId === p.id && x.roomTypeId === t.id && x.date === d);
                const amount = np ? (p.derivedFromId && p.adjustmentBps ? Math.round((np.amountMinor * (10_000 + p.adjustmentBps)) / 10_000) : np.amountMinor) : null;
                return { date: d, price: amount === null ? null : m(amount, loc.currency), source: np?.source ?? null, minStay: r?.minStay ?? null, maxStay: r?.maxStay ?? null, closed: r?.closed ?? false, closedToArrival: r?.closedToArrival ?? false, closedToDeparture: r?.closedToDeparture ?? false };
              }),
            };
          }),
        })),
      };
    });

    // ───────── Availability & reservations ─────────
    priv.get('/orgs/:orgId/hospitality/availability', {
      schema: { tags: ['hospitality'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid(), arrival: isoDate, departure: isoDate, adults: z.coerce.number().int().min(1).max(40).default(2), children: z.coerce.number().int().min(0).max(40).default(0), rooms: z.coerce.number().int().min(1).max(20).default(1) }) },
    }, async (req) => {
      const loc = await loadLoc(req.params.orgId, req.query.locationId);
      need((await hospAccess(req, s.db, req.params.orgId)).ops, loc.id, 'operations.read');
      await expireHolds(s, loc.id);
      return { currency: loc.currency, items: await searchAvailability(s.db, loc, { ...req.query, online: false }) };
    });

    priv.get('/orgs/:orgId/hospitality/reservations', {
      schema: {
        tags: ['hospitality'], security: secured, params: orgParams,
        querystring: z.object({ locationId: z.uuid().optional(), view: z.enum(['arrivals', 'departures', 'in_house', 'upcoming', 'all']).default('all'), date: isoDate.optional(), status: z.enum(RESERVATION_STATUSES).optional(), q: z.string().max(80).optional(), from: isoDate.optional(), to: isoDate.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }),
      },
    }, async (req) => {
      const { orgId } = req.params;
      const a = await hospAccess(req, s.db, orgId);
      const locs = await visibleLocs(orgId, a.ops, req.query.locationId);
      if (!locs.length) return { items: [] };
      const conds = [eq(hospReservations.organizationId, orgId), inArray(hospReservations.locationId, locs.map((l) => l.id))];
      // "Today" is each property's own local date unless a date is given.
      const perLoc = (col: typeof hospReservations.arrival | typeof hospReservations.departure, cmp: typeof eq) => or(...locs.map((l) => and(eq(hospReservations.locationId, l.id), cmp(col, req.query.date ?? localToday(l)))))!;
      if (req.query.view === 'arrivals') conds.push(perLoc(hospReservations.arrival, eq), inArray(hospReservations.status, ['confirmed', 'checked_in', 'hold']));
      if (req.query.view === 'departures') conds.push(perLoc(hospReservations.departure, eq), inArray(hospReservations.status, ['checked_in', 'checked_out', 'confirmed']));
      if (req.query.view === 'in_house') conds.push(eq(hospReservations.status, 'checked_in'));
      if (req.query.view === 'upcoming') conds.push(perLoc(hospReservations.arrival, gte as typeof eq), inArray(hospReservations.status, ['confirmed', 'hold']));
      if (req.query.status) conds.push(eq(hospReservations.status, req.query.status));
      if (req.query.from) conds.push(sql`${hospReservations.departure} > ${req.query.from}`);
      if (req.query.to) conds.push(lt(hospReservations.arrival, req.query.to));
      if (req.query.q) conds.push(or(ilike(hospReservations.code, `%${req.query.q}%`), ilike(hospReservations.guestName, `%${req.query.q}%`), ilike(hospReservations.groupName, `%${req.query.q}%`))!);
      const rows = await s.db.select().from(hospReservations).where(and(...conds)).orderBy(req.query.view === 'all' ? desc(hospReservations.arrival) : asc(hospReservations.arrival)).limit(req.query.limit);
      const rr = rows.length ? await s.db.select({ reservationId: hospReservationRooms.reservationId, roomId: hospReservationRooms.roomId, number: hospRooms.number, typeName: hospRoomTypes.name }).from(hospReservationRooms)
        .innerJoin(hospRoomTypes, eq(hospRoomTypes.id, hospReservationRooms.roomTypeId)).leftJoin(hospRooms, eq(hospRooms.id, hospReservationRooms.roomId)).where(inArray(hospReservationRooms.reservationId, rows.map((r) => r.id))) : [];
      return {
        items: rows.map((r) => ({
          ...reservationView(r, { contact: locationAllowed(a.guests, r.locationId) }),
          rooms: rr.filter((x) => x.reservationId === r.id).map((x) => ({ roomTypeName: x.typeName, roomNumber: x.number })),
          locationName: locs.find((l) => l.id === r.locationId)?.name ?? '',
        })),
      };
    });

    priv.post('/orgs/:orgId/hospitality/reservations', {
      schema: {
        tags: ['hospitality'], security: secured, params: orgParams, summary: 'Front-desk / phone booking (confirmed immediately; deposits are collected on the folio). Group bookings: several rooms + groupName.',
        body: z.object({ locationId: z.uuid(), arrival: isoDate, departure: isoDate, rooms: z.array(roomReq).min(1).max(40), guest, groupName: z.string().max(120).nullish(), arrivalTime: hhmm.nullish(), specialRequests: z.string().max(1000).nullish(), source: z.enum(RESERVATION_SOURCES).default('front_desk'), consent: z.object({ email: z.boolean(), sms: z.boolean() }).partial().optional() }),
      },
    }, async (req, reply) => {
      const loc = await loadLoc(req.params.orgId, req.body.locationId);
      need((await hospAccess(req, s.db, req.params.orgId)).opsWrite, loc.id, 'operations.write');
      const r = await createReservation(s, loc, { ...req.body, guest: { ...req.body.guest, phone: req.body.guest.phone ?? null } }, { actorUserId: req.user!.id, staff: true, ip: req.ip });
      const a = await hospAccess(req, s.db, req.params.orgId);
      return reply.code(201).send(await detail(a, r.reservation));
    });

    priv.get('/orgs/:orgId/hospitality/reservations/:id', { schema: { tags: ['hospitality'], security: secured, params: idParams } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const r = await loadRes(req.params.orgId, req.params.id);
      need(a.ops, r.locationId, 'operations.read');
      return detail(a, r);
    });

    priv.post('/orgs/:orgId/hospitality/reservations/:id/modify', {
      schema: { tags: ['hospitality'], security: secured, params: idParams, summary: 'Change dates/guests/room type/rate. New nights are secured before old ones are released; on failure nothing changes.', body: z.object({ arrival: isoDate, departure: isoDate, expectedTotalMinor: z.number().int().optional(), rooms: z.array(z.object({ id: z.uuid(), adults: z.number().int().min(1).max(20).optional(), children: z.number().int().min(0).max(20).optional(), roomTypeId: z.uuid().optional(), ratePlanId: z.uuid().optional() })).optional() }) },
    }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const r = await loadRes(req.params.orgId, req.params.id);
      need(a.opsWrite, r.locationId, 'operations.write');
      const out = await modifyReservation(s, await loadLoc(r.organizationId, r.locationId), r.id, req.body, { actorUserId: req.user!.id, staff: true });
      return { ...(await detail(a, out.reservation)), priceDifference: out.priceDifference, warnings: out.warnings };
    });

    priv.get('/orgs/:orgId/hospitality/reservations/:id/cancellation-quote', { schema: { tags: ['hospitality'], security: secured, params: idParams } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const r = await loadRes(req.params.orgId, req.params.id);
      need(a.ops, r.locationId, 'operations.read');
      return cancellationQuote(s.db, await loadLoc(r.organizationId, r.locationId), r);
    });

    priv.post('/orgs/:orgId/hospitality/reservations/:id/cancel', { schema: { tags: ['hospitality'], security: secured, params: idParams, body: z.object({ reason: z.string().max(300).nullish(), waiveFee: z.boolean().default(false) }) } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const r = await loadRes(req.params.orgId, req.params.id);
      need(a.opsWrite, r.locationId, 'operations.write');
      if (req.body.waiveFee) need(a.refunds, r.locationId, 'payments.refund');
      const out = await cancelReservation(s, await loadLoc(r.organizationId, r.locationId), r.id, { actorUserId: req.user!.id, reason: req.body.reason ?? null, waiveFee: req.body.waiveFee });
      return { ...(await detail(a, out.reservation)), fee: out.fee, refund: out.refund, refundState: out.refundState };
    });

    priv.post('/orgs/:orgId/hospitality/reservations/:id/no-show', { schema: { tags: ['hospitality'], security: secured, params: idParams, body: z.object({ waiveFee: z.boolean().default(false) }).default({ waiveFee: false }) } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const r = await loadRes(req.params.orgId, req.params.id);
      need(a.opsWrite, r.locationId, 'operations.write');
      if (req.body.waiveFee) need(a.refunds, r.locationId, 'payments.refund');
      const out = await markNoShow(s, await loadLoc(r.organizationId, r.locationId), r.id, { actorUserId: req.user!.id, waiveFee: req.body.waiveFee });
      return { ...(await detail(a, out.reservation)), fee: out.fee, refund: out.refund };
    });

    priv.post('/orgs/:orgId/hospitality/reservation-rooms/:id/assign', { schema: { tags: ['hospitality'], security: secured, params: idParams, body: z.object({ roomId: z.uuid(), bedId: z.uuid().nullish() }) } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const [rr] = await s.db.select({ locationId: hospReservations.locationId }).from(hospReservationRooms).innerJoin(hospReservations, eq(hospReservations.id, hospReservationRooms.reservationId)).where(and(eq(hospReservationRooms.id, req.params.id), eq(hospReservationRooms.organizationId, req.params.orgId)));
      if (!rr) throw notFound('Reservation room');
      need(a.opsWrite, rr.locationId, 'operations.write');
      return assignRoom(s, req.params.orgId, req.params.id, { roomId: req.body.roomId, bedId: req.body.bedId ?? null }, req.user!.id);
    });

    priv.put('/orgs/:orgId/hospitality/reservations/:id/registration', { schema: { tags: ['hospitality'], security: secured, params: idParams, body: z.object({ fields: z.record(z.string(), z.string().max(200)) }) } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const r = await loadRes(req.params.orgId, req.params.id);
      need(a.guests, r.locationId, 'customers.read');
      need(a.opsWrite, r.locationId, 'operations.write');
      const prop = await propertyFor(s.db, await loadLoc(r.organizationId, r.locationId));
      const registration = cleanRegistration(prop, { ...(r.registration ?? {}), ...req.body.fields }, { requireAll: false });
      const [u] = await s.db.update(hospReservations).set({ registration, updatedAt: new Date() }).where(eq(hospReservations.id, r.id)).returning();
      await audit(s.db, { organizationId: r.organizationId, ...actor(req), action: 'hospitality.registration.updated', scopeKind: 'location', scopeId: r.locationId, targetType: 'hosp_reservation', targetId: r.id, metadata: { fields: Object.keys(req.body.fields) } });
      return detail(a, u!);
    });

    priv.post('/orgs/:orgId/hospitality/reservations/:id/check-in', { schema: { tags: ['hospitality'], security: secured, params: idParams, body: z.object({ registration: z.record(z.string(), z.string().max(200)).optional() }).default({}) } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const r = await loadRes(req.params.orgId, req.params.id);
      need(a.opsWrite, r.locationId, 'operations.write');
      if (req.body.registration && Object.keys(req.body.registration).length) need(a.guests, r.locationId, 'customers.read');
      const u = await checkIn(s, await loadLoc(r.organizationId, r.locationId), r.id, { registration: req.body.registration }, { actorUserId: req.user!.id });
      return detail(a, u);
    });

    priv.post('/orgs/:orgId/hospitality/reservations/:id/check-out', { schema: { tags: ['hospitality'], security: secured, params: idParams } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const r = await loadRes(req.params.orgId, req.params.id);
      need(a.opsWrite, r.locationId, 'operations.write');
      return detail(a, await checkOut(s, await loadLoc(r.organizationId, r.locationId), r.id, { actorUserId: req.user!.id }));
    });

    priv.post('/orgs/:orgId/hospitality/reservations/:id/folio', {
      schema: { tags: ['hospitality'], security: secured, params: idParams, summary: 'Post an extra charge, adjustment, payment (card terminal, cash, transfer) or manual refund. Amounts are positive minor units; payments reduce the balance.', body: z.object({ kind: z.enum(['extra', 'adjustment', 'payment', 'refund']), description: z.string().min(1).max(200), amountMinor: z.number().int().refine((v) => v !== 0, 'Not zero'), method: z.enum(['card_terminal', 'cash', 'bank_transfer', 'other']).nullish(), serviceDate: isoDate.nullish() }) },
    }, async (req, reply) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const r = await loadRes(req.params.orgId, req.params.id);
      need(a.opsWrite, r.locationId, 'operations.write');
      if (req.body.kind === 'refund' || (req.body.kind === 'adjustment' && req.body.amountMinor < 0)) need(a.refunds, r.locationId, 'payments.refund');
      if (req.body.kind === 'payment' && !req.body.method) throw validationError('Choose how the guest paid', { method: 'Required' });
      await postFolioLine(s, r, { ...req.body, method: req.body.method ?? null, serviceDate: req.body.serviceDate ?? null }, req.user!.id);
      return reply.code(201).send(await folioView(s.db, r));
    });

    // ───────── Grid ─────────
    priv.get('/orgs/:orgId/hospitality/grid', { schema: { tags: ['hospitality'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid(), from: isoDate.optional(), nights: z.coerce.number().int().min(1).max(31).default(14) }) } }, async (req) => {
      const loc = await loadLoc(req.params.orgId, req.query.locationId);
      need((await hospAccess(req, s.db, req.params.orgId)).ops, loc.id, 'operations.read');
      await expireHolds(s, loc.id);
      return roomGrid(s.db, loc, req.query.from ?? addDaysIso(localToday(loc), -1), req.query.nights);
    });

    // ───────── Housekeeping ─────────
    priv.get('/orgs/:orgId/hospitality/housekeeping', { schema: { tags: ['hospitality'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid(), date: isoDate.optional() }) } }, async (req) => {
      const loc = await loadLoc(req.params.orgId, req.query.locationId);
      need((await hospAccess(req, s.db, req.params.orgId)).ops, loc.id, 'operations.read');
      const date = req.query.date ?? localToday(loc);
      await generateTasks(s.db, loc, date);
      const staff = await s.db.selectDistinct({ id: users.id, name: users.name }).from(users)
        .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
        .where(and(eq(roleAssignments.organizationId, loc.organizationId), or(and(eq(roleAssignments.scopeKind, 'location'), eq(roleAssignments.scopeId, loc.id)), eq(roleAssignments.scopeKind, 'organization')), inArray(roleAssignments.role, ['staff', 'location_manager', 'franchise_owner', 'org_owner']), or(isNull(roleAssignments.expiresAt), gte(roleAssignments.expiresAt, new Date()))));
      return { ...(await housekeepingBoard(s.db, loc, date)), staff };
    });

    priv.post('/orgs/:orgId/hospitality/housekeeping/tasks', {
      schema: { tags: ['hospitality'], security: secured, params: orgParams, summary: 'Add a task (e.g. maintenance issue or inspection); optionally take the room out of order', body: z.object({ roomId: z.uuid(), date: isoDate.optional(), kind: z.enum(HK_TASK_KINDS), notes: z.string().max(1000).nullish(), assigneeUserId: z.uuid().nullish(), priority: z.number().int().min(0).max(3).default(0), outOfOrderUntil: isoDate.nullish() }) },
    }, async (req, reply) => {
      const [room] = await s.db.select().from(hospRooms).where(and(eq(hospRooms.id, req.body.roomId), eq(hospRooms.organizationId, req.params.orgId)));
      if (!room) throw notFound('Room');
      const loc = await loadLoc(req.params.orgId, room.locationId);
      need((await hospAccess(req, s.db, req.params.orgId)).opsWrite, loc.id, 'operations.write');
      if (req.body.outOfOrderUntil) await setRoomStatus(s, loc, room.id, 'out_of_order', { reason: req.body.notes ?? 'Maintenance', until: req.body.outOfOrderUntil }, req.user!.id);
      try {
        const [t] = await s.db.insert(hospHkTasks).values({ organizationId: req.params.orgId, locationId: loc.id, roomId: room.id, date: req.body.date ?? localToday(loc), kind: req.body.kind, notes: req.body.notes ?? null, assigneeUserId: req.body.assigneeUserId ?? null, priority: req.body.priority, createdBy: req.user!.id }).returning();
        return reply.code(201).send(serializeTask(t!, room.number, null));
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('task_exists', 'This room already has that task for the day');
        throw err;
      }
    });

    priv.patch('/orgs/:orgId/hospitality/housekeeping/tasks/:id', { schema: { tags: ['hospitality'], security: secured, params: idParams, body: z.object({ status: z.enum(HK_TASK_STATUSES), assigneeUserId: z.uuid().nullable(), notes: z.string().max(1000).nullable() }).partial() } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const t = await updateTask(s, req.params.orgId, req.params.id, req.body, req.user!.id, (locId) => locationAllowed(a.opsWrite, locId));
      const [room] = await s.db.select().from(hospRooms).where(eq(hospRooms.id, t.roomId));
      return serializeTask(t, room?.number ?? '', null);
    });

    priv.get('/orgs/:orgId/hospitality/housekeeping/my-tasks', { schema: { tags: ['hospitality'], security: secured, params: orgParams, summary: 'Staff app: my tasks today and unassigned tasks at my properties' } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const locs = await visibleLocs(req.params.orgId, a.ops);
      const out = [];
      for (const loc of locs) {
        const date = localToday(loc);
        await generateTasks(s.db, loc, date);
        const rows = await s.db.select({ t: hospHkTasks, number: hospRooms.number, status: hospRooms.hkStatus }).from(hospHkTasks).innerJoin(hospRooms, eq(hospRooms.id, hospHkTasks.roomId))
          .where(and(eq(hospHkTasks.locationId, loc.id), eq(hospHkTasks.date, date), or(eq(hospHkTasks.assigneeUserId, req.user!.id), isNull(hospHkTasks.assigneeUserId))!)).orderBy(desc(hospHkTasks.priority), asc(hospRooms.number));
        out.push(...rows.map((x) => ({ ...serializeTask(x.t, x.number, null), roomStatus: x.status, mine: x.t.assigneeUserId === req.user!.id, locationName: loc.name })));
      }
      return { items: out };
    });

    // ───────── Outlet ─────────
    priv.get('/orgs/:orgId/hospitality/outlet/:locationId', { schema: { tags: ['hospitality'], security: secured, params: locParams, summary: 'Outlet menu (Foods engine) and in-house guests for charge-to-room' } }, async (req) => {
      const loc = await loadLoc(req.params.orgId, req.params.locationId);
      need((await hospAccess(req, s.db, req.params.orgId)).ops, loc.id, 'operations.read');
      return { ...(await outletMenu(s, loc)), inHouse: await inHouseGuests(s.db, loc) };
    });
    priv.post('/orgs/:orgId/hospitality/outlet/:locationId/room-charges', {
      schema: { tags: ['hospitality'], security: secured, params: locParams, body: z.object({ reservationId: z.uuid(), lines: z.array(z.object({ menuItemId: z.uuid(), quantity: z.number().int().min(1).max(50), modifierIds: z.array(z.uuid()).default([]), notes: z.string().max(200).optional() })).min(1).max(50), notes: z.string().max(500).nullish() }) },
    }, async (req, reply) => {
      const loc = await loadLoc(req.params.orgId, req.params.locationId);
      need((await hospAccess(req, s.db, req.params.orgId)).opsWrite, loc.id, 'operations.write');
      const out = await chargeToRoom(s, loc, { reservationId: req.body.reservationId, lines: req.body.lines, notes: req.body.notes ?? null }, req.user!.id);
      return reply.code(201).send({ order: { id: out.order.id, orderNumber: out.order.orderNumber, status: out.order.status, total: m(out.order.totalMinor, out.order.currency) }, folioLine: { id: out.folioLine.id, amount: m(out.folioLine.amountMinor, out.folioLine.currency) } });
    });

    // ───────── Reports & pulse ─────────
    priv.get('/orgs/:orgId/hospitality/reports', { schema: { tags: ['hospitality'], security: secured, params: orgParams, querystring: z.object({ from: isoDate, to: isoDate, locationId: z.uuid().optional(), pickupDays: z.coerce.number().int().min(1).max(90).default(14) }) } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const locs = await visibleLocs(req.params.orgId, a.reports, req.query.locationId);
      const props = locs.length ? await s.db.select({ id: hospProperties.locationId }).from(hospProperties).where(inArray(hospProperties.locationId, locs.map((l) => l.id))) : [];
      return hospitalityReport(s.db, locs.filter((l) => props.some((p) => p.id === l.id)), req.query.from, req.query.to, req.query.pickupDays);
    });
    priv.get('/orgs/:orgId/hospitality/pulse', { schema: { tags: ['hospitality'], security: secured, params: orgParams } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const all = await visibleLocs(req.params.orgId, 'all');
      const locs = all.filter((l) => locationAllowed(a.ops, l.id) || locationAllowed(a.reports, l.id));
      const props = locs.length ? await s.db.select({ id: hospProperties.locationId }).from(hospProperties).where(inArray(hospProperties.locationId, locs.map((l) => l.id))) : [];
      const items = await pulse(s.db, locs.filter((l) => props.some((p) => p.id === l.id)));
      return { items, generatedAt: new Date().toISOString() };
    });

    // ───────── Channel managers (sandbox) ─────────
    priv.get('/orgs/:orgId/hospitality/channels', { schema: { tags: ['hospitality'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }) } }, async (req) => {
      const a = await hospAccess(req, s.db, req.params.orgId);
      const locs = await visibleLocs(req.params.orgId, a.config, req.query.locationId);
      const exportsRows = locs.length ? await s.db.select().from(hospChannelExports).where(inArray(hospChannelExports.locationId, locs.map((l) => l.id))).orderBy(desc(hospChannelExports.createdAt)).limit(20) : [];
      return {
        mode: 'sandbox', notice: 'Sandbox only — availability and rates are previewed and recorded here; nothing is sent to any channel manager.',
        providers: CHANNEL_PROVIDERS.map((p) => ({ provider: p, name: CHANNEL_ADAPTERS[p].name, mode: 'sandbox' })),
        exports: exportsRows.map((e) => ({ id: e.id, locationId: e.locationId, provider: e.provider, kind: e.kind, createdAt: e.createdAt.toISOString() })),
      };
    });
    priv.post('/orgs/:orgId/hospitality/channels/:provider/preview', {
      schema: { tags: ['hospitality'], security: secured, params: z.object({ orgId: z.uuid(), provider: z.enum(CHANNEL_PROVIDERS as [string, ...string[]]) }), body: z.object({ locationId: z.uuid(), from: isoDate, nights: z.number().int().min(1).max(31).default(7), record: z.boolean().default(false) }) },
    }, async (req) => {
      const loc = await loadLoc(req.params.orgId, req.body.locationId);
      need((await hospAccess(req, s.db, req.params.orgId)).config, loc.id, 'locations.write');
      const dates = Array.from({ length: req.body.nights }, (_, i) => addDaysIso(req.body.from, i));
      const ctx = await rateContext(s.db, loc.id);
      const daily = await dailyRowsFor(s.db, ctx.plans.map((p) => p.id), dates[0]!, dates[dates.length - 1]!);
      const inv = await availabilityMatrix(s.db, ctx.roomTypes.map((t) => t.id), dates);
      const seasons = ctx.seasons.map((x) => ({ id: x.id, startDate: x.startDate, endDate: x.endDate, priority: x.priority }));
      const days: AriDay[] = ctx.roomTypes.filter((t) => t.active).flatMap((t) => ctx.plans.filter((p) => p.active).flatMap((p) => dates.map((d) => {
        const src = p.derivedFromId ?? p.id;
        const np = nightlyPrice(d, ctx.prices.filter((x) => x.ratePlanId === src && x.roomTypeId === t.id), seasons, daily.filter((x) => x.ratePlanId === src && x.roomTypeId === t.id));
        const r = daily.find((x) => x.ratePlanId === p.id && x.roomTypeId === t.id && x.date === d);
        return { roomTypeCode: t.code, ratePlanCode: p.code, date: d, available: inv.get(t.id)!.get(d)!.available, amountMinor: np ? (p.derivedFromId && p.adjustmentBps ? Math.round((np.amountMinor * (10_000 + p.adjustmentBps)) / 10_000) : np.amountMinor) : null, currency: loc.currency, minStay: r?.minStay ?? p.minStay, maxStay: r?.maxStay ?? p.maxStay, closed: r?.closed ?? false, closedToArrival: r?.closedToArrival ?? false, closedToDeparture: r?.closedToDeparture ?? false };
      })));
      const payload = CHANNEL_ADAPTERS[req.params.provider as keyof typeof CHANNEL_ADAPTERS].buildAriPayload(loc.code, days);
      if (req.body.record) await s.db.insert(hospChannelExports).values({ organizationId: req.params.orgId, locationId: loc.id, provider: req.params.provider, kind: 'ari', payload, createdBy: req.user!.id });
      return { mode: 'sandbox', sent: false, provider: req.params.provider, days: days.length, payload };
    });
  });
};

void lte;

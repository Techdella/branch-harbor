import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { locations, pickupSettings, pickupSlots } from '../db/schema/index.ts';
import { forbidden, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requireLocationPerm } from '../services/authz.ts';
import { configOf, DEFAULT_PICKUP, loadPickupSettings, syncPickupSlots, type PickupSettingsRow } from '../services/pickup.ts';
import { orgParams, secured } from './_common.ts';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const settingsBody = z.object({
  hours: z.array(z.object({ weekday: z.number().int().min(0).max(6), open: hhmm, close: hhmm })).max(21),
  slotMinutes: z.number().int().min(5).max(120),
  slotCapacity: z.number().int().min(1).max(500),
  prepBufferMinutes: z.number().int().min(0).max(1440),
  cutoffMinutes: z.number().int().min(0).max(1440),
  horizonDays: z.number().int().min(1).max(14),
  closedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366).default([]),
  acceptingOrders: z.boolean().default(true),
});

function view(loc: typeof locations.$inferSelect, row: PickupSettingsRow | null) {
  const c = configOf(row);
  return {
    locationId: loc.id, location: { id: loc.id, name: loc.name, timeZone: loc.timeZone, currency: loc.currency },
    configured: !!row, ...c, updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export const pickupSettingsRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  const requireManager = async (req: FastifyRequest, orgId: string, locationId: string) => {
    const loc = await requireLocationPerm(req, s.db, orgId, locationId, 'operations.write');
    if (!(await hasPerm(req, s.db, 'locations.read', { organizationId: orgId, kind: 'location', id: locationId }))) throw forbidden('Only a manager can change pickup settings');
    return loc;
  };

  app.get('/orgs/:orgId/foods/pickup-settings', {
    schema: { tags: ['foods'], security: secured, params: orgParams, summary: 'Pickup settings for every authorised location, with the next 24h of slot capacity' },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
    const locs = (await s.db.select().from(locations).where(eq(locations.organizationId, orgId))).filter((l) => !l.archivedAt && (allowed === 'all' || allowed.has(l.id)));
    if (!locs.length) return { items: [] };
    const rows = await s.db.select().from(pickupSettings).where(inArray(pickupSettings.locationId, locs.map((l) => l.id)));
    const now = new Date();
    const slots = await s.db.select().from(pickupSlots).where(and(inArray(pickupSlots.locationId, locs.map((l) => l.id)), gt(pickupSlots.cutoffAt, now), lt(pickupSlots.startsAt, new Date(now.getTime() + 86400_000))));
    return {
      items: locs.map((l) => {
        const own = slots.filter((x) => x.locationId === l.id);
        return { ...view(l, rows.find((r) => r.locationId === l.id) ?? null), next24h: { slots: own.length, capacity: own.reduce((a, x) => a + x.capacity, 0), booked: own.reduce((a, x) => a + x.booked, 0) } };
      }),
    };
  });

  app.get('/orgs/:orgId/foods/locations/:locationId/pickup-settings', {
    schema: { tags: ['foods'], security: secured, params: orgParams.extend({ locationId: z.uuid() }) },
  }, async (req) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    const row = await loadPickupSettings(s.db, loc.id);
    const upcoming = await s.db.select().from(pickupSlots).where(and(eq(pickupSlots.locationId, loc.id), gt(pickupSlots.startsAt, new Date()))).orderBy(asc(pickupSlots.startsAt)).limit(200);
    return { ...view(loc, row), defaults: DEFAULT_PICKUP, upcomingSlots: upcoming.map((x) => ({ id: x.id, startsAt: x.startsAt.toISOString(), endsAt: x.endsAt.toISOString(), cutoffAt: x.cutoffAt.toISOString(), capacity: x.capacity, booked: x.booked })) };
  });

  app.put('/orgs/:orgId/foods/locations/:locationId/pickup-settings', {
    schema: {
      tags: ['foods'], security: secured, params: orgParams.extend({ locationId: z.uuid() }), body: settingsBody,
      summary: 'Save pickup hours, cut-off, preparation buffer and slot capacity; future slots are regenerated (booked slots are kept)',
    },
  }, async (req) => {
    const { orgId, locationId } = req.params;
    const loc = await requireManager(req, orgId, locationId);
    const b = req.body;
    const fields: Record<string, string> = {};
    b.hours.forEach((h, i) => { if (h.close <= h.open) fields[`hours.${i}.close`] = 'Closing time must be after opening time'; });
    if (Object.keys(fields).length) throw validationError('Check the pickup hours', fields);
    const values = { organizationId: orgId, locationId: loc.id, ...b, updatedBy: req.user!.id, updatedAt: new Date() };
    const out = await s.db.transaction(async (tx) => {
      const [row] = await tx.insert(pickupSettings).values(values).onConflictDoUpdate({ target: pickupSettings.locationId, set: values }).returning();
      const result = await syncPickupSlots(tx, loc, configOf(row!));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'pickup_settings.updated', scopeKind: 'location', scopeId: loc.id, targetType: 'location', targetId: loc.id, metadata: { ...b, slots: result } });
      return { row: row!, result };
    });
    return { ...view(loc, out.row), slots: out.result };
  });

  app.post('/orgs/:orgId/foods/locations/:locationId/pickup-slots/generate', {
    schema: { tags: ['foods'], security: secured, params: orgParams.extend({ locationId: z.uuid() }), summary: 'Regenerate future pickup slots from the saved settings' },
  }, async (req) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.write');
    const row = await loadPickupSettings(s.db, loc.id);
    if (!row) throw validationError('Save pickup settings for this location first', { locationId: 'No pickup settings' });
    return syncPickupSlots(s.db, loc, configOf(row));
  });
};

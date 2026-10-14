import { and, asc, desc, eq, gte, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { currency } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import type { Permission } from '@bh/shared';
import {
  classBookings, classOccurrences, classSeries, classTypes, consentRecords, customers, instructorAvailability, locations, memberships, membershipInvoices, onlineAccessGrants, onlineContent,
  packs, roleAssignments, studioAiProposals, studioCustomerNotifications, studioFees, studioMembershipPlans, studioPackProducts, studioPolicies, studioPurchases, studioRooms, users, waitlistEntries,
} from '../db/schema/index.ts';
import { AppError, conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { recordAttendance } from '../services/studios.ts';
import {
  cancelMembership, chargeRenewalSandbox, createPurchase, grantCredits, invoicesFor, pauseMembership, resumeMembership, serializeMembership, serializePack, serializePurchase,
} from '../services/studios-commerce.ts';
import { describePolicy, effectivePolicy, entitlementOptions, membershipUsage } from '../services/studios-entitlements.ts';
import { attendanceSummary, draftClassDescription, followUpAudiences, studioReports } from '../services/studios-insights.ts';
import { serializeContent } from '../services/studios-online.ts';
import { applyEdit, createSeries, editPreview, findConflicts, previewSeries, publishSeries, serializeSeries, seriesStats } from '../services/studios-schedule.ts';
import { studioBilling } from '../integrations/studio-billing.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const accessPolicy = z.enum(['home_only', 'any_location', 'same_currency', 'listed']);
const prices = z.partialRecord(currency, z.number().int().min(0));
const tags = ['studios'];

const recurrenceSchema = z.object({
  freq: z.literal('WEEKLY').default('WEEKLY'),
  interval: z.number().int().min(1).max(8).default(1),
  byWeekday: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  time: hhmm,
  startDate: ymd,
  untilDate: ymd.nullable().default(null),
  count: z.number().int().min(1).max(750).nullable().default(null),
  skipDates: z.array(ymd).max(200).default([]),
});

const seriesBody = z.object({
  locationId: z.uuid(), classTypeId: z.uuid(), recurrence: recurrenceSchema,
  durationMinutes: z.number().int().min(5).max(600).optional(), instructorUserId: z.uuid().nullable().optional(), instructorName: z.string().max(120).nullable().optional(),
  roomId: z.uuid().nullable().optional(), capacity: z.number().int().min(1).max(1000).optional(), priceMinor: z.number().int().min(0).default(0), creditCost: z.number().int().min(0).max(20).optional(),
  allowCredits: z.boolean().default(true), allowMembership: z.boolean().default(true), online: z.boolean().default(false),
});

const changesSchema = z.object({
  time: hhmm.optional(), weekday: z.number().int().min(0).max(6).optional(), durationMinutes: z.number().int().min(5).max(600).optional(),
  instructorUserId: z.uuid().nullable().optional(), instructorName: z.string().max(120).nullable().optional(), roomId: z.uuid().nullable().optional(),
  capacity: z.number().int().min(1).max(1000).optional(), priceMinor: z.number().int().min(0).optional(), creditCost: z.number().int().min(0).max(20).optional(),
  online: z.boolean().optional(), cancel: z.boolean().optional(),
}).refine((c) => Object.keys(c).length > 0, { message: 'Choose at least one change' });

const strip = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_'))) as T;

export const studioAdminRoutes: FastifyPluginAsyncZod = async (_app) => {
  const app = _app.withTypeProvider<ZodTypeProvider>();
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  /** Location ids in scope for a permission, optionally narrowed to one location. */
  const scopeLocs = async (req: FastifyRequest, orgId: string, perm: Permission, locationId?: string | null): Promise<string[]> => {
    const allowed = await authorisedLocations(req, s.db, orgId, perm);
    const all = (await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt)))).map((l) => l.id);
    const ids = allowed === 'all' ? all : all.filter((id) => allowed.has(id));
    if (allowed !== 'all' && allowed.size === 0) throw forbidden(`Missing permission ${perm} in this organisation`);
    if (locationId) {
      if (!ids.includes(locationId)) throw forbidden(`Missing permission ${perm} for this location`);
      return [locationId];
    }
    return ids;
  };
  const loadOcc = async (orgId: string, id: string) => {
    const [o] = await s.db.select().from(classOccurrences).where(and(eq(classOccurrences.id, id), eq(classOccurrences.organizationId, orgId)));
    if (!o) throw notFound('Class');
    return o;
  };
  const editScope = (orgId: string, locationId: string | null | undefined) => (locationId ? { organizationId: orgId, kind: 'location' as const, id: locationId } : { organizationId: orgId, kind: 'organization' as const, id: orgId });

  // ───────── Rooms ─────────
  app.get('/orgs/:orgId/studios/rooms', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }), summary: 'Rooms per location' } }, async (req) => {
    const ids = await scopeLocs(req, req.params.orgId, 'operations.read', req.query.locationId);
    const rows = ids.length ? await s.db.select().from(studioRooms).where(and(eq(studioRooms.organizationId, req.params.orgId), inArray(studioRooms.locationId, ids))).orderBy(asc(studioRooms.name)) : [];
    const upcoming = rows.length ? await s.db.select({ roomId: classOccurrences.roomId, n: sql<number>`count(*)::int` }).from(classOccurrences).where(and(inArray(classOccurrences.roomId, rows.map((r) => r.id)), eq(classOccurrences.status, 'scheduled'), gte(classOccurrences.startsAt, new Date()))).groupBy(classOccurrences.roomId) : [];
    return { items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), upcomingClasses: upcoming.find((u) => u.roomId === r.id)?.n ?? 0 })) };
  });
  app.post('/orgs/:orgId/studios/rooms', { schema: { tags, security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), name: z.string().trim().min(1).max(80), capacity: z.number().int().min(1).max(1000), features: z.array(z.string().max(60)).max(20).default([]) }) } }, async (req, reply) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'operations.write');
    const [dupe] = await s.db.select({ id: studioRooms.id }).from(studioRooms).where(and(eq(studioRooms.locationId, req.body.locationId), sql`lower(${studioRooms.name}) = ${req.body.name.toLowerCase()}`));
    if (dupe) throw validationError('A room with this name already exists here', { name: 'Already used' });
    const [r] = await s.db.insert(studioRooms).values({ organizationId: req.params.orgId, ...req.body }).returning();
    await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'room.created', scopeKind: 'location', scopeId: r!.locationId, targetType: 'studio_room', targetId: r!.id });
    return reply.code(201).send(r);
  });
  app.patch('/orgs/:orgId/studios/rooms/:id', { schema: { tags, security: secured, params: idParams, body: z.object({ name: z.string().trim().min(1).max(80).optional(), capacity: z.number().int().min(1).max(1000).optional(), features: z.array(z.string().max(60)).max(20).optional(), active: z.boolean().optional() }) } }, async (req) => {
    const [r] = await s.db.select().from(studioRooms).where(and(eq(studioRooms.id, req.params.id), eq(studioRooms.organizationId, req.params.orgId)));
    if (!r) throw notFound('Room');
    await requireLocationPerm(req, s.db, r.organizationId, r.locationId, 'operations.write');
    const [u] = await s.db.update(studioRooms).set({ ...req.body, updatedAt: new Date() }).where(eq(studioRooms.id, r.id)).returning();
    if (req.body.name && req.body.name !== r.name) await s.db.update(classOccurrences).set({ room: req.body.name }).where(and(eq(classOccurrences.roomId, r.id), gte(classOccurrences.startsAt, new Date())));
    return u;
  });

  // ───────── Class types ─────────
  app.patch('/orgs/:orgId/studios/class-types/:id', {
    schema: { tags, security: secured, params: idParams, summary: 'Edit a class type (e.g. save an approved description draft)', body: z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(4000).nullable().optional(), durationMinutes: z.number().int().min(5).max(600).optional(), defaultCapacity: z.number().int().min(1).max(1000).optional(), creditCost: z.number().int().min(0).max(20).optional(), category: z.string().max(40).nullable().optional(), level: z.enum(['all_levels', 'beginner', 'intermediate', 'advanced']).nullable().optional(), archived: z.boolean().optional() }) },
  }, async (req) => {
    const [ct] = await s.db.select().from(classTypes).where(and(eq(classTypes.id, req.params.id), eq(classTypes.organizationId, req.params.orgId)));
    if (!ct) throw notFound('Class type');
    if (ct.locationId) await requireLocationPerm(req, s.db, ct.organizationId, ct.locationId, 'operations.write');
    else await requirePerm(req, s.db, 'templates.write', editScope(ct.organizationId, null));
    const { archived, ...rest } = req.body;
    const [u] = await s.db.update(classTypes).set({ ...rest, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) }).where(eq(classTypes.id, ct.id)).returning();
    await audit(s.db, { organizationId: ct.organizationId, ...actor(req), action: 'class_type.updated', targetType: 'class_type', targetId: ct.id, metadata: { fields: Object.keys(req.body) } });
    return u;
  });

  // ───────── Instructors (people who can teach at a location) ─────────
  app.get('/orgs/:orgId/studios/instructors', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }), summary: 'Staff who can teach (operations access) at the location, with availability rules' } }, async (req) => {
    const ids = await scopeLocs(req, req.params.orgId, 'operations.read', req.query.locationId);
    const rows = await s.db.select({ userId: roleAssignments.userId, role: roleAssignments.role, scopeKind: roleAssignments.scopeKind, scopeId: roleAssignments.scopeId, name: users.name, email: users.email })
      .from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId)).where(and(eq(roleAssignments.organizationId, req.params.orgId), isNull(users.deletedAt)));
    const locs = await s.db.select({ id: locations.id, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId }).from(locations).where(inArray(locations.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000']));
    const covers = (r: typeof rows[number]) => r.scopeKind === 'organization' || locs.some((l) => (r.scopeKind === 'location' && l.id === r.scopeId) || (r.scopeKind === 'region' && l.regionId === r.scopeId) || (r.scopeKind === 'owner_group' && l.ownerGroupId === r.scopeId));
    const teach = new Map<string, { userId: string; name: string; roles: string[] }>();
    for (const r of rows.filter((x) => ['staff', 'location_manager', 'franchise_owner', 'org_owner'].includes(x.role) && covers(x))) {
      const t = teach.get(r.userId) ?? { userId: r.userId, name: r.name, roles: [] };
      t.roles.push(r.role);
      teach.set(r.userId, t);
    }
    const av = teach.size ? await s.db.select().from(instructorAvailability).where(and(eq(instructorAvailability.organizationId, req.params.orgId), inArray(instructorAvailability.userId, [...teach.keys()]))) : [];
    return { items: [...teach.values()].sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ ...t, availability: av.filter((a) => a.userId === t.userId).map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })) })) };
  });

  // ───────── Instructor availability ─────────
  app.post('/orgs/:orgId/studios/availability', {
    schema: { tags, security: secured, params: orgParams, summary: 'Add an availability rule (weekly or one date). Instructors may manage their own; managers anyone at their location.', body: z.object({ userId: z.uuid().optional(), locationId: z.uuid().nullable().default(null), kind: z.enum(['available', 'unavailable']).default('available'), weekday: z.number().int().min(0).max(6).nullable().default(null), onDate: ymd.nullable().default(null), startTime: hhmm, endTime: hhmm, note: z.string().max(200).optional() }) },
  }, async (req, reply) => {
    const me = requireUser(req);
    const b = req.body;
    const userId = b.userId ?? me.id;
    if ((b.weekday === null) === (b.onDate === null)) throw validationError('Give either a weekday or a date', { weekday: 'Weekday or date' });
    if (b.endTime <= b.startTime) throw validationError('End must be after start', { endTime: 'Invalid' });
    const locId = b.locationId;
    if (userId !== me.id) {
      if (locId) await requireLocationPerm(req, s.db, req.params.orgId, locId, 'locations.read');
      else await requirePerm(req, s.db, 'members.manage', editScope(req.params.orgId, null));
    } else if (locId) await requireLocationPerm(req, s.db, req.params.orgId, locId, 'operations.read');
    else await scopeLocs(req, req.params.orgId, 'operations.read');
    const [loc] = locId ? await s.db.select({ tz: locations.timeZone }).from(locations).where(eq(locations.id, locId)) : [];
    const [org] = await s.db.select({ tz: sql<string>`default_time_zone` }).from(sql`organizations`).where(sql`id = ${req.params.orgId}`);
    const [row] = await s.db.insert(instructorAvailability).values({ organizationId: req.params.orgId, locationId: locId, userId, kind: b.kind, weekday: b.weekday, onDate: b.onDate, startTime: b.startTime, endTime: b.endTime, timeZone: loc?.tz ?? org?.tz ?? 'UTC', note: b.note ?? null }).returning();
    return reply.code(201).send(row);
  });
  app.get('/orgs/:orgId/studios/availability', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ userId: z.uuid().optional() }) } }, async (req) => {
    const me = requireUser(req);
    await scopeLocs(req, req.params.orgId, 'operations.read');
    const rows = await s.db.select({ a: instructorAvailability, name: users.name }).from(instructorAvailability).innerJoin(users, eq(users.id, instructorAvailability.userId))
      .where(and(eq(instructorAvailability.organizationId, req.params.orgId), eq(instructorAvailability.userId, req.query.userId ?? me.id)));
    return { items: rows.map((r) => ({ ...r.a, name: r.name, createdAt: r.a.createdAt.toISOString() })) };
  });
  app.delete('/orgs/:orgId/studios/availability/:id', { schema: { tags, security: secured, params: idParams } }, async (req, reply) => {
    const me = requireUser(req);
    const [a] = await s.db.select().from(instructorAvailability).where(and(eq(instructorAvailability.id, req.params.id), eq(instructorAvailability.organizationId, req.params.orgId)));
    if (!a) throw notFound('Availability rule');
    if (a.userId !== me.id) {
      if (a.locationId) await requireLocationPerm(req, s.db, a.organizationId, a.locationId, 'locations.read');
      else await requirePerm(req, s.db, 'members.manage', editScope(a.organizationId, null));
    }
    await s.db.delete(instructorAvailability).where(eq(instructorAvailability.id, a.id));
    return reply.code(204).send(null);
  });

  // ───────── Series: preview → create/publish ─────────
  app.post('/orgs/:orgId/studios/series/preview', { schema: { tags, security: secured, params: orgParams, body: seriesBody, summary: 'Preview a recurring schedule: every occurrence in local and UTC time, DST changes and clashes' } }, async (req) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'operations.write');
    return strip(await previewSeries(s.db, req.params.orgId, loc, req.body));
  });
  app.post('/orgs/:orgId/studios/series', { schema: { tags, security: secured, params: orgParams, body: seriesBody.extend({ publish: z.boolean().default(false), allowConflicts: z.boolean().default(false) }), summary: 'Create a series as a draft or publish it (generates the classes)' } }, async (req, reply) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'operations.write');
    const { publish, allowConflicts, ...input } = req.body;
    const r = await createSeries(s, req.params.orgId, loc, input, { publish, actorUserId: req.user!.id, allowConflicts });
    return reply.code(201).send({ series: serializeSeries(r.series), generated: r.generated });
  });
  app.get('/orgs/:orgId/studios/series', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), status: z.enum(['draft', 'published', 'ended']).optional() }) } }, async (req) => {
    const ids = await scopeLocs(req, req.params.orgId, 'operations.read', req.query.locationId);
    if (!ids.length) return { items: [] };
    const rows = await s.db.select({ sr: classSeries, name: classTypes.name, loc: locations.name }).from(classSeries).innerJoin(classTypes, eq(classTypes.id, classSeries.classTypeId)).innerJoin(locations, eq(locations.id, classSeries.locationId))
      .where(and(eq(classSeries.organizationId, req.params.orgId), inArray(classSeries.locationId, ids), req.query.status ? eq(classSeries.status, req.query.status) : sql`true`)).orderBy(desc(classSeries.createdAt));
    const stats = await seriesStats(s.db, rows.map((r) => r.sr.id));
    return { items: rows.map((r) => serializeSeries(r.sr, { className: r.name, locationName: r.loc, upcoming: stats.get(r.sr.id)?.upcoming ?? 0, bookings: stats.get(r.sr.id)?.bookings ?? 0 })) };
  });
  const loadSeries = async (orgId: string, id: string) => {
    const [sr] = await s.db.select().from(classSeries).where(and(eq(classSeries.id, id), eq(classSeries.organizationId, orgId)));
    if (!sr) throw notFound('Series');
    return sr;
  };
  app.get('/orgs/:orgId/studios/series/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const sr = await loadSeries(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, sr.organizationId, sr.locationId, 'operations.read');
    const occ = await s.db.select().from(classOccurrences).where(and(eq(classOccurrences.seriesId, sr.id), gte(classOccurrences.startsAt, new Date(Date.now() - 7 * 86400_000)))).orderBy(asc(classOccurrences.startsAt)).limit(120);
    const [ct] = await s.db.select({ name: classTypes.name }).from(classTypes).where(eq(classTypes.id, sr.classTypeId));
    const stats = await seriesStats(s.db, [sr.id]);
    return { ...serializeSeries(sr, { className: ct?.name, upcoming: stats.get(sr.id)?.upcoming ?? 0, bookings: stats.get(sr.id)?.bookings ?? 0 }), occurrences: occ.map((o) => ({ id: o.id, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(), status: o.status, detached: o.detached, instructorName: o.instructorName, room: o.room, capacity: o.capacity })) };
  });
  app.post('/orgs/:orgId/studios/series/:id/publish', { schema: { tags, security: secured, params: idParams, body: z.object({ allowConflicts: z.boolean().default(false) }) } }, async (req) => {
    const sr = await loadSeries(req.params.orgId, req.params.id);
    const loc = await requireLocationPerm(req, s.db, sr.organizationId, sr.locationId, 'operations.write');
    const r = await publishSeries(s, sr, loc, { actorUserId: req.user!.id, allowConflicts: req.body.allowConflicts });
    return { series: serializeSeries(r.series), generated: r.generated };
  });

  // ───────── Edit one / following / series ─────────
  const editBody = z.object({ scope: z.enum(['one', 'following', 'series']), changes: changesSchema });
  app.post('/orgs/:orgId/studios/occurrences/:id/edit-preview', { schema: { tags, security: secured, params: idParams, body: editBody, summary: 'Which classes and bookings a change affects, before applying it' } }, async (req) => {
    const o = await loadOcc(req.params.orgId, req.params.id);
    const loc = await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.write');
    return strip(await editPreview(s.db, o, loc, req.body.scope, req.body.changes));
  });
  app.post('/orgs/:orgId/studios/occurrences/:id/edit', {
    schema: { tags, security: secured, params: idParams, body: editBody.extend({ notify: z.boolean().default(true), reason: z.string().max(300).optional(), allowConflicts: z.boolean().default(false), allowOverCapacity: z.boolean().default(false) }), summary: 'Apply a change (or cancellation) to one class, this and following, or the whole series; affected customers are notified (consent-aware)' },
  }, async (req) => {
    const o = await loadOcc(req.params.orgId, req.params.id);
    const loc = await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.write');
    if (o.status !== 'scheduled') throw conflict('class_cancelled', 'This class is cancelled');
    return applyEdit(s, o, loc, req.body.scope, req.body.changes, { actorUserId: req.user!.id, notify: req.body.notify, reason: req.body.reason, allowConflicts: req.body.allowConflicts, allowOverCapacity: req.body.allowOverCapacity });
  });
  app.get('/orgs/:orgId/studios/occurrences/:id/notifications', { schema: { tags, security: secured, params: idParams, summary: 'Communication history for a class' } }, async (req) => {
    const o = await loadOcc(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.read');
    const canSee = await hasPerm(req, s.db, 'customers.read', { organizationId: o.organizationId, kind: 'location', id: o.locationId });
    const rows = await s.db.select({ n: studioCustomerNotifications, name: customers.name }).from(studioCustomerNotifications).innerJoin(customers, eq(customers.id, studioCustomerNotifications.customerId))
      .where(eq(studioCustomerNotifications.occurrenceId, o.id)).orderBy(desc(studioCustomerNotifications.createdAt)).limit(300);
    return { items: rows.map((r) => ({ id: r.n.id, kind: r.n.kind, channel: r.n.channel, status: r.n.status, subject: r.n.subject, customer: canSee ? r.name : r.name.split(' ')[0], createdAt: r.n.createdAt.toISOString(), sentAt: r.n.sentAt?.toISOString() ?? null })) };
  });

  // ───────── Roster & check-in ─────────
  app.get('/orgs/:orgId/studios/occurrences/:id/roster', { schema: { tags, security: secured, params: idParams, summary: 'Check-in roster: booked customers, how they booked (membership / pack / paid), check-in state and fees' } }, async (req) => {
    const o = await loadOcc(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.read');
    const canSee = await hasPerm(req, s.db, 'customers.read', { organizationId: o.organizationId, kind: 'location', id: o.locationId });
    const me = requireUser(req);
    const rows = await s.db.select({ b: classBookings, c: { id: customers.id, name: customers.name }, packName: packs.name, packLeft: packs.creditsRemaining, memName: memberships.plan })
      .from(classBookings).innerJoin(customers, eq(customers.id, classBookings.customerId)).leftJoin(packs, eq(packs.id, classBookings.packId)).leftJoin(memberships, eq(memberships.id, classBookings.membershipId))
      .where(and(eq(classBookings.occurrenceId, o.id), inArray(classBookings.status, ['held', 'confirmed', 'attended', 'no_show']))).orderBy(asc(customers.name));
    const fees = rows.length ? await s.db.select().from(studioFees).where(inArray(studioFees.bookingId, rows.map((r) => r.b.id))) : [];
    const [ct] = await s.db.select({ name: classTypes.name }).from(classTypes).where(eq(classTypes.id, o.classTypeId));
    const [loc] = await s.db.select({ timeZone: locations.timeZone, name: locations.name }).from(locations).where(eq(locations.id, o.locationId));
    const label = (r: typeof rows[number]) => r.b.paymentMethod === 'membership' ? `Membership · ${r.memName ?? ''}`.trim() : r.b.paymentMethod === 'credit' ? `Pack · ${r.packLeft ?? 0} left` : r.b.paymentMethod === 'comp' ? 'Complimentary' : r.b.paymentMethod === 'free' ? 'Free class' : r.b.status === 'held' ? 'Paying now' : 'Paid single class';
    return {
      occurrence: { id: o.id, name: ct?.name ?? '', startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(), timeZone: loc?.timeZone ?? 'UTC', locationName: loc?.name ?? '', instructorName: o.instructorName, room: o.room, capacity: o.capacity, status: o.status, youTeach: o.instructorUserId === me.id },
      counts: { booked: rows.filter((r) => r.b.status !== 'held').length, checkedIn: rows.filter((r) => r.b.status === 'attended').length, noShows: rows.filter((r) => r.b.status === 'no_show').length },
      items: rows.map((r) => {
        const f = fees.find((x) => x.bookingId === r.b.id && x.status !== 'waived');
        return { bookingId: r.b.id, status: r.b.status, customer: { id: r.c.id, name: canSee ? r.c.name : r.c.name.split(' ')[0] }, bookedWith: label(r), paymentMethod: r.b.paymentMethod, checkedInAt: r.b.checkedInAt?.toISOString() ?? null, checkInSource: r.b.checkInSource, source: r.b.source, fee: f ? { id: f.id, kind: f.kind, amount: f.amountMinor, currency: f.currency, status: f.status } : null };
      }),
    };
  });
  app.post('/orgs/:orgId/studios/bookings/:id/check-in', { schema: { tags, security: secured, params: idParams, body: z.object({ source: z.enum(['desk', 'instructor']).default('desk'), undo: z.boolean().default(false) }), summary: 'Check a customer in at the desk or by the instructor' } }, async (req) => {
    const [b] = await s.db.select().from(classBookings).where(and(eq(classBookings.id, req.params.id), eq(classBookings.organizationId, req.params.orgId)));
    if (!b) throw notFound('Booking');
    await requireLocationPerm(req, s.db, b.organizationId, b.locationId, 'operations.write');
    if (req.body.undo) {
      if (b.status !== 'attended') throw conflict('not_checked_in', 'This customer is not checked in');
      const [u] = await s.db.update(classBookings).set({ status: 'confirmed', checkedInAt: null, checkedInBy: null, checkInSource: null }).where(eq(classBookings.id, b.id)).returning();
      return { ...u!, fee: null };
    }
    const r = await recordAttendance(s, b.id, 'attended', { actorUserId: req.user!.id, source: req.body.source });
    return { ...r.booking, fee: null };
  });
  app.post('/orgs/:orgId/studios/occurrences/:id/close-attendance', { schema: { tags, security: secured, params: idParams, summary: 'After class: mark everyone not checked in as a no-show (applies the no-show fee policy)' } }, async (req) => {
    const o = await loadOcc(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.write');
    if (o.startsAt > new Date()) throw conflict('class_not_started', 'Attendance can be closed once the class has started');
    const open = await s.db.select({ id: classBookings.id }).from(classBookings).where(and(eq(classBookings.occurrenceId, o.id), eq(classBookings.status, 'confirmed')));
    let fees = 0;
    for (const b of open) if ((await recordAttendance(s, b.id, 'no_show', { actorUserId: req.user!.id, source: 'desk' })).fee) fees++;
    return { noShows: open.length, feesRecorded: fees };
  });
  app.get('/orgs/:orgId/studios/occurrences/:id/booking-options', { schema: { tags, security: secured, params: idParams, querystring: z.object({ customerId: z.uuid() }), summary: 'Packs and memberships a customer could use for this class (staff booking)' } }, async (req) => {
    const o = await loadOcc(req.params.orgId, req.params.id);
    const loc = await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.write');
    const opts = await entitlementOptions(s.db, req.query.customerId, o, loc);
    const policy = await effectivePolicy(s.db, o.organizationId, o.locationId);
    return { ...opts, price: { amount: o.priceMinor, currency: o.currency }, policy: describePolicy(policy, o.currency) };
  });

  // ───────── Products: packs & membership plans ─────────
  const packBody = z.object({ locationId: z.uuid().nullable().default(null), name: z.string().trim().min(1).max(120), description: z.string().max(1000).nullable().optional(), credits: z.number().int().min(1).max(500), validityDays: z.number().int().min(1).max(1095), prices, transferPolicy: accessPolicy.default('home_only'), allowedLocationIds: z.array(z.uuid()).max(500).default([]), classTypeIds: z.array(z.uuid()).max(200).default([]), status: z.enum(['draft', 'active', 'archived']).default('active') });
  const planBody = z.object({ locationId: z.uuid().nullable().default(null), name: z.string().trim().min(1).max(120), description: z.string().max(1000).nullable().optional(), classesPerPeriod: z.number().int().min(1).max(100).nullable().default(null), prices, accessPolicy: accessPolicy.default('home_only'), allowedLocationIds: z.array(z.uuid()).max(500).default([]), noticeDays: z.number().int().min(0).max(120).default(30), maxPauseDays: z.number().int().min(0).max(180).default(60), graceDays: z.number().int().min(0).max(30).default(7), status: z.enum(['draft', 'active', 'archived']).default('active') });
  const productPerm = (req: FastifyRequest, orgId: string, locationId: string | null) => (locationId ? requireLocationPerm(req, s.db, orgId, locationId, 'operations.write') : requirePerm(req, s.db, 'templates.write', editScope(orgId, null)));
  const sellable = (p: { prices: Record<string, number> }, locs: Array<{ id: string; currency: string; name: string }>, locationId: string | null) => locs.filter((l) => (!locationId || l.id === locationId) && p.prices[l.currency] !== undefined).map((l) => l.id);
  const missingCurrencies = (p: { prices: Record<string, number> }, locs: Array<{ currency: string }>, locationId: string | null, all: Array<{ id: string; currency: string }>) => [...new Set((locationId ? all.filter((l) => l.id === locationId) : locs).map((l) => l.currency))].filter((c) => p.prices[c] === undefined);

  for (const [path, table, body, label] of [['pack-products', studioPackProducts, packBody, 'pack'], ['membership-plans', studioMembershipPlans, planBody, 'membership plan']] as const) {
    app.get(`/orgs/:orgId/studios/${path}`, { schema: { tags, security: secured, params: orgParams } }, async (req) => {
      const ids = await scopeLocs(req, req.params.orgId, 'operations.read');
      const locs = await s.db.select({ id: locations.id, currency: locations.currency, name: locations.name }).from(locations).where(and(eq(locations.organizationId, req.params.orgId), eq(locations.status, 'operating')));
      const rows = (await s.db.select().from(table).where(eq(table.organizationId, req.params.orgId))).filter((p) => !p.locationId || ids.includes(p.locationId));
      const counts = label === 'pack'
        ? await s.db.select({ id: packs.productId, n: sql<number>`count(*)::int` }).from(packs).where(and(eq(packs.organizationId, req.params.orgId), eq(packs.status, 'active'))).groupBy(packs.productId)
        : await s.db.select({ id: memberships.planId, n: sql<number>`count(*)::int` }).from(memberships).where(and(eq(memberships.organizationId, req.params.orgId), inArray(memberships.status, ['active', 'grace', 'paused']))).groupBy(memberships.planId);
      return { items: rows.map((p) => ({ ...p, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(), scope: p.locationId ? 'location' : 'network', sellableAt: sellable(p, locs, p.locationId), missingCurrencies: missingCurrencies(p, locs, p.locationId, locs), active: counts.find((c) => c.id === p.id)?.n ?? 0 })) };
    });
    app.post(`/orgs/:orgId/studios/${path}`, { schema: { tags, security: secured, params: orgParams, body } }, async (req, reply) => {
      const b = req.body as z.infer<typeof packBody> & z.infer<typeof planBody>;
      await productPerm(req, req.params.orgId, b.locationId);
      if (!Object.keys(b.prices).length) throw validationError('Set a price in at least one currency', { prices: 'Required' });
      const [row] = await s.db.insert(table).values({ ...b, organizationId: req.params.orgId, description: b.description ?? null, prices: b.prices as Record<string, number> } as never).returning();
      await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: `${label.replace(' ', '_')}.created`, scopeKind: b.locationId ? 'location' : 'organization', scopeId: b.locationId ?? req.params.orgId, targetType: label, targetId: (row as { id: string }).id });
      return reply.code(201).send(row);
    });
    app.patch(`/orgs/:orgId/studios/${path}/:id`, { schema: { tags, security: secured, params: idParams, body: (body as typeof packBody).partial().omit({ locationId: true }) } }, async (req) => {
      const [p] = await s.db.select().from(table).where(and(eq(table.id, req.params.id), eq(table.organizationId, req.params.orgId)));
      if (!p) throw notFound(label);
      await productPerm(req, p.organizationId, p.locationId);
      const [u] = await s.db.update(table).set({ ...(req.body as object), updatedAt: new Date() } as never).where(eq(table.id, p.id)).returning();
      await audit(s.db, { organizationId: p.organizationId, ...actor(req), action: `${label.replace(' ', '_')}.updated`, targetType: label, targetId: p.id, metadata: { fields: Object.keys(req.body as object), note: 'Existing packs/memberships keep their terms' } });
      return u;
    });
  }

  // ───────── Policies ─────────
  const policyBody = z.object({ locationId: z.uuid().nullable().default(null), lateCancelMinutes: z.number().int().min(0).max(10080), lateCancelFee: prices.default({}), noShowFee: prices.default({}), forfeitCreditOnLateCancel: z.boolean(), refundPaidOnLateCancel: z.boolean(), feesApplyToMembers: z.boolean().default(true), bookingWindowDays: z.number().int().min(1).max(365).default(30) });
  app.get('/orgs/:orgId/studios/policies', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }), summary: 'Booking, late-cancel and no-show policy (location override or organisation default)' } }, async (req) => {
    const ids = await scopeLocs(req, req.params.orgId, 'operations.read', req.query.locationId);
    const rows = await s.db.select().from(studioPolicies).where(eq(studioPolicies.organizationId, req.params.orgId));
    const locs = await s.db.select({ id: locations.id, name: locations.name, currency: locations.currency }).from(locations).where(inArray(locations.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000']));
    const effective = await Promise.all(locs.map(async (l) => { const p = await effectivePolicy(s.db, req.params.orgId, l.id); return { locationId: l.id, locationName: l.name, currency: l.currency, policy: p, text: describePolicy(p, l.currency).lines }; }));
    return { organizationDefault: rows.find((r) => !r.locationId) ?? null, locationOverrides: rows.filter((r) => r.locationId && ids.includes(r.locationId)), effective };
  });
  app.put('/orgs/:orgId/studios/policies', { schema: { tags, security: secured, params: orgParams, body: policyBody, summary: 'Set the organisation default (locationId null, HQ) or a location policy. Shown to customers before booking.' } }, async (req) => {
    const b = req.body;
    if (b.locationId) await requireLocationPerm(req, s.db, req.params.orgId, b.locationId, 'operations.write');
    else await requirePerm(req, s.db, 'policies.write', editScope(req.params.orgId, null));
    const values = { ...b, lateCancelFee: b.lateCancelFee as Record<string, number>, noShowFee: b.noShowFee as Record<string, number>, organizationId: req.params.orgId, updatedBy: req.user!.id, updatedAt: new Date() };
    const [existing] = await s.db.select({ id: studioPolicies.id }).from(studioPolicies).where(and(eq(studioPolicies.organizationId, req.params.orgId), b.locationId ? eq(studioPolicies.locationId, b.locationId) : isNull(studioPolicies.locationId)));
    const [row] = existing ? await s.db.update(studioPolicies).set(values).where(eq(studioPolicies.id, existing.id)).returning() : await s.db.insert(studioPolicies).values(values).returning();
    await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'studio_policy.updated', scopeKind: b.locationId ? 'location' : 'organization', scopeId: b.locationId ?? req.params.orgId, targetType: 'studio_policy', targetId: row!.id, metadata: b });
    return row;
  });
  app.delete('/orgs/:orgId/studios/policies/:id', { schema: { tags, security: secured, params: idParams, summary: 'Remove a location override (falls back to the organisation default)' } }, async (req, reply) => {
    const [p] = await s.db.select().from(studioPolicies).where(and(eq(studioPolicies.id, req.params.id), eq(studioPolicies.organizationId, req.params.orgId)));
    if (!p || !p.locationId) throw notFound('Location policy');
    await requireLocationPerm(req, s.db, p.organizationId, p.locationId, 'operations.write');
    await s.db.delete(studioPolicies).where(eq(studioPolicies.id, p.id));
    return reply.code(204).send(null);
  });

  // ───────── Members ─────────
  app.get('/orgs/:orgId/studios/members', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ q: z.string().max(100).optional(), locationId: z.uuid().optional(), filter: z.enum(['all', 'members', 'pack_holders', 'grace', 'none']).default('all'), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }), summary: 'Searchable member list: packs, membership state, attendance and consent (customers.read)' },
  }, async (req) => {
    const ids = await scopeLocs(req, req.params.orgId, 'customers.read', req.query.locationId);
    if (!ids.length) return { items: [], total: 0 };
    const q = req.query.q?.trim();
    const conds = [eq(customers.organizationId, req.params.orgId), inArray(customers.locationId, ids), isNull(customers.erasedAt)];
    if (q) conds.push(or(ilike(customers.name, `%${q}%`), ilike(customers.email, `%${q}%`), ilike(customers.phone, `%${q}%`))!);
    const filter = req.query.filter;
    if (filter === 'members') conds.push(sql`exists (select 1 from memberships m where m.customer_id = ${customers.id} and m.status in ('active','grace','paused'))`);
    if (filter === 'grace') conds.push(sql`exists (select 1 from memberships m where m.customer_id = ${customers.id} and m.status in ('grace','suspended'))`);
    if (filter === 'pack_holders') conds.push(sql`exists (select 1 from packs p where p.customer_id = ${customers.id} and p.status = 'active' and p.credits_remaining > 0)`);
    if (filter === 'none') conds.push(sql`not exists (select 1 from memberships m where m.customer_id = ${customers.id} and m.status in ('active','grace','paused')) and not exists (select 1 from packs p where p.customer_id = ${customers.id} and p.status = 'active')`);
    const [{ total } = { total: 0 }] = await s.db.select({ total: sql<number>`count(*)::int` }).from(customers).where(and(...conds));
    const rows = await s.db.select().from(customers).where(and(...conds)).orderBy(asc(customers.name)).limit(req.query.limit).offset(req.query.offset);
    const cids = rows.map((r) => r.id);
    if (!cids.length) return { items: [], total };
    const [ms, ps, att, cons] = await Promise.all([
      s.db.select().from(memberships).where(and(inArray(memberships.customerId, cids), inArray(memberships.status, ['active', 'grace', 'paused', 'suspended', 'pending']))),
      s.db.select().from(packs).where(and(inArray(packs.customerId, cids), eq(packs.status, 'active'))),
      s.db.select({ c: classBookings.customerId, attended: sql<number>`count(*) filter (where ${classBookings.status} = 'attended')::int`, noShows: sql<number>`count(*) filter (where ${classBookings.status} = 'no_show')::int`, last: sql<string | null>`max(${classBookings.checkedInAt})` }).from(classBookings).where(inArray(classBookings.customerId, cids)).groupBy(classBookings.customerId),
      s.db.select({ c: consentRecords.customerId, purpose: consentRecords.purpose, granted: consentRecords.granted, at: consentRecords.recordedAt }).from(consentRecords).where(and(inArray(consentRecords.customerId, cids), inArray(consentRecords.purpose, ['marketing_email', 'marketing_sms', 'class_updates_sms']))).orderBy(desc(consentRecords.recordedAt)),
    ]);
    const locNames = new Map((await s.db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.organizationId, req.params.orgId))).map((l) => [l.id, l.name]));
    const consentOf = (c: string, p: string) => { const r = cons.find((x) => x.c === c && x.purpose === p); return r ? r.granted : null; };
    return {
      total,
      items: rows.map((c) => {
        const m = ms.filter((x) => x.customerId === c.id).map((x) => serializeMembership(x))[0] ?? null;
        const p = ps.filter((x) => x.customerId === c.id);
        const a = att.find((x) => x.c === c.id);
        return {
          id: c.id, name: c.name, email: c.email, phone: c.phone, homeLocation: c.locationId ? { id: c.locationId, name: locNames.get(c.locationId) ?? '' } : null,
          membership: m ? { id: m.id, name: m.name, state: m.state, graceUntil: m.graceUntil, cancelAt: m.cancelAt } : null,
          packs: { count: p.length, credits: p.reduce((x, y) => x + y.creditsRemaining, 0), nextExpiry: p.map((x) => x.expiresAt?.toISOString()).filter(Boolean).sort()[0] ?? null },
          attendance: { attended: a?.attended ?? 0, noShows: a?.noShows ?? 0, lastVisit: a?.last ? new Date(a.last).toISOString() : null },
          consent: { marketingEmail: consentOf(c.id, 'marketing_email'), marketingSms: consentOf(c.id, 'marketing_sms'), classUpdatesSms: consentOf(c.id, 'class_updates_sms') },
        };
      }),
    };
  });

  const loadMember = async (req: FastifyRequest, orgId: string, id: string, perm: Permission = 'customers.read') => {
    const [c] = await s.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, orgId)));
    if (!c || c.erasedAt) throw notFound('Member');
    const ids = await scopeLocs(req, orgId, perm);
    if (!c.locationId || !ids.includes(c.locationId)) {
      // Customers who visit several locations: visible where they hold a pack/membership/booking in scope.
      const [x] = await s.db.select({ n: sql<number>`count(*)::int` }).from(classBookings).where(and(eq(classBookings.customerId, c.id), inArray(classBookings.locationId, ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])));
      if (!x?.n) throw notFound('Member');
    }
    return c;
  };

  app.get('/orgs/:orgId/studios/members/:id', { schema: { tags, security: secured, params: idParams, summary: 'Member detail: packs, membership (usage, invoices), bookings and attendance, fees, consent history' } }, async (req) => {
    const c = await loadMember(req, req.params.orgId, req.params.id);
    const [ms, ps, bks, fees, cons, purchases, grants] = await Promise.all([
      s.db.select().from(memberships).where(eq(memberships.customerId, c.id)).orderBy(desc(memberships.startsAt)),
      s.db.select().from(packs).where(eq(packs.customerId, c.id)).orderBy(desc(packs.createdAt)),
      s.db.select({ b: classBookings, startsAt: classOccurrences.startsAt, name: classTypes.name, loc: locations.name, tz: locations.timeZone }).from(classBookings).innerJoin(classOccurrences, eq(classOccurrences.id, classBookings.occurrenceId)).innerJoin(classTypes, eq(classTypes.id, classOccurrences.classTypeId)).innerJoin(locations, eq(locations.id, classBookings.locationId))
        .where(eq(classBookings.customerId, c.id)).orderBy(desc(classOccurrences.startsAt)).limit(100),
      s.db.select().from(studioFees).where(eq(studioFees.customerId, c.id)).orderBy(desc(studioFees.createdAt)),
      s.db.select().from(consentRecords).where(eq(consentRecords.customerId, c.id)).orderBy(desc(consentRecords.recordedAt)),
      s.db.select().from(studioPurchases).where(eq(studioPurchases.customerId, c.id)).orderBy(desc(studioPurchases.createdAt)).limit(50),
      s.db.select({ g: onlineAccessGrants, title: onlineContent.title }).from(onlineAccessGrants).innerJoin(onlineContent, eq(onlineContent.id, onlineAccessGrants.contentId)).where(eq(onlineAccessGrants.customerId, c.id)),
    ]);
    const feeAuto = await (await import('../services/payments-saved.ts')).autoChargeStates(s.db, 'studio_fee', fees.map((f) => f.id));
    const memberOut = await Promise.all(ms.map(async (m) => ({ ...serializeMembership(m), usage: ['active', 'grace'].includes(m.status) ? await membershipUsage(s.db, m, new Date()).then((u) => ({ used: u.used, limit: u.limit, periodStart: u.periodStart.toISOString(), periodEnd: u.periodEnd.toISOString() })) : null, invoices: (await invoicesFor(s.db, m.id)).map((i) => ({ id: i.id, periodStart: i.periodStart.toISOString(), periodEnd: i.periodEnd.toISOString(), amount: { amount: i.amountMinor, currency: i.currency }, status: i.status, attempts: i.attempts, failureReason: i.failureReason })) })));
    return {
      id: c.id, name: c.name, email: c.email, phone: c.phone, locationId: c.locationId, createdAt: c.createdAt.toISOString(),
      memberships: memberOut, packs: ps.map((p) => serializePack(p)),
      bookings: bks.map((r) => ({ id: r.b.id, occurrenceId: r.b.occurrenceId, className: r.name, locationName: r.loc, timeZone: r.tz, startsAt: r.startsAt.toISOString(), status: r.b.status, paymentMethod: r.b.paymentMethod, lateCancel: r.b.lateCancel, checkedInAt: r.b.checkedInAt?.toISOString() ?? null })),
      attendance: { attended: bks.filter((b) => b.b.status === 'attended').length, noShows: bks.filter((b) => b.b.status === 'no_show').length, lateCancels: bks.filter((b) => b.b.lateCancel).length, upcoming: bks.filter((b) => b.startsAt > new Date() && b.b.status === 'confirmed').length },
      fees: fees.map((f) => ({ id: f.id, kind: f.kind, amount: { amount: f.amountMinor, currency: f.currency }, status: f.status, bookingId: f.bookingId, waiveReason: f.waiveReason, createdAt: f.createdAt.toISOString(), autoCharge: feeAuto.get(f.id) ?? null })),
      consents: cons.map((r) => ({ purpose: r.purpose, granted: r.granted, version: r.version, source: r.source, recordedAt: r.recordedAt.toISOString() })),
      purchases: purchases.map(serializePurchase),
      online: grants.map((g) => ({ contentId: g.g.contentId, title: g.title, kind: g.g.kind, basis: g.g.basis, joinedAt: g.g.joinedAt?.toISOString() ?? null })),
    };
  });

  app.post('/orgs/:orgId/studios/members/:id/purchases', { schema: { tags, security: secured, params: idParams, body: z.object({ locationId: z.uuid(), kind: z.enum(['pack', 'membership', 'offer', 'fee']), productId: z.uuid().optional(), offerId: z.uuid().optional() }), summary: 'Sell a pack / membership / intro offer at the desk (returns a payment to complete)' } }, async (req, reply) => {
    const c = await loadMember(req, req.params.orgId, req.params.id, 'customers.write');
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'operations.write');
    const r = await createPurchase(s, { organizationId: req.params.orgId, loc, customerId: c.id, kind: req.body.kind, productId: req.body.productId, offerId: req.body.offerId, source: 'desk', actorUserId: req.user!.id });
    return reply.code(201).send({ purchase: serializePurchase(r.purchase as never), payment: r.payment });
  });
  app.post('/orgs/:orgId/studios/members/:id/credits', { schema: { tags, security: secured, params: idParams, body: z.object({ locationId: z.uuid(), credits: z.number().int().min(1).max(50), validityDays: z.number().int().min(1).max(365).default(60), reason: z.string().trim().min(3).max(120) }), summary: 'Add complimentary credits (goodwill, class issue) — audited' } }, async (req, reply) => {
    const c = await loadMember(req, req.params.orgId, req.params.id, 'customers.write');
    await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'operations.write');
    const p = await grantCredits(s, { organizationId: req.params.orgId, locationId: req.body.locationId, customerId: c.id, credits: req.body.credits, validityDays: req.body.validityDays, reason: req.body.reason, actorUserId: req.user!.id });
    return reply.code(201).send(serializePack(p));
  });

  const loadMembership = async (req: FastifyRequest, orgId: string, id: string) => {
    const [m] = await s.db.select().from(memberships).where(and(eq(memberships.id, id), eq(memberships.organizationId, orgId)));
    if (!m || !m.locationId) throw notFound('Membership');
    await requireLocationPerm(req, s.db, orgId, m.locationId, 'customers.write');
    return m;
  };
  app.post('/orgs/:orgId/studios/memberships/:id/pause', { schema: { tags, security: secured, params: idParams, body: z.object({ from: isoDateTime, until: isoDateTime, reason: z.string().max(200).optional() }), summary: 'Pause (freeze) a membership; billing is deferred by the pause length' } }, async (req) => {
    const m = await loadMembership(req, req.params.orgId, req.params.id);
    return serializeMembership(await pauseMembership(s, m, { from: new Date(req.body.from), until: new Date(req.body.until), reason: req.body.reason, actorUserId: req.user!.id }));
  });
  app.post('/orgs/:orgId/studios/memberships/:id/resume', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const m = await loadMembership(req, req.params.orgId, req.params.id);
    return serializeMembership(await resumeMembership(s, m, req.user!.id));
  });
  app.post('/orgs/:orgId/studios/memberships/:id/cancel', { schema: { tags, security: secured, params: idParams, body: z.object({ immediate: z.boolean().default(false), reason: z.string().max(200).optional() }), summary: 'Cancel with the plan notice period (or immediately)' } }, async (req) => {
    const m = await loadMembership(req, req.params.orgId, req.params.id);
    return serializeMembership(await cancelMembership(s, m, { actorUserId: req.user!.id, immediate: req.body.immediate, reason: req.body.reason }));
  });
  app.post('/orgs/:orgId/studios/memberships/:id/sandbox-renewal', { schema: { tags, security: secured, params: idParams, body: z.object({ outcome: z.enum(['succeeded', 'failed']) }), summary: 'Sandbox only: charge the next renewal now with a simulated outcome (failed → grace period)' } }, async (req) => {
    if (studioBilling(s).mode !== 'sandbox') throw new AppError(409, 'not_sandbox', 'Renewals are charged by Stripe in live mode');
    const m = await loadMembership(req, req.params.orgId, req.params.id);
    const r = await chargeRenewalSandbox(s, m.id, req.body.outcome);
    return { membership: serializeMembership(r.membership), invoice: { id: r.invoice.id, status: r.invoice.status, periodStart: r.invoice.periodStart.toISOString(), amount: { amount: r.invoice.amountMinor, currency: r.invoice.currency } } };
  });

  // ───────── Fees ─────────
  app.get('/orgs/:orgId/studios/fees', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum(['due', 'paid', 'waived']).optional(), locationId: z.uuid().optional() }) } }, async (req) => {
    const ids = await scopeLocs(req, req.params.orgId, 'customers.read', req.query.locationId);
    if (!ids.length) return { items: [] };
    const rows = await s.db.select({ f: studioFees, name: customers.name }).from(studioFees).innerJoin(customers, eq(customers.id, studioFees.customerId))
      .where(and(eq(studioFees.organizationId, req.params.orgId), inArray(studioFees.locationId, ids), req.query.status ? eq(studioFees.status, req.query.status) : sql`true`)).orderBy(desc(studioFees.createdAt)).limit(200);
    const auto = await (await import('../services/payments-saved.ts')).autoChargeStates(s.db, 'studio_fee', rows.map((r) => r.f.id));
    return { items: rows.map((r) => ({ id: r.f.id, kind: r.f.kind, customer: { id: r.f.customerId, name: r.name }, locationId: r.f.locationId, amount: { amount: r.f.amountMinor, currency: r.f.currency }, status: r.f.status, bookingId: r.f.bookingId, waiveReason: r.f.waiveReason, createdAt: r.f.createdAt.toISOString(), autoCharge: auto.get(r.f.id) ?? null })) };
  });
  app.post('/orgs/:orgId/studios/fees/:id/waive', { schema: { tags, security: secured, params: idParams, body: z.object({ reason: z.string().trim().min(3).max(200) }) } }, async (req) => {
    const [f] = await s.db.select().from(studioFees).where(and(eq(studioFees.id, req.params.id), eq(studioFees.organizationId, req.params.orgId)));
    if (!f) throw notFound('Fee');
    await requireLocationPerm(req, s.db, f.organizationId, f.locationId, 'operations.write');
    if (f.status !== 'due') throw conflict('fee_not_due', `Fee is ${f.status}`);
    const [u] = await s.db.update(studioFees).set({ status: 'waived', waivedBy: req.user!.id, waiveReason: req.body.reason, updatedAt: new Date() }).where(eq(studioFees.id, f.id)).returning();
    await audit(s.db, { organizationId: f.organizationId, ...actor(req), action: 'fee.waived', scopeKind: 'location', scopeId: f.locationId, targetType: 'studio_fee', targetId: f.id, metadata: { reason: req.body.reason, amount: f.amountMinor, currency: f.currency } });
    return u;
  });

  // ───────── Cover candidates ─────────
  app.get('/orgs/:orgId/studios/cover-requests/:id/candidates', { schema: { tags, security: secured, params: idParams, summary: 'Eligible substitutes with their availability and clashes for the class time' } }, async (req) => {
    const { coverRequests } = await import('../db/schema/index.ts');
    const [cr] = await s.db.select().from(coverRequests).where(and(eq(coverRequests.id, req.params.id), eq(coverRequests.organizationId, req.params.orgId)));
    if (!cr) throw notFound('Cover request');
    await requireLocationPerm(req, s.db, cr.organizationId, cr.locationId, 'operations.read');
    const o = await loadOcc(cr.organizationId, cr.occurrenceId);
    const { usersWithPermissionAt } = await import('../services/notifications.ts');
    const ids = (await usersWithPermissionAt(s.db, cr.organizationId, cr.locationId, 'operations.read')).filter((u) => u !== cr.requestedBy);
    const people = ids.length ? await s.db.select({ id: users.id, name: users.name }).from(users).where(and(inArray(users.id, ids), isNull(users.deletedAt))) : [];
    const items = [];
    for (const p of people) {
      const [c] = await findConflicts(s.db, cr.organizationId, [o], { instructorUserId: p.id, excludeIds: [o.id] });
      items.push({ userId: p.id, name: p.name, available: !c!.length, conflicts: c! });
    }
    return { occurrenceId: o.id, items: items.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name)) };
  });

  // ───────── Online classes (admin) ─────────
  const onlineBody = z.object({
    locationId: z.uuid().nullable().default(null), kind: z.enum(['livestream', 'on_demand']), title: z.string().trim().min(1).max(160), description: z.string().max(2000).nullable().optional(),
    classTypeId: z.uuid().nullable().optional(), occurrenceId: z.uuid().nullable().optional(), instructorName: z.string().max(120).nullable().optional(),
    provider: z.enum(['zoom', 'youtube', 'vimeo', 'other']), providerUrl: z.url().max(1000), startsAt: isoDateTime.nullable().optional(), durationMinutes: z.number().int().min(1).max(600).nullable().optional(),
    allowMembers: z.boolean().default(true), allowPackHolders: z.boolean().default(false), allowFree: z.boolean().default(false), prices: prices.default({}), status: z.enum(['draft', 'published', 'archived']).default('draft'),
  });
  const onlinePerm = (req: FastifyRequest, orgId: string, locationId: string | null) => (locationId ? requireLocationPerm(req, s.db, orgId, locationId, 'operations.write') : requirePerm(req, s.db, 'templates.write', editScope(orgId, null)));
  app.get('/orgs/:orgId/studios/online', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ kind: z.enum(['livestream', 'on_demand']).optional(), locationId: z.uuid().optional() }) } }, async (req) => {
    const ids = await scopeLocs(req, req.params.orgId, 'operations.read', req.query.locationId);
    const rows = (await s.db.select().from(onlineContent).where(and(eq(onlineContent.organizationId, req.params.orgId), req.query.kind ? eq(onlineContent.kind, req.query.kind) : sql`true`)).orderBy(desc(onlineContent.createdAt)))
      .filter((c) => (!c.locationId && !req.query.locationId) || (c.locationId && ids.includes(c.locationId)) || (!c.locationId && !!req.query.locationId));
    const regs = rows.length ? await s.db.select({ id: onlineAccessGrants.contentId, n: sql<number>`count(*)::int` }).from(onlineAccessGrants).where(and(inArray(onlineAccessGrants.contentId, rows.map((r) => r.id)), isNull(onlineAccessGrants.revokedAt))).groupBy(onlineAccessGrants.contentId) : [];
    const names = new Map((await s.db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.organizationId, req.params.orgId))).map((l) => [l.id, l.name]));
    return { items: rows.map((c) => serializeContent(c, { includeUrl: true, registrations: regs.find((r) => r.id === c.id)?.n ?? 0, locationName: c.locationId ? names.get(c.locationId) ?? null : null })) };
  });
  app.post('/orgs/:orgId/studios/online', { schema: { tags, security: secured, params: orgParams, body: onlineBody, summary: 'Add a livestream or recording (provider URL stored; it is only revealed to customers with access)' } }, async (req, reply) => {
    const b = req.body;
    await onlinePerm(req, req.params.orgId, b.locationId);
    if (b.kind === 'livestream' && !b.startsAt && !b.occurrenceId) throw validationError('A livestream needs a start time or a linked class', { startsAt: 'Required' });
    let startsAt = b.startsAt ? new Date(b.startsAt) : null;
    let duration = b.durationMinutes ?? null;
    if (b.occurrenceId) {
      const o = await loadOcc(req.params.orgId, b.occurrenceId);
      startsAt ??= o.startsAt;
      duration ??= Math.round((o.endsAt.getTime() - o.startsAt.getTime()) / 60_000);
    }
    const [c] = await s.db.insert(onlineContent).values({ ...b, organizationId: req.params.orgId, description: b.description ?? null, classTypeId: b.classTypeId ?? null, occurrenceId: b.occurrenceId ?? null, instructorName: b.instructorName ?? null, startsAt, durationMinutes: duration, prices: b.prices as Record<string, number>, publishedAt: b.status === 'published' ? new Date() : null, createdBy: req.user!.id }).returning();
    await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'online.created', scopeKind: b.locationId ? 'location' : 'organization', scopeId: b.locationId ?? req.params.orgId, targetType: 'online_content', targetId: c!.id });
    return reply.code(201).send(serializeContent(c!, { includeUrl: true }));
  });
  app.patch('/orgs/:orgId/studios/online/:id', { schema: { tags, security: secured, params: idParams, body: onlineBody.partial().omit({ locationId: true, kind: true }) } }, async (req) => {
    const [c] = await s.db.select().from(onlineContent).where(and(eq(onlineContent.id, req.params.id), eq(onlineContent.organizationId, req.params.orgId)));
    if (!c) throw notFound('Online class');
    await onlinePerm(req, c.organizationId, c.locationId);
    const { startsAt: _st, ...b } = req.body;
    const [u] = await s.db.update(onlineContent).set({
      ...b, ...(b.prices ? { prices: b.prices as Record<string, number> } : {}), ...(_st !== undefined ? { startsAt: _st ? new Date(_st) : null } : {}),
      ...(b.status === 'published' && !c.publishedAt ? { publishedAt: new Date() } : {}), updatedAt: new Date(),
    }).where(eq(onlineContent.id, c.id)).returning();
    return serializeContent(u!, { includeUrl: true });
  });
  app.get('/orgs/:orgId/studios/online/:id/registrations', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const [c] = await s.db.select().from(onlineContent).where(and(eq(onlineContent.id, req.params.id), eq(onlineContent.organizationId, req.params.orgId)));
    if (!c) throw notFound('Online class');
    if (c.locationId) await requireLocationPerm(req, s.db, c.organizationId, c.locationId, 'operations.read');
    else await scopeLocs(req, c.organizationId, 'operations.read');
    const canSee = c.locationId ? await hasPerm(req, s.db, 'customers.read', { organizationId: c.organizationId, kind: 'location', id: c.locationId }) : await hasPerm(req, s.db, 'customers.read', editScope(c.organizationId, null));
    const rows = await s.db.select({ g: onlineAccessGrants, name: customers.name }).from(onlineAccessGrants).innerJoin(customers, eq(customers.id, onlineAccessGrants.customerId)).where(and(eq(onlineAccessGrants.contentId, c.id), isNull(onlineAccessGrants.revokedAt)));
    return { items: rows.map((r) => ({ customer: canSee ? r.name : r.name.split(' ')[0], kind: r.g.kind, basis: r.g.basis, joinedAt: r.g.joinedAt?.toISOString() ?? null, createdAt: r.g.createdAt.toISOString() })) };
  });

  // ───────── Reports ─────────
  app.get('/orgs/:orgId/studios/reports', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional(), locationId: z.uuid().optional() }), summary: 'Occupancy, attendance trend, membership churn and revenue per currency' } }, async (req) => {
    const ids = await scopeLocs(req, req.params.orgId, 'reports.read', req.query.locationId);
    const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 7 * 86400_000);
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 63 * 86400_000);
    if (from >= to) throw validationError('`from` must be before `to`');
    return studioReports(s.db, req.params.orgId, ids, { from, to });
  });
  app.get('/orgs/:orgId/studios/pulse', { schema: { tags, security: secured, params: orgParams, summary: 'Owner pulse: today and the next 7 days of occupancy per location' } }, async (req) => {
    const ids = await scopeLocs(req, req.params.orgId, 'reports.read');
    const now = new Date();
    const r = await studioReports(s.db, req.params.orgId, ids, { from: new Date(now.getTime() - 7 * 86400_000), to: now });
    const next = await studioReports(s.db, req.params.orgId, ids, { from: now, to: new Date(now.getTime() + 7 * 86400_000) });
    const grace = ids.length ? await s.db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(and(eq(memberships.organizationId, req.params.orgId), inArray(memberships.locationId, ids), inArray(memberships.status, ['grace', 'suspended']))) : [{ n: 0 }];
    return { generatedAt: r.generatedAt, last7: r.occupancy.byLocation, next7: next.occupancy.byLocation, revenueLast7: r.revenue, membershipsNeedingAttention: grace[0]?.n ?? 0, definitions: r.definitions };
  });

  // ───────── AI (read-only / proposals) ─────────
  app.post('/orgs/:orgId/studios/ai/class-description', { schema: { tags, security: secured, params: orgParams, body: z.object({ classTypeId: z.uuid(), tone: z.enum(['warm', 'energetic', 'calm']).default('warm'), audience: z.string().max(80).optional() }), summary: 'Draft a class description (not saved; no health claims)' } }, async (req) => {
    const [ct] = await s.db.select().from(classTypes).where(and(eq(classTypes.id, req.body.classTypeId), eq(classTypes.organizationId, req.params.orgId)));
    if (!ct) throw notFound('Class type');
    // Network class types: anyone with ai.use somewhere may draft (drafts change nothing).
    if (ct.locationId) await requireLocationPerm(req, s.db, ct.organizationId, ct.locationId, 'ai.use');
    else if (!(await scopeLocs(req, ct.organizationId, 'ai.use')).length) throw forbidden('Missing permission ai.use');
    return draftClassDescription(s, ct, { tone: req.body.tone, audience: req.body.audience, locationId: ct.locationId, actorUserId: req.user!.id });
  });
  app.get('/orgs/:orgId/studios/ai/attendance-summary', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ weeks: z.coerce.number().int().min(1).max(12).default(4), locationId: z.uuid().optional() }), summary: 'Attendance changes: observations only; causes are not inferred' } }, async (req) => {
    const ids = await scopeLocs(req, req.params.orgId, 'reports.read', req.query.locationId);
    await scopeLocs(req, req.params.orgId, 'ai.use', req.query.locationId);
    return attendanceSummary(s, req.params.orgId, ids, req.query.weeks, { userId: req.user!.id, locationId: req.query.locationId ?? null });
  });
  app.post('/orgs/:orgId/studios/ai/follow-up-audiences', { schema: { tags, security: secured, params: orgParams, body: z.object({ locationId: z.uuid().optional() }), summary: 'Propose follow-up audiences with consent counts (nothing is sent)' } }, async (req) => {
    const ids = await scopeLocs(req, req.params.orgId, 'customers.read', req.body.locationId);
    await scopeLocs(req, req.params.orgId, 'ai.use', req.body.locationId);
    return followUpAudiences(s, req.params.orgId, ids, { userId: req.user!.id, locationId: req.body.locationId ?? null, canSeeNames: true });
  });
  app.get('/orgs/:orgId/studios/ai/proposals', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ kind: z.string().optional() }) } }, async (req) => {
    const ids = await scopeLocs(req, req.params.orgId, 'ai.use');
    const rows = (await s.db.select().from(studioAiProposals).where(and(eq(studioAiProposals.organizationId, req.params.orgId), req.query.kind ? eq(studioAiProposals.kind, req.query.kind) : sql`true`)).orderBy(desc(studioAiProposals.createdAt)).limit(50))
      .filter((p) => !p.locationId || ids.includes(p.locationId));
    return { items: rows.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })) };
  });
  app.post('/orgs/:orgId/studios/ai/proposals/:id/status', { schema: { tags, security: secured, params: idParams, body: z.object({ status: z.enum(['dismissed', 'used']) }) } }, async (req) => {
    await scopeLocs(req, req.params.orgId, 'ai.use');
    const [u] = await s.db.update(studioAiProposals).set({ status: req.body.status }).where(and(eq(studioAiProposals.id, req.params.id), eq(studioAiProposals.organizationId, req.params.orgId))).returning();
    if (!u) throw notFound('Proposal');
    return u;
  });

  // Unused-import guard for tables referenced only in types.
  void membershipInvoices; void waitlistEntries;
};

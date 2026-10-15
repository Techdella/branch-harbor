import { and, asc, desc, eq, gt, gte, inArray, lt, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { locations, organizations, shiftSwapRequests, shifts, timeClockEvents, users } from '../db/schema/index.ts';
import type { Exec } from '../db/client.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { addDays, localDateParts, zonedToUtc } from '../lib/tz.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requireLocationPerm } from '../services/authz.ts';
import { insertApproval, notifyApprovers, serializeApprovals } from '../services/approvals.ts';
import { usersWithPermissionAt } from '../services/notifications.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

type ShiftRow = typeof shifts.$inferSelect;
const CLOCK_EARLY_MINUTES = 60;

/** Managers schedule and approve: operations.write AND locations.read at the location (staff hold only operations.*). */
async function requireManager(req: FastifyRequest, db: Exec, orgId: string, locationId: string) {
  const loc = await requireLocationPerm(req, db, orgId, locationId, 'operations.write');
  if (!(await hasPerm(req, db, 'locations.read', { organizationId: orgId, kind: 'location', id: locationId }))) throw forbidden('Only a manager can change the schedule');
  return loc;
}

/** Shift rows → view model with names, the location's time zone, clock state and any pending swap. */
async function serializeShifts(db: Exec, rows: ShiftRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [people, locs, events, swaps] = await Promise.all([
    db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.userId))])),
    db.select({ id: locations.id, name: locations.name, timeZone: locations.timeZone, organizationId: locations.organizationId }).from(locations).where(inArray(locations.id, [...new Set(rows.map((r) => r.locationId))])),
    db.select().from(timeClockEvents).where(inArray(timeClockEvents.shiftId, ids)).orderBy(asc(timeClockEvents.at)),
    db.select().from(shiftSwapRequests).where(and(inArray(shiftSwapRequests.shiftId, ids), eq(shiftSwapRequests.status, 'pending'))),
  ]);
  const swapPeople = swaps.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, swaps.map((x) => x.toUserId))) : [];
  return rows.map((r) => {
    const ev = events.filter((e) => e.shiftId === r.id);
    const lastIn = [...ev].reverse().find((e) => e.kind === 'clock_in');
    const lastOut = lastIn ? ev.find((e) => e.kind === 'clock_out' && e.at >= lastIn.at) : undefined;
    const sw = swaps.find((x) => x.shiftId === r.id);
    const l = locs.find((x) => x.id === r.locationId);
    return {
      id: r.id, organizationId: r.organizationId, locationId: r.locationId, location: l ? { id: l.id, name: l.name, timeZone: l.timeZone } : null,
      user: { id: r.userId, name: people.find((p) => p.id === r.userId)?.name ?? 'Team member' }, role: r.role,
      startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(), breakMinutes: r.breakMinutes, status: r.status, notes: r.notes,
      clockedInAt: lastIn?.at.toISOString() ?? null, clockedOutAt: lastOut?.at.toISOString() ?? null,
      pendingSwap: sw ? { id: sw.id, approvalId: sw.approvalId, toUser: { id: sw.toUserId, name: swapPeople.find((p) => p.id === sw.toUserId)?.name ?? 'Colleague' }, toShiftId: sw.toShiftId } : null,
    };
  });
}

async function assertWorksAt(db: Exec, orgId: string, locationId: string, userId: string) {
  const staff = await usersWithPermissionAt(db, orgId, locationId, 'operations.read');
  if (!staff.includes(userId)) throw validationError('This person does not work at this location', { userId: 'Not assigned to this location' });
}

async function assertNoOverlap(db: Exec, userId: string, startsAt: Date, endsAt: Date, exceptId?: string) {
  const conds = [eq(shifts.userId, userId), eq(shifts.status, 'scheduled'), lt(shifts.startsAt, endsAt), gt(shifts.endsAt, startsAt)];
  if (exceptId) conds.push(ne(shifts.id, exceptId));
  const [clash] = await db.select({ id: shifts.id, startsAt: shifts.startsAt }).from(shifts).where(and(...conds)).limit(1);
  if (clash) throw conflict('shift_overlap', 'This person already has a shift at that time', { shiftId: clash.id });
}

export const shiftRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  // ───────── Schedule ─────────
  app.get('/orgs/:orgId/shifts', {
    schema: {
      tags: ['shifts'], security: secured, params: orgParams, summary: 'Shifts in authorised locations (UTC; each item carries its location time zone)',
      querystring: z.object({ locationId: z.uuid().optional(), userId: z.uuid().optional(), from: isoDateTime.optional(), to: isoDateTime.optional(), includeCancelled: z.coerce.boolean().default(false) }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 86400_000);
    const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 8 * 86400_000);
    const conds = [eq(shifts.organizationId, orgId), lt(shifts.startsAt, to), gt(shifts.endsAt, from)];
    if (req.query.locationId) conds.push(eq(shifts.locationId, req.query.locationId));
    if (req.query.userId) conds.push(eq(shifts.userId, req.query.userId));
    if (!req.query.includeCancelled) conds.push(eq(shifts.status, 'scheduled'));
    if (allowed !== 'all') {
      if (!allowed.size) return { items: [] };
      conds.push(inArray(shifts.locationId, [...allowed]));
    }
    const rows = await s.db.select().from(shifts).where(and(...conds)).orderBy(asc(shifts.startsAt)).limit(1000);
    return { items: await serializeShifts(s.db, rows) };
  });

  app.post('/orgs/:orgId/shifts', {
    schema: {
      tags: ['shifts'], security: secured, params: orgParams, summary: 'Schedule a shift (managers). repeatWeeks keeps local wall time across DST.',
      body: z.object({
        locationId: z.uuid(), userId: z.uuid(), role: z.string().trim().min(1).max(80), startsAt: isoDateTime, endsAt: isoDateTime,
        breakMinutes: z.number().int().min(0).max(240).default(0), notes: z.string().max(500).optional(), repeatWeeks: z.number().int().min(1).max(12).default(1),
      }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    const loc = await requireManager(req, s.db, orgId, b.locationId);
    await assertWorksAt(s.db, orgId, loc.id, b.userId);
    const startsAt = new Date(b.startsAt), endsAt = new Date(b.endsAt);
    if (endsAt <= startsAt) throw validationError('A shift must end after it starts', { endsAt: 'Must be after startsAt' });
    if (endsAt.getTime() - startsAt.getTime() > 16 * 3600_000) throw validationError('Shifts are limited to 16 hours', { endsAt: 'Too long' });
    const durationMs = endsAt.getTime() - startsAt.getTime();
    const local = localDateParts(startsAt, loc.timeZone);
    const values = Array.from({ length: b.repeatWeeks }, (_, i) => {
      const st = i === 0 ? startsAt : zonedToUtc(addDays(local.date, 7 * i), local.time, loc.timeZone);
      return { organizationId: orgId, locationId: loc.id, userId: b.userId, role: b.role, startsAt: st, endsAt: new Date(st.getTime() + durationMs), breakMinutes: b.breakMinutes, notes: b.notes ?? null, createdBy: req.user!.id };
    });
    for (const v of values) await assertNoOverlap(s.db, b.userId, v.startsAt, v.endsAt);
    const rows = await s.db.transaction(async (tx) => {
      const rows = await tx.insert(shifts).values(values).returning();
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'shift.scheduled', scopeKind: 'location', scopeId: loc.id, targetType: 'shift', targetId: rows[0]!.id, metadata: { userId: b.userId, count: rows.length } });
      return rows;
    });
    return reply.code(201).send({ items: await serializeShifts(s.db, rows) });
  });

  const loadShift = async (orgId: string, id: string) => {
    const [r] = await s.db.select().from(shifts).where(and(eq(shifts.id, id), eq(shifts.organizationId, orgId)));
    if (!r) throw notFound('Shift');
    return r;
  };

  app.patch('/orgs/:orgId/shifts/:id', {
    schema: {
      tags: ['shifts'], security: secured, params: idParams, summary: 'Change a shift (managers)',
      body: z.object({ userId: z.uuid().optional(), role: z.string().trim().min(1).max(80).optional(), startsAt: isoDateTime.optional(), endsAt: isoDateTime.optional(), breakMinutes: z.number().int().min(0).max(240).optional(), notes: z.string().max(500).nullable().optional() }),
    },
  }, async (req) => {
    const sh = await loadShift(req.params.orgId, req.params.id);
    await requireManager(req, s.db, sh.organizationId, sh.locationId);
    if (sh.status !== 'scheduled') throw conflict('shift_cancelled', 'This shift is cancelled');
    const b = req.body;
    const startsAt = b.startsAt ? new Date(b.startsAt) : sh.startsAt;
    const endsAt = b.endsAt ? new Date(b.endsAt) : sh.endsAt;
    if (endsAt <= startsAt) throw validationError('A shift must end after it starts', { endsAt: 'Must be after startsAt' });
    const userId = b.userId ?? sh.userId;
    if (b.userId && b.userId !== sh.userId) await assertWorksAt(s.db, sh.organizationId, sh.locationId, b.userId);
    await assertNoOverlap(s.db, userId, startsAt, endsAt, sh.id);
    const [u] = await s.db.update(shifts).set({ userId, role: b.role ?? sh.role, startsAt, endsAt, breakMinutes: b.breakMinutes ?? sh.breakMinutes, notes: b.notes === undefined ? sh.notes : b.notes, updatedAt: new Date() }).where(eq(shifts.id, sh.id)).returning();
    await audit(s.db, { organizationId: sh.organizationId, ...actor(req), action: 'shift.updated', scopeKind: 'location', scopeId: sh.locationId, targetType: 'shift', targetId: sh.id, metadata: { changes: b } });
    return (await serializeShifts(s.db, [u!]))[0]!;
  });

  app.post('/orgs/:orgId/shifts/:id/cancel', {
    schema: { tags: ['shifts'], security: secured, params: idParams, body: z.object({ reason: z.string().max(300).optional() }).default({}), summary: 'Cancel a shift (managers); pending swaps are cancelled too' },
  }, async (req) => {
    const sh = await loadShift(req.params.orgId, req.params.id);
    await requireManager(req, s.db, sh.organizationId, sh.locationId);
    if (sh.status === 'cancelled') throw conflict('already_cancelled', 'This shift is already cancelled');
    const [u] = await s.db.transaction(async (tx) => {
      await tx.update(shiftSwapRequests).set({ status: 'cancelled' }).where(and(eq(shiftSwapRequests.shiftId, sh.id), eq(shiftSwapRequests.status, 'pending')));
      await audit(tx, { organizationId: sh.organizationId, ...actor(req), action: 'shift.cancelled', scopeKind: 'location', scopeId: sh.locationId, targetType: 'shift', targetId: sh.id, metadata: { reason: req.body.reason } });
      return tx.update(shifts).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(shifts.id, sh.id)).returning();
    });
    return (await serializeShifts(s.db, [u!]))[0]!;
  });

  // ───────── Swaps ─────────
  app.post('/orgs/:orgId/shifts/:id/swap-requests', {
    schema: {
      tags: ['shifts'], security: secured, params: idParams,
      summary: 'Ask to hand your shift to a colleague (optionally taking one of theirs). A manager approves in /approvals.',
      body: z.object({ toUserId: z.uuid(), toShiftId: z.uuid().optional(), reason: z.string().trim().max(300).optional() }),
    },
  }, async (req, reply) => {
    const me = requireUser(req);
    const sh = await loadShift(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, sh.organizationId, sh.locationId, 'operations.read');
    if (sh.userId !== me.id) throw forbidden('You can only request swaps for your own shifts');
    if (sh.status !== 'scheduled') throw conflict('shift_cancelled', 'This shift is cancelled');
    if (sh.startsAt <= new Date()) throw conflict('shift_started', 'This shift has already started');
    if (req.body.toUserId === me.id) throw validationError('Choose a colleague', { toUserId: 'Cannot swap with yourself' });
    await assertWorksAt(s.db, sh.organizationId, sh.locationId, req.body.toUserId);
    let theirs: ShiftRow | null = null;
    if (req.body.toShiftId) {
      theirs = await loadShift(sh.organizationId, req.body.toShiftId);
      if (theirs.userId !== req.body.toUserId || theirs.status !== 'scheduled') throw validationError('That shift is not your colleague’s', { toShiftId: 'Not their scheduled shift' });
    } else {
      // A giveaway must not double-book the colleague.
      await assertNoOverlap(s.db, req.body.toUserId, sh.startsAt, sh.endsAt);
    }
    const [pending] = await s.db.select({ id: shiftSwapRequests.id }).from(shiftSwapRequests).where(and(eq(shiftSwapRequests.shiftId, sh.id), eq(shiftSwapRequests.status, 'pending')));
    if (pending) throw conflict('swap_pending', 'A swap is already waiting for approval for this shift', { swapId: pending.id });
    const [[toUser], [loc]] = await Promise.all([
      s.db.select({ name: users.name }).from(users).where(eq(users.id, req.body.toUserId)),
      s.db.select({ name: locations.name, timeZone: locations.timeZone }).from(locations).where(eq(locations.id, sh.locationId)),
    ]);
    const [meRow] = await s.db.select({ name: users.name }).from(users).where(eq(users.id, me.id));
    const when = new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: loc?.timeZone ?? 'UTC' }).format(sh.startsAt);
    const out = await s.db.transaction(async (tx) => {
      const [sw] = await tx.insert(shiftSwapRequests).values({ organizationId: sh.organizationId, locationId: sh.locationId, shiftId: sh.id, requestedBy: me.id, toUserId: req.body.toUserId, toShiftId: req.body.toShiftId ?? null, reason: req.body.reason ?? null }).returning();
      const ap = await insertApproval(tx, {
        organizationId: sh.organizationId, locationId: sh.locationId, kind: 'shift_swap', targetId: sw!.id, title: `${sh.role} · ${when}`,
        titleI18n: { code: 'shift_swap', params: { role: sh.role, startsAt: sh.startsAt.toISOString(), timeZone: loc?.timeZone ?? 'UTC' } },
        payload: { shiftId: sh.id, toShiftId: req.body.toShiftId ?? null, from: { id: me.id, name: meRow?.name ?? 'Team member' }, to: { id: req.body.toUserId, name: toUser?.name ?? 'Colleague' }, shift: { role: sh.role, startsAt: sh.startsAt.toISOString(), endsAt: sh.endsAt.toISOString(), timeZone: loc?.timeZone ?? 'UTC' } },
        requestedBy: me.id, comment: req.body.reason ?? null,
      }, req.ip);
      await tx.update(shiftSwapRequests).set({ approvalId: ap.id }).where(eq(shiftSwapRequests.id, sw!.id));
      return { sw: { ...sw!, approvalId: ap.id }, ap };
    });
    await notifyApprovers(s, out.ap);
    return reply.code(201).send({ swap: out.sw, approval: (await serializeApprovals(req, s.db, [out.ap]))[0]! });
  });

  app.get('/orgs/:orgId/shift-swaps', {
    schema: { tags: ['shifts'], security: secured, params: orgParams, querystring: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }) },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
    const conds = [eq(shiftSwapRequests.organizationId, orgId)];
    if (req.query.status) conds.push(eq(shiftSwapRequests.status, req.query.status));
    const rows = await s.db.select().from(shiftSwapRequests).where(and(...conds)).orderBy(desc(shiftSwapRequests.createdAt)).limit(200);
    return { items: rows.filter((r) => allowed === 'all' || allowed.has(r.locationId)) };
  });

  // ───────── Time clock ─────────
  const openClock = async (userId: string) => {
    const [last] = await s.db.select().from(timeClockEvents).where(eq(timeClockEvents.userId, userId)).orderBy(desc(timeClockEvents.at)).limit(1);
    return last?.kind === 'clock_in' ? last : null;
  };

  app.post('/orgs/:orgId/time-clock/clock-in', {
    schema: {
      tags: ['shifts'], security: secured, params: orgParams, summary: 'Clock in at a location (optionally against your shift; up to 60 minutes early)',
      body: z.object({ locationId: z.uuid(), shiftId: z.uuid().optional(), note: z.string().max(300).optional(), source: z.enum(['web', 'mobile', 'kiosk']).default('web') }),
    },
  }, async (req, reply) => {
    const me = requireUser(req);
    const { orgId } = req.params;
    const loc = await requireLocationPerm(req, s.db, orgId, req.body.locationId, 'operations.read');
    if (await openClock(me.id)) throw conflict('already_clocked_in', 'You are already clocked in. Clock out first.');
    let shiftId: string | null = null;
    if (req.body.shiftId) {
      const sh = await loadShift(orgId, req.body.shiftId);
      if (sh.userId !== me.id) throw forbidden('This is not your shift');
      if (sh.locationId !== loc.id) throw validationError('This shift is at another location', { shiftId: 'Wrong location' });
      if (sh.status !== 'scheduled') throw conflict('shift_cancelled', 'This shift is cancelled');
      const now = Date.now();
      if (now < sh.startsAt.getTime() - CLOCK_EARLY_MINUTES * 60_000 || now > sh.endsAt.getTime()) throw conflict('outside_shift_window', `You can clock in from ${CLOCK_EARLY_MINUTES} minutes before the shift until it ends`);
      shiftId = sh.id;
    }
    const [ev] = await s.db.insert(timeClockEvents).values({ organizationId: orgId, locationId: loc.id, userId: me.id, shiftId, kind: 'clock_in', source: req.body.source, note: req.body.note ?? null }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'time_clock.clock_in', scopeKind: 'location', scopeId: loc.id, targetType: 'time_clock_event', targetId: ev!.id, metadata: { shiftId } });
    return reply.code(201).send({ event: { ...ev!, at: ev!.at.toISOString() }, shift: shiftId ? (await serializeShifts(s.db, [await loadShift(orgId, shiftId)]))[0]! : null });
  });

  app.post('/orgs/:orgId/time-clock/clock-out', {
    schema: { tags: ['shifts'], security: secured, params: orgParams, summary: 'Clock out of your open clock-in', body: z.object({ note: z.string().max(300).optional(), source: z.enum(['web', 'mobile', 'kiosk']).default('web') }).default({ source: 'web' }) },
  }, async (req, reply) => {
    const me = requireUser(req);
    const { orgId } = req.params;
    const open = await openClock(me.id);
    if (!open || open.organizationId !== orgId) throw conflict('not_clocked_in', 'You are not clocked in here');
    const [ev] = await s.db.insert(timeClockEvents).values({ organizationId: orgId, locationId: open.locationId, userId: me.id, shiftId: open.shiftId, kind: 'clock_out', source: req.body.source, note: req.body.note ?? null }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'time_clock.clock_out', scopeKind: 'location', scopeId: open.locationId, targetType: 'time_clock_event', targetId: ev!.id, metadata: { shiftId: open.shiftId, minutes: Math.round((ev!.at.getTime() - open.at.getTime()) / 60_000) } });
    return reply.code(201).send({ event: { ...ev!, at: ev!.at.toISOString() }, workedMinutes: Math.round((ev!.at.getTime() - open.at.getTime()) / 60_000), shift: open.shiftId ? (await serializeShifts(s.db, [await loadShift(orgId, open.shiftId)]))[0]! : null });
  });

  app.get('/orgs/:orgId/time-clock', {
    schema: {
      tags: ['shifts'], security: secured, params: orgParams, summary: 'Timesheet entries (clock-in/out pairs). Managers see their locations; staff see their own.',
      querystring: z.object({ locationId: z.uuid().optional(), from: isoDateTime.optional(), to: isoDateTime.optional() }),
    },
  }, async (req) => {
    const me = requireUser(req);
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
    const managerAt = await authorisedLocations(req, s.db, orgId, 'locations.read');
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86400_000);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const conds = [eq(timeClockEvents.organizationId, orgId), gte(timeClockEvents.at, from), lt(timeClockEvents.at, to)];
    if (req.query.locationId) conds.push(eq(timeClockEvents.locationId, req.query.locationId));
    const rows = (await s.db.select().from(timeClockEvents).where(and(...conds)).orderBy(asc(timeClockEvents.at)).limit(2000))
      .filter((e) => (allowed === 'all' || allowed.has(e.locationId)) && (e.userId === me.id || managerAt === 'all' || managerAt.has(e.locationId)));
    const names = rows.length ? await s.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.userId))])) : [];
    const entries: Array<{ userId: string; userName: string; locationId: string; shiftId: string | null; clockInAt: string; clockOutAt: string | null; minutes: number | null }> = [];
    for (const e of rows) {
      if (e.kind === 'clock_in') entries.push({ userId: e.userId, userName: names.find((n) => n.id === e.userId)?.name ?? 'Team member', locationId: e.locationId, shiftId: e.shiftId, clockInAt: e.at.toISOString(), clockOutAt: null, minutes: null });
      else {
        const open = [...entries].reverse().find((x) => x.userId === e.userId && !x.clockOutAt);
        if (open) Object.assign(open, { clockOutAt: e.at.toISOString(), minutes: Math.round((e.at.getTime() - new Date(open.clockInAt).getTime()) / 60_000) });
      }
    }
    return { items: entries.reverse() };
  });

  // ───────── Signed-in staff: my shifts across organisations ─────────
  app.get('/me/shifts', {
    schema: { tags: ['me'], security: secured, summary: 'My shifts (all organisations) with clock status, plus any open clock-in', querystring: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional() }) },
  }, async (req) => {
    const me = requireUser(req);
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 12 * 3600_000);
    const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 7 * 86400_000);
    const rows = await s.db.select().from(shifts).where(and(eq(shifts.userId, me.id), eq(shifts.status, 'scheduled'), lt(shifts.startsAt, to), gt(shifts.endsAt, from))).orderBy(asc(shifts.startsAt)).limit(200);
    const open = await openClock(me.id);
    const orgIds = [...new Set(rows.map((r) => r.organizationId))];
    const orgs = orgIds.length ? await s.db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, orgIds)) : [];
    return {
      items: (await serializeShifts(s.db, rows)).map((x) => ({ ...x, organizationName: orgs.find((o) => o.id === x.organizationId)?.name ?? null })),
      openClock: open ? { organizationId: open.organizationId, locationId: open.locationId, shiftId: open.shiftId, at: open.at.toISOString() } : null,
    };
  });
};

import { and, asc, count, eq, gt, inArray, isNull, lt, ne } from 'drizzle-orm';
import { z } from 'zod';
import { publicContactSchema, registrationStates } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { attendance, customers, guardianRelationships, locations, programmes, registrations, seasons, teams, trainingSessions, users } from '../db/schema/index.ts';
import { AppError, conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requireLocationPerm } from '../services/authz.ts';
import { findOrCreateCustomer } from '../services/customers.ts';
import { createPaymentForTarget } from '../services/payments.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Age in whole years on a reference date (eligibility uses the programme's cutoff date). */
export function ageOn(dob: string, on: string): number {
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  const [ry, rm, rd] = on.split('-').map(Number) as [number, number, number];
  return ry - y - (rm < m || (rm === m && rd < d) ? 1 : 0);
}

export const sportsRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  app.get('/public/sports/:locationId/programmes', { schema: { tags: ['sports'], params: z.object({ locationId: z.uuid() }) } }, async (req) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, req.params.locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    const rows = await s.db.select().from(programmes).where(and(eq(programmes.locationId, loc.id), eq(programmes.status, 'published')));
    const taken = rows.length ? await s.db.select({ id: registrations.programmeId, c: count() }).from(registrations).where(and(inArray(registrations.programmeId, rows.map((r) => r.id)), inArray(registrations.status, ['accepted', 'awaiting_review']))).groupBy(registrations.programmeId) : [];
    return {
      location: { id: loc.id, name: loc.name, timeZone: loc.timeZone },
      items: rows.map((p) => ({ ...p, fee: { amount: p.feeMinor, currency: p.currency }, spotsLeft: p.capacity === null ? null : Math.max(0, p.capacity - (taken.find((t) => t.id === p.id)?.c ?? 0)) })),
    };
  });

  app.post('/public/sports/programmes/:id/registrations', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['sports'], summary: 'Guardian registers a participant. Payment never implies team selection when review is required.', params: z.object({ id: z.uuid() }),
      body: z.object({ guardian: publicContactSchema, participant: z.object({ name: z.string().min(1), dateOfBirth: dateStr }), relationship: z.string().default('parent'), forms: z.record(z.string(), z.unknown()).default({}), acceptRefundPolicy: z.literal(true) }),
    },
  }, async (req, reply) => {
    const [p] = await s.db.select().from(programmes).where(and(eq(programmes.id, req.params.id), eq(programmes.status, 'published')));
    if (!p) throw notFound('Programme');
    const now = new Date();
    if ((p.registrationOpensAt && p.registrationOpensAt > now) || (p.registrationClosesAt && p.registrationClosesAt < now)) throw conflict('registration_closed', 'Registration is not open for this programme');
    const on = p.ageCutoffDate ?? now.toISOString().slice(0, 10);
    const age = ageOn(req.body.participant.dateOfBirth, on);
    if ((p.ageMin !== null && age < p.ageMin) || (p.ageMax !== null && age > p.ageMax)) {
      throw validationError(`This programme is for ages ${p.ageMin ?? 0}–${p.ageMax ?? '∞'} on ${on}`, { 'participant.dateOfBirth': `Participant would be ${age}` });
    }
    const res = await s.db.transaction(async (tx) => {
      const guardian = await findOrCreateCustomer(tx, p.organizationId, p.locationId, req.body.guardian, 'registration');
      const [participant] = await tx.insert(customers).values({ organizationId: p.organizationId, locationId: p.locationId, name: req.body.participant.name, dateOfBirth: req.body.participant.dateOfBirth }).returning();
      await tx.insert(guardianRelationships).values({ organizationId: p.organizationId, guardianCustomerId: guardian.id, participantCustomerId: participant!.id, relationship: req.body.relationship }).onConflictDoNothing();
      const [{ c } = { c: 0 }] = await tx.select({ c: count() }).from(registrations).where(and(eq(registrations.programmeId, p.id), inArray(registrations.status, ['accepted', 'awaiting_review'])));
      const full = p.capacity !== null && c >= p.capacity;
      const status = full ? 'waitlisted' : p.feeMinor > 0 ? 'submitted' : p.requiresApproval ? 'awaiting_review' : 'accepted';
      const [r] = await tx.insert(registrations).values({ organizationId: p.organizationId, locationId: p.locationId, programmeId: p.id, participantCustomerId: participant!.id, guardianCustomerId: guardian.id, status, forms: req.body.forms }).returning();
      await audit(tx, { organizationId: p.organizationId, actorUserId: null, actorType: 'system', action: 'registration.submitted', scopeKind: 'location', scopeId: p.locationId, targetType: 'registration', targetId: r!.id, metadata: { status } });
      return r!;
    });
    let payment = null;
    if (res.status === 'submitted' && p.feeMinor > 0) {
      const pay = await createPaymentForTarget(s, { organizationId: p.organizationId, locationId: p.locationId, amountMinor: p.feeMinor, currency: p.currency, targetType: 'registration', targetId: res.id, description: `Registration: ${p.name}` });
      await s.db.update(registrations).set({ paymentId: pay.payment.id }).where(eq(registrations.id, res.id));
      payment = { id: pay.payment.id, clientSecret: pay.clientSecret, amount: p.feeMinor, currency: p.currency, sandbox: pay.sandbox };
    }
    const nextStep = res.status === 'waitlisted' ? 'The programme is full; you are on the waitlist.' : p.requiresApproval ? 'Your registration will be reviewed. Payment does not confirm a place until it is accepted.' : 'Registration accepted.';
    return reply.code(201).send({ registration: res, payment, nextStep, refundPolicy: p.refundPolicy });
  });

  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    priv.get('/orgs/:orgId/sports/programmes', { schema: { tags: ['sports'], security: secured, params: orgParams } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = await s.db.select().from(programmes).where(eq(programmes.organizationId, req.params.orgId));
      return { items: rows.filter((p) => allowed === 'all' || allowed.has(p.locationId)) };
    });

    priv.post('/orgs/:orgId/sports/programmes', {
      schema: {
        tags: ['sports'], security: secured, params: orgParams,
        body: z.object({ locationId: z.uuid(), name: z.string().min(1), description: z.string().optional(), ageMin: z.number().int().min(0).optional(), ageMax: z.number().int().max(120).optional(), ageCutoffDate: dateStr.optional(), capacity: z.number().int().min(1).optional(), feeMinor: z.number().int().min(0).default(0), requiresApproval: z.boolean().default(true), refundPolicy: z.string().optional(), registrationOpensAt: isoDateTime.optional(), registrationClosesAt: isoDateTime.optional(), status: z.enum(['draft', 'published']).default('draft') }),
      },
    }, async (req, reply) => {
      const b = req.body;
      const l = await requireLocationPerm(req, s.db, req.params.orgId, b.locationId, 'operations.write');
      if (b.feeMinor > 0 && !b.refundPolicy) throw validationError('Paid programmes must show a refund/withdrawal policy before checkout', { refundPolicy: 'Required for paid programmes' });
      const [row] = await s.db.insert(programmes).values({
        organizationId: req.params.orgId, locationId: l.id, name: b.name, description: b.description ?? null, ageMin: b.ageMin ?? null, ageMax: b.ageMax ?? null, ageCutoffDate: b.ageCutoffDate ?? null,
        capacity: b.capacity ?? null, feeMinor: b.feeMinor, currency: l.currency, requiresApproval: b.requiresApproval, refundPolicy: b.refundPolicy ?? null,
        registrationOpensAt: b.registrationOpensAt ? new Date(b.registrationOpensAt) : null, registrationClosesAt: b.registrationClosesAt ? new Date(b.registrationClosesAt) : null, status: b.status,
      }).returning();
      return reply.code(201).send(row);
    });

    priv.post('/orgs/:orgId/sports/programmes/:id/seasons', { schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ name: z.string().min(1), startsOn: dateStr, endsOn: dateStr }) } }, async (req, reply) => {
      const [p] = await s.db.select().from(programmes).where(and(eq(programmes.id, req.params.id), eq(programmes.organizationId, req.params.orgId)));
      if (!p) throw notFound('Programme');
      await requireLocationPerm(req, s.db, p.organizationId, p.locationId, 'operations.write');
      if (req.body.endsOn < req.body.startsOn) throw validationError('Season ends before it starts', { endsOn: 'Must be after startsOn' });
      const [row] = await s.db.insert(seasons).values({ organizationId: p.organizationId, programmeId: p.id, ...req.body }).returning();
      return reply.code(201).send(row);
    });

    priv.get('/orgs/:orgId/sports/teams', { schema: { tags: ['sports'], security: secured, params: orgParams } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = await s.db.select().from(teams).where(eq(teams.organizationId, req.params.orgId));
      return { items: rows.filter((t) => allowed === 'all' || allowed.has(t.locationId)) };
    });

    priv.post('/orgs/:orgId/sports/teams', { schema: { tags: ['sports'], security: secured, params: orgParams, body: z.object({ programmeId: z.uuid(), seasonId: z.uuid().optional(), name: z.string().min(1), coachUserId: z.uuid().optional(), capacity: z.number().int().min(1).optional() }) } }, async (req, reply) => {
      const [p] = await s.db.select().from(programmes).where(and(eq(programmes.id, req.body.programmeId), eq(programmes.organizationId, req.params.orgId)));
      if (!p) throw notFound('Programme');
      await requireLocationPerm(req, s.db, p.organizationId, p.locationId, 'operations.write');
      const [row] = await s.db.insert(teams).values({ organizationId: p.organizationId, locationId: p.locationId, programmeId: p.id, seasonId: req.body.seasonId ?? null, name: req.body.name, coachUserId: req.body.coachUserId ?? null, capacity: req.body.capacity ?? null }).returning();
      return reply.code(201).send(row);
    });

    priv.get('/orgs/:orgId/sports/registrations', {
      schema: { tags: ['sports'], security: secured, params: orgParams, querystring: z.object({ programmeId: z.uuid().optional(), status: z.enum(registrationStates).optional() }) },
    }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
      const conds = [eq(registrations.organizationId, req.params.orgId)];
      if (req.query.programmeId) conds.push(eq(registrations.programmeId, req.query.programmeId));
      if (req.query.status) conds.push(eq(registrations.status, req.query.status));
      if (allowed !== 'all') {
        if (!allowed.size) return { items: [] };
        conds.push(inArray(registrations.locationId, [...allowed]));
      }
      const rows = await s.db.select({ r: registrations, participant: { id: customers.id, name: customers.name, dateOfBirth: customers.dateOfBirth } }).from(registrations).innerJoin(customers, eq(customers.id, registrations.participantCustomerId)).where(and(...conds)).orderBy(asc(registrations.createdAt));
      return { items: rows.map((x) => ({ ...x.r, participant: x.participant })) };
    });

    priv.post('/orgs/:orgId/sports/registrations/:id/review', {
      schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ decision: z.enum(['accept', 'waitlist', 'reject']), teamId: z.uuid().optional(), note: z.string().max(1000).optional() }) },
    }, async (req) => {
      const [r] = await s.db.select().from(registrations).where(and(eq(registrations.id, req.params.id), eq(registrations.organizationId, req.params.orgId)));
      if (!r) throw notFound('Registration');
      await requireLocationPerm(req, s.db, r.organizationId, r.locationId, 'operations.write');
      if (!['awaiting_review', 'waitlisted', 'submitted'].includes(r.status)) throw conflict('not_reviewable', `Registration is ${r.status}`);
      if (r.status === 'submitted' && r.paymentId) throw conflict('payment_pending', 'Payment for this registration has not completed');
      if (req.body.teamId) {
        const [t] = await s.db.select().from(teams).where(and(eq(teams.id, req.body.teamId), eq(teams.programmeId, r.programmeId)));
        if (!t) throw validationError('Team is not part of this programme', { teamId: 'Invalid team' });
      }
      const status = req.body.decision === 'accept' ? 'accepted' : req.body.decision === 'waitlist' ? 'waitlisted' : 'rejected';
      const [u] = await s.db.update(registrations).set({ status, teamId: req.body.decision === 'accept' ? req.body.teamId ?? r.teamId : null, reviewedBy: req.user!.id, reviewNote: req.body.note ?? null, updatedAt: new Date() }).where(eq(registrations.id, r.id)).returning();
      await audit(s.db, { organizationId: r.organizationId, ...actor(req), action: `registration.${status}`, scopeKind: 'location', scopeId: r.locationId, targetType: 'registration', targetId: r.id });
      return u;
    });

    priv.post('/orgs/:orgId/sports/teams/:id/sessions', { schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ startsAt: isoDateTime, endsAt: isoDateTime, venue: z.string().optional(), kind: z.enum(['training', 'fixture']).default('training') }) } }, async (req, reply) => {
      const [t] = await s.db.select().from(teams).where(and(eq(teams.id, req.params.id), eq(teams.organizationId, req.params.orgId)));
      if (!t) throw notFound('Team');
      await requireLocationPerm(req, s.db, t.organizationId, t.locationId, 'operations.write');
      const startsAt = new Date(req.body.startsAt), endsAt = new Date(req.body.endsAt);
      if (endsAt <= startsAt) throw validationError('Session must end after it starts', { endsAt: 'Invalid' });
      const clashes = req.body.venue ? await s.db.select({ id: trainingSessions.id, teamId: trainingSessions.teamId }).from(trainingSessions)
        .where(and(eq(trainingSessions.locationId, t.locationId), eq(trainingSessions.venue, req.body.venue), lt(trainingSessions.startsAt, endsAt), gt(trainingSessions.endsAt, startsAt))) : [];
      const [row] = await s.db.insert(trainingSessions).values({ organizationId: t.organizationId, locationId: t.locationId, teamId: t.id, startsAt, endsAt, venue: req.body.venue ?? null, kind: req.body.kind }).returning();
      return reply.code(201).send({ session: row, venueConflicts: clashes });
    });

    priv.get('/orgs/:orgId/sports/sessions', {
      schema: {
        tags: ['sports'], security: secured, params: orgParams,
        summary: 'Training sessions and fixtures (schedule) with attendance summary and venue conflict indicator. Coaches see the teams they coach.',
        querystring: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional(), teamId: z.uuid().optional(), locationId: z.uuid().optional(), kind: z.enum(['training', 'fixture']).optional() }),
      },
    }, async (req) => {
      const { orgId } = req.params;
      const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
      const managerAt = await authorisedLocations(req, s.db, orgId, 'locations.read');
      const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 86400_000);
      const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 15 * 86400_000);
      const conds = [eq(trainingSessions.organizationId, orgId), lt(trainingSessions.startsAt, to), gt(trainingSessions.endsAt, from)];
      if (req.query.teamId) conds.push(eq(trainingSessions.teamId, req.query.teamId));
      if (req.query.locationId) conds.push(eq(trainingSessions.locationId, req.query.locationId));
      if (req.query.kind) conds.push(eq(trainingSessions.kind, req.query.kind));
      const rows = (await s.db.select({ s: trainingSessions, t: teams, p: { id: programmes.id, name: programmes.name }, l: { id: locations.id, name: locations.name, timeZone: locations.timeZone } })
        .from(trainingSessions).innerJoin(teams, eq(teams.id, trainingSessions.teamId)).innerJoin(programmes, eq(programmes.id, teams.programmeId)).innerJoin(locations, eq(locations.id, trainingSessions.locationId))
        .where(and(...conds)).orderBy(asc(trainingSessions.startsAt)).limit(500))
        .filter((r) => (allowed === 'all' || allowed.has(r.s.locationId)) && (managerAt === 'all' || managerAt.has(r.s.locationId) || r.t.coachUserId === req.user!.id));
      if (!rows.length) return { items: [] };
      const teamIds = [...new Set(rows.map((r) => r.t.id))];
      const sessionIds = rows.map((r) => r.s.id);
      const [rosterCounts, marks, coaches] = await Promise.all([
        s.db.select({ teamId: registrations.teamId, n: count() }).from(registrations).where(and(inArray(registrations.teamId, teamIds), eq(registrations.status, 'accepted'))).groupBy(registrations.teamId),
        s.db.select({ sessionId: attendance.sessionId, status: attendance.status, n: count() }).from(attendance).where(inArray(attendance.sessionId, sessionIds)).groupBy(attendance.sessionId, attendance.status),
        s.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.t.coachUserId).filter((x): x is string => !!x))].concat(['00000000-0000-0000-0000-000000000000']))),
      ]);
      // Venue conflicts: any other scheduled session at the same location + venue overlapping in time (all teams, not just visible ones).
      const venueRows = await s.db.select({ id: trainingSessions.id, locationId: trainingSessions.locationId, venue: trainingSessions.venue, startsAt: trainingSessions.startsAt, endsAt: trainingSessions.endsAt, teamName: teams.name })
        .from(trainingSessions).innerJoin(teams, eq(teams.id, trainingSessions.teamId))
        .where(and(eq(trainingSessions.organizationId, orgId), lt(trainingSessions.startsAt, to), gt(trainingSessions.endsAt, from), ne(trainingSessions.status, 'cancelled')));
      return {
        items: rows.map(({ s: x, t, p, l }) => {
          const m = marks.filter((k) => k.sessionId === x.id);
          const by = (st: string) => m.find((k) => k.status === st)?.n ?? 0;
          const conflicts = x.venue && x.status !== 'cancelled' ? venueRows.filter((v) => v.id !== x.id && v.locationId === x.locationId && v.venue === x.venue && v.startsAt < x.endsAt && v.endsAt > x.startsAt) : [];
          return {
            id: x.id, kind: x.kind, status: x.status, startsAt: x.startsAt.toISOString(), endsAt: x.endsAt.toISOString(), venue: x.venue,
            location: l, team: { id: t.id, name: t.name, coach: t.coachUserId ? { id: t.coachUserId, name: coaches.find((c) => c.id === t.coachUserId)?.name ?? 'Coach' } : null }, programme: p,
            rosterCount: rosterCounts.find((r) => r.teamId === t.id)?.n ?? 0,
            attendance: { recorded: m.reduce((a, k) => a + k.n, 0), present: by('present'), absent: by('absent'), late: by('late'), excused: by('excused') },
            venueConflict: conflicts.length > 0, conflicts: conflicts.map((c) => ({ sessionId: c.id, teamName: c.teamName, startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString() })),
          };
        }),
      };
    });

    const coachGuard = async (req: Parameters<typeof hasPerm>[0], t: typeof teams.$inferSelect) => {
      await requireLocationPerm(req, s.db, t.organizationId, t.locationId, 'operations.write');
      // Staff (coaches) only see and record for teams they coach; managers see all teams in their scope.
      const manager = await hasPerm(req, s.db, 'locations.read', { organizationId: t.organizationId, kind: 'location', id: t.locationId });
      if (!manager && t.coachUserId !== req.user!.id) throw forbidden('You are not the coach of this team');
    };

    priv.get('/orgs/:orgId/sports/sessions/:id/roster', { schema: { tags: ['sports'], security: secured, params: idParams } }, async (req) => {
      const [sess] = await s.db.select({ s: trainingSessions, t: teams }).from(trainingSessions).innerJoin(teams, eq(teams.id, trainingSessions.teamId)).where(and(eq(trainingSessions.id, req.params.id), eq(trainingSessions.organizationId, req.params.orgId)));
      if (!sess) throw notFound('Session');
      await coachGuard(req, sess.t);
      const roster = await s.db.select({ id: customers.id, name: customers.name }).from(registrations).innerJoin(customers, eq(customers.id, registrations.participantCustomerId)).where(and(eq(registrations.teamId, sess.t.id), eq(registrations.status, 'accepted')));
      const marks = await s.db.select().from(attendance).where(eq(attendance.sessionId, sess.s.id));
      return { session: sess.s, team: { id: sess.t.id, name: sess.t.name }, roster: roster.map((p) => ({ ...p, attendance: marks.find((m) => m.participantCustomerId === p.id)?.status ?? null })) };
    });

    priv.post('/orgs/:orgId/sports/sessions/:id/attendance', {
      schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ marks: z.array(z.object({ participantId: z.uuid(), status: z.enum(['present', 'absent', 'late', 'excused']), note: z.string().max(300).optional() })).min(1) }) },
    }, async (req) => {
      const [sess] = await s.db.select({ s: trainingSessions, t: teams }).from(trainingSessions).innerJoin(teams, eq(teams.id, trainingSessions.teamId)).where(and(eq(trainingSessions.id, req.params.id), eq(trainingSessions.organizationId, req.params.orgId)));
      if (!sess) throw notFound('Session');
      await coachGuard(req, sess.t);
      const roster = new Set((await s.db.select({ id: registrations.participantCustomerId }).from(registrations).where(and(eq(registrations.teamId, sess.t.id), eq(registrations.status, 'accepted')))).map((r) => r.id));
      const notOnRoster = req.body.marks.filter((m) => !roster.has(m.participantId));
      if (notOnRoster.length) throw new AppError(400, 'not_on_roster', 'Some participants are not on this team roster', Object.fromEntries(notOnRoster.map((m) => [m.participantId, 'Not on roster'])));
      for (const m of req.body.marks) {
        const v = { organizationId: sess.s.organizationId, locationId: sess.s.locationId, sessionId: sess.s.id, participantCustomerId: m.participantId, status: m.status, note: m.note ?? null, recordedBy: req.user!.id, recordedAt: new Date() };
        await s.db.insert(attendance).values(v).onConflictDoUpdate({ target: [attendance.sessionId, attendance.participantCustomerId], set: v });
      }
      return { recorded: req.body.marks.length };
    });
  });
};

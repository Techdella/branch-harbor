/**
 * Sports schedule: recurring training, fixtures (kick-off in the location time zone), rescheduling,
 * cancellations (only the affected group's guardians are notified) and venue-conflict resolutions.
 */
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { locations, sportsScheduleProposals, sportsSessionSeries, sportsVenues, teams, trainingSessions } from '../db/schema/index.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { localDateParts } from '../lib/tz.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { requireDirector, requireTeamAccess, runInstalmentReminders } from '../services/sports-core.ts';
import { notifyTeam } from '../services/sports-notify.ts';
import { findVenueConflicts, localSlot, recurrenceDates, suggestResolutions } from '../services/sports-schedule.ts';
import { idParams, secured } from './_common.ts';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const sportsScheduleRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  // Hourly instalment reminders in long-running servers (not in tests).
  if (s.cfg.NODE_ENV !== 'test') {
    const timer = setInterval(() => { runInstalmentReminders(s).catch((err) => s.log.error({ err }, '[sports] reminder sweep failed')); }, 3600_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    const teamWithTz = async (orgId: string, id: string) => {
      const [row] = await s.db.select({ t: teams, tz: locations.timeZone }).from(teams).innerJoin(locations, eq(locations.id, teams.locationId)).where(and(eq(teams.id, id), eq(teams.organizationId, orgId)));
      if (!row) throw notFound('Team');
      return row;
    };
    const venueAt = async (locationId: string, venueId: string | undefined) => {
      if (!venueId) return null;
      const [v] = await s.db.select().from(sportsVenues).where(and(eq(sportsVenues.id, venueId), eq(sportsVenues.locationId, locationId)));
      if (!v) throw validationError('Venue is not at this location', { venueId: 'Invalid venue' });
      return v;
    };
    const sessionWithTeam = async (orgId: string, id: string) => {
      const [row] = await s.db.select({ s: trainingSessions, t: teams, tz: locations.timeZone }).from(trainingSessions).innerJoin(teams, eq(teams.id, trainingSessions.teamId)).innerJoin(locations, eq(locations.id, trainingSessions.locationId)).where(and(eq(trainingSessions.id, id), eq(trainingSessions.organizationId, orgId)));
      if (!row) throw notFound('Session');
      return row;
    };

    priv.post('/orgs/:orgId/sports/teams/:id/recurring-sessions', {
      schema: {
        tags: ['sports'], security: secured, params: idParams, summary: 'Generate weekly training in local wall-clock time (DST-safe). Clashing dates are reported; `skipConflicts` leaves them out.',
        body: z.object({ weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7), startTime: timeStr, durationMinutes: z.number().int().min(15).max(480), from: dateStr, until: dateStr, venueId: z.uuid().optional(), skipDates: z.array(dateStr).max(100).default([]), skipConflicts: z.boolean().default(false), dryRun: z.boolean().default(false) }),
      },
    }, async (req, reply) => {
      const { t, tz } = await teamWithTz(req.params.orgId, req.params.id);
      await requireDirector(req, s.db, t.organizationId, t.locationId);
      const b = req.body;
      if (b.until < b.from) throw validationError('The end date is before the start date', { until: 'Invalid' });
      const v = await venueAt(t.locationId, b.venueId);
      const dates = recurrenceDates(b.from, b.until, b.weekdays, b.skipDates);
      if (!dates.length) throw validationError('No dates match those weekdays', { weekdays: 'No matching dates' });
      const plan = [];
      for (const d of dates) {
        const slot = localSlot(d, b.startTime, b.durationMinutes, tz);
        const conflicts = v ? await findVenueConflicts(s.db, { organizationId: t.organizationId, locationId: t.locationId, venueId: v.id, venueName: v.name, ...slot }) : [];
        plan.push({ date: d, ...slot, conflicts });
      }
      const toCreate = plan.filter((p) => !(b.skipConflicts && p.conflicts.length));
      if (b.dryRun) return reply.send({ dryRun: true, timeZone: tz, sessions: plan.map((p) => ({ date: p.date, startsAt: p.startsAt.toISOString(), endsAt: p.endsAt.toISOString(), conflicts: p.conflicts })) });
      const created = await s.db.transaction(async (tx) => {
        const [series] = await tx.insert(sportsSessionSeries).values({ organizationId: t.organizationId, teamId: t.id, weekdays: b.weekdays, startTime: b.startTime, durationMinutes: b.durationMinutes, fromDate: b.from, untilDate: b.until, venueId: v?.id ?? null, createdBy: req.user!.id }).returning();
        const rows = toCreate.length ? await tx.insert(trainingSessions).values(toCreate.map((p) => ({ organizationId: t.organizationId, locationId: t.locationId, teamId: t.id, startsAt: p.startsAt, endsAt: p.endsAt, venue: v?.name ?? null, venueId: v?.id ?? null, kind: 'training', seriesId: series!.id }))).returning() : [];
        await audit(tx, { organizationId: t.organizationId, ...actor(req), action: 'sports.series_created', scopeKind: 'location', scopeId: t.locationId, targetType: 'team', targetId: t.id, metadata: { sessions: rows.length, skipped: plan.length - rows.length } });
        return { series: series!, rows };
      });
      return reply.code(201).send({ seriesId: created.series.id, timeZone: tz, created: created.rows.length, skipped: plan.filter((p) => b.skipConflicts && p.conflicts.length).map((p) => p.date), conflicts: plan.filter((p) => p.conflicts.length).map((p) => ({ date: p.date, conflicts: p.conflicts })) });
    });

    priv.post('/orgs/:orgId/sports/teams/:id/fixtures', {
      schema: {
        tags: ['sports'], security: secured, params: idParams, summary: 'Add a fixture. Kick-off is entered in the location\'s local time. Home fixtures use a venue resource (conflict-checked); away fixtures name the ground.',
        body: z.object({ opponent: z.string().min(1).max(120), homeAway: z.enum(['home', 'away', 'neutral']), date: dateStr, kickoff: timeStr, durationMinutes: z.number().int().min(20).max(300).default(90), venueId: z.uuid().optional(), venueName: z.string().max(120).optional(), competition: z.string().max(120).optional(), notes: z.string().max(500).optional(), notify: z.boolean().default(true) })
          .refine((b) => b.homeAway !== 'home' || !!b.venueId, { message: 'Home fixtures need one of your venues', path: ['venueId'] })
          .refine((b) => b.homeAway === 'home' || !!(b.venueName || b.venueId), { message: 'Name the ground for away/neutral fixtures', path: ['venueName'] }),
      },
    }, async (req, reply) => {
      const { t, tz } = await teamWithTz(req.params.orgId, req.params.id);
      await requireTeamAccess(req, s.db, t);
      const b = req.body;
      const v = await venueAt(t.locationId, b.venueId);
      const slot = localSlot(b.date, b.kickoff, b.durationMinutes, tz);
      const conflicts = v ? await findVenueConflicts(s.db, { organizationId: t.organizationId, locationId: t.locationId, venueId: v.id, venueName: v.name, ...slot }) : [];
      const [row] = await s.db.insert(trainingSessions).values({ organizationId: t.organizationId, locationId: t.locationId, teamId: t.id, ...slot, venue: v?.name ?? b.venueName ?? null, venueId: v?.id ?? null, kind: 'fixture', opponent: b.opponent, homeAway: b.homeAway, competition: b.competition ?? null, notes: b.notes ?? null }).returning();
      await audit(s.db, { organizationId: t.organizationId, ...actor(req), action: 'sports.fixture_created', scopeKind: 'location', scopeId: t.locationId, targetType: 'training_session', targetId: row!.id, metadata: { opponent: b.opponent } });
      const delivery = b.notify ? await notifyTeam(s, t, { kind: 'schedule_changed', subject: `${t.name}: new fixture vs ${b.opponent}`, body: `${t.name} play ${b.opponent} (${b.homeAway}) on ${b.date}, kick-off ${b.kickoff} (${tz}) at ${row!.venue ?? 'TBC'}.`, refType: 'training_session', refId: row!.id }) : null;
      return reply.code(201).send({ session: row, kickoffLocal: { date: b.date, time: b.kickoff, timeZone: tz }, venueConflicts: conflicts, delivery });
    });

    priv.patch('/orgs/:orgId/sports/sessions/:id', {
      schema: { tags: ['sports'], security: secured, params: idParams, summary: 'Reschedule (local date/time) or change venue/opponent. Guardians of that group only are notified.', body: z.object({ date: dateStr.optional(), startTime: timeStr.optional(), durationMinutes: z.number().int().min(15).max(480).optional(), venueId: z.uuid().nullable().optional(), venueName: z.string().max(120).optional(), opponent: z.string().max(120).optional(), notes: z.string().max(500).optional(), notify: z.boolean().default(true), allowConflict: z.boolean().default(false) }) },
    }, async (req) => {
      const { s: sess, t, tz } = await sessionWithTeam(req.params.orgId, req.params.id);
      await requireDirector(req, s.db, t.organizationId, t.locationId);
      if (sess.status === 'cancelled') throw conflict('session_cancelled', 'Cancelled sessions cannot be changed');
      const b = req.body;
      const local = localDateParts(sess.startsAt, tz);
      const dur = b.durationMinutes ?? Math.round((sess.endsAt.getTime() - sess.startsAt.getTime()) / 60_000);
      const slot = localSlot(b.date ?? local.date, b.startTime ?? local.time, dur, tz);
      const v = b.venueId === null ? null : b.venueId ? await venueAt(t.locationId, b.venueId) : sess.venueId ? (await s.db.select().from(sportsVenues).where(eq(sportsVenues.id, sess.venueId)))[0] ?? null : null;
      const venueName = v?.name ?? (b.venueId === null ? b.venueName ?? null : b.venueName ?? sess.venue);
      const conflicts = await findVenueConflicts(s.db, { organizationId: t.organizationId, locationId: t.locationId, venueId: v?.id ?? null, venueName, ...slot, excludeSessionIds: [sess.id] });
      if (conflicts.length && !b.allowConflict) throw conflict('venue_conflict', 'That venue is booked at this time', { conflicts });
      const [row] = await s.db.update(trainingSessions).set({ ...slot, venueId: v?.id ?? null, venue: venueName, opponent: b.opponent ?? sess.opponent, notes: b.notes ?? sess.notes }).where(eq(trainingSessions.id, sess.id)).returning();
      await audit(s.db, { organizationId: t.organizationId, ...actor(req), action: 'sports.session_rescheduled', scopeKind: 'location', scopeId: t.locationId, targetType: 'training_session', targetId: sess.id, metadata: { from: sess.startsAt.toISOString(), to: slot.startsAt.toISOString() } });
      const nl = localDateParts(slot.startsAt, tz);
      const delivery = b.notify ? await notifyTeam(s, t, { kind: 'schedule_changed', subject: `${t.name}: ${sess.kind} moved`, body: `${t.name}'s ${sess.kind} on ${local.date} at ${local.time} is now on ${nl.date} at ${nl.time} (${tz}) at ${venueName ?? 'TBC'}.`, refType: 'training_session', refId: sess.id }) : null;
      return { session: row, conflicts, delivery };
    });

    priv.post('/orgs/:orgId/sports/sessions/:id/cancel', {
      schema: { tags: ['sports'], security: secured, params: idParams, summary: 'Cancel one session. Only guardians of that group (roster or squad) are notified — never network-wide.', body: z.object({ reason: z.string().min(3).max(300), notify: z.boolean().default(true) }) },
    }, async (req) => {
      const { s: sess, t, tz } = await sessionWithTeam(req.params.orgId, req.params.id);
      await requireTeamAccess(req, s.db, t);
      if (sess.status === 'cancelled') throw conflict('already_cancelled', 'This session is already cancelled');
      const [row] = await s.db.update(trainingSessions).set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: req.body.reason }).where(eq(trainingSessions.id, sess.id)).returning();
      await s.db.update(sportsScheduleProposals).set({ status: 'dismissed', decidedAt: new Date() }).where(and(eq(sportsScheduleProposals.sessionId, sess.id), eq(sportsScheduleProposals.status, 'proposed')));
      await audit(s.db, { organizationId: t.organizationId, ...actor(req), action: 'sports.session_cancelled', scopeKind: 'location', scopeId: t.locationId, targetType: 'training_session', targetId: sess.id, metadata: { reason: req.body.reason } });
      const l = localDateParts(sess.startsAt, tz);
      const delivery = req.body.notify ? await notifyTeam(s, t, { kind: 'session_cancelled', subject: `${t.name}: ${sess.kind} cancelled (${l.date})`, body: `${t.name}'s ${sess.kind} on ${l.date} at ${l.time} (${tz}) is cancelled. Reason: ${req.body.reason}`, refType: 'training_session', refId: sess.id }) : null;
      return { session: row, delivery };
    });

    priv.get('/orgs/:orgId/sports/sessions/:id/resolutions', {
      schema: { tags: ['sports'], security: secured, params: idParams, summary: 'Current venue conflicts and suggested resolutions (free venue at the same time, or a small time shift). Suggestions are stored as proposals; nothing changes until one is applied.' },
    }, async (req) => {
      const { s: sess, t, tz } = await sessionWithTeam(req.params.orgId, req.params.id);
      await requireTeamAccess(req, s.db, t, 'operations.read');
      const conflicts = await findVenueConflicts(s.db, { organizationId: sess.organizationId, locationId: sess.locationId, venueId: sess.venueId, venueName: sess.venue, startsAt: sess.startsAt, endsAt: sess.endsAt, excludeSessionIds: [sess.id] });
      if (!conflicts.length || sess.status === 'cancelled') return { conflicts: [], proposals: [] };
      const candidates = await suggestResolutions(s.db, sess, tz);
      await s.db.delete(sportsScheduleProposals).where(and(eq(sportsScheduleProposals.sessionId, sess.id), eq(sportsScheduleProposals.status, 'proposed'), eq(sportsScheduleProposals.source, 'rules')));
      if (candidates.length) await s.db.insert(sportsScheduleProposals).values(candidates.map((c) => ({ organizationId: sess.organizationId, sessionId: sess.id, source: 'rules', proposal: { kind: c.kind, venueId: c.venueId, venueName: c.venueName, startsAt: c.startsAt, endsAt: c.endsAt }, rationale: c.summary, createdBy: req.user!.id })));
      const proposals = await s.db.select().from(sportsScheduleProposals).where(and(eq(sportsScheduleProposals.sessionId, sess.id), eq(sportsScheduleProposals.status, 'proposed'))).orderBy(asc(sportsScheduleProposals.createdAt));
      return { conflicts, timeZone: tz, proposals: proposals.map((p) => ({ ...p, local: { start: localDateParts(new Date(p.proposal.startsAt), tz).time, date: localDateParts(new Date(p.proposal.startsAt), tz).date } })) };
    });

    priv.post('/orgs/:orgId/sports/schedule-proposals/:id/apply', {
      schema: { tags: ['sports'], security: secured, params: idParams, summary: 'Apply a proposed resolution (re-checked for conflicts). Guardians of the moved group are notified.', body: z.object({ notify: z.boolean().default(true) }) },
    }, async (req) => {
      const [p] = await s.db.select().from(sportsScheduleProposals).where(and(eq(sportsScheduleProposals.id, req.params.id), eq(sportsScheduleProposals.organizationId, req.params.orgId)));
      if (!p) throw notFound('Proposal');
      if (p.status !== 'proposed') throw conflict('proposal_closed', `Proposal is ${p.status}`);
      const { s: sess, t, tz } = await sessionWithTeam(req.params.orgId, p.sessionId);
      await requireDirector(req, s.db, t.organizationId, t.locationId);
      const startsAt = new Date(p.proposal.startsAt), endsAt = new Date(p.proposal.endsAt);
      const clashes = await findVenueConflicts(s.db, { organizationId: sess.organizationId, locationId: sess.locationId, venueId: p.proposal.venueId, venueName: p.proposal.venueName, startsAt, endsAt, excludeSessionIds: [sess.id] });
      if (clashes.length) throw conflict('venue_conflict', 'That slot is no longer free', { conflicts: clashes });
      const [row] = await s.db.update(trainingSessions).set({ startsAt, endsAt, venueId: p.proposal.venueId, venue: p.proposal.venueName }).where(eq(trainingSessions.id, sess.id)).returning();
      await s.db.update(sportsScheduleProposals).set({ status: 'applied', decidedBy: req.user!.id, decidedAt: new Date() }).where(eq(sportsScheduleProposals.id, p.id));
      await s.db.update(sportsScheduleProposals).set({ status: 'dismissed', decidedAt: new Date() }).where(and(eq(sportsScheduleProposals.sessionId, sess.id), eq(sportsScheduleProposals.status, 'proposed')));
      await audit(s.db, { organizationId: t.organizationId, ...actor(req), action: 'sports.resolution_applied', scopeKind: 'location', scopeId: t.locationId, targetType: 'training_session', targetId: sess.id, metadata: { proposalId: p.id, source: p.source } });
      const was = localDateParts(sess.startsAt, tz), now = localDateParts(startsAt, tz);
      const delivery = req.body.notify ? await notifyTeam(s, t, { kind: 'schedule_changed', subject: `${t.name}: ${sess.kind} updated`, body: `${t.name}'s ${sess.kind} on ${was.date} (${was.time}) is now at ${now.time} (${tz}) at ${p.proposal.venueName ?? 'TBC'}.`, refType: 'training_session', refId: sess.id }) : null;
      return { session: row, delivery };
    });

    priv.post('/orgs/:orgId/sports/schedule-proposals/:id/dismiss', { schema: { tags: ['sports'], security: secured, params: idParams } }, async (req) => {
      const [p] = await s.db.select().from(sportsScheduleProposals).where(and(eq(sportsScheduleProposals.id, req.params.id), eq(sportsScheduleProposals.organizationId, req.params.orgId)));
      if (!p) throw notFound('Proposal');
      const { t } = await sessionWithTeam(req.params.orgId, p.sessionId);
      await requireDirector(req, s.db, t.organizationId, t.locationId);
      await s.db.update(sportsScheduleProposals).set({ status: 'dismissed', decidedBy: req.user!.id, decidedAt: new Date() }).where(eq(sportsScheduleProposals.id, p.id));
      return { id: p.id, status: 'dismissed' };
    });
  });
};


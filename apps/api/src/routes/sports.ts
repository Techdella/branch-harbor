import { and, asc, count, desc, eq, gt, inArray, isNull, lt, ne } from 'drizzle-orm';
import { z } from 'zod';
import { checkAgeEligibility, eligibleBirthDates, publicContactSchema, registrationStates, splitInstalments, sportsAbsenceReasons, type SportsAgeRule } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  attendance, customers, guardianRelationships, locations, paymentReferences, programmes, registrations, seasons, sportsFeeAdjustments, sportsInstalments, sportsRestrictedAnswers,
  sportsSquadMembers, sportsTeamCoaches, sportsVenues, teams, trainingSessions, users,
} from '../db/schema/index.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { sha256 } from '../lib/crypto.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requireLocationPerm } from '../services/authz.ts';
import {
  balanceOf, coachTeamIds, feePlansFor, formQuestions, formsComplete, placesHeld, programmeAgeRule, registerParticipant, requireTeamAccess, retryRegistrationPayment, reviewRegistration, todayIn,
} from '../services/sports-core.ts';
import { guardiansOf, notifyGuardians } from '../services/sports-notify.ts';
import { localDateParts } from '../lib/tz.ts';
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

  app.get('/public/sports/:locationId/programmes', {
    schema: { tags: ['sports'], summary: 'Programme catalogue: ages (rule + eligible birth dates), venues, fees, payment options, registration questions and refund policy. Optional age filter by date of birth.', params: z.object({ locationId: z.uuid() }), querystring: z.object({ dob: dateStr.optional() }) },
  }, async (req) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, req.params.locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    const today = todayIn(loc.timeZone);
    const rows = await s.db.select().from(programmes).where(and(eq(programmes.locationId, loc.id), eq(programmes.status, 'published'))).orderBy(asc(programmes.ageMin), asc(programmes.name));
    const venues = await s.db.select().from(sportsVenues).where(eq(sportsVenues.locationId, loc.id));
    const seasonRows = await s.db.select().from(seasons).where(eq(seasons.locationId, loc.id));
    const items = [];
    for (const p of rows) {
      const { rule, cutoffDate } = await programmeAgeRule(s.db, p, today);
      const eligibility = req.query.dob ? checkAgeEligibility({ dateOfBirth: req.query.dob, rule, cutoffDate, ageMin: p.ageMin, ageMax: p.ageMax }) : null;
      if (eligibility && !eligibility.eligible) continue;
      const held = await placesHeld(s.db, p.id);
      const plans = await feePlansFor(s.db, p.id);
      const { questions } = await formQuestions(s.db, p);
      const season = seasonRows.find((x) => x.id === p.seasonId);
      items.push({
        ...p, fee: { amount: p.feeMinor, currency: p.currency }, spotsLeft: p.capacity === null ? null : Math.max(0, p.capacity - held),
        age: { rule, cutoffDate, birthDates: eligibleBirthDates(rule as SportsAgeRule, cutoffDate, p.ageMin, p.ageMax) }, eligibility,
        season: season ? { id: season.id, name: season.name, startsOn: season.startsOn, endsOn: season.endsOn } : null,
        venues: venues.filter((v) => p.venueIds.includes(v.id)).map((v) => ({ id: v.id, name: v.name, kind: v.kind })),
        paymentOptions: plans.map((pl) => ({ id: pl.id, name: pl.name, kind: pl.kind, instalments: pl.kind === 'instalments' && p.feeMinor > 0 ? splitInstalments(p.feeMinor, pl.schedule.map((st, i) => ({ dueOn: i === 0 || st.dueOn < today ? today : st.dueOn, shareBps: st.shareBps }))) : [{ seq: 1, dueOn: today, amountMinor: p.feeMinor }] })),
        questions: questions.map((q) => ({ key: q.key, label: q.label, type: q.type, required: q.required, options: q.options ?? null, category: q.category, help: q.help ?? null, restricted: q.category === 'medical' || q.category === 'emergency' })),
        siblingDiscountPercent: p.siblingDiscountBps / 100,
      });
    }
    return { location: { id: loc.id, name: loc.name, timeZone: loc.timeZone, currency: loc.currency, country: loc.country }, today, items };
  });

  app.post('/public/sports/programmes/:id/registrations', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['sports'], summary: 'Guardian registers a participant (age, capacity, form answers, payment option). Payment never implies team selection when review is required.', params: z.object({ id: z.uuid() }),
      body: z.object({
        guardian: publicContactSchema, participant: z.object({ name: z.string().min(1).max(120), dateOfBirth: dateStr }), relationship: z.string().max(40).default('parent'),
        forms: z.record(z.string(), z.unknown()).default({}), answers: z.record(z.string(), z.unknown()).optional(), feePlanId: z.uuid().optional(),
        acceptRefundPolicy: z.literal(true), absenceAlerts: z.boolean().optional(),
      }),
    },
  }, async (req, reply) => {
    const b = req.body;
    const r = await registerParticipant(s, { programmeId: req.params.id, guardian: b.guardian, participant: b.participant, relationship: b.relationship, answers: b.answers ?? b.forms, feePlanId: b.feePlanId, acceptRefundPolicy: b.acceptRefundPolicy, absenceAlerts: b.absenceAlerts, source: 'web' });
    return reply.code(201).send({ registration: { id: r.registration.id, status: r.registration.status, totalFee: { amount: r.registration.totalFeeMinor, currency: r.registration.currency }, holdExpiresAt: r.registration.holdExpiresAt?.toISOString() ?? null }, payment: r.payment, instalments: r.instalments, nextStep: r.nextStep, refundPolicy: r.refundPolicy, manageToken: r.manageToken, ageGroup: r.ageGroup });
  });

  app.post('/public/sports/registrations/:id/pay', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['sports'], summary: 'Retry or resume payment with the registration manage token. Capacity is re-checked; a full programme moves the registration to the waitlist instead.', params: z.object({ id: z.uuid() }), body: z.object({ manageToken: z.string().min(10), instalmentId: z.uuid().optional() }) },
  }, async (req) => {
    const [reg] = await s.db.select().from(registrations).where(eq(registrations.id, req.params.id));
    if (!reg || !reg.manageTokenHash || reg.manageTokenHash !== sha256(req.body.manageToken)) throw notFound('Registration');
    return retryRegistrationPayment(s, reg.id, req.body.instalmentId ?? null);
  });

  app.get('/public/sports/registrations/:id', { schema: { tags: ['sports'], params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) } }, async (req) => {
    const [reg] = await s.db.select({ r: registrations, p: programmes, l: locations }).from(registrations).innerJoin(programmes, eq(programmes.id, registrations.programmeId)).innerJoin(locations, eq(locations.id, registrations.locationId)).where(eq(registrations.id, req.params.id));
    if (!reg || reg.r.manageTokenHash !== sha256(req.query.token)) throw notFound('Registration');
    const inst = await s.db.select().from(sportsInstalments).where(eq(sportsInstalments.registrationId, reg.r.id)).orderBy(asc(sportsInstalments.seq));
    const today = todayIn(reg.l.timeZone);
    return { id: reg.r.id, status: reg.r.status, programme: reg.p.name, requiresApproval: reg.p.requiresApproval, balance: balanceOf(inst, today), holdExpiresAt: reg.r.holdExpiresAt?.toISOString() ?? null };
  });

  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    priv.get('/orgs/:orgId/sports/programmes', { schema: { tags: ['sports'], security: secured, params: orgParams } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = (await s.db.select().from(programmes).where(eq(programmes.organizationId, req.params.orgId)).orderBy(asc(programmes.name))).filter((p) => allowed === 'all' || allowed.has(p.locationId));
      const ids = rows.map((p) => p.id);
      const counts = ids.length ? await s.db.select({ id: registrations.programmeId, status: registrations.status, n: count() }).from(registrations).where(inArray(registrations.programmeId, ids)).groupBy(registrations.programmeId, registrations.status) : [];
      const seasonRows = await s.db.select().from(seasons).where(eq(seasons.organizationId, req.params.orgId));
      return {
        items: rows.map((p) => {
          const c = (st: string) => counts.find((x) => x.id === p.id && x.status === st)?.n ?? 0;
          const season = seasonRows.find((x) => x.id === p.seasonId);
          return { ...p, season: season ? { id: season.id, name: season.name, startsOn: season.startsOn, endsOn: season.endsOn } : null, counts: { accepted: c('accepted'), awaitingReview: c('awaiting_review'), submitted: c('submitted'), waitlisted: c('waitlisted'), withdrawn: c('withdrawn') } };
        }),
      };
    });

    priv.post('/orgs/:orgId/sports/programmes', {
      schema: {
        tags: ['sports'], security: secured, params: orgParams,
        body: z.object({ locationId: z.uuid(), name: z.string().min(1), description: z.string().optional(), ageMin: z.number().int().min(0).optional(), ageMax: z.number().int().max(120).optional(), ageCutoffDate: dateStr.optional(), capacity: z.number().int().min(1).optional(), feeMinor: z.number().int().min(0).default(0), requiresApproval: z.boolean().default(true), refundPolicy: z.string().optional(), registrationOpensAt: isoDateTime.optional(), registrationClosesAt: isoDateTime.optional(), status: z.enum(['draft', 'published']).default('draft'), seasonId: z.uuid().optional(), ageRule: z.enum(['age_on_date', 'birth_year']).optional() }),
      },
    }, async (req, reply) => {
      const b = req.body;
      const l = await requireLocationPerm(req, s.db, req.params.orgId, b.locationId, 'operations.write');
      if (b.feeMinor > 0 && !b.refundPolicy) throw validationError('Paid programmes must show a refund/withdrawal policy before checkout', { refundPolicy: 'Required for paid programmes' });
      const [row] = await s.db.insert(programmes).values({
        organizationId: req.params.orgId, locationId: l.id, name: b.name, description: b.description ?? null, ageMin: b.ageMin ?? null, ageMax: b.ageMax ?? null, ageCutoffDate: b.ageCutoffDate ?? null,
        capacity: b.capacity ?? null, feeMinor: b.feeMinor, currency: l.currency, requiresApproval: b.requiresApproval, refundPolicy: b.refundPolicy ?? null,
        registrationOpensAt: b.registrationOpensAt ? new Date(b.registrationOpensAt) : null, registrationClosesAt: b.registrationClosesAt ? new Date(b.registrationClosesAt) : null, status: b.status,
        seasonId: b.seasonId ?? null, ageRule: b.ageRule ?? 'age_on_date',
      }).returning();
      return reply.code(201).send(row);
    });

    priv.post('/orgs/:orgId/sports/programmes/:id/seasons', { schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ name: z.string().min(1), startsOn: dateStr, endsOn: dateStr }) } }, async (req, reply) => {
      const [p] = await s.db.select().from(programmes).where(and(eq(programmes.id, req.params.id), eq(programmes.organizationId, req.params.orgId)));
      if (!p) throw notFound('Programme');
      await requireLocationPerm(req, s.db, p.organizationId, p.locationId, 'operations.write');
      if (req.body.endsOn < req.body.startsOn) throw validationError('Season ends before it starts', { endsOn: 'Must be after startsOn' });
      const [row] = await s.db.insert(seasons).values({ organizationId: p.organizationId, programmeId: p.id, locationId: p.locationId, ...req.body }).returning();
      return reply.code(201).send(row);
    });

    priv.get('/orgs/:orgId/sports/teams', { schema: { tags: ['sports'], security: secured, params: orgParams, querystring: z.object({ programmeId: z.uuid().optional(), mine: z.coerce.boolean().optional() }) } }, async (req) => {
      const { orgId } = req.params;
      const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
      const managerAt = await authorisedLocations(req, s.db, orgId, 'locations.read');
      const mineIds = await coachTeamIds(s.db, orgId, req.user!.id);
      const rows = (await s.db.select().from(teams).where(and(eq(teams.organizationId, orgId), isNull(teams.archivedAt), req.query.programmeId ? eq(teams.programmeId, req.query.programmeId) : undefined)).orderBy(asc(teams.name)))
        .filter((t) => (allowed === 'all' || allowed.has(t.locationId)) && (req.query.mine ? mineIds.has(t.id) : managerAt === 'all' || managerAt.has(t.locationId) || mineIds.has(t.id)));
      const ids = rows.map((t) => t.id);
      const [roster, squad, asst] = ids.length ? await Promise.all([
        s.db.select({ id: registrations.teamId, n: count() }).from(registrations).where(and(inArray(registrations.teamId, ids), eq(registrations.status, 'accepted'))).groupBy(registrations.teamId),
        s.db.select({ id: sportsSquadMembers.teamId, n: count() }).from(sportsSquadMembers).where(inArray(sportsSquadMembers.teamId, ids)).groupBy(sportsSquadMembers.teamId),
        s.db.select({ teamId: sportsTeamCoaches.teamId, userId: sportsTeamCoaches.userId, name: users.name }).from(sportsTeamCoaches).innerJoin(users, eq(users.id, sportsTeamCoaches.userId)).where(inArray(sportsTeamCoaches.teamId, ids)),
      ]) : [[], [], []];
      const headIds = [...new Set(rows.map((t) => t.coachUserId).filter((x): x is string => !!x))];
      const heads = headIds.length ? await s.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, headIds)) : [];
      return {
        items: rows.map((t) => ({
          ...t, rosterCount: t.kind === 'squad' ? squad.find((x) => x.id === t.id)?.n ?? 0 : roster.find((x) => x.id === t.id)?.n ?? 0,
          coach: t.coachUserId ? { id: t.coachUserId, name: heads.find((h) => h.id === t.coachUserId)?.name ?? 'Coach' } : null,
          assistants: asst.filter((a) => a.teamId === t.id).map((a) => ({ id: a.userId, name: a.name })), youCoach: mineIds.has(t.id),
        })),
      };
    });

    priv.post('/orgs/:orgId/sports/teams', { schema: { tags: ['sports'], security: secured, params: orgParams, body: z.object({ programmeId: z.uuid(), seasonId: z.uuid().optional(), name: z.string().min(1), coachUserId: z.uuid().optional(), capacity: z.number().int().min(1).optional(), kind: z.enum(['team', 'group', 'squad']).default('team'), homeVenueId: z.uuid().optional() }) } }, async (req, reply) => {
      const [p] = await s.db.select().from(programmes).where(and(eq(programmes.id, req.body.programmeId), eq(programmes.organizationId, req.params.orgId)));
      if (!p) throw notFound('Programme');
      await requireLocationPerm(req, s.db, p.organizationId, p.locationId, 'operations.write');
      const [row] = await s.db.insert(teams).values({ organizationId: p.organizationId, locationId: p.locationId, programmeId: p.id, seasonId: req.body.seasonId ?? p.seasonId ?? null, name: req.body.name, coachUserId: req.body.coachUserId ?? null, capacity: req.body.capacity ?? null, kind: req.body.kind, homeVenueId: req.body.homeVenueId ?? null }).returning();
      return reply.code(201).send(row);
    });

    priv.get('/orgs/:orgId/sports/registrations', {
      schema: { tags: ['sports'], security: secured, params: orgParams, querystring: z.object({ programmeId: z.uuid().optional(), status: z.enum(registrationStates).optional(), locationId: z.uuid().optional() }) },
    }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
      const conds = [eq(registrations.organizationId, req.params.orgId)];
      if (req.query.programmeId) conds.push(eq(registrations.programmeId, req.query.programmeId));
      if (req.query.status) conds.push(eq(registrations.status, req.query.status));
      if (req.query.locationId) conds.push(eq(registrations.locationId, req.query.locationId));
      if (allowed !== 'all') {
        if (!allowed.size) return { items: [] };
        conds.push(inArray(registrations.locationId, [...allowed]));
      }
      const rows = await s.db.select({ r: registrations, participant: { id: customers.id, name: customers.name, dateOfBirth: customers.dateOfBirth }, p: { id: programmes.id, name: programmes.name, ageRule: programmes.ageRule, ageCutoffDate: programmes.ageCutoffDate, requiresApproval: programmes.requiresApproval, registrationFormId: programmes.registrationFormId }, l: { timeZone: locations.timeZone } })
        .from(registrations).innerJoin(customers, eq(customers.id, registrations.participantCustomerId)).innerJoin(programmes, eq(programmes.id, registrations.programmeId)).innerJoin(locations, eq(locations.id, registrations.locationId))
        .where(and(...conds)).orderBy(asc(registrations.createdAt)).limit(1000);
      if (!rows.length) return { items: [] };
      const ids = rows.map((x) => x.r.id);
      const guardianIds = [...new Set(rows.map((x) => x.r.guardianCustomerId).filter((g): g is string => !!g))];
      const [gs, rels, inst, adj, restricted, pays] = await Promise.all([
        guardianIds.length ? s.db.select({ id: customers.id, name: customers.name, email: customers.email }).from(customers).where(inArray(customers.id, guardianIds)) : [],
        s.db.select().from(guardianRelationships).where(inArray(guardianRelationships.participantCustomerId, rows.map((x) => x.participant.id))),
        s.db.select().from(sportsInstalments).where(inArray(sportsInstalments.registrationId, ids)),
        s.db.select().from(sportsFeeAdjustments).where(inArray(sportsFeeAdjustments.registrationId, ids)),
        s.db.select({ registrationId: sportsRestrictedAnswers.registrationId, keys: sportsRestrictedAnswers.answers }).from(sportsRestrictedAnswers).where(inArray(sportsRestrictedAnswers.registrationId, ids)),
        s.db.select({ id: paymentReferences.id, state: paymentReferences.state }).from(paymentReferences).where(and(eq(paymentReferences.organizationId, req.params.orgId), eq(paymentReferences.targetType, 'registration'), inArray(paymentReferences.targetId, ids))),
      ]);
      const now = new Date();
      const qCache = new Map<string, Awaited<ReturnType<typeof formQuestions>>['questions']>();
      const items = [];
      for (const x of rows) {
        const key = x.p.registrationFormId ?? 'builtin';
        if (!qCache.has(key)) qCache.set(key, (await formQuestions(s.db, { registrationFormId: x.p.registrationFormId } as typeof programmes.$inferSelect)).questions);
        const today = todayIn(x.l.timeZone, now);
        const g = gs.find((y) => y.id === x.r.guardianCustomerId);
        const rel = rels.find((y) => y.participantCustomerId === x.participant.id && y.guardianCustomerId === x.r.guardianCustomerId);
        const ii = inst.filter((i) => i.registrationId === x.r.id);
        const restrictedKeys = Object.keys(restricted.find((y) => y.registrationId === x.r.id)?.keys ?? {});
        const cutoff = x.p.ageCutoffDate ?? today;
        const elig = x.participant.dateOfBirth ? checkAgeEligibility({ dateOfBirth: x.participant.dateOfBirth, rule: (x.p.ageRule as SportsAgeRule) ?? 'age_on_date', cutoffDate: cutoff, ageMin: null, ageMax: null }) : null;
        const lastPay = ii.map((i) => pays.find((p) => p.id === i.paymentId)).filter(Boolean).pop();
        items.push({
          ...x.r, forms: undefined, manageTokenHash: undefined, participant: { ...x.participant, age: elig?.age ?? null, ageGroup: elig?.ageGroup ?? null }, programme: { id: x.p.id, name: x.p.name, requiresApproval: x.p.requiresApproval },
          guardian: g ? { id: g.id, name: g.name, email: g.email, relationshipStatus: rel?.status ?? null, relationship: rel?.relationship ?? null } : null,
          guardiansCount: rels.filter((y) => y.participantCustomerId === x.participant.id && y.status === 'verified').length,
          balance: balanceOf(ii, today), adjustments: adj.filter((a) => a.registrationId === x.r.id).map((a) => ({ id: a.id, kind: a.kind, amount: { amount: a.amountMinor, currency: a.currency }, reason: a.reason })),
          formsComplete: formsComplete(qCache.get(key)!, x.r.forms, restrictedKeys), holdActive: x.r.status === 'submitted' && !!x.r.holdExpiresAt && x.r.holdExpiresAt > now, lastPaymentState: lastPay?.state ?? null,
        });
      }
      return { items };
    });

    priv.post('/orgs/:orgId/sports/registrations/:id/review', {
      schema: { tags: ['sports'], security: secured, params: idParams, summary: 'Director decision. Capacity (programme and team) is re-checked under lock; the guardian is notified.', body: z.object({ decision: z.enum(['accept', 'waitlist', 'reject']), teamId: z.uuid().optional(), note: z.string().max(1000).optional() }) },
    }, async (req) => reviewRegistration(s, req, req.params.orgId, req.params.id, req.body));

    priv.post('/orgs/:orgId/sports/teams/:id/sessions', { schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ startsAt: isoDateTime, endsAt: isoDateTime, venue: z.string().optional(), venueId: z.uuid().optional(), kind: z.enum(['training', 'fixture']).default('training'), opponent: z.string().max(120).optional(), homeAway: z.enum(['home', 'away', 'neutral']).optional() }) } }, async (req, reply) => {
      const [t] = await s.db.select().from(teams).where(and(eq(teams.id, req.params.id), eq(teams.organizationId, req.params.orgId)));
      if (!t) throw notFound('Team');
      await requireLocationPerm(req, s.db, t.organizationId, t.locationId, 'operations.write');
      const startsAt = new Date(req.body.startsAt), endsAt = new Date(req.body.endsAt);
      if (endsAt <= startsAt) throw validationError('Session must end after it starts', { endsAt: 'Invalid' });
      let venueName = req.body.venue ?? null;
      if (req.body.venueId) {
        const [v] = await s.db.select().from(sportsVenues).where(and(eq(sportsVenues.id, req.body.venueId), eq(sportsVenues.locationId, t.locationId)));
        if (!v) throw validationError('Venue is not at this location', { venueId: 'Invalid venue' });
        venueName = v.name;
      }
      const { findVenueConflicts } = await import('../services/sports-schedule.ts');
      const clashes = await findVenueConflicts(s.db, { organizationId: t.organizationId, locationId: t.locationId, venueId: req.body.venueId ?? null, venueName, startsAt, endsAt });
      const [row] = await s.db.insert(trainingSessions).values({ organizationId: t.organizationId, locationId: t.locationId, teamId: t.id, startsAt, endsAt, venue: venueName, venueId: req.body.venueId ?? null, kind: req.body.kind, opponent: req.body.opponent ?? null, homeAway: req.body.homeAway ?? null }).returning();
      return reply.code(201).send({ session: row, venueConflicts: clashes.map((c) => ({ id: c.sessionId, teamId: c.teamId, teamName: c.teamName, startsAt: c.startsAt, endsAt: c.endsAt })) });
    });

    priv.get('/orgs/:orgId/sports/sessions', {
      schema: {
        tags: ['sports'], security: secured, params: orgParams,
        summary: 'Training sessions and fixtures (schedule) with attendance summary and venue conflict indicator. Coaches see the teams they coach (head or assistant).',
        querystring: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional(), teamId: z.uuid().optional(), locationId: z.uuid().optional(), kind: z.enum(['training', 'fixture']).optional(), mine: z.coerce.boolean().optional() }),
      },
    }, async (req) => {
      const { orgId } = req.params;
      const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
      const managerAt = await authorisedLocations(req, s.db, orgId, 'locations.read');
      const mineIds = await coachTeamIds(s.db, orgId, req.user!.id);
      const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 86400_000);
      const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 15 * 86400_000);
      const conds = [eq(trainingSessions.organizationId, orgId), lt(trainingSessions.startsAt, to), gt(trainingSessions.endsAt, from)];
      if (req.query.teamId) conds.push(eq(trainingSessions.teamId, req.query.teamId));
      if (req.query.locationId) conds.push(eq(trainingSessions.locationId, req.query.locationId));
      if (req.query.kind) conds.push(eq(trainingSessions.kind, req.query.kind));
      const rows = (await s.db.select({ s: trainingSessions, t: teams, p: { id: programmes.id, name: programmes.name }, l: { id: locations.id, name: locations.name, timeZone: locations.timeZone } })
        .from(trainingSessions).innerJoin(teams, eq(teams.id, trainingSessions.teamId)).innerJoin(programmes, eq(programmes.id, teams.programmeId)).innerJoin(locations, eq(locations.id, trainingSessions.locationId))
        .where(and(...conds)).orderBy(asc(trainingSessions.startsAt)).limit(800))
        .filter((r) => (allowed === 'all' || allowed.has(r.s.locationId)) && (req.query.mine ? mineIds.has(r.t.id) : managerAt === 'all' || managerAt.has(r.s.locationId) || mineIds.has(r.t.id)));
      if (!rows.length) return { items: [] };
      const teamIds = [...new Set(rows.map((r) => r.t.id))];
      const sessionIds = rows.map((r) => r.s.id);
      const [rosterCounts, squadCounts, marks, coaches, venueList] = await Promise.all([
        s.db.select({ teamId: registrations.teamId, n: count() }).from(registrations).where(and(inArray(registrations.teamId, teamIds), eq(registrations.status, 'accepted'))).groupBy(registrations.teamId),
        s.db.select({ teamId: sportsSquadMembers.teamId, n: count() }).from(sportsSquadMembers).where(inArray(sportsSquadMembers.teamId, teamIds)).groupBy(sportsSquadMembers.teamId),
        s.db.select({ sessionId: attendance.sessionId, status: attendance.status, n: count() }).from(attendance).where(inArray(attendance.sessionId, sessionIds)).groupBy(attendance.sessionId, attendance.status),
        s.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.t.coachUserId).filter((x): x is string => !!x))].concat(['00000000-0000-0000-0000-000000000000']))),
        s.db.select({ id: sportsVenues.id, parentVenueId: sportsVenues.parentVenueId, locationId: sportsVenues.locationId }).from(sportsVenues).where(eq(sportsVenues.organizationId, orgId)),
      ]);
      // Venue conflicts: any other scheduled session at the same location + venue (or related pitch) overlapping in time — all teams, not just visible ones.
      const venueRows = await s.db.select({ id: trainingSessions.id, locationId: trainingSessions.locationId, venue: trainingSessions.venue, venueId: trainingSessions.venueId, startsAt: trainingSessions.startsAt, endsAt: trainingSessions.endsAt, teamName: teams.name })
        .from(trainingSessions).innerJoin(teams, eq(teams.id, trainingSessions.teamId))
        .where(and(eq(trainingSessions.organizationId, orgId), lt(trainingSessions.startsAt, to), gt(trainingSessions.endsAt, from), ne(trainingSessions.status, 'cancelled')));
      const related = (vid: string) => {
        const v = venueList.find((x) => x.id === vid);
        return new Set([vid, ...(v?.parentVenueId ? [v.parentVenueId] : []), ...venueList.filter((c) => c.parentVenueId === vid).map((c) => c.id)]);
      };
      return {
        items: rows.map(({ s: x, t, p, l }) => {
          const m = marks.filter((k) => k.sessionId === x.id);
          const by = (st: string) => m.find((k) => k.status === st)?.n ?? 0;
          const rel = x.venueId ? related(x.venueId) : null;
          const conflicts = (x.venue || x.venueId) && x.status !== 'cancelled' ? venueRows.filter((v) => v.id !== x.id && v.locationId === x.locationId && v.startsAt < x.endsAt && v.endsAt > x.startsAt && (rel && v.venueId ? rel.has(v.venueId) : v.venue === x.venue)) : [];
          const local = localDateParts(x.startsAt, l.timeZone);
          return {
            id: x.id, kind: x.kind, status: x.status, startsAt: x.startsAt.toISOString(), endsAt: x.endsAt.toISOString(), venue: x.venue, venueId: x.venueId, opponent: x.opponent, homeAway: x.homeAway, competition: x.competition, cancelReason: x.cancelReason, seriesId: x.seriesId,
            local: { date: local.date, time: local.time, timeZone: l.timeZone },
            location: l, team: { id: t.id, name: t.name, kind: t.kind, coach: t.coachUserId ? { id: t.coachUserId, name: coaches.find((c) => c.id === t.coachUserId)?.name ?? 'Coach' } : null }, programme: p, youCoach: mineIds.has(t.id),
            rosterCount: t.kind === 'squad' ? squadCounts.find((r) => r.teamId === t.id)?.n ?? 0 : rosterCounts.find((r) => r.teamId === t.id)?.n ?? 0,
            attendance: { recorded: m.reduce((a, k) => a + k.n, 0), present: by('present'), absent: by('absent'), late: by('late'), excused: by('excused') },
            venueConflict: conflicts.length > 0, conflicts: conflicts.map((c) => ({ sessionId: c.id, teamName: c.teamName, startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString() })),
          };
        }),
      };
    });

    const loadSession = async (orgId: string, id: string) => {
      const [sess] = await s.db.select({ s: trainingSessions, t: teams }).from(trainingSessions).innerJoin(teams, eq(teams.id, trainingSessions.teamId)).where(and(eq(trainingSessions.id, id), eq(trainingSessions.organizationId, orgId)));
      if (!sess) throw notFound('Session');
      return sess;
    };

    const rosterOf = async (team: typeof teams.$inferSelect) => {
      if (team.kind === 'squad') return s.db.select({ id: customers.id, name: customers.name, dateOfBirth: customers.dateOfBirth, registrationId: sportsSquadMembers.id }).from(sportsSquadMembers).innerJoin(customers, eq(customers.id, sportsSquadMembers.participantCustomerId)).where(eq(sportsSquadMembers.teamId, team.id)).orderBy(asc(customers.name));
      return s.db.select({ id: customers.id, name: customers.name, dateOfBirth: customers.dateOfBirth, registrationId: registrations.id }).from(registrations).innerJoin(customers, eq(customers.id, registrations.participantCustomerId)).where(and(eq(registrations.teamId, team.id), eq(registrations.status, 'accepted'))).orderBy(asc(customers.name));
    };

    priv.get('/orgs/:orgId/sports/sessions/:id/roster', { schema: { tags: ['sports'], security: secured, params: idParams, summary: 'Authorised roster for a session: names, attendance, guardian-reported absences and coach-visible care notes only.' } }, async (req) => {
      const sess = await loadSession(req.params.orgId, req.params.id);
      const { manager } = await requireTeamAccess(req, s.db, sess.t);
      const roster = await rosterOf(sess.t);
      const marks = await s.db.select().from(attendance).where(eq(attendance.sessionId, sess.s.id));
      // Coach-visible restricted answers (emergency contact, action plan) for this roster only; nothing else.
      const regIds = sess.t.kind === 'squad' ? [] : roster.map((r) => r.registrationId);
      const pIds = roster.map((r) => r.id);
      const care = pIds.length ? await s.db.select().from(sportsRestrictedAnswers).where(sess.t.kind === 'squad' ? inArray(sportsRestrictedAnswers.participantCustomerId, pIds) : inArray(sportsRestrictedAnswers.registrationId, regIds)).orderBy(desc(sportsRestrictedAnswers.updatedAt)) : [];
      if (care.length) await audit(s.db, { organizationId: sess.s.organizationId, ...actor(req), action: 'sports.care_notes_viewed', scopeKind: 'location', scopeId: sess.s.locationId, targetType: 'training_session', targetId: sess.s.id, metadata: { participants: care.length, manager } });
      const [loc] = await s.db.select({ timeZone: locations.timeZone }).from(locations).where(eq(locations.id, sess.s.locationId));
      return {
        session: { ...sess.s, local: localDateParts(sess.s.startsAt, loc!.timeZone), timeZone: loc!.timeZone }, team: { id: sess.t.id, name: sess.t.name, kind: sess.t.kind },
        roster: roster.map((p) => {
          const m = marks.find((k) => k.participantCustomerId === p.id);
          const c = care.find((k) => k.participantCustomerId === p.id);
          const visible = c ? Object.fromEntries(Object.entries(c.answers).filter(([k]) => c.coachVisibleKeys.includes(k))) : {};
          return {
            id: p.id, name: p.name, attendance: m?.status ?? null, absenceReason: m?.absenceReason ?? null, reportedBy: m?.reportedBy ?? null, note: m?.note ?? null,
            care: { emergencyContact: visible.emergency_contact_name ? { name: String(visible.emergency_contact_name), phone: visible.emergency_contact_phone ? String(visible.emergency_contact_phone) : null } : null, actionPlan: visible.medical_action_plan ? String(visible.medical_action_plan) : null, medicalInfoOnFile: !!c && Object.keys(c.answers).some((k) => k === 'medical_notes') },
          };
        }),
      };
    });

    priv.post('/orgs/:orgId/sports/sessions/:id/attendance', {
      schema: {
        tags: ['sports'], security: secured, params: idParams, summary: 'Fast check-in. Unexcused absences notify the participant\'s verified guardians who opted in to absence alerts.',
        body: z.object({ marks: z.array(z.object({ participantId: z.uuid(), status: z.enum(['present', 'absent', 'late', 'excused']), absenceReason: z.enum(sportsAbsenceReasons).optional(), note: z.string().max(300).optional() })).min(1), notifyGuardians: z.boolean().default(true) }),
      },
    }, async (req) => {
      const sess = await loadSession(req.params.orgId, req.params.id);
      await requireTeamAccess(req, s.db, sess.t);
      if (sess.s.status === 'cancelled') throw conflict('session_cancelled', 'This session was cancelled');
      const roster = new Set((await rosterOf(sess.t)).map((r) => r.id));
      const notOnRoster = req.body.marks.filter((m) => !roster.has(m.participantId));
      if (notOnRoster.length) throw new AppError(400, 'not_on_roster', 'Some participants are not on this team roster', Object.fromEntries(notOnRoster.map((m) => [m.participantId, 'Not on roster'])));
      const existing = await s.db.select().from(attendance).where(eq(attendance.sessionId, sess.s.id));
      const toNotify: string[] = [];
      for (const m of req.body.marks) {
        const prev = existing.find((e) => e.participantCustomerId === m.participantId);
        const v = { organizationId: sess.s.organizationId, locationId: sess.s.locationId, sessionId: sess.s.id, participantCustomerId: m.participantId, status: m.status, absenceReason: m.absenceReason ?? (m.status === 'excused' ? prev?.absenceReason ?? null : null), note: m.note ?? prev?.note ?? null, reportedBy: 'coach', recordedBy: req.user!.id, recordedAt: new Date(), guardianNotifiedAt: prev?.guardianNotifiedAt ?? null };
        await s.db.insert(attendance).values(v).onConflictDoUpdate({ target: [attendance.sessionId, attendance.participantCustomerId], set: v });
        // Guardian-reported absences are already known to the family; only unexpected absences notify, once.
        if (m.status === 'absent' && !(prev?.reportedBy === 'guardian') && !prev?.guardianNotifiedAt) toNotify.push(m.participantId);
      }
      let notified = { sent: 0, logged: 0, skipped_consent: 0, failed: 0, recipients: 0 };
      if (req.body.notifyGuardians && toNotify.length) {
        const gs = await guardiansOf(s.db, sess.s.organizationId, toNotify);
        const names = await s.db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, toNotify));
        const [loc] = await s.db.select({ timeZone: locations.timeZone }).from(locations).where(eq(locations.id, sess.s.locationId));
        const when = localDateParts(sess.s.startsAt, loc!.timeZone);
        for (const pid of toNotify) {
          const r = await notifyGuardians(s, {
            organizationId: sess.s.organizationId, locationId: sess.s.locationId, kind: 'absence', subject: `${names.find((n) => n.id === pid)?.name ?? 'Your participant'} was marked absent`,
            body: `${names.find((n) => n.id === pid)?.name ?? 'Your participant'} was marked absent from ${sess.t.name} ${sess.s.kind} on ${when.date} at ${when.time}. If this is unexpected, please contact the club.`,
            refType: 'training_session', refId: sess.s.id, recipients: gs.filter((g) => g.participantId === pid).map((g) => ({ guardianId: g.guardian.id, participantId: pid })),
          });
          notified = { sent: notified.sent + r.sent, logged: notified.logged + r.logged, skipped_consent: notified.skipped_consent + r.skipped_consent, failed: notified.failed + r.failed, recipients: notified.recipients + r.recipients };
        }
        await s.db.update(attendance).set({ guardianNotifiedAt: new Date() }).where(and(eq(attendance.sessionId, sess.s.id), inArray(attendance.participantCustomerId, toNotify)));
      }
      return { recorded: req.body.marks.length, notifiedGuardians: notified.sent + notified.logged, skippedNoConsent: notified.skipped_consent };
    });

    // Back-compat: the earlier participant-level guardian check used by the review screen.
    priv.get('/orgs/:orgId/sports/registrations/:id/eligibility', { schema: { tags: ['sports'], security: secured, params: idParams } }, async (req) => {
      const [r] = await s.db.select({ r: registrations, c: customers, p: programmes, l: locations }).from(registrations).innerJoin(customers, eq(customers.id, registrations.participantCustomerId)).innerJoin(programmes, eq(programmes.id, registrations.programmeId)).innerJoin(locations, eq(locations.id, registrations.locationId)).where(and(eq(registrations.id, req.params.id), eq(registrations.organizationId, req.params.orgId)));
      if (!r) throw notFound('Registration');
      if (!(await hasPerm(req, s.db, 'customers.read', { organizationId: r.r.organizationId, kind: 'location', id: r.r.locationId }))) throw notFound('Registration');
      const { rule, cutoffDate } = await programmeAgeRule(s.db, r.p, todayIn(r.l.timeZone));
      return r.c.dateOfBirth ? checkAgeEligibility({ dateOfBirth: r.c.dateOfBirth, rule, cutoffDate, ageMin: r.p.ageMin, ageMax: r.p.ageMax }) : { eligible: null, reason: 'Date of birth unavailable' };
    });
  });
};

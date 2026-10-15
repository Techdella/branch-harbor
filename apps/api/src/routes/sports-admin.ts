/**
 * Sports administration: season/programme setup wizard, venues, coaches, forms, fee plans, teams and
 * transfers, squad selection, announcements, balances/aid, guardian relationships and disputes,
 * guardian messages, reports and AI drafts.
 */
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { checkAgeEligibility, defaultAgeConvention, eligibleBirthDates, type Role, type SportsAgeRule } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  attendance, customers, guardianRelationships, locations, programmes, registrations, roleAssignments, seasons, sportsAnnouncements, sportsFeeAdjustments, sportsFeePlans, sportsGuardianInvitations,
  sportsInstalments, sportsMessages, sportsNotifications, sportsRegistrationForms, sportsRelationshipDisputes, sportsRestrictedAnswers, sportsScheduleProposals, sportsSelectionEntries, sportsSelections,
  sportsSquadMembers, sportsTeamCoaches, sportsTeamMoves, sportsVenues, teams, trainingSessions, users,
} from '../db/schema/index.ts';
import { hasPermissionInScope, type Assignment } from '../domain/scope.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requireLocationPerm, resolveScopeChain, withEffectiveAccess } from '../services/authz.ts';
import {
  adjustFees, balanceOf, BUILT_IN_QUESTIONS, coachTeamIds, isCoachOf, placesHeld, requireDirector, requireTeamAccess, runInstalmentReminders, serializeInstalment, teamRosterCount, todayIn, withdrawRegistration,
} from '../services/sports-core.ts';
import { inviteGuardian, raiseDispute, resolveDispute } from '../services/sports-guardians.ts';
import { guardiansOf, notifyGuardians, notifyTeam, rosterParticipantIds } from '../services/sports-notify.ts';
import { draftProgrammeDescription, rankConflictResolutions, summariseEnrolment } from '../services/sports-ai.ts';
import { suggestResolutions } from '../services/sports-schedule.ts';
import { idParams, orgParams, secured } from './_common.ts';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const questionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), label: z.string().min(1).max(200), type: z.enum(['text', 'textarea', 'yes_no', 'select', 'phone', 'date', 'consent']), required: z.boolean().default(false),
  options: z.array(z.string().min(1).max(80)).max(20).optional(), category: z.enum(['general', 'medical', 'emergency', 'consent']).default('general'), coachVisible: z.boolean().optional(), help: z.string().max(300).optional(),
});
const planSchema = z.object({ name: z.string().min(1).max(80), kind: z.enum(['full', 'instalments']), schedule: z.array(z.object({ dueOn: dateStr, shareBps: z.number().int().min(1).max(10_000) })).max(12).default([]) })
  .refine((p) => p.kind === 'full' || (p.schedule.length >= 2 && p.schedule.reduce((a, x) => a + x.shareBps, 0) === 10_000), { message: 'Instalment plans need at least two instalments adding up to 100%', path: ['schedule'] });
const programmeSchema = z.object({
  name: z.string().min(1).max(120), description: z.string().max(4000).optional(), kind: z.enum(['programme', 'camp', 'academy', 'league']).default('programme'),
  ageMin: z.number().int().min(0).max(99).optional(), ageMax: z.number().int().min(0).max(99).optional(), ageRule: z.enum(['age_on_date', 'birth_year']).optional(), ageCutoffDate: dateStr.optional(),
  eligibilityNotes: z.string().max(1000).optional(), capacity: z.number().int().min(1).max(5000).optional(), feeMinor: z.number().int().min(0).default(0), requiresApproval: z.boolean().default(true),
  refundPolicy: z.string().max(2000).optional(), registrationOpensAt: z.iso.datetime({ offset: true }).optional(), registrationClosesAt: z.iso.datetime({ offset: true }).optional(),
  venueIds: z.array(z.uuid()).default([]), siblingDiscountBps: z.number().int().min(0).max(5000).default(0), registrationFormId: z.uuid().optional(), holdMinutes: z.number().int().min(5).max(1440).default(30),
  feePlans: z.array(planSchema).max(6).default([]),
  teams: z.array(z.object({ name: z.string().min(1).max(80), capacity: z.number().int().min(1).max(500).optional(), coachUserId: z.uuid().optional(), assistantUserIds: z.array(z.uuid()).default([]), kind: z.enum(['team', 'group', 'squad']).default('team'), homeVenueId: z.uuid().optional() })).max(30).default([]),
});

export const sportsAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    const locIn = async (orgId: string, locationId: string) => {
      const [l] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, orgId)));
      if (!l) throw notFound('Location');
      return l;
    };
    const programmeIn = async (orgId: string, id: string) => {
      const [p] = await s.db.select().from(programmes).where(and(eq(programmes.id, id), eq(programmes.organizationId, orgId)));
      if (!p) throw notFound('Programme');
      return p;
    };
    const teamIn = async (orgId: string, id: string) => {
      const [t] = await s.db.select().from(teams).where(and(eq(teams.id, id), eq(teams.organizationId, orgId)));
      if (!t) throw notFound('Team');
      return t;
    };

    /** Users who can coach at a location: anyone holding operations.write there (staff, managers). */
    const coachCandidates = async (orgId: string, locationId: string) => {
      const rows = await s.db.select({ ra: roleAssignments, u: { id: users.id, name: users.name, email: users.email } }).from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId)).where(and(eq(roleAssignments.organizationId, orgId), isNull(users.deletedAt)));
      const chain = await resolveScopeChain(s.db, { organizationId: orgId, kind: 'location', id: locationId });
      const access = await withEffectiveAccess(s.db, orgId, rows.map((r) => r.ra));
      const byUser = new Map<string, { u: (typeof rows)[number]['u']; a: Assignment[] }>();
      rows.forEach((r, i) => {
        const e = byUser.get(r.u.id) ?? { u: r.u, a: [] };
        e.a.push(access[i]!);
        byUser.set(r.u.id, e);
      });
      return [...byUser.values()].filter((e) => hasPermissionInScope(e.a, 'operations.write', chain)).map((e) => ({ id: e.u.id, name: e.u.name, email: e.u.email, roles: [...new Set(e.a.map((a) => a.role))] }));
    };
    const assertCoaches = async (orgId: string, locationId: string, ids: string[]) => {
      if (!ids.length) return;
      const ok = new Set((await coachCandidates(orgId, locationId)).map((c) => c.id));
      const bad = ids.filter((i) => !ok.has(i));
      if (bad.length) throw validationError('Coaches must have a staff or manager role at this location', { coachUserId: 'Not assigned to this location' });
    };

    /* ---------------- Overview ---------------- */

    priv.get('/orgs/:orgId/sports/overview', {
      schema: { tags: ['sports'], security: secured, params: orgParams, summary: 'Programme overview: enrolment vs capacity, outstanding administrative work and upcoming sessions in scope.', querystring: z.object({ locationId: z.uuid().optional() }) },
    }, async (req) => {
      const { orgId } = req.params;
      const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
      const locs = (await s.db.select().from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt)))).filter((l) => (allowed === 'all' || allowed.has(l.id)) && (!req.query.locationId || l.id === req.query.locationId));
      const ids = locs.map((l) => l.id);
      if (!ids.length) return { programmes: [], work: null, upcoming: [], locations: [] };
      const progs = await s.db.select().from(programmes).where(and(inArray(programmes.locationId, ids), ne(programmes.status, 'archived')));
      const pIds = progs.map((p) => p.id);
      const counts = pIds.length ? await s.db.select({ id: registrations.programmeId, status: registrations.status, n: count() }).from(registrations).where(inArray(registrations.programmeId, pIds)).groupBy(registrations.programmeId, registrations.status) : [];
      const canCustomers = await authorisedLocations(req, s.db, orgId, 'customers.read');
      const custIds = ids.filter((i) => canCustomers === 'all' || canCustomers.has(i));
      const now = new Date();
      const [disputes, selections, overdueRows, upcoming] = await Promise.all([
        s.db.select({ n: count() }).from(sportsRelationshipDisputes).where(and(eq(sportsRelationshipDisputes.organizationId, orgId), eq(sportsRelationshipDisputes.status, 'open'))),
        s.db.select({ n: count() }).from(sportsSelections).where(and(inArray(sportsSelections.locationId, ids), eq(sportsSelections.status, 'proposed'))),
        custIds.length ? s.db.select({ i: sportsInstalments, tz: locations.timeZone }).from(sportsInstalments).innerJoin(locations, eq(locations.id, sportsInstalments.locationId)).innerJoin(registrations, eq(registrations.id, sportsInstalments.registrationId)).where(and(inArray(sportsInstalments.locationId, custIds), eq(sportsInstalments.status, 'scheduled'), inArray(registrations.status, ['accepted', 'awaiting_review']))) : [],
        s.db.select({ s: trainingSessions, t: teams.name, l: { name: locations.name, timeZone: locations.timeZone } }).from(trainingSessions).innerJoin(teams, eq(teams.id, trainingSessions.teamId)).innerJoin(locations, eq(locations.id, trainingSessions.locationId))
          .where(and(inArray(trainingSessions.locationId, ids), gte(trainingSessions.startsAt, now), lt(trainingSessions.startsAt, new Date(now.getTime() + 7 * 86400_000)))).orderBy(asc(trainingSessions.startsAt)).limit(8),
      ]);
      const overdue = overdueRows.filter((r) => r.i.dueOn < todayIn(r.tz, now));
      const c = (pid: string, st: string) => counts.find((x) => x.id === pid && x.status === st)?.n ?? 0;
      return {
        locations: locs.map((l) => ({ id: l.id, name: l.name, timeZone: l.timeZone, currency: l.currency, country: l.country })),
        programmes: await Promise.all(progs.map(async (p) => ({ id: p.id, name: p.name, status: p.status, locationId: p.locationId, capacity: p.capacity, held: await placesHeld(s.db, p.id, now), accepted: c(p.id, 'accepted'), awaitingReview: c(p.id, 'awaiting_review'), awaitingPayment: c(p.id, 'submitted'), waitlisted: c(p.id, 'waitlisted') }))),
        work: {
          awaitingReview: counts.filter((x) => x.status === 'awaiting_review').reduce((a, x) => a + x.n, 0), openDisputes: disputes[0]?.n ?? 0, pendingSelections: selections[0]?.n ?? 0,
          overdueInstalments: custIds.length ? overdue.length : null, overdueByCurrency: custIds.length ? Object.entries(overdue.reduce<Record<string, number>>((a, r) => ({ ...a, [r.i.currency]: (a[r.i.currency] ?? 0) + r.i.amountMinor }), {})).map(([currency, amount]) => ({ currency, amount })) : null,
        },
        upcoming: upcoming.map((u) => ({ id: u.s.id, kind: u.s.kind, status: u.s.status, team: u.t, startsAt: u.s.startsAt.toISOString(), endsAt: u.s.endsAt.toISOString(), venue: u.s.venue, opponent: u.s.opponent, location: u.l })),
      };
    });

    /* ---------------- Seasons, venues, coaches ---------------- */

    priv.get('/orgs/:orgId/sports/seasons', { schema: { tags: ['sports'], security: secured, params: orgParams } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = await s.db.select().from(seasons).where(and(eq(seasons.organizationId, req.params.orgId), isNull(seasons.programmeId))).orderBy(desc(seasons.startsOn));
      return { items: rows.filter((r) => !r.locationId || allowed === 'all' || allowed.has(r.locationId)) };
    });

    priv.get('/orgs/:orgId/sports/age-preview', {
      schema: { tags: ['sports'], security: secured, params: orgParams, summary: 'Default age convention for the location country, and the birth-date range for an age band.', querystring: z.object({ locationId: z.uuid(), startsOn: dateStr, endsOn: dateStr.optional(), rule: z.enum(['age_on_date', 'birth_year']).optional(), cutoffDate: dateStr.optional(), ageMin: z.coerce.number().int().optional(), ageMax: z.coerce.number().int().optional(), dob: dateStr.optional() }) },
    }, async (req) => {
      await requireLocationPerm(req, s.db, req.params.orgId, req.query.locationId, 'operations.read');
      const l = await locIn(req.params.orgId, req.query.locationId);
      const conv = defaultAgeConvention(l.country, req.query.startsOn, req.query.endsOn);
      const rule = req.query.rule ?? conv.rule;
      const cutoffDate = req.query.cutoffDate ?? conv.cutoffDate;
      return { default: conv, rule, cutoffDate, birthDates: eligibleBirthDates(rule, cutoffDate, req.query.ageMin ?? null, req.query.ageMax ?? null), check: req.query.dob ? checkAgeEligibility({ dateOfBirth: req.query.dob, rule, cutoffDate, ageMin: req.query.ageMin ?? null, ageMax: req.query.ageMax ?? null }) : null };
    });

    priv.get('/orgs/:orgId/sports/venues', { schema: { tags: ['sports'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }) } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = await s.db.select().from(sportsVenues).where(and(eq(sportsVenues.organizationId, req.params.orgId), req.query.locationId ? eq(sportsVenues.locationId, req.query.locationId) : undefined)).orderBy(asc(sportsVenues.name));
      return { items: rows.filter((v) => allowed === 'all' || allowed.has(v.locationId)) };
    });

    const venueBody = z.object({ locationId: z.uuid(), name: z.string().min(1).max(80), kind: z.enum(['pitch', 'court', 'hall', 'field', 'pool', 'other']).default('pitch'), surface: z.string().max(40).optional(), parentVenueId: z.uuid().optional(), capacityNote: z.string().max(120).optional() });
    priv.post('/orgs/:orgId/sports/venues', { schema: { tags: ['sports'], security: secured, params: orgParams, body: venueBody } }, async (req, reply) => {
      await requireDirector(req, s.db, req.params.orgId, req.body.locationId);
      if (req.body.parentVenueId) {
        const [p] = await s.db.select().from(sportsVenues).where(and(eq(sportsVenues.id, req.body.parentVenueId), eq(sportsVenues.locationId, req.body.locationId)));
        if (!p) throw validationError('Parent venue must be at the same location', { parentVenueId: 'Invalid' });
      }
      const [row] = await s.db.insert(sportsVenues).values({ organizationId: req.params.orgId, ...req.body }).returning();
      return reply.code(201).send(row);
    });

    priv.patch('/orgs/:orgId/sports/venues/:id', { schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ name: z.string().min(1).max(80).optional(), active: z.boolean().optional(), surface: z.string().max(40).optional(), capacityNote: z.string().max(120).optional() }) } }, async (req) => {
      const [v] = await s.db.select().from(sportsVenues).where(and(eq(sportsVenues.id, req.params.id), eq(sportsVenues.organizationId, req.params.orgId)));
      if (!v) throw notFound('Venue');
      await requireDirector(req, s.db, v.organizationId, v.locationId);
      const [row] = await s.db.update(sportsVenues).set(req.body).where(eq(sportsVenues.id, v.id)).returning();
      return row;
    });

    priv.get('/orgs/:orgId/sports/coaches', { schema: { tags: ['sports'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid() }) } }, async (req) => {
      await requireLocationPerm(req, s.db, req.params.orgId, req.query.locationId, 'operations.read');
      return { items: await coachCandidates(req.params.orgId, req.query.locationId) };
    });

    /* ---------------- Registration forms ---------------- */

    priv.get('/orgs/:orgId/sports/forms', { schema: { tags: ['sports'], security: secured, params: orgParams } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = await s.db.select().from(sportsRegistrationForms).where(eq(sportsRegistrationForms.organizationId, req.params.orgId)).orderBy(asc(sportsRegistrationForms.name));
      return { builtIn: BUILT_IN_QUESTIONS, items: rows.filter((f) => !f.locationId || allowed === 'all' || allowed.has(f.locationId)) };
    });

    priv.post('/orgs/:orgId/sports/forms', { schema: { tags: ['sports'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), name: z.string().min(1).max(120), questions: z.array(questionSchema).max(40) }) } }, async (req, reply) => {
      await requireDirector(req, s.db, req.params.orgId, req.body.locationId);
      const keys = req.body.questions.map((q) => q.key);
      if (new Set(keys).size !== keys.length || keys.some((k) => BUILT_IN_QUESTIONS.some((b) => b.key === k))) throw validationError('Question keys must be unique and not reuse built-in keys', { questions: 'Duplicate key' });
      const [row] = await s.db.insert(sportsRegistrationForms).values({ organizationId: req.params.orgId, locationId: req.body.locationId, name: req.body.name, questions: req.body.questions, createdBy: req.user!.id }).returning();
      return reply.code(201).send(row);
    });

    priv.patch('/orgs/:orgId/sports/forms/:id', { schema: { tags: ['sports'], security: secured, params: idParams, summary: 'Changing questions bumps the version; answers keep the version they were given under.', body: z.object({ name: z.string().min(1).max(120).optional(), questions: z.array(questionSchema).max(40).optional(), status: z.enum(['active', 'archived']).optional() }) } }, async (req) => {
      const [f] = await s.db.select().from(sportsRegistrationForms).where(and(eq(sportsRegistrationForms.id, req.params.id), eq(sportsRegistrationForms.organizationId, req.params.orgId)));
      if (!f) throw notFound('Form');
      if (f.locationId) await requireDirector(req, s.db, f.organizationId, f.locationId);
      const changed = req.body.questions && JSON.stringify(req.body.questions) !== JSON.stringify(f.questions);
      const [row] = await s.db.update(sportsRegistrationForms).set({ ...req.body, version: changed ? f.version + 1 : f.version, updatedAt: new Date() }).where(eq(sportsRegistrationForms.id, f.id)).returning();
      return row;
    });

    /* ---------------- Setup wizard + programmes ---------------- */

    priv.post('/orgs/:orgId/sports/setup', {
      schema: {
        tags: ['sports'], security: secured, params: orgParams, summary: 'Setup wizard: season → programmes (age groups, venues, coaches, capacity, fees + instalment plans, registration window, form) → groups, in one transaction.',
        body: z.object({
          locationId: z.uuid(), season: z.object({ id: z.uuid().optional(), name: z.string().min(1).max(80), startsOn: dateStr, endsOn: dateStr, ageRule: z.enum(['age_on_date', 'birth_year']).optional(), ageCutoffDate: dateStr.optional() }),
          venues: z.array(venueBody.omit({ locationId: true })).max(20).default([]), programmes: z.array(programmeSchema).min(1).max(20), publish: z.boolean().default(false),
        }),
      },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const b = req.body;
      await requireDirector(req, s.db, orgId, b.locationId);
      const l = await locIn(orgId, b.locationId);
      if (b.season.endsOn < b.season.startsOn) throw validationError('Season ends before it starts', { 'season.endsOn': 'Must be after the start' });
      const conv = defaultAgeConvention(l.country, b.season.startsOn, b.season.endsOn);
      const fields: Record<string, string> = {};
      b.programmes.forEach((p, i) => {
        if (p.feeMinor > 0 && !p.refundPolicy?.trim()) fields[`programmes.${i}.refundPolicy`] = 'Paid programmes must show a refund/withdrawal policy before checkout';
        if (p.ageMin !== undefined && p.ageMax !== undefined && p.ageMin > p.ageMax) fields[`programmes.${i}.ageMax`] = 'Maximum age is below the minimum';
        if (p.registrationOpensAt && p.registrationClosesAt && p.registrationClosesAt <= p.registrationOpensAt) fields[`programmes.${i}.registrationClosesAt`] = 'Registration closes before it opens';
        p.feePlans.forEach((pl, k) => pl.schedule.forEach((st) => { if (st.dueOn > b.season.endsOn) fields[`programmes.${i}.feePlans.${k}`] = 'Instalments must be due before the season ends'; }));
      });
      if (Object.keys(fields).length) throw validationError('Some programme details need attention', fields);
      const coachIds = b.programmes.flatMap((p) => p.teams.flatMap((t) => [t.coachUserId, ...t.assistantUserIds].filter((x): x is string => !!x)));
      await assertCoaches(orgId, l.id, [...new Set(coachIds)]);
      const formIds = [...new Set(b.programmes.map((p) => p.registrationFormId).filter((x): x is string => !!x))];
      if (formIds.length) {
        const fs = await s.db.select({ id: sportsRegistrationForms.id }).from(sportsRegistrationForms).where(and(inArray(sportsRegistrationForms.id, formIds), eq(sportsRegistrationForms.organizationId, orgId)));
        if (fs.length !== formIds.length) throw validationError('Unknown registration form', { registrationFormId: 'Not found' });
      }
      const out = await s.db.transaction(async (tx) => {
        let season;
        if (b.season.id) {
          [season] = await tx.update(seasons).set({ name: b.season.name, startsOn: b.season.startsOn, endsOn: b.season.endsOn, ageRule: b.season.ageRule ?? conv.rule, ageCutoffDate: b.season.ageCutoffDate ?? conv.cutoffDate }).where(and(eq(seasons.id, b.season.id), eq(seasons.organizationId, orgId))).returning();
          if (!season) throw notFound('Season');
        } else {
          [season] = await tx.insert(seasons).values({ organizationId: orgId, locationId: l.id, name: b.season.name, startsOn: b.season.startsOn, endsOn: b.season.endsOn, ageRule: b.season.ageRule ?? conv.rule, ageCutoffDate: b.season.ageCutoffDate ?? conv.cutoffDate, status: b.publish ? 'published' : 'draft' }).returning();
        }
        const newVenues = b.venues.length ? await tx.insert(sportsVenues).values(b.venues.map((v) => ({ organizationId: orgId, locationId: l.id, name: v.name, kind: v.kind, surface: v.surface ?? null, capacityNote: v.capacityNote ?? null }))).returning() : [];
        const existingVenues = await tx.select({ id: sportsVenues.id }).from(sportsVenues).where(eq(sportsVenues.locationId, l.id));
        const validVenue = new Set(existingVenues.map((v) => v.id));
        const created = [];
        for (const p of b.programmes) {
          const venueIds = p.venueIds.filter((v) => validVenue.has(v));
          const [prog] = await tx.insert(programmes).values({
            organizationId: orgId, locationId: l.id, seasonId: season!.id, name: p.name, description: p.description ?? null, kind: p.kind, ageMin: p.ageMin ?? null, ageMax: p.ageMax ?? null,
            ageRule: p.ageRule ?? season!.ageRule ?? conv.rule, ageCutoffDate: p.ageCutoffDate ?? season!.ageCutoffDate ?? conv.cutoffDate, eligibilityNotes: p.eligibilityNotes ?? null, capacity: p.capacity ?? null,
            feeMinor: p.feeMinor, currency: l.currency, requiresApproval: p.requiresApproval, refundPolicy: p.refundPolicy ?? null, registrationOpensAt: p.registrationOpensAt ? new Date(p.registrationOpensAt) : null,
            registrationClosesAt: p.registrationClosesAt ? new Date(p.registrationClosesAt) : null, status: b.publish ? 'published' : 'draft', venueIds: venueIds.length ? venueIds : newVenues.map((v) => v.id),
            siblingDiscountBps: p.siblingDiscountBps, registrationFormId: p.registrationFormId ?? null, holdMinutes: p.holdMinutes, refundPolicyVersion: p.refundPolicy ? new Date().toISOString().slice(0, 10) : null,
          }).returning();
          const plans = p.feePlans.length ? p.feePlans : [{ name: 'Pay in full', kind: 'full' as const, schedule: [] }];
          if (p.feeMinor > 0) await tx.insert(sportsFeePlans).values(plans.map((pl) => ({ organizationId: orgId, programmeId: prog!.id, name: pl.name, kind: pl.kind, schedule: pl.schedule })));
          const ts = p.teams.length ? await tx.insert(teams).values(p.teams.map((t) => ({ organizationId: orgId, locationId: l.id, programmeId: prog!.id, seasonId: season!.id, name: t.name, capacity: t.capacity ?? null, coachUserId: t.coachUserId ?? null, kind: t.kind, homeVenueId: t.homeVenueId ?? null }))).returning() : [];
          const asst = p.teams.flatMap((t, i) => t.assistantUserIds.filter((u) => u !== t.coachUserId).map((u) => ({ organizationId: orgId, teamId: ts[i]!.id, userId: u, role: 'assistant' })));
          if (asst.length) await tx.insert(sportsTeamCoaches).values(asst).onConflictDoNothing();
          created.push({ ...prog!, teams: ts });
        }
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'sports.setup', scopeKind: 'location', scopeId: l.id, targetType: 'season', targetId: season!.id, metadata: { programmes: created.length, venues: newVenues.length, published: b.publish } });
        return { season: season!, venues: newVenues, programmes: created };
      });
      return reply.code(201).send({ ...out, convention: conv });
    });

    priv.get('/orgs/:orgId/sports/programmes/:id', { schema: { tags: ['sports'], security: secured, params: idParams } }, async (req) => {
      const p = await programmeIn(req.params.orgId, req.params.id);
      await requireLocationPerm(req, s.db, p.organizationId, p.locationId, 'operations.read');
      const [plans, ts, form, venues, season] = await Promise.all([
        s.db.select().from(sportsFeePlans).where(eq(sportsFeePlans.programmeId, p.id)),
        s.db.select().from(teams).where(and(eq(teams.programmeId, p.id), isNull(teams.archivedAt))),
        p.registrationFormId ? s.db.select().from(sportsRegistrationForms).where(eq(sportsRegistrationForms.id, p.registrationFormId)) : Promise.resolve([]),
        p.venueIds.length ? s.db.select().from(sportsVenues).where(inArray(sportsVenues.id, p.venueIds)) : Promise.resolve([]),
        p.seasonId ? s.db.select().from(seasons).where(eq(seasons.id, p.seasonId)) : Promise.resolve([]),
      ]);
      return { ...p, held: await placesHeld(s.db, p.id), feePlans: plans, teams: ts, form: form[0] ?? null, venues, season: season[0] ?? null, birthDates: p.ageCutoffDate ? eligibleBirthDates(p.ageRule as SportsAgeRule, p.ageCutoffDate, p.ageMin, p.ageMax) : null };
    });

    priv.patch('/orgs/:orgId/sports/programmes/:id', {
      schema: { tags: ['sports'], security: secured, params: idParams, body: programmeSchema.omit({ feePlans: true, teams: true }).partial().extend({ status: z.enum(['draft', 'published', 'closed', 'archived']).optional() }) },
    }, async (req) => {
      const p = await programmeIn(req.params.orgId, req.params.id);
      await requireDirector(req, s.db, p.organizationId, p.locationId);
      const b = req.body;
      const fee = b.feeMinor ?? p.feeMinor;
      const policy = b.refundPolicy ?? p.refundPolicy;
      if (fee > 0 && !policy) throw validationError('Paid programmes must show a refund/withdrawal policy before checkout', { refundPolicy: 'Required' });
      if (b.capacity !== undefined && b.capacity < (await placesHeld(s.db, p.id))) throw conflict('capacity_below_enrolment', 'Capacity cannot go below the places already held');
      const { registrationOpensAt, registrationClosesAt, ...rest } = b;
      const [row] = await s.db.update(programmes).set({
        ...rest, ...(registrationOpensAt !== undefined ? { registrationOpensAt: new Date(registrationOpensAt) } : {}), ...(registrationClosesAt !== undefined ? { registrationClosesAt: new Date(registrationClosesAt) } : {}),
        ...(b.refundPolicy && b.refundPolicy !== p.refundPolicy ? { refundPolicyVersion: new Date().toISOString().slice(0, 10) } : {}),
      }).where(eq(programmes.id, p.id)).returning();
      await audit(s.db, { organizationId: p.organizationId, ...actor(req), action: 'sports.programme_updated', scopeKind: 'location', scopeId: p.locationId, targetType: 'programme', targetId: p.id, metadata: { fields: Object.keys(b) } });
      return row;
    });

    priv.post('/orgs/:orgId/sports/programmes/:id/fee-plans', { schema: { tags: ['sports'], security: secured, params: idParams, body: planSchema } }, async (req, reply) => {
      const p = await programmeIn(req.params.orgId, req.params.id);
      await requireDirector(req, s.db, p.organizationId, p.locationId);
      const [row] = await s.db.insert(sportsFeePlans).values({ organizationId: p.organizationId, programmeId: p.id, ...req.body }).returning();
      return reply.code(201).send(row);
    });

    /* ---------------- Teams, coaches, transfers ---------------- */

    priv.get('/orgs/:orgId/sports/teams/:id', { schema: { tags: ['sports'], security: secured, params: idParams, summary: 'Team detail: roster (names, age groups), coaches and transfer history. Coaches only for their teams.' } }, async (req) => {
      const t = await teamIn(req.params.orgId, req.params.id);
      const { manager } = await requireTeamAccess(req, s.db, t, 'operations.read');
      const roster = t.kind === 'squad'
        ? await s.db.select({ id: customers.id, name: customers.name, dateOfBirth: customers.dateOfBirth, registrationId: sql<string | null>`null` }).from(sportsSquadMembers).innerJoin(customers, eq(customers.id, sportsSquadMembers.participantCustomerId)).where(eq(sportsSquadMembers.teamId, t.id)).orderBy(asc(customers.name))
        : await s.db.select({ id: customers.id, name: customers.name, dateOfBirth: customers.dateOfBirth, registrationId: registrations.id }).from(registrations).innerJoin(customers, eq(customers.id, registrations.participantCustomerId)).where(and(eq(registrations.teamId, t.id), eq(registrations.status, 'accepted'))).orderBy(asc(customers.name));
      const moves = await s.db.select({ m: sportsTeamMoves, name: customers.name }).from(sportsTeamMoves).innerJoin(customers, eq(customers.id, sportsTeamMoves.participantCustomerId)).where(sql`${sportsTeamMoves.fromTeamId} = ${t.id} or ${sportsTeamMoves.toTeamId} = ${t.id}`).orderBy(desc(sportsTeamMoves.createdAt)).limit(50);
      const coachRows = await s.db.select({ id: users.id, name: users.name, role: sportsTeamCoaches.role }).from(sportsTeamCoaches).innerJoin(users, eq(users.id, sportsTeamCoaches.userId)).where(eq(sportsTeamCoaches.teamId, t.id));
      const [head] = t.coachUserId ? await s.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, t.coachUserId)) : [];
      const [p] = await s.db.select().from(programmes).where(eq(programmes.id, t.programmeId));
      const today = new Date().toISOString().slice(0, 10);
      return {
        team: t, programme: { id: p!.id, name: p!.name }, canManage: manager, coach: head ?? null, assistants: coachRows,
        roster: roster.map((r) => ({ ...r, ageGroup: r.dateOfBirth ? checkAgeEligibility({ dateOfBirth: r.dateOfBirth, rule: p!.ageRule as SportsAgeRule, cutoffDate: p!.ageCutoffDate ?? today, ageMin: null, ageMax: null }).ageGroup : null })),
        moves: moves.map(({ m, name }) => ({ id: m.id, participant: name, fromTeamId: m.fromTeamId, toTeamId: m.toTeamId, reason: m.reason, at: m.createdAt.toISOString() })),
      };
    });

    priv.patch('/orgs/:orgId/sports/teams/:id', { schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ name: z.string().min(1).max(80).optional(), capacity: z.number().int().min(1).max(500).nullable().optional(), homeVenueId: z.uuid().nullable().optional(), archived: z.boolean().optional() }) } }, async (req) => {
      const t = await teamIn(req.params.orgId, req.params.id);
      await requireDirector(req, s.db, t.organizationId, t.locationId);
      if (req.body.capacity != null && req.body.capacity < (await teamRosterCount(s.db, t.id))) throw conflict('capacity_below_roster', 'Capacity cannot go below the current roster');
      const { archived, ...rest } = req.body;
      const [row] = await s.db.update(teams).set({ ...rest, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) }).where(eq(teams.id, t.id)).returning();
      return row;
    });

    priv.put('/orgs/:orgId/sports/teams/:id/coaches', { schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ headCoachUserId: z.uuid().nullable(), assistantUserIds: z.array(z.uuid()).max(6).default([]) }) } }, async (req) => {
      const t = await teamIn(req.params.orgId, req.params.id);
      await requireDirector(req, s.db, t.organizationId, t.locationId);
      await assertCoaches(t.organizationId, t.locationId, [req.body.headCoachUserId, ...req.body.assistantUserIds].filter((x): x is string => !!x));
      await s.db.transaction(async (tx) => {
        await tx.update(teams).set({ coachUserId: req.body.headCoachUserId }).where(eq(teams.id, t.id));
        await tx.delete(sportsTeamCoaches).where(eq(sportsTeamCoaches.teamId, t.id));
        const asst = [...new Set(req.body.assistantUserIds)].filter((u) => u !== req.body.headCoachUserId);
        if (asst.length) await tx.insert(sportsTeamCoaches).values(asst.map((u) => ({ organizationId: t.organizationId, teamId: t.id, userId: u, role: 'assistant' })));
        await audit(tx, { organizationId: t.organizationId, ...actor(req), action: 'sports.coaches_assigned', scopeKind: 'location', scopeId: t.locationId, targetType: 'team', targetId: t.id, metadata: req.body });
      });
      return { ok: true };
    });

    priv.post('/orgs/:orgId/sports/registrations/:id/transfer', {
      schema: { tags: ['sports'], security: secured, params: idParams, summary: 'Move an accepted participant to another group in the same programme. The target group\'s capacity is checked under lock; the move is recorded.', body: z.object({ toTeamId: z.uuid(), reason: z.string().max(300).optional(), notifyGuardians: z.boolean().default(true) }) },
    }, async (req) => {
      const [r0] = await s.db.select().from(registrations).where(and(eq(registrations.id, req.params.id), eq(registrations.organizationId, req.params.orgId)));
      if (!r0) throw notFound('Registration');
      await requireDirector(req, s.db, r0.organizationId, r0.locationId);
      const res = await s.db.transaction(async (tx) => {
        const [to] = await tx.select().from(teams).where(and(eq(teams.id, req.body.toTeamId), eq(teams.organizationId, req.params.orgId))).for('update');
        if (!to || to.archivedAt) throw notFound('Team');
        const [r] = await tx.select().from(registrations).where(eq(registrations.id, r0.id)).for('update');
        if (r!.status !== 'accepted') throw conflict('not_accepted', 'Only accepted participants can be moved between groups');
        if (to.programmeId !== r!.programmeId) throw validationError('Groups must be in the same programme. Register for the other programme instead.', { toTeamId: 'Different programme' });
        if (to.kind === 'squad') throw validationError('Squads are filled by selection', { toTeamId: 'Squad' });
        if (r!.teamId === to.id) throw conflict('same_team', 'Already in this group');
        if (to.capacity !== null && (await teamRosterCount(tx, to.id)) >= to.capacity) throw conflict('team_full', `${to.name} is full (${to.capacity})`);
        await tx.update(registrations).set({ teamId: to.id, updatedAt: new Date() }).where(eq(registrations.id, r!.id));
        const [m] = await tx.insert(sportsTeamMoves).values({ organizationId: r!.organizationId, registrationId: r!.id, participantCustomerId: r!.participantCustomerId, fromTeamId: r!.teamId, toTeamId: to.id, reason: req.body.reason ?? null, movedBy: req.user!.id }).returning();
        await audit(tx, { organizationId: r!.organizationId, ...actor(req), action: 'sports.transfer', scopeKind: 'location', scopeId: r!.locationId, targetType: 'registration', targetId: r!.id, metadata: { from: r!.teamId, to: to.id } });
        return { move: m!, to, reg: r! };
      });
      if (req.body.notifyGuardians) {
        const gs = await guardiansOf(s.db, res.reg.organizationId, [res.reg.participantCustomerId]);
        const [child] = await s.db.select({ name: customers.name }).from(customers).where(eq(customers.id, res.reg.participantCustomerId));
        await notifyGuardians(s, { organizationId: res.reg.organizationId, locationId: res.reg.locationId, kind: 'schedule_changed', subject: `${child?.name}: new group`, body: `${child?.name} has moved to ${res.to.name}. The schedule in the guardian portal now shows this group's sessions.`, refType: 'registration', refId: res.reg.id, recipients: gs.map((g) => ({ guardianId: g.guardian.id, participantId: g.participantId })) });
      }
      return { move: res.move, teamId: res.to.id };
    });

    /* ---------------- Squad selection (coach proposes, director approves) ---------------- */

    priv.get('/orgs/:orgId/sports/selections', { schema: { tags: ['sports'], security: secured, params: orgParams, querystring: z.object({ status: z.enum(['proposed', 'approved', 'rejected', 'withdrawn']).optional() }) } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = (await s.db.select({ sel: sportsSelections, squad: teams.name, by: users.name }).from(sportsSelections).innerJoin(teams, eq(teams.id, sportsSelections.squadTeamId)).innerJoin(users, eq(users.id, sportsSelections.proposedBy))
        .where(and(eq(sportsSelections.organizationId, req.params.orgId), req.query.status ? eq(sportsSelections.status, req.query.status) : undefined)).orderBy(desc(sportsSelections.createdAt)))
        .filter((r) => allowed === 'all' || allowed.has(r.sel.locationId));
      const entries = rows.length ? await s.db.select({ e: sportsSelectionEntries, name: customers.name }).from(sportsSelectionEntries).innerJoin(customers, eq(customers.id, sportsSelectionEntries.participantCustomerId)).where(inArray(sportsSelectionEntries.selectionId, rows.map((r) => r.sel.id))) : [];
      const out = [];
      for (const r of rows) {
        const canDecide = r.sel.status === 'proposed' && r.sel.proposedBy !== req.user!.id && (await hasPerm(req, s.db, 'customers.write', { organizationId: r.sel.organizationId, kind: 'location', id: r.sel.locationId }));
        out.push({ ...r.sel, squadName: r.squad, proposedByName: r.by, canDecide, participants: entries.filter((e) => e.e.selectionId === r.sel.id).map((e) => ({ id: e.e.participantCustomerId, name: e.name, note: e.e.note })) });
      }
      return { items: out };
    });

    priv.post('/orgs/:orgId/sports/selections', {
      schema: { tags: ['sports'], security: secured, params: orgParams, summary: 'Coach proposes a squad. Participants are chosen by a person; there is no automated selection.', body: z.object({ squadTeamId: z.uuid(), title: z.string().min(1).max(120), notes: z.string().max(1000).optional(), participants: z.array(z.object({ id: z.uuid(), note: z.string().max(300).optional() })).min(1).max(60) }) },
    }, async (req, reply) => {
      const squad = await teamIn(req.params.orgId, req.body.squadTeamId);
      if (squad.kind !== 'squad') throw validationError('Choose a squad (a group of kind "squad")', { squadTeamId: 'Not a squad' });
      await requireLocationPerm(req, s.db, squad.organizationId, squad.locationId, 'operations.write');
      const director = await hasPerm(req, s.db, 'customers.write', { organizationId: squad.organizationId, kind: 'location', id: squad.locationId });
      const myTeams = await coachTeamIds(s.db, squad.organizationId, req.user!.id);
      const progTeams = await s.db.select({ id: teams.id }).from(teams).where(eq(teams.programmeId, squad.programmeId));
      if (!director && !progTeams.some((t) => myTeams.has(t.id))) throw forbidden('Only coaches in this programme can propose a squad');
      const ids = req.body.participants.map((p) => p.id);
      const eligible = await s.db.select({ id: registrations.participantCustomerId }).from(registrations).where(and(eq(registrations.programmeId, squad.programmeId), eq(registrations.status, 'accepted'), inArray(registrations.participantCustomerId, ids)));
      const okIds = new Set(eligible.map((e) => e.id));
      const bad = ids.filter((i) => !okIds.has(i));
      if (bad.length) throw validationError('Only accepted participants in this programme can be proposed', Object.fromEntries(bad.map((b) => [`participants.${b}`, 'Not in programme'])));
      if (squad.capacity !== null && ids.length > squad.capacity) throw conflict('squad_full', `This squad holds ${squad.capacity}`);
      const sel = await s.db.transaction(async (tx) => {
        const [row] = await tx.insert(sportsSelections).values({ organizationId: squad.organizationId, locationId: squad.locationId, squadTeamId: squad.id, title: req.body.title, notes: req.body.notes ?? null, proposedBy: req.user!.id }).returning();
        await tx.insert(sportsSelectionEntries).values(req.body.participants.map((p) => ({ organizationId: squad.organizationId, selectionId: row!.id, participantCustomerId: p.id, note: p.note ?? null })));
        await audit(tx, { organizationId: squad.organizationId, ...actor(req), action: 'sports.selection_proposed', scopeKind: 'location', scopeId: squad.locationId, targetType: 'selection', targetId: row!.id, metadata: { count: ids.length } });
        return row!;
      });
      return reply.code(201).send(sel);
    });

    priv.post('/orgs/:orgId/sports/selections/:id/decision', { schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).optional() }) } }, async (req) => {
      const [sel] = await s.db.select().from(sportsSelections).where(and(eq(sportsSelections.id, req.params.id), eq(sportsSelections.organizationId, req.params.orgId)));
      if (!sel) throw notFound('Selection');
      await requireDirector(req, s.db, sel.organizationId, sel.locationId);
      if (sel.proposedBy === req.user!.id) throw forbidden('A selection must be approved by someone other than the coach who proposed it');
      if (req.body.decision === 'reject' && !req.body.note?.trim()) throw validationError('Add a note for the coach when rejecting', { note: 'Required' });
      const result = await s.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(sportsSelections).where(eq(sportsSelections.id, sel.id)).for('update');
        if (locked!.status !== 'proposed') throw conflict('already_decided', `Selection is ${locked!.status}`);
        const [u] = await tx.update(sportsSelections).set({ status: req.body.decision === 'approve' ? 'approved' : 'rejected', decidedBy: req.user!.id, decidedAt: new Date(), decisionNote: req.body.note ?? null }).where(eq(sportsSelections.id, sel.id)).returning();
        let added = 0;
        if (req.body.decision === 'approve') {
          const entries = await tx.select().from(sportsSelectionEntries).where(eq(sportsSelectionEntries.selectionId, sel.id));
          const [squad] = await tx.select().from(teams).where(eq(teams.id, sel.squadTeamId)).for('update');
          const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(sportsSquadMembers).where(eq(sportsSquadMembers.teamId, sel.squadTeamId));
          const existing = new Set((await tx.select({ id: sportsSquadMembers.participantCustomerId }).from(sportsSquadMembers).where(eq(sportsSquadMembers.teamId, sel.squadTeamId))).map((r) => r.id));
          const fresh = entries.filter((e) => !existing.has(e.participantCustomerId));
          if (squad!.capacity !== null && n + fresh.length > squad!.capacity) throw conflict('squad_full', `Approving would exceed the squad size (${squad!.capacity})`);
          if (fresh.length) await tx.insert(sportsSquadMembers).values(fresh.map((e) => ({ organizationId: sel.organizationId, teamId: sel.squadTeamId, participantCustomerId: e.participantCustomerId, selectionId: sel.id })));
          added = fresh.length;
        }
        await audit(tx, { organizationId: sel.organizationId, ...actor(req), action: `sports.selection_${u!.status}`, scopeKind: 'location', scopeId: sel.locationId, targetType: 'selection', targetId: sel.id, metadata: { added } });
        return { selection: u!, added };
      });
      if (req.body.decision === 'approve') {
        const entries = await s.db.select().from(sportsSelectionEntries).where(eq(sportsSelectionEntries.selectionId, sel.id));
        const gs = await guardiansOf(s.db, sel.organizationId, entries.map((e) => e.participantCustomerId));
        await notifyGuardians(s, { organizationId: sel.organizationId, locationId: sel.locationId, kind: 'selection', subject: `Squad selection: ${sel.title}`, body: `Your participant has been selected for ${sel.title}. Squad sessions now appear in the guardian portal.`, refType: 'selection', refId: sel.id, recipients: gs.map((g) => ({ guardianId: g.guardian.id, participantId: g.participantId })) });
      }
      return result;
    });

    /* ---------------- Announcements ---------------- */

    priv.get('/orgs/:orgId/sports/announcements', { schema: { tags: ['sports'], security: secured, params: orgParams } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = await s.db.select({ a: sportsAnnouncements, by: users.name }).from(sportsAnnouncements).leftJoin(users, eq(users.id, sportsAnnouncements.createdBy)).where(eq(sportsAnnouncements.organizationId, req.params.orgId)).orderBy(desc(sportsAnnouncements.createdAt)).limit(100);
      const ts = await s.db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.organizationId, req.params.orgId));
      const ps = await s.db.select({ id: programmes.id, name: programmes.name }).from(programmes).where(eq(programmes.organizationId, req.params.orgId));
      return { items: rows.filter((r) => allowed === 'all' || allowed.has(r.a.locationId)).map((r) => ({ ...r.a, createdByName: r.by, scopeName: (r.a.scopeKind === 'team' ? ts : ps).find((x) => x.id === r.a.scopeId)?.name ?? null })) };
    });

    priv.post('/orgs/:orgId/sports/announcements', {
      schema: { tags: ['sports'], security: secured, params: orgParams, summary: 'Message the guardians of one team (coach or director) or one programme (director). Never network-wide.', body: z.object({ scopeKind: z.enum(['team', 'programme']), scopeId: z.uuid(), title: z.string().min(1).max(140), body: z.string().min(1).max(4000) }) },
    }, async (req, reply) => {
      const b = req.body;
      let locationId: string;
      let participantIds: string[];
      let scopeName: string;
      if (b.scopeKind === 'team') {
        const t = await teamIn(req.params.orgId, b.scopeId);
        await requireTeamAccess(req, s.db, t);
        locationId = t.locationId;
        participantIds = await rosterParticipantIds(s.db, t);
        scopeName = t.name;
      } else {
        const p = await programmeIn(req.params.orgId, b.scopeId);
        await requireDirector(req, s.db, p.organizationId, p.locationId);
        locationId = p.locationId;
        participantIds = (await s.db.select({ id: registrations.participantCustomerId }).from(registrations).where(and(eq(registrations.programmeId, p.id), eq(registrations.status, 'accepted')))).map((r) => r.id);
        scopeName = p.name;
      }
      const gs = await guardiansOf(s.db, req.params.orgId, participantIds);
      const [row] = await s.db.insert(sportsAnnouncements).values({ organizationId: req.params.orgId, locationId, scopeKind: b.scopeKind, scopeId: b.scopeId, title: b.title, body: b.body, createdBy: req.user!.id }).returning();
      const res = await notifyGuardians(s, { organizationId: req.params.orgId, locationId, kind: 'announcement', subject: `${scopeName}: ${b.title}`, body: b.body, refType: 'announcement', refId: row!.id, recipients: gs.map((g) => ({ guardianId: g.guardian.id, participantId: g.participantId })) });
      await s.db.update(sportsAnnouncements).set({ recipientCount: res.recipients }).where(eq(sportsAnnouncements.id, row!.id));
      await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'sports.announcement_sent', scopeKind: 'location', scopeId: locationId, targetType: b.scopeKind, targetId: b.scopeId, metadata: { recipients: res.recipients } });
      return reply.code(201).send({ ...row!, recipientCount: res.recipients, delivery: res });
    });

    priv.get('/orgs/:orgId/sports/notifications', { schema: { tags: ['sports'], security: secured, params: orgParams, summary: 'Delivery log for a record (who was notified, or skipped for consent).', querystring: z.object({ refType: z.string(), refId: z.uuid() }) } }, async (req) => {
      const rows = await s.db.select({ n: sportsNotifications, name: customers.name }).from(sportsNotifications).innerJoin(customers, eq(customers.id, sportsNotifications.guardianCustomerId)).where(and(eq(sportsNotifications.organizationId, req.params.orgId), eq(sportsNotifications.refType, req.query.refType), eq(sportsNotifications.refId, req.query.refId)));
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
      return { items: rows.filter((r) => allowed === 'all' || (r.n.locationId && allowed.has(r.n.locationId))).map((r) => ({ id: r.n.id, guardian: r.name, kind: r.n.kind, status: r.n.status, channel: r.n.channel, createdAt: r.n.createdAt.toISOString() })) };
    });

    /* ---------------- Balances, aid, withdrawal, restricted data ---------------- */

    priv.get('/orgs/:orgId/sports/balances', {
      schema: { tags: ['sports'], security: secured, params: orgParams, summary: 'Registrations with instalments and balance state; totals per currency (never combined).', querystring: z.object({ locationId: z.uuid().optional(), state: z.enum(['overdue', 'due', 'on_track', 'paid', 'all']).default('all') }) },
    }, async (req) => {
      const { orgId } = req.params;
      const pr = await authorisedLocations(req, s.db, orgId, 'payments.read');
      const cr = await authorisedLocations(req, s.db, orgId, 'customers.read');
      const ok = (l: string) => pr === 'all' || pr.has(l) || cr === 'all' || cr.has(l);
      const rows = (await s.db.select({ r: registrations, c: customers.name, p: programmes.name, l: { id: locations.id, name: locations.name, timeZone: locations.timeZone } }).from(registrations).innerJoin(customers, eq(customers.id, registrations.participantCustomerId)).innerJoin(programmes, eq(programmes.id, registrations.programmeId)).innerJoin(locations, eq(locations.id, registrations.locationId))
        .where(and(eq(registrations.organizationId, orgId), inArray(registrations.status, ['accepted', 'awaiting_review', 'submitted', 'withdrawn']), req.query.locationId ? eq(registrations.locationId, req.query.locationId) : undefined))).filter((x) => ok(x.r.locationId));
      if (!rows.length) return { items: [], totals: [], combined: null };
      const ids = rows.map((x) => x.r.id);
      const inst = await s.db.select().from(sportsInstalments).where(inArray(sportsInstalments.registrationId, ids)).orderBy(asc(sportsInstalments.seq));
      const adj = await s.db.select().from(sportsFeeAdjustments).where(inArray(sportsFeeAdjustments.registrationId, ids));
      const gIds = [...new Set(rows.map((x) => x.r.guardianCustomerId).filter((g): g is string => !!g))];
      const gs = gIds.length ? await s.db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, gIds)) : [];
      const now = new Date();
      const items = rows.map((x) => {
        const today = todayIn(x.l.timeZone, now);
        const ii = inst.filter((i) => i.registrationId === x.r.id);
        return { registrationId: x.r.id, status: x.r.status, participant: x.c, guardian: gs.find((g) => g.id === x.r.guardianCustomerId)?.name ?? null, programme: x.p, location: x.l, plan: x.r.paymentPlan, listFee: { amount: x.r.listFeeMinor, currency: x.r.currency }, balance: balanceOf(ii, today), instalments: ii.map((i) => serializeInstalment(i, today)), adjustments: adj.filter((a) => a.registrationId === x.r.id).map((a) => ({ kind: a.kind, amount: { amount: a.amountMinor, currency: a.currency }, reason: a.reason, at: a.createdAt.toISOString() })) };
      }).filter((x) => x.balance.state !== 'none' && (req.query.state === 'all' || x.balance.state === req.query.state));
      const totals = new Map<string, { outstanding: number; overdue: number; paid: number; registrations: number }>();
      for (const i of items) if (i.balance.currency) {
        const t = totals.get(i.balance.currency) ?? { outstanding: 0, overdue: 0, paid: 0, registrations: 0 };
        t.outstanding += i.balance.outstanding; t.overdue += i.balance.overdue; t.paid += i.balance.paid; t.registrations++;
        totals.set(i.balance.currency, t);
      }
      return { items, totals: [...totals.entries()].map(([currency, v]) => ({ currency, ...v })), combined: null, combinedNote: 'Currencies are never combined without a defined conversion method.' };
    });

    priv.post('/orgs/:orgId/sports/registrations/:id/fee-adjustments', {
      schema: { tags: ['sports'], security: secured, params: idParams, summary: 'Financial aid or waiver (administrators/finance). Reduces unpaid instalments; already-paid amounts are refunded through Payments.', body: z.object({ kind: z.enum(['financial_aid', 'waiver']), amountMinor: z.number().int().min(1).optional(), waiveAll: z.boolean().optional(), reason: z.string().min(3).max(500) }) },
    }, async (req, reply) => reply.code(201).send(await adjustFees(s, req, req.params.orgId, req.params.id, req.body)));

    priv.post('/orgs/:orgId/sports/instalments/run-reminders', { schema: { tags: ['sports'], security: secured, params: orgParams, summary: 'Send due/overdue instalment reminders now (also runs hourly in the server).' } }, async (req) => {
      const a = await authorisedLocations(req, s.db, req.params.orgId, 'customers.write');
      if (a !== 'all') throw forbidden('Organisation-wide customer access is needed to run reminders');
      return runInstalmentReminders(s, new Date(), req.params.orgId);
    });

    priv.post('/orgs/:orgId/sports/registrations/:id/withdraw', { schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ reason: z.string().min(3).max(500) }) } }, async (req) => {
      const [r] = await s.db.select().from(registrations).where(and(eq(registrations.id, req.params.id), eq(registrations.organizationId, req.params.orgId)));
      if (!r) throw notFound('Registration');
      await requireDirector(req, s.db, r.organizationId, r.locationId);
      return withdrawRegistration(s, r, { userId: req.user!.id, guardianId: null }, req.body.reason);
    });

    priv.get('/orgs/:orgId/sports/registrations/:id/restricted', {
      schema: { tags: ['sports'], security: secured, params: idParams, summary: 'Medical/emergency answers. Directors see all; a coach of the participant\'s team sees only coach-visible answers. Every read is audited. Never included in AI context.' },
    }, async (req) => {
      const [r] = await s.db.select().from(registrations).where(and(eq(registrations.id, req.params.id), eq(registrations.organizationId, req.params.orgId)));
      if (!r) throw notFound('Registration');
      const director = await hasPerm(req, s.db, 'customers.read', { organizationId: r.organizationId, kind: 'location', id: r.locationId });
      let coach = false;
      if (!director) {
        const [t] = r.teamId ? await s.db.select().from(teams).where(eq(teams.id, r.teamId)) : [];
        coach = !!t && (await isCoachOf(s.db, t, req.user!.id)) && (await hasPerm(req, s.db, 'operations.read', { organizationId: r.organizationId, kind: 'location', id: r.locationId }));
        if (!coach) throw forbidden('Only programme administrators, or the participant\'s coach, can see care information');
      }
      const [row] = await s.db.select().from(sportsRestrictedAnswers).where(eq(sportsRestrictedAnswers.registrationId, r.id));
      await audit(s.db, { organizationId: r.organizationId, ...actor(req), action: 'sports.restricted_viewed', scopeKind: 'location', scopeId: r.locationId, targetType: 'registration', targetId: r.id, metadata: { access: director ? 'full' : 'coach' } });
      if (!row) return { access: director ? 'full' : 'coach', answers: {}, formVersion: null };
      const answers = director ? row.answers : Object.fromEntries(Object.entries(row.answers).filter(([k]) => row.coachVisibleKeys.includes(k)));
      return { access: director ? 'full' : 'coach', answers, formVersion: row.formVersion, coachVisibleKeys: row.coachVisibleKeys, updatedAt: row.updatedAt.toISOString() };
    });

    /* ---------------- Guardians: relationships, invitations, disputes ---------------- */

    priv.get('/orgs/:orgId/sports/guardians', { schema: { tags: ['sports'], security: secured, params: orgParams, querystring: z.object({ participantId: z.uuid().optional(), status: z.enum(['pending_verification', 'verified', 'disputed', 'revoked']).optional() }) } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
      const rows = await s.db.select({ rel: guardianRelationships, participant: { id: customers.id, name: customers.name, locationId: customers.locationId } }).from(guardianRelationships).innerJoin(customers, eq(customers.id, guardianRelationships.participantCustomerId))
        .where(and(eq(guardianRelationships.organizationId, req.params.orgId), req.query.participantId ? eq(guardianRelationships.participantCustomerId, req.query.participantId) : undefined, req.query.status ? eq(guardianRelationships.status, req.query.status) : undefined)).limit(500);
      const visible = rows.filter((r) => allowed === 'all' || (r.participant.locationId && allowed.has(r.participant.locationId)));
      const gIds = [...new Set(visible.map((r) => r.rel.guardianCustomerId))];
      const gs = gIds.length ? await s.db.select({ id: customers.id, name: customers.name, email: customers.email, phone: customers.phone, hasAccount: sql<boolean>`${customers.userId} is not null` }).from(customers).where(inArray(customers.id, gIds)) : [];
      const pIds = [...new Set(visible.map((r) => r.participant.id))];
      const invites = pIds.length ? await s.db.select().from(sportsGuardianInvitations).where(and(inArray(sportsGuardianInvitations.participantCustomerId, pIds), eq(sportsGuardianInvitations.status, 'pending'))) : [];
      return {
        items: visible.map((r) => ({ id: r.rel.id, relationship: r.rel.relationship, status: r.rel.status, verifiedAt: r.rel.verifiedAt?.toISOString() ?? null, participant: r.participant, guardian: gs.find((x) => x.id === r.rel.guardianCustomerId) ?? null })),
        invitations: invites.map((i) => ({ id: i.id, participantId: i.participantCustomerId, email: i.email, relationship: i.relationship, expiresAt: i.expiresAt.toISOString() })),
      };
    });

    const relIn = async (orgId: string, id: string) => {
      const [rel] = await s.db.select({ rel: guardianRelationships, locationId: customers.locationId }).from(guardianRelationships).innerJoin(customers, eq(customers.id, guardianRelationships.participantCustomerId)).where(and(eq(guardianRelationships.id, id), eq(guardianRelationships.organizationId, orgId)));
      if (!rel) throw notFound('Relationship');
      return rel;
    };

    priv.post('/orgs/:orgId/sports/relationships/:id/verify', { schema: { tags: ['sports'], security: secured, params: idParams, summary: 'Staff verify a relationship after checking documents in person.', body: z.object({ note: z.string().min(3).max(300) }) } }, async (req) => {
      const r = await relIn(req.params.orgId, req.params.id);
      if (!r.locationId) throw forbidden();
      await requireDirector(req, s.db, req.params.orgId, r.locationId);
      if (r.rel.status === 'disputed') throw conflict('disputed', 'Resolve the open dispute first');
      if (r.rel.status === 'revoked') throw conflict('revoked', 'This relationship was removed; send a new invitation');
      await s.db.update(guardianRelationships).set({ status: 'verified', verifiedAt: new Date() }).where(eq(guardianRelationships.id, r.rel.id));
      await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'guardian.verified_by_staff', targetType: 'guardian_relationship', targetId: r.rel.id, metadata: { note: req.body.note } });
      return { id: r.rel.id, status: 'verified' };
    });

    priv.post('/orgs/:orgId/sports/relationships/:id/dispute', { schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ reason: z.string().min(3).max(1000) }) } }, async (req, reply) => {
      const r = await relIn(req.params.orgId, req.params.id);
      if (!r.locationId) throw forbidden();
      await requireDirector(req, s.db, req.params.orgId, r.locationId);
      return reply.code(201).send(await raiseDispute(s, { relationshipId: r.rel.id, reason: req.body.reason, byUserId: req.user!.id, organizationId: req.params.orgId }));
    });

    priv.get('/orgs/:orgId/sports/disputes', { schema: { tags: ['sports'], security: secured, params: orgParams, querystring: z.object({ status: z.enum(['open', 'upheld', 'dismissed']).default('open') }) } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
      const rows = await s.db.select({ d: sportsRelationshipDisputes, rel: guardianRelationships, participant: { id: customers.id, name: customers.name, locationId: customers.locationId } }).from(sportsRelationshipDisputes)
        .innerJoin(guardianRelationships, eq(guardianRelationships.id, sportsRelationshipDisputes.relationshipId)).innerJoin(customers, eq(customers.id, sportsRelationshipDisputes.participantCustomerId))
        .where(and(eq(sportsRelationshipDisputes.organizationId, req.params.orgId), eq(sportsRelationshipDisputes.status, req.query.status))).orderBy(desc(sportsRelationshipDisputes.createdAt));
      const visible = rows.filter((r) => allowed === 'all' || (r.participant.locationId && allowed.has(r.participant.locationId)));
      const ids = [...new Set(visible.flatMap((r) => [r.rel.guardianCustomerId, r.d.raisedByCustomerId].filter((x): x is string => !!x)))];
      const names = ids.length ? await s.db.select({ id: customers.id, name: customers.name, email: customers.email }).from(customers).where(inArray(customers.id, ids)) : [];
      return {
        items: visible.map((r) => ({ id: r.d.id, status: r.d.status, reason: r.d.reason, createdAt: r.d.createdAt.toISOString(), participant: r.participant, relationship: { id: r.rel.id, relationship: r.rel.relationship, guardian: names.find((n) => n.id === r.rel.guardianCustomerId) ?? null }, raisedBy: r.d.raisedByCustomerId ? names.find((n) => n.id === r.d.raisedByCustomerId)?.name ?? null : 'Staff', resolutionNote: r.d.resolutionNote })),
      };
    });

    priv.post('/orgs/:orgId/sports/disputes/:id/resolve', { schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ outcome: z.enum(['uphold', 'dismiss']), note: z.string().min(3).max(1000) }) } }, async (req) => {
      const [d] = await s.db.select({ d: sportsRelationshipDisputes, locationId: customers.locationId }).from(sportsRelationshipDisputes).innerJoin(customers, eq(customers.id, sportsRelationshipDisputes.participantCustomerId)).where(and(eq(sportsRelationshipDisputes.id, req.params.id), eq(sportsRelationshipDisputes.organizationId, req.params.orgId)));
      if (!d || !d.locationId) throw notFound('Dispute');
      await requireDirector(req, s.db, req.params.orgId, d.locationId);
      return resolveDispute(s, req.params.orgId, d.d.id, req.user!.id, req.body.outcome, req.body.note);
    });

    priv.post('/orgs/:orgId/sports/participants/:id/invitations', { schema: { tags: ['sports'], security: secured, params: idParams, body: z.object({ email: z.email(), name: z.string().max(120).optional(), relationship: z.string().min(2).max(40).default('parent') }) } }, async (req, reply) => {
      const [c] = await s.db.select().from(customers).where(and(eq(customers.id, req.params.id), eq(customers.organizationId, req.params.orgId)));
      if (!c || !c.locationId) throw notFound('Participant');
      await requireDirector(req, s.db, req.params.orgId, c.locationId);
      return reply.code(201).send(await inviteGuardian(s, { organizationId: req.params.orgId, participantId: c.id, invitedByCustomerId: null, invitedByUserId: req.user!.id, email: req.body.email, name: req.body.name, relationship: req.body.relationship }));
    });

    /* ---------------- Guardian messages ---------------- */

    priv.get('/orgs/:orgId/sports/messages', { schema: { tags: ['sports'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), guardianId: z.uuid().optional() }) } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
      const rows = (await s.db.select({ m: sportsMessages, g: { id: customers.id, name: customers.name }, l: { name: locations.name } }).from(sportsMessages).innerJoin(customers, eq(customers.id, sportsMessages.guardianCustomerId)).innerJoin(locations, eq(locations.id, sportsMessages.locationId))
        .where(and(eq(sportsMessages.organizationId, req.params.orgId), req.query.locationId ? eq(sportsMessages.locationId, req.query.locationId) : undefined, req.query.guardianId ? eq(sportsMessages.guardianCustomerId, req.query.guardianId) : undefined)).orderBy(asc(sportsMessages.createdAt)).limit(1000))
        .filter((r) => allowed === 'all' || allowed.has(r.m.locationId));
      const threads = new Map<string, { guardian: { id: string; name: string }; locationId: string; locationName: string; messages: Array<{ id: string; direction: string; body: string; createdAt: string }>; unread: number }>();
      for (const r of rows) {
        const k = `${r.m.locationId}:${r.g.id}`;
        const t = threads.get(k) ?? { guardian: r.g, locationId: r.m.locationId, locationName: r.l.name, messages: [], unread: 0 };
        t.messages.push({ id: r.m.id, direction: r.m.direction, body: r.m.body, createdAt: r.m.createdAt.toISOString() });
        if (r.m.direction === 'inbound' && !r.m.readAt) t.unread++;
        threads.set(k, t);
      }
      return { threads: [...threads.values()].sort((a, b) => (b.messages.at(-1)?.createdAt ?? '').localeCompare(a.messages.at(-1)?.createdAt ?? '')) };
    });

    priv.post('/orgs/:orgId/sports/messages', { schema: { tags: ['sports'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), guardianId: z.uuid(), body: z.string().min(1).max(4000) }) } }, async (req, reply) => {
      await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'customers.write');
      const [thread] = await s.db.select({ id: sportsMessages.id }).from(sportsMessages).where(and(eq(sportsMessages.locationId, req.body.locationId), eq(sportsMessages.guardianCustomerId, req.body.guardianId))).limit(1);
      if (!thread) throw notFound('Conversation');
      await s.db.update(sportsMessages).set({ readAt: new Date() }).where(and(eq(sportsMessages.locationId, req.body.locationId), eq(sportsMessages.guardianCustomerId, req.body.guardianId), eq(sportsMessages.direction, 'inbound'), isNull(sportsMessages.readAt)));
      const [m] = await s.db.insert(sportsMessages).values({ organizationId: req.params.orgId, locationId: req.body.locationId, guardianCustomerId: req.body.guardianId, direction: 'outbound', authorUserId: req.user!.id, body: req.body.body }).returning();
      return reply.code(201).send({ id: m!.id, direction: m!.direction, body: m!.body, createdAt: m!.createdAt.toISOString() });
    });

    /* ---------------- Reports ---------------- */

    priv.get('/orgs/:orgId/sports/reports', {
      schema: { tags: ['sports'], security: secured, params: orgParams, summary: 'Enrolment, capacity, attendance rates and outstanding balances per currency. Missing data is null with a reason, never 0.', querystring: z.object({ locationId: z.uuid().optional(), days: z.coerce.number().int().min(7).max(365).default(60) }) },
    }, async (req) => {
      const { orgId } = req.params;
      const allowed = await authorisedLocations(req, s.db, orgId, 'reports.read');
      const locs = (await s.db.select().from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt)))).filter((l) => (allowed === 'all' || allowed.has(l.id)) && (!req.query.locationId || l.id === req.query.locationId));
      if (!locs.length) throw forbidden('Missing permission reports.read in this scope');
      const ids = locs.map((l) => l.id);
      const now = new Date();
      const since = new Date(now.getTime() - req.query.days * 86400_000);
      const progs = await s.db.select().from(programmes).where(and(inArray(programmes.locationId, ids), ne(programmes.status, 'archived')));
      const pIds = progs.map((p) => p.id);
      const counts = pIds.length ? await s.db.select({ id: registrations.programmeId, status: registrations.status, n: count() }).from(registrations).where(inArray(registrations.programmeId, pIds)).groupBy(registrations.programmeId, registrations.status) : [];
      const ts = await s.db.select().from(teams).where(and(inArray(teams.locationId, ids), isNull(teams.archivedAt)));
      const tIds = ts.map((t) => t.id);
      const [rosters, squads, att] = tIds.length ? await Promise.all([
        s.db.select({ id: registrations.teamId, n: count() }).from(registrations).where(and(inArray(registrations.teamId, tIds), eq(registrations.status, 'accepted'))).groupBy(registrations.teamId),
        s.db.select({ id: sportsSquadMembers.teamId, n: count() }).from(sportsSquadMembers).where(inArray(sportsSquadMembers.teamId, tIds)).groupBy(sportsSquadMembers.teamId),
        s.db.select({ teamId: trainingSessions.teamId, status: attendance.status, n: count() }).from(attendance).innerJoin(trainingSessions, eq(trainingSessions.id, attendance.sessionId)).where(and(inArray(trainingSessions.teamId, tIds), gte(trainingSessions.startsAt, since), lt(trainingSessions.startsAt, now), ne(trainingSessions.status, 'cancelled'))).groupBy(trainingSessions.teamId, attendance.status),
      ]) : [[], [], []];
      const owed = pIds.length ? await s.db.select({ i: sportsInstalments, tz: locations.timeZone }).from(sportsInstalments).innerJoin(registrations, eq(registrations.id, sportsInstalments.registrationId)).innerJoin(locations, eq(locations.id, sportsInstalments.locationId)).where(and(inArray(registrations.programmeId, pIds), inArray(sportsInstalments.status, ['scheduled', 'paid']), inArray(registrations.status, ['accepted', 'awaiting_review', 'submitted']))) : [];
      const bal = new Map<string, { outstanding: number; overdue: number; collected: number }>();
      for (const { i, tz } of owed) {
        const b = bal.get(i.currency) ?? { outstanding: 0, overdue: 0, collected: 0 };
        if (i.status === 'paid') b.collected += i.amountMinor;
        else { b.outstanding += i.amountMinor; if (i.dueOn < todayIn(tz, now)) b.overdue += i.amountMinor; }
        bal.set(i.currency, b);
      }
      const c = (pid: string, st: string) => counts.find((x) => x.id === pid && x.status === st)?.n ?? 0;
      return {
        asOf: now.toISOString(), periodDays: req.query.days, source: 'BranchHarbor registrations, attendance and instalments',
        enrolment: progs.map((p) => {
          const accepted = c(p.id, 'accepted');
          const held = accepted + c(p.id, 'awaiting_review');
          return { programmeId: p.id, programme: p.name, locationId: p.locationId, status: p.status, capacity: p.capacity, accepted, awaitingReview: c(p.id, 'awaiting_review'), awaitingPayment: c(p.id, 'submitted'), waitlisted: c(p.id, 'waitlisted'), withdrawn: c(p.id, 'withdrawn'), fillRate: p.capacity ? Math.round((held / p.capacity) * 1000) / 10 : null, fillRateUnavailableReason: p.capacity ? null : 'No capacity set' };
        }),
        capacity: ts.map((t) => {
          const roster = t.kind === 'squad' ? squads.find((x) => x.id === t.id)?.n ?? 0 : rosters.find((x) => x.id === t.id)?.n ?? 0;
          return { teamId: t.id, team: t.name, kind: t.kind, programmeId: t.programmeId, locationId: t.locationId, roster, capacity: t.capacity, spaces: t.capacity === null ? null : Math.max(0, t.capacity - roster) };
        }),
        attendance: ts.map((t) => {
          const rows = att.filter((a) => a.teamId === t.id);
          const recorded = rows.reduce((a, r) => a + r.n, 0);
          const attended = rows.filter((r) => r.status === 'present' || r.status === 'late').reduce((a, r) => a + r.n, 0);
          return { teamId: t.id, team: t.name, locationId: t.locationId, recorded, attended, excused: rows.find((r) => r.status === 'excused')?.n ?? 0, rate: recorded ? Math.round((attended / recorded) * 1000) / 10 : null, rateUnavailableReason: recorded ? null : 'No attendance recorded in this period' };
        }),
        balances: [...bal.entries()].map(([currency, v]) => ({ currency, ...v })), combinedBalance: null, combinedNote: 'Not shown — no conversion method defined',
        locations: locs.map((l) => ({ id: l.id, name: l.name, currency: l.currency, timeZone: l.timeZone })),
      };
    });

    /* ---------------- AI (drafts and proposals only) ---------------- */

    priv.post('/orgs/:orgId/sports/ai/programme-description', { schema: { tags: ['sports'], security: secured, params: orgParams, body: z.object({ programmeId: z.uuid(), tone: z.string().max(40).default('friendly'), locale: z.string().max(10).default('en') }) } }, async (req) => {
      const p = await programmeIn(req.params.orgId, req.body.programmeId);
      await requireLocationPerm(req, s.db, p.organizationId, p.locationId, 'ai.use');
      return draftProgrammeDescription(s, p.id, req.body.tone, req.body.locale);
    });

    priv.post('/orgs/:orgId/sports/ai/enrolment-summary', { schema: { tags: ['sports'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid().optional() }) } }, async (req) => {
      const ai = await authorisedLocations(req, s.db, req.params.orgId, 'ai.use');
      const rep = await authorisedLocations(req, s.db, req.params.orgId, 'reports.read');
      const locs = (await s.db.select().from(locations).where(eq(locations.organizationId, req.params.orgId))).filter((l) => (ai === 'all' || ai.has(l.id)) && (rep === 'all' || rep.has(l.id)) && (!req.body.locationId || l.id === req.body.locationId));
      if (!locs.length) throw forbidden('AI and report access are needed in this scope');
      return summariseEnrolment(s, locs.map((l) => l.id), req.body.locationId ? locs[0]!.name : 'all authorised locations');
    });

    priv.post('/orgs/:orgId/sports/ai/conflict-resolutions', { schema: { tags: ['sports'], security: secured, params: orgParams, summary: 'AI ranks rule-engine options for a clashing session and stores them as proposals. Nothing is changed until a person applies one.', body: z.object({ sessionId: z.uuid() }) } }, async (req) => {
      const [sess] = await s.db.select({ s: trainingSessions, tz: locations.timeZone }).from(trainingSessions).innerJoin(locations, eq(locations.id, trainingSessions.locationId)).where(and(eq(trainingSessions.id, req.body.sessionId), eq(trainingSessions.organizationId, req.params.orgId)));
      if (!sess) throw notFound('Session');
      await requireLocationPerm(req, s.db, req.params.orgId, sess.s.locationId, 'ai.use');
      await requireLocationPerm(req, s.db, req.params.orgId, sess.s.locationId, 'operations.write');
      const candidates = await suggestResolutions(s.db, sess.s, sess.tz);
      const ranked = await rankConflictResolutions(s, sess.s.id, candidates);
      await s.db.delete(sportsScheduleProposals).where(and(eq(sportsScheduleProposals.sessionId, sess.s.id), eq(sportsScheduleProposals.status, 'proposed'), eq(sportsScheduleProposals.source, 'ai')));
      const rows = ranked.length ? await s.db.insert(sportsScheduleProposals).values(ranked.map((r) => ({ organizationId: req.params.orgId, sessionId: sess.s.id, source: 'ai', proposal: { kind: r.candidate.kind, venueId: r.candidate.venueId, venueName: r.candidate.venueName, startsAt: r.candidate.startsAt, endsAt: r.candidate.endsAt }, rationale: r.rationale, createdBy: req.user!.id }))).returning() : [];
      return { proposals: rows, model: s.ai.model, status: 'proposals_only' };
    });
  });
};

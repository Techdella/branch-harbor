import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ACTION_PLAN_STATUSES, STARTER_SURVEY, surveyBodySchema, validateSurveyAnswers, type SurveyAnswer } from '@bh/shared';
import { franchiseSurveyActions, franchiseSurveyResponses, franchiseSurveyRounds, franchiseSurveys } from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { hasCapability, requireMember } from '../services/authz.ts';
import { toCsv } from '../services/finance/exports.ts';
import {
  SURVEY_MODULE, inAudience, loadSurvey, openRound, orgToday, respondentKey, respondentSlice, resultScope, roundsOf, serializeSurvey, surveyResults, surveyTrend,
} from '../services/franchise-dev/surveys.ts';
import { userNames } from '../services/network-access.ts';
import { idParams, orgParams, patchOf, secured } from './_common.ts';

const tags = ['surveys'];
const org = (organizationId: string) => ({ organizationId, kind: 'organization' as const, id: organizationId });
const answersSchema = z.record(z.string().max(40), z.union([z.number().int(), z.string().max(4000), z.null()]));

/**
 * Franchisee satisfaction surveys (`/v1/orgs/:orgId/surveys`, module `community.surveys`). HQ writes and launches;
 * the audience answers (anonymous by default, results only above the threshold); results are scoped to the viewer.
 */
export const surveyRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);

  const canManage = (req: Parameters<typeof hasCapability>[0], orgId: string) => hasCapability(req, db, SURVEY_MODULE, 'publish', org(orgId));
  const requireManage = async (req: Parameters<typeof hasCapability>[0], orgId: string) => {
    await requireMember(req, db, orgId);
    if (!(await canManage(req, orgId))) throw forbidden('Only HQ can create and launch surveys');
  };

  app.get('/orgs/:orgId/surveys', { schema: { tags, security: secured, params: orgParams, summary: 'Surveys to answer (open rounds in your audience) and, for people who run surveys or see results, every survey' } }, async (req) => {
    const { orgId } = req.params;
    const mine = await requireMember(req, db, orgId);
    const all = await db.select().from(franchiseSurveys).where(eq(franchiseSurveys.organizationId, orgId)).orderBy(desc(franchiseSurveys.createdAt));
    const rounds = all.length ? await db.select().from(franchiseSurveyRounds).where(inArray(franchiseSurveyRounds.surveyId, all.map((x) => x.id))).orderBy(asc(franchiseSurveyRounds.opensOn)) : [];
    const answered = new Set<string>();
    for (const r of rounds.filter((x) => x.status === 'open')) {
      const [row] = await db.select({ id: franchiseSurveyResponses.id }).from(franchiseSurveyResponses).where(and(eq(franchiseSurveyResponses.roundId, r.id), eq(franchiseSurveyResponses.respondentKey, respondentKey(s.cfg.ENCRYPTION_KEY, req.user!.id, r.id))));
      if (row) answered.add(r.id);
    }
    const toAnswer = all.filter((sv) => sv.status === 'active' && inAudience(sv, mine)).map((sv) => {
      const open = rounds.find((r) => r.surveyId === sv.id && r.status === 'open');
      return open ? { id: sv.id, title: sv.title, description: sv.description, anonymous: sv.anonymous, roundId: open.id, closesOn: open.closesOn, answered: answered.has(open.id) } : null;
    }).filter((x) => !!x);
    const scope = resultScope(mine, orgId);
    const manage = await canManage(req, orgId);
    return {
      toAnswer,
      surveys: scope ? all.filter((sv) => manage || sv.status !== 'draft').map((sv) => serializeSurvey(sv, rounds.filter((r) => r.surveyId === sv.id))) : [],
      can: { manage, results: !!scope, export: await hasCapability(req, db, SURVEY_MODULE, 'export', org(orgId)), actions: await hasCapability(req, db, SURVEY_MODULE, 'edit', org(orgId)) },
      starter: STARTER_SURVEY,
    };
  });

  app.post('/orgs/:orgId/surveys', { schema: { tags, security: secured, params: orgParams, body: surveyBodySchema, summary: 'Create a survey as a draft (community.surveys publish, organisation-wide)' } }, async (req, reply) => {
    const { orgId } = req.params;
    await requireManage(req, orgId);
    const [sv] = await db.insert(franchiseSurveys).values({ organizationId: orgId, ...req.body, createdBy: req.user!.id }).returning();
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'survey.created', targetType: 'franchise_survey', targetId: sv!.id, ip: req.ip });
    return reply.code(201).send(serializeSurvey(sv!));
  });

  app.put('/orgs/:orgId/surveys/:id', { schema: { tags, security: secured, params: idParams, body: surveyBodySchema, summary: 'Edit a survey. Questions can only change while no round has responses.' } }, async (req) => {
    const { orgId, id } = req.params;
    await requireManage(req, orgId);
    const sv = await loadSurvey(db, orgId, id);
    const rounds = await roundsOf(db, id);
    const [any] = rounds.length ? await db.select({ id: franchiseSurveyResponses.id }).from(franchiseSurveyResponses).where(inArray(franchiseSurveyResponses.roundId, rounds.map((r) => r.id))).limit(1) : [];
    if (any && JSON.stringify(req.body.questions.map((q) => [q.id, q.type])) !== JSON.stringify(sv.questions.map((q) => [q.id, q.type]))) throw conflict('survey_has_responses', 'Questions can’t be added, removed or change type once people have answered. Create a new survey instead.');
    if (any && req.body.anonymous !== sv.anonymous) throw conflict('survey_has_responses', 'Anonymity can’t change once people have answered.');
    const [row] = await db.update(franchiseSurveys).set({ ...req.body, updatedAt: new Date() }).where(eq(franchiseSurveys.id, id)).returning();
    return serializeSurvey(row!, rounds);
  });

  app.post('/orgs/:orgId/surveys/:id/launch', { schema: { tags, security: secured, params: idParams, summary: 'Open a round now and invite the audience; recurring surveys then open the next round on schedule' } }, async (req) => {
    const { orgId, id } = req.params;
    await requireManage(req, orgId);
    const sv = await loadSurvey(db, orgId, id);
    const rounds = await roundsOf(db, id);
    if (rounds.some((r) => r.status === 'open')) throw conflict('round_open', 'A round is already open');
    const round = await openRound(s, sv, await orgToday(db, orgId), req.user!.id);
    if (!round) throw conflict('round_exists', 'A round already started today');
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'survey.launched', targetType: 'franchise_survey', targetId: id, metadata: { roundId: round.id, invited: round.invitedCount }, ip: req.ip });
    return serializeSurvey((await loadSurvey(db, orgId, id)), await roundsOf(db, id));
  });

  app.post('/orgs/:orgId/surveys/:id/close', { schema: { tags, security: secured, params: idParams, body: z.object({ archive: z.boolean().default(false) }).default({ archive: false }), summary: 'Close the open round now (and optionally stop the schedule)' } }, async (req) => {
    const { orgId, id } = req.params;
    await requireManage(req, orgId);
    await loadSurvey(db, orgId, id);
    await db.update(franchiseSurveyRounds).set({ status: 'closed' }).where(and(eq(franchiseSurveyRounds.surveyId, id), eq(franchiseSurveyRounds.status, 'open')));
    if (req.body.archive) await db.update(franchiseSurveys).set({ status: 'archived', nextRunOn: null, updatedAt: new Date() }).where(eq(franchiseSurveys.id, id));
    return serializeSurvey(await loadSurvey(db, orgId, id), await roundsOf(db, id));
  });

  /* ------------------------------ answering ------------------------------ */

  app.get('/orgs/:orgId/surveys/:id/respond', { schema: { tags, security: secured, params: idParams, summary: 'The open round to answer (only for people in the audience)' } }, async (req) => {
    const { orgId, id } = req.params;
    const mine = await requireMember(req, db, orgId);
    const sv = await loadSurvey(db, orgId, id);
    if (sv.status !== 'active' || !inAudience(sv, mine)) throw notFound('Survey');
    const open = (await roundsOf(db, id)).find((r) => r.status === 'open');
    if (!open) throw notFound('Survey round');
    const [done] = await db.select({ id: franchiseSurveyResponses.id }).from(franchiseSurveyResponses).where(and(eq(franchiseSurveyResponses.roundId, open.id), eq(franchiseSurveyResponses.respondentKey, respondentKey(s.cfg.ENCRYPTION_KEY, req.user!.id, open.id))));
    return { id: sv.id, title: sv.title, description: sv.description, anonymous: sv.anonymous, minResponses: sv.minResponses, questions: sv.questions, round: { id: open.id, label: open.label, closesOn: open.closesOn }, answered: !!done };
  });

  app.post('/orgs/:orgId/surveys/:id/respond', { schema: { tags, security: secured, params: idParams, body: z.object({ answers: answersSchema }), summary: 'Answer the open round (once per person; anonymous surveys keep no link to you)' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    const mine = await requireMember(req, db, orgId);
    const sv = await loadSurvey(db, orgId, id);
    if (sv.status !== 'active' || !inAudience(sv, mine)) throw notFound('Survey');
    const open = (await roundsOf(db, id)).find((r) => r.status === 'open');
    if (!open) throw conflict('round_closed', 'This survey is closed');
    const answers = req.body.answers as Record<string, SurveyAnswer>;
    const errs = validateSurveyAnswers(sv.questions, answers);
    if (Object.keys(errs).length) throw validationError('Check your answers', errs);
    const slice = await respondentSlice(db, orgId, mine);
    const npsQ = sv.questions.find((q) => q.type === 'nps');
    const [row] = await db.insert(franchiseSurveyResponses).values({
      organizationId: orgId, roundId: open.id, respondentKey: respondentKey(s.cfg.ENCRYPTION_KEY, req.user!.id, open.id), userId: sv.anonymous ? null : req.user!.id,
      regionId: slice.regionId, ownerGroupId: slice.ownerGroupId, answers, npsScore: npsQ && typeof answers[npsQ.id] === 'number' ? (answers[npsQ.id] as number) : null,
    }).onConflictDoNothing().returning();
    if (!row) throw conflict('already_answered', 'You already answered this round');
    return reply.code(201).send({ status: 'received' as const });
  });

  /* -------------------------------- results ------------------------------- */

  const scopeFor = async (req: Parameters<typeof hasCapability>[0], orgId: string) => {
    const scope = resultScope(await requireMember(req, db, orgId), orgId);
    if (!scope) throw forbidden('You don’t see survey results');
    return scope;
  };

  app.get('/orgs/:orgId/surveys/:id/results', { schema: { tags, security: secured, params: idParams, querystring: z.object({ roundId: z.uuid().optional() }), summary: 'Results of a round in your scope: eNPS, questions, themes, regions and owner groups (small groups hidden), comments, trend, action plans' } }, async (req) => {
    const { orgId, id } = req.params;
    const scope = await scopeFor(req, orgId);
    const sv = await loadSurvey(db, orgId, id);
    const rounds = await roundsOf(db, id);
    const round = req.query.roundId ? rounds.find((r) => r.id === req.query.roundId) : [...rounds].reverse().find((r) => r.status === 'closed') ?? rounds[rounds.length - 1];
    const actions = await db.select().from(franchiseSurveyActions).where(eq(franchiseSurveyActions.surveyId, id)).orderBy(asc(franchiseSurveyActions.dueOn));
    const names = await userNames(db, actions.map((a) => a.ownerUserId));
    return {
      survey: serializeSurvey(sv, rounds), scope: scope === 'all' ? 'all' : 'partial', round: round ? await surveyResults(db, sv, round, scope) : null, trend: await surveyTrend(db, sv, scope),
      actions: actions.map((a) => ({ id: a.id, roundId: a.roundId, theme: a.theme, title: a.title, description: a.description, ownerUserId: a.ownerUserId, ownerName: names.get(a.ownerUserId ?? '') ?? null, dueOn: a.dueOn, status: a.status, shared: a.shared })),
    };
  });

  app.get('/orgs/:orgId/surveys/:id/results.csv', { schema: { tags, security: secured, params: idParams, querystring: z.object({ roundId: z.uuid() }), summary: 'Aggregated results of a round (never individual answers of anonymous surveys)' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    const scope = await scopeFor(req, orgId);
    if (!(await hasCapability(req, db, SURVEY_MODULE, 'export', org(orgId)))) throw forbidden('Missing export access to surveys');
    const sv = await loadSurvey(db, orgId, id);
    const round = (await roundsOf(db, id)).find((r) => r.id === req.query.roundId);
    if (!round) throw notFound('Survey round');
    const r = await surveyResults(db, sv, round, scope);
    const rows: unknown[][] = [['responses', '', r.responses], ['enps', '', r.nps?.score ?? '']];
    for (const q of r.questions) rows.push([q.id, q.label, 'average' in q ? (q.average ?? '') : 'options' in q && q.options ? q.options.map((o) => `${o.option}: ${o.count}`).join('; ') : q.answered]);
    for (const g of r.byRegion) rows.push([`region:${g.name}`, '', g.visible ? g.nps ?? '' : 'hidden (too few responses)']);
    for (const g of r.byOwnerGroup) rows.push([`owner_group:${g.name}`, '', g.visible ? g.nps ?? '' : 'hidden (too few responses)']);
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="survey-${round.opensOn}.csv"`).send(toCsv(['metric', 'question', 'value'], rows));
  });

  /* ------------------------------ action plans ----------------------------- */

  const actionBody = z.object({ roundId: z.uuid().nullable().optional(), theme: z.string().max(40).nullable().optional(), title: z.string().trim().min(1).max(200), description: z.string().max(4000).nullable().optional(), ownerUserId: z.uuid().nullable().optional(), dueOn: z.iso.date().nullable().optional(), status: z.enum(ACTION_PLAN_STATUSES).default('open'), shared: z.boolean().default(false) });

  app.post('/orgs/:orgId/surveys/:id/actions', { schema: { tags, security: secured, params: idParams, body: actionBody, summary: 'Add an action plan item (community.surveys edit, organisation-wide)' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireMember(req, db, orgId);
    if (!(await hasCapability(req, db, SURVEY_MODULE, 'edit', org(orgId))) || !resultScope(await requireMember(req, db, orgId), orgId)) throw forbidden('Missing access to action plans');
    await loadSurvey(db, orgId, id);
    const [a] = await db.insert(franchiseSurveyActions).values({ organizationId: orgId, surveyId: id, ...req.body, createdBy: req.user!.id }).returning();
    return reply.code(201).send({ id: a!.id, status: a!.status });
  });

  app.patch('/orgs/:orgId/surveys/:id/actions/:actionId', { schema: { tags, security: secured, params: idParams.extend({ actionId: z.uuid() }), body: patchOf(actionBody) } }, async (req) => {
    const { orgId, id, actionId } = req.params;
    await requireMember(req, db, orgId);
    if (!(await hasCapability(req, db, SURVEY_MODULE, 'edit', org(orgId)))) throw forbidden('Missing access to action plans');
    const [a] = await db.update(franchiseSurveyActions).set({ ...req.body, updatedAt: new Date() }).where(and(eq(franchiseSurveyActions.id, actionId), eq(franchiseSurveyActions.surveyId, id), eq(franchiseSurveyActions.organizationId, orgId))).returning();
    if (!a) throw notFound('Action');
    return { id: a.id, status: a.status };
  });
};

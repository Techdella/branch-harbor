/**
 * Franchisee satisfaction surveys (Community → Surveys, module `community.surveys`).
 *
 * - HQ (publish, organisation-wide) writes a survey (eNPS + custom questions) and launches it; recurring surveys open
 *   a new round on schedule. Everyone in the audience who holds the module (view) can answer once per round.
 * - Anonymous surveys never store who answered (an HMAC of person + round prevents double answers) and results,
 *   slices by region / owner group and comments only show once at least `minResponses` people answered.
 * - Results are scoped: publish on a region or owner group shows only that slice's responses.
 */
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { nextRoundDate, npsOf, sliceVisible, type SurveyAnswer, type SurveyQuestion } from '@bh/shared';
import type { Services } from '../../context.ts';
import type { Exec } from '../../db/client.ts';
import { franchiseSurveyResponses, franchiseSurveyRounds, franchiseSurveys, locations, organizations, ownerGroups, regions } from '../../db/schema/index.ts';
import { hasCapabilityInScope, type Assignment } from '../../domain/scope.ts';
import { addDays, localDateParts } from '../../lib/tz.ts';
import { notFound } from '../../lib/errors.ts';
import { loadOrgAssignments } from '../authz.ts';
import { networkNotify, prefsFor } from '../network-notify.ts';
import { recipientsOf, sendNetworkEmails } from '../network-emails.ts';

export const SURVEY_MODULE = 'community.surveys';
export type Survey = typeof franchiseSurveys.$inferSelect;
export type Round = typeof franchiseSurveyRounds.$inferSelect;

export async function orgToday(db: Exec, organizationId: string, now = new Date()) {
  const [o] = await db.select({ tz: organizations.defaultTimeZone }).from(organizations).where(eq(organizations.id, organizationId));
  return localDateParts(now, o?.tz ?? 'UTC').date;
}

export const respondentKey = (secret: string, userId: string, roundId: string) => createHmac('sha256', secret).update(`${userId}:${roundId}`).digest('hex');

/** Where a respondent sits in the network (for slices): owner group and region from their franchise assignment. */
export async function respondentSlice(db: Exec, organizationId: string, assignments: Assignment[]) {
  const og = assignments.find((a) => a.scopeKind === 'owner_group');
  const loc = assignments.find((a) => a.scopeKind === 'location');
  if (og) {
    const [l] = await db.select({ regionId: locations.regionId }).from(locations).where(and(eq(locations.organizationId, organizationId), eq(locations.ownerGroupId, og.scopeId))).limit(1);
    return { ownerGroupId: og.scopeId, regionId: l?.regionId ?? null };
  }
  if (loc) {
    const [l] = await db.select({ regionId: locations.regionId, ownerGroupId: locations.ownerGroupId }).from(locations).where(eq(locations.id, loc.scopeId));
    return { ownerGroupId: l?.ownerGroupId ?? null, regionId: l?.regionId ?? null };
  }
  const reg = assignments.find((a) => a.scopeKind === 'region');
  return { ownerGroupId: null, regionId: reg?.scopeId ?? null };
}

/** Is a person part of the survey's audience? Franchise owners = owner-group assignments; managers = location ones too. */
export function inAudience(s: Pick<Survey, 'audience'>, assignments: Assignment[]) {
  const view = assignments.filter((a) => a.capabilities?.has('community.surveys:view'));
  if (view.some((a) => a.scopeKind === 'owner_group')) return true;
  return s.audience === 'owners_and_managers' && view.some((a) => a.scopeKind === 'location' && (a.role === 'location_manager' || a.role === 'custom'));
}

/** User ids in the audience (for invitations and the response rate). */
export async function audienceUserIds(db: Exec, survey: Survey) {
  const byUser = await loadOrgAssignments(db, survey.organizationId);
  return [...byUser.entries()].filter(([, a]) => inAudience(survey, a)).map(([id]) => id);
}

/** Opens a round today for `openDays` days and schedules the next one. */
export async function openRound(s: Services, survey: Survey, today: string, actorUserId: string | null) {
  const invited = await audienceUserIds(s.db, survey);
  const label = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${today}T12:00:00Z`));
  const [round] = await s.db.insert(franchiseSurveyRounds).values({ organizationId: survey.organizationId, surveyId: survey.id, label, opensOn: today, closesOn: addDays(today, survey.openDays), invitedCount: invited.length })
    .onConflictDoNothing().returning();
  await s.db.update(franchiseSurveys).set({ status: 'active', nextRunOn: nextRoundDate(today, survey.recurrence as 'once'), updatedAt: new Date() }).where(eq(franchiseSurveys.id, survey.id));
  if (round) {
    await networkNotify(s, { organizationId: survey.organizationId, userIds: invited, kind: 'survey', title: survey.title, body: survey.anonymous ? 'Your answers are anonymous. It takes about three minutes.' : 'It takes about three minutes.', link: `/surveys/${survey.id}/respond`, data: { surveyId: survey.id, roundId: round.id }, exclude: actorUserId ? [actorUserId] : [] });
    await emailInvitations(s, survey, round, invited.filter((id) => id !== actorUserId));
  }
  return round ?? null;
}

/**
 * Survey invitations by email as well as in the app: one email per person in their own language, with the link to
 * answer. People who switched off survey notifications get neither.
 */
async function emailInvitations(s: Services, survey: Survey, round: Round, userIds: string[]) {
  if (!userIds.length) return 0;
  const prefs = await prefsFor(s.db, survey.organizationId, userIds);
  const to = userIds.filter((id) => !prefs.get(id)?.mutedKinds.includes('survey'));
  const [org] = await s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, survey.organizationId));
  return sendNetworkEmails(s, await recipientsOf(s.db, to), 'survey_invite', {
    kind: 'survey_invite', business: org?.name ?? '', title: survey.title, closesOn: round.closesOn, anonymous: survey.anonymous,
    url: `${s.cfg.APP_URL.replace(/\/$/, '')}/surveys/${survey.id}/respond`,
  });
}

/** Opens scheduled rounds and closes finished ones (hourly job; idempotent). */
export async function runSurveyJobs(s: Services, now = new Date(), organizationId?: string) {
  let opened = 0;
  let closed = 0;
  const due = await s.db.select().from(franchiseSurveys).where(and(eq(franchiseSurveys.status, 'active'), ...(organizationId ? [eq(franchiseSurveys.organizationId, organizationId)] : [])));
  for (const sv of due) {
    const today = await orgToday(s.db, sv.organizationId, now);
    const res = await s.db.update(franchiseSurveyRounds).set({ status: 'closed' }).where(and(eq(franchiseSurveyRounds.surveyId, sv.id), eq(franchiseSurveyRounds.status, 'open'), lt(franchiseSurveyRounds.closesOn, today))).returning();
    closed += res.length;
    if (sv.nextRunOn && sv.nextRunOn <= today) {
      const [open] = await s.db.select().from(franchiseSurveyRounds).where(and(eq(franchiseSurveyRounds.surveyId, sv.id), eq(franchiseSurveyRounds.status, 'open')));
      if (!open && (await openRound(s, sv, today, null))) opened++;
    }
  }
  return { opened, closed };
}

export async function loadSurvey(db: Exec, organizationId: string, id: string) {
  const [sv] = await db.select().from(franchiseSurveys).where(and(eq(franchiseSurveys.id, id), eq(franchiseSurveys.organizationId, organizationId)));
  if (!sv) throw notFound('Survey');
  return sv;
}

export async function roundsOf(db: Exec, surveyId: string) {
  return db.select().from(franchiseSurveyRounds).where(eq(franchiseSurveyRounds.surveyId, surveyId)).orderBy(asc(franchiseSurveyRounds.opensOn));
}

/** Which responses the viewer may see results for: all (organisation-wide publish) or the slices of their scopes. */
export function resultScope(assignments: Assignment[], organizationId: string): 'all' | { regionIds: Set<string>; ownerGroupIds: Set<string> } | null {
  const pub = assignments.filter((a) => hasCapabilityInScope([a], SURVEY_MODULE, 'publish', { organizationId, kind: a.scopeKind, ...(a.scopeKind === 'region' ? { regionId: a.scopeId } : a.scopeKind === 'owner_group' ? { ownerGroupId: a.scopeId } : a.scopeKind === 'location' ? { locationId: a.scopeId } : {}) }));
  if (!pub.length) return null;
  if (pub.some((a) => a.scopeKind === 'organization')) return 'all';
  return { regionIds: new Set(pub.filter((a) => a.scopeKind === 'region').map((a) => a.scopeId)), ownerGroupIds: new Set(pub.filter((a) => a.scopeKind === 'owner_group').map((a) => a.scopeId)) };
}

type ResponseRow = typeof franchiseSurveyResponses.$inferSelect;

function questionStats(q: SurveyQuestion, rows: ResponseRow[]) {
  const vals = rows.map((r) => r.answers[q.id]).filter((v): v is Exclude<SurveyAnswer, null> => v !== null && v !== undefined && v !== '');
  if (q.type === 'nps') { const n = npsOf(vals as number[]); return { id: q.id, type: q.type, label: q.label, theme: q.theme, answered: vals.length, nps: n, average: vals.length ? Math.round(((vals as number[]).reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null, distribution: Array.from({ length: 11 }, (_, i) => (vals as number[]).filter((v) => v === i).length) }; }
  if (q.type === 'scale') return { id: q.id, type: q.type, label: q.label, theme: q.theme, answered: vals.length, average: vals.length ? Math.round(((vals as number[]).reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null, distribution: [1, 2, 3, 4, 5].map((i) => (vals as number[]).filter((v) => v === i).length) };
  if (q.type === 'choice') return { id: q.id, type: q.type, label: q.label, theme: q.theme, answered: vals.length, options: q.options.map((o) => ({ option: o, count: vals.filter((v) => v === o).length })) };
  return { id: q.id, type: q.type, label: q.label, theme: q.theme, answered: vals.length };
}

/** Deterministic shuffle so comment order never reveals submission order. */
function shuffled<T>(xs: T[], seed: string) {
  const h = (s: string) => { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) | 0; return x; };
  return [...xs].map((x, i) => ({ x, k: h(`${seed}:${i}`) })).sort((a, b) => a.k - b.k).map((o) => o.x);
}

/**
 * Results of a round within the viewer's scope. Below the threshold (anonymous) only the response count is returned;
 * region and owner-group slices are dropped individually when they are too small.
 */
export async function surveyResults(db: Exec, sv: Survey, round: Round, scope: 'all' | { regionIds: Set<string>; ownerGroupIds: Set<string> }) {
  const all = await db.select().from(franchiseSurveyResponses).where(eq(franchiseSurveyResponses.roundId, round.id));
  const rows = scope === 'all' ? all : all.filter((r) => (r.regionId && scope.regionIds.has(r.regionId)) || (r.ownerGroupId && scope.ownerGroupIds.has(r.ownerGroupId)));
  const visible = sliceVisible(rows.length, sv.anonymous, sv.minResponses);
  const base = { roundId: round.id, label: round.label, opensOn: round.opensOn, closesOn: round.closesOn, status: round.status, responses: rows.length, invited: round.invitedCount, responseRate: round.invitedCount && scope === 'all' ? Math.round((all.length / round.invitedCount) * 100) : null, visible, minResponses: sv.minResponses, anonymous: sv.anonymous };
  if (!visible) return { ...base, nps: null, questions: [], byRegion: [], byOwnerGroup: [], comments: [] };
  const npsQ = sv.questions.find((q) => q.type === 'nps');
  const nps = npsQ ? npsOf(rows.map((r) => r.answers[npsQ.id]).filter((v): v is number => typeof v === 'number')) : null;
  const regionNames = new Map((await db.select({ id: regions.id, name: regions.name }).from(regions).where(eq(regions.organizationId, sv.organizationId))).map((r) => [r.id, r.name]));
  const groupNames = new Map((await db.select({ id: ownerGroups.id, name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.organizationId, sv.organizationId))).map((r) => [r.id, r.name]));
  const slice = (key: 'regionId' | 'ownerGroupId', names: Map<string, string>) => {
    const ids = [...new Set(rows.map((r) => r[key]).filter((x): x is string => !!x))];
    return ids.map((id) => {
      const part = rows.filter((r) => r[key] === id);
      const show = sliceVisible(part.length, sv.anonymous, sv.minResponses);
      return { id, name: names.get(id) ?? '—', responses: part.length, visible: show, nps: show && npsQ ? npsOf(part.map((r) => r.answers[npsQ.id]).filter((v): v is number => typeof v === 'number')).score : null, themes: show ? themeAverages(sv.questions, part) : [] };
    }).sort((a, b) => b.responses - a.responses);
  };
  const textQs = sv.questions.filter((q) => q.type === 'text');
  const comments = shuffled(rows.flatMap((r) => textQs.map((q) => ({ questionId: q.id, text: r.answers[q.id] }))).filter((c): c is { questionId: string; text: string } => typeof c.text === 'string' && c.text.trim().length > 0), round.id)
    .map((c) => ({ ...c, ...(sv.anonymous ? {} : { userId: rows.find((r) => r.answers[c.questionId] === c.text)?.userId ?? null }) }));
  return { ...base, nps, questions: sv.questions.map((q) => questionStats(q, rows)), themes: themeAverages(sv.questions, rows), byRegion: slice('regionId', regionNames), byOwnerGroup: slice('ownerGroupId', groupNames), comments };
}

function themeAverages(questions: SurveyQuestion[], rows: ResponseRow[]) {
  const themes = [...new Set(questions.filter((q) => q.type === 'scale' && q.theme).map((q) => q.theme!))];
  return themes.map((t) => {
    const vals = rows.flatMap((r) => questions.filter((q) => q.theme === t && q.type === 'scale').map((q) => r.answers[q.id])).filter((v): v is number => typeof v === 'number');
    return { theme: t, average: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null };
  });
}

/** eNPS and response counts per round (trend), within the viewer's scope and threshold. */
export async function surveyTrend(db: Exec, sv: Survey, scope: 'all' | { regionIds: Set<string>; ownerGroupIds: Set<string> }) {
  const rounds = await roundsOf(db, sv.id);
  const resp = rounds.length ? await db.select().from(franchiseSurveyResponses).where(inArray(franchiseSurveyResponses.roundId, rounds.map((r) => r.id))) : [];
  const npsQ = sv.questions.find((q) => q.type === 'nps');
  return rounds.map((r) => {
    const rows = resp.filter((x) => x.roundId === r.id && (scope === 'all' || (x.regionId && scope.regionIds.has(x.regionId)) || (x.ownerGroupId && scope.ownerGroupIds.has(x.ownerGroupId))));
    const show = sliceVisible(rows.length, sv.anonymous, sv.minResponses);
    return { roundId: r.id, label: r.label, opensOn: r.opensOn, responses: rows.length, nps: show && npsQ ? npsOf(rows.map((x) => x.answers[npsQ.id]).filter((v): v is number => typeof v === 'number')).score : null, themes: show ? themeAverages(sv.questions, rows) : [] };
  });
}

export function serializeSurvey(sv: Survey, rounds: Round[] = []) {
  const open = rounds.find((r) => r.status === 'open') ?? null;
  return {
    id: sv.id, title: sv.title, description: sv.description, questions: sv.questions, anonymous: sv.anonymous, minResponses: sv.minResponses, audience: sv.audience, recurrence: sv.recurrence, openDays: sv.openDays,
    status: sv.status, nextRunOn: sv.nextRunOn, rounds: rounds.map((r) => ({ id: r.id, label: r.label, opensOn: r.opensOn, closesOn: r.closesOn, status: r.status, invited: r.invitedCount })), openRoundId: open?.id ?? null,
    createdAt: sv.createdAt.toISOString(), updatedAt: sv.updatedAt.toISOString(),
  };
}


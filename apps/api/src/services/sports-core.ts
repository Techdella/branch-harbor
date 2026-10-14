/**
 * Sports registration, capacity, fees and instalments.
 *
 * Rules (spec §10/§14):
 *  - A place is held while the first payment completes (`submitted` + holdExpiresAt). Capacity counts
 *    accepted + awaiting_review + live holds. Every capacity decision locks the programme row.
 *  - Payment never equals selection: an approval-required programme moves to `awaiting_review` when paid.
 *  - Payment retries (failed intents, duplicate/late webhooks) re-check capacity under the same lock and
 *    never move a registration backwards or past review.
 *  - Money is integer minor units in the location currency; balances are reported per currency.
 */
import { and, asc, count, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { checkAgeEligibility, instalmentState, siblingDiscount, splitInstalments, type SportsAgeRule } from '@bh/shared';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import {
  consentRecords, customers, guardianRelationships, locations, paymentReferences, programmes, registrations, seasons, sportsFeeAdjustments, sportsFeePlans,
  sportsInstalments, sportsRegistrationForms, sportsRestrictedAnswers, sportsTeamCoaches, teams, type SportsFormQuestion,
} from '../db/schema/index.ts';
import { localDateParts } from '../lib/tz.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { hasPerm, requireLocationPerm } from './authz.ts';
import { findOrCreateCustomer, type ContactInput } from './customers.ts';
import { assertPaymentsEnabled, type PaymentRow } from './payments.ts';
import { guardiansOf, notifyGuardians } from './sports-notify.ts';

type Programme = typeof programmes.$inferSelect;
type Registration = typeof registrations.$inferSelect;
type Instalment = typeof sportsInstalments.$inferSelect;
type Team = typeof teams.$inferSelect;

export const ACTIVE_REG_STATES = ['submitted', 'awaiting_review', 'accepted', 'waitlisted'] as const;

/* ------------------------------------------------------------------ */
/* Access helpers                                                      */
/* ------------------------------------------------------------------ */

/** Teams a user coaches (head coach or assistant) in an organisation. */
export async function coachTeamIds(db: Exec, organizationId: string, userId: string): Promise<Set<string>> {
  const head = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.organizationId, organizationId), eq(teams.coachUserId, userId)));
  const asst = await db.select({ id: sportsTeamCoaches.teamId }).from(sportsTeamCoaches).where(and(eq(sportsTeamCoaches.organizationId, organizationId), eq(sportsTeamCoaches.userId, userId)));
  return new Set([...head, ...asst].map((r) => r.id));
}

export async function isCoachOf(db: Exec, team: Pick<Team, 'id' | 'coachUserId' | 'organizationId'>, userId: string) {
  if (team.coachUserId === userId) return true;
  const [row] = await db.select({ id: sportsTeamCoaches.id }).from(sportsTeamCoaches).where(and(eq(sportsTeamCoaches.teamId, team.id), eq(sportsTeamCoaches.userId, userId)));
  return !!row;
}

/** Managers (locations.read at the team's location) see every team; coaches only teams they coach. */
export async function requireTeamAccess(req: FastifyRequest, db: Exec, team: Team, permission: 'operations.read' | 'operations.write' = 'operations.write') {
  await requireLocationPerm(req, db, team.organizationId, team.locationId, permission);
  const manager = await hasPerm(req, db, 'locations.read', { organizationId: team.organizationId, kind: 'location', id: team.locationId });
  if (!manager && !(await isCoachOf(db, team, req.user!.id))) throw forbidden('You are not a coach of this team');
  return { manager };
}

/** Directors/administrators: managers with customer write access at the location (never plain coaches). */
export async function requireDirector(req: FastifyRequest, db: Exec, organizationId: string, locationId: string) {
  await requireLocationPerm(req, db, organizationId, locationId, 'operations.write');
  if (!(await hasPerm(req, db, 'customers.write', { organizationId, kind: 'location', id: locationId }))) throw forbidden('Only programme directors and administrators can do this');
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

export const todayIn = (timeZone: string, now = new Date()) => localDateParts(now, timeZone).date;

/** Effective age rule + cutoff for a programme (programme → season → today). */
export async function programmeAgeRule(db: Exec, p: Programme, today: string): Promise<{ rule: SportsAgeRule; cutoffDate: string }> {
  let rule = (p.ageRule as SportsAgeRule) ?? 'age_on_date';
  let cutoff = p.ageCutoffDate;
  if ((!cutoff || !p.ageRule) && p.seasonId) {
    const [season] = await db.select().from(seasons).where(eq(seasons.id, p.seasonId));
    if (season?.ageRule && !p.ageRule) rule = season.ageRule as SportsAgeRule;
    cutoff ??= season?.ageCutoffDate ?? null;
  }
  return { rule, cutoffDate: cutoff ?? today };
}

/* ------------------------------------------------------------------ */
/* Capacity                                                            */
/* ------------------------------------------------------------------ */

/** Places in use: accepted + awaiting review + submitted with a live hold. */
export async function placesHeld(db: Exec, programmeId: string, now = new Date(), excludeRegistrationId?: string) {
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(registrations).where(and(
    eq(registrations.programmeId, programmeId),
    or(inArray(registrations.status, ['accepted', 'awaiting_review']), and(eq(registrations.status, 'submitted'), gt(registrations.holdExpiresAt, now))),
    excludeRegistrationId ? ne(registrations.id, excludeRegistrationId) : undefined,
  ));
  return n;
}

export async function lockProgramme(tx: Tx, programmeId: string) {
  const [p] = await tx.select().from(programmes).where(eq(programmes.id, programmeId)).for('update');
  if (!p) throw notFound('Programme');
  return p;
}

export async function teamRosterCount(db: Exec, teamId: string) {
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(registrations).where(and(eq(registrations.teamId, teamId), eq(registrations.status, 'accepted')));
  return n;
}

/* ------------------------------------------------------------------ */
/* Forms                                                               */
/* ------------------------------------------------------------------ */

/** Built-in questions every registration asks, before the programme's custom questions. */
export const BUILT_IN_QUESTIONS: SportsFormQuestion[] = [
  { key: 'emergency_contact_name', label: 'Emergency contact name', type: 'text', required: true, category: 'emergency', coachVisible: true },
  { key: 'emergency_contact_phone', label: 'Emergency contact phone', type: 'phone', required: true, category: 'emergency', coachVisible: true },
  { key: 'medical_notes', label: 'Medical information the club should know (allergies, conditions, medication)', type: 'textarea', required: false, category: 'medical', help: 'Only programme administrators see this. Coaches see that information is on file and any action plan you mark as shareable.' },
  { key: 'medical_action_plan', label: 'Action plan coaches should follow (optional)', type: 'textarea', required: false, category: 'medical', coachVisible: true },
  { key: 'photo_consent', label: 'Photos of the participant may be used in club communications', type: 'yes_no', required: true, category: 'consent' },
];

export async function formQuestions(db: Exec, p: Programme) {
  if (!p.registrationFormId) return { form: null, questions: BUILT_IN_QUESTIONS };
  const [f] = await db.select().from(sportsRegistrationForms).where(eq(sportsRegistrationForms.id, p.registrationFormId));
  if (!f) return { form: null, questions: BUILT_IN_QUESTIONS };
  const custom = f.questions.filter((q) => !BUILT_IN_QUESTIONS.some((b) => b.key === q.key));
  return { form: f, questions: [...BUILT_IN_QUESTIONS, ...custom] };
}

export const isRestricted = (q: SportsFormQuestion) => q.category === 'medical' || q.category === 'emergency';

/** Validates answers and splits them into ordinary (registration.forms) and restricted (medical/emergency). */
export function splitAnswers(questions: SportsFormQuestion[], answers: Record<string, unknown>) {
  const fields: Record<string, string> = {};
  const general: Record<string, unknown> = {};
  const restricted: Record<string, unknown> = {};
  for (const q of questions) {
    const v = answers[q.key];
    const empty = v === undefined || v === null || (typeof v === 'string' && !v.trim());
    if (q.required && empty) { fields[`answers.${q.key}`] = `${q.label} is required`; continue; }
    if (empty) continue;
    if ((q.type === 'yes_no' || q.type === 'consent') && typeof v !== 'boolean') { fields[`answers.${q.key}`] = `${q.label}: answer yes or no`; continue; }
    if (q.type === 'select' && q.options && !q.options.includes(String(v))) { fields[`answers.${q.key}`] = `${q.label}: choose one of the options`; continue; }
    if (typeof v === 'string' && v.length > 2000) { fields[`answers.${q.key}`] = `${q.label} is too long`; continue; }
    (isRestricted(q) ? restricted : general)[q.key] = typeof v === 'string' ? v.trim() : v;
  }
  if (Object.keys(fields).length) throw validationError('Some registration questions need an answer', fields);
  const coachVisibleKeys = questions.filter((q) => isRestricted(q) && q.coachVisible).map((q) => q.key);
  return { general, restricted, coachVisibleKeys };
}

/** True when every required question has an answer on file (general + restricted). */
export function formsComplete(questions: SportsFormQuestion[], general: Record<string, unknown>, restrictedKeys: string[]) {
  return questions.filter((q) => q.required).every((q) => (isRestricted(q) ? restrictedKeys.includes(q.key) : general[q.key] !== undefined && general[q.key] !== ''));
}

/* ------------------------------------------------------------------ */
/* Fees and instalments                                                */
/* ------------------------------------------------------------------ */

export async function feePlansFor(db: Exec, programmeId: string) {
  return db.select().from(sportsFeePlans).where(and(eq(sportsFeePlans.programmeId, programmeId), eq(sportsFeePlans.active, true))).orderBy(asc(sportsFeePlans.createdAt));
}

/** Instalment lines for a plan; pay-in-full (or no plan) is one line due today. Past due dates move to today. */
export function scheduleFor(totalMinor: number, plan: typeof sportsFeePlans.$inferSelect | null, today: string) {
  if (!plan || plan.kind === 'full' || !plan.schedule.length) return splitInstalments(totalMinor, [{ dueOn: today, shareBps: 10_000 }]);
  const lines = splitInstalments(totalMinor, plan.schedule.map((s, i) => ({ dueOn: i === 0 || s.dueOn < today ? today : s.dueOn, shareBps: s.shareBps })));
  return lines;
}

export interface BalanceSummary {
  currency: string | null;
  total: number;
  paid: number;
  outstanding: number;
  overdue: number;
  state: 'none' | 'paid' | 'on_track' | 'due' | 'overdue' | 'waived';
  nextDue: { dueOn: string; amountMinor: number; instalmentId: string } | null;
}

export function balanceOf(inst: Instalment[], today: string): BalanceSummary {
  const live = inst.filter((i) => i.status !== 'cancelled');
  if (!live.length) return { currency: null, total: 0, paid: 0, outstanding: 0, overdue: 0, state: 'none', nextDue: null };
  const currency = live[0]!.currency;
  const paid = live.filter((i) => i.status === 'paid').reduce((a, i) => a + i.amountMinor, 0);
  const unpaid = live.filter((i) => i.status === 'scheduled').sort((a, b) => a.seq - b.seq);
  const outstanding = unpaid.reduce((a, i) => a + i.amountMinor, 0);
  const states = unpaid.map((i) => instalmentState(i, today));
  const overdue = unpaid.filter((_, k) => states[k] === 'overdue').reduce((a, i) => a + i.amountMinor, 0);
  const state = !unpaid.length ? (paid > 0 ? 'paid' : 'waived') : states.includes('overdue') ? 'overdue' : states.includes('due') ? 'due' : 'on_track';
  const n = unpaid[0];
  return { currency, total: paid + outstanding, paid, outstanding, overdue, state, nextDue: n ? { dueOn: n.dueOn, amountMinor: n.amountMinor, instalmentId: n.id } : null };
}

export function serializeInstalment(i: Instalment, today: string, paymentState?: string | null) {
  return {
    id: i.id, seq: i.seq, dueOn: i.dueOn, amount: { amount: i.amountMinor, currency: i.currency }, status: i.status,
    state: instalmentState(i, today), paidAt: i.paidAt?.toISOString() ?? null, paymentId: i.paymentId, paymentState: paymentState ?? null,
    remindersSent: i.remindersSent, lastReminderStage: i.lastReminderStage,
  };
}

/** Creates (or reuses an in-flight) PaymentIntent for one instalment. Each new attempt gets its own idempotency key. */
export async function payInstalment(s: Services, instalmentId: string, opts: { fresh?: boolean } = {}) {
  const [inst] = await s.db.select().from(sportsInstalments).where(eq(sportsInstalments.id, instalmentId));
  if (!inst) throw notFound('Instalment');
  if (inst.status !== 'scheduled') throw conflict('instalment_not_payable', `This instalment is ${inst.status}`);
  if (inst.amountMinor <= 0) throw conflict('instalment_not_payable', 'Nothing to pay for this instalment');
  if (inst.paymentId && !opts.fresh) {
    const [p] = await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, inst.paymentId));
    if (p && ['created', 'requires_action', 'processing'].includes(p.state) && p.amountMinor === inst.amountMinor) {
      return { payment: { id: p.id, clientSecret: p.clientSecret, amount: p.amountMinor, currency: p.currency, sandbox: p.sandbox === 1 }, instalment: inst };
    }
    if (p?.state === 'succeeded') throw conflict('instalment_already_paid', 'This instalment has already been paid');
  }
  const acct = await assertPaymentsEnabled(s.db, inst.organizationId, inst.locationId);
  if (acct.location.currency !== inst.currency) throw validationError('Instalment currency does not match the location currency');
  const attempt = inst.paymentAttempts + 1;
  const applicationFeeMinor = Math.floor((inst.amountMinor * acct.feeBps) / 10_000);
  const intent = await s.payments.createPaymentIntent({
    amountMinor: inst.amountMinor, currency: inst.currency, connectedAccountId: acct.accountId, applicationFeeMinor,
    idempotencyKey: `sports_instalment:${inst.id}:${attempt}`, description: `Registration instalment ${inst.seq}`,
    metadata: { bh_org: inst.organizationId, bh_location: inst.locationId, bh_target_type: 'registration', bh_target_id: inst.registrationId, bh_instalment: inst.id },
  });
  const [ref] = await s.db.insert(paymentReferences).values({
    organizationId: inst.organizationId, locationId: inst.locationId, provider: 'stripe', externalId: intent.id, connectedAccountId: acct.accountId,
    amountMinor: inst.amountMinor, currency: inst.currency, applicationFeeMinor, state: 'created', targetType: 'registration', targetId: inst.registrationId,
    clientSecret: intent.clientSecret, sandbox: s.payments.mode === 'sandbox' ? 1 : 0,
  }).returning();
  await s.db.update(sportsInstalments).set({ paymentId: ref!.id, paymentAttempts: attempt, updatedAt: new Date() }).where(eq(sportsInstalments.id, inst.id));
  return { payment: { id: ref!.id, clientSecret: intent.clientSecret, amount: inst.amountMinor, currency: inst.currency, sandbox: s.payments.mode === 'sandbox' }, instalment: { ...inst, paymentId: ref!.id, paymentAttempts: attempt } };
}

/**
 * Called by the payment processor (webhook / sandbox confirm) inside its transaction when a
 * registration payment succeeds. Idempotent; never moves a registration backwards.
 */
export async function fulfilRegistrationPayment(tx: Tx, p: PaymentRow): Promise<{ fulfilled: boolean; note: string }> {
  const [inst] = await tx.select().from(sportsInstalments).where(eq(sportsInstalments.paymentId, p.id)).for('update');
  if (inst && inst.status === 'scheduled') {
    await tx.update(sportsInstalments).set({ status: 'paid', paidAt: new Date(), updatedAt: new Date() }).where(eq(sportsInstalments.id, inst.id));
  }
  const [head] = await tx.select({ programmeId: registrations.programmeId }).from(registrations).where(eq(registrations.id, p.targetId!));
  if (!head) return { fulfilled: false, note: 'Registration record missing' };
  // Lock order everywhere: programme, then registration.
  const prog = await lockProgramme(tx, head.programmeId);
  const [reg] = await tx.select().from(registrations).where(eq(registrations.id, p.targetId!)).for('update');
  if (!reg) return { fulfilled: false, note: 'Registration record missing' };
  if (reg.status === 'withdrawn' || reg.status === 'rejected') return { fulfilled: false, note: `Registration is ${reg.status} — refund this payment` };
  if (reg.status !== 'submitted') {
    return { fulfilled: true, note: inst ? `Instalment ${inst.seq} paid` : `Registration already ${reg.status}` };
  }
  const now = new Date();
  if (prog.capacity !== null && (!reg.holdExpiresAt || reg.holdExpiresAt <= now)) {
    const held = await placesHeld(tx, prog.id, now, reg.id);
    if (held >= prog.capacity) {
      await tx.update(registrations).set({ status: 'waitlisted', holdExpiresAt: null, paymentId: p.id, reviewNote: 'Paid after the place hold expired and the programme is full — offer the next place or refund', updatedAt: now }).where(eq(registrations.id, reg.id));
      return { fulfilled: true, note: 'Paid after the hold expired; programme full — waitlisted' };
    }
  }
  const status = prog.requiresApproval ? 'awaiting_review' : 'accepted';
  await tx.update(registrations).set({ status, holdExpiresAt: null, paymentId: p.id, updatedAt: now }).where(eq(registrations.id, reg.id));
  return { fulfilled: true, note: prog.requiresApproval ? 'Registration paid — awaiting review' : 'Registration accepted' };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export interface RegisterInput {
  programmeId: string;
  guardian: ContactInput;
  participant: { name: string; dateOfBirth: string };
  relationship: string;
  answers: Record<string, unknown>;
  feePlanId?: string;
  acceptRefundPolicy: boolean;
  absenceAlerts?: boolean;
  /** Signed-in guardian (app). Links the guardian record to the account. */
  userId?: string | null;
  source: 'web' | 'app' | 'staff';
}

export async function registerParticipant(s: Services, input: RegisterInput) {
  const [p] = await s.db.select().from(programmes).where(and(eq(programmes.id, input.programmeId), eq(programmes.status, 'published')));
  if (!p) throw notFound('Programme');
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, p.locationId));
  if (!loc) throw notFound('Location');
  const now = new Date();
  const today = todayIn(loc.timeZone, now);
  if ((p.registrationOpensAt && p.registrationOpensAt > now) || (p.registrationClosesAt && p.registrationClosesAt < now)) throw conflict('registration_closed', 'Registration is not open for this programme');
  const { rule, cutoffDate } = await programmeAgeRule(s.db, p, today);
  const elig = checkAgeEligibility({ dateOfBirth: input.participant.dateOfBirth, rule, cutoffDate, ageMin: p.ageMin, ageMax: p.ageMax });
  if (!elig.eligible) {
    const how = rule === 'birth_year' ? `born in ${cutoffDate.slice(0, 4)} minus ${p.ageMin ?? 0}–${p.ageMax ?? '∞'} years` : `aged ${p.ageMin ?? 0}–${p.ageMax ?? '∞'} on ${cutoffDate}`;
    throw validationError(`This programme is for participants ${how}`, { 'participant.dateOfBirth': `Participant would be ${elig.age} (${elig.ageGroup})` });
  }
  if (p.refundPolicy && !input.acceptRefundPolicy) throw validationError('Please read and accept the refund and withdrawal policy', { acceptRefundPolicy: 'Required' });
  const { questions, form } = await formQuestions(s.db, p);
  const ans = splitAnswers(questions, input.answers);
  const plans = await feePlansFor(s.db, p.id);
  const plan = input.feePlanId ? plans.find((x) => x.id === input.feePlanId) ?? null : null;
  if (input.feePlanId && !plan) throw validationError('Choose one of the payment options offered', { feePlanId: 'Not offered for this programme' });
  if (p.feeMinor > 0) await assertPaymentsEnabled(s.db, p.organizationId, p.locationId);
  const manageToken = randomToken(24);

  const res = await s.db.transaction(async (tx) => {
    const prog = await lockProgramme(tx, p.id);
    const guardian = await findOrCreateCustomer(tx, p.organizationId, p.locationId, input.guardian, input.source === 'app' ? 'app' : 'registration');
    if (input.userId && !guardian.userId) await tx.update(customers).set({ userId: input.userId, updatedAt: now }).where(eq(customers.id, guardian.id));
    // Reuse the participant record this guardian already represents (same name + date of birth) — avoids duplicates.
    const known = await tx.select({ c: customers }).from(guardianRelationships).innerJoin(customers, eq(customers.id, guardianRelationships.participantCustomerId))
      .where(and(eq(guardianRelationships.guardianCustomerId, guardian.id), inArray(guardianRelationships.status, ['verified', 'pending_verification']), eq(customers.dateOfBirth, input.participant.dateOfBirth), sql`lower(${customers.name}) = ${input.participant.name.trim().toLowerCase()}`, isNull(customers.erasedAt)));
    const participant = known[0]?.c ?? (await tx.insert(customers).values({ organizationId: p.organizationId, locationId: p.locationId, name: input.participant.name.trim(), dateOfBirth: input.participant.dateOfBirth }).returning())[0]!;
    await tx.insert(guardianRelationships).values({ organizationId: p.organizationId, guardianCustomerId: guardian.id, participantCustomerId: participant.id, relationship: input.relationship }).onConflictDoNothing();
    const [dupe] = await tx.select({ id: registrations.id }).from(registrations).where(and(eq(registrations.programmeId, p.id), eq(registrations.participantCustomerId, participant.id), inArray(registrations.status, [...ACTIVE_REG_STATES])));
    if (dupe) throw conflict('already_registered', `${participant.name} is already registered for this programme`);

    const held = await placesHeld(tx, prog.id, now);
    const full = prog.capacity !== null && held >= prog.capacity;
    // Sibling discount: this guardian's other active registrations in the same season (or programme).
    const family = await tx.select({ id: registrations.id }).from(registrations).innerJoin(programmes, eq(programmes.id, registrations.programmeId))
      .where(and(eq(registrations.guardianCustomerId, guardian.id), inArray(registrations.status, [...ACTIVE_REG_STATES]), prog.seasonId ? eq(programmes.seasonId, prog.seasonId) : eq(programmes.id, prog.id), ne(registrations.participantCustomerId, participant.id)));
    const discount = siblingDiscount(prog.feeMinor, prog.siblingDiscountBps, family.length + 1);
    const total = prog.feeMinor - discount;
    const status = full ? 'waitlisted' : total > 0 ? 'submitted' : prog.requiresApproval ? 'awaiting_review' : 'accepted';
    const [r] = await tx.insert(registrations).values({
      organizationId: p.organizationId, locationId: p.locationId, programmeId: p.id, participantCustomerId: participant.id, guardianCustomerId: guardian.id, status,
      forms: { ...ans.general, _formVersion: form?.version ?? 0 }, paymentPlan: plan?.kind === 'instalments' ? 'instalments' : 'full', feePlanId: plan?.id ?? null,
      listFeeMinor: prog.feeMinor, totalFeeMinor: total, currency: loc.currency, holdExpiresAt: status === 'submitted' ? new Date(now.getTime() + prog.holdMinutes * 60_000) : null,
      refundPolicyAcceptedAt: prog.refundPolicy ? now : null, refundPolicyVersion: prog.refundPolicyVersion ?? (prog.refundPolicy ? sha256(prog.refundPolicy).slice(0, 12) : null), manageTokenHash: sha256(manageToken),
    }).returning();
    if (discount > 0) await tx.insert(sportsFeeAdjustments).values({ organizationId: p.organizationId, registrationId: r!.id, kind: 'sibling_discount', amountMinor: discount, currency: loc.currency, reason: `Sibling discount (${prog.siblingDiscountBps / 100}%)` });
    if (Object.keys(ans.restricted).length) {
      await tx.insert(sportsRestrictedAnswers).values({ organizationId: p.organizationId, locationId: p.locationId, registrationId: r!.id, participantCustomerId: participant.id, formId: form?.id ?? null, formVersion: form?.version ?? 0, answers: ans.restricted, coachVisibleKeys: ans.coachVisibleKeys });
    }
    if (total > 0 && status !== 'waitlisted') {
      const lines = scheduleFor(total, plan, today);
      await tx.insert(sportsInstalments).values(lines.map((l) => ({ organizationId: p.organizationId, locationId: p.locationId, registrationId: r!.id, seq: l.seq, dueOn: l.dueOn, amountMinor: l.amountMinor, currency: loc.currency })));
    }
    if (input.absenceAlerts !== undefined) {
      await tx.insert(consentRecords).values({ organizationId: p.organizationId, customerId: guardian.id, email: guardian.email, purpose: 'sports_absence_alerts', version: '2026-10', granted: input.absenceAlerts, source: 'registration' });
    }
    await audit(tx, { organizationId: p.organizationId, actorUserId: input.userId ?? null, actorType: input.userId ? 'user' : 'system', action: 'registration.submitted', scopeKind: 'location', scopeId: p.locationId, targetType: 'registration', targetId: r!.id, metadata: { status, plan: plan?.kind ?? 'full', discount, source: input.source } });
    return { reg: r!, participant, guardian };
  });

  let payment = null;
  if (res.reg.status === 'submitted') {
    const [first] = await s.db.select().from(sportsInstalments).where(and(eq(sportsInstalments.registrationId, res.reg.id), eq(sportsInstalments.seq, 1)));
    payment = (await payInstalment(s, first!.id)).payment;
  }
  const instalments = await s.db.select().from(sportsInstalments).where(eq(sportsInstalments.registrationId, res.reg.id)).orderBy(asc(sportsInstalments.seq));
  const nextStep = res.reg.status === 'waitlisted' ? 'The programme is full; you are on the waitlist. You will not be charged unless a place is offered.'
    : p.requiresApproval ? 'Your registration will be reviewed. Payment does not confirm a place until it is accepted.'
      : res.reg.status === 'accepted' ? 'Registration accepted.' : 'Complete payment to confirm the registration.';
  return { registration: res.reg, participant: res.participant, guardian: res.guardian, payment, instalments: instalments.map((i) => serializeInstalment(i, today)), nextStep, refundPolicy: p.refundPolicy, manageToken, ageGroup: elig.ageGroup, today };
}

/** Retry or resume payment for a registration (guardian with the manage token). Capacity is re-checked under lock. */
export async function retryRegistrationPayment(s: Services, registrationId: string, instalmentId: string | null) {
  const now = new Date();
  const outcome = await s.db.transaction(async (tx) => {
    const [head] = await tx.select({ programmeId: registrations.programmeId }).from(registrations).where(eq(registrations.id, registrationId));
    if (!head) throw notFound('Registration');
    const prog = await lockProgramme(tx, head.programmeId);
    const [reg] = await tx.select().from(registrations).where(eq(registrations.id, registrationId)).for('update');
    if (!reg) throw notFound('Registration');
    if (reg.status === 'withdrawn' || reg.status === 'rejected') throw conflict('registration_closed', `Registration is ${reg.status}`);
    if (reg.status === 'waitlisted') throw conflict('waitlisted', 'This registration is on the waitlist — nothing to pay until a place is offered');
    if (reg.status === 'submitted' && (!reg.holdExpiresAt || reg.holdExpiresAt <= now)) {
      const held = await placesHeld(tx, prog.id, now, reg.id);
      if (prog.capacity !== null && held >= prog.capacity) {
        await tx.update(registrations).set({ status: 'waitlisted', holdExpiresAt: null, updatedAt: now }).where(eq(registrations.id, reg.id));
        await tx.update(sportsInstalments).set({ status: 'cancelled', updatedAt: now }).where(and(eq(sportsInstalments.registrationId, reg.id), eq(sportsInstalments.status, 'scheduled')));
        return { waitlisted: true as const };
      }
      await tx.update(registrations).set({ holdExpiresAt: new Date(now.getTime() + prog.holdMinutes * 60_000), updatedAt: now }).where(eq(registrations.id, reg.id));
    }
    return { waitlisted: false as const };
  });
  if (outcome.waitlisted) return { status: 'waitlisted' as const, payment: null };
  const inst = await s.db.select().from(sportsInstalments).where(and(eq(sportsInstalments.registrationId, registrationId), eq(sportsInstalments.status, 'scheduled'))).orderBy(asc(sportsInstalments.seq));
  const target = instalmentId ? inst.find((i) => i.id === instalmentId) : inst[0];
  if (!target) throw conflict('nothing_to_pay', 'There is nothing left to pay on this registration');
  const r = await payInstalment(s, target.id, { fresh: true });
  const [reg] = await s.db.select().from(registrations).where(eq(registrations.id, registrationId));
  return { status: reg!.status, payment: r.payment };
}

/* ------------------------------------------------------------------ */
/* Review, withdrawal, adjustments                                     */
/* ------------------------------------------------------------------ */

export async function reviewRegistration(s: Services, req: FastifyRequest, orgId: string, id: string, body: { decision: 'accept' | 'waitlist' | 'reject'; teamId?: string; note?: string }) {
  const [r0] = await s.db.select().from(registrations).where(and(eq(registrations.id, id), eq(registrations.organizationId, orgId)));
  if (!r0) throw notFound('Registration');
  await requireDirector(req, s.db, orgId, r0.locationId);
  const now = new Date();
  const updated = await s.db.transaction(async (tx) => {
    const prog = await lockProgramme(tx, r0.programmeId);
    const [r] = await tx.select().from(registrations).where(eq(registrations.id, id)).for('update');
    if (!r) throw notFound('Registration');
    if (!['awaiting_review', 'waitlisted', 'submitted'].includes(r.status)) throw conflict('not_reviewable', `Registration is ${r.status}`);
    if (r.status === 'submitted' && body.decision === 'accept') throw conflict('payment_pending', 'Payment for this registration has not completed');
    let teamId: string | null = null;
    if (body.decision === 'accept') {
      if (prog.capacity !== null && r.status !== 'awaiting_review') {
        const held = await placesHeld(tx, prog.id, now, r.id);
        if (held >= prog.capacity) throw conflict('programme_full', 'The programme is at capacity. Withdraw or move someone first.');
      }
      if (body.teamId) {
        const [t] = await tx.select().from(teams).where(and(eq(teams.id, body.teamId), eq(teams.programmeId, r.programmeId))).for('update');
        if (!t) throw validationError('Team is not part of this programme', { teamId: 'Invalid team' });
        if (t.kind === 'squad') throw validationError('Squads are filled by selection, not registration', { teamId: 'Squad' });
        if (t.capacity !== null && (await teamRosterCount(tx, t.id)) >= t.capacity) throw conflict('team_full', `${t.name} is full`);
        teamId = t.id;
      }
    }
    const status = body.decision === 'accept' ? 'accepted' : body.decision === 'waitlist' ? 'waitlisted' : 'rejected';
    const [u] = await tx.update(registrations).set({ status, teamId: status === 'accepted' ? teamId ?? r.teamId : null, reviewedBy: req.user!.id, reviewNote: body.note ?? null, holdExpiresAt: null, updatedAt: now }).where(eq(registrations.id, r.id)).returning();
    // Accepted from the waitlist with a fee and nothing scheduled yet: create the balance (pay in full, due today).
    if (status === 'accepted' && r.totalFeeMinor > 0) {
      const existing = await tx.select({ id: sportsInstalments.id }).from(sportsInstalments).where(and(eq(sportsInstalments.registrationId, r.id), ne(sportsInstalments.status, 'cancelled')));
      if (!existing.length) {
        const [loc] = await tx.select().from(locations).where(eq(locations.id, r.locationId));
        const [plan] = r.feePlanId ? await tx.select().from(sportsFeePlans).where(eq(sportsFeePlans.id, r.feePlanId)) : [];
        const today = todayIn(loc!.timeZone, now);
        const [{ maxSeq } = { maxSeq: 0 }] = await tx.select({ maxSeq: sql<number>`coalesce(max(${sportsInstalments.seq}), 0)::int` }).from(sportsInstalments).where(eq(sportsInstalments.registrationId, r.id));
        const lines = scheduleFor(r.totalFeeMinor, plan ?? null, today);
        await tx.insert(sportsInstalments).values(lines.map((l) => ({ organizationId: r.organizationId, locationId: r.locationId, registrationId: r.id, seq: maxSeq + l.seq, dueOn: l.dueOn, amountMinor: l.amountMinor, currency: r.currency ?? loc!.currency })));
      }
    }
    if (status === 'rejected') await tx.update(sportsInstalments).set({ status: 'cancelled', updatedAt: now }).where(and(eq(sportsInstalments.registrationId, r.id), eq(sportsInstalments.status, 'scheduled')));
    await audit(tx, { organizationId: r.organizationId, actorUserId: req.user!.id, action: `registration.${status}`, scopeKind: 'location', scopeId: r.locationId, targetType: 'registration', targetId: r.id, metadata: { teamId } });
    return u!;
  });
  const [prog] = await s.db.select().from(programmes).where(eq(programmes.id, updated.programmeId));
  if (updated.guardianCustomerId) {
    const [child] = await s.db.select({ name: customers.name }).from(customers).where(eq(customers.id, updated.participantCustomerId));
    const verb = updated.status === 'accepted' ? 'has been accepted' : updated.status === 'waitlisted' ? 'is on the waitlist' : 'was not accepted this time';
    await notifyGuardians(s, { organizationId: orgId, locationId: updated.locationId, kind: 'registration_status', subject: `${prog?.name ?? 'Programme'}: registration update`, body: `${child?.name ?? 'Your participant'} ${verb} for ${prog?.name ?? 'the programme'}.${body.note ? ` Note from the club: ${body.note}` : ''}`, refType: 'registration', refId: updated.id, recipients: [{ guardianId: updated.guardianCustomerId, participantId: updated.participantCustomerId }] });
  }
  return updated;
}

export async function withdrawRegistration(s: Services, reg: Registration, actor: { userId: string | null; guardianId: string | null }, reason: string) {
  if (!['submitted', 'awaiting_review', 'accepted', 'waitlisted'].includes(reg.status)) throw conflict('not_withdrawable', `Registration is ${reg.status}`);
  const now = new Date();
  await s.db.transaction(async (tx) => {
    await tx.update(registrations).set({ status: 'withdrawn', teamId: null, withdrawnAt: now, withdrawalReason: reason, holdExpiresAt: null, updatedAt: now }).where(eq(registrations.id, reg.id));
    await tx.update(sportsInstalments).set({ status: 'cancelled', updatedAt: now }).where(and(eq(sportsInstalments.registrationId, reg.id), eq(sportsInstalments.status, 'scheduled')));
    await audit(tx, { organizationId: reg.organizationId, actorUserId: actor.userId, actorType: actor.userId ? 'user' : 'system', action: 'registration.withdrawn', scopeKind: 'location', scopeId: reg.locationId, targetType: 'registration', targetId: reg.id, metadata: { reason, byGuardian: actor.guardianId } });
  });
  const paid = await s.db.select().from(sportsInstalments).where(and(eq(sportsInstalments.registrationId, reg.id), eq(sportsInstalments.status, 'paid')));
  const [prog] = await s.db.select().from(programmes).where(eq(programmes.id, reg.programmeId));
  return { withdrawn: true, paid: { amount: paid.reduce((a, i) => a + i.amountMinor, 0), currency: reg.currency }, refundPolicy: prog?.refundPolicy ?? null, note: 'Unpaid instalments were cancelled. Any refund follows the policy shown at checkout and is processed by the club.' };
}

/** Financial aid / waiver: reduces unpaid instalments, latest first. Paid amounts are refunded through Payments instead. */
export async function adjustFees(s: Services, req: FastifyRequest, orgId: string, registrationId: string, body: { kind: 'financial_aid' | 'waiver'; amountMinor?: number; waiveAll?: boolean; reason: string }) {
  const [reg] = await s.db.select().from(registrations).where(and(eq(registrations.id, registrationId), eq(registrations.organizationId, orgId)));
  if (!reg) throw notFound('Registration');
  await requireLocationPerm(req, s.db, orgId, reg.locationId, 'operations.read');
  const canAdjust = (await hasPerm(req, s.db, 'customers.write', { organizationId: orgId, kind: 'location', id: reg.locationId })) || (await hasPerm(req, s.db, 'payments.refund', { organizationId: orgId, kind: 'location', id: reg.locationId }));
  if (!canAdjust) throw forbidden('Only administrators or finance can grant financial aid or waivers');
  return s.db.transaction(async (tx) => {
    const unpaid = await tx.select().from(sportsInstalments).where(and(eq(sportsInstalments.registrationId, reg.id), eq(sportsInstalments.status, 'scheduled'))).orderBy(sql`${sportsInstalments.seq} desc`).for('update');
    const outstanding = unpaid.reduce((a, i) => a + i.amountMinor, 0);
    const amount = body.waiveAll ? outstanding : body.amountMinor ?? 0;
    if (!Number.isInteger(amount) || amount <= 0) throw validationError('Enter an amount greater than zero', { amountMinor: 'Must be > 0' });
    if (amount > outstanding) throw validationError(`Only ${outstanding} ${reg.currency} (minor units) is still owed`, { amountMinor: 'More than the outstanding balance' });
    let left = amount;
    for (const i of unpaid) {
      if (left <= 0) break;
      const take = Math.min(left, i.amountMinor);
      left -= take;
      const rest = i.amountMinor - take;
      // An in-flight payment for the old amount is detached; the guardian pays the new amount next time.
      await tx.update(sportsInstalments).set({ amountMinor: rest, status: rest === 0 ? 'waived' : 'scheduled', paymentId: null, updatedAt: new Date() }).where(eq(sportsInstalments.id, i.id));
    }
    await tx.update(registrations).set({ totalFeeMinor: reg.totalFeeMinor - amount, updatedAt: new Date() }).where(eq(registrations.id, reg.id));
    const [adj] = await tx.insert(sportsFeeAdjustments).values({ organizationId: orgId, registrationId: reg.id, kind: body.kind, amountMinor: amount, currency: reg.currency ?? 'USD', reason: body.reason, createdBy: req.user!.id }).returning();
    await audit(tx, { organizationId: orgId, actorUserId: req.user!.id, action: `registration.${body.kind}`, scopeKind: 'location', scopeId: reg.locationId, targetType: 'registration', targetId: reg.id, metadata: { amountMinor: amount, currency: reg.currency, reason: body.reason } });
    return adj!;
  });
}

/* ------------------------------------------------------------------ */
/* Reminders                                                           */
/* ------------------------------------------------------------------ */

const STAGE_ORDER = ['upcoming', 'due', 'overdue'] as const;

/**
 * Sends at most one reminder per stage per instalment: `upcoming` (≤3 days before), `due` (on or after
 * the due date) and `overdue` (more than 7 days late). Only for registrations holding a place.
 */
export async function runInstalmentReminders(s: Services, now = new Date(), organizationId?: string) {
  const rows = await s.db.select({ i: sportsInstalments, r: registrations, l: { timeZone: locations.timeZone, name: locations.name }, p: { name: programmes.name } })
    .from(sportsInstalments).innerJoin(registrations, eq(registrations.id, sportsInstalments.registrationId)).innerJoin(locations, eq(locations.id, sportsInstalments.locationId)).innerJoin(programmes, eq(programmes.id, registrations.programmeId))
    .where(and(eq(sportsInstalments.status, 'scheduled'), inArray(registrations.status, ['accepted', 'awaiting_review']), organizationId ? eq(sportsInstalments.organizationId, organizationId) : undefined));
  let sent = 0;
  for (const { i, r, l, p } of rows) {
    const today = todayIn(l.timeZone, now);
    const days = Math.round((Date.parse(`${i.dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000);
    const stage = days > 3 ? null : days > 0 ? 'upcoming' : days >= -7 ? 'due' : 'overdue';
    if (!stage) continue;
    if (i.lastReminderStage && STAGE_ORDER.indexOf(i.lastReminderStage as (typeof STAGE_ORDER)[number]) >= STAGE_ORDER.indexOf(stage)) continue;
    const amount = `${(i.amountMinor / 100).toFixed(2)} ${i.currency}`;
    const subject = stage === 'overdue' ? `Overdue: ${p.name} instalment ${i.seq}` : stage === 'due' ? `Due today: ${p.name} instalment ${i.seq}` : `Coming up: ${p.name} instalment ${i.seq}`;
    const body = `Instalment ${i.seq} of ${amount} for ${p.name} at ${l.name} ${stage === 'upcoming' ? `is due on ${i.dueOn}` : stage === 'due' ? `was due on ${i.dueOn}` : `has been unpaid since ${i.dueOn}`}. You can pay it from the guardian portal.`;
    if (r.guardianCustomerId) {
      await notifyGuardians(s, { organizationId: i.organizationId, locationId: i.locationId, kind: 'instalment_reminder', subject, body, refType: 'instalment', refId: i.id, recipients: [{ guardianId: r.guardianCustomerId, participantId: r.participantCustomerId }] });
    }
    await s.db.update(sportsInstalments).set({ lastReminderStage: stage, lastReminderAt: now, remindersSent: i.remindersSent + 1, updatedAt: now }).where(eq(sportsInstalments.id, i.id));
    sent++;
  }
  return { checked: rows.length, sent };
}

/** Guardians who can act for a registration's participant (used by portal checks and notifications). */
export async function registrationGuardians(db: Exec, reg: Registration) {
  return guardiansOf(db, reg.organizationId, [reg.participantCustomerId]);
}

export { AppError };

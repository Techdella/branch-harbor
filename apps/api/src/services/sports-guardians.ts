/**
 * Guardian relationships and the guardian portal.
 *
 *  - A guardian sees ONLY participants with a `verified` relationship to them. Pending, disputed and
 *    revoked relationships grant nothing.
 *  - The guardian who registered a participant verifies their relationship by proving their email
 *    (portal sign-in link, or a signed-in account with a verified email).
 *  - A second guardian is invited by a verified guardian (or staff); accepting the emailed token verifies it.
 *  - A dispute suspends the disputed relationship until staff resolve it (upheld → revoked, dismissed → restored).
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import {
  attendance, customers, guardianRelationships, locations, organizations, paymentReferences, programmes, registrations, sportsGuardianInvitations, sportsInstalments,
  sportsMessages, sportsNotifications, sportsPortalTokens, sportsRelationshipDisputes, sportsRestrictedAnswers, sportsSquadMembers, teams, trainingSessions, users,
} from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, unauthorized, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { balanceOf, formQuestions, formsComplete, serializeInstalment, todayIn } from './sports-core.ts';
import { notifyGuardians } from './sports-notify.ts';

type Customer = typeof customers.$inferSelect;

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/** Guardian records for a signed-in account: linked by user id, or by the account's verified email. */
export async function guardianIdsForUser(db: Exec, userId: string): Promise<Customer[]> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) return [];
  const byEmail = u.emailVerifiedAt ? sql`lower(${customers.email}) = ${u.email.toLowerCase()}` : sql`false`;
  return db.select().from(customers).where(and(or(eq(customers.userId, userId), byEmail), isNull(customers.erasedAt)));
}

/** Email proven → relationships this guardian created by registering the participant become verified. */
export async function verifyRegistrantRelationships(db: Exec, guardianIds: string[]) {
  if (!guardianIds.length) return 0;
  const rows = await db.select({ id: guardianRelationships.id }).from(guardianRelationships)
    .where(and(inArray(guardianRelationships.guardianCustomerId, guardianIds), eq(guardianRelationships.status, 'pending_verification'),
      sql`exists (select 1 from ${registrations} r where r.guardian_customer_id = ${guardianRelationships.guardianCustomerId} and r.participant_customer_id = ${guardianRelationships.participantCustomerId})`));
  if (rows.length) await db.update(guardianRelationships).set({ status: 'verified', verifiedAt: new Date() }).where(inArray(guardianRelationships.id, rows.map((r) => r.id)));
  return rows.length;
}

/** Verified relationships for these guardians: participantId → relationship rows. */
export async function authorisedParticipants(db: Exec, guardianIds: string[]) {
  if (!guardianIds.length) return [];
  return db.select({ rel: guardianRelationships, participant: customers }).from(guardianRelationships).innerJoin(customers, eq(customers.id, guardianRelationships.participantCustomerId))
    .where(and(inArray(guardianRelationships.guardianCustomerId, guardianIds), eq(guardianRelationships.status, 'verified'), isNull(customers.erasedAt)));
}

/** Throws 404 (no enumeration) unless one of these guardians holds a verified relationship to the participant. */
export async function assertGuardianOf(db: Exec, guardianIds: string[], participantId: string) {
  const rows = await authorisedParticipants(db, guardianIds);
  const hit = rows.find((r) => r.participant.id === participantId);
  if (!hit) throw notFound('Participant');
  return hit;
}

/* ------------------------------------------------------------------ */
/* Portal sign-in (customer websites)                                  */
/* ------------------------------------------------------------------ */

const LINK_MINUTES = 30;
const SESSION_HOURS = 12;

export async function requestPortalLink(s: Services, locationId: string, email: string) {
  const [loc] = await s.db.select({ l: locations, o: organizations }).from(locations).innerJoin(organizations, eq(organizations.id, locations.organizationId)).where(and(eq(locations.id, locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
  if (!loc) throw notFound('Location');
  const [g] = await s.db.select().from(customers).where(and(eq(customers.organizationId, loc.o.id), sql`lower(${customers.email}) = ${email.trim().toLowerCase()}`, isNull(customers.erasedAt)));
  // Same response whether or not the email is known (no account enumeration).
  if (!g) return { sent: true as const, devLinkToken: undefined };
  const token = randomToken(24);
  await s.db.insert(sportsPortalTokens).values({ organizationId: loc.o.id, guardianCustomerId: g.id, kind: 'link', tokenHash: sha256(token), expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000) });
  const url = `${s.cfg.SITES_BASE_URL.replace(/\/$/, '')}/${loc.o.slug}/${loc.l.slug}/programmes/portal?token=${encodeURIComponent(token)}`;
  await s.mailer.send({ to: g.email!, subject: `${loc.o.name}: your guardian portal link`, text: `Use this link within ${LINK_MINUTES} minutes to open the guardian portal:\n${url}\n\nIf you did not ask for it, ignore this email.`, tag: 'sports_portal_link' }).catch((err) => s.log.error({ err }, '[sports] portal link email failed'));
  const dev = s.cfg.NODE_ENV !== 'production' && s.cfg.EXPOSE_DEV_TOKENS && s.mailer.mode === 'log';
  return { sent: true as const, devLinkToken: dev ? token : undefined };
}

export async function openPortalSession(s: Services, linkToken: string) {
  const now = new Date();
  const [row] = await s.db.select().from(sportsPortalTokens).where(and(eq(sportsPortalTokens.tokenHash, sha256(linkToken)), eq(sportsPortalTokens.kind, 'link')));
  if (!row || row.usedAt || row.expiresAt < now) throw new AppError(401, 'link_invalid', 'This sign-in link has expired or was already used. Ask for a new one.');
  await s.db.update(sportsPortalTokens).set({ usedAt: now }).where(eq(sportsPortalTokens.id, row.id));
  return createPortalSession(s, row.organizationId, row.guardianCustomerId);
}

export async function createPortalSession(s: Services, organizationId: string, guardianId: string) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await s.db.insert(sportsPortalTokens).values({ organizationId, guardianCustomerId: guardianId, kind: 'session', tokenHash: sha256(token), expiresAt });
  const verified = await verifyRegistrantRelationships(s.db, [guardianId]);
  const [g] = await s.db.select().from(customers).where(eq(customers.id, guardianId));
  return { portalToken: token, expiresAt: expiresAt.toISOString(), guardian: { id: g!.id, name: g!.name, email: g!.email }, newlyVerified: verified };
}

/** Resolves a portal session token to its guardian. 401 when missing/expired. */
export async function portalGuardian(db: Exec, token: string | undefined) {
  if (!token) throw unauthorized('Sign in to the guardian portal');
  const [row] = await db.select().from(sportsPortalTokens).where(and(eq(sportsPortalTokens.tokenHash, sha256(token)), eq(sportsPortalTokens.kind, 'session'), gt(sportsPortalTokens.expiresAt, new Date())));
  if (!row) throw new AppError(401, 'portal_session_expired', 'Your portal session has ended. Ask for a new sign-in link.');
  const [g] = await db.select().from(customers).where(eq(customers.id, row.guardianCustomerId));
  if (!g || g.erasedAt) throw unauthorized('Sign in to the guardian portal');
  return { guardian: g, organizationId: row.organizationId };
}

/* ------------------------------------------------------------------ */
/* Overview (portal + app)                                             */
/* ------------------------------------------------------------------ */

export async function guardianOverview(s: Services, guardians: Customer[], now = new Date()) {
  const guardianIds = guardians.map((g) => g.id);
  const rels = await authorisedParticipants(s.db, guardianIds);
  const participantIds = [...new Set(rels.map((r) => r.participant.id))];
  const pendingCount = guardianIds.length ? (await s.db.select({ id: guardianRelationships.id }).from(guardianRelationships).where(and(inArray(guardianRelationships.guardianCustomerId, guardianIds), inArray(guardianRelationships.status, ['pending_verification', 'disputed'])))).length : 0;
  if (!participantIds.length) {
    return { guardians: guardians.map((g) => ({ id: g.id, name: g.name, organizationId: g.organizationId })), participants: [], schedule: [], balances: [], notifications: await recentNotifications(s, guardianIds), pendingRelationships: pendingCount, locations: [] };
  }
  const regs = await s.db.select({ r: registrations, p: programmes, l: locations, t: { id: teams.id, name: teams.name } })
    .from(registrations).innerJoin(programmes, eq(programmes.id, registrations.programmeId)).innerJoin(locations, eq(locations.id, registrations.locationId)).leftJoin(teams, eq(teams.id, registrations.teamId))
    .where(and(inArray(registrations.participantCustomerId, participantIds), ne(registrations.status, 'rejected'))).orderBy(desc(registrations.createdAt));
  const regIds = regs.map((x) => x.r.id);
  const inst = regIds.length ? await s.db.select().from(sportsInstalments).where(inArray(sportsInstalments.registrationId, regIds)).orderBy(asc(sportsInstalments.seq)) : [];
  const payIds = inst.map((i) => i.paymentId).filter((x): x is string => !!x);
  const pays = payIds.length ? await s.db.select({ id: paymentReferences.id, state: paymentReferences.state }).from(paymentReferences).where(inArray(paymentReferences.id, payIds)) : [];
  const restricted = regIds.length ? await s.db.select({ registrationId: sportsRestrictedAnswers.registrationId, answers: sportsRestrictedAnswers.answers }).from(sportsRestrictedAnswers).where(inArray(sportsRestrictedAnswers.registrationId, regIds)) : [];
  // Other guardians (names + relationship only) so a guardian can see who else has access and dispute it.
  const others = await s.db.select({ rel: guardianRelationships, name: customers.name }).from(guardianRelationships).innerJoin(customers, eq(customers.id, guardianRelationships.guardianCustomerId))
    .where(and(inArray(guardianRelationships.participantCustomerId, participantIds), guardianIds.length ? sql`${guardianRelationships.guardianCustomerId} not in (${sql.join(guardianIds.map((g) => sql`${g}`), sql`, `)})` : sql`true`, ne(guardianRelationships.status, 'revoked')));

  // Schedule: sessions of the teams/squads these participants are on, next 28 days (and last 2 days for context).
  const teamOf = new Map<string, Set<string>>(); // teamId → participantIds
  for (const x of regs) if (x.r.status === 'accepted' && x.r.teamId) teamOf.set(x.r.teamId, new Set([...(teamOf.get(x.r.teamId) ?? []), x.r.participantCustomerId]));
  const squads = await s.db.select().from(sportsSquadMembers).where(inArray(sportsSquadMembers.participantCustomerId, participantIds));
  for (const sq of squads) teamOf.set(sq.teamId, new Set([...(teamOf.get(sq.teamId) ?? []), sq.participantCustomerId]));
  const teamIds = [...teamOf.keys()];
  const sessions = teamIds.length ? await s.db.select({ s: trainingSessions, t: { id: teams.id, name: teams.name }, l: { id: locations.id, name: locations.name, timeZone: locations.timeZone } })
    .from(trainingSessions).innerJoin(teams, eq(teams.id, trainingSessions.teamId)).innerJoin(locations, eq(locations.id, trainingSessions.locationId))
    .where(and(inArray(trainingSessions.teamId, teamIds), gte(trainingSessions.startsAt, new Date(now.getTime() - 2 * 86400_000)), lt(trainingSessions.startsAt, new Date(now.getTime() + 28 * 86400_000)))).orderBy(asc(trainingSessions.startsAt)) : [];
  const marks = sessions.length ? await s.db.select().from(attendance).where(and(inArray(attendance.sessionId, sessions.map((x) => x.s.id)), inArray(attendance.participantCustomerId, participantIds))) : [];

  const participants = participantIds.map((pid) => {
    const rel = rels.filter((r) => r.participant.id === pid);
    const p = rel[0]!.participant;
    return {
      id: p.id, name: p.name, dateOfBirth: p.dateOfBirth, relationships: rel.map((r) => ({ id: r.rel.id, relationship: r.rel.relationship, organizationId: r.rel.organizationId })),
      otherGuardians: others.filter((o) => o.rel.participantCustomerId === pid).map((o) => ({ relationshipId: o.rel.id, name: o.name, relationship: o.rel.relationship, status: o.rel.status })),
      registrations: regs.filter((x) => x.r.participantCustomerId === pid).map((x) => {
        const ii = inst.filter((i) => i.registrationId === x.r.id);
        const today = todayIn(x.l.timeZone, now);
        const rk = restricted.find((r) => r.registrationId === x.r.id);
        return {
          id: x.r.id, status: x.r.status, programme: { id: x.p.id, name: x.p.name, refundPolicy: x.p.refundPolicy, requiresApproval: x.p.requiresApproval },
          location: { id: x.l.id, name: x.l.name, timeZone: x.l.timeZone, currency: x.l.currency }, team: x.t?.id ? x.t : null, paymentPlan: x.r.paymentPlan,
          balance: balanceOf(ii, today), instalments: ii.map((i) => serializeInstalment(i, today, pays.find((p) => p.id === i.paymentId)?.state)),
          forms: { complete: formsCompleteQuick(x.r.forms, rk?.answers), onFile: Object.keys(x.r.forms).filter((k) => !k.startsWith('_')).length + Object.keys(rk?.answers ?? {}).length },
          createdAt: x.r.createdAt.toISOString(),
        };
      }),
    };
  });
  const schedule = sessions.map(({ s: x, t, l }) => ({
    id: x.id, kind: x.kind, status: x.status, startsAt: x.startsAt.toISOString(), endsAt: x.endsAt.toISOString(), venue: x.venue, opponent: x.opponent, homeAway: x.homeAway, competition: x.competition,
    cancelReason: x.cancelReason, team: t, location: l, participants: [...(teamOf.get(t.id) ?? [])].map((pid) => {
      const m = marks.find((k) => k.sessionId === x.id && k.participantCustomerId === pid);
      return { id: pid, name: participants.find((p) => p.id === pid)?.name ?? '', attendance: m ? { status: m.status, reason: m.absenceReason, reportedBy: m.reportedBy } : null };
    }),
  }));
  const byCur = new Map<string, { outstanding: number; overdue: number; paid: number }>();
  for (const p of participants) for (const r of p.registrations) if (r.balance.currency) {
    const c = byCur.get(r.balance.currency) ?? { outstanding: 0, overdue: 0, paid: 0 };
    c.outstanding += r.balance.outstanding; c.overdue += r.balance.overdue; c.paid += r.balance.paid;
    byCur.set(r.balance.currency, c);
  }
  const locs = [...new Map(regs.map((x) => [x.l.id, { id: x.l.id, name: x.l.name, timeZone: x.l.timeZone, organizationId: x.l.organizationId }])).values()];
  return {
    guardians: guardians.map((g) => ({ id: g.id, name: g.name, organizationId: g.organizationId })), participants, schedule,
    balances: [...byCur.entries()].map(([currency, v]) => ({ currency, ...v })), notifications: await recentNotifications(s, guardianIds), pendingRelationships: pendingCount, locations: locs,
  };
}

function formsCompleteQuick(general: Record<string, unknown>, restricted: Record<string, unknown> | undefined) {
  // Built-in required keys only (custom questions are validated at submission).
  return ['emergency_contact_name', 'emergency_contact_phone'].every((k) => restricted?.[k] !== undefined) && general.photo_consent !== undefined;
}

async function recentNotifications(s: Services, guardianIds: string[]) {
  if (!guardianIds.length) return [];
  const rows = await s.db.select().from(sportsNotifications).where(inArray(sportsNotifications.guardianCustomerId, guardianIds)).orderBy(desc(sportsNotifications.createdAt)).limit(30);
  return rows.map((n) => ({ id: n.id, kind: n.kind, subject: n.subject, body: n.body, status: n.status, createdAt: n.createdAt.toISOString(), readAt: n.readAt?.toISOString() ?? null }));
}

/* ------------------------------------------------------------------ */
/* Guardian actions                                                    */
/* ------------------------------------------------------------------ */

/** Guardian reports an absence ahead of a session for a participant on that team. */
export async function reportAbsence(s: Services, guardianIds: string[], body: { participantId: string; sessionId: string; reason: string; note?: string }) {
  await assertGuardianOf(s.db, guardianIds, body.participantId);
  const [sess] = await s.db.select({ s: trainingSessions, t: teams }).from(trainingSessions).innerJoin(teams, eq(teams.id, trainingSessions.teamId)).where(eq(trainingSessions.id, body.sessionId));
  if (!sess) throw notFound('Session');
  const onTeam = sess.t.kind === 'squad'
    ? (await s.db.select({ id: sportsSquadMembers.id }).from(sportsSquadMembers).where(and(eq(sportsSquadMembers.teamId, sess.t.id), eq(sportsSquadMembers.participantCustomerId, body.participantId)))).length > 0
    : (await s.db.select({ id: registrations.id }).from(registrations).where(and(eq(registrations.teamId, sess.t.id), eq(registrations.participantCustomerId, body.participantId), eq(registrations.status, 'accepted')))).length > 0;
  if (!onTeam) throw notFound('Session');
  if (sess.s.status === 'cancelled') throw conflict('session_cancelled', 'This session is cancelled');
  if (sess.s.endsAt < new Date()) throw conflict('session_past', 'This session has already happened; contact the coach');
  const [existing] = await s.db.select().from(attendance).where(and(eq(attendance.sessionId, sess.s.id), eq(attendance.participantCustomerId, body.participantId)));
  if (existing && existing.reportedBy === 'coach') throw conflict('already_recorded', 'Attendance was already recorded by the coach');
  const v = { organizationId: sess.s.organizationId, locationId: sess.s.locationId, sessionId: sess.s.id, participantCustomerId: body.participantId, status: 'excused', absenceReason: body.reason, note: body.note ?? null, reportedBy: 'guardian', recordedBy: null, recordedAt: new Date() };
  const [row] = await s.db.insert(attendance).values(v).onConflictDoUpdate({ target: [attendance.sessionId, attendance.participantCustomerId], set: v }).returning();
  await audit(s.db, { organizationId: sess.s.organizationId, actorUserId: null, actorType: 'system', action: 'attendance.absence_reported', scopeKind: 'location', scopeId: sess.s.locationId, targetType: 'training_session', targetId: sess.s.id, metadata: { participantId: body.participantId, reason: body.reason } });
  return { id: row!.id, status: row!.status, reason: row!.absenceReason };
}

export async function guardianMessages(s: Services, guardianIds: string[], locationId: string | undefined) {
  if (!guardianIds.length) return [];
  const rows = await s.db.select({ m: sportsMessages, l: { name: locations.name } }).from(sportsMessages).innerJoin(locations, eq(locations.id, sportsMessages.locationId))
    .where(and(inArray(sportsMessages.guardianCustomerId, guardianIds), locationId ? eq(sportsMessages.locationId, locationId) : undefined)).orderBy(asc(sportsMessages.createdAt)).limit(300);
  return rows.map(({ m, l }) => ({ id: m.id, locationId: m.locationId, locationName: l.name, direction: m.direction, body: m.body, createdAt: m.createdAt.toISOString() }));
}

/** A guardian may message a location where one of their authorised participants is registered. */
export async function sendGuardianMessage(s: Services, guardians: Customer[], locationId: string, body: string) {
  const rels = await authorisedParticipants(s.db, guardians.map((g) => g.id));
  const pids = rels.map((r) => r.participant.id);
  const [reg] = pids.length ? await s.db.select({ id: registrations.id, org: registrations.organizationId }).from(registrations).where(and(inArray(registrations.participantCustomerId, pids), eq(registrations.locationId, locationId))).limit(1) : [];
  if (!reg) throw notFound('Location');
  const g = guardians.find((x) => x.organizationId === reg.org);
  if (!g) throw notFound('Location');
  const [m] = await s.db.insert(sportsMessages).values({ organizationId: reg.org, locationId, guardianCustomerId: g.id, direction: 'inbound', body }).returning();
  return { id: m!.id, locationId, direction: 'inbound', body: m!.body, createdAt: m!.createdAt.toISOString() };
}

export async function inviteGuardian(s: Services, args: { organizationId: string; participantId: string; invitedByCustomerId: string | null; invitedByUserId: string | null; email: string; name?: string; relationship: string }) {
  const email = args.email.trim().toLowerCase();
  const existing = await s.db.select({ id: guardianRelationships.id }).from(guardianRelationships).innerJoin(customers, eq(customers.id, guardianRelationships.guardianCustomerId))
    .where(and(eq(guardianRelationships.participantCustomerId, args.participantId), sql`lower(${customers.email}) = ${email}`, inArray(guardianRelationships.status, ['verified', 'pending_verification', 'disputed'])));
  if (existing.length) throw conflict('already_guardian', 'This person is already connected to the participant');
  const [org] = await s.db.select().from(organizations).where(eq(organizations.id, args.organizationId));
  const [child] = await s.db.select().from(customers).where(eq(customers.id, args.participantId));
  const [reg] = await s.db.select({ l: locations }).from(registrations).innerJoin(locations, eq(locations.id, registrations.locationId)).where(eq(registrations.participantCustomerId, args.participantId)).limit(1);
  await s.db.update(sportsGuardianInvitations).set({ status: 'revoked' }).where(and(eq(sportsGuardianInvitations.participantCustomerId, args.participantId), sql`lower(${sportsGuardianInvitations.email}) = ${email}`, eq(sportsGuardianInvitations.status, 'pending')));
  const token = randomToken(24);
  const [inv] = await s.db.insert(sportsGuardianInvitations).values({
    organizationId: args.organizationId, participantCustomerId: args.participantId, invitedByCustomerId: args.invitedByCustomerId, invitedByUserId: args.invitedByUserId,
    name: args.name ?? null, email, relationship: args.relationship, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 86400_000),
  }).returning();
  const url = reg ? `${s.cfg.SITES_BASE_URL.replace(/\/$/, '')}/${org!.slug}/${reg.l.slug}/programmes/portal?invite=${encodeURIComponent(token)}` : null;
  await s.mailer.send({ to: email, subject: `${org!.name}: you've been invited as a guardian`, text: `You've been invited to be a guardian contact for ${child!.name} at ${org!.name}.${url ? `\nAccept within 7 days: ${url}` : ''}\nIf you don't recognise this, ignore the email — nothing changes unless you accept.`, tag: 'sports_guardian_invitation' }).catch((err) => s.log.error({ err }, '[sports] invitation email failed'));
  await audit(s.db, { organizationId: args.organizationId, actorUserId: args.invitedByUserId, actorType: args.invitedByUserId ? 'user' : 'system', action: 'guardian.invited', targetType: 'customer', targetId: args.participantId, metadata: { invitationId: inv!.id, byGuardian: args.invitedByCustomerId } });
  const dev = s.cfg.NODE_ENV !== 'production' && s.cfg.EXPOSE_DEV_TOKENS && s.mailer.mode === 'log';
  return { id: inv!.id, email, status: inv!.status, expiresAt: inv!.expiresAt.toISOString(), ...(dev ? { devInvitationToken: token } : {}) };
}

/** Accept an invitation. For app users the account email must match the invitation. */
export async function acceptGuardianInvitation(s: Services, token: string, opts: { name?: string; userId?: string | null }) {
  const [inv] = await s.db.select().from(sportsGuardianInvitations).where(eq(sportsGuardianInvitations.tokenHash, sha256(token)));
  if (!inv || inv.status !== 'pending' || inv.expiresAt < new Date()) throw new AppError(401, 'invitation_invalid', 'This invitation has expired or was already used.');
  if (opts.userId) {
    const [u] = await s.db.select().from(users).where(eq(users.id, opts.userId));
    if (!u || u.email.toLowerCase() !== inv.email.toLowerCase() || !u.emailVerifiedAt) throw new AppError(403, 'invitation_email_mismatch', 'Sign in with the email address the invitation was sent to.');
  }
  const out = await s.db.transaction(async (tx) => {
    let [g] = await tx.select().from(customers).where(and(eq(customers.organizationId, inv.organizationId), sql`lower(${customers.email}) = ${inv.email}`, isNull(customers.erasedAt)));
    if (!g) [g] = await tx.insert(customers).values({ organizationId: inv.organizationId, name: opts.name?.trim() || inv.name || inv.email, email: inv.email, userId: opts.userId ?? null }).returning();
    else if (opts.userId && !g.userId) await tx.update(customers).set({ userId: opts.userId }).where(eq(customers.id, g.id));
    await tx.insert(guardianRelationships).values({ organizationId: inv.organizationId, guardianCustomerId: g!.id, participantCustomerId: inv.participantCustomerId, relationship: inv.relationship, status: 'verified', verifiedAt: new Date() })
      .onConflictDoUpdate({ target: [guardianRelationships.guardianCustomerId, guardianRelationships.participantCustomerId], set: { status: 'verified', verifiedAt: new Date(), relationship: inv.relationship } });
    await tx.update(sportsGuardianInvitations).set({ status: 'accepted', acceptedAt: new Date(), acceptedCustomerId: g!.id }).where(eq(sportsGuardianInvitations.id, inv.id));
    await audit(tx, { organizationId: inv.organizationId, actorUserId: opts.userId ?? null, actorType: opts.userId ? 'user' : 'system', action: 'guardian.invitation_accepted', targetType: 'customer', targetId: inv.participantCustomerId, metadata: { invitationId: inv.id, guardianId: g!.id } });
    return g!;
  });
  return { guardian: out, organizationId: inv.organizationId };
}

/** Raise a dispute about a relationship to a participant (by another verified guardian, or staff). */
export async function raiseDispute(s: Services, args: { relationshipId: string; reason: string; byGuardianIds?: string[]; byUserId?: string | null; organizationId?: string }) {
  const [rel] = await s.db.select().from(guardianRelationships).where(eq(guardianRelationships.id, args.relationshipId));
  if (!rel || (args.organizationId && rel.organizationId !== args.organizationId)) throw notFound('Relationship');
  if (args.byGuardianIds) {
    await assertGuardianOf(s.db, args.byGuardianIds, rel.participantCustomerId);
    if (args.byGuardianIds.includes(rel.guardianCustomerId)) throw validationError('To end your own access, contact the club', { relationshipId: 'Your own relationship' });
  }
  if (rel.status === 'disputed') throw conflict('already_disputed', 'This relationship is already under review');
  if (rel.status === 'revoked') throw conflict('revoked', 'This relationship has already been removed');
  const [d] = await s.db.transaction(async (tx) => {
    await tx.update(guardianRelationships).set({ status: 'disputed' }).where(eq(guardianRelationships.id, rel.id));
    const row = await tx.insert(sportsRelationshipDisputes).values({ organizationId: rel.organizationId, relationshipId: rel.id, participantCustomerId: rel.participantCustomerId, raisedByCustomerId: args.byGuardianIds?.[0] ?? null, raisedByUserId: args.byUserId ?? null, reason: args.reason, previousStatus: rel.status }).returning();
    await audit(tx, { organizationId: rel.organizationId, actorUserId: args.byUserId ?? null, actorType: args.byUserId ? 'user' : 'system', action: 'guardian.relationship_disputed', targetType: 'guardian_relationship', targetId: rel.id, metadata: { disputeId: row[0]!.id } });
    return row;
  });
  return { id: d!.id, status: d!.status, relationshipStatus: 'disputed' };
}

export async function resolveDispute(s: Services, orgId: string, disputeId: string, userId: string, outcome: 'uphold' | 'dismiss', note: string) {
  return s.db.transaction(async (tx) => {
    const [d] = await tx.select().from(sportsRelationshipDisputes).where(and(eq(sportsRelationshipDisputes.id, disputeId), eq(sportsRelationshipDisputes.organizationId, orgId))).for('update');
    if (!d) throw notFound('Dispute');
    if (d.status !== 'open') throw conflict('dispute_closed', `Dispute is already ${d.status}`);
    const relStatus = outcome === 'uphold' ? 'revoked' : d.previousStatus;
    await tx.update(guardianRelationships).set({ status: relStatus }).where(eq(guardianRelationships.id, d.relationshipId));
    const [u] = await tx.update(sportsRelationshipDisputes).set({ status: outcome === 'uphold' ? 'upheld' : 'dismissed', resolutionNote: note, resolvedBy: userId, resolvedAt: new Date() }).where(eq(sportsRelationshipDisputes.id, d.id)).returning();
    await audit(tx, { organizationId: orgId, actorUserId: userId, action: `guardian.dispute_${outcome === 'uphold' ? 'upheld' : 'dismissed'}`, targetType: 'guardian_relationship', targetId: d.relationshipId, metadata: { disputeId: d.id, note } });
    return { ...u!, relationshipStatus: relStatus };
  });
}

export { formQuestions, formsComplete, notifyGuardians };

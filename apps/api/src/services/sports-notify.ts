/**
 * Sports notifications. Recipients are always computed from the affected group (team roster, squad or
 * programme) — never the whole network. Each guardian gets one row in `sports_notifications` (the portal
 * inbox) recording whether it was emailed, logged (no email provider) or skipped for lack of consent.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { consentRecords, customers, guardianRelationships, pushTokens, registrations, sportsNotifications, sportsSquadMembers, teams } from '../db/schema/index.ts';

export type SportsNotificationKind =
  | 'session_cancelled' | 'schedule_changed' | 'absence' | 'announcement' | 'instalment_reminder'
  | 'registration_status' | 'selection' | 'guardian_invitation' | 'portal_link';

/** Kinds that need the guardian's explicit opt-in (latest consent record granted). Others are service messages. */
export const CONSENT_PURPOSE: Partial<Record<SportsNotificationKind, string>> = {
  absence: 'sports_absence_alerts',
};

type Team = typeof teams.$inferSelect;

/** Participant ids on a team: accepted registrations assigned to it, or approved squad members. */
export async function rosterParticipantIds(db: Exec, team: Pick<Team, 'id' | 'kind'>): Promise<string[]> {
  if (team.kind === 'squad') {
    return (await db.select({ id: sportsSquadMembers.participantCustomerId }).from(sportsSquadMembers).where(eq(sportsSquadMembers.teamId, team.id))).map((r) => r.id);
  }
  return (await db.select({ id: registrations.participantCustomerId }).from(registrations).where(and(eq(registrations.teamId, team.id), eq(registrations.status, 'accepted')))).map((r) => r.id);
}

/**
 * Guardians who receive notices about these participants: verified relationships, plus the registering
 * guardian whose relationship is still pending email verification (notices go to the address they gave
 * at registration). Disputed and revoked relationships never receive anything.
 */
export async function guardiansOf(db: Exec, organizationId: string, participantIds: string[]) {
  if (!participantIds.length) return [];
  const rows = await db.select({ participantId: guardianRelationships.participantCustomerId, guardian: customers, status: guardianRelationships.status })
    .from(guardianRelationships).innerJoin(customers, eq(customers.id, guardianRelationships.guardianCustomerId))
    .where(and(eq(guardianRelationships.organizationId, organizationId), inArray(guardianRelationships.participantCustomerId, participantIds), inArray(guardianRelationships.status, ['verified', 'pending_verification']), isNull(customers.erasedAt)));
  return rows;
}

async function consented(db: Exec, customerId: string, purpose: string): Promise<boolean> {
  const [row] = await db.select({ granted: consentRecords.granted }).from(consentRecords)
    .where(and(eq(consentRecords.customerId, customerId), eq(consentRecords.purpose, purpose))).orderBy(desc(consentRecords.recordedAt)).limit(1);
  return !!row?.granted;
}

export interface SportsNotifyInput {
  organizationId: string;
  locationId: string | null;
  kind: SportsNotificationKind;
  subject: string;
  body: string;
  refType?: string;
  refId?: string;
  /** guardian customer id → participant it concerns (null = general) */
  recipients: Array<{ guardianId: string; participantId: string | null }>;
}

/** Deliver to each distinct guardian once. Returns per-status counts. */
export async function notifyGuardians(s: Services, input: SportsNotifyInput) {
  const seen = new Set<string>();
  const counts = { sent: 0, logged: 0, skipped_consent: 0, failed: 0 };
  const purpose = CONSENT_PURPOSE[input.kind];
  for (const r of input.recipients) {
    const key = `${r.guardianId}:${r.participantId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [g] = await s.db.select().from(customers).where(eq(customers.id, r.guardianId));
    if (!g || g.erasedAt) continue;
    let status: keyof typeof counts = 'logged';
    if (purpose && !(await consented(s.db, g.id, purpose))) {
      status = 'skipped_consent';
    } else if (g.email) {
      try {
        const res = await s.mailer.send({ to: g.email, subject: input.subject, text: input.body, tag: `sports_${input.kind}` });
        status = res.delivered ? 'sent' : 'logged';
      } catch (err) {
        s.log.error({ err }, '[sports] notification email failed');
        status = 'failed';
      }
      if (g.userId && status !== 'failed') await pushBestEffort(s, g.userId, input);
    }
    counts[status]++;
    await s.db.insert(sportsNotifications).values({
      organizationId: input.organizationId, locationId: input.locationId, guardianCustomerId: g.id, participantCustomerId: r.participantId,
      kind: input.kind, channel: g.email ? 'email' : 'in_app', status, subject: input.subject, body: input.body, refType: input.refType ?? null, refId: input.refId ?? null,
    });
  }
  return { ...counts, recipients: seen.size };
}

/** Push to a guardian's app account, honouring the push_updates preference. Never throws. */
async function pushBestEffort(s: Services, userId: string, input: SportsNotifyInput) {
  try {
    const [pref] = await s.db.select({ granted: consentRecords.granted }).from(consentRecords)
      .where(and(eq(consentRecords.userId, userId), eq(consentRecords.purpose, 'push_updates'))).orderBy(desc(consentRecords.recordedAt)).limit(1);
    if (pref && !pref.granted) return;
    const tokens = await s.db.select({ token: pushTokens.token }).from(pushTokens).where(eq(pushTokens.userId, userId));
    if (!tokens.length) return;
    await s.push.send(tokens.map((t) => ({ to: t.token, title: input.subject, body: input.body.slice(0, 180), data: { category: `sports_${input.kind}`, url: '/sports/guardian' } })));
  } catch (err) {
    s.log.warn({ err }, '[sports] push failed');
  }
}

/** Notify the guardians of everyone on a team (cancellations, schedule changes, team announcements). */
export async function notifyTeam(s: Services, team: Team, msg: Omit<SportsNotifyInput, 'recipients' | 'organizationId' | 'locationId'>) {
  const ids = await rosterParticipantIds(s.db, team);
  const gs = await guardiansOf(s.db, team.organizationId, ids);
  return notifyGuardians(s, { ...msg, organizationId: team.organizationId, locationId: team.locationId, recipients: gs.map((g) => ({ guardianId: g.guardian.id, participantId: g.participantId })) });
}

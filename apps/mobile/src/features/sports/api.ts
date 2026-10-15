/**
 * Sports in the mobile app: guardian (schedule, balances, messages, absence reporting), coach (roster +
 * attendance) and owner (enrolment pulse): `/v1/me/sports*` and `/v1/orgs/:orgId/sports/*`.
 */
import { http } from '@/lib/http';
import { payPayment, type Translate } from '@/lib/cardPayment';

export interface Money { amount: number; currency: string }
export interface GInstalment { id: string; seq: number; dueOn: string; amount: Money; status: string; state: string }
export interface GRegistration { id: string; status: string; programme: { id: string; name: string; refundPolicy: string | null }; location: { id: string; name: string; timeZone: string }; team: { id: string; name: string } | null; balance: { currency: string | null; outstanding: number; overdue: number; paid: number; state: string }; instalments: GInstalment[] }
export interface GParticipant { id: string; name: string; registrations: GRegistration[] }
export interface GSession { id: string; kind: string; status: string; startsAt: string; endsAt: string; venue: string | null; opponent: string | null; homeAway: string | null; cancelReason: string | null; team: { id: string; name: string }; location: { id: string; name: string; timeZone: string }; participants: { id: string; name: string; attendance: { status: string; reason: string | null; reportedBy: string } | null }[] }
export interface GuardianOverview { participants: GParticipant[]; schedule: GSession[]; balances: { currency: string; outstanding: number; overdue: number; paid: number }[]; notifications: { id: string; subject: string; body: string; createdAt: string }[]; pendingRelationships: number; locations: { id: string; name: string }[] }
export interface GMessage { id: string; locationId: string; locationName?: string; direction: 'inbound' | 'outbound'; body: string; createdAt: string }
export interface CoachSession { key: string; orgId: string; id: string; kind: string; status: string; startsAt: string; team: string; venue: string | null; timeZone: string; location: string; rosterCount: number; recorded: number }
export interface RosterRow { id: string; name: string; attendance: string | null; absenceReason: string | null; reportedBy: string | null; care: { emergencyContact: { name: string; phone: string | null } | null; actionPlan: string | null } }
export interface PulseOrg { orgId: string; name: string; enrolment: { programme: string; capacity: number | null; accepted: number; awaitingReview: number; waitlisted: number; fillRate: number | null }[]; balances: { currency: string; outstanding: number; overdue: number; collected: number }[]; attendance: { team: string; rate: number | null }[]; work: { awaitingReview: number; openDisputes: number; pendingSelections: number } | null }

interface MeOrg { id: string; name: string; industry: string; roles: { role: string }[] }
const sportsOrgs = async () => (await http<{ organizations: MeOrg[] }>('GET', '/auth/me')).organizations.filter((o) => o.industry === 'sports');

const live = {
  guardian: () => http<GuardianOverview>('GET', '/me/sports'),
  reportAbsence: (participantId: string, sessionId: string, reason: string, note?: string) => http<unknown>('POST', '/me/sports/absences', { participantId, sessionId, reason, ...(note ? { note } : {}) }),
  /** PaymentSheet on iOS/Android (sandbox: simulated); resolves once the API has the signed webhook. */
  async payInstalment(id: string, t?: Translate): Promise<{ ok: boolean; sandbox: boolean; message?: string }> {
    const r = await http<{ payment: { id: string; sandbox: boolean; clientSecret?: string | null } }>('POST', `/me/sports/instalments/${id}/pay`, {});
    const res = await payPayment(r.payment, t);
    return { ok: res.ok, sandbox: r.payment.sandbox, ...(res.ok ? {} : { message: res.message }) };
  },
  messages: async () => (await http<{ items: GMessage[] }>('GET', '/me/sports/messages')).items,
  sendMessage: (locationId: string, body: string) => http<GMessage>('POST', '/me/sports/messages', { locationId, body }),
  async coachSessions(): Promise<CoachSession[]> {
    const orgs = await sportsOrgs();
    const from = new Date(Date.now() - 12 * 3600_000).toISOString();
    const to = new Date(Date.now() + 36 * 3600_000).toISOString();
    const out: CoachSession[] = [];
    for (const o of orgs) {
      const coachOnly = o.roles.every((r) => r.role === 'staff');
      const r = await http<{ items: { id: string; kind: string; status: string; startsAt: string; venue: string | null; team: { name: string }; location: { name: string; timeZone: string }; rosterCount: number; attendance: { recorded: number } }[] }>('GET', `/orgs/${o.id}/sports/sessions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${coachOnly ? '&mine=true' : ''}`).catch(() => ({ items: [] }));
      for (const s of r.items) out.push({ key: `${o.id}~${s.id}`, orgId: o.id, id: s.id, kind: s.kind, status: s.status, startsAt: s.startsAt, team: s.team.name, venue: s.venue, timeZone: s.location.timeZone, location: s.location.name, rosterCount: s.rosterCount, recorded: s.attendance.recorded });
    }
    return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  },
  roster: async (orgId: string, id: string) => (await http<{ roster: RosterRow[] }>('GET', `/orgs/${orgId}/sports/sessions/${id}/roster`)).roster,
  mark: (orgId: string, id: string, participantId: string, status: string, absenceReason?: string) => http<{ recorded: number; notifiedGuardians: number }>('POST', `/orgs/${orgId}/sports/sessions/${id}/attendance`, { marks: [{ participantId, status, ...(absenceReason ? { absenceReason } : {}) }] }),
  async pulse(): Promise<PulseOrg[]> {
    const out: PulseOrg[] = [];
    for (const o of await sportsOrgs()) {
      const rep = await http<{ enrolment: PulseOrg['enrolment']; balances: PulseOrg['balances']; attendance: PulseOrg['attendance'] }>('GET', `/orgs/${o.id}/sports/reports`).catch(() => null);
      if (!rep) continue;
      const ov = await http<{ work: PulseOrg['work'] }>('GET', `/orgs/${o.id}/sports/overview`).catch(() => ({ work: null }));
      out.push({ orgId: o.id, name: o.name, enrolment: rep.enrolment, balances: rep.balances, attendance: rep.attendance, work: ov.work });
    }
    return out;
  },
};

export const sportsApi = live;

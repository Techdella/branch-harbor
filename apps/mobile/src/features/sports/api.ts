/**
 * Sports in the mobile app: guardian (schedule, balances, messages, absence reporting), coach (roster +
 * attendance) and owner (enrolment pulse). Live: `/v1/me/sports*` and `/v1/orgs/:orgId/sports/*`.
 * Mock (EXPO_PUBLIC_USE_MOCKS): a small in-memory sample academy.
 */
import { env } from '@/lib/env';
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

/* ---------------- mock ---------------- */
const iso = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const TZ = 'America/Toronto';
const mockState = {
  overview: {
    participants: [
      { id: 'mia', name: 'Mia Park', registrations: [{ id: 'r1', status: 'accepted', programme: { id: 'p1', name: 'Youth Academy', refundPolicy: 'Full refund before the first session.' }, location: { id: 'tor', name: 'Toronto Lakeshore', timeZone: TZ }, team: { id: 't1', name: 'U10 Blue' }, balance: { currency: 'CAD', outstanding: 27996, overdue: 13998, paid: 14004, state: 'overdue' }, instalments: [{ id: 'i1', seq: 1, dueOn: '2026-09-01', amount: { amount: 14004, currency: 'CAD' }, status: 'paid', state: 'paid' }, { id: 'i2', seq: 2, dueOn: '2026-10-01', amount: { amount: 13998, currency: 'CAD' }, status: 'scheduled', state: 'overdue' }, { id: 'i3', seq: 3, dueOn: '2026-11-01', amount: { amount: 13998, currency: 'CAD' }, status: 'scheduled', state: 'scheduled' }] }] },
      { id: 'owen', name: 'Owen Park', registrations: [{ id: 'r2', status: 'accepted', programme: { id: 'p1', name: 'Youth Academy', refundPolicy: null }, location: { id: 'tor', name: 'Toronto Lakeshore', timeZone: TZ }, team: { id: 't2', name: 'U12 Blue' }, balance: { currency: 'CAD', outstanding: 12598, overdue: 0, paid: 25202, state: 'on_track' }, instalments: [{ id: 'i4', seq: 3, dueOn: '2026-11-01', amount: { amount: 12598, currency: 'CAD' }, status: 'scheduled', state: 'scheduled' }] }] },
    ],
    schedule: [
      { id: 's1', kind: 'training', status: 'scheduled', startsAt: iso(26), endsAt: iso(27.5), venue: 'Lakeshore Pitch 1', opponent: null, homeAway: null, cancelReason: null, team: { id: 't1', name: 'U10 Blue' }, location: { id: 'tor', name: 'Toronto Lakeshore', timeZone: TZ }, participants: [{ id: 'mia', name: 'Mia Park', attendance: null }] },
      { id: 's2', kind: 'fixture', status: 'scheduled', startsAt: iso(70), endsAt: iso(72), venue: 'Lamport Stadium', opponent: 'Etobicoke Rangers', homeAway: 'home', cancelReason: null, team: { id: 't2', name: 'U12 Blue' }, location: { id: 'tor', name: 'Toronto Lakeshore', timeZone: TZ }, participants: [{ id: 'owen', name: 'Owen Park', attendance: null }] },
      { id: 's3', kind: 'training', status: 'cancelled', startsAt: iso(98), endsAt: iso(99.5), venue: 'Lakeshore Pitch 2', opponent: null, homeAway: null, cancelReason: 'Venue closed for maintenance', team: { id: 't2', name: 'U12 Blue' }, location: { id: 'tor', name: 'Toronto Lakeshore', timeZone: TZ }, participants: [{ id: 'owen', name: 'Owen Park', attendance: null }] },
    ],
    balances: [{ currency: 'CAD', outstanding: 40594, overdue: 13998, paid: 39206 }],
    notifications: [{ id: 'n1', subject: 'Due: Youth Academy instalment 2', body: 'Instalment 2 was due on 1 Oct. You can pay it here.', createdAt: iso(-24) }],
    pendingRelationships: 0,
    locations: [{ id: 'tor', name: 'Toronto Lakeshore' }],
  } as GuardianOverview,
  messages: [{ id: 'm1', locationId: 'tor', direction: 'inbound', body: 'Mia has a school trip on the 30th.', createdAt: iso(-50) }, { id: 'm2', locationId: 'tor', direction: 'outbound', body: 'Thanks — you can mark it in the app so the coach sees it.', createdAt: iso(-48) }] as GMessage[],
  roster: [
    { id: 'k1', name: 'Leo Park', attendance: null, absenceReason: null, reportedBy: null, care: { emergencyContact: { name: 'Sam Park', phone: '+1 416 555 0101' }, actionPlan: null } },
    { id: 'k2', name: 'Ava Singh', attendance: 'excused', absenceReason: 'school', reportedBy: 'guardian', care: { emergencyContact: { name: 'Alex Singh', phone: '+1 416 555 0102' }, actionPlan: 'Sample: allow inhaler use; call guardian if symptoms continue' } },
    { id: 'k3', name: 'Noah Williams', attendance: null, absenceReason: null, reportedBy: null, care: { emergencyContact: null, actionPlan: null } },
  ] as RosterRow[],
};
const wait = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(JSON.parse(JSON.stringify(v)) as T), 250));
const mock: typeof live = {
  guardian: () => wait(mockState.overview),
  async reportAbsence(participantId, sessionId, reason) {
    const s = mockState.overview.schedule.find((x) => x.id === sessionId);
    const p = s?.participants.find((x) => x.id === participantId);
    if (p) p.attendance = { status: 'excused', reason, reportedBy: 'guardian' };
    return wait({});
  },
  async payInstalment(id) {
    for (const p of mockState.overview.participants) for (const r of p.registrations) for (const i of r.instalments) if (i.id === id) { i.status = 'paid'; i.state = 'paid'; r.balance.outstanding -= i.amount.amount; if (r.balance.overdue) r.balance.overdue = Math.max(0, r.balance.overdue - i.amount.amount); r.balance.paid += i.amount.amount; }
    const b = mockState.overview.balances[0]!;
    b.outstanding = mockState.overview.participants.reduce((a, p) => a + p.registrations.reduce((x, r) => x + r.balance.outstanding, 0), 0);
    b.overdue = mockState.overview.participants.reduce((a, p) => a + p.registrations.reduce((x, r) => x + r.balance.overdue, 0), 0);
    return wait({ ok: true, sandbox: true });
  },
  messages: () => wait(mockState.messages),
  async sendMessage(locationId, body) { const m: GMessage = { id: `m${Date.now()}`, locationId, direction: 'inbound', body, createdAt: new Date().toISOString() }; mockState.messages.push(m); return wait(m); },
  coachSessions: () => wait([{ key: 'o~c1', orgId: 'o', id: 'c1', kind: 'training', status: 'scheduled', startsAt: iso(1), team: 'U10 Blue', venue: 'Lakeshore Pitch 1', timeZone: TZ, location: 'Toronto Lakeshore', rosterCount: 3, recorded: 1 }]),
  roster: () => wait(mockState.roster),
  async mark(_o, _s, participantId, status) { const r = mockState.roster.find((x) => x.id === participantId); if (r) { r.attendance = status; r.reportedBy = 'coach'; } return wait({ recorded: 1, notifiedGuardians: status === 'absent' ? 1 : 0 }); },
  pulse: () => wait([{ orgId: 'o', name: 'North Shore FA (sample)', work: { awaitingReview: 3, openDisputes: 1, pendingSelections: 2 }, enrolment: [{ programme: 'Youth Academy · Toronto', capacity: 60, accepted: 34, awaitingReview: 3, waitlisted: 2, fillRate: 61.7 }, { programme: 'Youth Academy · Manchester', capacity: 60, accepted: 22, awaitingReview: 1, waitlisted: 0, fillRate: 38.3 }], balances: [{ currency: 'CAD', outstanding: 182400, overdue: 41996, collected: 1290000 }, { currency: 'GBP', outstanding: 48000, overdue: 12000, collected: 384000 }], attendance: [{ team: 'U10 Blue', rate: 91.2 }, { team: 'U11 Sky', rate: null }] }]),
};

export const sportsApi = env.useMocks ? mock : live;

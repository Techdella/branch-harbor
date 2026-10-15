/**
 * Sports data client: apps/api `/v1/orgs/:orgId/sports/*` for the selected organisation (lists are filtered
 * client-side to the selected scope's locations).
 */
import { ApiError } from '../errors';
import { http } from '../http/client';
import { orgId } from '../http/workspace';
import type {
  AgePreview, SAnnouncement, SBalanceRow, SBalanceTotals, SCoach, SDispute, SForm, SGuardianRel, SOverview, SProgramme, SProposal, SQuestion, SRegistration, SReport,
  SRoster, SSeason, SSelection, SSession, STeam, STeamDetail, SThread, SVenue, SetupInput,
} from './types';

/** Locations in the selected scope; empty = every authorised location. */
export type ScopeIds = string[];

export interface SportsClient {
  overview(scope: ScopeIds): Promise<SOverview>;
  reports(scope: ScopeIds): Promise<SReport>;
  programmes(scope: ScopeIds): Promise<SProgramme[]>;
  updateProgramme(id: string, patch: Partial<Pick<SProgramme, 'status' | 'description' | 'capacity' | 'refundPolicy'>>): Promise<SProgramme>;
  seasons(): Promise<SSeason[]>;
  venues(locationId?: string): Promise<SVenue[]>;
  coaches(locationId: string): Promise<SCoach[]>;
  forms(): Promise<{ builtIn: SQuestion[]; items: SForm[] }>;
  createForm(input: { locationId: string; name: string; questions: SQuestion[] }): Promise<SForm>;
  agePreview(q: { locationId: string; startsOn: string; endsOn: string; rule?: string; cutoffDate?: string; ageMin?: number; ageMax?: number }): Promise<AgePreview>;
  setup(input: SetupInput): Promise<{ season: SSeason; programmes: { id: string; name: string }[] }>;
  registrations(scope: ScopeIds): Promise<SRegistration[]>;
  review(id: string, decision: 'accept' | 'waitlist' | 'reject', teamId?: string, note?: string): Promise<void>;
  withdraw(id: string, reason: string): Promise<void>;
  restricted(id: string): Promise<{ access: 'full' | 'coach'; answers: Record<string, unknown> }>;
  teams(scope: ScopeIds): Promise<STeam[]>;
  team(id: string): Promise<STeamDetail>;
  transfer(registrationId: string, toTeamId: string, reason?: string): Promise<void>;
  setCoaches(teamId: string, headCoachUserId: string | null, assistantUserIds: string[]): Promise<void>;
  sessions(scope: ScopeIds, from: string, to: string, opts?: { mine?: boolean }): Promise<SSession[]>;
  roster(sessionId: string): Promise<SRoster>;
  markAttendance(sessionId: string, marks: { participantId: string; status: string; absenceReason?: string }[]): Promise<{ recorded: number; notifiedGuardians: number; skippedNoConsent: number }>;
  cancelSession(id: string, reason: string): Promise<{ recipients: number }>;
  resolutions(sessionId: string): Promise<{ conflicts: { sessionId: string; teamName: string; startsAt: string }[]; proposals: SProposal[] }>;
  applyProposal(id: string): Promise<{ recipients: number }>;
  aiResolutions(sessionId: string): Promise<SProposal[]>;
  createFixture(teamId: string, input: { opponent: string; homeAway: 'home' | 'away' | 'neutral'; date: string; kickoff: string; durationMinutes: number; venueId?: string; venueName?: string; competition?: string }): Promise<{ venueConflicts: unknown[] }>;
  createRecurring(teamId: string, input: { weekdays: number[]; startTime: string; durationMinutes: number; from: string; until: string; venueId?: string; skipConflicts: boolean }): Promise<{ created: number; conflicts: { date: string }[] }>;
  selections(scope: ScopeIds): Promise<SSelection[]>;
  proposeSelection(input: { squadTeamId: string; title: string; notes?: string; participants: { id: string; note?: string }[] }): Promise<void>;
  decideSelection(id: string, decision: 'approve' | 'reject', note?: string): Promise<void>;
  announcements(scope: ScopeIds): Promise<SAnnouncement[]>;
  announce(input: { scopeKind: 'team' | 'programme'; scopeId: string; title: string; body: string }): Promise<{ recipientCount: number }>;
  balances(scope: ScopeIds): Promise<{ items: SBalanceRow[]; totals: SBalanceTotals[] }>;
  adjust(registrationId: string, input: { kind: 'financial_aid' | 'waiver'; amountMinor?: number; waiveAll?: boolean; reason: string }): Promise<void>;
  runReminders(): Promise<{ sent: number }>;
  guardians(scope: ScopeIds): Promise<{ items: SGuardianRel[]; invitations: { id: string; participantId: string; email: string; expiresAt: string }[] }>;
  disputes(): Promise<SDispute[]>;
  resolveDispute(id: string, outcome: 'uphold' | 'dismiss', note: string): Promise<void>;
  verifyRelationship(id: string, note: string): Promise<void>;
  threads(scope: ScopeIds): Promise<SThread[]>;
  reply(locationId: string, guardianId: string, body: string): Promise<void>;
  aiDescription(programmeId: string): Promise<{ draft: string }>;
  aiEnrolment(locationId?: string): Promise<{ summary: string; asOf: string }>;
}

const o = (p: string) => `/orgs/${orgId()}/sports${p}`;
const inScope = (scope: ScopeIds, locationId: string | null | undefined) => !scope.length || (!!locationId && scope.includes(locationId));
const items = <T,>(r: { items: T[] }) => r.items;

export const liveSports: SportsClient = {
  async overview(scope) {
    const r = await http.get<SOverview>(o('/overview'), scope.length === 1 ? { locationId: scope[0] } : undefined);
    return { ...r, locations: r.locations.filter((l) => inScope(scope, l.id)), programmes: r.programmes.filter((p) => inScope(scope, p.locationId)) };
  },
  async reports(scope) {
    const r = await http.get<SReport>(o('/reports'), scope.length === 1 ? { locationId: scope[0] } : undefined);
    return { ...r, enrolment: r.enrolment.filter((e) => inScope(scope, e.locationId)), capacity: r.capacity.filter((c) => inScope(scope, c.locationId)), attendance: r.attendance.filter((a) => inScope(scope, a.locationId)) };
  },
  programmes: async (scope) => (await http.get<{ items: SProgramme[] }>(o('/programmes')).then(items)).filter((p) => inScope(scope, p.locationId)),
  updateProgramme: (id, patch) => http.patch<SProgramme>(o(`/programmes/${id}`), patch),
  seasons: () => http.get<{ items: SSeason[] }>(o('/seasons')).then(items),
  venues: (locationId) => http.get<{ items: SVenue[] }>(o('/venues'), { locationId }).then(items),
  coaches: (locationId) => http.get<{ items: SCoach[] }>(o('/coaches'), { locationId }).then(items),
  forms: () => http.get<{ builtIn: SQuestion[]; items: SForm[] }>(o('/forms')),
  createForm: (input) => http.post<SForm>(o('/forms'), input),
  agePreview: (q) => http.get<AgePreview>(o('/age-preview'), q),
  setup: (input) => http.post(o('/setup'), input),
  registrations: async (scope) => (await http.get<{ items: SRegistration[] }>(o('/registrations')).then(items)).filter((r) => inScope(scope, r.locationId)),
  review: async (id, decision, teamId, note) => { await http.post(o(`/registrations/${id}/review`), { decision, teamId, note }); },
  withdraw: async (id, reason) => { await http.post(o(`/registrations/${id}/withdraw`), { reason }); },
  restricted: (id) => http.get(o(`/registrations/${id}/restricted`)),
  teams: async (scope) => (await http.get<{ items: STeam[] }>(o('/teams')).then(items)).filter((t) => inScope(scope, t.locationId)),
  team: (id) => http.get<STeamDetail>(o(`/teams/${id}`)),
  transfer: async (id, toTeamId, reason) => { await http.post(o(`/registrations/${id}/transfer`), { toTeamId, reason }); },
  setCoaches: async (teamId, headCoachUserId, assistantUserIds) => { await http.put(o(`/teams/${teamId}/coaches`), { headCoachUserId, assistantUserIds }); },
  sessions: async (scope, from, to, opts) => (await http.get<{ items: SSession[] }>(o('/sessions'), { from, to, mine: opts?.mine ? 'true' : undefined }).then(items)).filter((x) => inScope(scope, x.location.id)),
  roster: (id) => http.get<SRoster>(o(`/sessions/${id}/roster`)),
  markAttendance: (id, marks) => http.post(o(`/sessions/${id}/attendance`), { marks }),
  cancelSession: async (id, reason) => {
    const r = await http.post<{ delivery: { recipients: number } | null }>(o(`/sessions/${id}/cancel`), { reason });
    return { recipients: r.delivery?.recipients ?? 0 };
  },
  resolutions: (id) => http.get(o(`/sessions/${id}/resolutions`)),
  applyProposal: async (id) => {
    const r = await http.post<{ delivery: { recipients: number } | null }>(o(`/schedule-proposals/${id}/apply`), {});
    return { recipients: r.delivery?.recipients ?? 0 };
  },
  aiResolutions: async (sessionId) => (await http.post<{ proposals: SProposal[] }>(o('/ai/conflict-resolutions'), { sessionId })).proposals,
  createFixture: (teamId, input) => http.post(o(`/teams/${teamId}/fixtures`), input),
  createRecurring: (teamId, input) => http.post(o(`/teams/${teamId}/recurring-sessions`), input),
  selections: async (scope) => (await http.get<{ items: SSelection[] }>(o('/selections')).then(items)).filter((x) => inScope(scope, x.locationId)),
  proposeSelection: async (input) => { await http.post(o('/selections'), input); },
  decideSelection: async (id, decision, note) => { await http.post(o(`/selections/${id}/decision`), { decision, note }); },
  announcements: async (scope) => (await http.get<{ items: SAnnouncement[] }>(o('/announcements')).then(items)).filter((x) => inScope(scope, x.locationId)),
  announce: (input) => http.post(o('/announcements'), input),
  balances: async (scope) => {
    const r = await http.get<{ items: SBalanceRow[]; totals: SBalanceTotals[] }>(o('/balances'), scope.length === 1 ? { locationId: scope[0] } : undefined);
    const rows = r.items.filter((x) => inScope(scope, x.location.id));
    return { items: rows, totals: totalsOf(rows) };
  },
  adjust: async (id, input) => { await http.post(o(`/registrations/${id}/fee-adjustments`), input); },
  runReminders: () => http.post(o('/instalments/run-reminders'), {}),
  guardians: async (scope) => {
    const r = await http.get<{ items: SGuardianRel[]; invitations: { id: string; participantId: string; email: string; expiresAt: string }[] }>(o('/guardians'));
    return { ...r, items: r.items.filter((x) => inScope(scope, x.participant.locationId)) };
  },
  disputes: () => http.get<{ items: SDispute[] }>(o('/disputes')).then(items),
  resolveDispute: async (id, outcome, note) => { await http.post(o(`/disputes/${id}/resolve`), { outcome, note }); },
  verifyRelationship: async (id, note) => { await http.post(o(`/relationships/${id}/verify`), { note }); },
  threads: async (scope) => (await http.get<{ threads: SThread[] }>(o('/messages'))).threads.filter((t) => inScope(scope, t.locationId)),
  reply: async (locationId, guardianId, body) => { await http.post(o('/messages'), { locationId, guardianId, body }); },
  aiDescription: (programmeId) => http.post(o('/ai/programme-description'), { programmeId }),
  aiEnrolment: (locationId) => http.post(o('/ai/enrolment-summary'), { locationId }),
};

/** Per-currency totals of outstanding/overdue/paid — currencies are never combined. */
export function totalsOf(rows: SBalanceRow[]): SBalanceTotals[] {
  const m = new Map<string, SBalanceTotals>();
  for (const r of rows) {
    const c = r.balance.currency;
    if (!c) continue;
    const t = m.get(c) ?? { currency: c, outstanding: 0, overdue: 0, paid: 0, registrations: 0 };
    t.outstanding += r.balance.outstanding;
    t.overdue += r.balance.overdue;
    t.paid += r.balance.paid;
    t.registrations++;
    m.set(c, t);
  }
  return [...m.values()];
}

/** The live Sports client. */
export async function getSports(): Promise<SportsClient> {
  return liveSports;
}

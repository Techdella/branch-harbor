/** Sports view models — the shapes of apps/api `/v1/orgs/:orgId/sports/*` responses the screens use. */
import type { Currency, Money } from '@bh/shared';

export type RegStatus = 'submitted' | 'awaiting_review' | 'accepted' | 'waitlisted' | 'withdrawn' | 'rejected';
export type BalanceState = 'none' | 'paid' | 'on_track' | 'due' | 'overdue' | 'waived';
export type AgeRule = 'age_on_date' | 'birth_year';

export interface SLocation { id: string; name: string; timeZone: string; currency: Currency; country?: string }

export interface SBalance {
  currency: Currency | null;
  total: number;
  paid: number;
  outstanding: number;
  overdue: number;
  state: BalanceState;
  nextDue: { dueOn: string; amountMinor: number; instalmentId: string } | null;
}

export interface SInstalment {
  id: string;
  seq: number;
  dueOn: string;
  amount: Money;
  status: string;
  state: 'scheduled' | 'due' | 'overdue' | 'paid' | 'waived' | 'cancelled';
  paidAt: string | null;
  remindersSent: number;
  lastReminderStage: string | null;
}

export interface SSeason { id: string; name: string; startsOn: string; endsOn: string; locationId: string | null; ageRule: AgeRule | null; ageCutoffDate: string | null; status: string }
export interface SVenue { id: string; locationId: string; name: string; kind: string; surface: string | null; parentVenueId: string | null; active: boolean }
export interface SCoach { id: string; name: string; email: string; roles: string[] }

export interface SProgramme {
  id: string;
  locationId: string;
  name: string;
  description: string | null;
  kind: string;
  status: 'draft' | 'published' | 'closed' | 'archived';
  ageMin: number | null;
  ageMax: number | null;
  ageRule: AgeRule;
  ageCutoffDate: string | null;
  capacity: number | null;
  feeMinor: number;
  currency: Currency;
  requiresApproval: boolean;
  refundPolicy: string | null;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  siblingDiscountBps: number;
  season: { id: string; name: string; startsOn: string; endsOn: string } | null;
  counts: { accepted: number; awaitingReview: number; submitted: number; waitlisted: number; withdrawn: number };
}

export interface SQuestion { key: string; label: string; type: string; required: boolean; options?: string[]; category: 'general' | 'medical' | 'emergency' | 'consent'; coachVisible?: boolean; help?: string }
export interface SForm { id: string; name: string; version: number; locationId: string | null; questions: SQuestion[]; status: string }

export interface SRegistration {
  id: string;
  locationId: string;
  status: RegStatus;
  teamId: string | null;
  paymentPlan: 'full' | 'instalments';
  listFeeMinor: number;
  totalFeeMinor: number;
  currency: Currency | null;
  reviewNote: string | null;
  createdAt: string;
  participant: { id: string; name: string; dateOfBirth: string | null; age: number | null; ageGroup: string | null };
  programme: { id: string; name: string; requiresApproval: boolean };
  guardian: { id: string; name: string; email: string | null; relationshipStatus: string | null; relationship: string | null } | null;
  guardiansCount: number;
  balance: SBalance;
  adjustments: { id: string; kind: string; amount: Money; reason: string | null }[];
  formsComplete: boolean;
  holdActive: boolean;
  lastPaymentState: string | null;
}

export interface STeam {
  id: string;
  locationId: string;
  programmeId: string;
  name: string;
  kind: 'team' | 'group' | 'squad';
  capacity: number | null;
  rosterCount: number;
  coach: { id: string; name: string } | null;
  assistants: { id: string; name: string }[];
  youCoach: boolean;
}

export interface STeamDetail {
  team: STeam;
  programme: { id: string; name: string };
  canManage: boolean;
  coach: { id: string; name: string } | null;
  assistants: { id: string; name: string; role: string }[];
  roster: { id: string; name: string; dateOfBirth: string | null; registrationId: string | null; ageGroup: string | null }[];
  moves: { id: string; participant: string; fromTeamId: string | null; toTeamId: string | null; reason: string | null; at: string }[];
}

export interface SSession {
  id: string;
  kind: 'training' | 'fixture';
  status: 'scheduled' | 'cancelled';
  startsAt: string;
  endsAt: string;
  venue: string | null;
  venueId: string | null;
  opponent: string | null;
  homeAway: 'home' | 'away' | 'neutral' | null;
  competition: string | null;
  cancelReason: string | null;
  location: { id: string; name: string; timeZone: string };
  team: { id: string; name: string; kind: string; coach: { id: string; name: string } | null };
  programme: { id: string; name: string };
  youCoach: boolean;
  rosterCount: number;
  attendance: { recorded: number; present: number; absent: number; late: number; excused: number };
  venueConflict: boolean;
  conflicts: { sessionId: string; teamName: string; startsAt: string; endsAt: string }[];
}

export interface SRosterEntry {
  id: string;
  name: string;
  attendance: 'present' | 'absent' | 'late' | 'excused' | null;
  absenceReason: string | null;
  reportedBy: 'coach' | 'guardian' | null;
  note: string | null;
  care: { emergencyContact: { name: string; phone: string | null } | null; actionPlan: string | null; medicalInfoOnFile: boolean };
}
export interface SRoster { session: { id: string; startsAt: string; endsAt: string; venue: string | null; kind: string; status: string; timeZone: string }; team: { id: string; name: string }; roster: SRosterEntry[] }

export interface SProposal { id: string; sessionId: string; source: 'rules' | 'ai'; status: string; rationale: string | null; proposal: { kind: string; venueId: string | null; venueName: string | null; startsAt: string; endsAt: string } }

export interface SSelection {
  id: string;
  locationId: string;
  squadTeamId: string;
  squadName: string;
  title: string;
  notes: string | null;
  status: 'proposed' | 'approved' | 'rejected' | 'withdrawn';
  proposedByName: string;
  decisionNote: string | null;
  canDecide: boolean;
  participants: { id: string; name: string; note: string | null }[];
  createdAt: string;
}

export interface SAnnouncement { id: string; locationId: string; scopeKind: 'team' | 'programme'; scopeId: string; scopeName: string | null; title: string; body: string; recipientCount: number; createdAt: string; createdByName: string | null }

export interface SBalanceRow {
  registrationId: string;
  status: RegStatus;
  participant: string;
  guardian: string | null;
  programme: string;
  location: { id: string; name: string; timeZone: string };
  plan: string;
  listFee: Money;
  balance: SBalance;
  instalments: SInstalment[];
  adjustments: { kind: string; amount: Money; reason: string | null; at: string }[];
}
export interface SBalanceTotals { currency: Currency; outstanding: number; overdue: number; paid: number; registrations: number }

export interface SGuardianRel { id: string; relationship: string; status: 'pending_verification' | 'verified' | 'disputed' | 'revoked'; participant: { id: string; name: string; locationId: string | null }; guardian: { id: string; name: string; email: string | null; phone: string | null; hasAccount: boolean } | null }
export interface SDispute { id: string; status: string; reason: string; createdAt: string; participant: { id: string; name: string }; relationship: { id: string; relationship: string; guardian: { id: string; name: string; email: string | null } | null }; raisedBy: string | null; resolutionNote: string | null }
export interface SThread { guardian: { id: string; name: string }; locationId: string; locationName: string; unread: number; messages: { id: string; direction: 'inbound' | 'outbound'; body: string; createdAt: string }[] }

export interface SOverview {
  locations: SLocation[];
  programmes: { id: string; name: string; status: string; locationId: string; capacity: number | null; held: number; accepted: number; awaitingReview: number; awaitingPayment: number; waitlisted: number }[];
  work: { awaitingReview: number; openDisputes: number; pendingSelections: number; overdueInstalments: number | null; overdueByCurrency: { currency: Currency; amount: number }[] | null } | null;
  upcoming: { id: string; kind: string; status: string; team: string; startsAt: string; endsAt: string; venue: string | null; opponent: string | null; location: { name: string; timeZone: string } }[];
}

export interface SReport {
  asOf: string;
  periodDays: number;
  enrolment: { programmeId: string; programme: string; locationId: string; capacity: number | null; accepted: number; awaitingReview: number; awaitingPayment: number; waitlisted: number; withdrawn: number; fillRate: number | null; fillRateUnavailableReason: string | null }[];
  capacity: { teamId: string; team: string; kind: string; locationId: string; roster: number; capacity: number | null; spaces: number | null }[];
  attendance: { teamId: string; team: string; locationId: string; recorded: number; attended: number; excused: number; rate: number | null; rateUnavailableReason: string | null }[];
  balances: { currency: Currency; outstanding: number; overdue: number; collected: number }[];
  locations: SLocation[];
}

export interface AgePreview { default: { rule: AgeRule; cutoffDate: string; note: string }; rule: AgeRule; cutoffDate: string; birthDates: { from: string | null; to: string | null } }

export interface SetupProgrammeInput {
  name: string;
  description?: string;
  kind: string;
  ageMin?: number;
  ageMax?: number;
  ageRule?: AgeRule;
  ageCutoffDate?: string;
  eligibilityNotes?: string;
  capacity?: number;
  feeMinor: number;
  requiresApproval: boolean;
  refundPolicy?: string;
  registrationOpensAt?: string;
  registrationClosesAt?: string;
  venueIds: string[];
  siblingDiscountBps: number;
  registrationFormId?: string;
  feePlans: { name: string; kind: 'full' | 'instalments'; schedule: { dueOn: string; shareBps: number }[] }[];
  teams: { name: string; capacity?: number; coachUserId?: string; assistantUserIds: string[]; kind: 'team' | 'group' | 'squad' }[];
}
export interface SetupInput {
  locationId: string;
  season: { name: string; startsOn: string; endsOn: string; ageRule?: AgeRule; ageCutoffDate?: string };
  venues: { name: string; kind: string; surface?: string }[];
  programmes: SetupProgrammeInput[];
  publish: boolean;
}

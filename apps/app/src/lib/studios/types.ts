/** View models for the Studios full-product screens (live API and sample data share them). */
export interface Money { amount: number; currency: string }
export type AccessPolicy = 'home_only' | 'any_location' | 'same_currency' | 'listed';

export interface Room { id: string; locationId: string; name: string; capacity: number; features: string[]; active: boolean; upcomingClasses: number }
export interface ClassTypeVM { id: string; name: string; description: string | null; durationMinutes: number; defaultCapacity: number; creditCost: number; category: string | null; level: string | null; locationId: string | null }
export interface Instructor { userId: string; name: string; roles: string[]; availability: Array<{ id: string; kind: 'available' | 'unavailable'; weekday: number | null; onDate: string | null; startTime: string; endTime: string; note: string | null }> }

export interface Recurrence { freq: 'WEEKLY'; interval: number; byWeekday: number[]; time: string; startDate: string; untilDate: string | null; count: number | null; skipDates: string[] }
export interface SeriesVM {
  id: string; locationId: string; locationName: string | null; classTypeId: string; className: string | null; status: 'draft' | 'published' | 'ended'; recurrence: Recurrence; timeZone: string; rrule: string;
  durationMinutes: number; instructorName: string | null; roomName: string | null; capacity: number; price: Money; creditCost: number; allowCredits: boolean; allowMembership: boolean; online: boolean;
  upcoming: number | null; bookings: number | null; splitFromId: string | null;
}
export interface SeriesInput {
  locationId: string; classTypeId: string; recurrence: Recurrence; instructorUserId?: string | null; instructorName?: string | null; roomId?: string | null; capacity?: number;
  priceMinor: number; creditCost?: number; allowCredits: boolean; allowMembership: boolean; online: boolean;
}
export interface Conflict { kind: 'room_busy' | 'instructor_busy' | 'instructor_unavailable' | 'room_capacity'; message: string }
export interface SeriesPreview {
  classType: { id: string; name: string }; timeZone: string; rrule: string; durationMinutes: number; capacity: number; room: { id: string; name: string; capacity: number } | null; instructorName: string | null;
  price: Money; creditCost: number; summary: { count: number; first: string | null; last: string | null; crossesDst: boolean; conflicts: number; dstAdjusted: number };
  occurrences: Array<{ localDate: string; localTime: string; startsAt: string; endsAt: string; utcOffsetMinutes: number; dstAdjusted: boolean; conflicts: Conflict[] }>;
}

export type EditScope = 'one' | 'following' | 'series';
export interface EditChanges { time?: string; weekday?: number; durationMinutes?: number; instructorName?: string | null; instructorUserId?: string | null; roomId?: string | null; capacity?: number; priceMinor?: number; online?: boolean; cancel?: boolean }
export interface EditPreview {
  scope: EditScope; timeZone: string;
  totals: { occurrences: number; bookings: number; customers: number; waitlisted: number; conflicts: number };
  notify: { customers: number; channels: string[] };
  warnings: string[];
  items: Array<{ occurrenceId: string; detached: boolean; before: { startsAt: string; instructorName: string | null; room: string | null; capacity: number }; after: { startsAt: string; instructorName: string | null; room: string | null; capacity: number; dstAdjusted: boolean } | null; bookings: number; waitlist: number; overCapacity: number; conflicts: Conflict[]; changes: string[] }>;
}
export interface EditResult { occurrences: number; bookingsAffected: number; cancelledBookings: number; customersNotified: number; newSeriesId: string | null; delivery: { sent: number; skipped: number } }

export interface RosterItem { bookingId: string; status: 'held' | 'confirmed' | 'attended' | 'no_show'; customer: { id: string; name: string }; bookedWith: string; paymentMethod: string; checkedInAt: string | null; checkInSource: string | null; fee: { id: string; kind: string; amount: number; currency: string; status: string } | null }
export interface Roster { occurrence: { id: string; name: string; startsAt: string; endsAt: string; timeZone: string; locationName: string; instructorName: string | null; room: string | null; capacity: number; status: string; youTeach: boolean }; counts: { booked: number; checkedIn: number; noShows: number }; items: RosterItem[] }
export interface NotificationRow { id: string; kind: string; channel: 'email' | 'sms' | 'push'; status: string; subject: string; customer: string; createdAt: string }

export interface PackProduct { id: string; locationId: string | null; name: string; description: string | null; credits: number; validityDays: number; prices: Record<string, number>; transferPolicy: AccessPolicy; status: string; scope: 'network' | 'location'; sellableAt: string[]; missingCurrencies: string[]; active: number }
export interface MembershipPlan { id: string; locationId: string | null; name: string; description: string | null; classesPerPeriod: number | null; prices: Record<string, number>; accessPolicy: AccessPolicy; noticeDays: number; maxPauseDays: number; graceDays: number; status: string; scope: 'network' | 'location'; sellableAt: string[]; missingCurrencies: string[]; active: number }
export interface PolicyVM { lateCancelMinutes: number; lateCancelFee: Record<string, number>; noShowFee: Record<string, number>; forfeitCreditOnLateCancel: boolean; refundPaidOnLateCancel: boolean; feesApplyToMembers: boolean; bookingWindowDays: number; source?: string }
export interface Policies { organizationDefault: (PolicyVM & { id: string }) | null; locationOverrides: Array<PolicyVM & { id: string; locationId: string }>; effective: Array<{ locationId: string; locationName: string; currency: string; policy: PolicyVM; text: string[] }> }

export type MembershipStateKey = 'active' | 'paused' | 'grace' | 'suspended' | 'cancelling' | 'cancelled' | 'pending' | 'ended';
export interface MemberRow {
  id: string; name: string; email: string | null; phone: string | null; homeLocation: { id: string; name: string } | null;
  membership: { id: string; name: string; state: MembershipStateKey; graceUntil: string | null; cancelAt: string | null } | null;
  packs: { count: number; credits: number; nextExpiry: string | null }; attendance: { attended: number; noShows: number; lastVisit: string | null };
  consent: { marketingEmail: boolean | null; marketingSms: boolean | null; classUpdatesSms: boolean | null };
}
export interface MembershipVM {
  id: string; name: string; status: string; state: MembershipStateKey; recurring: boolean; classesPerPeriod: number | null; accessPolicy: AccessPolicy; price: (Money & { interval: string | null }) | null;
  startsAt: string; currentPeriodEnd: string | null; pausedFrom: string | null; pausedUntil: string | null; cancelAt: string | null; graceUntil: string | null; failedAttempts: number; billing: string;
  usage?: { used: number; limit: number | null; periodEnd: string } | null; invoices?: Array<{ id: string; periodStart: string; amount: Money; status: string; attempts: number; failureReason: string | null }>;
}
export interface PackVM { id: string; name: string; locationId: string | null; creditsTotal: number; creditsRemaining: number; expiresAt: string | null; status: string; transferPolicy: string; source: string }
export interface MemberDetail {
  id: string; name: string; email: string | null; phone: string | null; locationId: string | null;
  memberships: MembershipVM[]; packs: PackVM[];
  bookings: Array<{ id: string; className: string; locationName: string; timeZone: string; startsAt: string; status: string; paymentMethod: string; lateCancel: boolean; checkedInAt: string | null }>;
  attendance: { attended: number; noShows: number; lateCancels: number; upcoming: number };
  fees: Array<{ id: string; kind: string; amount: Money; status: string; waiveReason: string | null; createdAt: string }>;
  consents: Array<{ purpose: string; granted: boolean; version: string; source: string; recordedAt: string }>;
  purchases: Array<{ id: string; kind: string; name: string; status: string; amount: Money; createdAt: string }>;
  online: Array<{ contentId: string; title: string; kind: string; basis: string; joinedAt: string | null }>;
}

export interface OnlineItem {
  id: string; kind: 'livestream' | 'on_demand'; title: string; description: string | null; instructorName: string | null; provider: string; providerUrl?: string; startsAt: string | null; durationMinutes: number | null;
  locationId: string | null; locationName: string | null; allowMembers: boolean; allowPackHolders: boolean; allowFree: boolean; prices: Record<string, number>; rules: string[]; status: 'draft' | 'published' | 'archived'; registrations: number | null;
}
export interface OnlineInput { locationId: string | null; kind: 'livestream' | 'on_demand'; title: string; description?: string; provider: string; providerUrl: string; startsAt?: string | null; durationMinutes?: number | null; allowMembers: boolean; allowPackHolders: boolean; allowFree: boolean; prices: Record<string, number>; status: 'draft' | 'published' }

export interface StudioReport {
  generatedAt: string; definitions: Record<string, string>; source: string;
  occupancy: { byLocation: Array<{ locationId: string; locationName: string; classes: number; capacity: number; booked: number; occupancyPct: number | null }>; byClassType: Array<{ classTypeId: string; name: string; classes: number; occupancyPct: number | null }> };
  attendance: Array<{ weekStart: string; attended: number; noShow: number; lateCancel: number; booked: number; classes: number; unrecorded: number; attendanceRatePct: number | null }>;
  churn: Array<{ month: string; activeAtStart: number; started: number; cancelled: number; activeAtEnd: number; churnRatePct: number | null }>;
  revenue: Array<{ currency: string; gross: number | null; refunds: number | null; net: number | null; payments: number; byCategory: Record<string, number>; unavailableReason?: string }>;
}
export interface AiDescription { draft: string; source: 'model' | 'template'; notes: string[]; classTypeId: string }
export interface AiAttendance { observations: string[]; narrative: string | null; notInferred: string; source: 'model' | 'template'; current: { classes: number; booked: number; occupancyPct: number | null }; previous: { classes: number; booked: number; occupancyPct: number | null } }
export interface AiAudience { proposalId: string; key: string; title: string; rule: string; size: number; emailConsented: number; sample: string[]; suggestedMessage: string; status: 'proposed' }

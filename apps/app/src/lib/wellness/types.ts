/** Wellness view models (shapes follow the API). Money = minor units + currency. */
export type WMoney = { amount: number; currency: string };
export type Window = { weekday: number; start: string; end: string };
export type Policy = { freeCancelHours: number; lateCancelFeePercent: number; noShowFeePercent: number; depositRefundable: boolean };
export type DepositRule = { kind: 'none' | 'fixed' | 'percent'; value: number };

export interface WVariantPrice { locationId: string; priceMinor: number; depositMinor: number | null; currency: string }
export interface WVariant { id: string; name: string; durationMinutes: number; bufferBeforeMinutes: number | null; bufferAfterMinutes: number | null; sortOrder: number; active: boolean; prices: WVariantPrice[] }
export interface WService {
  id: string;
  locationId: string | null;
  name: string;
  description: string | null;
  category: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceMinor: number;
  depositMinor: number;
  currency: string;
  requiredResourceType: string | null;
  equipmentTypes: string[];
  cancellationPolicy: string | null;
  onlineBookable: boolean;
  practitionersRequired: number;
  depositRule: DepositRule | null;
  policy: Policy;
  rebookAfterWeeks: number | null;
  active: boolean;
  variants: WVariant[];
}
export interface WPractitioner { id: string; name: string; locationId: string; userId: string | null; serviceIds: string[]; active: boolean; locations: { locationId: string; home: boolean; availability: Window[] }[] }
export interface WResource { id: string; locationId: string; name: string; type: string; active: boolean }

export interface WAppointment {
  id: string;
  locationId: string;
  serviceId: string;
  variantId: string | null;
  practitionerId: string;
  resourceId: string | null;
  customerId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  price: WMoney;
  deposit: WMoney;
  voucherApplied: WMoney;
  clientPackageId: string | null;
  groupId: string | null;
  seriesId: string | null;
  source: string;
  checkedInAt: string | null;
  cancellationKind: string | null;
  paymentId: string | null;
}
export interface CalAppointment extends WAppointment {
  serviceName: string;
  variantName: string | null;
  practitionerName: string;
  clientName: string | null;
  clientVisible: boolean;
  roomId: string | null;
  roomName: string | null;
  equipment: { id: string; name: string | null }[];
  mine: boolean;
}
export interface Utilisation { bookedMinutes: number; availableMinutes: number; rate: number | null }
export interface CalendarDay {
  location: { id: string; name: string; timeZone: string; currency: string };
  date: string;
  practitioners: { id: string; name: string; kind: 'practitioner'; home: boolean; userId: string | null; windows: { start: string; end: string }[]; exceptions: { id: string; kind: string; startsAt: string; endsAt: string; reason: string | null }[]; utilisation: Utilisation }[];
  rooms: { id: string; name: string; kind: 'room' | 'equipment'; type: string; utilisation: Utilisation }[];
  appointments: CalAppointment[];
}

export interface MoveConflict { kind: string; message: string; with?: string }
export interface MoveResult { ok: boolean; conflicts: MoveConflict[]; error: { code: string; message: string } | null }

export interface CancellationPreview {
  window: 'free' | 'late' | 'no_show' | 'business';
  hoursBeforeStart: number;
  policy: Policy;
  policyText: string | null;
  price: WMoney;
  fee: WMoney;
  deposit: { paid: number; refund: number; retained: number; currency: string; paymentState: string | null };
  voucher: { applied: number; returned: number; retained: number; currency: string };
  packageSession: 'returned' | 'forfeited' | null;
  outstanding: WMoney;
}

export interface WException { id: string; practitionerId: string; practitionerName: string; locationId: string | null; startsAt: string; endsAt: string; kind: string; reason: string | null; affected: number }
export interface ImpactItem { appointment: WAppointment; serviceName: string; clientName: string; location: { id: string; name: string; timeZone: string }; alternatives: { id: string; name: string }[] }
export type RebookAction = { appointmentId: string; action: 'reassign'; practitionerId?: string } | { appointmentId: string; action: 'reschedule'; startsAt: string; practitionerId?: string } | { appointmentId: string; action: 'cancel'; notify?: boolean };
export interface RebookResult { results: { appointmentId: string; action: string; status: 'done' | 'failed'; newAppointmentId?: string; error?: { code: string; message: string } }[]; done: number; failed: number }

export interface ClientRow { id: string; name: string; email: string | null; phone: string | null; locationId: string | null; visits: number; nextAppointmentAt: string | null; lastVisitAt: string | null; activePackages: number }
export interface ClientPackage { id: string; planId: string; name: string | null; serviceId: string | null; customerId: string; locationId: string; sessionsTotal: number; sessionsUsed: number; sessionsRemaining: number; price: WMoney; purchasedAt: string | null; expiresAt: string | null; status: string; sharing: string; sharedWithCustomerIds: string[]; clientName?: string }
export interface Voucher { id: string; code: string; locationId: string | null; initial: WMoney; balance: WMoney; expiresAt: string; status: string; recipientName: string | null; recipientEmail: string | null; message: string | null; createdAt: string; transactions?: { id: string; kind: string; amount: WMoney; balanceAfter: WMoney; appointmentId: string | null; createdAt: string }[] }
export interface ClientNote { id: string; body: string; confidential: boolean; locationId: string; appointmentId: string | null; mine: boolean; createdAt: string }
export interface ClientProfile {
  client: { id: string; name: string; email: string | null; phone: string | null; locationId: string | null; createdAt: string };
  preferences: { preferredPractitionerIds: string[]; preferredLocationId: string | null; preferredChannel: 'email' | 'sms'; comfort: string[] } | null;
  appointments: (WAppointment & { serviceName: string; practitionerName: string; locationName: string; timeZone: string })[];
  packages: ClientPackage[];
  vouchersPurchased: Voucher[];
  notes: ClientNote[];
  charges: { appointmentId: string; kind: string; fee: WMoney; outstanding: WMoney; status: string }[];
  intake: { responses: number; restricted: true; canView: boolean; aiContext: 'excluded' };
  stats: { visits: number; noShows: number; lateCancellations: number };
}
export interface PackagePlan { id: string; locationId: string | null; name: string; description: string | null; serviceId: string; variantId: string | null; sessions: number; price: WMoney; perSession: WMoney; validityDays: number; sharing: string; maxSharedWith: number; onlinePurchasable: boolean; active: boolean; sold?: number }
export interface WaitlistEntry { id: string; locationId: string; serviceId: string; serviceName?: string; clientName?: string | null; windowStart: string; windowEnd: string; status: string; offeredStartsAt: string | null }

export interface UtilRow { id: string; name: string; locationId: string; locationName: string; bookedMinutes: number; availableMinutes: number; rate: number | null; type?: string }
export interface WReport {
  range: { from: string; to: string; timeZones: string[] };
  asOf: string;
  source: string;
  cancellations: { locationId: string; locationName: string; booked: number; completed: number; cancelled: number; freeCancellations: number; lateCancellations: number; businessCancellations: number; noShows: number; cancellationRate: number | null }[];
  revenue: { currency: string; appointmentValueMinor: number; packageSessionsUsed: number; depositsCollectedMinor: number; packagesSoldMinor: number; vouchersSoldMinor: number; feesRetainedMinor: number; feesOutstandingMinor: number; refundsMinor: number }[];
  revenueDefinition: string;
  combinedRevenue: null;
  utilisation: { definition: string; practitioners: UtilRow[]; rooms: UtilRow[] };
  packageLiability: { currency: string; packages: number; sessionsRemaining: number; valueMinor: number }[];
  voucherLiability: { currency: string; vouchers: number; balanceMinor: number }[];
  liabilityDefinition: string;
}
export interface Draft { id: string; kind: string; output: string; removedClaims: string[]; sources: string[]; status: string; createdAt: string; sample?: boolean }

export interface Slot { startsAt: string; endsAt: string; practitionerIds: string[] }
export interface BookInput {
  locationId: string;
  serviceId: string;
  variantId?: string;
  practitionerId?: string;
  startsAt: string;
  customerId?: string;
  contact?: { name: string; email: string; phone?: string };
  partner?: { name: string; email: string };
  voucherCode?: string;
  packageId?: string;
  outsideAvailability?: boolean;
}
export interface ServiceInput {
  locationId: string | null;
  name: string;
  description?: string;
  category?: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceMinor: number;
  currency?: string;
  requiredResourceType?: string;
  equipmentTypes: string[];
  onlineBookable: boolean;
  practitionersRequired: number;
  depositRule: DepositRule | null;
  policy: Policy;
  cancellationPolicy?: string;
  rebookAfterWeeks?: number | null;
}

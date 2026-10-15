/** Hospitality public data (GET /v1/public/hospitality/*). No mock fallback — API failures show the error page. */
import type { Money } from './types';

export interface Policy { name?: string; nonRefundable: boolean; freeUntilHours: number | null; lateFee: { type: string; percentBps?: number | null; amountMinor?: number | null }; noShowFee: { type: string; percentBps?: number | null } }
export interface PropertyCard {
  locationId: string; slug: string; name: string; kind: string; description: string | null; city: string; country: string; currency: string; timeZone: string;
  photos: Array<{ url: string; alt?: string | null }>; amenities: string[]; checkInTime: string; checkOutTime: string; today: string; onlinePayments: boolean;
}
export interface RoomTypeCard { id: string; code: string; name: string; kind: string; description: string | null; beds: Array<{ type: string; count: number }>; baseOccupancy: number; maxOccupancy: number; sizeSqm: number | null; amenities: string[]; photos: Array<{ url: string; alt?: string | null }> }
export interface PropertyPage {
  brand: { name: string; slug: string }; property: PropertyCard; houseRules: string | null; roomTypes: RoomTypeCard[];
  taxes: Array<{ name: string; kind: string; rateBps: number | null; amount: Money | null; inclusive: boolean; maxNights: number | null; appliesToChildren: boolean }>;
  outlet: { name: string | null } | null;
}
export interface RateChoice {
  ratePlanId: string; code: string; name: string; kind: string; includesBreakfast: boolean; inclusions: string[]; description: string | null; policy: Policy; depositRule: string;
  ok: boolean; reason?: string; message?: string; nights?: Array<{ date: string; amountMinor: number }>; taxes?: Array<{ name: string; amountMinor: number; inclusive: boolean }>;
  perUnit?: { room: number; taxAdded: number; total: number; deposit: number }; total?: Money; deposit?: Money;
}
export interface AvailabilityItem extends Omit<RoomTypeCard, "id"> { roomTypeId: string; available: number; unitsNeeded: number; bookable: boolean; rates: RateChoice[] }
export interface StayReservation {
  id: string; code: string; status: string; arrival: string; departure: string; nights: number; adults: number; children: number; guestName: string; guestEmail: string | null;
  total: Money; roomTotal: Money; taxAdded: Money; depositRequired: Money; depositPaid: Money; holdExpiresAt: string | null; cancellationPolicy: Policy; cancellationFee: Money | null;
}
export interface StayRoom { id: string; roomTypeName: string; ratePlanName: string; includesBreakfast: boolean; adults: number; nights: Array<{ date: string; amount: Money }>; taxes: Array<{ name: string; amount: Money; inclusive: boolean }>; total: Money; room: { number: string } | null }
export interface CancelQuote { fee: Money; free: boolean; freeUntil: string | null; reason: string; depositPaid: Money; refund: Money; outstanding: Money }
export interface ManageStayView {
  reservation: StayReservation; rooms: StayRoom[]; property: PropertyCard; houseRules: string | null;
  payment: { id: string; state: string; amount: Money; sandbox: boolean } | null; cancellation: CancelQuote | null;
  registrationFields: Array<{ key: string; label: string; kind: string; required: boolean }>; registration: Record<string, string>;
  balance: Money; canModify: boolean; canCancel: boolean;
}

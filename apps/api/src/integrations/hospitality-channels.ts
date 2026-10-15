/**
 * Channel-manager integration point (later phase). Adapters render BranchHarbor availability, restrictions and rates
 * into each provider's push shape and parse inbound reservation notifications. SANDBOX ONLY: nothing is sent; exports
 * are recorded so the business can preview them. Field names follow the providers' public ARI concepts and must be
 * confirmed against each provider's certification docs before going live. No claim of live sync is made anywhere.
 */

export type ChannelProvider = 'siteminder' | 'cloudbeds' | 'channex';

export interface AriDay {
  roomTypeCode: string;
  ratePlanCode: string;
  date: string;
  available: number;
  amountMinor: number | null;
  currency: string;
  minStay: number | null;
  maxStay: number | null;
  closed: boolean;
  closedToArrival: boolean;
  closedToDeparture: boolean;
}

export interface InboundReservation { externalId: string; roomTypeCode: string; ratePlanCode: string; arrival: string; departure: string; adults: number; children: number; guestName: string; guestEmail: string | null; totalMinor: number; currency: string; status: 'new' | 'modified' | 'cancelled' }

export interface ChannelAdapter {
  provider: ChannelProvider;
  name: string;
  mode: 'sandbox';
  /** Availability + restrictions + rates payload for one property. */
  buildAriPayload(propertyCode: string, days: AriDay[]): unknown;
  /** Map a provider reservation notification to our shape (validation only in sandbox). */
  parseReservation(payload: unknown): InboundReservation;
}

const major = (minor: number | null) => (minor === null ? null : Number((minor / 100).toFixed(2)));

const siteminder: ChannelAdapter = {
  provider: 'siteminder', name: 'SiteMinder', mode: 'sandbox',
  buildAriPayload: (hotelCode, days) => ({
    // OTA_HotelAvailNotifRQ / OTA_HotelRateAmountNotifRQ style (pmsXchange), simplified as JSON for preview.
    HotelCode: hotelCode,
    AvailStatusMessages: days.map((d) => ({
      StatusApplicationControl: { Start: d.date, End: d.date, InvTypeCode: d.roomTypeCode, RatePlanCode: d.ratePlanCode },
      BookingLimit: d.available,
      RestrictionStatus: { Status: d.closed ? 'Close' : 'Open', ClosedToArrival: d.closedToArrival, ClosedToDeparture: d.closedToDeparture },
      LengthsOfStay: [d.minStay ? { MinMaxMessageType: 'SetMinLOS', Time: d.minStay } : null, d.maxStay ? { MinMaxMessageType: 'SetMaxLOS', Time: d.maxStay } : null].filter(Boolean),
    })),
    RateAmountMessages: days.filter((d) => d.amountMinor !== null).map((d) => ({ InvTypeCode: d.roomTypeCode, RatePlanCode: d.ratePlanCode, Start: d.date, End: d.date, AmountAfterTax: major(d.amountMinor), CurrencyCode: d.currency })),
  }),
  parseReservation: (p) => parseGeneric(p),
};

const cloudbeds: ChannelAdapter = {
  provider: 'cloudbeds', name: 'Cloudbeds', mode: 'sandbox',
  buildAriPayload: (propertyID, days) => ({
    propertyID,
    rates: days.map((d) => ({ roomTypeID: d.roomTypeCode, ratePlanID: d.ratePlanCode, date: d.date, rate: major(d.amountMinor), currency: d.currency, minLos: d.minStay, maxLos: d.maxStay, closedToArrival: d.closedToArrival, closedToDeparture: d.closedToDeparture, closed: d.closed })),
    availability: days.map((d) => ({ roomTypeID: d.roomTypeCode, date: d.date, roomsAvailable: d.available })),
  }),
  parseReservation: (p) => parseGeneric(p),
};

const channex: ChannelAdapter = {
  provider: 'channex', name: 'Channex', mode: 'sandbox',
  buildAriPayload: (propertyId, days) => ({
    availability: { values: days.map((d) => ({ property_id: propertyId, room_type_id: d.roomTypeCode, date: d.date, availability: d.available })) },
    restrictions: {
      values: days.map((d) => ({
        property_id: propertyId, rate_plan_id: `${d.roomTypeCode}:${d.ratePlanCode}`, date: d.date, rate: d.amountMinor === null ? undefined : String(major(d.amountMinor)),
        min_stay_arrival: d.minStay ?? undefined, max_stay: d.maxStay ?? undefined, closed_to_arrival: d.closedToArrival, closed_to_departure: d.closedToDeparture, stop_sell: d.closed,
      })),
    },
  }),
  parseReservation: (p) => parseGeneric(p),
};

function parseGeneric(p: unknown): InboundReservation {
  const o = (p ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  const num = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : 0);
  if (!str('externalId') || !str('arrival') || !str('departure')) throw new Error('Reservation notification is missing externalId, arrival or departure');
  return {
    externalId: str('externalId'), roomTypeCode: str('roomTypeCode'), ratePlanCode: str('ratePlanCode'), arrival: str('arrival'), departure: str('departure'),
    adults: num('adults') || 1, children: num('children'), guestName: str('guestName') || 'Guest', guestEmail: str('guestEmail') || null, totalMinor: num('totalMinor'), currency: str('currency'),
    status: (['new', 'modified', 'cancelled'].includes(str('status')) ? str('status') : 'new') as InboundReservation['status'],
  };
}

export const CHANNEL_ADAPTERS: Record<ChannelProvider, ChannelAdapter> = { siteminder, cloudbeds, channex };
export const CHANNEL_PROVIDERS = Object.keys(CHANNEL_ADAPTERS) as ChannelProvider[];

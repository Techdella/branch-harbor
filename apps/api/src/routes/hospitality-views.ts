/** Shared serializers for hospitality staff and public routes. */
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { stayNights } from '@bh/shared';
import { hospBeds, hospRatePlans, hospRooms, hospRoomTypes } from '../db/schema/index.ts';
import { reservationRooms, type Reservation } from '../services/hospitality.ts';

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const m = (amount: number, currency: string) => ({ amount, currency });

export function reservationView(r: Reservation, opts: { contact: boolean }) {
  return {
    id: r.id, code: r.code, status: r.status, source: r.source, locationId: r.locationId, arrival: r.arrival, departure: r.departure, nights: stayNights(r.arrival, r.departure).length,
    adults: r.adults, children: r.children, groupName: r.groupName, guestName: r.guestName,
    guestEmail: opts.contact ? r.guestEmail : null, guestPhone: opts.contact ? r.guestPhone : null,
    arrivalTime: r.arrivalTime, specialRequests: r.specialRequests,
    roomTotal: m(r.roomTotalMinor, r.currency), taxAdded: m(r.taxAddedMinor, r.currency), total: m(r.totalMinor, r.currency),
    depositRequired: m(r.depositRequiredMinor, r.currency), depositPaid: m(r.depositPaidMinor, r.currency), paymentId: r.paymentId,
    holdExpiresAt: r.holdExpiresAt?.toISOString() ?? null, cancellationPolicy: r.cancellationPolicy,
    cancellationFee: r.cancellationFeeMinor === null ? null : m(r.cancellationFeeMinor, r.currency), cancelledAt: r.cancelledAt?.toISOString() ?? null, cancelReason: r.cancelReason,
    noShowAt: r.noShowAt?.toISOString() ?? null, checkedInAt: r.checkedInAt?.toISOString() ?? null, checkedOutAt: r.checkedOutAt?.toISOString() ?? null,
    messageConsent: r.messageConsent, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

export async function reservationRoomsView(db: Parameters<typeof reservationRooms>[0], r: Reservation) {
  const rooms = await reservationRooms(db, r.id);
  const typeIds = [...new Set(rooms.map((x) => x.roomTypeId))];
  const planIds = [...new Set(rooms.map((x) => x.ratePlanId))];
  const roomIds = rooms.map((x) => x.roomId).filter((x): x is string => !!x);
  const bedIds = rooms.map((x) => x.bedId).filter((x): x is string => !!x);
  const [types, plans, rms, beds] = await Promise.all([
    typeIds.length ? db.select().from(hospRoomTypes).where(inArray(hospRoomTypes.id, typeIds)) : [],
    planIds.length ? db.select().from(hospRatePlans).where(inArray(hospRatePlans.id, planIds)) : [],
    roomIds.length ? db.select().from(hospRooms).where(inArray(hospRooms.id, roomIds)) : [],
    bedIds.length ? db.select().from(hospBeds).where(inArray(hospBeds.id, bedIds)) : [],
  ]);
  return rooms.map((x) => {
    const t = types.find((y) => y.id === x.roomTypeId);
    const p = plans.find((y) => y.id === x.ratePlanId);
    const room = rms.find((y) => y.id === x.roomId);
    return {
      id: x.id, roomTypeId: x.roomTypeId, roomTypeName: t?.name ?? '', roomTypeKind: t?.kind ?? 'room', ratePlanId: x.ratePlanId, ratePlanName: p?.name ?? '', includesBreakfast: p?.includesBreakfast ?? false,
      adults: x.adults, children: x.children, nights: x.nights.map((n) => ({ date: n.date, amount: m(n.amountMinor, r.currency), source: n.source })), taxes: x.taxes.map((t2) => ({ ...t2, amount: m(t2.amountMinor, r.currency) })),
      roomTotal: m(x.roomTotalMinor, r.currency), taxAdded: m(x.taxAddedMinor, r.currency), total: m(x.totalMinor, r.currency),
      room: room ? { id: room.id, number: room.number, hkStatus: room.hkStatus } : null, bed: x.bedId ? { id: x.bedId, label: beds.find((b) => b.id === x.bedId)?.label ?? '' } : null,
    };
  });
}


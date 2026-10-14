import { describe, expect, it } from 'vitest';
import { computeCancellation, depositFor, reservationWindow, templatesOverlap, withinWindows } from '../src/services/wellness.ts';
import { screenHealthClaims } from '../src/services/wellness-ai.ts';
import { zonedToUtc } from '../src/lib/tz.ts';

const svc = (policy: any = null) => ({ policy, cancellationPolicy: 'Policy text' }) as any;
const appt = (over: Partial<any> = {}) => ({ priceMinor: 10000, currency: 'EUR', voucherAppliedMinor: 0, clientPackageId: null, startsAt: new Date('2026-11-02T10:00:00Z'), ...over }) as any;

describe('wellness policy (pure)', () => {
  it('derives deposits from the rule and never above the price', () => {
    expect(depositFor(null, 3000, 10000)).toBe(3000);
    expect(depositFor(null, 30000, 10000)).toBe(10000);
    expect(depositFor({ kind: 'percent', value: 25 }, 0, 9999)).toBe(2500);
    expect(depositFor({ kind: 'fixed', value: 5000 }, 0, 4000)).toBe(4000);
    expect(depositFor({ kind: 'none', value: 0 }, 3000, 10000)).toBe(0);
  });

  it('applies buffers around the service time', () => {
    const w = reservationWindow({ durationMinutes: 60, bufferBeforeMinutes: 10, bufferAfterMinutes: 15 }, new Date('2026-11-02T10:00:00Z'));
    expect(w.blockedFrom.toISOString()).toBe('2026-11-02T09:50:00.000Z');
    expect(w.blockedUntil.toISOString()).toBe('2026-11-02T11:15:00.000Z');
  });

  it('checks windows in local time across DST', () => {
    const win = [{ weekday: 0, start: '09:00', end: '12:00' }];
    // 2026-11-01 is the DST change in Toronto (Sunday)
    expect(withinWindows(win, 'America/Toronto', zonedToUtc('2026-11-01', '09:00', 'America/Toronto'), zonedToUtc('2026-11-01', '10:00', 'America/Toronto'))).toBe(true);
    expect(withinWindows(win, 'America/Toronto', zonedToUtc('2026-11-01', '11:30', 'America/Toronto'), zonedToUtc('2026-11-01', '12:30', 'America/Toronto'))).toBe(false);
  });

  it('finds overlapping weekly templates (multi-location schedules)', () => {
    expect(templatesOverlap([{ weekday: 1, start: '09:00', end: '13:00' }], [{ weekday: 1, start: '12:00', end: '18:00' }])).toHaveLength(1);
    expect(templatesOverlap([{ weekday: 1, start: '09:00', end: '13:00' }], [{ weekday: 1, start: '13:00', end: '18:00' }])).toHaveLength(0);
    expect(templatesOverlap([{ weekday: 1, start: '09:00', end: '13:00' }], [{ weekday: 2, start: '09:00', end: '13:00' }])).toHaveLength(0);
  });

  it('cancellation: free window refunds; late fee comes from deposit then voucher; packages forfeit instead of a fee', () => {
    const now = new Date('2026-11-02T05:00:00Z'); // 5 h before
    const policy = { freeCancelHours: 24, lateCancelFeePercent: 50, noShowFeePercent: 100, depositRefundable: true };
    const free = computeCancellation({ members: [appt()], svc: svc(policy), depositPaidMinor: 2000, paymentState: 'succeeded', now: new Date('2026-10-30T10:00:00Z'), mode: 'auto' });
    expect(free).toMatchObject({ window: 'free', fee: { amount: 0 }, deposit: { refund: 2000, retained: 0 } });
    const late = computeCancellation({ members: [appt({ voucherAppliedMinor: 4000 })], svc: svc(policy), depositPaidMinor: 2000, paymentState: 'succeeded', now, mode: 'auto' });
    expect(late).toMatchObject({ window: 'late', fee: { amount: 5000, currency: 'EUR' }, deposit: { retained: 2000, refund: 0 }, voucher: { retained: 3000, returned: 1000 }, outstanding: { amount: 0 } });
    const pkg = computeCancellation({ members: [appt({ clientPackageId: 'x' })], svc: svc(policy), depositPaidMinor: 0, paymentState: null, now, mode: 'auto' });
    expect(pkg).toMatchObject({ window: 'late', fee: { amount: 0 }, packageSession: 'forfeited' });
    const biz = computeCancellation({ members: [appt()], svc: svc(policy), depositPaidMinor: 2000, paymentState: 'succeeded', now, mode: 'business' });
    expect(biz).toMatchObject({ window: 'business', deposit: { refund: 2000 } });
    const nonRefundable = computeCancellation({ members: [appt()], svc: svc({ ...policy, depositRefundable: false }), depositPaidMinor: 2000, paymentState: 'succeeded', now: new Date('2026-10-30T10:00:00Z'), mode: 'auto' });
    expect(nonRefundable.deposit).toMatchObject({ refund: 0, retained: 2000 });
  });

  it('screens health claims out of AI copy', () => {
    const r = screenHealthClaims('Sixty quiet minutes in a warm room. Our detox wrap heals the body! Book online.');
    expect(r.text).toBe('Sixty quiet minutes in a warm room. Book online.');
    expect(r.removed).toHaveLength(1);
  });
});

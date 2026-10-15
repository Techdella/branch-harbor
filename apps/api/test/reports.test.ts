import { describe, expect, it } from 'vitest';
import { metric, revenueByCurrency } from '../src/domain/reports.ts';
import { approvalTitleOf } from '../src/services/approvals.ts';

describe('revenue by currency', () => {
  const rows = [
    { amountMinor: 2800, currency: 'CAD', state: 'succeeded', refundedMinor: 0 },
    { amountMinor: 2400, currency: 'CAD', state: 'succeeded', refundedMinor: 400 },
    { amountMinor: 3000, currency: 'USD', state: 'succeeded', refundedMinor: 0 },
    { amountMinor: 2500, currency: 'GBP', state: 'succeeded', refundedMinor: 2500 },
    { amountMinor: 9999, currency: 'USD', state: 'failed', refundedMinor: 0 },
    { amountMinor: 1500, currency: 'JPY', state: 'succeeded', refundedMinor: 0 },
  ];

  it('never combines currencies and excludes unsuccessful payments', () => {
    const r = revenueByCurrency(rows);
    expect(r.map((x) => x.currency)).toEqual(['CAD', 'GBP', 'JPY', 'USD']);
    expect(r.find((x) => x.currency === 'CAD')).toMatchObject({ grossMinor: 5200, refundedMinor: 400, netMinor: 4800, paymentCount: 2 });
    expect(r.find((x) => x.currency === 'USD')).toMatchObject({ grossMinor: 3000, netMinor: 3000, paymentCount: 1 });
    expect(r.find((x) => x.currency === 'GBP')).toMatchObject({ grossMinor: 2500, netMinor: 0 });
    expect(r.find((x) => x.currency === 'JPY')?.grossMinor).toBe(1500);
  });

  it('keeps integer minor units', () => {
    for (const x of revenueByCurrency(rows)) expect(Number.isInteger(x.netMinor)).toBe(true);
  });

  it('reports unavailable data as null, not zero', () => {
    const m = metric<number>(null, 'Bookings', { asOf: new Date().toISOString(), source: 'x', lastSyncAt: null, complete: false }, 'Provider disconnected');
    expect(m.value).toBeNull();
    expect(m.unavailableReason).toBe('Provider disconnected');
    expect(metric(0, 'Leads', { asOf: '', source: 'x', lastSyncAt: null, complete: true }).value).toBe(0);
  });

  it('returns a stable reason code with arguments next to the English reason', () => {
    const f = { asOf: '', source: 'Mindbody', sourceCode: 'provider', lastSyncAt: null, complete: false };
    const m = metric<number>(null, 'Bookings', f, 'Mindbody is degraded', { code: 'booking_sync', params: { provider: 'Mindbody', state: 'degraded' } });
    expect(m).toMatchObject({ unavailableReason: 'Mindbody is degraded', unavailableCode: 'booking_sync', unavailableParams: { provider: 'Mindbody', state: 'degraded' } });
    expect(metric<number>(null, 'x', f).unavailableCode).toBe('unavailable');
    expect(metric(3, 'x', f)).toMatchObject({ unavailableCode: null, unavailableParams: null });
  });
});

describe('structured approval titles', () => {
  it('uses the stored code, derives website changes, and leaves titles typed by people alone', () => {
    expect(approvalTitleOf({ title: 'Refund for payment 1234 · CAD 10.00', targetType: 'refund', payload: { titleI18n: { code: 'refund_payment', params: { ref: '1234' } } } })).toEqual({ code: 'refund_payment', params: { ref: '1234' } });
    expect(approvalTitleOf({ title: null, targetType: 'field', payload: { fieldKey: 'hero_headline' } })).toEqual({ code: 'website_change', params: { fieldKey: 'hero_headline' } });
    expect(approvalTitleOf({ title: null, targetType: 'page', payload: {} })).toEqual({ code: 'page_submitted', params: {} });
    expect(approvalTitleOf({ title: 'Spring local ads', targetType: 'ad_spend', payload: { channel: 'meta_ads' } })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASIS, ageingBucket, applyBps, computeStatement, formatInvoiceNumber, invoiceLinesFromStatement, invoiceTaxes, isPeriodStart, lateFeeFor, periodBoundsUtc,
  periodContaining, streamOf, tieredRoyalty, type RoyaltyTerms,
} from '../src/domain/royalty.ts';

const terms = (over: Partial<RoyaltyTerms> = {}): RoyaltyTerms => ({
  source: 'organization', sourceId: null, currency: 'CAD', royaltyBps: 600, tiers: [], tierMode: 'marginal', minimumRoyaltyMinor: 0, marketingFundBps: 200,
  technologyFeeMinor: 14_900, basis: DEFAULT_BASIS, lateFee: { kind: 'none', graceDays: 0 }, effectiveFrom: '2026-01-01', effectiveTo: null, ...over,
});

describe('royalty engine', () => {
  it('computes royalty, fund and technology fee on net sales (refunds and tax out, tips out)', () => {
    const r = computeStatement(terms(), {
      currency: 'CAD',
      streams: { bookings: { grossMinor: 1_000_000, refundsMinor: 31_200, taxMinor: 0, tipsMinor: 0 }, food: { grossMinor: 113_000, refundsMinor: 0, taxMinor: 13_000, tipsMinor: 5_000 } },
    });
    expect(r.grossSalesMinor).toBe(1_113_000);
    expect(r.basisMinor).toBe(1_113_000 - 31_200 - 13_000 - 5_000);
    expect(r.royaltyMinor).toBe(applyBps(r.basisMinor, 600));
    expect(r.marketingFundMinor).toBe(applyBps(r.basisMinor, 200));
    expect(r.technologyFeeMinor).toBe(14_900);
    expect(r.totalMinor).toBe(r.royaltyMinor + r.marketingFundMinor + 14_900);
    expect(r.lines.filter((l) => l.charge).map((l) => l.kind)).toEqual(['royalty', 'marketing_fund', 'technology_fee']);
  });

  it('follows the configured revenue basis: excluded streams, gross of refunds, tax included', () => {
    const sales = { currency: 'CAD', streams: { bookings: { grossMinor: 100_000, refundsMinor: 10_000, taxMinor: 5_000, tipsMinor: 0 }, gift_vouchers: { grossMinor: 50_000, refundsMinor: 0, taxMinor: 0, tipsMinor: 0 } } };
    const def = computeStatement(terms(), sales);
    expect(def.basisMinor).toBe(100_000 - 10_000 - 5_000); // gift vouchers excluded by default
    expect(def.lines.find((l) => l.description === 'excluded:gift_vouchers')?.charge).toBe(false);
    const gross = computeStatement(terms({ basis: { streams: ['bookings', 'gift_vouchers'], netOfRefunds: false, excludeTax: false, excludeTips: false, includeExternalSales: true } }), sales);
    expect(gross.basisMinor).toBe(150_000);
  });

  it('adds accepted external sales and never lets the basis go negative', () => {
    const r = computeStatement(terms({ technologyFeeMinor: 0 }), { currency: 'CAD', streams: {}, external: { grossMinor: 200_000, refundsMinor: 20_000, taxMinor: 26_000 } });
    expect(r.externalSalesMinor).toBe(154_000);
    expect(r.basisMinor).toBe(154_000);
    const neg = computeStatement(terms({ technologyFeeMinor: 0 }), { currency: 'CAD', streams: { bookings: { grossMinor: 1_000, refundsMinor: 5_000, taxMinor: 0, tipsMinor: 0 } } });
    expect(neg.basisMinor).toBe(0);
    expect(neg.totalMinor).toBe(0);
  });

  it('applies marginal and whole-basis tiers', () => {
    const tiers = [{ fromMinor: 0, bps: 600 }, { fromMinor: 1_000_000, bps: 500 }, { fromMinor: 2_000_000, bps: 400 }];
    const m = tieredRoyalty(2_500_000, { royaltyBps: 600, tiers, tierMode: 'marginal' });
    expect(m.amountMinor).toBe(60_000 + 50_000 + 20_000);
    expect(m.slices.map((s) => s.basisMinor)).toEqual([1_000_000, 1_000_000, 500_000]);
    const w = tieredRoyalty(2_500_000, { royaltyBps: 600, tiers, tierMode: 'whole' });
    expect(w.amountMinor).toBe(100_000);
    expect(tieredRoyalty(999_999, { royaltyBps: 600, tiers, tierMode: 'whole' }).amountMinor).toBe(60_000);
    // A first tier above zero starts with the flat rate below it.
    expect(tieredRoyalty(1_500_000, { royaltyBps: 700, tiers: [{ fromMinor: 1_000_000, bps: 500 }], tierMode: 'marginal' }).amountMinor).toBe(70_000 + 25_000);
  });

  it('tops up to the minimum royalty with its own line', () => {
    const r = computeStatement(terms({ minimumRoyaltyMinor: 50_000, technologyFeeMinor: 0, marketingFundBps: 0 }), { currency: 'CAD', streams: { bookings: { grossMinor: 300_000, refundsMinor: 0, taxMinor: 0, tipsMinor: 0 } } });
    expect(r.royaltyMinor).toBe(50_000);
    expect(r.lines.find((l) => l.kind === 'royalty')?.amountMinor).toBe(18_000);
    expect(r.lines.find((l) => l.kind === 'royalty_minimum')?.amountMinor).toBe(32_000);
    expect(r.totalMinor).toBe(50_000);
  });

  it('includes manual adjustments in the total', () => {
    const r = computeStatement(terms({ technologyFeeMinor: 0, marketingFundBps: 0 }), { currency: 'CAD', streams: { bookings: { grossMinor: 100_000, refundsMinor: 0, taxMinor: 0, tipsMinor: 0 } } }, [-1_000, 250]);
    expect(r.adjustmentsMinor).toBe(-750);
    expect(r.totalMinor).toBe(6_000 - 750);
  });

  it('refuses to mix currencies', () => {
    expect(() => computeStatement(terms({ currency: 'USD' }), { currency: 'CAD', streams: {} })).toThrow(/USD/);
  });

  it('maps payment targets to revenue streams and never counts royalty invoices as sales', () => {
    expect(streamOf('class_booking')).toBe('bookings');
    expect(streamOf('food_order')).toBe('food');
    expect(streamOf('wellness_voucher')).toBe('gift_vouchers');
    expect(streamOf('something_new')).toBe('other');
    expect(streamOf('royalty_invoice')).toBeNull();
  });
});

describe('periods and time zones', () => {
  it('builds monthly and weekly periods', () => {
    expect(periodContaining('monthly', '2026-12-15')).toEqual({ startDate: '2026-12-01', endDate: '2027-01-01' });
    expect(periodContaining('weekly', '2026-10-15', 1)).toEqual({ startDate: '2026-10-12', endDate: '2026-10-19' }); // Thu → Mon
    expect(periodContaining('weekly', '2026-10-15', 7)).toEqual({ startDate: '2026-10-11', endDate: '2026-10-18' }); // Sunday weeks
    expect(isPeriodStart('monthly', '2026-09-01')).toBe(true);
    expect(isPeriodStart('monthly', '2026-09-02')).toBe(false);
    expect(isPeriodStart('weekly', '2026-10-12', 1)).toBe(true);
  });

  it('puts period boundaries at local midnight of each location, across DST', () => {
    const tor = periodBoundsUtc('2026-10-01', '2026-11-01', 'America/Toronto');
    expect(tor.startAt.toISOString()).toBe('2026-10-01T04:00:00.000Z'); // EDT
    expect(tor.endAt.toISOString()).toBe('2026-11-01T04:00:00.000Z'); // still EDT at midnight on 1 Nov (DST ends at 2am)
    const van = periodBoundsUtc('2026-10-01', '2026-11-01', 'America/Vancouver');
    expect(van.startAt.toISOString()).toBe('2026-10-01T07:00:00.000Z');
    const lon = periodBoundsUtc('2026-10-01', '2026-11-01', 'Europe/London');
    expect(lon.startAt.toISOString()).toBe('2026-09-30T23:00:00.000Z'); // BST
    expect(lon.endAt.toISOString()).toBe('2026-11-01T00:00:00.000Z'); // GMT
    const syd = periodBoundsUtc('2026-10-01', '2026-11-01', 'Australia/Sydney');
    expect(syd.startAt.toISOString()).toBe('2026-09-30T14:00:00.000Z'); // AEST
    expect(syd.endAt.toISOString()).toBe('2026-10-31T13:00:00.000Z'); // AEDT
  });
});

describe('invoices, late fees and ageing', () => {
  it('only applies tax lines HQ configured, per country and line kind', () => {
    const lines = invoiceLinesFromStatement({ royaltyMinor: 60_000, marketingFundMinor: 20_000, technologyFeeMinor: 14_900, adjustmentsMinor: 0 });
    expect(invoiceTaxes(lines, [], 'CA')).toEqual([]);
    const taxes = invoiceTaxes(lines, [{ name: 'GST', rateBps: 500, country: 'CA', appliesTo: ['royalty', 'technology_fee'] }, { name: 'VAT', rateBps: 2000, country: 'GB', appliesTo: ['royalty'] }], 'CA');
    expect(taxes).toEqual([{ name: 'GST', rateBps: 500, baseMinor: 74_900, amountMinor: 3_745 }]);
  });

  it('charges late fees after the grace period only', () => {
    expect(lateFeeFor({ kind: 'flat', flatMinor: 5_000, graceDays: 5 }, 100_000, 5)).toBe(0);
    expect(lateFeeFor({ kind: 'flat', flatMinor: 5_000, graceDays: 5 }, 100_000, 6)).toBe(5_000);
    expect(lateFeeFor({ kind: 'percent', bps: 150, graceDays: 0 }, 100_000, 1)).toBe(1_500);
    expect(lateFeeFor({ kind: 'none', graceDays: 0 }, 100_000, 90)).toBe(0);
  });

  it('buckets arrears by days past due', () => {
    expect(ageingBucket('2026-10-15', '2026-10-15')).toBe('current');
    expect(ageingBucket('2026-10-01', '2026-10-15')).toBe('d1_30');
    expect(ageingBucket('2026-08-20', '2026-10-15')).toBe('d31_60');
    expect(ageingBucket('2026-07-20', '2026-10-15')).toBe('d61_90');
    expect(ageingBucket('2026-01-01', '2026-10-15')).toBe('d90_plus');
  });

  it('formats invoice numbers with the organisation prefix', () => {
    expect(formatInvoiceNumber('NL', 42)).toBe('NL-000042');
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCapabilities, permissionsFromCapabilities } from './access.ts';
import {
  applyReceipt, catalogueItemBodySchema, computeRebate, fundShareOf, moqViolations, poNeedsApproval, rebatePeriodOf, rebateProgrammeBodySchema, supplierCovers, supplierScorecard, type PoLine,
} from './supply.ts';
import {
  SELF_CHECK_STARTERS, addMonthsClamped, auditScheduleBodySchema, haversineKm, nearestNeighbourRoute, questionTraining, routeKm, scheduleDueDates, selfCheckDueOn, selfCheckStartersFor, targetIncludes,
} from './audit-programmes.ts';
import { auditTemplateBodySchema, scoreAudit } from './quality.ts';

const line = (o: Partial<PoLine> & { itemId: string; quantity: number }): PoLine => ({
  sku: 'SKU', name: 'Item', packLabel: '', unitsPerPack: 1, confirmedQuantity: null, received: 0, damaged: 0, unitPriceMinor: 100, totalMinor: 100 * o.quantity, variantId: null, ingredientId: null, ...o,
});
const I1 = '6f1c6a2e-1b1f-4b6e-9a39-0c4a3e0f1d11';
const I2 = '6f1c6a2e-1b1f-4b6e-9a39-0c4a3e0f1d12';

test('suppliers cover a location by country or region, everywhere when neither is set', () => {
  assert.equal(supplierCovers({ countries: [], regionIds: [] }, { country: 'GB', regionId: null }), true);
  assert.equal(supplierCovers({ countries: ['CA', 'US'], regionIds: [] }, { country: 'GB', regionId: null }), false);
  assert.equal(supplierCovers({ countries: ['CA'], regionIds: [] }, { country: 'CA', regionId: null }), true);
  assert.equal(supplierCovers({ countries: [], regionIds: ['r1'] }, { country: 'PT', regionId: 'r1' }), true);
});

test('catalogue items need a price and link a product or an ingredient, never both', () => {
  assert.equal(catalogueItemBodySchema.safeParse({ sku: 'A', name: 'Oat milk', prices: {} }).success, false);
  const ok = catalogueItemBodySchema.parse({ sku: 'A', name: 'Oat milk', prices: { USD: 2400, CAD: 3100 }, unitsPerPack: 12 });
  assert.equal(ok.moq, 1);
  assert.equal(catalogueItemBodySchema.safeParse({ sku: 'A', name: 'x', prices: { USD: 1 }, variantId: I1, ingredientId: I2 }).success, false);
});

test('HQ approval above the threshold for the order currency only', () => {
  const th = { USD: 50_000, EUR: 40_000 };
  assert.equal(poNeedsApproval(50_000, 'USD', th), false);
  assert.equal(poNeedsApproval(50_001, 'USD', th), true);
  assert.equal(poNeedsApproval(9_999_999, 'GBP', th), false);
  assert.deepEqual(moqViolations([{ itemId: I1, quantity: 2 }, { itemId: I2, quantity: 5 }], new Map([[I1, { moq: 3 }], [I2, { moq: 1 }]])), [I1]);
});

test('receiving: partial deliveries, damage and shortfalls', () => {
  const lines = [line({ itemId: I1, quantity: 10 }), line({ itemId: I2, quantity: 4 })];
  const first = applyReceipt(lines, { lines: [{ itemId: I1, received: 6, damaged: 1, issue: null, note: '' }], note: '', closeShort: false });
  assert.equal(first.complete, false);
  assert.equal(first.goodPacks, 6);
  assert.equal(first.lines[0]!.received, 6);
  assert.equal(first.lines[0]!.damaged, 1);
  assert.equal(first.results[0]!.issue, 'damaged');
  assert.equal(first.results[0]!.outstandingAfter, 4);
  const second = applyReceipt(first.lines, { lines: [{ itemId: I1, received: 4, damaged: 0, issue: null, note: '' }, { itemId: I2, received: 4, damaged: 0, issue: null, note: '' }], note: '', closeShort: false });
  assert.equal(second.complete, true);
  assert.equal(second.issues, 0);
  const short = applyReceipt(lines, { lines: [{ itemId: I1, received: 10, damaged: 0, issue: null, note: '' }], note: '', closeShort: true });
  assert.equal(short.complete, false);
  assert.equal(short.issues, 1, 'the missing line counts as an issue when closed short');
});

test('rebates: the reached tier applies to the whole period volume', () => {
  const p = { basis: 'percent' as const, measure: 'spend' as const, tiers: [{ from: 0, rate: 100 }, { from: 1_000_000, rate: 250 }, { from: 5_000_000, rate: 400 }] };
  assert.deepEqual(computeRebate(p, { spendMinor: 400_000, units: 0 }), { tierIndex: 0, rate: 100, volume: 400_000, accruedMinor: 4_000, next: { from: 1_000_000, rate: 250, remaining: 600_000 } });
  assert.equal(computeRebate(p, { spendMinor: 2_000_000, units: 0 }).accruedMinor, 50_000);
  assert.equal(computeRebate(p, { spendMinor: 6_000_000, units: 0 }).next, null);
  const perUnit = { basis: 'per_unit' as const, measure: 'units' as const, tiers: [{ from: 100, rate: 50 }] };
  assert.equal(computeRebate(perUnit, { spendMinor: 0, units: 99 }).accruedMinor, 0);
  assert.equal(computeRebate(perUnit, { spendMinor: 0, units: 120 }).accruedMinor, 6_000);
  assert.deepEqual(rebatePeriodOf('quarter', '2026-08-14'), { start: '2026-07-01', end: '2026-09-30', label: '2026-Q3' });
  assert.deepEqual(rebatePeriodOf('month', '2028-02-03'), { start: '2028-02-01', end: '2028-02-29', label: '2028-02' });
  assert.equal(fundShareOf(10_001, 25), 2_500);
  assert.equal(rebateProgrammeBodySchema.safeParse({ supplierId: I1, name: 'x', basis: 'percent', currency: 'USD', tiers: [{ from: 10, rate: 1 }, { from: 5, rate: 2 }], startsOn: '2026-01-01' }).success, false);
});

test('supplier scorecard: on-time delivery, fill rate and issues', () => {
  const sc = supplierScorecard({
    orders: [
      { status: 'received', expectedOn: '2026-05-10', firstDeliveryOn: '2026-05-09', orderedPacks: 10, receivedPacks: 10, closed: true },
      { status: 'received', expectedOn: '2026-05-10', firstDeliveryOn: '2026-05-12', orderedPacks: 10, receivedPacks: 8, closed: true },
      { status: 'sent', expectedOn: '2026-06-01', firstDeliveryOn: null, orderedPacks: 5, receivedPacks: 0, closed: false },
      { status: 'cancelled', expectedOn: null, firstDeliveryOn: null, orderedPacks: 5, receivedPacks: 0, closed: false },
    ],
    issues: 1,
  });
  assert.equal(sc.orders, 3);
  assert.equal(sc.delivered, 2);
  assert.equal(sc.onTimePct, 50);
  assert.equal(sc.fillRatePct, 90);
  assert.equal(sc.score, 0.4 * 50 + 0.4 * 90 + 0.2 * 50);
  assert.equal(supplierScorecard({ orders: [], issues: 0 }).score, null);
});

test('supplier access: franchise owners order and receive, only HQ manages suppliers and sees rebates', () => {
  const fo = effectiveCapabilities({ role: 'franchise_owner', scopeKind: 'owner_group' }, 'foods');
  assert.ok(fo.has('operations.suppliers:edit') && !fo.has('operations.suppliers:publish'));
  assert.ok(!fo.has('finance.supplier_rebates:view'), 'HQ-only');
  assert.ok(fo.has('operations.self_checks:publish'));
  const staff = effectiveCapabilities({ role: 'staff', scopeKind: 'location' }, 'foods');
  assert.ok(staff.has('operations.self_checks:edit'), 'staff run self-checks through operations.*');
  assert.ok(!staff.has('operations.suppliers:view'), 'suppliers are granted by name only');
  const ops = effectiveCapabilities({ role: 'operations_lead', scopeKind: 'organization' }, 'foods');
  assert.ok(ops.has('operations.suppliers:publish') && !ops.has('finance.supplier_rebates:view'), 'operations: no finance');
  assert.ok(effectiveCapabilities({ role: 'finance_lead', scopeKind: 'organization' }, 'foods').has('finance.supplier_rebates:edit'));
  const fc = effectiveCapabilities({ role: 'field_consultant', scopeKind: 'portfolio' }, 'foods');
  assert.ok(fc.has('operations.audits:edit') && fc.has('operations.self_checks:view') && !fc.has('operations.suppliers:edit'));
  // A rebate grant on a location assignment is dropped (HQ-only module).
  assert.ok(!effectiveCapabilities({ role: 'custom', scopeKind: 'location', customCapabilities: ['finance.supplier_rebates:view'] }, 'foods').size);
  // Suppliers never add legacy Operations permissions.
  assert.ok(!permissionsFromCapabilities(new Set(['operations.suppliers:edit'])).has('operations.write'));
});

test('recurring audit schedules: months clamp to the last day, weeks step evenly', () => {
  assert.equal(addMonthsClamped('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsClamped('2028-01-31', 1), '2028-02-29');
  const monthly = { frequency: 'monthly' as const, interval: 1, anchorDate: '2026-01-31' };
  assert.deepEqual(scheduleDueDates(monthly, '2026-02-01', '2026-05-31'), ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  assert.deepEqual(scheduleDueDates({ frequency: 'quarterly', interval: 1, anchorDate: '2026-01-15' }, '2026-01-01', '2026-12-31'), ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
  assert.deepEqual(scheduleDueDates({ frequency: 'weekly', interval: 2, anchorDate: '2026-10-05' }, '2026-10-01', '2026-11-01'), ['2026-10-05', '2026-10-19']);
  assert.deepEqual(scheduleDueDates(monthly, '2025-01-01', '2025-12-31'), [], 'nothing before the anchor');
  assert.equal(auditScheduleBodySchema.safeParse({ name: 'Monthly', templateId: I1, target: { kind: 'region', ids: [] }, frequency: 'monthly', anchorDate: '2026-01-01' }).success, false);
  assert.equal(targetIncludes({ kind: 'owner_group', ids: ['g'] }, { id: 'l', regionId: null, ownerGroupId: 'g' }), true);
  assert.equal(targetIncludes({ kind: 'locations', ids: ['x'] }, { id: 'l', regionId: null, ownerGroupId: 'g' }), false);
});

test('self-checks: weekdays, starters per industry, and the starters are valid checklists', () => {
  assert.equal(selfCheckDueOn({ weekdays: [1, 2, 3, 4, 5] }, '2026-10-17'), false); // Saturday
  assert.equal(selfCheckDueOn({ weekdays: [1, 2, 3, 4, 5] }, '2026-10-16'), true);
  assert.deepEqual(selfCheckStartersFor('studios').map((s) => s.key), ['opening_check', 'closing_check']);
  assert.ok(selfCheckStartersFor('foods').some((s) => s.key === 'temperature_log'));
  for (const s of SELF_CHECK_STARTERS) assert.ok(auditTemplateBodySchema.safeParse(s).success, s.key);
  const log = SELF_CHECK_STARTERS.find((s) => s.key === 'temperature_log')!;
  const answers = { fridge_1: { value: 3 }, fridge_2: { value: 7 }, freezer: { value: -20 }, hot_hold: { value: 70 }, probe_cleaned: { value: 'yes' as const }, dates_checked: { value: 'yes' as const } };
  const score = scoreAudit(log, answers);
  assert.equal(score.criticalFailed, true, 'a warm fridge fails the log');
});

test('visit planner: nearest-neighbour route by straight-line distance', () => {
  const toronto = { lat: 43.6532, lng: -79.3832 };
  const stops = [
    { id: 'ottawa', geo: { lat: 45.4215, lng: -75.6972 } },
    { id: 'hamilton', geo: { lat: 43.2557, lng: -79.8711 } },
    { id: 'nowhere', geo: null },
    { id: 'mississauga', geo: { lat: 43.589, lng: -79.6441 } },
  ];
  const route = nearestNeighbourRoute(stops, toronto);
  assert.deepEqual(route.map((s) => s.id), ['mississauga', 'hamilton', 'ottawa', 'nowhere']);
  assert.ok(route[0]!.legKm! > 20 && route[0]!.legKm! < 25);
  assert.equal(route[3]!.legKm, null);
  assert.ok(routeKm(route) > 450 && routeKm(route) < 550);
  assert.equal(haversineKm(toronto, toronto), 0);
});

test('a failed item can recommend a training course', () => {
  const body = auditTemplateBodySchema.parse({ name: 'x', sections: [{ id: 's', title: 'S', questions: [{ id: 'q', text: 'Q', type: 'yes_no', trainingCourseId: I1, trainingAutoAssign: true }] }] });
  assert.deepEqual(questionTraining(body.sections, 'q'), { courseId: I1, autoAssign: true });
  assert.equal(questionTraining(body.sections, 'other'), null);
});

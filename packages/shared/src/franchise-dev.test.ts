import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  areaKm2, centroidOf, deriveTerritoryStatus, findOverlaps, geometriesOverlap, npsOf, parsePostcodeList, pickValidators, renderNotice, renewalPhase, renewalWindow, scheduleProgress,
  scoreTerritory, sliceVisible, splitAmounts, ruleFor, surveyBodySchema, STARTER_SURVEY, territoryGeometrySchema, validateSurveyAnswers, nextRoundDate, type TerritoryGeometry,
} from './franchise-dev.ts';
import { effectiveCapabilities, templateCapabilities } from './access.ts';

const square = (x: number, y: number, s: number): TerritoryGeometry => ({ type: 'Polygon', coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] });

test('geometry: rings close automatically, area and centroid are sensible', () => {
  const g = territoryGeometrySchema.parse({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] });
  assert.equal(g.coordinates[0]!.length, 5);
  // 1° x 1° at the equator is about 111 km x 111 km.
  assert.ok(Math.abs(areaKm2(square(0, 0, 1)) - 12_392) < 50);
  assert.deepEqual(centroidOf(square(10, 20, 2)), { lng: 11, lat: 21 });
  assert.throws(() => territoryGeometrySchema.parse({ type: 'Polygon', coordinates: [[[0, 0], [1, 0]]] }));
  assert.throws(() => territoryGeometrySchema.parse({ type: 'Polygon', coordinates: [[[0, 0], [200, 0], [1, 1]]] }));
});

test('overlap detection: crossing, containment and touching neighbours', () => {
  assert.equal(geometriesOverlap(square(0, 0, 2), square(1, 1, 2)), true);
  assert.equal(geometriesOverlap(square(0, 0, 4), square(1, 1, 1)), true);
  assert.equal(geometriesOverlap(square(0, 0, 1), square(1, 0, 1)), false, 'touching edges');
  assert.equal(geometriesOverlap(square(0, 0, 1), square(3, 3, 1)), false);
});

test('exclusivity: overlap with a taken exclusive territory is a conflict, non-exclusive never is', () => {
  const t = { id: 'a', name: 'A', status: 'available', exclusivity: 'exclusive' as const, geometry: square(0, 0, 2), postcodes: ['78701'] };
  const sold = { id: 'b', name: 'B', status: 'sold', exclusivity: 'exclusive' as const, geometry: square(1, 1, 2), postcodes: [] };
  const zip = { id: 'c', name: 'C', status: 'available', exclusivity: 'exclusive' as const, geometry: null, postcodes: ['78 701', '78702'] };
  const open = { id: 'd', name: 'D', status: 'open', exclusivity: 'non_exclusive' as const, geometry: square(0.5, 0.5, 0.5), postcodes: [] };
  const o = findOverlaps(t, [t, sold, zip, open]);
  assert.deepEqual(o.map((x) => [x.id, x.by, x.conflict]), [['b', ['area'], true], ['c', ['postcodes'], false], ['d', ['area'], false]]);
  assert.deepEqual(o[1]!.sharedPostcodes, ['78701']);
  assert.deepEqual(parsePostcodeList('78701, 78702\n m5v 1a1;x'), ['78701', '78702', 'M5V1A1']);
});

test('territory status follows the pipeline and agreements', () => {
  assert.equal(deriveTerritoryStatus('available', { openLocation: false, activeProject: false, activeAgreement: false, activeProspect: true }), 'reserved');
  assert.equal(deriveTerritoryStatus('reserved', { openLocation: false, activeProject: true, activeAgreement: true, activeProspect: false }), 'under_development');
  assert.equal(deriveTerritoryStatus('sold', { openLocation: true, activeProject: false, activeAgreement: true, activeProspect: false }), 'open');
  assert.equal(deriveTerritoryStatus('reserved', { openLocation: false, activeProject: false, activeAgreement: false, activeProspect: false }), 'available');
  assert.equal(deriveTerritoryStatus('sold', { openLocation: false, activeProject: false, activeAgreement: false, activeProspect: false }), 'sold');
  assert.equal(deriveTerritoryStatus('unavailable', { openLocation: false, activeProject: false, activeAgreement: false, activeProspect: false }), 'unavailable');
});

test('scoring weighs demographics and nearby performance, re-weighting missing parts', () => {
  const full = scoreTerritory({ population: 120_000, households: 45_000, medianHouseholdIncomeMinor: 8_500_000 }, { nearbyRevenueMinor: 200, networkMedianRevenueMinor: 100 });
  assert.equal(full.score, 100);
  const half = scoreTerritory({ population: 60_000, households: null, medianHouseholdIncomeMinor: null }, null);
  assert.equal(half.score, 50);
  assert.equal(scoreTerritory(null, null).score, null);
});

test('surveys: eNPS, answer validation, anonymity threshold and rounds', () => {
  assert.deepEqual(npsOf([10, 9, 8, 7, 6, 0]), { n: 6, promoters: 2, passives: 2, detractors: 2, score: 0 });
  assert.equal(npsOf([10, 10, 9, 3]).score, 50);
  const q = surveyBodySchema.parse(STARTER_SURVEY).questions;
  assert.deepEqual(validateSurveyAnswers(q, { enps: 11, support: 3, marketing: 4, training: 5, value: 2, invest_again: 'Maybe' }), { enps: 'Answer 0 to 10', invest_again: 'Choose one of the options' });
  assert.deepEqual(validateSurveyAnswers(q, { enps: 9, support: 3, marketing: 4, training: 5, value: 2, invest_again: 'Yes' }), {});
  assert.equal(sliceVisible(4, true, 5), false);
  assert.equal(sliceVisible(4, false, 5), true);
  assert.equal(nextRoundDate('2026-01-31', 'quarterly'), '2026-05-01');
  assert.equal(nextRoundDate('2026-01-15', 'once'), null);
});

test('validation calls rotate: region first, fewest recent calls, monthly limit respected', () => {
  const pool = [
    { id: 'a', country: 'US', region: 'TX', callsLast90: 5, callsThisMonth: 1, maxCallsPerMonth: 4, lastCallAt: '2026-10-01' },
    { id: 'b', country: 'US', region: 'CA', callsLast90: 1, callsThisMonth: 0, maxCallsPerMonth: 4, lastCallAt: null },
    { id: 'c', country: 'CA', region: 'ON', callsLast90: 0, callsThisMonth: 0, maxCallsPerMonth: 4, lastCallAt: null },
    { id: 'd', country: 'US', region: 'TX', callsLast90: 0, callsThisMonth: 2, maxCallsPerMonth: 2, lastCallAt: null },
  ];
  assert.deepEqual(pickValidators(pool, { country: 'US', region: 'TX' }, 3).map((v) => v.id), ['a', 'b', 'c']);
  assert.deepEqual(pickValidators(pool, { country: 'US', region: 'TX' }, 2, ['a']).map((v) => v.id), ['b', 'c']);
});

test('notices render from templates; renewal windows and development schedules', () => {
  const n = renderNotice('default', { franchisee: 'Pacific Heat Ltd', brand: 'Northlight', agreementDate: '2020-01-01', reason: 'insurance', details: 'liability certificate expired', cureDays: 10, cureDeadline: '2026-11-01', date: '2026-10-22' });
  assert.match(n.body, /insurance coverage required by the Agreement \(liability certificate expired\)/);
  assert.match(n.body, /until 2026-11-01/);
  assert.match(n.subject, /Northlight/);
  const w = renewalWindow('2027-06-30');
  assert.deepEqual(w, { opensOn: '2026-06-30', closesOn: '2026-12-30' });
  assert.equal(renewalPhase('2026-10-15', w, '2027-06-30'), 'window_open');
  assert.equal(renewalPhase('2026-01-01', w, '2027-06-30'), 'upcoming');
  const p = scheduleProgress([
    { sequence: 1, signByDate: '2025-06-01', openByDate: '2026-01-01', status: 'opened' },
    { sequence: 2, signByDate: '2026-03-01', openByDate: '2026-09-01', status: 'signed' },
    { sequence: 3, signByDate: '2027-01-01', openByDate: '2027-06-01', status: 'pending' },
  ], '2026-10-15');
  assert.deepEqual({ behind: p.behind, overdue: p.overdue, opened: p.opened, dueToOpen: p.dueToOpen, next: p.nextDeadline }, { behind: true, overdue: [2], opened: 1, dueToOpen: 2, next: '2026-09-01' });
});

test('royalty splits per currency always add up', () => {
  const rules = [{ currency: null, royaltyShareBps: 4000, fundShareBps: 2500 }, { currency: 'GBP', royaltyShareBps: 5000, fundShareBps: 0 }];
  assert.equal(ruleFor(rules, 'EUR')!.royaltyShareBps, 4000);
  assert.equal(ruleFor(rules, 'GBP')!.royaltyShareBps, 5000);
  const s = splitAmounts(1001, 333, ruleFor(rules, 'EUR')!);
  assert.deepEqual(s, { masterRoyaltyMinor: 400, hqRoyaltyMinor: 601, masterFundMinor: 83, hqFundMinor: 250 });
});

test('access: the new modules are HQ-private where they should be', () => {
  const vp = templateCapabilities('vp_franchise', 'studios');
  assert.ok(vp.has('sales.territories:publish') && vp.has('legal.lifecycle:edit') && vp.has('sales.master_franchise:edit'));
  const fo = effectiveCapabilities({ role: 'franchise_owner', scopeKind: 'owner_group', grants: ['sales.territories:view', 'legal.lifecycle:view', 'sales.master_franchise:view', 'finance.royalty_splits:view'] }, 'studios');
  assert.ok(!fo.has('sales.territories:view') && !fo.has('legal.lifecycle:view'));
  assert.ok(fo.has('sales.master_franchise:view') && fo.has('finance.royalty_splits:view'));
  assert.ok(fo.has('community.surveys:view'), 'every member can answer surveys');
  assert.ok(templateCapabilities('finance', 'studios').has('finance.royalty_splits:publish'));
});

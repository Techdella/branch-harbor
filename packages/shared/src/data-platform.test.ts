import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCapabilities, templateCapabilities } from './access.ts';
import {
  BENCHMARK_MIN_COHORT, autoDetectMapping, benchmarkRegion, decimalToMinor, detectTemplate, importEntitiesFor, laplaceNoise, migrationTemplate, netSales, normalizeHeader,
  parseBooleanish, parseDateish, percentileOf, percentilePoints, privatePercentiles, salesVariance, suggestRole,
} from './data-platform.ts';

test('decimal amounts become minor units without float drift, per currency exponent', () => {
  assert.equal(decimalToMinor('12.30', 'USD'), 1230);
  assert.equal(decimalToMinor(0.1 + 0.2, 'EUR'), 30);
  assert.equal(decimalToMinor('1,234.505', 'GBP'), 123451);
  assert.equal(decimalToMinor('-4.5', 'CAD'), -450);
  assert.equal(decimalToMinor('1500', 'JPY'), 1500);
  assert.equal(decimalToMinor('1500.6', 'JPY'), 1501);
  assert.equal(decimalToMinor('abc', 'USD'), null);
  assert.equal(decimalToMinor('', 'USD'), null);
});

test('net sales = gross − refunds − tax − tips; variance flags past the threshold', () => {
  assert.equal(netSales({ grossMinor: 10_000, refundsMinor: 500, taxMinor: 1300, tipsMinor: 700 }), 7500);
  assert.deepEqual(salesVariance(10_400, 10_000), { diffMinor: 400, pct: 4, flagged: false });
  assert.deepEqual(salesVariance(9_000, 10_000), { diffMinor: -1000, pct: -10, flagged: true });
  assert.equal(salesVariance(500, 0).flagged, true);
  assert.equal(salesVariance(0, 0).flagged, false);
});

test('import: headers auto-detect, vendor exports are recognised and mapped', () => {
  assert.equal(normalizeHeader('﻿E-mail Address '), 'e_mail_address');
  const sq = ['Reference ID', 'First Name', 'Surname', 'Email Address', 'Phone Number', 'Square Customer ID', 'Email Subscription Status', 'Birthday'];
  const t = detectTemplate(sq, 'customers');
  assert.equal(t?.key, 'square_customers');
  const { mapping } = autoDetectMapping('customers', sq, t);
  assert.equal(mapping.first_name, 1);
  assert.equal(mapping.last_name, 2);
  assert.equal(mapping.email, 3);
  assert.equal(mapping.phone, 4);
  assert.equal(mapping.marketing_email, 6);
  assert.equal(mapping.date_of_birth, 7);
  assert.equal(mapping.marketing_sms, null);
  const shop = ['First Name', 'Last Name', 'Email', 'Accepts Email Marketing', 'Accepts SMS Marketing', 'Total Spent', 'Phone'];
  assert.equal(detectTemplate(shop)?.key, 'shopify_customers');
  for (const k of ['mindbody_clients', 'glofox_members', 'fresha_clients', 'vagaro_customers', 'mindbody_memberships', 'glofox_memberships']) assert.ok(migrationTemplate(k), k);
  // Generic synonyms without a template.
  const generic = autoDetectMapping('locations', ['Store Name', 'Store Code', 'Street Address', 'Town', 'Zip', 'Country', 'Timezone', 'Currency']).mapping;
  assert.deepEqual([generic.name, generic.code, generic.address_line1, generic.city, generic.postal_code, generic.country, generic.time_zone, generic.currency], [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('import: consent is only what the file says; dates follow the export order', () => {
  assert.equal(parseBooleanish('Subscribed'), true);
  assert.equal(parseBooleanish('yes'), true);
  assert.equal(parseBooleanish('Unsubscribed'), false);
  assert.equal(parseBooleanish(''), null);
  assert.equal(parseBooleanish('maybe'), null);
  assert.equal(parseDateish('2024-02-29'), '2024-02-29');
  assert.equal(parseDateish('03/04/1990', 'mdy'), '1990-03-04');
  assert.equal(parseDateish('03/04/1990', 'dmy'), '1990-04-03');
  assert.equal(parseDateish('25/12/1990', 'mdy'), '1990-12-25');
  assert.equal(parseDateish('31/02/1990', 'dmy'), null);
  assert.equal(parseDateish('soon'), null);
});

test('import: role suggestions and entities per industry', () => {
  assert.equal(suggestRole('Studio Manager'), 'location_manager');
  assert.equal(suggestRole('Front desk'), 'staff');
  assert.equal(suggestRole('Instructor'), 'staff');
  assert.equal(suggestRole('Franchisee'), 'franchise_owner');
  assert.equal(suggestRole('Social media'), 'content_social');
  assert.ok(importEntitiesFor('studios').includes('memberships'));
  assert.ok(!importEntitiesFor('foods').includes('memberships'));
  assert.ok(importEntitiesFor('foods').includes('products'));
  assert.ok(importEntitiesFor('hospitality').includes('properties'));
});

test('benchmarks: nothing below k organisations; noise is deterministic, monotone and bounded', () => {
  const nine = Array.from({ length: BENCHMARK_MIN_COHORT - 1 }, (_, i) => i * 10);
  assert.equal(privatePercentiles(nine, 'seed'), null);
  const vals = Array.from({ length: 23 }, (_, i) => 50 + i * 2);
  const a = privatePercentiles(vals, 'studios:north_america:2026-09:occupancy_pct', { bounds: [0, 100], digits: 1 })!;
  const b = privatePercentiles(vals, 'studios:north_america:2026-09:occupancy_pct', { bounds: [0, 100], digits: 1 })!;
  assert.deepEqual(a, b);
  assert.equal(a.cohortSize, 20);
  assert.ok(a.p10 <= a.p25 && a.p25 <= a.p50 && a.p50 <= a.p75 && a.p75 <= a.p90);
  const exact = percentilePoints(vals)!;
  assert.ok(Math.abs(a.p50 - exact.p50) < 10, 'noise stays small relative to the spread');
  assert.notEqual(laplaceNoise('x', 1), laplaceNoise('y', 1));
  assert.equal(percentileOf(exact.p50, exact), 50);
  assert.equal(percentileOf(exact.p90 + 100, exact), 95);
  assert.equal(percentileOf(exact.p75, exact), 75);
  assert.equal(benchmarkRegion('ca'), 'north_america');
  assert.equal(benchmarkRegion('GB'), 'uk_ireland');
});

test('access: data platform modules in the role templates', () => {
  const hq = templateCapabilities('hq_admin', 'studios');
  for (const c of ['network.sales_connectors:publish', 'network.bulk_launch:publish', 'network.benchmarks:publish', 'settings.import:edit']) assert.ok(hq.has(c as never), c);
  const fo = effectiveCapabilities({ role: 'franchise_owner', scopeKind: 'owner_group' }, 'studios');
  assert.ok(fo.has('network.sales_connectors:edit'));
  assert.ok(!fo.has('network.sales_connectors:publish'));
  assert.ok(!fo.has('network.benchmarks:view'), 'benchmarks are HQ-private');
  assert.ok(!fo.has('network.bulk_launch:view'));
  assert.ok(templateCapabilities('org_owner', 'foods').has('network.benchmarks:publish'));
  assert.ok(!templateCapabilities('staff', 'studios').has('settings.import:view'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCapabilities, permissionsFromCapabilities, ROLE_PERMISSIONS } from './access.ts';
import {
  ASSISTANT_NAME, aiOrgSettings, aiUsageState, applyGuardrails, checkGuardrails, creditsFor, explainedScore, isLegalTopic, redactPii, usageMonth,
} from './ai.ts';
import { aiMonthlyAllowance } from './pricing.ts';

test('the assistant name is one constant', () => {
  assert.equal(ASSISTANT_NAME, 'Marina');
});

test('credits: tokens priced per model, cache reads cheaper, sandbox free', () => {
  assert.equal(creditsFor('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0 }), 400);
  assert.equal(creditsFor('claude-opus-5-5', { inputTokens: 0, outputTokens: 100_000 }), 200);
  assert.equal(creditsFor('claude-opus-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }), 40);
  assert.equal(creditsFor('sandbox', { inputTokens: 5000, outputTokens: 5000 }), 0);
  // Unknown models are priced at the most expensive row, never free.
  assert.ok(creditsFor('some-future-model', { inputTokens: 1000, outputTokens: 1000 }) > 0);
});

test('usage state: allowance warning, then fair-use pause', () => {
  assert.equal(aiUsageState(10, 100), 'ok');
  assert.equal(aiUsageState(100, 100), 'over_allowance');
  assert.equal(aiUsageState(200, 100), 'paused');
  assert.equal(usageMonth(new Date('2026-10-15T10:00:00Z')), '2026-10');
});

test('plan allowance scales with locations', () => {
  assert.equal(aiMonthlyAllowance('network', 10), 2000 + 4000);
  assert.equal(aiMonthlyAllowance('solo', 1), 500);
});

test('guardrails: banned claims removed, required disclaimers appended', () => {
  const g = { bannedClaims: ['guaranteed results'], requiredDisclaimers: ['Results vary.'] };
  const r = checkGuardrails('Join now. Guaranteed results in 30 days!', g);
  assert.deepEqual(r.bannedFound, ['guaranteed results']);
  assert.deepEqual(r.missingDisclaimers, ['Results vary.']);
  const fixed = applyGuardrails('Join now. Guaranteed results in 30 days! See you soon.', g);
  assert.ok(!/guaranteed/i.test(fixed.text));
  assert.ok(fixed.text.endsWith('Results vary.'));
  assert.ok(checkGuardrails(fixed.text, g).ok);
});

test('legal topics are detected for the "not legal advice" note', () => {
  assert.ok(isLegalTopic('What is the cooling-off period in Ontario?'));
  assert.ok(isLegalTopic('Can we terminate the franchise agreement?'));
  assert.ok(!isLegalTopic('Revenue by location this quarter'));
});

test('PII is masked before logging, dates are kept', () => {
  const t = redactPii('Call +44 20 7946 0958 or mail jo@example.com about 2026-10-15');
  assert.ok(!t.includes('jo@example.com'));
  assert.ok(!t.includes('7946'));
  assert.ok(t.includes('2026-10-15'));
});

test('explained score keeps every factor visible', () => {
  const s = explainedScore([
    { key: 'a', label: 'A', points: 30, max: 40, reason: 'x' },
    { key: 'b', label: 'B', points: 70, max: 60, reason: 'capped' },
  ], { label: 'Call', reason: 'hot' });
  assert.equal(s.score, 90);
  assert.equal(s.band, 'hot');
  assert.equal(s.factors.length, 2);
});

test('org settings fill defaults', () => {
  const s = aiOrgSettings({ enabled: false, guardrails: { bannedClaims: ['x'] } });
  assert.equal(s.enabled, false);
  assert.deepEqual(s.guardrails.requiredDisclaimers, []);
  assert.equal(s.retentionDays, 365);
});

test('ai.assistant: granted to roles that had AI, never widens scope; staff and finance keep their pinned permissions', () => {
  const fo = effectiveCapabilities({ role: 'franchise_owner', scopeKind: 'owner_group' }, 'studios');
  assert.ok(fo.has('ai.assistant:view') && fo.has('ai.assistant:edit'));
  assert.ok(!fo.has('ai.assistant:publish'));
  const hq = effectiveCapabilities({ role: 'hq_admin', scopeKind: 'organization' }, 'studios');
  assert.ok(hq.has('ai.assistant:publish'));
  assert.ok(effectiveCapabilities({ role: 'org_owner', scopeKind: 'organization' }, 'foods').has('ai.assistant:export'));
  assert.ok(!effectiveCapabilities({ role: 'staff', scopeKind: 'location' }, 'studios').has('ai.assistant:view'));
  assert.ok(!ROLE_PERMISSIONS.staff.includes('ai.use'));
  // Holding only ai.assistant gives ai.use and nothing else.
  assert.deepEqual([...permissionsFromCapabilities(new Set(['ai.assistant:view']))], ['ai.use']);
});

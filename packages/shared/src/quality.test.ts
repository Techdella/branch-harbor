import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCapabilities, expandGrants, permissionsFromCapabilities } from './access.ts';
import {
  STARTER_AUDIT_TEMPLATES, auditTemplateBodySchema, complianceState, dueReminderStep, growthPct, quartileOf, quartiles, scoreAudit, startersFor, type AuditSection,
} from './quality.ts';

const sections: AuditSection[] = [
  { id: 's1', title: 'Safety', questions: [
    { id: 'exits', text: 'Exits clear', type: 'yes_no', weight: 2, critical: true, photoRequired: false },
    { id: 'clean', text: 'Clean', type: 'scale', weight: 4, critical: false, photoRequired: false },
  ] },
  { id: 's2', title: 'Kitchen', questions: [
    { id: 'fridge', text: 'Fridge', type: 'number', weight: 2, critical: false, photoRequired: false, max: 5 },
    { id: 'notes', text: 'Notes', type: 'text', weight: 1, critical: false, photoRequired: false },
    { id: 'photo', text: 'Photo', type: 'photo', weight: 1, critical: false, photoRequired: false },
  ] },
];
const P = '6f1c6a2e-1b1f-4b6e-9a39-0c4a3e0f1d11';

test('audit score: weighted percentage, scale points, number ranges and text not scored', () => {
  const s = scoreAudit({ sections, passThreshold: 80 }, { exits: { value: 'yes' }, clean: { value: 4 }, fridge: { value: 3 }, notes: { value: 'ok' }, photo: { photoIds: [P] } });
  // exits 2/2, clean 3/4 of 4, fridge 2/2, photo 1/1 → 8/9
  assert.equal(s.possible, 9);
  assert.equal(s.earned, 8);
  assert.equal(s.scorePct, 88.9);
  assert.equal(s.passed, true);
  assert.equal(s.criticalFailed, false);
  assert.deepEqual(s.unanswered, []);
});

test('a failed critical item fails the audit whatever the score', () => {
  const s = scoreAudit({ sections, passThreshold: 10 }, { exits: { value: 'no' }, clean: { value: 5 }, fridge: { value: 2 }, notes: { value: 'x' }, photo: { photoIds: [P] } });
  assert.equal(s.criticalFailed, true);
  assert.equal(s.passed, false);
  assert.deepEqual(s.failedItems.map((f) => f.questionId), ['exits']);
});

test('failed items: no, low scale, out of range, missing required photo; n/a is excluded', () => {
  const t = { sections: [{ ...sections[0]!, questions: [...sections[0]!.questions, { id: 'sign', text: 'Sign', type: 'yes_no' as const, weight: 1, critical: false, photoRequired: true }] }, sections[1]!], passThreshold: 50 };
  const s = scoreAudit(t, { exits: { na: true }, clean: { value: 2 }, fridge: { value: 9 }, notes: { value: 'n' }, photo: { photoIds: [P] }, sign: { value: 'yes' } });
  assert.deepEqual(s.failedItems.map((f) => [f.questionId, f.reason]), [['clean', 'low_score'], ['sign', 'photo_missing'], ['fridge', 'out_of_range']]);
  assert.equal(s.results.find((r) => r.questionId === 'exits')!.possible, 0);
});

test('an incomplete audit cannot pass', () => {
  const s = scoreAudit({ sections, passThreshold: 0 }, { exits: { value: 'yes' } });
  assert.equal(s.passed, false);
  assert.ok(s.unanswered.includes('clean'));
});

test('template schema: unique ids and valid ranges; every starter validates', () => {
  assert.equal(auditTemplateBodySchema.safeParse({ name: 'x', sections: [{ id: 'a', title: 'A', questions: [{ id: 'q', text: 'Q', type: 'yes_no' }, { id: 'q', text: 'Q2', type: 'yes_no' }] }] }).success, false);
  assert.equal(auditTemplateBodySchema.safeParse({ name: 'x', sections: [{ id: 'a', title: 'A', questions: [{ id: 'n', text: 'N', type: 'number', min: 5, max: 1 }] }] }).success, false);
  for (const st of STARTER_AUDIT_TEMPLATES) assert.equal(auditTemplateBodySchema.safeParse(st).success, true, st.key);
  assert.deepEqual(startersFor('studios').map((s) => s.key), ['brand_standards', 'cleanliness_safety', 'pre_opening']);
  assert.ok(startersFor('hospitality').some((s) => s.key === 'room_inspection'));
  assert.ok(startersFor('foods').some((s) => s.key === 'kitchen_food_safety'));
});

test('compliance state: valid, expiring within 30 days, expired, pending, below minimum, missing', () => {
  const req = { minAmountMinor: 200_000_000, currency: 'USD' };
  const today = '2026-10-15';
  const doc = (o: Partial<{ status: string; expiresOn: string | null; coverageAmountMinor: number | null; currency: string | null }>) => ({ status: 'approved', expiresOn: '2027-06-01', coverageAmountMinor: 300_000_000, currency: 'USD', ...o });
  assert.equal(complianceState([doc({})], req, today).state, 'valid');
  assert.equal(complianceState([doc({ expiresOn: '2026-11-01' })], req, today).state, 'expiring');
  assert.equal(complianceState([doc({ expiresOn: '2026-10-01' })], req, today).state, 'expired');
  assert.equal(complianceState([doc({ status: 'pending' })], req, today).state, 'pending');
  assert.equal(complianceState([doc({ coverageAmountMinor: 100 })], req, today).state, 'below_minimum');
  assert.equal(complianceState([doc({ currency: 'CAD' })], req, today).state, 'below_minimum');
  assert.equal(complianceState([doc({ status: 'rejected' })], req, today).state, 'missing');
  assert.equal(complianceState([], req, today).state, 'missing');
});

test('reminders at 60, 30 and 7 days and on expiry, each once', () => {
  assert.equal(dueReminderStep(90, []), null);
  assert.equal(dueReminderStep(59, []), 60);
  assert.equal(dueReminderStep(20, [60]), 30);
  assert.equal(dueReminderStep(20, [60, 30]), null);
  assert.equal(dueReminderStep(5, []), 7);
  assert.equal(dueReminderStep(0, [60, 30, 7]), 0);
  assert.equal(dueReminderStep(-3, [60, 30, 7, 0]), null);
});

test('league table: quartiles need enough locations; growth per currency', () => {
  assert.equal(quartiles([1, 2, 3]), null);
  const q = quartiles([10, 20, 30, 40, 50])!;
  assert.deepEqual([q.q1, q.median, q.q3], [20, 30, 40]);
  assert.equal(quartileOf(45, q), 1);
  assert.equal(quartileOf(15, q), 4);
  assert.equal(growthPct(1100, 1000), 10);
  assert.equal(growthPct(100, 0), null);
});

test('audits are granted by name only: operations.* never includes them or implies them', () => {
  const staff = effectiveCapabilities({ role: 'staff', scopeKind: 'location' }, 'studios');
  assert.equal(staff.has('operations.audits:view'), false);
  assert.equal(expandGrants({ 'operations.*': ['view'] }, 'foods').has('operations.audits:view'), false);
  const auditor = permissionsFromCapabilities(new Set(['operations.audits:view', 'operations.audits:edit']));
  assert.equal(auditor.has('operations.read'), false);
  const fo = effectiveCapabilities({ role: 'franchise_owner', scopeKind: 'owner_group' }, 'studios');
  assert.ok(fo.has('operations.audits:edit') && fo.has('legal.compliance_documents:edit') && fo.has('network.league_table:view'));
  assert.equal(fo.has('operations.audits:publish'), false);
  assert.equal(fo.has('network.league_table:publish'), false);
  assert.ok(effectiveCapabilities({ role: 'hq_admin', scopeKind: 'organization' }, 'studios').has('operations.audits:publish'));
});

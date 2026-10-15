import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JURISDICTION_RULES, RULES_DISCLAIMER, addWaitingDays, applicableRules, evaluateFranchiseCompliance, rulesInForce,
  type ComplianceDelivery, type ComplianceInput, type JurisdictionRule,
} from '@bh/shared';

const DAY = 86_400_000;
const RULES = DEFAULT_JURISDICTION_RULES;
const receipt = new Date('2026-10-02T15:00:00Z');
const at = (days: number) => new Date(receipt.getTime() + days * DAY);
const disclosure = (jurisdictions: string[], when = receipt): ComplianceDelivery => ({ kind: 'disclosure', jurisdictions, deliveredAt: when, receiptSignedAt: when });
const evalAt = (prospect: ComplianceInput['prospect'], now: Date, extra: Partial<ComplianceInput> = {}) =>
  evaluateFranchiseCompliance({ franchisor: { country: 'US' }, prospect, rules: RULES, now, deliveries: [disclosure([prospect.country])], ...extra });

/** Expected key rules per seeded jurisdiction (the table in the report). */
const EXPECTED: Record<string, { sign: number | null; pay: number | null; count?: 'calendar' | 'business'; reg: JurisdictionRule['registration']['kind']; cooling?: number; status?: JurisdictionRule['status'] }> = {
  US: { sign: 14, pay: 14, reg: 'none' },
  'US-CA': { sign: 14, pay: 14, reg: 'registration' }, 'US-HI': { sign: 14, pay: 14, reg: 'registration' }, 'US-IL': { sign: 14, pay: 14, reg: 'registration' },
  'US-IN': { sign: 14, pay: 14, reg: 'registration' }, 'US-MD': { sign: 14, pay: 14, reg: 'registration' }, 'US-MI': { sign: 10, pay: 10, count: 'business', reg: 'notice_filing' },
  'US-MN': { sign: 14, pay: 14, reg: 'registration' }, 'US-NY': { sign: 10, pay: 10, count: 'business', reg: 'registration' }, 'US-ND': { sign: 14, pay: 14, reg: 'registration' },
  'US-RI': { sign: 14, pay: 14, reg: 'registration' }, 'US-SD': { sign: 14, pay: 14, reg: 'registration' }, 'US-VA': { sign: 14, pay: 14, reg: 'registration' },
  'US-WA': { sign: 14, pay: 14, reg: 'registration' }, 'US-WI': { sign: 14, pay: 14, reg: 'notice_filing' },
  'US-FL': { sign: 14, pay: 14, reg: 'exemption_filing' }, 'US-KY': { sign: 14, pay: 14, reg: 'exemption_filing' }, 'US-NE': { sign: 14, pay: 14, reg: 'exemption_filing' },
  'US-TX': { sign: 14, pay: 14, reg: 'exemption_filing' }, 'US-UT': { sign: 14, pay: 14, reg: 'exemption_filing' }, 'US-OR': { sign: 14, pay: 14, reg: 'none' },
  CA: { sign: null, pay: null, reg: 'none', status: 'no_statute' },
  'CA-AB': { sign: 14, pay: 14, reg: 'none' }, 'CA-BC': { sign: 14, pay: 14, reg: 'none' }, 'CA-MB': { sign: 14, pay: 14, reg: 'none' },
  'CA-NB': { sign: 14, pay: 14, reg: 'none' }, 'CA-ON': { sign: 14, pay: 14, reg: 'none' }, 'CA-PE': { sign: 14, pay: 14, reg: 'none' },
  'CA-SK': { sign: null, pay: null, reg: 'verify', status: 'verify' }, 'CA-QC': { sign: null, pay: null, reg: 'none', status: 'no_statute' },
  AU: { sign: 14, pay: 14, reg: 'none', cooling: 14 },
  NZ: { sign: null, pay: null, reg: 'none', status: 'no_statute' }, GB: { sign: null, pay: null, reg: 'none', status: 'no_statute' },
  FR: { sign: 20, pay: 20, reg: 'none' }, IT: { sign: 30, pay: null, reg: 'none' }, ES: { sign: 20, pay: 20, reg: 'voluntary' }, BE: { sign: 31, pay: 31, reg: 'none' },
  RO: { sign: null, pay: null, reg: 'none', status: 'verify' },
  BR: { sign: 10, pay: 10, reg: 'none' }, MX: { sign: 30, pay: null, count: 'business', reg: 'none' },
  AE: { sign: null, pay: null, reg: 'none', status: 'no_statute' },
};

describe('jurisdiction rules: shipped table', () => {
  it('every rule is versioned, cited, unreviewed and flagged for counsel review', () => {
    const codes = RULES.map((r) => `${r.code}@${r.version}`);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of RULES) {
      expect(r.reviewedByCounsel, r.code).toBe(false);
      expect(r.needsCounselReview, r.code).toBe(true);
      expect(r.sources.length, r.code).toBeGreaterThan(0);
      expect(r.sources.every((s) => s.law.length > 3), r.code).toBe(true);
      expect(r.version).toMatch(/^\d{4}\.\d+$/);
      expect(r.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (r.status === 'statute' && r.disclosure.required) expect(r.disclosure.document, r.code).toBeTruthy();
      if (r.confidence === 'low' || r.status === 'verify') expect(r.verify.length, r.code).toBeGreaterThan(0);
    }
    expect(RULES_DISCLAIMER).toMatch(/not legal advice/i);
  });

  it('covers exactly the expected jurisdictions with the expected key rules', () => {
    expect(RULES.map((r) => r.code).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [code, e] of Object.entries(EXPECTED)) {
      const r = RULES.find((x) => x.code === code)!;
      expect(r.disclosure.minDaysBeforeSigning, code).toBe(e.sign);
      expect(r.disclosure.minDaysBeforePayment, code).toBe(e.pay);
      expect(r.disclosure.dayCount, code).toBe(e.count ?? 'calendar');
      expect(r.registration.kind, code).toBe(e.reg);
      expect(r.coolingOff?.days ?? undefined, code).toBe(e.cooling);
      if (e.status) expect(r.status, code).toBe(e.status);
    }
    expect(RULES.find((r) => r.code === 'US')!.disclosure.changedTermsDays).toBe(7);
  });

  it('a newer version replaces the old one from its effective date only', () => {
    const v2: JurisdictionRule = { ...RULES.find((r) => r.code === 'FR')!, version: '2027.1', effectiveFrom: '2027-01-01', disclosure: { ...RULES.find((r) => r.code === 'FR')!.disclosure, minDaysBeforeSigning: 25 } };
    const all = [...RULES, v2];
    expect(rulesInForce(all, new Date('2026-12-31T12:00:00Z')).find((r) => r.code === 'FR')!.version).toBe('2026.1');
    expect(rulesInForce(all, new Date('2027-01-02T12:00:00Z')).find((r) => r.code === 'FR')!.version).toBe('2027.1');
  });
});

describe('jurisdiction rules: engine', () => {
  it('counts calendar days conservatively from the signed receipt (receipt 2 Oct → sign 16 Oct or later)', () => {
    expect(addWaitingDays(receipt, 14, 'calendar').toISOString()).toBe('2026-10-17T00:00:00.000Z');
    expect(addWaitingDays(new Date('2026-10-02T00:00:00Z'), 14, 'calendar').toISOString()).toBe('2026-10-16T00:00:00.000Z');
    // Friday + 10 business days = Friday two weeks later.
    expect(addWaitingDays(new Date('2026-10-02T10:00:00Z'), 10, 'business').toISOString()).toBe('2026-10-17T00:00:00.000Z');
  });

  for (const [label, prospect, codes] of [
    ['US (federal only, Colorado)', { country: 'US', region: 'CO' }, ['US']],
    ['Canada (Ontario)', { country: 'CA', region: 'ON' }, ['CA', 'CA-ON']],
    ['Australia', { country: 'AU', region: 'NSW' }, ['AU']],
  ] as const) {
    it(`${label}: signing and payment blocked before day 14, allowed after`, () => {
      const d13 = evalAt(prospect, at(13));
      expect(d13.applicable.map((a) => a.code)).toEqual(codes);
      expect(d13.canSign).toBe(false);
      expect(d13.canPay).toBe(false);
      expect(d13.signingBlockers.map((b) => b.code)).toContain('waiting_period');
      expect(d13.signingBlockers.find((b) => b.code === 'waiting_period')!.until).toBe(d13.earliestSigningAt);
      const d15 = evalAt(prospect, at(15));
      expect(d15.canSign).toBe(true);
      expect(d15.canPay).toBe(true);
      expect(d15.earliestSigningAt).toBe('2026-10-17T00:00:00.000Z');
    });
  }

  it('without a delivered disclosure or a signed receipt nothing can be signed', () => {
    const none = evaluateFranchiseCompliance({ franchisor: { country: 'US' }, prospect: { country: 'US', region: 'CO' }, rules: RULES, now: at(30) });
    expect(none.signingBlockers[0]!.code).toBe('disclosure_not_delivered');
    const unsigned = evaluateFranchiseCompliance({ franchisor: { country: 'US' }, prospect: { country: 'US', region: 'CO' }, rules: RULES, now: at(30), deliveries: [{ kind: 'disclosure', jurisdictions: ['US'], deliveredAt: receipt, receiptSignedAt: null }] });
    expect(unsigned.signingBlockers[0]!.code).toBe('receipt_not_signed');
    // A disclosure for another country does not count.
    const wrong = evalAt({ country: 'US', region: 'CO' }, at(30), { deliveries: [disclosure(['CA'])] });
    expect(wrong.canSign).toBe(false);
  });

  it('registration states block signing and payment until the registration is in effect', () => {
    const p = { country: 'US', region: 'CA' };
    const missing = evalAt(p, at(30));
    expect(missing.canSign).toBe(false);
    expect(missing.signingBlockers.map((b) => b.code)).toEqual(['registration_required']);
    expect(missing.paymentBlockers.map((b) => b.code)).toEqual(['registration_required']);
    expect(missing.warnings.map((w) => w.code)).toContain('offer_before_registration');
    expect(evalAt(p, at(30), { registrations: [{ jurisdiction: 'US-CA', status: 'pending' }] }).canSign).toBe(false);
    expect(evalAt(p, at(30), { registrations: [{ jurisdiction: 'US-CA', status: 'registered', expiresAt: at(20) }] }).canSign).toBe(false);
    expect(evalAt(p, at(30), { registrations: [{ jurisdiction: 'US-CA', status: 'registered', expiresAt: at(400) }] }).canSign).toBe(true);
    // Registered but still inside the waiting period: only the waiting period blocks.
    expect(evalAt(p, at(5), { registrations: [{ jurisdiction: 'US-CA', status: 'registered' }] }).signingBlockers.map((b) => [b.code, b.ruleCode])).toEqual([['waiting_period', 'US'], ['waiting_period', 'US-CA']]);
  });

  it('applies offer-state laws when the franchisor offers from that state', () => {
    const r = applicableRules(RULES, { country: 'US', region: 'CA' }, { country: 'US', region: 'CO' }, at(1));
    expect(r.map((x) => [x.rule.code, x.basis])).toEqual([['US', 'prospect_location'], ['US-CA', 'franchisor_location']]);
    expect(applicableRules(RULES, { country: 'US', region: 'CA' }, { country: 'CA', region: 'ON' }, at(1)).map((x) => x.rule.code)).toEqual(['CA', 'CA-ON']);
  });

  it('Michigan and New York: the later of the state business-day period and the FTC 14 days wins', () => {
    const mi = evalAt({ country: 'US', region: 'MI' }, at(13), { registrations: [{ jurisdiction: 'US-MI', status: 'registered' }] });
    expect(mi.earliestSigningAt).toBe('2026-10-17T00:00:00.000Z');
    expect(mi.steps.filter((s) => s.key === 'waiting_period_signing').map((s) => s.ruleCode).sort()).toEqual(['US', 'US-MI']);
  });

  it('FTC: unilaterally changed material terms need the final agreement 7 days before signing', () => {
    const r = evalAt({ country: 'US', region: 'CO' }, at(16), { deliveries: [disclosure(['US']), { kind: 'agreement', jurisdictions: ['US'], deliveredAt: at(12), receiptSignedAt: null, materialChange: true }] });
    expect(r.canSign).toBe(false);
    expect(r.signingBlockers[0]!.code).toBe('changed_terms_waiting');
    expect(evalAt({ country: 'US', region: 'CO' }, at(20), { deliveries: [disclosure(['US']), { kind: 'agreement', jurisdictions: ['US'], deliveredAt: at(12), receiptSignedAt: null, materialChange: true }] }).canSign).toBe(true);
  });

  it('Australia: the 14-day cooling-off runs from the earlier of signing or payment', () => {
    const r = evalAt({ country: 'AU' }, at(20), { agreementSignedAt: at(16), firstPaymentAt: at(18) });
    expect(r.coolingOffEndsAt).toBe(addWaitingDays(at(16), 14, 'calendar').toISOString());
    expect(r.requiredDocuments.map((d) => d.key)).toEqual(expect.arrayContaining(['au_disclosure_document', 'au_information_statement', 'au_advice_statement', 'final_agreement']));
  });

  it.each([
    ['FR', 20, 20], ['IT', 30, null], ['ES', 20, 20], ['BE', 31, 31], ['BR', 10, 10],
  ] as const)('%s: %s days before signing', (country, sign, pay) => {
    expect(evalAt({ country }, at(sign - 1)).canSign).toBe(false);
    expect(evalAt({ country }, at(sign + 1)).canSign).toBe(true);
    expect(evalAt({ country }, at(1)).canPay).toBe(pay === null);
  });

  it('Mexico counts 30 business days', () => {
    expect(evalAt({ country: 'MX' }, at(41)).canSign).toBe(false);
    expect(evalAt({ country: 'MX' }, at(43)).canSign).toBe(true);
    expect(evalAt({ country: 'MX' }, at(1)).canPay).toBe(true);
  });

  it.each(['NZ', 'GB', 'AE'])('%s: no franchise statute, nothing blocks, the rule explains why', (country) => {
    const r = evaluateFranchiseCompliance({ franchisor: { country: 'US' }, prospect: { country }, rules: RULES, now: at(0) });
    expect(r.canSign).toBe(true);
    expect(r.applicable).toEqual([expect.objectContaining({ code: country, status: 'no_statute', reviewedByCounsel: false, needsCounselReview: true })]);
    expect(r.warnings.map((w) => w.code)).toContain('cross_border');
  });

  it('Romania and Saskatchewan are flagged for verification instead of inventing a period', () => {
    expect(evalAt({ country: 'RO' }, at(0)).warnings.map((w) => w.code)).toContain('rule_needs_verification');
    expect(evalAt({ country: 'CA', region: 'SK' }, at(0)).warnings.map((w) => w.code)).toContain('rule_needs_verification');
  });

  it('a jurisdiction without rules on file warns instead of pretending it is clear', () => {
    const r = evaluateFranchiseCompliance({ franchisor: { country: 'US' }, prospect: { country: 'JP' }, rules: RULES, now: at(0) });
    expect(r.warnings[0]!.code).toBe('no_rules_on_file');
    expect(r.disclaimer).toBe(RULES_DISCLAIMER);
  });
});

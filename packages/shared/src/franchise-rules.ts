/**
 * Franchise jurisdiction rules: a configurable, versioned table of disclosure, registration, waiting-period and
 * cooling-off requirements per jurisdiction (product plan, decision 4).
 *
 * THIS IS A COMPLIANCE AID, NOT LEGAL ADVICE. Every rule below was written from general knowledge of the cited
 * law, has `reviewedByCounsel: false` and `needsCounselReview: true`, and must be checked by franchise counsel in
 * each jurisdiction before launch. Where we are not sure of a detail the rule says "verify" instead of guessing.
 *
 * Codes: ISO 3166-1 alpha-2 country ("US", "AU") or ISO 3166-2 subdivision ("US-CA", "CA-ON").
 */

export type RuleConfidence = 'high' | 'medium' | 'low';
export type DayCount = 'calendar' | 'business';
export type RegistrationKind = 'none' | 'registration' | 'notice_filing' | 'exemption_filing' | 'voluntary' | 'verify';
/** statute: a franchise-specific law applies · no_statute: none (general law only) · verify: we are not sure. */
export type RuleStatus = 'statute' | 'no_statute' | 'verify';

export interface RuleSource {
  /** Name of the law or instrument. */
  law: string;
  /** Section / article citation. */
  citation?: string;
  url?: string;
}

export interface JurisdictionRule {
  code: string;
  country: string;
  /** Subdivision code part (e.g. "CA" in US-CA), null for country-level rules. */
  region: string | null;
  name: string;
  status: RuleStatus;
  /** Ruleset version; a new version is added when the rule changes (old versions are kept). */
  version: string;
  /** Date (YYYY-MM-DD) from which this version applies. */
  effectiveFrom: string;
  effectiveTo: string | null;
  sources: RuleSource[];
  disclosure: {
    required: boolean;
    /** What the disclosure document is called locally. */
    document: string | null;
    /** Minimum time between the signed receipt of the disclosure and signing a binding agreement. */
    minDaysBeforeSigning: number | null;
    /** Minimum time between the signed receipt and any payment to the franchisor. */
    minDaysBeforePayment: number | null;
    dayCount: DayCount;
    /** Days the final agreement must be held when the franchisor unilaterally and materially changed its terms (FTC rule). */
    changedTermsDays?: number | null;
    note?: string;
  };
  registration: {
    kind: RegistrationKind;
    /** True when the franchisor must be registered / filed before offering or selling in the jurisdiction. */
    beforeOffer: boolean;
    authority?: string;
    note?: string;
  };
  coolingOff: { days: number; from: 'agreement_or_payment' | 'agreement'; note?: string } | null;
  /** Agreement / disclosure language requirements, when known. */
  language: string | null;
  /** Renewal, non-renewal or termination notice requirements, when known. */
  renewalTermination: string | null;
  /** Document keys the franchisor must give (see REQUIRED_DOCUMENT_LABELS). */
  requiredDocuments: string[];
  /** Also applies when the franchisor is located in (offers from) this jurisdiction. Verify per law. */
  appliesWhenFranchisorHere?: boolean;
  notes: string[];
  /** Points we are not sure about and counsel must confirm. */
  verify: string[];
  confidence: RuleConfidence;
  /** Defaults to false for every shipped rule; set only when franchise counsel has reviewed this version. */
  reviewedByCounsel: boolean;
  needsCounselReview: boolean;
}

export const RULES_DISCLAIMER =
  'Compliance aid, not legal advice. These rules were prepared from public sources, have not been reviewed by franchise counsel and may be incomplete or out of date. Confirm the requirements for each jurisdiction with qualified counsel before offering or selling a franchise.';

export const REQUIRED_DOCUMENT_LABELS: Record<string, string> = {
  fdd: 'Franchise Disclosure Document (FDD)',
  fdd_receipt: 'Signed FDD receipt (Item 23)',
  state_addendum: 'State addendum / state-specific cover pages',
  final_agreement: 'Franchise agreement in the form to be signed',
  ca_disclosure_document: 'Provincial disclosure document (with financial statements)',
  ca_receipt: 'Signed acknowledgement of receipt',
  au_disclosure_document: 'Disclosure document',
  au_key_facts_sheet: 'Key facts sheet (verify)',
  au_information_statement: 'Information statement',
  au_code_copy: 'Copy of the Franchising Code',
  au_advice_statement: 'Statement of legal, business and accounting advice (or waiver)',
  fr_dip: 'Document d’information précontractuelle (DIP)',
  it_disclosure: 'Disclosure package with complete copy of the contract',
  es_disclosure: 'Pre-contractual information in writing',
  be_disclosure: 'Draft agreement and separate disclosure document',
  br_cof: 'Circular de Oferta de Franquia (COF)',
  mx_cof: 'Circular de Oferta de Franquicia (COF)',
  ro_information: 'Pre-contractual information (verify)',
  disclosure_receipt: 'Signed disclosure receipt',
};

const BASE = { reviewedByCounsel: false as const, needsCounselReview: true as const, effectiveTo: null };
const V = '2026.1';

const noStatute = (code: string, country: string, name: string, notes: string[], sources: RuleSource[], confidence: RuleConfidence, extra: Partial<JurisdictionRule> = {}): JurisdictionRule => ({
  ...BASE, code, country, region: null, name, status: 'no_statute', version: V, effectiveFrom: '2000-01-01', sources,
  disclosure: { required: false, document: null, minDaysBeforeSigning: null, minDaysBeforePayment: null, dayCount: 'calendar' },
  registration: { kind: 'none', beforeOffer: false }, coolingOff: null, language: null, renewalTermination: null, requiredDocuments: [], notes, verify: [], confidence, ...extra,
});

/** US registration (or notice-filing) states. Disclosure timing follows the FTC rule unless noted. */
const usState = (
  region: string, name: string, law: string, citation: string,
  o: { kind?: RegistrationKind; days?: number; dayCount?: DayCount; authority?: string; renewalTermination?: string | null; notes?: string[]; verify?: string[]; confidence?: RuleConfidence; franchisorHere?: boolean; disclosureNote?: string },
): JurisdictionRule => ({
  ...BASE, code: `US-${region}`, country: 'US', region, name, status: 'statute', version: V, effectiveFrom: '2008-07-01',
  sources: [{ law, citation }],
  disclosure: { required: true, document: 'FDD with state addendum', minDaysBeforeSigning: o.days ?? 14, minDaysBeforePayment: o.days ?? 14, dayCount: o.dayCount ?? 'calendar', note: o.disclosureNote },
  registration: { kind: o.kind ?? 'registration', beforeOffer: (o.kind ?? 'registration') !== 'none', authority: o.authority },
  coolingOff: null, language: null, renewalTermination: o.renewalTermination ?? null,
  requiredDocuments: ['fdd', 'state_addendum', 'fdd_receipt'], appliesWhenFranchisorHere: o.franchisorHere,
  notes: o.notes ?? [], verify: o.verify ?? ['Renewal of the registration or filing each year and amendment after material changes.'], confidence: o.confidence ?? 'medium',
});

const caProvince = (region: string, name: string, law: string, citation: string, confidence: RuleConfidence = 'high', extra: Partial<JurisdictionRule> = {}): JurisdictionRule => ({
  ...BASE, code: `CA-${region}`, country: 'CA', region, name, status: 'statute', version: V, effectiveFrom: '2000-01-01',
  sources: [{ law, citation }],
  disclosure: { required: true, document: 'Disclosure document', minDaysBeforeSigning: 14, minDaysBeforePayment: 14, dayCount: 'calendar', note: 'The disclosure document must be delivered as one document at one time, at least 14 days before signing any agreement or paying any consideration.' },
  registration: { kind: 'none', beforeOffer: false, note: 'No registration or filing.' },
  coolingOff: null, language: null, renewalTermination: null,
  requiredDocuments: ['ca_disclosure_document', 'ca_receipt'],
  notes: ['Rescission: generally within 60 days after receiving a late or deficient disclosure document, or within 2 years of the agreement if none was given.'],
  verify: ['Rescission periods and the content of the disclosure document (financial statements, prescribed statements).'],
  confidence, ...extra,
});

export const DEFAULT_JURISDICTION_RULES: JurisdictionRule[] = [
  /* ----------------------------- United States ----------------------------- */
  {
    ...BASE, code: 'US', country: 'US', region: null, name: 'United States (federal)', status: 'statute', version: V, effectiveFrom: '2007-07-01',
    sources: [{ law: 'FTC Franchise Rule', citation: '16 CFR Part 436', url: 'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-436' }],
    disclosure: {
      required: true, document: 'Franchise Disclosure Document (FDD)', minDaysBeforeSigning: 14, minDaysBeforePayment: 14, dayCount: 'calendar', changedTermsDays: 7,
      note: 'FDD at least 14 calendar days before the prospect signs a binding agreement or makes any payment. If the franchisor unilaterally and materially changes the agreement terms, the completed agreement must be given at least 7 calendar days before signing.',
    },
    registration: { kind: 'none', beforeOffer: false, note: 'No federal registration. Some states require registration or filing (see state rules).' },
    coolingOff: null, language: null, renewalTermination: null,
    requiredDocuments: ['fdd', 'fdd_receipt', 'final_agreement'],
    notes: ['Applies to franchises offered or sold in the United States. State law may add requirements.', 'Exemptions (e.g. large investment, sophisticated investor, fractional franchise) are not modelled.'],
    verify: ['Whether an exemption applies to a particular sale.'],
    confidence: 'high',
  },
  usState('CA', 'California', 'California Franchise Investment Law', 'Cal. Corp. Code §31000 et seq.', {
    authority: 'Department of Financial Protection and Innovation (DFPI)', franchisorHere: true,
    renewalTermination: 'California Franchise Relations Act (Bus. & Prof. Code §20020 et seq.): termination needs good cause and, in most cases, notice with at least 60 days to cure; non-renewal needs at least 180 days’ notice.',
    confidence: 'medium',
  }),
  usState('HI', 'Hawaii', 'Hawaii Franchise Investment Law', 'Haw. Rev. Stat. ch. 482E', {
    authority: 'Department of Commerce and Consumer Affairs', confidence: 'low',
    verify: ['State-specific disclosure timing (historically 7 days before sale); the FTC 14-day period is applied here as the minimum.', 'Registration renewal and amendment rules.'],
  }),
  usState('IL', 'Illinois', 'Illinois Franchise Disclosure Act of 1987', '815 ILCS 705', {
    authority: 'Attorney General', franchisorHere: true,
    renewalTermination: 'Termination requires good cause with notice and a reasonable cure period (up to 30 days); non-renewal requires 6 months’ notice or compensation, in some cases (815 ILCS 705/19–20). Verify.',
  }),
  usState('IN', 'Indiana', 'Indiana Franchise Act', 'Ind. Code §23-2-2.5', {
    authority: 'Securities Division', confidence: 'low',
    verify: ['Whether Indiana currently requires registration or a notice filing, and any state-specific disclosure period.'],
  }),
  usState('MD', 'Maryland', 'Maryland Franchise Registration and Disclosure Law', 'Md. Code, Bus. Reg. §14-201 et seq.', { authority: 'Securities Commissioner', franchisorHere: true }),
  usState('MI', 'Michigan', 'Michigan Franchise Investment Law', 'MCL §445.1501 et seq.', {
    kind: 'notice_filing', days: 10, dayCount: 'business', authority: 'Attorney General',
    disclosureNote: 'State law: 10 business days before signing or payment. The FTC 14 calendar days also applies; the later date wins.',
  }),
  usState('MN', 'Minnesota', 'Minnesota Franchise Act', 'Minn. Stat. ch. 80C', {
    authority: 'Department of Commerce',
    renewalTermination: 'Termination: 90 days’ notice with 60 days to cure; non-renewal: 180 days’ notice (Minn. Stat. §80C.14). Verify.',
  }),
  usState('NY', 'New York', 'New York Franchise Sales Act', 'N.Y. Gen. Bus. Law Art. 33, §680 et seq.', {
    days: 10, dayCount: 'business', authority: 'Attorney General (Investor Protection Bureau)', franchisorHere: true,
    disclosureNote: 'State law: at the earlier of the first personal meeting or 10 business days before signing or payment. The FTC 14 calendar days also applies.',
    notes: ['Give the FDD no later than the first personal meeting to discuss the sale.'],
  }),
  usState('ND', 'North Dakota', 'North Dakota Franchise Investment Law', 'N.D. Cent. Code ch. 51-19', { authority: 'Securities Department' }),
  usState('RI', 'Rhode Island', 'Rhode Island Franchise Investment Act', 'R.I. Gen. Laws §19-28.1', { authority: 'Department of Business Regulation' }),
  usState('SD', 'South Dakota', 'South Dakota Franchises for Brand-Name Goods and Services', 'S.D. Codified Laws ch. 37-5B', { authority: 'Division of Insurance – Securities Regulation' }),
  usState('VA', 'Virginia', 'Virginia Retail Franchising Act', 'Va. Code §13.1-557 et seq.', {
    authority: 'State Corporation Commission', franchisorHere: true, confidence: 'low',
    verify: ['State-specific disclosure period (historically 10 business days); the FTC 14-day period is applied as the minimum.'],
  }),
  usState('WA', 'Washington', 'Washington Franchise Investment Protection Act', 'RCW 19.100', {
    authority: 'Department of Financial Institutions', franchisorHere: true,
    renewalTermination: 'Franchisee bill of rights (RCW 19.100.180): termination needs good cause with notice and a reasonable cure opportunity. Verify.',
  }),
  usState('WI', 'Wisconsin', 'Wisconsin Franchise Investment Law', 'Wis. Stat. ch. 553', {
    kind: 'notice_filing', authority: 'Department of Financial Institutions',
    renewalTermination: 'Wisconsin Fair Dealership Law (Wis. Stat. ch. 135): 90 days’ written notice of termination or non-renewal with 60 days to cure. Verify applicability.',
  }),
  // Filing / notice states (business-opportunity laws with a franchise exemption that may need a filing).
  ...([
    ['FL', 'Florida', 'Florida Franchise Act / Sale of Business Opportunities Act', 'Fla. Stat. §817.416; §559.80 et seq.'],
    ['KY', 'Kentucky', 'Kentucky Business Opportunity Act', 'Ky. Rev. Stat. §367.801 et seq.'],
    ['NE', 'Nebraska', 'Nebraska Seller-Assisted Marketing Plan Act', 'Neb. Rev. Stat. §59-1701 et seq.'],
    ['TX', 'Texas', 'Texas Business Opportunity Act', 'Tex. Bus. & Com. Code ch. 51'],
    ['UT', 'Utah', 'Utah Business Opportunity Disclosure Act', 'Utah Code §13-15-1 et seq.'],
  ] as const).map(([region, name, law, citation]): JurisdictionRule => ({
    ...BASE, code: `US-${region}`, country: 'US', region, name, status: 'statute', version: V, effectiveFrom: '2008-07-01',
    sources: [{ law, citation }],
    disclosure: { required: true, document: 'FDD (FTC rule)', minDaysBeforeSigning: 14, minDaysBeforePayment: 14, dayCount: 'calendar', note: 'Disclosure timing follows the FTC rule.' },
    registration: { kind: 'exemption_filing', beforeOffer: true, note: 'A one-time or annual exemption notice may be needed to rely on the franchise exemption from the business-opportunity law. Verify.' },
    coolingOff: null, language: null, renewalTermination: null, requiredDocuments: ['fdd', 'fdd_receipt'],
    notes: ['Filing/notice state: not a full franchise registration state.'],
    verify: ['Whether an exemption filing is required for this franchise and how often it must be renewed.'],
    confidence: 'low',
  })),
  {
    ...BASE, code: 'US-OR', country: 'US', region: 'OR', name: 'Oregon', status: 'statute', version: V, effectiveFrom: '2008-07-01',
    sources: [{ law: 'Oregon Franchise Transactions law', citation: 'Or. Rev. Stat. §650.005 et seq.' }],
    disclosure: { required: true, document: 'FDD (FTC rule)', minDaysBeforeSigning: 14, minDaysBeforePayment: 14, dayCount: 'calendar' },
    registration: { kind: 'none', beforeOffer: false, note: 'Disclosure state without registration.' },
    coolingOff: null, language: null, renewalTermination: null, requiredDocuments: ['fdd', 'fdd_receipt'], notes: [], verify: ['State disclosure timing.'], confidence: 'low',
  },

  /* --------------------------------- Canada -------------------------------- */
  noStatute('CA', 'CA', 'Canada (federal)', ['No federal franchise statute. Provincial disclosure laws apply in Alberta, British Columbia, Manitoba, New Brunswick, Ontario and Prince Edward Island.'], [{ law: 'No federal franchise statute' }], 'high'),
  caProvince('AB', 'Alberta', 'Franchises Act (Alberta)', 'RSA 2000, c F-23', 'high', { notes: ['No registration (repealed in 1995).', 'Rescission: generally within 60 days of a late or deficient disclosure, or 2 years if none was given.'] }),
  caProvince('BC', 'British Columbia', 'Franchises Act (British Columbia)', 'SBC 2015, c 35'),
  caProvince('MB', 'Manitoba', 'The Franchises Act (Manitoba)', 'CCSM c F156'),
  caProvince('NB', 'New Brunswick', 'Franchises Act (New Brunswick)', 'SNB 2007, c F-23.5'),
  caProvince('ON', 'Ontario', 'Arthur Wishart Act (Franchise Disclosure), 2000', 'SO 2000, c 3'),
  caProvince('PE', 'Prince Edward Island', 'Franchises Act (Prince Edward Island)', 'RSPEI 1988, c F-14.1'),
  {
    ...BASE, code: 'CA-SK', country: 'CA', region: 'SK', name: 'Saskatchewan', status: 'verify', version: V, effectiveFrom: '2025-01-01',
    sources: [{ law: 'Franchise disclosure legislation (verify)', citation: 'verify' }],
    disclosure: { required: false, document: null, minDaysBeforeSigning: null, minDaysBeforePayment: null, dayCount: 'calendar', note: 'Verify whether Saskatchewan franchise disclosure legislation is in force and what it requires.' },
    registration: { kind: 'verify', beforeOffer: false }, coolingOff: null, language: null, renewalTermination: null, requiredDocuments: [],
    notes: [], verify: ['Whether a Saskatchewan franchise disclosure statute is in force, and its disclosure period.'], confidence: 'low',
  },
  noStatute('CA-QC', 'CA', 'Quebec', ['No franchise disclosure statute; Civil Code duties of good faith and information apply.'], [{ law: 'Civil Code of Québec' }, { law: 'Charter of the French Language', citation: 'CQLR c C-11' }], 'medium', {
    region: 'QC', language: 'Contracts of adhesion must be provided in French first; the parties may then choose another language. Verify the current Charter requirements (amended by Bill 96).',
    verify: ['French-language requirements for the agreement and disclosure documents.'],
  }),

  /* ------------------------------- Australia ------------------------------- */
  {
    ...BASE, code: 'AU', country: 'AU', region: null, name: 'Australia', status: 'statute', version: V, effectiveFrom: '2025-04-01',
    sources: [
      { law: 'Competition and Consumer (Industry Codes—Franchising) Regulation 2024 (Franchising Code of Conduct)', url: 'https://www.legislation.gov.au/' },
      { law: 'Competition and Consumer (Industry Codes—Franchising) Regulation 2014 (previous code)' },
    ],
    disclosure: {
      required: true, document: 'Disclosure document, information statement and agreement in its final form', minDaysBeforeSigning: 14, minDaysBeforePayment: 14, dayCount: 'calendar',
      note: 'Disclosure document, a copy of the agreement in the form to be signed and the other prescribed documents at least 14 days before entering the agreement or making a non-refundable payment.',
    },
    registration: { kind: 'none', beforeOffer: false, note: 'Franchisors must keep their details current on the Franchise Disclosure Register. Verify the timing.' },
    coolingOff: { days: 14, from: 'agreement_or_payment', note: '14 days after the earlier of entering the agreement or making any payment under it.' },
    language: null,
    renewalTermination: 'End-of-term notice: the franchisor must tell the franchisee whether it intends to extend or renew, at least 6 months before the term ends (shorter for short terms). Verify under the 2024 regulation.',
    requiredDocuments: ['au_information_statement', 'au_disclosure_document', 'au_key_facts_sheet', 'au_code_copy', 'final_agreement', 'au_advice_statement', 'disclosure_receipt'],
    notes: ['The franchisee must give statements that it received legal, business and accounting advice, or that it chose not to.'],
    verify: ['Key facts sheet requirements and commencement date under the 2024 regulation.', 'Franchise Disclosure Register obligations.'],
    confidence: 'medium',
  },
  noStatute('NZ', 'NZ', 'New Zealand', ['No franchise-specific statute. The Franchise Association of New Zealand Code of Practice binds its members; the Fair Trading Act 1986 prohibits misleading conduct.'], [{ law: 'Fair Trading Act 1986' }, { law: 'Franchise Association of New Zealand Code of Practice (voluntary)' }], 'high'),

  /* --------------------------------- Europe -------------------------------- */
  noStatute('GB', 'GB', 'United Kingdom', ['No franchise statute. The British Franchise Association Code of Ethics binds its members; general contract and competition law applies.'], [{ law: 'No franchise statute' }, { law: 'British Franchise Association Code of Ethics (voluntary)' }], 'high'),
  {
    ...BASE, code: 'FR', country: 'FR', region: null, name: 'France', status: 'statute', version: V, effectiveFrom: '1991-04-04',
    sources: [{ law: 'Loi Doubin (Law no. 89-1008 of 31 December 1989)', citation: 'Code de commerce art. L330-3 and R330-1' }],
    disclosure: { required: true, document: 'Document d’information précontractuelle (DIP)', minDaysBeforeSigning: 20, minDaysBeforePayment: 20, dayCount: 'calendar', note: 'DIP and draft contract at least 20 days before signing or any payment.' },
    registration: { kind: 'none', beforeOffer: false }, coolingOff: null, language: null, renewalTermination: null,
    requiredDocuments: ['fr_dip', 'final_agreement', 'disclosure_receipt'], notes: [], verify: ['French-language requirements for the documents.'], confidence: 'high',
  },
  {
    ...BASE, code: 'IT', country: 'IT', region: null, name: 'Italy', status: 'statute', version: V, effectiveFrom: '2004-05-25',
    sources: [{ law: 'Law no. 129 of 6 May 2004 (affiliazione commerciale)', citation: 'art. 4' }],
    disclosure: { required: true, document: 'Complete copy of the contract with the prescribed disclosure', minDaysBeforeSigning: 30, minDaysBeforePayment: null, dayCount: 'calendar', note: 'Complete copy of the contract and disclosures at least 30 days before signing.' },
    registration: { kind: 'none', beforeOffer: false }, coolingOff: null, language: null,
    renewalTermination: 'Fixed-term agreements must last long enough to recover the investment and at least 3 years. Verify.',
    requiredDocuments: ['it_disclosure', 'final_agreement', 'disclosure_receipt'], notes: [], verify: ['Whether payments before the 30 days are restricted.', 'Translation requirements for foreign franchisors.'], confidence: 'high',
  },
  {
    ...BASE, code: 'ES', country: 'ES', region: null, name: 'Spain', status: 'statute', version: V, effectiveFrom: '2010-03-27',
    sources: [{ law: 'Ley 7/1996 de Ordenación del Comercio Minorista', citation: 'art. 62' }, { law: 'Real Decreto 201/2010' }, { law: 'Real Decreto-ley 20/2018 (registry)' }],
    disclosure: { required: true, document: 'Pre-contractual information', minDaysBeforeSigning: 20, minDaysBeforePayment: 20, dayCount: 'calendar', note: 'Written information at least 20 days before signing the agreement or a pre-contract, or making any payment.' },
    registration: { kind: 'voluntary', beforeOffer: false, authority: 'Registro de Franquiciadores', note: 'The franchisor registry exists, but the obligation to register before operating was removed in 2018. Verify.' },
    coolingOff: null, language: null, renewalTermination: null, requiredDocuments: ['es_disclosure', 'disclosure_receipt'], notes: [], verify: ['Current registry obligations.'], confidence: 'medium',
  },
  {
    ...BASE, code: 'BE', country: 'BE', region: null, name: 'Belgium', status: 'statute', version: V, effectiveFrom: '2006-02-01',
    sources: [{ law: 'Code of Economic Law, Book X, Title 2 (commercial partnership agreements; formerly the Law of 19 December 2005)' }],
    disclosure: { required: true, document: 'Draft agreement and separate disclosure document', minDaysBeforeSigning: 31, minDaysBeforePayment: 31, dayCount: 'calendar', note: 'At least one month before signing (modelled as 31 days to stay on the safe side).' },
    registration: { kind: 'none', beforeOffer: false }, coolingOff: null, language: null, renewalTermination: null,
    requiredDocuments: ['be_disclosure', 'final_agreement', 'disclosure_receipt'], notes: [], verify: ['Whether payments before the period are restricted; language requirements (regional).'], confidence: 'medium',
  },
  {
    ...BASE, code: 'RO', country: 'RO', region: null, name: 'Romania', status: 'verify', version: V, effectiveFrom: '1998-01-01',
    sources: [{ law: 'Government Ordinance no. 52/1997 on the legal regime of franchising (approved by Law no. 79/1998)' }],
    disclosure: { required: true, document: 'Pre-contractual information', minDaysBeforeSigning: null, minDaysBeforePayment: null, dayCount: 'calendar', note: 'Pre-contractual information is required. We do not know a fixed waiting period: verify.' },
    registration: { kind: 'none', beforeOffer: false }, coolingOff: null, language: null, renewalTermination: null,
    requiredDocuments: ['ro_information'], notes: [], verify: ['Any minimum period between information and signing.'], confidence: 'low',
  },

  /* ------------------------------ Latin America ---------------------------- */
  {
    ...BASE, code: 'BR', country: 'BR', region: null, name: 'Brazil', status: 'statute', version: V, effectiveFrom: '2020-03-26',
    sources: [{ law: 'Lei nº 13.966/2019 (Lei de Franquia)', citation: 'art. 2' }],
    disclosure: { required: true, document: 'Circular de Oferta de Franquia (COF)', minDaysBeforeSigning: 10, minDaysBeforePayment: 10, dayCount: 'calendar', note: 'COF at least 10 days before signing any agreement or paying any fee. Late or missing COF lets the franchisee seek annulment and a refund.' },
    registration: { kind: 'none', beforeOffer: false, note: 'Recording the agreement with INPI is needed for some effects (e.g. remittances abroad), not before offering.' },
    coolingOff: null, language: 'The COF must be in Portuguese. Verify translation requirements for the agreement.',
    renewalTermination: null, requiredDocuments: ['br_cof', 'disclosure_receipt'], notes: [], verify: ['Language requirements for the agreement.'], confidence: 'high',
  },
  {
    ...BASE, code: 'MX', country: 'MX', region: null, name: 'Mexico', status: 'statute', version: V, effectiveFrom: '2020-11-05',
    sources: [{ law: 'Ley Federal de Protección a la Propiedad Industrial (2020)', citation: 'art. 245' }],
    disclosure: { required: true, document: 'Circular de Oferta de Franquicia (COF)', minDaysBeforeSigning: 30, minDaysBeforePayment: null, dayCount: 'business', note: 'COF at least 30 business days before signing the agreement. Verify whether the period is in business or calendar days.' },
    registration: { kind: 'none', beforeOffer: false, note: 'Recording the franchise licence with IMPI is optional and gives effect against third parties.' },
    coolingOff: null, language: null, renewalTermination: null, requiredDocuments: ['mx_cof', 'disclosure_receipt'], notes: [], verify: ['Business vs calendar days for the 30-day period.'], confidence: 'medium',
  },

  /* ------------------------------- Middle East ----------------------------- */
  noStatute('AE', 'AE', 'United Arab Emirates', [
    'No specific franchise statute.',
    'If the franchise is registered as a commercial agency, Federal Law No. 3 of 2022 on Commercial Agencies can restrict termination and non-renewal. Structure agreements with local counsel.',
  ], [{ law: 'Federal Decree-Law No. 3 of 2022 Regulating Commercial Agencies' }, { law: 'Civil Transactions Law' }], 'medium', { verify: ['Whether the arrangement could be treated as a commercial agency.'] }),
];

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export interface ComplianceDelivery {
  id?: string;
  /** disclosure = disclosure package; agreement = agreement in the form to be signed. */
  kind: 'disclosure' | 'agreement';
  /** Jurisdiction codes the document covers ("US", "US-CA", "CA-ON"…). A country code covers its subdivisions. */
  jurisdictions: string[];
  deliveredAt: Date | null;
  receiptSignedAt: Date | null;
  /** Agreement only: the franchisor unilaterally and materially changed the terms (FTC 7-day rule). */
  materialChange?: boolean;
}

export interface ComplianceRegistration {
  jurisdiction: string;
  status: 'not_filed' | 'pending' | 'registered' | 'exempt' | 'expired';
  effectiveFrom?: Date | null;
  expiresAt?: Date | null;
}

export interface ComplianceInput {
  franchisor: { country: string; region?: string | null };
  prospect: { country: string; region?: string | null };
  rules: JurisdictionRule[];
  now?: Date;
  deliveries?: ComplianceDelivery[];
  registrations?: ComplianceRegistration[];
  agreementSignedAt?: Date | null;
  firstPaymentAt?: Date | null;
}

export type BlockerCode = 'disclosure_not_delivered' | 'receipt_not_signed' | 'waiting_period' | 'registration_required' | 'changed_terms_waiting' | 'agreement_not_delivered';

export interface Blocker {
  code: BlockerCode;
  ruleCode: string;
  message: string;
  /** When this blocker lifts on its own (waiting periods), ISO date-time. */
  until: string | null;
}

export interface ApplicableRule {
  rule: JurisdictionRule;
  basis: 'prospect_location' | 'franchisor_location';
}

export interface ComplianceStep {
  key: string;
  ruleCode: string;
  status: 'done' | 'pending' | 'blocked' | 'info';
  label: string;
  dueAt: string | null;
}

export interface ComplianceResult {
  disclaimer: string;
  prospectJurisdiction: string;
  applicable: Array<{ code: string; name: string; basis: ApplicableRule['basis']; version: string; status: RuleStatus; confidence: RuleConfidence; reviewedByCounsel: boolean; needsCounselReview: boolean }>;
  steps: ComplianceStep[];
  requiredDocuments: Array<{ key: string; label: string; ruleCodes: string[] }>;
  earliestSigningAt: string | null;
  earliestPaymentAt: string | null;
  canSign: boolean;
  canPay: boolean;
  signingBlockers: Blocker[];
  paymentBlockers: Blocker[];
  /** Not blocking, but someone must act or check (offer before registration, unknown jurisdiction, "verify" rules). */
  warnings: Array<{ code: string; ruleCode: string | null; message: string }>;
  coolingOffEndsAt: string | null;
}

const DAY = 86_400_000;

/** Next UTC midnight at or after `d` (a waiting period never ends part-way through a day). */
function ceilUtcDay(d: Date): Date {
  const m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return m === d.getTime() ? d : new Date(m + DAY);
}

/**
 * Earliest moment an act is allowed after `from` given a minimum number of days. Calendar days: full 24-hour days,
 * rounded up to the next UTC midnight. Business days: Monday–Friday only (public holidays are NOT excluded: verify).
 */
export function addWaitingDays(from: Date, days: number, count: DayCount): Date {
  if (count === 'calendar') return ceilUtcDay(new Date(from.getTime() + days * DAY));
  let d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d = new Date(d.getTime() + DAY);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return ceilUtcDay(d);
}

/** Rule versions in force at `at`, newest version per code. */
export function rulesInForce(rules: JurisdictionRule[], at: Date): JurisdictionRule[] {
  const day = at.toISOString().slice(0, 10);
  const best = new Map<string, JurisdictionRule>();
  for (const r of rules) {
    if (r.effectiveFrom > day || (r.effectiveTo && r.effectiveTo <= day)) continue;
    const cur = best.get(r.code);
    if (!cur || r.effectiveFrom > cur.effectiveFrom || (r.effectiveFrom === cur.effectiveFrom && r.version > cur.version)) best.set(r.code, r);
  }
  return [...best.values()];
}

export function jurisdictionCode(country: string, region?: string | null) {
  const c = country.toUpperCase();
  return region ? `${c}-${region.toUpperCase().replace(/^[A-Z]{2}-/, '')}` : c;
}

/** Rules that apply to an offer from `franchisor` to a prospect located at `prospect`. */
export function applicableRules(rules: JurisdictionRule[], franchisor: ComplianceInput['franchisor'], prospect: ComplianceInput['prospect'], at: Date): ApplicableRule[] {
  const inForce = rulesInForce(rules, at);
  const country = prospect.country.toUpperCase();
  const pCode = prospect.region ? jurisdictionCode(country, prospect.region) : null;
  const fCode = franchisor.region ? jurisdictionCode(franchisor.country, franchisor.region) : null;
  const out: ApplicableRule[] = [];
  for (const r of inForce) {
    if (r.code === country || (pCode && r.code === pCode)) out.push({ rule: r, basis: 'prospect_location' });
    else if (fCode && r.code === fCode && r.appliesWhenFranchisorHere && r.country === country) out.push({ rule: r, basis: 'franchisor_location' });
  }
  return out.sort((a, b) => a.rule.code.length - b.rule.code.length || a.rule.code.localeCompare(b.rule.code));
}

const covers = (docJurisdictions: string[], ruleCode: string) => {
  const country = ruleCode.slice(0, 2);
  return docJurisdictions.some((j) => j.toUpperCase() === ruleCode || j.toUpperCase() === country);
};

const latest = <T,>(xs: T[], key: (x: T) => Date | null) => xs.filter((x) => key(x)).sort((a, b) => key(b)!.getTime() - key(a)!.getTime())[0];

/**
 * Evaluate where a prospect stands against every applicable rule: required steps and documents, the earliest
 * allowed signing and payment dates, and the reasons signing or payment is blocked right now.
 * Conservative by design: the clock starts at the signed receipt (not at sending), and the latest date wins.
 */
export function evaluateFranchiseCompliance(input: ComplianceInput): ComplianceResult {
  const now = input.now ?? new Date();
  const deliveries = input.deliveries ?? [];
  const regs = input.registrations ?? [];
  const applicable = applicableRules(input.rules, input.franchisor, input.prospect, now);
  const signingBlockers: Blocker[] = [];
  const paymentBlockers: Blocker[] = [];
  const warnings: ComplianceResult['warnings'] = [];
  const steps: ComplianceStep[] = [];
  const docs = new Map<string, Set<string>>();
  let earliestSign: Date | null = null;
  let earliestPay: Date | null = null;
  let coolingOffEndsAt: Date | null = null;
  const later = (a: Date | null, b: Date) => (!a || b > a ? b : a);
  const prospectCode = jurisdictionCode(input.prospect.country, input.prospect.region);

  if (!applicable.length) {
    warnings.push({ code: 'no_rules_on_file', ruleCode: null, message: `No franchise rules on file for ${prospectCode}. Get advice from local counsel before offering a franchise there.` });
  }
  if (input.prospect.country.toUpperCase() !== input.franchisor.country.toUpperCase()) {
    warnings.push({ code: 'cross_border', ruleCode: null, message: 'Cross-border offer: tax, currency, trademark and foreign-investment rules may also apply. Confirm with counsel.' });
  }

  for (const { rule: r } of applicable) {
    for (const d of r.requiredDocuments) {
      if (!docs.has(d)) docs.set(d, new Set());
      docs.get(d)!.add(r.code);
    }
    if (r.status === 'verify') warnings.push({ code: 'rule_needs_verification', ruleCode: r.code, message: `${r.name}: requirements are uncertain. Verify with counsel before offering.` });
    for (const v of r.verify) warnings.push({ code: 'verify', ruleCode: r.code, message: `${r.name}: verify — ${v}` });

    // Registration before offer or sale.
    if (r.registration.beforeOffer && r.registration.kind !== 'none' && r.registration.kind !== 'voluntary' && r.registration.kind !== 'verify') {
      const reg = regs.find((g) => g.jurisdiction.toUpperCase() === r.code);
      const ok = !!reg && (reg.status === 'registered' || reg.status === 'exempt') && (!reg.effectiveFrom || reg.effectiveFrom <= now) && (!reg.expiresAt || reg.expiresAt > now);
      steps.push({ key: 'registration', ruleCode: r.code, status: ok ? 'done' : 'blocked', label: `${r.name}: ${r.registration.kind === 'registration' ? 'registration' : 'filing'} in effect`, dueAt: null });
      if (!ok) {
        const msg = `${r.name} requires the franchisor’s ${r.registration.kind === 'registration' ? 'registration' : 'filing'}${r.registration.authority ? ` with ${r.registration.authority}` : ''} to be in effect before offering or selling. Status: ${reg?.status ?? 'not filed'}.`;
        signingBlockers.push({ code: 'registration_required', ruleCode: r.code, message: msg, until: null });
        paymentBlockers.push({ code: 'registration_required', ruleCode: r.code, message: msg, until: null });
        warnings.push({ code: 'offer_before_registration', ruleCode: r.code, message: `Do not send disclosure documents or make offers in ${r.name} until the ${r.registration.kind === 'registration' ? 'registration' : 'filing'} is in effect.` });
      }
    }

    // Disclosure and waiting periods.
    if (r.disclosure.required) {
      const covering = deliveries.filter((d) => d.kind === 'disclosure' && covers(d.jurisdictions, r.code));
      const delivered = latest(covering, (d) => d.deliveredAt);
      const receipted = latest(covering, (d) => d.receiptSignedAt);
      steps.push({ key: 'disclosure_delivered', ruleCode: r.code, status: delivered ? 'done' : 'pending', label: `${r.name}: deliver ${r.disclosure.document ?? 'disclosure document'}`, dueAt: null });
      steps.push({ key: 'receipt_signed', ruleCode: r.code, status: receipted ? 'done' : 'pending', label: `${r.name}: signed receipt`, dueAt: null });
      if (!delivered) {
        const msg = `${r.name}: the ${r.disclosure.document ?? 'disclosure document'} has not been delivered.`;
        signingBlockers.push({ code: 'disclosure_not_delivered', ruleCode: r.code, message: msg, until: null });
        if (r.disclosure.minDaysBeforePayment != null) paymentBlockers.push({ code: 'disclosure_not_delivered', ruleCode: r.code, message: msg, until: null });
      } else if (!receipted) {
        const msg = `${r.name}: the prospect has not signed the disclosure receipt. The waiting period starts when the receipt is signed.`;
        signingBlockers.push({ code: 'receipt_not_signed', ruleCode: r.code, message: msg, until: null });
        if (r.disclosure.minDaysBeforePayment != null) paymentBlockers.push({ code: 'receipt_not_signed', ruleCode: r.code, message: msg, until: null });
      } else {
        const start = receipted.receiptSignedAt!;
        if (r.disclosure.minDaysBeforeSigning != null) {
          const at = addWaitingDays(start, r.disclosure.minDaysBeforeSigning, r.disclosure.dayCount);
          earliestSign = later(earliestSign, at);
          const waiting = now < at;
          steps.push({ key: 'waiting_period_signing', ruleCode: r.code, status: waiting ? 'blocked' : 'done', label: `${r.name}: ${r.disclosure.minDaysBeforeSigning} ${r.disclosure.dayCount} days before signing`, dueAt: at.toISOString() });
          if (waiting) signingBlockers.push({ code: 'waiting_period', ruleCode: r.code, message: `${r.name}: the agreement cannot be signed until ${at.toISOString().slice(0, 10)} (${r.disclosure.minDaysBeforeSigning} ${r.disclosure.dayCount} days after the signed disclosure receipt).`, until: at.toISOString() });
        }
        if (r.disclosure.minDaysBeforePayment != null) {
          const at = addWaitingDays(start, r.disclosure.minDaysBeforePayment, r.disclosure.dayCount);
          earliestPay = later(earliestPay, at);
          const waiting = now < at;
          steps.push({ key: 'waiting_period_payment', ruleCode: r.code, status: waiting ? 'blocked' : 'done', label: `${r.name}: ${r.disclosure.minDaysBeforePayment} ${r.disclosure.dayCount} days before any payment`, dueAt: at.toISOString() });
          if (waiting) paymentBlockers.push({ code: 'waiting_period', ruleCode: r.code, message: `${r.name}: no payment may be taken until ${at.toISOString().slice(0, 10)} (${r.disclosure.minDaysBeforePayment} ${r.disclosure.dayCount} days after the signed disclosure receipt).`, until: at.toISOString() });
        }
      }
      // FTC: unilaterally and materially changed terms need the final agreement 7 days before signing.
      if (r.disclosure.changedTermsDays) {
        const changed = latest(deliveries.filter((d) => d.kind === 'agreement' && d.materialChange && covers(d.jurisdictions, r.code)), (d) => d.deliveredAt);
        if (changed?.deliveredAt) {
          const at = addWaitingDays(changed.deliveredAt, r.disclosure.changedTermsDays, 'calendar');
          earliestSign = later(earliestSign, at);
          if (now < at) signingBlockers.push({ code: 'changed_terms_waiting', ruleCode: r.code, message: `${r.name}: the franchisor changed material terms; the final agreement must be held ${r.disclosure.changedTermsDays} calendar days, until ${at.toISOString().slice(0, 10)}.`, until: at.toISOString() });
        }
      }
      if (r.requiredDocuments.includes('final_agreement')) {
        const ag = latest(deliveries.filter((d) => d.kind === 'agreement' && covers(d.jurisdictions, r.code)), (d) => d.deliveredAt);
        steps.push({ key: 'final_agreement', ruleCode: r.code, status: ag ? 'done' : 'pending', label: `${r.name}: agreement in the form to be signed delivered`, dueAt: null });
      }
    }

    if (r.coolingOff) {
      const startCooling = r.coolingOff.from === 'agreement_or_payment'
        ? [input.agreementSignedAt, input.firstPaymentAt].filter((x): x is Date => !!x).sort((a, b) => a.getTime() - b.getTime())[0]
        : input.agreementSignedAt ?? undefined;
      if (startCooling) {
        const end = addWaitingDays(startCooling, r.coolingOff.days, 'calendar');
        coolingOffEndsAt = later(coolingOffEndsAt, end);
        steps.push({ key: 'cooling_off', ruleCode: r.code, status: now < end ? 'pending' : 'done', label: `${r.name}: ${r.coolingOff.days}-day cooling-off period`, dueAt: end.toISOString() });
      } else {
        steps.push({ key: 'cooling_off', ruleCode: r.code, status: 'info', label: `${r.name}: ${r.coolingOff.days}-day cooling-off period after signing or payment`, dueAt: null });
      }
    }
  }

  return {
    disclaimer: RULES_DISCLAIMER,
    prospectJurisdiction: prospectCode,
    applicable: applicable.map(({ rule: r, basis }) => ({ code: r.code, name: r.name, basis, version: r.version, status: r.status, confidence: r.confidence, reviewedByCounsel: r.reviewedByCounsel, needsCounselReview: r.needsCounselReview })),
    steps,
    requiredDocuments: [...docs.entries()].map(([key, codes]) => ({ key, label: REQUIRED_DOCUMENT_LABELS[key] ?? key, ruleCodes: [...codes] })),
    earliestSigningAt: earliestSign?.toISOString() ?? null,
    earliestPaymentAt: earliestPay?.toISOString() ?? null,
    canSign: signingBlockers.length === 0,
    canPay: paymentBlockers.length === 0,
    signingBlockers,
    paymentBlockers,
    warnings,
    coolingOffEndsAt: coolingOffEndsAt?.toISOString() ?? null,
  };
}

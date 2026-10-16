/**
 * Franchise development (Sales workspace) and new-location onboarding: stages, sources, default cadences and the
 * onboarding project template. Jurisdiction rules live in ./franchise-rules.ts.
 */
import { z } from 'zod';

export const FRANCHISE_STAGES = [
  'enquiry', 'qualified', 'discovery_call', 'disclosure_sent', 'disclosure_receipt_signed', 'waiting_period',
  'agreement_sent', 'signed', 'onboarding', 'opened', 'lost',
] as const;
export type FranchiseStage = (typeof FRANCHISE_STAGES)[number];

/** Stages a person can move a prospect to by hand. The rest follow from events (receipt signed, e-signature, go-live). */
export const MANUAL_STAGES: readonly FranchiseStage[] = ['enquiry', 'qualified', 'discovery_call', 'lost'];

export const PROSPECT_SOURCES = ['website', 'brand_site', 'referral', 'ads', 'campaign', 'broker', 'event', 'franchise_portal', 'other'] as const;
export type ProspectSource = (typeof PROSPECT_SOURCES)[number];

/** `under_development` (agreement signed, location being built) and `open` follow the pipeline and agreements. */
export const TERRITORY_STATUSES = ['available', 'reserved', 'sold', 'under_development', 'open', 'unavailable'] as const;
export type TerritoryStatus = (typeof TERRITORY_STATUSES)[number];

export const REGISTRATION_STATUSES = ['not_filed', 'pending', 'registered', 'exempt', 'expired'] as const;

export const stageIndex = (s: FranchiseStage) => FRANCHISE_STAGES.indexOf(s);

export interface CadenceStepDef {
  /** Days after the prospect enters the stage. */
  offsetDays: number;
  kind: 'email' | 'call' | 'task';
  title: string;
  /** Email template key for `email` steps. */
  templateKey?: string;
}

export interface CadenceDef {
  stage: FranchiseStage;
  name: string;
  steps: CadenceStepDef[];
}

/** Default follow-up sequences, created for an organisation the first time it opens its cadences. Editable. */
export const DEFAULT_CADENCES: CadenceDef[] = [
  { stage: 'enquiry', name: 'New enquiry follow-up', steps: [
    { offsetDays: 0, kind: 'email', title: 'Send welcome and next steps', templateKey: 'enquiry_welcome' },
    { offsetDays: 1, kind: 'call', title: 'Intro call to qualify' },
    { offsetDays: 4, kind: 'email', title: 'Follow up if no reply', templateKey: 'enquiry_follow_up' },
  ] },
  { stage: 'qualified', name: 'Book discovery call', steps: [
    { offsetDays: 0, kind: 'email', title: 'Invite to discovery call', templateKey: 'discovery_invite' },
    { offsetDays: 3, kind: 'task', title: 'Check territory availability' },
  ] },
  { stage: 'disclosure_sent', name: 'Disclosure receipt chase', steps: [
    { offsetDays: 2, kind: 'email', title: 'Remind to sign the disclosure receipt', templateKey: 'receipt_reminder' },
    { offsetDays: 5, kind: 'call', title: 'Call about the disclosure document' },
  ] },
  { stage: 'waiting_period', name: 'Waiting period check-ins', steps: [
    { offsetDays: 3, kind: 'call', title: 'Answer questions from the disclosure review' },
    { offsetDays: 10, kind: 'task', title: 'Prepare agreement for signature' },
  ] },
  { stage: 'agreement_sent', name: 'Agreement signature chase', steps: [
    { offsetDays: 3, kind: 'email', title: 'Remind to sign the agreement', templateKey: 'agreement_reminder' },
  ] },
];

export const DEFAULT_EMAIL_TEMPLATES: Array<{ key: string; name: string; subject: string; body: string }> = [
  { key: 'enquiry_welcome', name: 'Welcome', subject: 'Thanks for your interest in a {{brand}} franchise', body: 'Hi {{first_name}},\n\nThanks for your enquiry about owning a {{brand}} franchise. {{owner_name}} from our development team will call you shortly to talk about your goals and the territory you are interested in.\n\n{{brand}} franchise development' },
  { key: 'enquiry_follow_up', name: 'Follow-up', subject: 'Following up on your {{brand}} enquiry', body: 'Hi {{first_name}},\n\nWe tried to reach you about your franchise enquiry. Reply to this email with a good time to talk.\n\n{{owner_name}}' },
  { key: 'discovery_invite', name: 'Discovery call invite', subject: 'Your {{brand}} discovery call', body: 'Hi {{first_name}},\n\nThe next step is a discovery call about the business, the investment and the territory. Reply with times that suit you.\n\n{{owner_name}}' },
  { key: 'receipt_reminder', name: 'Receipt reminder', subject: 'Please confirm you received the disclosure document', body: 'Hi {{first_name}},\n\nPlease open the link in our earlier email and sign the receipt for the disclosure document. The legal waiting period starts once the receipt is signed.\n\n{{owner_name}}' },
  { key: 'agreement_reminder', name: 'Agreement reminder', subject: 'Your {{brand}} franchise agreement', body: 'Hi {{first_name}},\n\nYour franchise agreement is ready to sign. Take the time you need and ask us any questions.\n\n{{owner_name}}' },
];

export interface OnboardingTaskDef {
  key: string;
  section: 'training' | 'site_selection' | 'lease' | 'fit_out' | 'suppliers' | 'marketing' | 'systems' | 'pre_opening';
  title: string;
  /** Days after the project starts. */
  offsetDays: number;
  /** Who does it: HQ (the project owner) or the franchise owner. */
  assignee: 'hq' | 'owner';
  /** Pre-opening gate: all gates must be done before HQ can be asked to approve the opening. */
  gate?: boolean;
}

export const ONBOARDING_TEMPLATE: { key: string; name: string; tasks: OnboardingTaskDef[] } = {
  key: 'standard_unit',
  name: 'Standard new location',
  tasks: [
    { key: 'training_owner', section: 'training', title: 'Owner training: brand, operations and BranchHarbor', offsetDays: 21, assignee: 'hq' },
    { key: 'training_staff_plan', section: 'training', title: 'Staff training plan agreed', offsetDays: 75, assignee: 'owner' },
    { key: 'site_criteria', section: 'site_selection', title: 'Site criteria brief shared', offsetDays: 7, assignee: 'hq' },
    { key: 'site_submitted', section: 'site_selection', title: 'Site submitted for approval', offsetDays: 30, assignee: 'owner' },
    { key: 'site_approved', section: 'site_selection', title: 'Site approved by HQ', offsetDays: 40, assignee: 'hq' },
    { key: 'lease_loi', section: 'lease', title: 'Letter of intent with landlord', offsetDays: 45, assignee: 'owner' },
    { key: 'lease_review', section: 'lease', title: 'Lease reviewed by counsel', offsetDays: 55, assignee: 'owner' },
    { key: 'lease_signed', section: 'lease', title: 'Lease signed', offsetDays: 60, assignee: 'owner' },
    { key: 'fitout_design', section: 'fit_out', title: 'Design package issued', offsetDays: 65, assignee: 'hq' },
    { key: 'fitout_contractor', section: 'fit_out', title: 'Contractor appointed', offsetDays: 70, assignee: 'owner' },
    { key: 'fitout_complete', section: 'fit_out', title: 'Fit-out complete and inspected', offsetDays: 120, assignee: 'owner' },
    { key: 'suppliers_accounts', section: 'suppliers', title: 'Approved supplier accounts opened', offsetDays: 100, assignee: 'owner' },
    { key: 'suppliers_opening_order', section: 'suppliers', title: 'Opening stock ordered', offsetDays: 110, assignee: 'owner' },
    { key: 'marketing_coming_soon', section: 'marketing', title: '“Coming soon” page and campaign live', offsetDays: 90, assignee: 'hq' },
    { key: 'marketing_grand_opening', section: 'marketing', title: 'Grand opening plan', offsetDays: 110, assignee: 'owner' },
    { key: 'systems_provisioned', section: 'systems', title: 'Location provisioned in BranchHarbor', offsetDays: 75, assignee: 'hq' },
    { key: 'systems_local_details', section: 'systems', title: 'Hours, phone and local details added', offsetDays: 105, assignee: 'owner' },
    { key: 'gate_policies', section: 'pre_opening', title: 'Policies and brand standards confirmed', offsetDays: 110, assignee: 'owner', gate: true },
    { key: 'gate_training', section: 'pre_opening', title: 'Owner training completed', offsetDays: 115, assignee: 'owner', gate: true },
    { key: 'gate_payments', section: 'pre_opening', title: 'Payment account enabled', offsetDays: 115, assignee: 'owner', gate: true },
    { key: 'gate_test_transaction', section: 'pre_opening', title: 'Test booking or order passed', offsetDays: 118, assignee: 'owner', gate: true },
    { key: 'gate_website_review', section: 'pre_opening', title: 'Website reviewed by HQ', offsetDays: 118, assignee: 'hq', gate: true },
    { key: 'gate_permits', section: 'pre_opening', title: 'Local permits, insurance and inspections in place', offsetDays: 118, assignee: 'owner', gate: true },
  ],
};

export const franchiseEnquirySchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().max(200),
  phone: z.string().trim().max(40).optional(),
  country: z.string().length(2).transform((s) => s.toUpperCase()),
  region: z.string().trim().max(10).optional(),
  city: z.string().trim().max(120).optional(),
  territoryId: z.uuid().optional(),
  desiredTerritory: z.string().trim().max(200).optional(),
  /** Self-declared, in whole units of `currency` (the form never checks or verifies them). */
  liquidCapital: z.number().int().min(0).max(1_000_000_000).optional(),
  netWorth: z.number().int().min(0).max(10_000_000_000).optional(),
  currency: z.string().length(3).transform((s) => s.toUpperCase()).optional(),
  message: z.string().trim().max(2000).optional(),
  /** Campaign / ad attribution from the landing URL. */
  utm: z.object({ source: z.string().max(100).optional(), medium: z.string().max(100).optional(), campaign: z.string().max(100).optional() }).optional(),
  consent: z.literal(true),
  marketingConsent: z.boolean().default(false),
  locale: z.string().max(10).default('en'),
  turnstileToken: z.string().optional(),
  /** Honeypot: must stay empty. */
  website: z.string().max(0).optional(),
});
export type FranchiseEnquiryInput = z.infer<typeof franchiseEnquirySchema>;

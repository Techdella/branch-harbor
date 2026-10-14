import { z } from 'zod';

/**
 * Additional API contracts used by the BranchHarbor API (apps/api) and its clients.
 * Added alongside schemas.ts; nothing here changes existing exports.
 */

/** The nine onboarding steps from product spec §7. Optional steps can be skipped. */
export const ONBOARDING_STEPS = [
  { key: 'account', title: 'Create account and verify email', optional: false },
  { key: 'industry', title: 'Choose industry and business model', optional: false },
  { key: 'business_details', title: 'Business details, timezone and currency', optional: false },
  { key: 'first_location', title: 'Add your first location', optional: false },
  { key: 'website', title: 'Choose a hosted site or connect WordPress', optional: true },
  { key: 'industry_data', title: 'Add services, classes, programmes, products or menu', optional: true },
  { key: 'connections', title: 'Connect booking, commerce or payment systems', optional: true },
  { key: 'invite_staff', title: 'Invite staff with location permissions', optional: true },
  { key: 'preview_publish', title: 'Preview, test and publish', optional: false },
] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number]['key'];
export const onboardingStepStatuses = ['not_started', 'in_progress', 'complete', 'skipped'] as const;

export const onboardingStepUpdateSchema = z.object({
  status: z.enum(['in_progress', 'complete', 'skipped']),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const locationStatuses = ['draft', 'onboarding', 'opening_soon', 'operating', 'paused', 'closed'] as const;
export const domainStateLabels = {
  awaiting_dns: 'Awaiting DNS',
  verifying: 'Verifying',
  certificate_pending: 'Certificate pending',
  ready: 'Ready',
  failed: 'Failed',
} as const;

export const bookingStates = ['held', 'confirmed', 'cancelled', 'expired', 'attended', 'no_show'] as const;
export const registrationStates = ['submitted', 'awaiting_review', 'accepted', 'waitlisted', 'withdrawn', 'rejected'] as const;
export const appointmentStates = ['confirmed', 'cancelled', 'rescheduled', 'completed', 'no_show'] as const;
export const publishResultStates = ['pending', 'succeeded', 'failed', 'skipped'] as const;
export const fieldOrigins = ['hq', 'local', 'locked', 'approval'] as const;
export const reconciliationKinds = ['paid_without_record', 'unpaid_confirmed_record', 'amount_mismatch'] as const;

/** Customer contact details collected by public booking/order flows. */
export const publicContactSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  marketingConsent: z.boolean().default(false),
});

export const foodOrderCreateSchema = z.object({
  pickupSlotId: z.string().min(1),
  lines: z.array(z.object({
    menuItemId: z.string().min(1),
    quantity: z.number().int().min(1).max(50),
    modifierIds: z.array(z.string()).default([]),
    notes: z.string().max(300).optional(),
  })).min(1).max(50),
  contact: publicContactSchema,
  notes: z.string().max(500).optional(),
  /** Optional: the total the customer saw. If it differs from the server total, the order is refused. */
  expectedTotalMinor: z.number().int().optional(),
});

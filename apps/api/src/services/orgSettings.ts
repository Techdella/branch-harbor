import { z } from 'zod';
import type { organizations } from '../db/schema/index.ts';

/**
 * Organisation-level policies stored in `organizations.settings` (jsonb, merged — other keys such as
 * the hosted-site theme live alongside and are never overwritten).
 */
/** off: each location sees only its own customers · totals_only: aggregate counts across locations, no personal details · shared: records shared across locations for a documented purpose. */
export const CUSTOMER_DATA_SHARING = ['off', 'totals_only', 'shared'] as const;
export type CustomerDataSharing = (typeof CUSTOMER_DATA_SHARING)[number];

export const orgPolicySchema = z.object({
  /** Who may see a customer's record beyond their home location. Default: only the home location. */
  customerDataSharing: z.enum(CUSTOMER_DATA_SHARING),
  /** Business data is never used to train AI models unless the organisation opts in. Default: opted out. */
  aiTrainingOptOut: z.boolean(),
  /** Refunds above this amount (minor units, per currency) need approval from someone else. Absent = no threshold. */
  refundApprovalThresholds: z.record(z.string().length(3), z.number().int().min(0)),
});
export type OrgPolicies = z.infer<typeof orgPolicySchema>;

export const DEFAULT_POLICIES: OrgPolicies = { customerDataSharing: 'off', aiTrainingOptOut: true, refundApprovalThresholds: {} };

export function orgPolicies(o: Pick<typeof organizations.$inferSelect, 'settings'>): OrgPolicies {
  const st = (o.settings ?? {}) as Record<string, unknown>;
  const sharing = CUSTOMER_DATA_SHARING.includes(st.customerDataSharing as CustomerDataSharing) ? (st.customerDataSharing as CustomerDataSharing) : DEFAULT_POLICIES.customerDataSharing;
  const thresholds = st.refundApprovalThresholds && typeof st.refundApprovalThresholds === 'object' ? (st.refundApprovalThresholds as Record<string, number>) : {};
  return {
    customerDataSharing: sharing,
    aiTrainingOptOut: typeof st.aiTrainingOptOut === 'boolean' ? st.aiTrainingOptOut : DEFAULT_POLICIES.aiTrainingOptOut,
    refundApprovalThresholds: Object.fromEntries(Object.entries(thresholds).filter(([, v]) => Number.isInteger(v) && v >= 0)),
  };
}

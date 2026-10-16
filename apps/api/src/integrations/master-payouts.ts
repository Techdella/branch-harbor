/**
 * Payouts to master franchisees / area representatives through Stripe Connect transfers.
 *
 * Limits (also in docs/API_INTEGRATIONS.md, "Master franchise payouts"):
 * - A transfer moves money from the BranchHarbor platform balance to a connected account. Royalties are collected on
 *   the franchisor's own connected account (direct charges), so the platform balance must be funded in that currency
 *   first (or the franchisor pays the master by bank transfer and records it: method `manual`).
 * - Transfers are same-currency and only to connected accounts in regions where cross-border payouts are supported
 *   (e.g. US platform → accounts in the US, Canada, UK, EEA, Australia…); elsewhere use `manual`.
 * - The master's account needs the `transfers` capability (requested when it is created through BranchHarbor).
 * Without STRIPE_SECRET_KEY (sandbox), transfers get a deterministic `tr_sandbox_…` id and move no money.
 */
import { createHash } from 'node:crypto';
import type { PaymentsProvider } from './payments.ts';

export interface MasterTransferInput { amountMinor: number; currency: string; destinationAccountId: string; statementId: string; description: string }

export async function transferToMaster(payments: PaymentsProvider, input: MasterTransferInput): Promise<{ id: string; sandbox: boolean }> {
  const stripe = payments.client;
  if (!stripe || payments.mode === 'sandbox' || input.destinationAccountId.includes('_sandbox_')) {
    return { id: `tr_sandbox_${createHash('sha256').update(input.statementId).digest('hex').slice(0, 14)}`, sandbox: true };
  }
  const t = await stripe.transfers.create(
    { amount: input.amountMinor, currency: input.currency.toLowerCase(), destination: input.destinationAccountId, transfer_group: `master_split_${input.statementId}`, description: input.description.slice(0, 200), metadata: { master_split_statement_id: input.statementId } },
    { idempotencyKey: `master-split-${input.statementId}` },
  );
  return { id: t.id, sandbox: false };
}

/** Studio cancellation policy, phrased in the visitor's language from the API's structured terms. */
import { money } from './format';
import type { Money } from './types';

export interface PolicyTerms { lateCancelMinutes: number; forfeitCreditOnLateCancel: boolean; refundPaidOnLateCancel: boolean; feesApplyToMembers: boolean }
export interface CustomerPolicy { lines: string[]; terms?: PolicyTerms; lateCancelFee?: Money | null; noShowFee?: Money | null }

/** `t` is a translator for the `studio` namespace. Older API responses without `terms` keep their English lines. */
export function policyLines(p: CustomerPolicy, t: (key: string, values?: Record<string, string | number>) => string, locale: string): string[] {
  const x = p.terms;
  if (!x) return p.lines;
  const members = x.feesApplyToMembers ? '' : 'Members';
  return [
    x.lateCancelMinutes % 60 === 0 ? t('terms.windowHours', { hours: x.lateCancelMinutes / 60 }) : t('terms.windowMinutes', { minutes: x.lateCancelMinutes }),
    t(x.forfeitCreditOnLateCancel ? 'terms.creditUsed' : 'terms.creditReturned'),
    t(x.refundPaidOnLateCancel ? 'terms.paidRefunded' : 'terms.paidNotRefunded'),
    p.lateCancelFee ? t(`terms.lateFee${members}`, { amount: money(p.lateCancelFee, locale) }) : t('terms.noLateFee'),
    p.noShowFee ? t(`terms.noShowFee${members}`, { amount: money(p.noShowFee, locale) }) : t('terms.noNoShowFee'),
  ];
}

import type { Money } from '@bh/shared';
import type { TFn } from '@/i18n';
import { fmtMoney } from '@/lib/format';

/** Studio cancellation policy as the API returns it: English `lines` plus structured `terms` to phrase locally. */
export interface CustomerPolicy {
  lines: string[];
  terms?: { lateCancelMinutes: number; forfeitCreditOnLateCancel: boolean; refundPaidOnLateCancel: boolean; feesApplyToMembers: boolean };
  lateCancelFee?: Money | null;
  noShowFee?: Money | null;
}

/** The policy in the app language; responses without `terms` (older API, sample data) keep their lines. */
export function policyLines(p: CustomerPolicy, t: TFn, locale: string): string[] {
  const x = p.terms;
  if (!x) return p.lines;
  const members = x.feesApplyToMembers ? '' : 'Members';
  return [
    x.lateCancelMinutes % 60 === 0 ? t('studio.terms.windowHours', { count: x.lateCancelMinutes / 60 }) : t('studio.terms.windowMinutes', { minutes: x.lateCancelMinutes }),
    t(x.forfeitCreditOnLateCancel ? 'studio.terms.creditUsed' : 'studio.terms.creditReturned'),
    t(x.refundPaidOnLateCancel ? 'studio.terms.paidRefunded' : 'studio.terms.paidNotRefunded'),
    p.lateCancelFee ? t(`studio.terms.lateFee${members}`, { amount: fmtMoney(p.lateCancelFee, locale) }) : t('studio.terms.noLateFee'),
    p.noShowFee ? t(`studio.terms.noShowFee${members}`, { amount: fmtMoney(p.noShowFee, locale) }) : t('studio.terms.noNoShowFee'),
  ];
}

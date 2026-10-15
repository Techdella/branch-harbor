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

/** Where a pack or membership can be used (API `accessDetail`, next to the English `access` line). */
export interface AccessDetail { policy: 'any_location' | 'same_currency' | 'listed' | 'home_only'; currency: string; locationCount: number; locationName: string }
/** The facts behind a membership's English `terms` lines (API `termsDetail`). */
export interface TermsDetail { billingCurrency: string; noticeDays: number; maxPauseDays: number | null; classesPerPeriod: number | null }
type StudioT = (key: string, values?: Record<string, string | number>) => string;

/** Access line in the visitor's language; older API responses without `accessDetail` keep the English line. */
export function accessLine(access: string, d: AccessDetail | undefined, t: StudioT): string {
  if (!d) return access;
  if (d.policy === 'any_location') return t('access.any_location');
  if (d.policy === 'same_currency') return t('access.same_currency', { currency: d.currency });
  if (d.policy === 'listed') return t('access.listed', { count: d.locationCount });
  return t('access.home_only', { location: d.locationName });
}

/** Membership terms in the visitor's language (same order as the API's English `terms`). */
export function membershipTermLines(terms: string[], d: TermsDetail | undefined, t: StudioT): string[] {
  if (!d) return terms;
  return [
    t('membershipTerms.billed', { currency: d.billingCurrency }),
    t('membershipTerms.notice', { days: d.noticeDays }),
    d.maxPauseDays ? t('membershipTerms.pause', { days: d.maxPauseDays }) : t('membershipTerms.noPause'),
    d.classesPerPeriod ? t('membershipTerms.classes', { count: d.classesPerPeriod }) : t('membershipTerms.unlimited'),
  ];
}

/** Online-class rules or access reasons phrased from their codes; unknown or missing codes keep the English text. */
export function codedLines(texts: string[], codes: string[] | undefined, group: 'onlineReason' | 'onlineRule', t: StudioT & { has?: (key: string) => boolean }): string[] {
  if (!codes || codes.length !== texts.length) return texts;
  return codes.map((c, i) => (t.has && !t.has(`${group}.${c}`) ? texts[i]! : t(`${group}.${c}`)));
}

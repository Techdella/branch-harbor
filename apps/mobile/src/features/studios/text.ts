/**
 * Studio texts the API sends in English, phrased in the app's language from the structured facts it sends
 * alongside (`accessDetail`, `termsDetail`, `ruleCodes`, `reasonCodes`). Older responses keep the English lines.
 */
import type { TFn } from '@/i18n';
import type { AccessDetail, TermsDetail } from './api';

export function accessLine(access: string, d: AccessDetail | undefined, t: TFn): string {
  if (!d) return access;
  if (d.policy === 'any_location') return t('studio.access.any_location');
  if (d.policy === 'same_currency') return t('studio.access.same_currency', { currency: d.currency });
  if (d.policy === 'listed') return t('studio.access.listed', { count: d.locationCount });
  return t('studio.access.home_only', { location: d.locationName });
}

export function membershipTermLines(terms: string[], d: TermsDetail | undefined, t: TFn): string[] {
  if (!d) return terms;
  return [
    t('studio.membershipTerms.billed', { currency: d.billingCurrency }),
    t('studio.membershipTerms.notice', { count: d.noticeDays }),
    d.maxPauseDays ? t('studio.membershipTerms.pause', { days: d.maxPauseDays }) : t('studio.membershipTerms.noPause'),
    d.classesPerPeriod ? t('studio.membershipTerms.classes', { count: d.classesPerPeriod }) : t('studio.membershipTerms.unlimited'),
  ];
}

const RULES = ['free_with_registration', 'members', 'pack_holders', 'buy', 'not_available'];
const REASONS = ['sign_in', 'membership_excludes', 'members_only', 'pack_holders_only', 'buy_to_watch', 'livestream_ended'];

/** Online-class rules / access reasons from their codes; unknown codes keep the English text. */
export function codedLines(texts: string[], codes: string[] | undefined, group: 'onlineRule' | 'onlineReason', t: TFn): string[] {
  if (!codes || codes.length !== texts.length) return texts;
  const known = group === 'onlineRule' ? RULES : REASONS;
  return codes.map((c, i) => (known.includes(c) ? t(`studio.${group}.${c}`) : texts[i]!));
}

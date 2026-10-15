'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Icon } from '@bh/ui';
import { billingApi } from '@/lib/billing';
import { moneyWithCode } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { useApp } from '../../shell/AppContext';
import { SectionCard } from '../../ui/States';
import { STATUS_TONE, fmtDate } from './BillingScreen';

/** Settings summary of the BranchHarbor plan, linking to Settings → Billing. */
export function BillingLinkCard() {
  const t = useTranslations('billing');
  const locale = useLocale();
  const app = useApp();
  const allowed = app.hasModule('settings.billing');
  const res = useApi(() => billingApi.view(), [app.org.id], allowed);
  if (!allowed) return null;
  const b = res.status === 'ready' ? res.data : null;
  return (
    <SectionCard title={t('title')} aside={<Badge tone="neutral" icon="info">{t('separate')}</Badge>}>
      <Link href="/settings/billing" className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-canvas-raised px-4 py-3.5 hover:bg-canvas" data-testid="billing-link">
        <div>
          <div className="flex items-center gap-2 text-base font-bold">
            {b ? t(`plans.${b.plan}`) : t('title')}
            {b && <Badge tone={STATUS_TONE[b.status] ?? 'neutral'}>{t(`status.${b.status}`)}</Badge>}
          </div>
          <div className="text-sm text-stone">
            {b?.status === 'trialing' && b.trial.endsAt
              ? t('link.trial', { date: fmtDate(b.trial.endsAt, locale) })
              : b?.status === 'checkout_required'
                ? t('link.start', { days: b.trial.days, fee: moneyWithCode(b.trial.fee, locale) })
                : t('link.manage')}
          </div>
        </div>
        <Icon name="chevron-right" size={18} />
      </Link>
    </SectionCard>
  );
}

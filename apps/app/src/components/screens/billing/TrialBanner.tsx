'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { billingApi } from '@/lib/billing';
import { moneyWithCode } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { useApp } from '../../shell/AppContext';

/**
 * App-wide plan banner for people who manage billing: days left in the paid trial and when the plan starts, or a
 * prompt to start the trial / restart an ended plan. Hidden on the Billing screen itself and for everyone else.
 */
export function TrialBanner() {
  const t = useTranslations('billing.banner');
  const tp = useTranslations('billing.plans');
  const locale = useLocale();
  const app = useApp();
  const path = usePathname();
  const allowed = app.hasModule('settings.billing');
  const res = useApi(() => billingApi.view(), [app.org.id, path === '/settings/billing'], allowed);
  if (!allowed || res.status !== 'ready' || path === '/settings/billing') return null;
  const b = res.data;
  const date = b.trial.endsAt ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(new Date(b.trial.endsAt)) : '';
  let text: string | null = null;
  let tone = 'bg-lime text-ink';
  if (b.status === 'trialing') {
    text = b.cancelAtPeriodEnd ? t('trialCanceled', { date }) : t('trial', { count: b.trial.daysLeft ?? 0, plan: tp(b.plan), date });
    tone = b.cancelAtPeriodEnd ? 'bg-canvas-raised text-ink' : 'bg-lime text-ink';
  } else if (b.status === 'checkout_required') {
    text = t('required', { days: b.trial.days, fee: moneyWithCode(b.trial.fee, locale) });
    tone = 'bg-butter text-ink';
  } else if (b.status === 'canceled') {
    text = t('canceled');
    tone = 'bg-canvas-raised text-ink';
  } else if (b.status === 'past_due') {
    text = t('pastDue');
    tone = 'bg-warning-bg text-warning';
  }
  if (!text) return null;
  return (
    <div role="status" data-testid="trial-banner" className={`flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-semibold ${tone}`}>
      <span className="flex items-center gap-2">
        <Icon name={b.status === 'trialing' ? 'clock' : 'card'} size={18} />
        {text}
      </span>
      <Link href="/settings/billing" className="inline-flex h-9 items-center rounded-full bg-ink px-4 text-xs font-bold text-white hover:bg-ink-2">
        {b.status === 'checkout_required' ? t('start') : t('manage')}
      </Link>
    </div>
  );
}

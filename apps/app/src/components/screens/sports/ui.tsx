'use client';

import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Icon, cx, type Tone } from '@bh/ui';
import type { IconName } from '@bh/icons';
import type { Currency } from '@bh/shared';
import { moneyWithCode } from '@/lib/format';
import type { BalanceState, RegStatus } from '@/lib/sports/types';
import { useApp } from '../../shell/AppContext';

/** Location ids of the selected scope (empty = all authorised locations). */
export function useScopeIds(): string[] {
  const app = useApp();
  return app.scope.locationIds;
}

const REG_TONE: Record<RegStatus, [Tone, IconName]> = {
  submitted: ['warning', 'card'],
  awaiting_review: ['info', 'clock'],
  accepted: ['success', 'check-circle'],
  waitlisted: ['neutral', 'list'],
  withdrawn: ['neutral', 'undo'],
  rejected: ['danger', 'x'],
};
export function RegStatusBadge({ status }: { status: RegStatus }) {
  const t = useTranslations('sportsHub.regStatus');
  const [tone, icon] = REG_TONE[status];
  return <Badge tone={tone} icon={icon}>{t(status)}</Badge>;
}

const BAL_TONE: Record<BalanceState, [Tone, IconName]> = {
  none: ['neutral', 'minus'], paid: ['success', 'check-circle'], on_track: ['info', 'clock'], due: ['warning', 'alert'], overdue: ['danger', 'alert'], waived: ['neutral', 'gift'],
};
export function BalanceBadge({ state }: { state: BalanceState }) {
  const t = useTranslations('sportsHub.balanceState');
  const [tone, icon] = BAL_TONE[state];
  return <Badge tone={tone} icon={icon}>{t(state)}</Badge>;
}

export function Amount({ amount, currency, className }: { amount: number; currency: Currency | string | null; className?: string }) {
  const locale = useLocale();
  const t = useTranslations('sportsHub');
  if (!currency) return <span className={className}>{t('unavailable')}</span>;
  return <span className={cx('tabular-nums', className)}>{moneyWithCode({ amount, currency: currency as Currency }, locale)}</span>;
}

export function Stat({ label, value, sub, icon, tone }: { label: string; value: ReactNode; sub?: ReactNode; icon?: IconName; tone?: 'danger' | 'warning' | 'success' }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-surface p-4">
      <div className="flex items-center gap-1.5 text-xs font-bold text-stone">
        {icon && <Icon name={icon} size={14} />}
        {label}
      </div>
      <div className={cx('text-2xl font-extrabold tracking-tight', tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning', tone === 'success' && 'text-success')}>{value}</div>
      {sub && <div className="text-xs text-stone">{sub}</div>}
    </div>
  );
}

/** Capacity bar with text (never colour alone). */
export function CapacityBar({ used, capacity, label }: { used: number; capacity: number | null; label?: string }) {
  const t = useTranslations('sportsHub');
  if (capacity === null) return <div className="text-xs text-stone">{label ? `${label} · ` : ''}{t('noCapacity', { n: used })}</div>;
  const pct = Math.min(100, Math.round((used / Math.max(1, capacity)) * 100));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs"><span className="text-stone">{label}</span><span className="font-bold">{t('ofCapacity', { used, capacity })}{used >= capacity ? ` · ${t('full')}` : ''}</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-canvas" role="img" aria-label={t('ofCapacity', { used, capacity })}>
        <div className={cx('h-full rounded-full', used >= capacity ? 'bg-danger' : pct > 85 ? 'bg-warning' : 'bg-ink')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return <label htmlFor={htmlFor} className="text-[13px] font-bold text-ink">{children}</label>;
}

export const inputCls = 'w-full rounded-xs border border-line bg-surface px-3.5 h-11 text-sm font-medium text-ink focus:border-ink focus:outline-none aria-[invalid=true]:border-danger';
export const areaCls = 'w-full rounded-xs border border-line bg-surface px-3.5 py-3 min-h-24 text-sm font-medium text-ink focus:border-ink focus:outline-none';

export function fmtDate(ymd: string | null | undefined, locale: string) {
  if (!ymd) return '—';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ymd.slice(0, 10)}T00:00:00Z`));
}

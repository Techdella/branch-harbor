'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Icon, cx, type Tone } from '@bh/ui';
import type { IconName } from '@bh/icons';
import type { StudioResource } from '@/lib/studios/api';
import type { MembershipStateKey } from '@/lib/studios/types';
import { DeniedState, ErrorState, LoadingBlock } from '../../ui/States';

export const fmtMoney = (amount: number | null | undefined, currency: string, locale: string) =>
  amount === null || amount === undefined ? null : new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 10 ** (new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2));

/** Minor units ↔ the decimal string typed in a price field. */
export const toMinor = (v: string, currency: string) => {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) && v.trim() !== '' ? Math.round(n * 10 ** digits) : null;
};

const STATE: Record<MembershipStateKey, { tone: Tone; icon: IconName }> = {
  active: { tone: 'success', icon: 'check-circle' }, paused: { tone: 'info', icon: 'clock' }, grace: { tone: 'warning', icon: 'alert' }, suspended: { tone: 'danger', icon: 'x' },
  cancelling: { tone: 'warning', icon: 'clock' }, cancelled: { tone: 'neutral', icon: 'x' }, pending: { tone: 'neutral', icon: 'clock' }, ended: { tone: 'neutral', icon: 'x' },
};

/** Membership state: always text + icon, never colour alone. */
export function MembershipBadge({ state }: { state: MembershipStateKey }) {
  const t = useTranslations('studiosFull.membershipState');
  const s = STATE[state] ?? STATE.pending;
  return <Badge tone={s.tone} icon={s.icon}>{t(state)}</Badge>;
}

export function StudioAsync<T>({ res, children, loading, empty, isEmpty }: { res: StudioResource<T> & { reload: () => void }; children: (d: T) => ReactNode; loading?: ReactNode; empty?: ReactNode; isEmpty?: (d: T) => boolean }) {
  if (res.status === 'error') return res.error.isForbidden ? <DeniedState detail={res.error.message} /> : <ErrorState error={res.error} onRetry={res.reload} />;
  if (res.status === 'loading' && res.data === undefined) return <>{loading ?? <LoadingBlock />}</>;
  const d = res.data as T;
  if (isEmpty?.(d) && empty) return <>{empty}</>;
  return <>{children(d)}</>;
}

export function Stat({ label, value, sub, pastel }: { label: string; value: ReactNode; sub?: ReactNode; pastel?: string }) {
  return (
    <div className="rounded-[14px] p-3" style={{ background: pastel ?? '#F3F2EE' }}>
      <div className="text-xs text-stone">{label}</div>
      <strong className="text-lg tabular">{value}</strong>
      {sub && <div className="text-[11px] text-graphite">{sub}</div>}
    </div>
  );
}

export function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={cx('h-9 min-w-10 rounded-full border px-3 text-[13px] font-bold', active ? 'border-ink bg-ink text-white' : 'border-line-soft bg-surface text-graphite hover:border-ink')}>
      {children}
    </button>
  );
}

export function Labeled({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-bold">
      {label}
      {children}
      {hint && !error && <span className="text-xs font-medium text-stone">{hint}</span>}
      {error && <span className="text-xs font-bold text-danger">{error}</span>}
    </label>
  );
}

export const inputCls = 'h-11 w-full rounded-md border border-line bg-surface px-3 text-sm font-medium focus:border-ink focus:outline-none';

export function ErrorLine({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-center gap-1.5 text-sm font-bold text-danger">
      <Icon name="alert" size={15} />
      {message}
    </p>
  );
}

export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

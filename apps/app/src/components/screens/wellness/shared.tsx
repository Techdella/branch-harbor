'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Select, cx, type Tone } from '@bh/ui';
import type { IconName } from '@bh/icons';
import { money } from '@/lib/format';
import type { Location } from '@/lib/types';
import type { CancellationPreview, WMoney } from '@/lib/wellness/types';
import type { WRes } from '@/lib/wellness/api';
import { useApp } from '../../shell/AppContext';
import { DeniedState, ErrorState, LoadingBlock } from '../../ui/States';

/** Locations in the active scope (the whole directory for "All authorised locations"). */
export function useScopeLocations(): Location[] {
  const app = useApp();
  return useMemo(() => {
    const ids = app.scope.locationIds;
    const list = ids.length ? app.locations.filter((l) => ids.includes(l.id)) : app.locations;
    return list.length ? list : app.locations;
  }, [app.locations, app.scope.locationIds]);
}

/** A single selected location within the scope (calendar, availability). Remembers the last choice. */
export function useLocationChoice() {
  const locs = useScopeLocations();
  const [id, setId] = useState<string>(() => {
    try { return localStorage.getItem('bh_wellness_loc') ?? ''; } catch { return ''; }
  });
  const current = locs.find((l) => l.id === id) ?? locs[0];
  useEffect(() => {
    if (current) try { localStorage.setItem('bh_wellness_loc', current.id); } catch { /* storage unavailable */ }
  }, [current]);
  return { locations: locs, location: current, setLocationId: setId };
}

export function LocationSelect({ locations, value, onChange, allLabel, label }: { locations: Location[]; value: string; onChange: (id: string) => void; allLabel?: string; label: string }) {
  if (locations.length <= 1 && !allLabel) return <span className="text-sm font-bold">{locations[0]?.name}</span>;
  return (
    <label className="flex items-center gap-2 text-xs font-bold text-stone">
      <span className="sr-only md:not-sr-only">{label}</span>
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="!h-9 min-w-[200px] !text-[13px]">
        {allLabel && <option value="">{allLabel}</option>}
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name} · {l.currency}
          </option>
        ))}
      </Select>
    </label>
  );
}

export function Money({ m }: { m: WMoney | null | undefined }) {
  const locale = useLocale();
  const t = useTranslations('wellnessFull');
  if (!m) return <span className="text-stone">{t('unavailable')}</span>;
  return <span className="tabular">{money(m as Parameters<typeof money>[0], locale)}</span>;
}

const STATUS: Record<string, { tone: Tone; icon: IconName }> = {
  confirmed: { tone: 'success', icon: 'check' },
  checked_in: { tone: 'info', icon: 'check-circle' },
  completed: { tone: 'neutral', icon: 'check-circle' },
  cancelled: { tone: 'danger', icon: 'x' },
  no_show: { tone: 'warning', icon: 'alert' },
  rescheduled: { tone: 'neutral', icon: 'repeat' },
  active: { tone: 'success', icon: 'check' },
  exhausted: { tone: 'neutral', icon: 'check-circle' },
  expired: { tone: 'warning', icon: 'clock' },
  redeemed: { tone: 'neutral', icon: 'check-circle' },
  pending_payment: { tone: 'info', icon: 'clock' },
  waiting: { tone: 'info', icon: 'clock' },
  offered: { tone: 'signal', icon: 'bell' },
  booked: { tone: 'success', icon: 'check' },
};

/** Status is always text + icon, never colour alone. */
export function StatusBadge({ status, checkedIn }: { status: string; checkedIn?: boolean }) {
  const t = useTranslations('wellnessFull.status');
  const key = status === 'confirmed' && checkedIn ? 'checked_in' : status;
  const s = STATUS[key] ?? { tone: 'neutral' as Tone, icon: 'info' as IconName };
  return <Badge tone={s.tone} icon={s.icon}>{t.has(key) ? t(key) : key.replace(/_/g, ' ')}</Badge>;
}

export function Loadable<T>({ res, children, loading }: { res: WRes<T> & { reload: () => void }; children: (d: T) => ReactNode; loading?: ReactNode }) {
  if (res.status === 'error') return res.error.isForbidden ? <DeniedState detail={res.error.message} /> : <ErrorState error={res.error} onRetry={res.reload} />;
  if (res.status === 'loading' && res.data === undefined) return <>{loading ?? <LoadingBlock />}</>;
  return <>{children(res.data as T)}</>;
}

/** Consequence preview for cancellations / no-shows (financial effect before confirmation). */
export function PolicyPreview({ p }: { p: CancellationPreview }) {
  const t = useTranslations('wellnessFull.policy');
  const m = (amount: number) => ({ amount, currency: p.fee.currency });
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-canvas p-3.5 text-[13px] leading-relaxed">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={p.window === 'free' || p.window === 'business' ? 'success' : 'warning'} icon={p.window === 'free' || p.window === 'business' ? 'check' : 'alert'}>{t(`window.${p.window}`)}</Badge>
        <span className="text-stone">{t('hoursBefore', { hours: p.hoursBeforeStart })}</span>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        <dt>{t('price')}</dt><dd className="text-right"><Money m={p.price} /></dd>
        <dt>{t('fee')}</dt><dd className="text-right font-bold"><Money m={p.fee} /></dd>
        {p.deposit.paid > 0 && (<><dt>{t('depositRefund')}</dt><dd className="text-right"><Money m={m(p.deposit.refund)} /></dd><dt>{t('depositRetained')}</dt><dd className="text-right"><Money m={m(p.deposit.retained)} /></dd></>)}
        {p.voucher.applied > 0 && (<><dt>{t('voucherReturned')}</dt><dd className="text-right"><Money m={m(p.voucher.returned)} /></dd></>)}
        {p.packageSession && (<><dt>{t('packageSession')}</dt><dd className="text-right">{t(`session.${p.packageSession}`)}</dd></>)}
        {p.outstanding.amount > 0 && (<><dt>{t('outstanding')}</dt><dd className="text-right font-bold text-danger"><Money m={p.outstanding} /></dd></>)}
      </dl>
      {p.policyText && <p className="text-xs text-stone">{p.policyText}</p>}
    </div>
  );
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full bg-canvas px-2.5 py-0.5 text-[11px] font-bold text-graphite', className)}>{children}</span>;
}

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
export function weekdayName(wd: number, locale: string, style: 'short' | 'long' = 'short') {
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + wd)));
}
export function pct(rate: number | null | undefined, locale: string) {
  return rate == null ? null : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(rate);
}

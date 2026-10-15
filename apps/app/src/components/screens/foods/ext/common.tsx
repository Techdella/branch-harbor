'use client';

import { useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { Money } from '@bh/shared';
import { Badge, Icon, cx, type Tone } from '@bh/ui';
import type { IconName } from '@bh/icons';
import { moneyWithCode } from '@/lib/format';
import { useApp } from '../../../shell/AppContext';
import { Banner } from '../../../ui/States';

export const useFx = () => useTranslations('foodsx');

/** Locations in the active scope. Staff screens work whether or not the location has a published website; pass `onlyLive` to keep only locations whose site is live. */
export function useScopedLocations(onlyLive = false) {
  const app = useApp();
  return app.locations.filter((l) => app.scope.locationIds.includes(l.id) && (!onlyLive || l.site === 'live'));
}

/** Location selector shared by per-location foods screens. Keeps the choice valid when the scope changes. */
export function useLocationPick(onlyLive = false) {
  const locs = useScopedLocations(onlyLive);
  const [id, setId] = useState(locs[0]?.id ?? '');
  const current = locs.find((l) => l.id === id) ?? locs[0];
  return { locs, loc: current, locationId: current?.id ?? '', setLocationId: setId };
}

export function LocationSelect({ pick, label }: { pick: ReturnType<typeof useLocationPick>; label?: string }) {
  const t = useFx();
  return (
    <label className="flex h-11 items-center gap-2 rounded-full border border-line-soft bg-surface px-3 text-[13px]">
      <Icon name="pin" size={14} />
      <span className="sr-only">{label ?? t('common.location')}</span>
      <select value={pick.locationId} onChange={(e) => pick.setLocationId(e.target.value)} className="bg-transparent font-bold focus:outline-none">
        {pick.locs.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name} · {l.currency}
          </option>
        ))}
      </select>
    </label>
  );
}

export function NoLocations() {
  const t = useFx();
  return <Banner tone="neutral" title={t('common.noLocations')}>{t('common.noLocationsBody')}</Banner>;
}

export function Money1({ m }: { m: Money | null | undefined }) {
  const locale = useLocale();
  const t = useFx();
  if (!m) return <span className="text-stone">{t('common.unavailable')}</span>;
  return <span className="tabular">{moneyWithCode(m, locale)}</span>;
}

/** Amounts in several currencies are listed per currency, never added together. */
export function MoneyList({ values }: { values: Money[] }) {
  const locale = useLocale();
  const t = useFx();
  if (!values.length) return <span className="text-stone">{t('common.none')}</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {values.map((v) => (
        <span key={v.currency} className="tabular">
          {moneyWithCode(v, locale)}
        </span>
      ))}
    </span>
  );
}

const STATUS_TONE: Record<string, [Tone, IconName]> = {
  awaiting_acceptance: ['warning', 'clock'], accepted: ['info', 'check'], preparing: ['info', 'chef'], ready: ['success', 'check-circle'], collected: ['neutral', 'check'],
  out_for_delivery: ['info', 'truck'], delivered: ['success', 'check-circle'], served: ['success', 'check-circle'], cancelled: ['neutral', 'x'], rejected: ['danger', 'x'],
  queued: ['neutral', 'clock'], in_progress: ['info', 'chef'], done: ['success', 'check'], new: ['warning', 'mail'], quoted: ['info', 'file'], deposit_paid: ['info', 'card'],
  confirmed: ['success', 'check-circle'], completed: ['neutral', 'check'], declined: ['danger', 'x'], expired: ['neutral', 'clock'], active: ['success', 'check-circle'],
  paused: ['warning', 'clock'], past_due: ['danger', 'alert'], pending_payment: ['warning', 'card'], pending: ['warning', 'clock'], assigned: ['info', 'user'], picked_up: ['info', 'truck'],
  failed: ['danger', 'alert'], succeeded: ['success', 'check-circle'], partial: ['warning', 'alert'], skipped: ['neutral', 'minus'], open: ['info', 'receipt'], paid: ['success', 'check-circle'], void: ['neutral', 'x'], closed: ['neutral', 'lock'],
};

/** Status always shown as text + icon (never colour alone). */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const t = useFx();
  const [tone, icon] = STATUS_TONE[status] ?? ['neutral', 'info'];
  return (
    <Badge tone={tone} icon={icon}>
      {label ?? (t.has(`status.${status}`) ? t(`status.${status}`) : status.replace(/_/g, ' '))}
    </Badge>
  );
}

export function ChannelTag({ channel }: { channel: string }) {
  const t = useFx();
  const icon: Record<string, IconName> = { pickup: 'bag', delivery: 'truck', dine_in: 'utensils', preorder: 'calendar', catering: 'gift', meal_plan: 'repeat' };
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2 py-0.5 text-[11px] font-bold">
      <Icon name={icon[channel] ?? 'receipt'} size={12} />
      {t.has(`channel.${channel}`) ? t(`channel.${channel}`) : channel}
    </span>
  );
}

export function Section({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl bg-surface p-4 md:p-5', className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function ErrorLine({ error }: { error: { message: string } | null }) {
  const t = useFx();
  if (!error) return null;
  return <Banner tone="danger" live="assertive" title={t('common.notSaved')}>{error.message}</Banner>;
}

export const toMinor = (major: string) => {
  const n = Number(major.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
export const toMajor = (minor: number | undefined) => (minor === undefined ? '' : (minor / 100).toFixed(2));
export const pctFromBps = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

/** Small labelled input row used by the foods forms. */
export function Labeled({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-[13px] font-bold">
      {label}
      {children}
      {hint && <span className="text-xs font-normal text-stone">{hint}</span>}
    </label>
  );
}
export const inputCls = 'h-10 w-full rounded-xs border border-line bg-surface px-3 text-sm font-medium focus:border-ink focus:outline-none';

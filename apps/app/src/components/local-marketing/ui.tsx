'use client';

import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, cx, type Tone } from '@bh/ui';
import type { Currency, ListingField, SpecialHour, WeeklyHour } from '@bh/shared';
import { fmtWall, fmtYmd, moneyWithCode } from '@/lib/format';
import type { SyncStatus } from './api';

export const SYNC_TONE: Record<SyncStatus, Tone> = { synced: 'success', pending: 'info', drift: 'warning', error: 'danger', not_connected: 'neutral' };

/** Weekday name in the viewer's language (0 = Sunday). */
export function weekdayName(day: number, locale: string, style: 'short' | 'long' = 'short') {
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + day)));
}

/** Readable value of a listing field (drift and change requests). */
export function useListingValue() {
  const locale = useLocale();
  const t = useTranslations('lmk.listings');
  return (field: ListingField | string, v: unknown): string => {
    if (v === null || v === undefined || v === '') return t('empty');
    switch (field) {
      case 'hours': return (v as WeeklyHour[]).map((h) => `${weekdayName(h.day, locale)} ${fmtWall(h.opens, locale)}–${fmtWall(h.closes, locale)}`).join(' · ') || t('empty');
      case 'specialHours': return (v as SpecialHour[]).map((s) => `${fmtYmd(s.date, locale, { day: 'numeric', month: 'short' })} ${s.closed ? t('closed') : `${fmtWall(s.opens!, locale)}–${fmtWall(s.closes!, locale)}`}`).join(' · ') || t('empty');
      case 'address': { const a = v as { line1: string; city: string; postalCode?: string }; return [a.line1, a.postalCode, a.city].filter(Boolean).join(', '); }
      case 'categories': { const c = v as { primary: string | null; additional: string[] }; return [c.primary, ...c.additional].filter(Boolean).join(', ') || t('empty'); }
      case 'photos': return t('photoCount', { n: (v as unknown[]).length });
      case 'attributes': return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${String(x)}`).join(', ') || t('empty');
      default: return String(v);
    }
  };
}

export function HealthBar({ score, compact }: { score: number; compact?: boolean }) {
  const t = useTranslations('lmk.listings');
  const tone = score >= 80 ? 'bg-success' : score >= 60 ? 'bg-warning' : 'bg-danger';
  return (
    <span className={cx('inline-flex items-center gap-2', compact ? 'min-w-[120px]' : 'min-w-[160px]')} role="img" aria-label={t('healthLabel', { score })}>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-line-soft"><span className={cx('block h-full rounded-full', tone)} style={{ width: `${score}%` }} /></span>
      <span className="tabular text-sm font-bold">{score}</span>
    </span>
  );
}

export function SyncBadge({ provider, status, mode }: { provider: string; status: SyncStatus; mode?: string | null }) {
  const t = useTranslations('lmk.listings');
  return <Badge tone={SYNC_TONE[status]}>{t(`provider.${provider}`)} · {t(`sync.${status}`)}{mode === 'sandbox' && status !== 'not_connected' ? ` · ${t('sandbox')}` : ''}</Badge>;
}

export function Kpi({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId?: string }) {
  return (
    <div className="rounded-xl bg-surface p-4" data-testid={testId}>
      <div className="text-xs font-semibold text-stone">{label}</div>
      <div className="tabular mt-1 text-[28px] font-extrabold leading-none">{value}</div>
      {sub && <div className="mt-1.5 text-xs text-stone">{sub}</div>}
    </div>
  );
}

export function KpiRow({ children }: { children: ReactNode }) {
  return <section className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr))]">{children}</section>;
}

export function useMoneyFmt() {
  const locale = useLocale();
  return (amount: number, currency: string) => moneyWithCode({ amount, currency: currency as Currency }, locale);
}

/** Decimal input → minor units (two-decimal currencies). */
export const toMinor = (v: string) => {
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

/** Progress of spend against an allowance: paid, claimed, committed, remaining (one bar, labelled segments). */
export function BurnBar({ allowance, paid, claimed, committed, label }: { allowance: number; paid: number; claimed: number; committed: number; label: string }) {
  const pct = (v: number) => (allowance > 0 ? Math.max(0, Math.min(100, (v / allowance) * 100)) : 0);
  return (
    <span className="flex h-2.5 w-full min-w-[140px] overflow-hidden rounded-full bg-line-soft" role="img" aria-label={label}>
      <span className="bg-ink" style={{ width: `${pct(paid)}%` }} />
      <span className="bg-graphite" style={{ width: `${pct(claimed - paid)}%` }} />
      <span className="bg-lime" style={{ width: `${pct(committed)}%` }} />
    </span>
  );
}

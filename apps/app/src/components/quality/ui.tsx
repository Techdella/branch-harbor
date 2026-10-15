'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Badge, cx, type Tone } from '@bh/ui';
import type { Currency } from '@bh/shared';
import { fmtYmd, moneyWithCode } from '@/lib/format';
import type { ApiError } from '@/lib/errors';
import { Banner } from '../ui/States';

export function useQFmt() {
  const locale = useLocale();
  return {
    locale,
    date: (ymd: string | null | undefined) => (ymd ? fmtYmd(ymd.slice(0, 10), locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'),
    shortDate: (ymd: string | null | undefined) => (ymd ? fmtYmd(ymd.slice(0, 10), locale, { day: 'numeric', month: 'short' }) : '—'),
    month: (ym: string) => new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(`${ym}-15T12:00:00Z`)),
    pct: (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n)}%`),
    num: (n: number | null | undefined, digits = 0) => (n === null || n === undefined ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n)),
    money: (minor: number | null | undefined, currency: string) => (minor === null || minor === undefined ? '—' : moneyWithCode({ amount: minor, currency: currency as Currency }, locale)),
  };
}

/** Score with a colour for pass / fail. */
export function ScoreBadge({ score, passed, critical }: { score: number | null; passed: boolean | null; critical?: boolean | null }) {
  const t = useTranslations('quality');
  const f = useQFmt();
  if (score === null && passed === null) return <span className="text-stone">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={passed ? 'success' : 'danger'}>{f.pct(score)}</Badge>
      {critical && <Badge tone="danger" icon="alert">{t('audit.criticalFail')}</Badge>}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = { scheduled: 'info', in_progress: 'warning', completed: 'success', cancelled: 'neutral', open: 'warning', submitted: 'info', verified: 'success' };
export function StatusBadge({ kind, status }: { kind: 'audit' | 'action'; status: string }) {
  const t = useTranslations('quality');
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{t(`${kind}Status.${status}` as 'auditStatus.scheduled')}</Badge>;
}

const CELL_TONE: Record<string, { tone: Tone; icon: 'check-circle' | 'clock' | 'alert' | 'x' | 'info' | 'minus' }> = {
  valid: { tone: 'success', icon: 'check-circle' }, expiring: { tone: 'warning', icon: 'clock' }, expired: { tone: 'danger', icon: 'alert' }, missing: { tone: 'danger', icon: 'x' },
  pending: { tone: 'info', icon: 'info' }, below_minimum: { tone: 'warning', icon: 'alert' }, not_applicable: { tone: 'neutral', icon: 'minus' },
};
export function CellBadge({ state, label }: { state: string; label?: ReactNode }) {
  const t = useTranslations('quality');
  const c = CELL_TONE[state] ?? CELL_TONE.missing!;
  return <Badge tone={c.tone} icon={c.icon}>{label ?? t(`state.${state}` as 'state.valid')}</Badge>;
}

export function ActionError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return <Banner tone="danger" live="assertive">{error.message}</Banner>;
}

/** Pill tabs bound to local state. */
export function PillTabs<K extends string>({ items, value, onChange }: { items: Array<[K, string, number?]>; value: K; onChange: (k: K) => void }) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1.5">
      {items.map(([k, label, badge]) => (
        <button key={k} role="tab" type="button" aria-selected={value === k} onClick={() => onChange(k)} className={cx('flex h-[42px] items-center gap-1.5 rounded-full px-4 text-[13px] font-bold', value === k ? 'bg-ink text-white' : 'bg-surface')}>
          {label}
          {!!badge && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[11px] text-white">{badge}</span>}
        </button>
      ))}
    </div>
  );
}

/** Stat tiles in pastel colours. */
export function Tiles({ items }: { items: Array<{ label: string; value: ReactNode; sub?: ReactNode; tone?: 'danger' }> }) {
  const pastel = ['#E2F5A6', '#CDEEEE', '#E9DDF8', '#F7EDA8', '#F8D6D8', '#D4E6D9'];
  return (
    <section className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr))]">
      {items.map((m, i) => (
        <div key={m.label} className="rounded-lg p-4" style={{ background: m.tone === 'danger' ? '#F8D6D8' : pastel[i % pastel.length] }}>
          <div className="text-xs font-semibold">{m.label}</div>
          <div className="tabular text-[24px] font-extrabold">{m.value}</div>
          {m.sub && <div className="text-[11px]">{m.sub}</div>}
        </div>
      ))}
    </section>
  );
}

/** A tiny bar trend (0–100) for scores by month; empty months show a gap. */
export function Trend({ values, labels, threshold }: { values: Array<number | null>; labels: string[]; threshold?: number }) {
  return (
    <span className="inline-flex h-8 items-end gap-[3px]" role="img" aria-label={values.map((v, i) => `${labels[i]}: ${v ?? '—'}`).join(', ')}>
      {values.map((v, i) => (
        <span key={i} title={`${labels[i]}: ${v ?? '—'}`} className={cx('w-2 rounded-sm', v === null ? 'bg-line-soft' : threshold !== undefined && v < threshold ? 'bg-danger' : 'bg-ink')} style={{ height: v === null ? 4 : Math.max(4, Math.round((v / 100) * 32)) }} />
      ))}
    </span>
  );
}

'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Badge, Button, type Tone } from '@bh/ui';
import type { Currency } from '@bh/shared';
import { fmtYmd, moneyWithCode } from '@/lib/format';
import type { ApiError } from '@/lib/errors';
import { Banner } from '../ui/States';

/** Money in minor units with its currency (never combined across currencies). */
export function useMoney() {
  const locale = useLocale();
  return (minor: number, currency: string) => moneyWithCode({ amount: minor, currency: currency as Currency }, locale);
}

export function useDate() {
  const locale = useLocale();
  return (ymd: string | null | undefined) => (ymd ? fmtYmd(ymd.slice(0, 10), locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
}

/** "September 2026" or "12–18 Oct 2026" for a period. */
export function usePeriodLabel() {
  const locale = useLocale();
  return (p: { startDate: string; endDate: string; frequency?: string } | null | undefined) => {
    if (!p) return '—';
    const start = new Date(`${p.startDate}T12:00:00Z`);
    if (p.frequency !== 'weekly') return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(start);
    const end = new Date(Date.parse(`${p.endDate}T12:00:00Z`) - 86_400_000);
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).formatRange(start, end);
  };
}

const STATEMENT_TONE: Record<string, Tone> = { draft: 'neutral', disputed: 'warning', approved: 'info', invoiced: 'success', void: 'neutral' };
const INVOICE_TONE: Record<string, Tone> = { open: 'info', processing: 'info', paid: 'success', overdue: 'danger', void: 'neutral' };

export function StatementBadge({ status }: { status: string }) {
  const t = useTranslations('finance');
  return <Badge tone={STATEMENT_TONE[status] ?? 'neutral'}>{t(`statementStatus.${status}`)}</Badge>;
}

export function InvoiceBadge({ state }: { state: string }) {
  const t = useTranslations('finance');
  return <Badge tone={INVOICE_TONE[state] ?? 'neutral'}>{t(`invoiceState.${state}`)}</Badge>;
}

/** Totals per currency as separate tiles, with the "no conversion" note when there is more than one currency. */
export function CurrencyTiles({ items, label, sub }: { items: Array<{ currency: string; amountMinor: number }>; label: (currency: string) => string; sub?: (currency: string) => ReactNode }) {
  const t = useTranslations('finance');
  const money = useMoney();
  const pastel = ['#E2F5A6', '#CDEEEE', '#E9DDF8', '#F7EDA8', '#F8D6D8', '#D4E6D9'];
  if (!items.length) return null;
  return (
    <section className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))]">
      {items.map((m, i) => (
        <div key={m.currency} className="rounded-lg p-4" style={{ background: pastel[i % pastel.length] }}>
          <div className="text-xs font-semibold">{label(m.currency)}</div>
          <div className="tabular text-[24px] font-extrabold">{money(m.amountMinor, m.currency)}</div>
          {sub && <div className="text-[11px]">{sub(m.currency)}</div>}
        </div>
      ))}
      {items.length > 1 && (
        <div className="rounded-lg bg-surface p-4">
          <div className="text-xs font-semibold">{t('common.combined')}</div>
          <div className="text-sm text-stone">{t('common.noConversion', { currencies: items.map((x) => x.currency).join(' + ') })}</div>
        </div>
      )}
    </section>
  );
}

export function ActionError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return <Banner tone="danger" live="assertive">{error.message}</Banner>;
}

export function SandboxNote() {
  const t = useTranslations('finance');
  return <Banner tone="neutral" icon="info">{t('common.sandbox')}</Banner>;
}

/** Pill tabs bound to local state. */
export function PillTabs<K extends string>({ items, value, onChange }: { items: Array<[K, string, number?]>; value: K; onChange: (k: K) => void }) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1.5">
      {items.map(([k, label, badge]) => (
        <button key={k} role="tab" type="button" aria-selected={value === k} onClick={() => onChange(k)} className={`flex h-[42px] items-center gap-1.5 rounded-full px-4 text-[13px] font-bold ${value === k ? 'bg-ink text-white' : 'bg-surface'}`}>
          {label}
          {!!badge && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[11px] text-white">{badge}</span>}
        </button>
      ))}
    </div>
  );
}

/** Minor units from a decimal string typed by the user (e.g. "12.50" → 1250). */
export function toMinor(input: string): number | null {
  const s = input.trim().replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const v = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return neg ? -v : v;
}

export function DownloadButton({ onClick, label, pending }: { onClick: () => void; label: string; pending?: boolean }) {
  return (
    <Button variant="secondary" size="sm" icon="download" loading={pending} onClick={onClick}>
      {label}
    </Button>
  );
}

'use client';

import { cloneElement, useState, type ReactElement, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { Currency } from '@bh/shared';
import { Badge, Field, Select, cx, type Tone } from '@bh/ui';
import type { ApiError } from '@/lib/errors';
import { fmtDateTime, moneyWithCode, relativeTime } from '@/lib/format';
import type { CState } from '@/lib/commerce/client';
import type { M } from '@/lib/commerce/types';
import { useApp } from '../../shell/AppContext';
import { Banner, DeniedState, ErrorState, LoadingBlock } from '../../ui/States';

export const useCt = () => useTranslations('commerceApp');

export function Money({ m, className }: { m: M | null | undefined; className?: string }) {
  const locale = useLocale();
  const t = useCt();
  if (!m) return <span className={cx('text-stone', className)}>{t('common.unavailable')}</span>;
  return <span className={cx('tabular', className)}>{moneyWithCode({ amount: m.amount, currency: m.currency as Currency }, locale)}</span>;
}

/** Amounts in several currencies, listed separately (never added together). */
export function MoneyList({ values }: { values: M[] }) {
  const t = useCt();
  if (!values.length) return <span className="text-stone">{t('common.none')}</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {values.map((v) => <Money key={v.currency} m={v} className="font-bold" />)}
    </span>
  );
}

const TONES: Record<string, Record<string, Tone>> = {
  payment: { pending: 'warning', paid: 'success', failed: 'danger', expired: 'neutral', cancelled: 'neutral', refunded: 'info', partially_refunded: 'info', external: 'info', not_required: 'neutral' },
  fulfilment: { unfulfilled: 'info', picking: 'info', packed: 'info', ready_for_pickup: 'success', out_for_delivery: 'info', partially_fulfilled: 'warning', fulfilled: 'success', backordered: 'warning', awaiting_transfer: 'warning', stock_conflict: 'danger', cancelled: 'neutral' },
  transfer: { requested: 'warning', approved: 'info', rejected: 'danger', in_transit: 'info', received: 'success', cancelled: 'neutral' },
  return: { requested: 'warning', reviewed: 'info', authorised: 'info', received: 'info', refund_pending_approval: 'warning', resolved: 'success', rejected: 'neutral' },
  po: { draft: 'neutral', sent: 'info', partially_received: 'warning', received: 'success', cancelled: 'neutral' },
  count: { in_progress: 'info', submitted: 'warning', applied: 'success', cancelled: 'neutral' },
  product: { draft: 'neutral', active: 'success', archived: 'neutral' },
  result: { synced: 'success', skipped: 'neutral', failed: 'danger', ready: 'success', blocked: 'danger' },
  connection: { connected: 'success', initial_sync: 'info', degraded: 'warning', disconnected: 'danger', authorization_expired: 'danger' },
};

/** Status always shown as text + icon (tone icon), never colour alone. */
export function StatusBadge({ kind, value, className }: { kind: keyof typeof TONES; value: string; className?: string }) {
  const t = useCt();
  const label = t.has(`status.${kind}.${value}`) ? t(`status.${kind}.${value}`) : value.replace(/_/g, ' ');
  return <Badge tone={TONES[kind]?.[value] ?? 'neutral'} className={className}>{label}</Badge>;
}

export function When({ iso, tz }: { iso: string | null | undefined; tz?: string | null }) {
  const locale = useLocale();
  const t = useCt();
  if (!iso) return <span className="text-stone">{t('common.unavailable')}</span>;
  return <time dateTime={iso} title={fmtDateTime(iso, tz ?? 'UTC', locale)}>{relativeTime(iso, locale)}</time>;
}

/** Store selector limited to the active scope. */
export function StorePicker({ value, onChange, label, includeAll, id }: { value: string; onChange: (v: string) => void; label?: string; includeAll?: boolean; id?: string }) {
  const app = useApp();
  const t = useCt();
  const ids = app.scope.locationIds;
  const locs = app.locations.filter((l) => !ids.length || ids.includes(l.id));
  return (
    <label className="flex items-center gap-2 text-sm font-semibold">
      <span className="text-stone">{label ?? t('common.store')}</span>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-10 min-w-48">
        {includeAll && <option value="">{t('common.allStores')}</option>}
        {locs.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.currency}</option>)}
      </Select>
    </label>
  );
}

export function useScopeStores() {
  const app = useApp();
  const ids = app.scope.locationIds;
  return app.locations.filter((l) => !ids.length || ids.includes(l.id));
}

export function View<T>({ res, children, loading, empty, isEmpty }: { res: CState<T> & { reload: () => void }; children: (d: T) => ReactNode; loading?: ReactNode; empty?: ReactNode; isEmpty?: (d: T) => boolean }) {
  if (res.status === 'error') return res.error.isForbidden ? <DeniedState detail={res.error.message} /> : <ErrorState error={res.error} onRetry={res.reload} />;
  if (res.data === undefined) return <>{loading ?? <LoadingBlock variant="table" />}</>;
  if (isEmpty?.(res.data) && empty) return <>{empty}</>;
  return <>{children(res.data)}</>;
}

export function ActionError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const fields = error.fields ? Object.values(error.fields).filter((f) => f !== error.message) : [];
  return (
    <Banner tone="danger" live="assertive">
      {error.message}
      {fields.length > 0 && <ul className="ms-4 list-disc">{fields.map((f) => <li key={f}>{f}</li>)}</ul>}
    </Banner>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'warning' | 'danger' }) {
  return (
    <div className={cx('rounded-lg bg-canvas-raised p-4', tone === 'warning' && 'outline outline-1 outline-warning', tone === 'danger' && 'outline outline-1 outline-danger')}>
      <div className="text-xs font-bold text-stone">{label}</div>
      <div className="mt-1 text-[22px] font-bold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-stone">{hint}</div>}
    </div>
  );
}

export function NumberInput({ value, onChange, min = 0, label, className }: { value: number; onChange: (n: number) => void; min?: number; label: string; className?: string }) {
  return <input type="number" aria-label={label} min={min} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} className={cx('h-10 w-20 rounded-md border border-line bg-white px-2 text-right tabular', className)} />;
}

/** Major-unit text input for a money amount (stored as minor units). */
export function MoneyInput({ minor, currency, onChange, label }: { minor: number | null; currency: string; onChange: (minor: number | null) => void; label: string }) {
  const digits = currency === 'JPY' ? 0 : 2;
  return (
    <span className="inline-flex items-center gap-1">
      <input type="number" step={digits ? '0.01' : '1'} min={0} aria-label={label} value={minor === null ? '' : (minor / 10 ** digits).toFixed(digits)}
        onChange={(e) => onChange(e.target.value === '' ? null : Math.round(Number(e.target.value) * 10 ** digits))} className="h-10 w-28 rounded-md border border-line bg-white px-2 text-right tabular" />
      <span className="text-xs font-bold text-stone">{currency}</span>
    </span>
  );
}

export function History({ items, tz }: { items: Array<{ at: string; event: string; note?: string }>; tz?: string | null }) {
  const t = useCt();
  const locale = useLocale();
  return (
    <ol className="flex flex-col gap-2 border-l border-line-soft pl-4 text-[13px]">
      {[...items].reverse().map((h, i) => (
        <li key={i}>
          <div className="font-bold">{t.has(`event.${h.event}`) ? t(`event.${h.event}`) : h.event.replace(/_/g, ' ')}</div>
          <div className="text-xs text-stone">{fmtDateTime(h.at, tz ?? 'UTC', locale)}{h.note ? ` · ${h.note}` : ''}</div>
        </li>
      ))}
    </ol>
  );
}

/** Field wrapper that wires the label to a single child control. */
export function F({ label, hint, optional, error, children }: { label: string; hint?: string; optional?: boolean; error?: string; children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }> }) {
  return <Field label={label} hint={hint} optional={optional} error={error}>{(ids) => cloneElement(children, { id: ids.id, 'aria-describedby': ids.describedBy, 'aria-invalid': ids.invalid || undefined })}</Field>;
}

/** Selected store within the scope (falls back to the first store when the scope changes). */
export function useStore(): [string, (v: string) => void] {
  const stores = useScopeStores();
  const [v, set] = useState('');
  return [stores.some((s) => s.id === v) ? v : stores[0]?.id ?? '', set];
}

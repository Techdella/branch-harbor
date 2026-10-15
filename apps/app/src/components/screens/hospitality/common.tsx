'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Field, Select, type Tone } from '@bh/ui';
import type { IconName } from '@bh/icons';
import type { Currency, Money } from '@bh/shared';
import type { ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { hosp, useHosp, type Property } from '@/lib/hospitality/api';
import { useApp } from '../../shell/AppContext';
import { Banner, Empty, ErrorState, LoadingBlock } from '../../ui/States';
import { NotAvailable } from '../NotAvailable';

const PICK_KEY = 'bh.hospitality.property';

/** Properties the viewer can see, filtered to the selected scope, plus the remembered selection. */
export function useProperty() {
  const app = useApp();
  const res = useHosp(() => hosp.properties(), []);
  const inScope = useMemo(() => (res.data ?? []).filter((p) => app.scope.locationIds.length === 0 || app.scope.locationIds.includes(p.locationId)), [res.data, app.scope.locationIds]);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    try { setPicked(window.localStorage.getItem(PICK_KEY)); } catch { /* storage unavailable */ }
  }, []);
  const current = inScope.find((p) => p.locationId === picked) ?? inScope[0] ?? null;
  const pick = (id: string) => {
    setPicked(id);
    try { window.localStorage.setItem(PICK_KEY, id); } catch { /* storage unavailable */ }
  };
  return { res, properties: inScope, current, pick };
}

export function PropertyPicker({ properties, current, onPick }: { properties: Property[]; current: Property | null; onPick: (id: string) => void }) {
  const t = useTranslations('hosp');
  if (properties.length <= 1) return current ? <span className="text-sm font-bold">{current.name}</span> : null;
  return (
    <div className="w-full max-w-xs">
      <Field label={t('common.property')}>
        {({ id }) => (
          <Select id={id} value={current?.locationId ?? ''} onChange={(e) => onPick(e.target.value)}>
            {properties.map((p) => <option key={p.locationId} value={p.locationId}>{p.name} · {p.currency}</option>)}
          </Select>
        )}
      </Field>
    </div>
  );
}

/** Wraps a screen that needs one property: loading, errors and the empty state. */
export function WithProperty({ children }: { children: (p: Property, picker: ReactNode) => ReactNode }) {
  const t = useTranslations('hosp');
  const { res, properties, current, pick } = useProperty();
  if (res.status === 'loading' && !res.data) return <LoadingBlock variant="table" />;
  if (res.status === 'error') return <HError error={res.error} onRetry={res.reload} />;
  if (!current) return <Empty icon="bed" title={t('common.noPropertiesTitle')} body={t('common.noPropertiesBody')} />;
  return <>{children(current, <PropertyPicker properties={properties} current={current} onPick={pick} />)}</>;
}

export function HError({ error, onRetry }: { error?: ApiError; onRetry?: () => void }) {
  if (error?.isForbidden) return <NotAvailable />;
  return <ErrorState error={error} onRetry={onRetry} />;
}

export function HAsync<T>({ res, children, variant = 'table' }: { res: { status: string; data?: T; error?: ApiError; reload: () => void }; children: (d: T) => ReactNode; variant?: 'cards' | 'table' | 'detail' | 'calendar' }) {
  if (res.status === 'loading' && res.data === undefined) return <LoadingBlock variant={variant} />;
  if (res.status === 'error') return <HError error={res.error} onRetry={res.reload} />;
  if (res.data === undefined) return null;
  return <>{children(res.data)}</>;
}

export function M({ value }: { value: Money | null | undefined }) {
  const locale = useLocale();
  const t = useTranslations('hosp');
  if (!value) return <span className="text-stone">{t('common.notAvailable')}</span>;
  return <span className="tabular-nums">{money({ amount: value.amount, currency: value.currency as Currency }, locale)}</span>;
}

export const pct = (v: number | null, locale: string) => (v === null ? null : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(v));

export const RES_TONE: Record<string, { tone: Tone; icon: IconName }> = {
  hold: { tone: 'warning', icon: 'clock' },
  confirmed: { tone: 'info', icon: 'check' },
  checked_in: { tone: 'success', icon: 'key' },
  checked_out: { tone: 'neutral', icon: 'check-circle' },
  cancelled: { tone: 'danger', icon: 'x' },
  no_show: { tone: 'danger', icon: 'alert' },
  expired: { tone: 'neutral', icon: 'clock' },
};
export function ResStatus({ status }: { status: string }) {
  const t = useTranslations('hosp.status');
  const s = RES_TONE[status] ?? { tone: 'neutral' as Tone, icon: 'info' as IconName };
  return <Badge tone={s.tone} icon={s.icon}>{t(status as 'hold')}</Badge>;
}

export const HK_TONE: Record<string, Tone> = { clean: 'info', inspected: 'success', dirty: 'warning', out_of_order: 'danger' };
export function HkStatus({ status }: { status: string }) {
  const t = useTranslations('hosp.hk');
  return <Badge tone={HK_TONE[status] ?? 'neutral'}>{t(status as 'clean')}</Badge>;
}

/** Major units → minor units for the property currency (two decimals; JPY has none). */
export const toMinor = (major: string, currency: string) => Math.round(Number(major.replace(',', '.')) * (currency === 'JPY' ? 1 : 100));
export const toMajor = (minor: number, currency: string) => (currency === 'JPY' ? String(minor) : (minor / 100).toFixed(2));
export const addDaysYmd = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

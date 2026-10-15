'use client';

import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { cx } from '@bh/ui';
import type { IconName } from '@bh/icons';
import type { Currency } from '@bh/shared';
import { moneyWithCode } from '@/lib/format';
import { useApp } from '../shell/AppContext';

export const CHANNEL_ICON: Record<string, IconName> = { email: 'mail', sms: 'phone', whatsapp: 'message', instagram: 'image', messenger: 'message' };
export const NETWORK_ICON: Record<string, IconName> = { facebook: 'thumb', instagram: 'image', linkedin: 'briefcase', google_business: 'pin' };

/** Location name lookup from the workspace directory (null id = HQ). */
export function useLocationName() {
  const app = useApp();
  const t = useTranslations('comms');
  return (id: string | null | undefined) => (id ? app.locations.find((l) => l.id === id)?.name ?? t('common.unknownLocation') : t('common.hq'));
}

/** The locations of the selected scope (`null` = the whole organisation). */
export function useScopeLocations(): string[] | null {
  const app = useApp();
  return app.scope.kind === 'all' ? null : app.scope.locationIds;
}

export function useMoney() {
  const locale = useLocale();
  return (amount: number, currency: string) => moneyWithCode({ amount, currency: currency as Currency }, locale);
}

/** Holds a module action anywhere in the organisation (the API checks the exact scope). */
export function useCan() {
  const app = useApp();
  return (module: string, action: 'view' | 'edit' | 'publish' | 'export' = 'view') => app.capabilities.has(`${module}:${action}`);
}

export function Chip({ active, onClick, children, label }: { active: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button type="button" aria-pressed={active} aria-label={label} onClick={onClick} className={cx('h-9 rounded-full border-[1.5px] px-3.5 text-[13px] font-semibold', active ? 'border-ink bg-ink text-white' : 'border-line-soft bg-surface hover:border-ink')}>
      {children}
    </button>
  );
}

/** Minor units ↔ decimal input (2-decimal currencies; JPY-like currencies use whole units). */
export const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);
export const toMinor = (v: string, currency: string) => {
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(ZERO_DECIMAL.has(currency) ? n : n * 100);
};

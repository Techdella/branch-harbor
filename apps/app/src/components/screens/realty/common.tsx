'use client';

import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, type Tone } from '@bh/ui';
import type { IconName } from '@bh/icons';
import type { Money } from '@bh/shared';
import type { RealtyCtx } from '@/lib/realty/api';
import type { ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { Banner, ErrorState, LoadingBlock } from '../../ui/States';

/** The realty request context: persona, locations in the selected scope and the API scope for reports. */
export function useRealtyCtx(): RealtyCtx {
  const app = useApp();
  return useMemo(() => {
    const [k, v] = app.scope.id.split(':') as [string, string | undefined];
    const scope: RealtyCtx['scope'] = k === 'region' && v ? { kind: 'region', id: v } : k === 'group' && v ? { kind: 'owner_group', id: v } : k === 'loc' && v ? { kind: 'location', id: v } : { kind: 'organization', id: null };
    return { role: app.role, locationIds: app.scope.locationIds, scope };
  }, [app.role, app.scope]);
}

export const LISTING_TONE: Record<string, { tone: Tone; icon: IconName }> = {
  draft: { tone: 'neutral', icon: 'edit' },
  coming_soon: { tone: 'info', icon: 'clock' },
  active: { tone: 'success', icon: 'check' },
  under_offer: { tone: 'warning', icon: 'receipt' },
  sold: { tone: 'neutral', icon: 'check-circle' },
  let: { tone: 'neutral', icon: 'check-circle' },
  withdrawn: { tone: 'danger', icon: 'x' },
};

export function ListingStatusBadge({ status }: { status: string }) {
  const t = useTranslations('realty.status');
  const s = LISTING_TONE[status] ?? { tone: 'neutral' as Tone, icon: 'info' as IconName };
  return <Badge tone={s.tone} icon={s.icon}>{t(status as 'draft')}</Badge>;
}

export function ApprovalBadge({ status }: { status: string }) {
  const t = useTranslations('realty.approval');
  if (status === 'pending') return <Badge tone="warning" icon="shield">{t('pending')}</Badge>;
  if (status === 'rejected') return <Badge tone="danger" icon="x">{t('rejected')}</Badge>;
  return null;
}

export function Price({ value, rentPeriod }: { value: Money | null | undefined; rentPeriod?: string | null }) {
  const locale = useLocale();
  const t = useTranslations('realty');
  if (!value) return <span className="text-stone">{t('unavailable')}</span>;
  return (
    <span className="font-bold tabular-nums">
      {money(value, locale)}
      {rentPeriod ? <span className="font-normal text-stone"> / {t(`per.${rentPeriod}` as 'per.month')}</span> : null}
    </span>
  );
}

/** Generic async block for realty resources. */
export function RAsync<T>({ res, children, variant = 'table', empty, isEmpty }: { res: { status: string; data?: T; error?: ApiError; reload: () => void }; children: (d: T) => ReactNode; variant?: 'cards' | 'table' | 'detail' | 'calendar'; empty?: ReactNode; isEmpty?: (d: T) => boolean }) {
  if (res.status === 'loading' && res.data === undefined) return <LoadingBlock variant={variant} />;
  if (res.status === 'error') {
    if (res.error?.isForbidden) return <Banner tone="neutral" icon="lock">{res.error.message}</Banner>;
    return <ErrorState error={res.error} onRetry={res.reload} />;
  }
  if (res.data === undefined) return null;
  if (empty && isEmpty?.(res.data)) return <>{empty}</>;
  return <>{children(res.data)}</>;
}

export function Stat({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-surface p-4">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-stone">{icon}{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-stone">{sub}</div>}
    </div>
  );
}

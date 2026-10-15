'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, cx, type Tone } from '@bh/ui';
import { STATUS_COLORS } from '@bh/ui/map';
import type { ApiError } from '@/lib/errors';
import { Banner } from '../ui/States';

export { useQFmt as useFmt, PillTabs, Tiles } from '../quality/ui';

const TERRITORY_TONE: Record<string, Tone> = { available: 'success', reserved: 'warning', sold: 'info', under_development: 'info', open: 'neutral', unavailable: 'neutral' };

export function TerritoryStatus({ status }: { status: string }) {
  const t = useTranslations('fdev');
  return (
    <Badge tone={TERRITORY_TONE[status] ?? 'neutral'}>
      <span aria-hidden="true" className="me-1 inline-block h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[status] ?? '#6B7280' }} />
      {t(`territoryStatus.${status}` as 'territoryStatus.available')}
    </Badge>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  draft: 'neutral', in_review: 'warning', approved: 'info', completed: 'success', rejected: 'danger', cancelled: 'neutral',
  issued: 'warning', cured: 'success', escalated: 'danger', terminated: 'danger', withdrawn: 'neutral',
  signed: 'success', pending: 'neutral', opened: 'success', missed: 'danger', waived: 'neutral',
  upcoming: 'neutral', window_open: 'warning', notice_received: 'info', declined: 'danger', renewed: 'success', lapsed: 'danger',
  requested: 'warning', scheduled: 'info', no_show: 'danger', paid: 'success', active: 'success', archived: 'neutral', open: 'warning', closed: 'neutral', in_progress: 'info', done: 'success',
};

/** Status badge for lifecycle, survey, validation and statement records (`fdev.status.*`). */
export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('fdev');
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{t(`status.${status}` as 'status.draft')}</Badge>;
}

export function ActionError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return <Banner tone="danger" live="assertive">{error.message}</Banner>;
}

export function KeyValue({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-3 gap-y-1.5 text-[13px]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-stone">{k}</dt>
          <dd className="font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A horizontal bar 0–1 with a label (score parts, distributions). */
export function Bar({ value, label, tone = 'ink' }: { value: number; label: string; tone?: 'ink' | 'lime' | 'danger' }) {
  return (
    <span className="flex items-center gap-2" role="img" aria-label={label}>
      <span className="relative h-2 w-full overflow-hidden rounded-full bg-canvas">
        <span className={cx('absolute inset-y-0 start-0 rounded-full', tone === 'ink' ? 'bg-ink' : tone === 'lime' ? 'bg-lime' : 'bg-danger')} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </span>
    </span>
  );
}

export const COUNTRY_RE = /^[A-Z]{2}$/;

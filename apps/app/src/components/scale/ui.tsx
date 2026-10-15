'use client';

import { useTranslations } from 'next-intl';
import { Badge, type Tone } from '@bh/ui';
import type { ConnectionVM } from './api';

export { ActionError, PillTabs, Tiles, useQFmt } from '../quality/ui';

const STATUS_TONE: Record<ConnectionVM['status'], Tone> = { connected: 'success', pending_authorisation: 'info', error: 'danger', authorization_expired: 'warning', disconnected: 'neutral' };

export function ConnectionStatus({ c }: { c: Pick<ConnectionVM, 'status' | 'mode'> }) {
  const t = useTranslations('scale');
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={STATUS_TONE[c.status]}>{t(`status.${c.status}`)}</Badge>
      {c.mode === 'sandbox' && <Badge tone="neutral" icon="info">{t('mode.sandbox')}</Badge>}
    </span>
  );
}

/** Small monogram tile per vendor (no third-party logos). */
export function VendorMark({ provider, size = 36 }: { provider: string; size?: number }) {
  const colors: Record<string, string> = { square: '#E7E5E4', toast: '#FDE2D3', mindbody: '#E9DDF8', shopify: '#DFF3D2', lightspeed: '#FBE4E1', clover: '#D4E6D9' };
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center justify-center rounded-[12px] text-[13px] font-extrabold uppercase" style={{ width: size, height: size, background: colors[provider] ?? '#EEE' }}>
      {provider.slice(0, 2)}
    </span>
  );
}

/** A segmented progress bar (done / failed / remaining). */
export function Progress({ done, failed, total, label }: { done: number; failed?: number; total: number; label: string }) {
  const pct = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done + (failed ?? 0)} className="flex h-2.5 w-full overflow-hidden rounded-full bg-canvas">
      <span className="h-full bg-ink" style={{ width: pct(done) }} />
      {!!failed && <span className="h-full bg-danger" style={{ width: pct(failed) }} />}
    </div>
  );
}

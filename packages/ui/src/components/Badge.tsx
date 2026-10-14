import type { ReactNode } from 'react';
import type { IconName } from '@bh/icons';
import { cx } from '../cx';
import { Icon } from './Icon';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'signal';

const tones: Record<Tone, string> = {
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning',
  danger: 'bg-danger-bg text-danger',
  info: 'bg-info-bg text-info',
  neutral: 'bg-canvas text-graphite',
  signal: 'bg-lime text-ink',
};
const toneIcon: Partial<Record<Tone, IconName>> = { success: 'check-circle', warning: 'alert', danger: 'alert', info: 'info' };

/** Status badge — always text + icon, never colour alone. */
export function Badge({ tone = 'neutral', icon, children, className }: { tone?: Tone; icon?: IconName | null; children: ReactNode; className?: string }) {
  const ic = icon === null ? undefined : (icon ?? toneIcon[tone]);
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold', tones[tone], className)}>
      {ic && <Icon name={ic} size={14} stroke={2.2} />}
      {children}
    </span>
  );
}

/** Neutral pill used for filters, origins ("From headquarters") and metadata. */
export function Tag({ children, pastel, className }: { children: ReactNode; pastel?: string; className?: string }) {
  return (
    <span
      className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold text-ink', !pastel && 'bg-canvas', className)}
      style={pastel ? { background: pastel } : undefined}
    >
      {children}
    </span>
  );
}

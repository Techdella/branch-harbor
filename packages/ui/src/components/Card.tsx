import type { HTMLAttributes, ReactNode } from 'react';
import type { IconName } from '@bh/icons';
import { cx } from '../cx';
import { Icon } from './Icon';

export function Card({ className, padded = true, ...rest }: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return <div className={cx('rounded-card bg-surface', padded && 'p-5 md:p-6', className)} {...rest} />;
}

export function Section({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <section className={cx('rounded-2xl bg-surface p-6 md:p-12', className)} {...rest} />;
}

/** Eyebrow label: 12/800, tracked uppercase. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('text-label font-extrabold uppercase text-stone', className)}>{children}</div>;
}

/** Icons sit in pastel tiles, never alone in colour. */
export function IconTile({ name, pastel = '#EEEDE8', size = 44 }: { name: IconName; pastel?: string; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-sm text-ink" style={{ background: pastel, width: size, height: size }}>
      <Icon name={name} size={Math.round(size * 0.48)} />
    </span>
  );
}

export function EmptyState({ icon = 'info', title, body, action }: { icon?: IconName; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line px-6 py-12 text-center">
      <IconTile name={icon} />
      <div className="text-h3 font-bold">{title}</div>
      {body && <p className="max-w-md text-sm text-stone">{body}</p>}
      {action}
    </div>
  );
}

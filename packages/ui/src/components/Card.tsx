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

export interface StatCardProps {
  label: string;
  /** `null` renders "Unavailable" — never a fabricated zero. */
  value: ReactNode | null;
  range?: string;
  source?: string;
  icon?: IconName;
  pastel?: string;
  notConnected?: boolean;
}

/** Overview metric: shows definition, time range and data source. */
export function StatCard({ label, value, range, source, icon, pastel, notConnected }: StatCardProps) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-bold text-graphite">{label}</div>
        {icon && <IconTile name={icon} pastel={pastel} size={36} />}
      </div>
      <div className="tabular text-[32px] font-extrabold tracking-[-0.03em]">
        {notConnected ? <span className="text-xl text-mute">Not connected</span> : value ?? <span className="text-xl text-mute">Unavailable</span>}
      </div>
      {(range || source) && (
        <div className="text-xs font-semibold text-stone">
          {range}
          {range && source && ' · '}
          {source}
        </div>
      )}
    </Card>
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

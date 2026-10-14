import type { ReactNode } from 'react';
import type { IconName } from '@bh/icons';
import { Icon, cx } from '@/components/ui';
import { STATUS_STYLE, type IntegrationStatus } from '@/content/integrations';

/** Big rounded white panel on the warm canvas. */
export function Panel({ children, className, id, labelledBy, tone = 'white' }: { children: ReactNode; className?: string; id?: string; labelledBy?: string; tone?: 'white' | 'ink' | 'sage' | 'aqua' | 'lilac' }) {
  const tones = { white: 'bg-surface text-ink', ink: 'bg-ink text-white', sage: 'bg-sage text-white', aqua: 'bg-aqua text-ink', lilac: 'bg-lilac text-ink' };
  return (
    <section id={id} aria-labelledby={labelledBy} className={cx('scroll-mt-4 rounded-[28px] px-5 py-10 sm:px-8 md:rounded-2xl md:px-12 md:py-14', tones[tone], className)}>
      {children}
    </section>
  );
}

export function Kicker({ icon, children, className }: { icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2 rounded-full border border-line-soft px-3.5 py-1.5 text-[13px] font-bold', className)}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

export function H2({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <h2 id={id} className={cx('text-[30px] leading-[1.08] font-extrabold tracking-[-0.035em] md:text-[40px]', className)}>
      {children}
    </h2>
  );
}

export function Lead({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('text-base leading-relaxed text-stone md:text-lg', className)}>{children}</p>;
}

/** Integration status label — always text plus icon, never colour alone. */
export function StatusPill({ status, label, className }: { status: IntegrationStatus; label: string; className?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold whitespace-nowrap', className)} style={{ background: s.bg, color: s.fg }}>
      <Icon name={s.icon} size={13} stroke={2.2} />
      {label}
    </span>
  );
}

export function SampleBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[10px] font-extrabold tracking-[0.08em] text-stone uppercase', className)}>
      <Icon name="info" size={12} stroke={2.2} />
      {children}
    </span>
  );
}

/** Accessible FAQ list using native disclosure. */
export function FaqList({ items, className }: { items: { q: string; a: string }[]; className?: string }) {
  return (
    <div className={cx('flex flex-col gap-2', className)}>
      {items.map((f, i) => (
        <details key={i} className="group rounded-[20px] bg-canvas-raised open:bg-canvas" open={i === 0}>
          <summary className="flex min-h-14 items-center justify-between gap-4 rounded-[20px] px-5 py-4 text-start text-base font-bold">
            {f.q}
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface" aria-hidden="true">
              <Icon name="plus" size={15} className="group-open:hidden" />
              <Icon name="minus" size={15} className="hidden group-open:block" />
            </span>
          </summary>
          <p className="px-5 pb-5 text-[15px] leading-relaxed text-graphite">{f.a}</p>
        </details>
      ))}
    </div>
  );
}

export function PastelIcon({ name, bg, size = 44, className }: { name: IconName; bg: string; size?: number; className?: string }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-[14px] text-ink', className)} style={{ background: bg, width: size, height: size }}>
      <Icon name={name} size={Math.round(size * 0.46)} />
    </span>
  );
}

/** Simple sub-page hero inside a panel. */
export function PageHero({ kicker, kickerIcon, title, intro, children, aside }: { kicker: string; kickerIcon?: IconName; title: string; intro: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <Panel className={cx(!!aside && 'grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:items-center')}>
      <div className="flex flex-col items-start gap-5">
        <Kicker icon={kickerIcon}>{kicker}</Kicker>
        <h1 className="max-w-3xl text-[40px] leading-[1.02] font-extrabold tracking-[-0.045em] md:text-[60px]">{title}</h1>
        <Lead className="max-w-2xl">{intro}</Lead>
        {children}
      </div>
      {aside}
    </Panel>
  );
}

export function CheckList({ items, className, icon = 'check' }: { items: string[]; className?: string; icon?: IconName }) {
  return (
    <ul className={cx('flex flex-col gap-2.5', className)}>
      {items.map((x) => (
        <li key={x} className="flex items-start gap-3 text-[15px] leading-snug">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink text-white" aria-hidden="true">
            <Icon name={icon} size={12} stroke={2.6} />
          </span>
          {x}
        </li>
      ))}
    </ul>
  );
}

import type { ReactNode } from 'react';
import type { IconName } from '@bh/icons';
import { Icon, cx } from '@/components/ui';
import { Link } from '@/i18n/navigation';

type Variant = 'primary' | 'secondary' | 'light' | 'ghost' | 'onDark';

const variants: Record<Variant, string> = {
  primary: 'bg-ink text-white hover:bg-ink-2',
  secondary: 'bg-surface text-ink border-[1.5px] border-ink hover:bg-canvas-raised',
  light: 'bg-white text-ink hover:bg-canvas-raised',
  ghost: 'bg-transparent text-ink hover:bg-ink/5',
  onDark: 'bg-transparent text-white border-[1.5px] border-white/50 hover:bg-white/10',
};

export interface LinkButtonProps {
  href: string;
  children: ReactNode;
  variant?: Variant;
  size?: 'md' | 'lg';
  /** Lime circle with an icon at the end — the page's single "signal". */
  signal?: IconName;
  icon?: IconName;
  iconRight?: IconName;
  external?: boolean;
  className?: string;
}

/** Pill-shaped navigation link styled like a button (links navigate; buttons act). */
export function LinkButton({ href, children, variant = 'primary', size = 'md', signal, icon, iconRight, external, className }: LinkButtonProps) {
  const cls = cx(
    'inline-flex items-center justify-center gap-2.5 rounded-full text-center font-bold transition duration-150 ease-bh',
    size === 'lg' ? 'min-h-[54px] py-1.5 text-[15px]' : 'min-h-11 py-1 text-sm',
    signal ? (size === 'lg' ? 'ps-6 pe-1.5' : 'ps-5 pe-1') : size === 'lg' ? 'px-6' : 'px-5',
    variants[variant],
    className,
  );
  const inner = (
    <>
      {icon && <Icon name={icon} size={16} />}
      <span>{children}</span>
      {iconRight && <Icon name={iconRight} size={16} className="rtl:-scale-x-100" />}
      {signal && (
        <span className={cx('flex shrink-0 items-center justify-center rounded-full bg-lime text-ink', size === 'lg' ? 'h-[42px] w-[42px]' : 'h-9 w-9')}>
          <Icon name={signal} size={size === 'lg' ? 18 : 16} className="rtl:-scale-x-100" />
        </span>
      )}
    </>
  );
  if (external) {
    return (
      <a href={href} className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  );
}

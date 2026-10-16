import { useId } from 'react';
import { cx } from '../cx';

export interface MarinaMarkProps {
  /** Diameter in px. Below 24px the small sparkle and the faint second reflection are dropped so it stays crisp. */
  size?: number;
  /** Soft pulse of the guiding light while Marina is working (respects reduced motion). */
  thinking?: boolean;
  className?: string;
  /** Provide a label only when the mark stands alone (otherwise it is decorative). */
  label?: string;
}

/**
 * Marina's mark: a guiding light rising over the harbour, with its reflection on the water.
 * Ink disc, lime light (the brand signal), white horizon. Use it wherever Marina speaks or is offered;
 * use the monochrome `marina` icon inside buttons and navigation.
 */
export function MarinaMark({ size = 32, thinking, className, label }: MarinaMarkProps) {
  const id = useId().replace(/:/g, '');
  const small = size < 24;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={cx('shrink-0', thinking && 'bh-marina-thinking', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={`${id}bg`} x1="8" y1="3" x2="32" y2="38" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#253533" />
          <stop offset=".6" stopColor="#171A19" />
          <stop offset="1" stopColor="#141414" />
        </linearGradient>
        <radialGradient id={`${id}glow`} cx="20" cy="16" r="12.5" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#D6F26B" stopOpacity=".5" />
          <stop offset="1" stopColor="#D6F26B" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="20" cy="20" r="20" fill={`url(#${id}bg)`} />
      <circle className="bh-marina-glow" cx="20" cy="16" r="12.5" fill={`url(#${id}glow)`} />
      <path d="M20 7c.9 5 3.3 7.4 8.3 8.3-5 .9-7.4 3.3-8.3 8.3-.9-5-3.3-7.4-8.3-8.3 5-.9 7.4-3.3 8.3-8.3Z" fill="#D6F26B" />
      {!small && <path d="M28.4 8.2c.22 1.25.82 1.85 2.07 2.07-1.25.22-1.85.82-2.07 2.07-.22-1.25-.82-1.85-2.07-2.07 1.25-.22 1.85-.82 2.07-2.07Z" fill="#FFFFFF" opacity=".85" />}
      <path d="M7.8 26.6c4.1-2 8.1-2 12.2 0s8.1 2 12.2 0" fill="none" stroke="#FFFFFF" strokeWidth={small ? 2.4 : 1.8} strokeLinecap="round" />
      <path d="M16.6 30.2h6.8" stroke="#D6F26B" strokeWidth={small ? 2.2 : 1.6} strokeLinecap="round" opacity=".75" />
      {!small && <path d="M18.4 33.2h3.2" stroke="#D6F26B" strokeWidth="1.4" strokeLinecap="round" opacity=".4" />}
    </svg>
  );
}

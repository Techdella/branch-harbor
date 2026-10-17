import { marinaAvatarSvg, marinaFigureSvg, type MarinaMood, type MarinaPose } from '@bh/icons';
import { cx } from '../cx';

export interface MarinaAvatarProps {
  /** Diameter in px. */
  size?: number;
  /** How Marina looks: happy (default), thinking, celebrate, concerned or sleep. */
  mood?: MarinaMood;
  /** Shortcut for `mood="thinking"` with a gentle bob while she works (respects reduced motion). */
  thinking?: boolean;
  /** Drop the water-blue disc (for use on a coloured surface). */
  bare?: boolean;
  className?: string;
  /** Provide a label only when Marina stands alone (otherwise she is decorative). */
  label?: string;
}

/**
 * Marina, the BranchHarbor assistant, as a sea otter with a lime guiding-star clip. Use the avatar wherever she
 * speaks or is offered; use `MarinaFigure` for welcomes and empty states, and the monochrome `marina` icon inside
 * buttons and navigation.
 */
export function MarinaAvatar({ size = 32, mood, thinking, bare, className, label }: MarinaAvatarProps) {
  const m: MarinaMood = mood ?? (thinking ? 'thinking' : 'happy');
  return (
    <span
      className={cx('inline-block shrink-0 [&>svg]:block [&>svg]:h-full [&>svg]:w-full', thinking && 'bh-marina-working', className)}
      style={{ width: size, height: size }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      dangerouslySetInnerHTML={{ __html: marinaAvatarSvg(m, { background: !bare }) }}
    />
  );
}

/** Earlier name for the avatar; kept so every existing call site shows Marina. */
export const MarinaMark = MarinaAvatar;

export interface MarinaFigureProps {
  /** Width in px (the height follows the artwork, about 0.8 × width). */
  width?: number;
  mood?: MarinaMood;
  pose?: MarinaPose;
  className?: string;
  label?: string;
}

/** Marina rising from the harbour, waving or holding her tablet. For welcomes, empty states and the website. */
export function MarinaFigure({ width = 200, mood = 'happy', pose = 'wave', className, label }: MarinaFigureProps) {
  return (
    <span
      className={cx('inline-block shrink-0 [&>svg]:block [&>svg]:h-full [&>svg]:w-full', pose === 'wave' && 'bh-marina-waving', className)}
      style={{ width, height: Math.round(width * (190 / 240)) }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      dangerouslySetInnerHTML={{ __html: marinaFigureSvg(mood, pose) }}
    />
  );
}

import { ICON_PATHS, type IconName } from '@bh/icons';

export interface IconProps {
  name: IconName;
  size?: number;
  stroke?: number;
  className?: string;
  /** Provide a label only when the icon carries meaning on its own. */
  label?: string;
}

export function Icon({ name, size = 20, stroke = 1.9, className, label }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] ?? ICON_PATHS.info }}
    />
  );
}

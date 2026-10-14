import { cx } from '../cx';

export function LogoMark({ size = 32, dark = false, stem = true }: { size?: number; dark?: boolean; stem?: boolean }) {
  const bg = dark ? '#FFFFFF' : '#141414';
  const fg = dark ? '#141414' : '#FFFFFF';
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" className="shrink-0">
      <rect width="40" height="40" rx="12" fill={bg} />
      <path d="M11 11v18M29 11v18M11 20h18" stroke={fg} strokeWidth="3.4" strokeLinecap="round" fill="none" />
      {stem && <path d="M20 20 20 11" stroke={fg} strokeWidth="3.4" strokeLinecap="round" opacity=".35" />}
      <circle cx="20" cy="20" r="4.2" fill="#D6F26B" />
    </svg>
  );
}

export function Logo({ size = 32, dark = false, className }: { size?: number; dark?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', dark ? 'text-white' : 'text-ink', className)}>
      <LogoMark size={size} dark={dark} />
      <span className="font-extrabold tracking-[-0.04em]" style={{ fontSize: size * 0.62 }}>
        BranchHarbor
      </span>
      <span className="sr-only">BranchHarbor</span>
    </span>
  );
}

import { cx } from '../cx';

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

export function Avatar({ name, src, size = 36, pastel = '#E2F5A6', className }: { name: string; src?: string; size?: number; pastel?: string; className?: string }) {
  return src ? (
    <img src={src} alt="" width={size} height={size} className={cx('shrink-0 rounded-full object-cover', className)} style={{ width: size, height: size }} />
  ) : (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-extrabold text-ink', className)} style={{ width: size, height: size, background: pastel, fontSize: size * 0.36 }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

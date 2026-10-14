'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '@bh/ui';

/** Disclosure popover: button toggles a panel; Esc and outside click close it and return focus. */
export function Popover({
  trigger,
  children,
  label,
  align = 'right',
  className,
  panelClassName,
}: {
  trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  children: (close: () => void) => ReactNode;
  label: string;
  align?: 'left' | 'right';
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        (root.current?.querySelector('[aria-expanded]') as HTMLElement | null)?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={root} className={cx('relative', className)}>
      {trigger({ open, toggle: () => setOpen((o) => !o), id })}
      {open && (
        <div id={id} role="dialog" aria-label={label} className={cx('absolute top-[calc(100%+8px)] z-40 w-[min(360px,calc(100vw-24px))] rounded-lg bg-surface p-2 shadow-pop', align === 'right' ? 'right-0' : 'left-0', panelClassName)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

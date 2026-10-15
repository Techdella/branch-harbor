'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useUiLabels } from '../labels';

/** Record detail drawer (full-screen on mobile). Esc closes; focus moves into the panel. */
export function Drawer({ open, onClose, title, kicker, children, footer }: { open: boolean; onClose: () => void; title: string; kicker?: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const ui = useUiLabels();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="relative flex h-full w-full flex-col bg-surface pb-safe pt-safe shadow-pop outline-none md:w-[480px] md:rounded-l-xl">
        <div className="flex items-start justify-between gap-4 border-b border-line-soft p-6">
          <div className="min-w-0">
            {kicker && <div className="text-label font-extrabold uppercase text-stone">{kicker}</div>}
            <h2 className="text-h2 font-bold">{title}</h2>
          </div>
          <button type="button" onClick={onClose} className="-mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-canvas" aria-label={ui.close}>
            <Icon name="x" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
        {footer && <div className="border-t border-line-soft p-4">{footer}</div>}
      </div>
    </div>
  );
}

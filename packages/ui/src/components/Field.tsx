'use client';

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from '../cx';

const control =
  'w-full rounded-xs border border-line bg-surface px-3.5 text-sm font-medium text-ink placeholder:text-mute transition focus:border-ink focus:outline-none aria-[invalid=true]:border-danger';

interface FieldWrapProps {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}

/** Label + control + hint + inline error. Errors keep the entered value intact. */
export function Field({ label, hint, error, optional, children }: FieldWrapProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-bold text-ink">
        {label} {optional && <span className="font-medium text-stone">(optional)</span>}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {hint && !error && <p id={hintId} className="text-xs text-stone">{hint}</p>}
      {error && <p id={errId} className="text-xs font-bold text-danger">{error}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(control, 'h-11', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cx(control, 'h-11 appearance-none bg-[length:16px] pr-9', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(control, 'min-h-28 py-3', className)} {...rest} />;
});

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx('relative h-6 w-11 rounded-full transition', checked ? 'bg-ink' : 'bg-line')}
    >
      <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition', checked ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

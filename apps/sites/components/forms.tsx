'use client';

import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';

/** Labelled input with its error next to it (WCAG 3.3.1 / 3.3.2). */
export function Field({ label, error, hint, optional, ...rest }: { label: string; error?: string; hint?: string; optional?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const t = useTranslations('common');
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-semibold">
        {label}{optional && <span className="font-normal text-graphite"> ({t('optional')})</span>}
      </label>
      <input id={id} className="field" aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : hint ? `${id}-h` : undefined} {...rest} />
      {hint && !error && <p id={`${id}-h`} className="mt-1 text-xs text-graphite">{hint}</p>}
      {error && <p id={`${id}-e`} className="mt-1 text-sm font-semibold text-danger">{error}</p>}
    </div>
  );
}

export function Checkbox({ label, checked, onChange, error }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; error?: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="flex items-start gap-3 text-sm">
        <input id={id} type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--site-brand)]" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-invalid={error ? true : undefined} />
        <span>{label}</span>
      </label>
      {error && <p className="mt-1 text-sm font-semibold text-danger">{error}</p>}
    </div>
  );
}

/** Accessible summary announced on submit failure; the entered data stays in the form. */
export function ErrorSummary({ message, fields }: { message: string | null; fields?: Record<string, string> }) {
  const t = useTranslations('common');
  if (!message) return null;
  const list = fields ? Object.values(fields) : [];
  return (
    <div role="alert" className="rounded-2xl border border-danger/30 bg-danger-bg p-4 text-sm text-danger">
      <p className="flex items-center gap-2 font-bold"><Icon name="alert" size={18} />{message}</p>
      {list.length > 0 && (
        <>
          <p className="mt-1">{t('errorSummary')}</p>
          <ul className="ms-5 list-disc">{list.map((f) => <li key={f}>{f}</li>)}</ul>
        </>
      )}
    </div>
  );
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PaymentInfo { id: string; sandbox: boolean; amount?: number; currency?: string }

/**
 * Payment step. In sandbox mode (no Stripe keys) the provider confirmation is simulated through the API's
 * sandbox endpoint — the same webhook processor a real payment uses. Without sandbox we don't pretend:
 * card entry (Stripe Elements) isn't wired on hosted sites yet.
 */
export function PayButton({ payment, label, onDone, disabled }: { payment: PaymentInfo; label: string; onDone: (r: { ok: boolean; message?: string }) => void; disabled?: boolean }) {
  const t = useTranslations('booking');
  const tc = useTranslations('common');
  if (!payment.sandbox) return <p className="rounded-2xl bg-warning-bg p-4 text-sm text-warning">{t('cardUnavailable')}</p>;
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn btn-primary w-full sm:w-auto"
        disabled={disabled}
        onClick={async (e) => {
          (e.currentTarget as HTMLButtonElement).disabled = true;
          const r = await call<{ payment: { state: string } }>('POST', `/public/payments/${payment.id}/sandbox-confirm`, { outcome: 'succeeded' });
          if (!r.ok) onDone({ ok: false, message: r.error.message });
          else onDone({ ok: r.data.payment.state === 'succeeded', message: r.data.payment.state === 'succeeded' ? undefined : t('paymentFailed') });
        }}
      >
        <Icon name="card" size={18} />{label}
      </button>
      <p className="flex items-center gap-1.5 text-xs text-graphite"><span className="rounded-full bg-warning-bg px-2 py-0.5 font-bold text-warning">{tc('testMode')}</span>{t('sandboxNote')}</p>
    </div>
  );
}

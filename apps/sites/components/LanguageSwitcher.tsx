'use client';

import { useId } from 'react';
import { LOCALE_LABELS, type Locale } from '@bh/shared';

/** Only the languages the business enabled. Works without JS as a GET form. */
export function LanguageSwitcher({ current, available, label, submitLabel }: { current: string; available: string[]; label: string; submitLabel: string }) {
  const id = useId();
  if (available.length < 2) return null;
  return (
    <form method="get" className="flex items-center">
      <label htmlFor={id} className="sr-only">{label}</label>
      <select
        id={id}
        name="lang"
        defaultValue={current}
        className="h-11 rounded-full border border-line bg-white px-3 text-sm font-semibold"
        onChange={(e) => {
          const u = new URL(window.location.href);
          u.searchParams.set('lang', e.target.value);
          window.location.assign(u.toString());
        }}
      >
        {available.map((l) => (
          <option key={l} value={l} lang={l}>{LOCALE_LABELS[l as Locale] ?? l}</option>
        ))}
      </select>
      <noscript><button type="submit" className="btn btn-secondary ms-2">{submitLabel}</button></noscript>
    </form>
  );
}

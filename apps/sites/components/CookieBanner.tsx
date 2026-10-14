'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

const COOKIE = 'bh_cookie_choice';

/**
 * EU/UK visitors: only essential cookies are used, and the banner says so. The choice is stored in an
 * essential cookie; nothing non-essential is ever set without an explicit opt-in (there is none to set).
 */
export function CookieBanner() {
  const t = useTranslations('cookies');
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);

  useEffect(() => {
    if (!document.cookie.split('; ').some((c) => c.startsWith(`${COOKIE}=`))) setOpen(true);
    const reopen = () => { setOpen(true); setDetails(true); };
    window.addEventListener('bh:cookie-settings', reopen);
    return () => window.removeEventListener('bh:cookie-settings', reopen);
  }, []);

  if (!open) return null;
  const accept = () => {
    document.cookie = `${COOKIE}=essential; path=/; max-age=${60 * 60 * 24 * 180}; samesite=lax`;
    setOpen(false);
  };
  return (
    <section
      role="region"
      aria-label={t('title')}
      className="fixed inset-x-2 bottom-2 z-50 mx-auto max-w-xl rounded-2xl border border-line bg-white p-4 shadow-pop sm:bottom-4 sm:p-5"
    >
      <h2 className="text-base font-bold">{t('title')}</h2>
      <p className="mt-1 text-sm text-graphite">{t('body')}</p>
      {details && (
        <ul className="mt-3 space-y-1 text-sm text-graphite">
          <li>{t('essential')}</li>
          <li>{t('analytics')}</li>
        </ul>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" onClick={accept}>{t('ok')}</button>
        {!details && <button type="button" className="btn btn-secondary" onClick={() => setDetails(true)} aria-expanded={details}>{t('details')}</button>}
      </div>
    </section>
  );
}

export function CookieSettingsButton({ label }: { label: string }) {
  return (
    <button type="button" className="underline underline-offset-2" onClick={() => window.dispatchEvent(new Event('bh:cookie-settings'))}>
      {label}
    </button>
  );
}

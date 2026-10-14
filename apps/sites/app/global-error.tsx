'use client';

import { useEffect, useState } from 'react';
import { isRtl, resolveLocale } from '@bh/shared';
import { fallbackMessages } from '@/lib/fallback-messages';

/**
 * Last-resort error page when even the root layout failed, so next-intl is not available here. The language is
 * the visitor's saved choice (bh_lang cookie) or their browser language; strings live in messages/fallback/.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  const [locale, setLocale] = useState('en');
  useEffect(() => {
    const saved = /(?:^|;\s*)bh_lang=([^;]+)/.exec(document.cookie)?.[1];
    setLocale(resolveLocale(saved ? decodeURIComponent(saved) : navigator.language));
  }, []);
  const m = fallbackMessages(locale);
  return (
    <html lang={locale} dir={isRtl(locale) ? 'rtl' : 'ltr'}>
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 16 }}>
        <main style={{ maxWidth: 480, textAlign: 'center' }}>
          <h1>{m.title}</h1>
          <p>{m.body}</p>
          <button type="button" onClick={reset} style={{ minHeight: 44, padding: '0 20px', borderRadius: 999, border: 0, background: '#141414', color: '#fff', fontWeight: 700 }}>
            {m.retry}
          </button>
        </main>
      </body>
    </html>
  );
}

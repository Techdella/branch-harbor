'use client';

import { useEffect } from 'react';

/**
 * Dynamic number insertion (Marketing → Call tracking): remembers where the visitor came from on their first page
 * (UTM parameters and referrer, for the session) and asks the API which tracking number to show. Elements marked
 * `data-bh-phone="text"` get the number as text and link; `data-bh-phone="href"` only get the link. Without a
 * matching tracking number the location's own number stays.
 */
export function TrackingNumber({ brand, location }: { brand: string; location: string }) {
  useEffect(() => {
    let src: { s: string; m: string; c: string; r: string } | null = null;
    try { src = JSON.parse(sessionStorage.getItem('bh_src') ?? 'null'); } catch { src = null; }
    if (!src) {
      const q = new URLSearchParams(window.location.search);
      src = { s: q.get('utm_source') ?? '', m: q.get('utm_medium') ?? '', c: q.get('utm_campaign') ?? '', r: document.referrer || '' };
      try { sessionStorage.setItem('bh_src', JSON.stringify(src)); } catch { /* private mode */ }
    }
    const qs = new URLSearchParams({ utm_source: src.s, utm_medium: src.m, utm_campaign: src.c, ref: src.r });
    const ctl = new AbortController();
    fetch(`/api/v1/public/call-tracking/${encodeURIComponent(brand)}/${encodeURIComponent(location)}?${qs}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { number: string | null } | null) => {
        if (!d?.number) return;
        const shown = d.number.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '+1 $1 $2 $3');
        document.querySelectorAll<HTMLElement>('[data-bh-phone]').forEach((el) => {
          if (el.dataset.bhPhone === 'text') el.textContent = shown;
          const a = el.tagName === 'A' ? el : el.closest('a');
          if (a) a.setAttribute('href', `tel:${d.number}`);
        });
      })
      .catch(() => { /* keep the real number */ });
    return () => ctl.abort();
  }, [brand, location]);
  return null;
}

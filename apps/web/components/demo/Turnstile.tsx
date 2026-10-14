'use client';

import { useEffect, useRef } from 'react';

/**
 * Cloudflare Turnstile widget (bot protection for the demo form).
 *
 * Rendered only when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set. The token goes to the API as
 * `turnstileToken`; the API must verify it with Cloudflare using TURNSTILE_SECRET_KEY
 * (POST https://challenges.cloudflare.com/turnstile/v0/siteverify). Tokens are single-use and
 * expire after 300 s, so the widget is reset after every submission attempt.
 */
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loader: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loader ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile unavailable')));
    s.onerror = () => {
      loader = null;
      reject(new Error('turnstile failed to load'));
    };
    document.head.appendChild(s);
  });
  return loader;
}

/** Turnstile language codes for our UI locales. */
function widgetLanguage(locale: string): string {
  if (locale === 'pt-BR') return 'pt-br';
  if (locale.startsWith('en')) return 'en';
  return locale.toLowerCase();
}

export function Turnstile({ locale, onToken, resetSignal, describedBy }: { locale: string; onToken: (token: string) => void; resetSignal: number; describedBy?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((ts) => {
        if (cancelled || !el.current || widget.current) return;
        widget.current = ts.render(el.current, {
          sitekey: TURNSTILE_SITE_KEY,
          language: widgetLanguage(locale),
          theme: 'light',
          size: 'flexible',
          action: 'demo_request',
          callback: (token: string) => cb.current(token),
          'expired-callback': () => cb.current(''),
          'error-callback': () => cb.current(''),
        });
      })
      .catch(() => cb.current(''));
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [locale]);

  useEffect(() => {
    if (resetSignal && widget.current) {
      window.turnstile?.reset(widget.current);
      cb.current('');
    }
  }, [resetSignal]);

  return <div ref={el} aria-describedby={describedBy} className="min-h-[65px] w-full max-w-[400px]" />;
}

'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Cookie consent store.
 *
 * Essential cookies (language, security checks such as Turnstile, this choice) are always allowed.
 * Optional categories default to OFF and stay off until the visitor opts in. No analytics script is
 * loaded today; gate any future script (e.g. PostHog) on `useConsent().allows('analytics')`, or
 * listen for the `bh:consent` window event outside React.
 *
 * The choice is stored in a first-party cookie (`bh_consent`, 180 days) so the server can read it
 * too. Bump CONSENT_VERSION when categories or their purposes change to ask again.
 */
export const CONSENT_COOKIE = 'bh_consent';
export const CONSENT_VERSION = 1;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export const OPTIONAL_CATEGORIES = ['analytics', 'marketing'] as const;
export type ConsentCategory = 'essential' | (typeof OPTIONAL_CATEGORIES)[number];
export type ConsentChoices = Record<(typeof OPTIONAL_CATEGORIES)[number], boolean>;

export interface ConsentRecord extends ConsentChoices {
  v: number;
  /** ISO timestamp of the decision. */
  at: string;
}

export interface ConsentApi {
  /** False until the stored choice has been read on the client (avoids hydration flashes). */
  ready: boolean;
  /** The visitor's saved decision, or null when they haven't chosen yet. */
  record: ConsentRecord | null;
  allows: (category: ConsentCategory) => boolean;
  acceptAll: () => void;
  essentialOnly: () => void;
  save: (choices: ConsentChoices) => void;
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
}

const ConsentContext = createContext<ConsentApi | null>(null);

function readCookie(): ConsentRecord | null {
  try {
    const raw = document.cookie
      .split('; ')
      .find((c) => c.startsWith(`${CONSENT_COOKIE}=`))
      ?.slice(CONSENT_COOKIE.length + 1);
    if (!raw) return null;
    const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<ConsentRecord>;
    if (parsed.v !== CONSENT_VERSION) return null;
    return { v: CONSENT_VERSION, at: String(parsed.at ?? ''), analytics: parsed.analytics === true, marketing: parsed.marketing === true };
  } catch {
    return null;
  }
}

function writeCookie(record: ConsentRecord) {
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(record))}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
  } catch {
    /* cookies blocked: the choice applies to this page view only */
  }
}

export function ConsentProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [record, setRecord] = useState<ConsentRecord | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    setRecord(readCookie());
    setReady(true);
  }, []);

  const save = useCallback((choices: ConsentChoices) => {
    const next: ConsentRecord = { v: CONSENT_VERSION, at: new Date().toISOString(), analytics: choices.analytics, marketing: choices.marketing };
    writeCookie(next);
    setRecord(next);
    setSettingsOpen(false);
    window.dispatchEvent(new CustomEvent('bh:consent', { detail: next }));
  }, []);

  const api = useMemo<ConsentApi>(
    () => ({
      ready,
      record,
      allows: (category) => category === 'essential' || (record?.[category] ?? false),
      acceptAll: () => save({ analytics: true, marketing: true }),
      essentialOnly: () => save({ analytics: false, marketing: false }),
      save,
      settingsOpen,
      openSettings: () => setSettingsOpen(true),
      closeSettings: () => setSettingsOpen(false),
    }),
    [ready, record, save, settingsOpen],
  );

  return <ConsentContext.Provider value={api}>{children}</ConsentContext.Provider>;
}

/** Read and change cookie consent. Must be used inside <ConsentProvider>. */
export function useConsent(): ConsentApi {
  const ctx = useContext(ConsentContext);
  if (!ctx) throw new Error('useConsent must be used inside <ConsentProvider>');
  return ctx;
}

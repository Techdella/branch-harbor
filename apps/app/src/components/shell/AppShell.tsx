'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon, cx } from '@bh/ui';
import { Banner } from '../ui/States';
import { AppProvider, useApp } from './AppContext';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { AiPanel } from './AiPanel';

function useIsWide(query: string) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return wide;
}

function Shell({ children }: { children: ReactNode }) {
  const t = useTranslations('shell');
  const app = useApp();
  const path = usePathname();
  const [mobileNav, setMobileNav] = useState(false);
  const xl = useIsWide('(min-width: 1280px)');
  const mainRef = useRef<HTMLElement>(null);
  const navCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMobileNav(false), [path]);
  useEffect(() => {
    if (!mobileNav) return;
    // Modal drawer: move focus in, and keep the page behind from scrolling.
    navCloseRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobileNav(false);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileNav]);

  // Tablet: icon rail (CSS, below lg). Desktop: full nav unless the user collapsed it.
  const collapsed = app.navCollapsed;

  return (
    <div className="flex min-h-viewport items-start gap-3 p-2 md:p-3">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">
        {t('skip')}
      </a>
      <aside className={cx('sticky top-3 hidden h-viewport-inset shrink-0 flex-col overflow-hidden rounded-xl bg-surface md:flex', collapsed ? 'w-[72px]' : 'w-[72px] lg:w-[248px]')}>
        <Sidebar collapsed={collapsed} />
      </aside>

      {mobileNav && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileNav(false)} aria-hidden="true" />
          <div role="dialog" aria-modal="true" aria-label={t('navigation')} className="absolute inset-y-0 left-0 flex w-[min(320px,88vw)] flex-col bg-surface pb-safe pt-safe">
            <button ref={navCloseRef} type="button" onClick={() => setMobileNav(false)} aria-label={t('closeNav')} className="absolute right-3 top-[max(12px,env(safe-area-inset-top))] z-10 flex h-11 w-11 items-center justify-center rounded-full bg-canvas">
              <Icon name="x" size={16} />
            </button>
            <Sidebar collapsed={false} mobile onNavigate={() => setMobileNav(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <TopBar onOpenNav={() => setMobileNav(true)} />
        {app.apiMode === 'fallback' && (
          <Banner tone="warning" title={t('fallbackTitle')}>
            {t('fallbackHint')}
          </Banner>
        )}
        <div className="flex items-start gap-3">
          <main id="main" ref={mainRef} tabIndex={-1} className="flex min-w-0 flex-1 flex-col gap-3 outline-none">
            {app.ready ? children : null}
          </main>
          {app.aiOpen && xl && (
            <div className="sticky top-3 w-[380px] shrink-0">
              <AiPanel onClose={() => app.setAiOpen(false)} />
            </div>
          )}
        </div>
      </div>

      {app.aiOpen && !xl && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 hidden bg-black/40 md:block" onClick={() => app.setAiOpen(false)} aria-hidden="true" />
          <div className="relative h-full w-full md:w-[420px]">
            <AiPanel fullScreen onClose={() => app.setAiOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <Shell>{children}</Shell>
    </AppProvider>
  );
}

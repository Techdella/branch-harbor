'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, Logo, cx } from '@/components/ui';
import { Link, usePathname } from '@/i18n/navigation';
import { INDUSTRIES, INDUSTRY_KEYS } from '@/content/industries';
import { LinkButton } from './LinkButton';
import { LanguageSwitcher } from './LanguageSwitcher';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001';

export function SiteHeader() {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const tm = useTranslations('industryMeta');
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [indOpen, setIndOpen] = useState(false);
  const indRef = useRef<HTMLLIElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const indId = useId();

  // Close menus whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
    setIndOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen && !indOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menuOpen) {
        setMenuOpen(false);
        menuBtnRef.current?.focus();
      }
      setIndOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (indOpen && indRef.current && !indRef.current.contains(e.target as Node)) setIndOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen, indOpen]);

  const active = (prefix: string) => pathname === prefix || pathname.startsWith(prefix + '/');
  const navItem = (on: boolean) =>
    cx('inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-bold transition', on ? 'bg-surface shadow-card' : 'hover:bg-surface/70');

  const links = [
    { href: '/solutions/franchises', label: t('franchises'), on: active('/solutions/franchises') },
    { href: '/wordpress', label: t('wordpressIntegrations'), on: active('/wordpress') || active('/integrations') },
    { href: '/pricing', label: t('pricing'), on: active('/pricing') },
    { href: '/resources', label: t('resources'), on: active('/resources') || active('/docs') },
  ];

  return (
    <header className="relative rounded-[28px] bg-surface md:rounded-2xl">
      <div className="flex items-center gap-4 px-4 py-3 sm:px-6 md:py-4">
        <Link href="/" className="shrink-0 rounded-full" aria-label={tc('homeLabel')}>
          <Logo size={34} />
        </Link>

        <nav aria-label={t('main')} className="mx-auto hidden xl:block">
          <ul className="flex items-center gap-0.5 rounded-full bg-canvas p-1">
            <li ref={indRef} className="relative">
              <button
                type="button"
                aria-expanded={indOpen}
                aria-controls={indId}
                onClick={() => setIndOpen((v) => !v)}
                className={navItem(indOpen || active('/industries'))}
              >
                {t('industries')}
                <Icon name="chevron-down" size={14} className={cx('transition', indOpen && 'rotate-180')} />
              </button>
              <div
                id={indId}
                hidden={!indOpen}
                className="absolute start-1/2 top-[calc(100%+12px)] z-30 w-[min(760px,92vw)] -translate-x-1/2 rounded-[28px] bg-surface p-3 shadow-pop rtl:translate-x-1/2"
              >
                <ul className="grid grid-cols-2 gap-1.5">
                  {INDUSTRY_KEYS.map((k) => {
                    const ind = INDUSTRIES[k];
                    return (
                      <li key={k}>
                        <Link href={`/industries/${k}`} className="flex items-start gap-3 rounded-[18px] p-3 hover:bg-canvas">
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px]" style={{ background: ind.pastel }}>
                            <Icon name={ind.icon} size={20} />
                          </span>
                          <span>
                            <span className="flex flex-wrap items-center gap-2 text-[15px] font-bold">
                              {tm(`${k}.name`)}
                              <span className="rounded-full bg-canvas px-2 py-0.5 text-[10px] font-bold">{tc(`availability.${ind.availability}`)}</span>
                            </span>
                            <span className="mt-0.5 block text-xs leading-snug text-stone">{tm(`${k}.who`)}</span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                  <li>
                    <Link href="/solutions/independent-businesses" className="flex h-full items-center gap-3 rounded-[18px] border-[1.5px] border-dashed border-line p-3 hover:bg-canvas">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-canvas">
                        <Icon name="store" size={20} />
                      </span>
                      <span className="text-sm font-bold">{t('independent')}</span>
                    </Link>
                  </li>
                </ul>
              </div>
            </li>
            {links.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className={navItem(l.on)} aria-current={l.on ? 'page' : undefined}>
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ms-auto hidden items-center gap-4 xl:ms-0 xl:flex">
          <a href={`${APP_URL}/sign-in`} className="rounded-full px-2 py-1 text-sm font-bold hover:underline">
            {tc('signIn')}
          </a>
          {/* No lime here: the page's own primary CTA carries the single lime signal (brand rule). */}
          <LinkButton href="/demo" iconRight="arrow-up-right">
            {tc('requestDemo')}
          </LinkButton>
        </div>

        <div className="ms-auto flex items-center gap-2 xl:hidden">
          <span className="hidden sm:block">
            <LinkButton href="/demo">{tc('requestDemo')}</LinkButton>
          </span>
          <button
            ref={menuBtnRef}
            type="button"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={menuOpen ? t('closeMenu') : t('openMenu')}
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-ink"
          >
            <Icon name={menuOpen ? 'x' : 'menu'} size={20} />
          </button>
        </div>
      </div>

      <nav id={menuId} aria-label={t('mobileMenu')} hidden={!menuOpen} className="border-t border-line-soft px-4 pt-3 pb-6 sm:px-6 xl:hidden">
        <p className="px-1 pt-1 pb-2 text-xs font-bold text-stone">{t('industries')}</p>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {INDUSTRY_KEYS.map((k) => (
            <li key={k}>
              <Link href={`/industries/${k}`} className="flex min-h-[52px] items-center gap-3 rounded-[16px] bg-canvas-raised px-2.5 py-1.5 text-[15px] font-bold">
                <span className="flex h-9 w-9 items-center justify-center rounded-[12px]" style={{ background: INDUSTRIES[k].pastel }}>
                  <Icon name={INDUSTRIES[k].icon} size={18} />
                </span>
                {tm(`${k}.name`)}
                <span className="ms-auto rounded-full bg-surface px-2 py-0.5 text-[10px] font-bold">{tc(`availability.${INDUSTRIES[k].availability}`)}</span>
              </Link>
            </li>
          ))}
        </ul>
        <ul className="mt-3 flex flex-col">
          {[{ href: '/solutions/independent-businesses', label: t('independent') }, ...links, { href: '/integrations', label: t('integrations') }, { href: '/support', label: t('support') }].map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="flex min-h-[52px] items-center justify-between rounded-[16px] px-3 text-base font-bold hover:bg-canvas">
                {l.label}
                <Icon name="chevron-right" size={18} className="rtl:-scale-x-100" />
              </Link>
            </li>
          ))}
          <li>
            <a href={`${APP_URL}/sign-in`} className="flex min-h-[52px] items-center justify-between rounded-[16px] px-3 text-base font-bold hover:bg-canvas">
              {tc('signIn')}
              <Icon name="arrow-up-right" size={18} />
            </a>
          </li>
        </ul>
        <LinkButton href="/demo" size="lg" className="mt-3 w-full">
          {tc('requestDemo')}
        </LinkButton>
        <LanguageSwitcher className="mt-4 px-1" />
      </nav>
    </header>
  );
}

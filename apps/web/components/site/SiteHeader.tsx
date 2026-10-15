'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { IconName } from '@bh/icons';
import { Icon, Logo, cx } from '@/components/ui';
import { Link, usePathname } from '@/i18n/navigation';
import { INDUSTRIES, INDUSTRY_KEYS } from '@/content/industries';
import { APP_URL, DEMO_URL, otherIndustryMailto } from '@/lib/links';
import { LinkButton } from './LinkButton';
import { LanguageSwitcher } from './LanguageSwitcher';

type MenuKey = 'industries' | 'resources';

/** One disclosure menu in the desktop nav: button with a rotating chevron and a panel with a pointer arrow. */
function NavMenu({
  id,
  label,
  open,
  active,
  onToggle,
  align,
  width,
  children,
}: {
  id: string;
  label: string;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  align: 'center' | 'start';
  width: string;
  children: ReactNode;
}) {
  return (
    <>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} className={navItem(open || active)}>
        {label}
        <Icon name="chevron-down" size={16} className={cx('transition-transform duration-200 ease-bh', open && 'rotate-180')} />
      </button>
      <div
        id={id}
        hidden={!open}
        className={cx(
          'absolute top-[calc(100%+14px)] z-40 rounded-[28px] bg-surface p-3 shadow-pop transition duration-150 ease-bh starting:-translate-y-1 starting:opacity-0',
          // Pointer arrow, centred on the button (center) or near its start edge (start).
          'before:absolute before:-top-1.5 before:h-3 before:w-3 before:rotate-45 before:rounded-[3px] before:bg-surface',
          align === 'center' ? 'start-1/2 -translate-x-1/2 before:start-1/2 before:-ms-1.5 rtl:translate-x-1/2' : 'start-0 before:start-12',
          width,
        )}
      >
        {children}
      </div>
    </>
  );
}

const navItem = (on: boolean) =>
  cx(
    'inline-flex h-10 items-center gap-1.5 rounded-full px-3.5 text-sm font-bold whitespace-nowrap min-[100rem]:px-4 transition duration-150 ease-bh',
    on ? 'bg-surface shadow-card' : 'hover:bg-surface/70',
  );

export function SiteHeader() {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const tm = useTranslations('industryMeta');
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState<MenuKey | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const navRef = useRef<HTMLUListElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const indId = useId();
  const resId = useId();

  // Close menus whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
    setOpen(null);
  }, [pathname]);

  // Raise the sticky header (shadow) once the page has scrolled.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen && !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menuOpen) {
        setMenuOpen(false);
        menuBtnRef.current?.focus();
      }
      setOpen(null);
    };
    const onClick = (e: MouseEvent) => {
      if (open && navRef.current && !navRef.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen, open]);

  const active = (prefix: string) => pathname === prefix || pathname.startsWith(prefix + '/');
  const toggle = (k: MenuKey) => setOpen((v) => (v === k ? null : k));
  const otherIndustry = otherIndustryMailto(t('otherIndustrySubject'));

  const links = [
    { href: '/solutions/franchises', label: t('franchises'), on: active('/solutions/franchises') },
    { href: '/wordpress', label: t('wordpressIntegrations'), on: active('/wordpress') || active('/integrations') },
    { href: '/pricing', label: t('pricing'), on: active('/pricing') },
  ];
  const resources: { href: string; label: string; desc: string; icon: IconName }[] = [
    { href: '/blog', label: t('blog'), desc: t('blogDesc'), icon: 'edit' },
    { href: '/guides', label: t('guides'), desc: t('guidesDesc'), icon: 'book' },
    { href: '/docs', label: t('docs'), desc: t('docsDesc'), icon: 'file' },
    { href: '/support', label: t('support'), desc: t('supportDesc'), icon: 'help' },
  ];

  return (
    <header
      className={cx(
        'sticky top-[var(--edge)] z-40 rounded-[28px] bg-surface transition-shadow duration-200 md:rounded-2xl',
        scrolled ? 'shadow-pop' : 'shadow-none',
      )}
    >
      <div className="band flex min-h-[var(--header-h)] items-center gap-4 py-2.5">
        <Link href="/" className="shrink-0 rounded-full" aria-label={tc('homeLabel')}>
          <Logo size={34} />
        </Link>

        <nav aria-label={t('main')} className="mx-auto hidden min-[85rem]:block">
          <ul ref={navRef} className="flex items-center gap-0.5 rounded-full bg-canvas p-1">
            <li className="relative">
              <NavMenu id={indId} label={t('industries')} open={open === 'industries'} active={active('/industries')} onToggle={() => toggle('industries')} align="start" width="w-[min(800px,92vw)]">
                <ul className="grid grid-cols-2 gap-1">
                  {INDUSTRY_KEYS.map((k) => {
                    const ind = INDUSTRIES[k];
                    const here = active(`/industries/${k}`);
                    return (
                      <li key={k}>
                        <Link
                          href={`/industries/${k}`}
                          aria-current={here ? 'page' : undefined}
                          className={cx('flex items-start gap-3 rounded-[18px] p-3 transition hover:bg-canvas focus-visible:bg-canvas', here && 'bg-canvas')}
                        >
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px]" style={{ background: ind.pastel }}>
                            <Icon name={ind.icon} size={20} />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[15px] font-bold">{tm(`${k}.name`)}</span>
                            <span className="mt-0.5 block text-xs leading-snug text-stone">{tm(`${k}.who`)}</span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                  <li>
                    <Link href="/solutions/independent-businesses" className="flex h-full items-center gap-3 rounded-[18px] p-3 transition hover:bg-canvas">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-canvas">
                        <Icon name="store" size={20} />
                      </span>
                      <span className="text-[15px] font-bold">{t('independent')}</span>
                    </Link>
                  </li>
                </ul>
                <a href={otherIndustry} className="mt-1 flex items-center justify-between gap-3 rounded-[18px] border-[1.5px] border-dashed border-line px-4 py-3 text-sm transition hover:bg-canvas">
                  <span>
                    <span className="font-bold">{tc('otherIndustry')}</span> <span className="text-stone">{tc('otherIndustryBody')}</span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1.5 font-bold">
                    {tc('otherIndustryCta')}
                    <Icon name="arrow-right" size={16} className="rtl:-scale-x-100" />
                  </span>
                </a>
              </NavMenu>
            </li>
            {links.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className={navItem(l.on)} aria-current={l.on ? 'page' : undefined}>
                  {l.label}
                </Link>
              </li>
            ))}
            <li className="relative">
              <NavMenu
                id={resId}
                label={t('resources')}
                open={open === 'resources'}
                active={active('/resources') || active('/blog') || active('/guides') || active('/docs') || active('/support')}
                onToggle={() => toggle('resources')}
                align="start"
                width="w-[340px]"
              >
                <ul className="flex flex-col gap-1">
                  {resources.map((r) => (
                    <li key={r.href}>
                      <Link href={r.href} className="flex items-start gap-3 rounded-[18px] p-3 transition hover:bg-canvas">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-canvas">
                          <Icon name={r.icon} size={20} />
                        </span>
                        <span>
                          <span className="block text-[15px] font-bold">{r.label}</span>
                          <span className="mt-0.5 block text-xs leading-snug text-stone">{r.desc}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <Link href="/resources" className="mt-1 flex items-center justify-between rounded-[18px] px-3 py-2.5 text-sm font-bold transition hover:bg-canvas">
                  {t('allResources')}
                  <Icon name="arrow-right" size={16} className="rtl:-scale-x-100" />
                </Link>
              </NavMenu>
            </li>
          </ul>
        </nav>

        <div className="ms-auto hidden items-center gap-1 min-[85rem]:ms-0 min-[85rem]:flex">
          <a href={`${APP_URL}/sign-in`} className="rounded-full px-3 py-2 text-sm font-bold transition hover:bg-canvas">
            {tc('signIn')}
          </a>
          <Link href="/demo" className="hidden rounded-full px-3 py-2 text-sm font-bold transition hover:bg-canvas min-[90rem]:inline-flex">
            {tc('requestDemo')}
          </Link>
          {/* No lime here: the page's own primary CTA carries the single lime signal (brand rule). */}
          <LinkButton href={DEMO_URL} external iconRight="arrow-up-right" className="ms-2">
            {tc('tryDemo')}
          </LinkButton>
        </div>

        <div className="ms-auto flex items-center gap-2 min-[85rem]:hidden">
          <span className="hidden sm:block">
            <LinkButton href={DEMO_URL} external>
              {tc('tryDemo')}
            </LinkButton>
          </span>
          <button
            ref={menuBtnRef}
            type="button"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={menuOpen ? t('closeMenu') : t('openMenu')}
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-ink transition hover:bg-canvas"
          >
            <Icon name={menuOpen ? 'x' : 'menu'} size={20} />
          </button>
        </div>
      </div>

      <nav
        id={menuId}
        aria-label={t('mobileMenu')}
        hidden={!menuOpen}
        className="band max-h-[calc(100dvh-var(--header-h)-3*var(--edge))] overflow-y-auto overscroll-contain border-t border-line-soft pt-3 pb-6 min-[85rem]:hidden"
      >
        <p className="px-1 pt-1 pb-2 text-xs font-bold text-stone">{t('industries')}</p>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {INDUSTRY_KEYS.map((k) => (
            <li key={k}>
              <Link href={`/industries/${k}`} className="flex min-h-[52px] items-center gap-3 rounded-[16px] bg-canvas-raised px-2.5 py-1.5 text-[15px] font-bold transition hover:bg-canvas">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px]" style={{ background: INDUSTRIES[k].pastel }}>
                  <Icon name={INDUSTRIES[k].icon} size={18} />
                </span>
                {tm(`${k}.name`)}
              </Link>
            </li>
          ))}
          <li>
            <a href={otherIndustry} className="flex min-h-[52px] items-center gap-3 rounded-[16px] border-[1.5px] border-dashed border-line px-2.5 py-1.5 text-[15px] font-bold transition hover:bg-canvas">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-canvas">
                <Icon name="plus" size={18} />
              </span>
              {t('otherIndustryShort')}
            </a>
          </li>
        </ul>
        <ul className="mt-3 flex flex-col">
          {[
            { href: '/solutions/independent-businesses', label: t('independent') },
            ...links,
            { href: '/integrations', label: t('integrations') },
            ...resources,
          ].map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="flex min-h-[52px] items-center justify-between rounded-[16px] px-3 text-base font-bold transition hover:bg-canvas">
                {l.label}
                <Icon name="chevron-right" size={16} className="text-stone rtl:-scale-x-100" />
              </Link>
            </li>
          ))}
          <li>
            <a href={`${APP_URL}/sign-in`} className="flex min-h-[52px] items-center justify-between rounded-[16px] px-3 text-base font-bold transition hover:bg-canvas">
              {tc('signIn')}
              <Icon name="arrow-up-right" size={16} className="text-stone" />
            </a>
          </li>
        </ul>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <LinkButton href={DEMO_URL} external size="lg" className="w-full">
            {tc('tryDemo')}
          </LinkButton>
          <LinkButton href={`${APP_URL}/sign-up`} external size="lg" variant="secondary" className="w-full">
            {tc('startPlan')}
          </LinkButton>
          <LinkButton href="/demo" size="lg" variant="ghost" className="w-full">
            {tc('requestDemo')}
          </LinkButton>
        </div>
        <LanguageSwitcher className="mt-4 px-1" />
      </nav>
    </header>
  );
}

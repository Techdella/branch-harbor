'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Avatar, Icon, LogoMark, cx } from '@bh/ui';
import type { ViewRole } from '@/lib/types';
import { INDUSTRY_UI } from '@/lib/nav';
import { getApi } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { APP_LOCALES, APP_LOCALE_LABELS, LOCALE_COOKIE } from '@/i18n/config';
import { Popover } from '../ui/Popover';
import { useApp } from './AppContext';
import { ScopePicker } from './ScopePicker';

export function setLocaleCookie(locale: string) {
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; path=/; max-age=31536000; samesite=lax`;
}

export function LanguageSelect({ className }: { className?: string }) {
  const t = useTranslations('shell');
  const locale = useLocale();
  const router = useRouter();
  return (
    <label className={cx('flex items-center gap-2 text-sm', className)}>
      <Icon name="globe" size={16} />
      <span className="sr-only">{t('language')}</span>
      <select
        value={locale}
        onChange={(e) => {
          setLocaleCookie(e.target.value);
          router.refresh();
        }}
        className="h-9 flex-1 rounded-full border border-line bg-surface px-3 text-sm font-semibold"
      >
        {APP_LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {APP_LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

function Search({ onDone }: { onDone?: () => void }) {
  const t = useTranslations('shell');
  const app = useApp();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<{ type: string; items: { id: string; label: string; sub: string; href: string }[] }[]>([]);
  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const h = setTimeout(async () => setResults(await (await getApi()).search(app.ctx, q).catch(() => [])), 200);
    return () => clearTimeout(h);
  }, [q, app.ctx]);
  return (
    <div className="relative min-w-0 flex-1 md:max-w-[380px]" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <label className="flex h-11 items-center gap-2 rounded-full bg-canvas px-4">
        <Icon name="search" size={16} />
        <span className="sr-only">{t('search')}</span>
        <input
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={t('searchPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-mute"
          aria-controls="bh-search-results"
          aria-expanded={open && !!q}
          role="combobox"
          aria-autocomplete="list"
        />
      </label>
      {open && q.trim() && (
        <div id="bh-search-results" role="listbox" className="absolute left-0 right-0 top-[calc(100%+8px)] z-40 rounded-lg bg-surface p-2 shadow-pop">
          {results.length === 0 ? (
            <p className="p-3 text-sm text-stone">{t('searchEmpty')}</p>
          ) : (
            results.map((g) => (
              <div key={g.type} className="py-1">
                <div className="px-3 py-1 text-[11px] font-bold uppercase tracking-[0.06em] text-mute">{g.type}</div>
                {g.items.map((it) => (
                  <Link key={it.id} href={it.href} role="option" aria-selected={false} onClick={() => (setOpen(false), setQ(''), onDone?.())} className="block rounded-sm px-3 py-2 hover:bg-canvas">
                    <div className="text-sm font-bold">{it.label}</div>
                    <div className="text-xs text-stone">{it.sub}</div>
                  </Link>
                ))}
              </div>
            ))
          )}
          <p className="border-t border-line-soft px-3 pt-2 text-[11px] text-stone">{t('searchScoped')}</p>
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const t = useTranslations('shell');
  const locale = useLocale();
  const app = useApp();
  const res = useApi((api) => api.notifications(app.ctx), [app.ctx.industry, app.ctx.role, app.ctx.scopeId]);
  const items = res.status === 'ready' ? res.data : [];
  const kindTone = { action: 'bg-warning-bg text-warning', integration: 'bg-danger-bg text-danger', info: 'bg-info-bg text-info' } as const;
  const kindIcon = { action: 'flag', integration: 'plug', info: 'info' } as const;
  return (
    <Popover
      label={t('notifications')}
      trigger={({ open, toggle, id }) => (
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={id} aria-label={t('notificationsCount', { count: items.length })} className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line-soft bg-surface hover:border-ink">
          <Icon name="bell" size={18} />
          {items.length > 0 && <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-danger" aria-hidden="true" />}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="px-3 py-2 text-sm font-bold">{t('notifications')}</div>
          {items.length === 0 && <p className="px-3 pb-3 text-sm text-stone">{t('notificationsEmpty')}</p>}
          <ul className="flex flex-col gap-1">
            {items.map((n) => (
              <li key={n.id}>
                <Link href={n.href} onClick={close} className="flex gap-3 rounded-md p-3 hover:bg-canvas">
                  <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', kindTone[n.kind])}>
                    <Icon name={kindIcon[n.kind]} size={15} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[11px] font-bold uppercase tracking-[0.05em] text-stone">{t(`notificationKind.${n.kind}`)}</span>
                    <span className="block text-sm font-bold">{n.title}</span>
                    <span className="block text-xs text-stone">{relativeTime(n.at, locale)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Popover>
  );
}

/** "Viewing as": every persona in sample mode; with the API, only the roles the user actually holds. */
function RoleSelect({ className }: { className?: string }) {
  const t = useTranslations('shell');
  const ts = useTranslations('single');
  const app = useApp();
  const independent = app.org.model === 'independent';
  // Sample mode also offers the independent-business demo (one location, no network concepts).
  if (!app.live) {
    const value = app.sampleBusiness === 'independent' ? 'independent' : app.role;
    return (
      <label className={cx('flex h-11 items-center gap-1.5 rounded-full bg-canvas pl-3.5 pr-2 text-xs font-semibold text-stone', className)}>
        {t('viewingAs')}
        <select
          value={value}
          data-testid="persona-select"
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'independent') app.setSampleBusiness('independent');
            else {
              app.setSampleBusiness('network');
              app.setRole(v as ViewRole);
            }
          }}
          className="h-10 bg-transparent text-[13px] font-bold text-ink focus:outline-none"
        >
          <optgroup label={ts('personaNetwork')}>
            {(['hq', 'local', 'staff'] as const).map((r) => (
              <option key={r} value={r}>
                {t(`roles.${r}`)}
              </option>
            ))}
          </optgroup>
          <optgroup label={ts('personaIndependent')}>
            <option value="independent">{ts('personaOwner')}</option>
          </optgroup>
        </select>
      </label>
    );
  }
  if (app.roles.length <= 1)
    return (
      <span className={cx('flex h-11 items-center gap-1.5 rounded-full bg-canvas px-3.5 text-xs font-semibold text-stone', className)}>
        {t('signedInAs')}
        <strong className="text-[13px] text-ink">{independent ? ts(`roles.${app.role}`) : t(`roles.${app.role}`)}</strong>
      </span>
    );
  return (
    <label className={cx('flex h-11 items-center gap-1.5 rounded-full bg-canvas pl-3.5 pr-2 text-xs font-semibold text-stone', className)}>
      {t('viewingAs')}
      <select value={app.role} onChange={(e) => app.setRole(e.target.value as ViewRole)} className="h-10 bg-transparent text-[13px] font-bold text-ink focus:outline-none">
        {app.roles.map((r) => (
          <option key={r} value={r}>
            {independent ? ts(`roles.${r}`) : t(`roles.${r}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ProfileMenu() {
  const t = useTranslations('shell');
  const ts = useTranslations('single');
  const app = useApp();
  const router = useRouter();
  return (
    <Popover
      label={t('profile')}
      trigger={({ open, toggle, id }) => (
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={id} aria-label={t('profileOf', { name: app.session.user.name })} className="shrink-0 rounded-full">
          <Avatar name={app.session.user.name} size={44} pastel={INDUSTRY_UI[app.industry].pastel} />
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-1 p-1">
          <div className="flex items-center gap-3 p-2">
            <Avatar name={app.session.user.name} size={40} pastel={INDUSTRY_UI[app.industry].pastel} />
            <div className="min-w-0">
              <div className="truncate text-sm font-bold">{app.session.user.name}</div>
              <div className="truncate text-xs text-stone">{app.session.user.email}</div>
              <div className="mt-0.5 text-xs font-semibold">{app.org.model === 'independent' ? ts(`roles.${app.role}`) : t(`roles.${app.role}`)}</div>
            </div>
          </div>
          <RoleSelect className="md:hidden" />
          <LanguageSelect className="px-2 py-1" />
          <Link href="/settings" onClick={close} className="flex items-center gap-2 rounded-sm px-2 py-2 text-sm font-semibold hover:bg-canvas">
            <Icon name="settings" size={16} />
            {t('settings')}
          </Link>
          <button
            type="button"
            onClick={async () => {
              await (await getApi()).auth.signOut();
              router.push('/sign-in');
            }}
            className="flex items-center gap-2 rounded-sm px-2 py-2 text-left text-sm font-semibold hover:bg-canvas"
          >
            <Icon name="logout" size={16} />
            {t('signOut')}
          </button>
        </div>
      )}
    </Popover>
  );
}

export function TopBar({ onOpenNav }: { onOpenNav: () => void }) {
  const t = useTranslations('shell');
  const app = useApp();
  return (
    <header className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface px-3 py-2.5 md:flex-row md:flex-wrap md:items-center md:gap-2.5 md:px-3.5">
      <div className="flex items-center gap-2 md:hidden">
        <button type="button" onClick={onOpenNav} aria-label={t('openNav')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-canvas">
          <Icon name="menu" size={20} />
        </button>
        <LogoMark size={30} />
        <span className="min-w-0 flex-1" />
        <AiButton compact />
        <Notifications />
        <ProfileMenu />
      </div>
      <ScopePicker className="w-full md:w-auto" compact />
      <Search />
      <div className="hidden items-center gap-2 md:ml-auto md:flex">
        {app.apiMode !== 'live' && (
          <span title={app.apiMode === 'fallback' ? t('fallbackHint') : t('sampleHint')} className="hidden items-center gap-1.5 rounded-full bg-butter px-3 py-1.5 text-xs font-bold xl:inline-flex">
            <Icon name="info" size={13} />
            {app.apiMode === 'fallback' ? t('fallback') : t('sample')}
          </span>
        )}
        <RoleSelect />
        <AiButton />
        <Notifications />
        <ProfileMenu />
      </div>
    </header>
  );
}

function AiButton({ compact }: { compact?: boolean }) {
  const t = useTranslations('ai');
  const app = useApp();
  return (
    <button
      type="button"
      onClick={() => app.setAiOpen(!app.aiOpen)}
      aria-pressed={app.aiOpen}
      className={cx('flex h-11 shrink-0 items-center gap-2 rounded-full text-[13px] font-bold', compact ? 'w-11 justify-center min-[400px]:w-auto min-[400px]:px-4' : 'px-4', app.aiOpen ? 'bg-ink text-white' : 'bg-[#F1E7FB] text-[#4A2E8A]')}
    >
      <Icon name="sparkles" size={16} />
      <span className={compact ? 'sr-only min-[400px]:not-sr-only' : undefined}>{t('button')}</span>
    </button>
  );
}

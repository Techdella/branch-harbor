'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon, LogoMark, cx } from '@bh/ui';
import { INDUSTRY_UI, NAV_SHARED, NAV_TOP, OPS, type NavItem } from '@/lib/nav';
import { useApp } from './AppContext';

export function Sidebar({ collapsed, onNavigate, mobile }: { collapsed: boolean; onNavigate?: () => void; mobile?: boolean }) {
  const t = useTranslations();
  const app = useApp();
  const path = usePathname();
  const org = app.org;

  const opsItems: NavItem[] = OPS[app.industry].map((o) => ({ key: o.key, href: `/ops/${o.key}`, icon: o.icon, later: o.kind === 'later', perm: 'operations.read' }));
  // Sample-mode badges illustrate counts; live counts come from the overview's "Needs attention" and notifications.
  const badges: Record<string, number> = app.live ? {} : { approvals: 4, payments: 1, connections: app.industry === 'studios' ? 2 : 1, registrations: 4, cover: 1 };

  const label = (it: NavItem, section: 'top' | 'ops' | 'shared') => {
    if (section === 'ops') return t(`ops.${app.industry}.${it.key}.title`);
    if (it.key === 'customers') return t(`industries.${app.industry}.customers`);
    return t(`nav.${it.key}`);
  };

  const item = (it: NavItem, section: 'top' | 'ops' | 'shared') => {
    const active = path === it.href || path.startsWith(`${it.href}/`);
    const allowed = !it.perm || app.can(it.perm);
    const text = label(it, section);
    const badge = !it.later && allowed ? badges[it.key] : undefined;
    return (
      <li key={`${section}-${it.key}`}>
        <Link
          href={it.href}
          onClick={onNavigate}
          aria-current={active ? 'page' : undefined}
          title={collapsed ? text : undefined}
          className={cx(
            'flex h-10 items-center gap-2.5 rounded-full px-3 text-sm transition',
            active ? 'bg-lime font-bold text-ink' : 'font-medium text-graphite hover:bg-canvas',
            (it.later || !allowed) && !active && 'text-mute',
            collapsed && 'justify-center px-0',
          )}
        >
          <Icon name={allowed ? it.icon : 'lock'} size={17} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 truncate">{text}</span>
              {it.later && <span className="rounded-full bg-canvas px-2 py-0.5 text-[10px] font-bold text-stone">{t('common.later')}</span>}
              {!allowed && !it.later && <span className="sr-only">{t('nav.restricted')}</span>}
              {badge ? (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-ink px-1.5 text-[11px] font-bold text-white" aria-label={t('nav.badge', { count: badge })}>
                  {badge}
                </span>
              ) : null}
            </>
          )}
        </Link>
      </li>
    );
  };

  return (
    <nav aria-label={t('nav.label')} className={cx('flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto scrollbar-thin', mobile ? 'p-4' : 'px-3 py-4')}>
      <div className={cx('flex shrink-0 items-center gap-2.5 pb-3.5', collapsed ? 'justify-center' : 'px-1.5')}>
        <LogoMark size={34} />
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-[15px] font-extrabold tracking-tight">BranchHarbor</div>
            <div className="truncate text-xs text-stone">
              {org.brand} · {t(`industries.${app.industry}.name`)}
            </div>
          </div>
        )}
      </div>

      {!collapsed && app.industries.length > 1 && (
        <div role="group" aria-label={t('shell.industrySwitcher')} className="mb-3 grid shrink-0 gap-1 rounded-[18px] bg-canvas p-1" style={{ gridTemplateColumns: `repeat(${app.industries.length}, minmax(0, 1fr))` }}>
          {app.industries.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => app.setIndustry(k)}
              aria-pressed={app.industry === k}
              title={t(`industries.${k}.name`)}
              aria-label={t(`industries.${k}.name`)}
              className={cx('flex h-9 items-center justify-center rounded-sm text-ink transition', app.industry === k ? 'bg-surface shadow-card' : 'hover:bg-surface/60')}
            >
              <Icon name={INDUSTRY_UI[k].icon} size={17} />
            </button>
          ))}
        </div>
      )}

      <ul className="flex flex-col gap-0.5">{NAV_TOP.map((i) => item(i, 'top'))}</ul>
      {!collapsed && <div className="px-3 pb-1 pt-3 text-[11px] font-bold uppercase tracking-[0.06em] text-mute">{t(`industries.${app.industry}.name`)}</div>}
      {collapsed && <hr className="mx-3 my-2 border-line-soft" />}
      <ul className="flex flex-col gap-0.5">{opsItems.map((i) => item(i, 'ops'))}</ul>
      {!collapsed && <div className="px-3 pb-1 pt-3 text-[11px] font-bold uppercase tracking-[0.06em] text-mute">{t('nav.shared')}</div>}
      {collapsed && <hr className="mx-3 my-2 border-line-soft" />}
      <ul className="flex flex-col gap-0.5">{NAV_SHARED.map((i) => item(i, 'shared'))}</ul>

      <div className="mt-auto flex shrink-0 flex-col gap-1 pt-3">
        <Link href="/onboarding" onClick={onNavigate} title={collapsed ? t('nav.setup') : undefined} className={cx('flex h-10 items-center gap-2.5 rounded-full px-3 text-[13px] font-semibold text-stone hover:bg-canvas', collapsed && 'justify-center px-0')}>
          <Icon name="flag" size={16} />
          {!collapsed && t('nav.setup')}
        </Link>
        {!mobile && (
          <button type="button" onClick={app.toggleNav} aria-label={collapsed ? t('shell.expandNav') : t('shell.collapseNav')} className={cx('hidden h-10 items-center gap-2.5 rounded-full px-3 text-[13px] font-semibold text-stone hover:bg-canvas lg:flex', collapsed && 'justify-center px-0')}>
            <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
            {!collapsed && t('shell.collapseNav')}
          </button>
        )}
      </div>
    </nav>
  );
}

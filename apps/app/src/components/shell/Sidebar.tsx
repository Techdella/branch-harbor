'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon, LogoMark, cx } from '@bh/ui';
import type { WorkspaceKey } from '@bh/shared';
import { INDUSTRY_UI } from '@/lib/nav';
import { WORKSPACE_ICON, flatNav, settingsNav, workspaceNav, type NavLink } from '@/lib/access';
import { Popover } from '../ui/Popover';
import { useApp } from './AppContext';

/** Label for a nav link: industry screens use the industry's words. */
export function useNavLabel() {
  const t = useTranslations();
  const app = useApp();
  return (l: NavLink) => {
    if (l.screen) return t(`ops.${app.industry}.${l.screen}.title`);
    if (l.msg) return t(l.msg);
    if (l.key === 'customers') return t(`industries.${app.industry}.customers`);
    if (l.key === 'schedule') return t('access.nav.schedule');
    // Inside the Marketing workspace the campaigns screen is called what it is.
    if (l.key === 'marketing') return t('access.modules.marketing.campaigns.name');
    return t(`nav.${l.key}`);
  };
}

/** Business accounts under this login (one industry each). Hidden when there is only one. */
function AccountSwitcher({ collapsed, railHide }: { collapsed: boolean; railHide?: string }) {
  const t = useTranslations();
  const app = useApp();
  const head = (
    <span className="min-w-0 text-left">
      <span className="block truncate text-[15px] font-extrabold tracking-tight">{app.org.name || 'BranchHarbor'}</span>
      <span className="block truncate text-xs text-stone">{t(`industries.${app.industry}.name`)}</span>
    </span>
  );
  if (app.accounts.length <= 1 || collapsed) return collapsed ? null : <div className={cx('min-w-0', railHide)}>{head}</div>;
  return (
    <Popover
      label={t('access.account.switch')}
      align="left"
      className={cx('min-w-0 flex-1', railHide)}
      trigger={({ open, toggle, id }) => (
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={id} aria-label={t('access.account.switchFrom', { name: app.org.name })} data-testid="account-switcher" className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-1 hover:bg-canvas">
          {head}
          <Icon name="chevron-down" size={14} className="ml-auto shrink-0" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-[0.06em] text-mute">{t('access.account.title')}</div>
          <ul className="flex flex-col gap-0.5">
            {app.accounts.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => (close(), app.switchAccount(a.id))}
                  aria-current={a.id === app.org.id ? 'true' : undefined}
                  className={cx('flex w-full items-center gap-3 rounded-md p-2.5 text-left hover:bg-canvas', a.id === app.org.id && 'bg-canvas')}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px]" style={{ background: INDUSTRY_UI[a.industry].pastel }}>
                    <Icon name={INDUSTRY_UI[a.industry].icon} size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold">{a.name}</span>
                    <span className="block text-xs text-stone">{t(`industries.${a.industry}.name`)}</span>
                  </span>
                  {a.id === app.org.id && <Icon name="check" size={15} />}
                </button>
              </li>
            ))}
          </ul>
          <p className="border-t border-line-soft px-3 pt-2 text-[11px] text-stone">{t('access.account.note')}</p>
        </div>
      )}
    </Popover>
  );
}

/** Workspaces this person has (only those). Hidden when there is one, and for independent businesses. */
function WorkspaceSwitcher({ collapsed, railHide, onNavigate }: { collapsed: boolean; railHide?: string; onNavigate?: () => void }) {
  const t = useTranslations('access');
  const app = useApp();
  const current = app.workspace;
  if (app.workspaces.length <= 1 || !current) return null;
  return (
    <Popover
      label={t('switcher.label')}
      align="left"
      className={cx('mb-3 shrink-0', collapsed ? 'self-center' : undefined)}
      panelClassName="w-[min(320px,calc(100vw-24px))]"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={id}
          data-testid="workspace-switcher"
          aria-label={t('switcher.current', { workspace: t(`workspace.${current}.name`) })}
          className={cx('flex h-11 w-full items-center gap-2.5 rounded-full bg-canvas px-3 text-sm font-bold hover:bg-line-soft', collapsed && 'w-11 justify-center px-0')}
        >
          <Icon name={WORKSPACE_ICON[current]} size={17} className="shrink-0" />
          {!collapsed && (
            <span className={cx('contents', railHide)}>
              <span className="min-w-0 flex-1 truncate text-left">{t(`workspace.${current}.name`)}</span>
              <Icon name="chevron-down" size={14} className="shrink-0" />
            </span>
          )}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-[0.06em] text-mute">{t('switcher.label')}</div>
          <ul className="flex flex-col gap-0.5">
            {app.workspaces.map((w: WorkspaceKey) => (
              <li key={w}>
                <button
                  type="button"
                  data-testid={`workspace-${w}`}
                  onClick={() => (close(), onNavigate?.(), app.setWorkspace(w))}
                  aria-current={w === current ? 'true' : undefined}
                  className={cx('flex w-full items-start gap-3 rounded-md p-2.5 text-left hover:bg-canvas', w === current && 'bg-canvas')}
                >
                  <Icon name={WORKSPACE_ICON[w]} size={17} className="mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold">{t(`workspace.${w}.name`)}</span>
                    <span className="block text-xs text-stone">{t(`workspace.${w}.description`)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Popover>
  );
}

export function Sidebar({ collapsed, onNavigate, mobile }: { collapsed: boolean; onNavigate?: () => void; mobile?: boolean }) {
  const t = useTranslations();
  const app = useApp();
  const path = usePathname();
  const label = useNavLabel();
  // Desktop sidebar that isn't collapsed by the user: full width from lg, icon rail below (CSS only, so the
  // layout is right on first paint — no shift when JS measures the viewport).
  const auto = !mobile && !collapsed;
  const railHide = auto ? 'max-lg:hidden' : undefined;

  // Independent businesses keep one simple navigation (the owner sees everything for their business);
  // networks get the active workspace's navigation plus Settings.
  const independent = app.org.model === 'independent';
  const main = independent ? flatNav(app.capabilities, app.industry).filter((l) => l.key !== 'locations') : app.workspace ? workspaceNav(app.workspace, app.capabilities, app.industry) : [];
  const settings = independent ? [] : settingsNav(app.capabilities, app.industry);
  const homeLabel = !independent && app.workspace && app.workspaces.length > 1 ? t('access.home.navLabel', { workspace: t(`access.workspace.${app.workspace}.name`) }) : t('nav.overview');

  // Only the longest matching link is active (/marketing/inbox highlights Inbox, not Campaigns at /marketing).
  const activeHref = ['/overview', ...main.map((l) => l.href), ...settings.map((l) => l.href)]
    .filter((h) => path === h || path.startsWith(`${h}/`))
    .sort((a, b) => b.length - a.length)[0];
  const item = (l: { key: string; href: string; icon: NavLink['icon'] }, text: string) => {
    const active = l.href === activeHref;
    return (
      <li key={l.href}>
        <Link
          href={l.href}
          onClick={onNavigate}
          aria-current={active ? 'page' : undefined}
          title={collapsed || auto ? text : undefined}
          className={cx(
            'flex h-10 items-center gap-2.5 rounded-full px-3 text-sm transition',
            active ? 'bg-lime font-bold text-ink' : 'font-medium text-graphite hover:bg-canvas',
            collapsed && 'justify-center px-0',
            auto && 'max-lg:justify-center max-lg:px-0',
          )}
        >
          <Icon name={l.icon} size={17} className="shrink-0" />
          {!collapsed && <span className={cx('min-w-0 flex-1 truncate', railHide)}>{text}</span>}
        </Link>
      </li>
    );
  };

  return (
    <nav aria-label={t('nav.label')} className={cx('flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain scrollbar-thin', mobile ? 'p-4' : 'px-3 py-4')}>
      <div className={cx('flex shrink-0 items-center gap-2.5 pb-3.5', collapsed ? 'justify-center' : 'px-1.5', auto && 'max-lg:justify-center max-lg:px-0')}>
        <LogoMark size={34} />
        <AccountSwitcher collapsed={collapsed} railHide={railHide} />
      </div>

      {!independent && <WorkspaceSwitcher collapsed={collapsed} railHide={railHide} onNavigate={onNavigate} />}

      <ul className="flex flex-col gap-0.5">
        {item({ key: 'overview', href: '/overview', icon: 'grid' }, homeLabel)}
        {main.map((l) => item(l, label(l)))}
      </ul>
      {settings.length > 0 && (
        <>
          {!collapsed && <div className={cx('px-3 pb-1 pt-3 text-[11px] font-bold uppercase tracking-[0.06em] text-mute', railHide)}>{t('access.nav.settings')}</div>}
          {(collapsed || auto) && <hr className={cx('mx-3 my-2 border-line-soft', auto && 'lg:hidden')} />}
          <ul className="flex flex-col gap-0.5">{settings.map((l) => item(l, label(l)))}</ul>
        </>
      )}

      <div className="mt-auto flex shrink-0 flex-col gap-1 pt-3">
        {app.can('org.manage') && (
          <Link href="/onboarding" onClick={onNavigate} title={collapsed || auto ? t('nav.setup') : undefined} className={cx('flex h-10 items-center gap-2.5 rounded-full px-3 text-[13px] font-semibold text-stone hover:bg-canvas', collapsed && 'justify-center px-0', auto && 'max-lg:justify-center max-lg:px-0')}>
            <Icon name="flag" size={16} className="shrink-0" />
            {!collapsed && <span className={railHide}>{t('nav.setup')}</span>}
          </Link>
        )}
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

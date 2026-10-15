'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { IconName } from '@bh/icons';
import type { Permission } from '@bh/shared';
import { Icon, cx } from '@bh/ui';
import { useMkt } from './data';

/**
 * Marketing workspace sections (module keys mirror the workspace model: marketing.website_builder,
 * marketing.email, marketing.automations, marketing.forms, marketing.brand_assets).
 */
export const MARKETING_SECTIONS: Array<{ key: string; module: string; href: string; icon: IconName; perm: Permission }> = [
  { key: 'overview', module: 'marketing', href: '/marketing', icon: 'megaphone', perm: 'marketing.draft' },
  { key: 'websites', module: 'marketing.website_builder', href: '/marketing/websites', icon: 'globe', perm: 'website.edit' },
  { key: 'email', module: 'marketing.email', href: '/marketing/email', icon: 'mail', perm: 'email.draft' },
  { key: 'automations', module: 'marketing.automations', href: '/marketing/automations', icon: 'workflow', perm: 'automations.manage' },
  { key: 'forms', module: 'marketing.forms', href: '/marketing/forms', icon: 'file', perm: 'forms.manage' },
  { key: 'assets', module: 'marketing.brand_assets', href: '/marketing/assets', icon: 'image', perm: 'assets.manage' },
];

export function MarketingNav() {
  const t = useTranslations('mkt.nav');
  const path = usePathname();
  const { can } = useMkt();
  const active = (href: string) => (href === '/marketing' ? path === href : path.startsWith(href));
  return (
    <nav aria-label={t('label')} className="mb-3 overflow-x-auto">
      <ul className="flex min-w-max gap-1 rounded-full bg-surface p-1" role="list">
        {MARKETING_SECTIONS.filter((s) => can(s.perm) || s.key === 'overview').map((s) => (
          <li key={s.key}>
            <Link href={s.href} aria-current={active(s.href) ? 'page' : undefined} className={cx('flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-bold', active(s.href) ? 'bg-ink text-white' : 'text-graphite hover:bg-canvas')}>
              <Icon name={s.icon} size={16} />{t(s.key)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

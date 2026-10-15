'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { useApp } from '../shell/AppContext';

/**
 * A page outside the person's access. It never loads the page's data (the API would refuse it too) and offers the
 * way home. Shown for direct links and old bookmarks; navigation never links here.
 */
export function NotAvailable() {
  const t = useTranslations('access.notAvailable');
  const app = useApp();
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl bg-surface px-6 py-14 text-center" data-testid="not-available">
      <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-canvas">
        <Icon name="info" size={24} />
      </span>
      <h1 className="text-h3 font-bold">{t('title')}</h1>
      <p className="max-w-md text-sm text-stone">{t('body', { business: app.org.name })}</p>
      <Link href="/overview" className="inline-flex h-11 items-center rounded-full bg-ink px-5 text-sm font-bold text-white">
        {t('home')}
      </Link>
    </div>
  );
}

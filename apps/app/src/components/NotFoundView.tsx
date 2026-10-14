'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LogoMark } from '@bh/ui';

export function NotFoundView() {
  const t = useTranslations('states');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <LogoMark size={44} />
      <h1 className="text-h2 font-bold">{t('notFoundTitle')}</h1>
      <p className="max-w-md text-sm text-stone">{t('notFoundBody')}</p>
      <Link href="/overview" className="inline-flex h-11 items-center rounded-full bg-ink px-5 text-sm font-bold text-white">
        {t('backToOverview')}
      </Link>
    </main>
  );
}

'use client';

import { useId, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from '@bh/shared';
import { Icon, cx } from '@/components/ui';
import { usePathname, useRouter } from '@/i18n/navigation';

export function LanguageSwitcher({ dark = false, className }: { dark?: boolean; className?: string }) {
  const t = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const id = useId();

  return (
    <div className={cx('flex min-w-0 flex-wrap items-center gap-2', className)}>
      <label htmlFor={id} className={cx('flex items-center gap-1.5 text-[13px] font-bold', dark ? 'text-[#B9B9B3]' : 'text-stone')}>
        <Icon name="globe" size={15} />
        {t('language')}
      </label>
      <select
        id={id}
        value={locale}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as Locale;
          startTransition(() => {
            // pathname is the current path without its locale prefix.
            router.replace(pathname, { locale: next });
          });
        }}
        className={cx(
          'h-10 min-w-0 max-w-full rounded-full border px-3 text-[13px] font-bold',
          dark ? 'border-[#3a3a3a] bg-ink-2 text-white' : 'border-line bg-surface text-ink',
        )}
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </div>
  );
}

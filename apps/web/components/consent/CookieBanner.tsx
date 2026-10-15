'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, cx } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { OPTIONAL_CATEGORIES, useConsent, type ConsentChoices } from './ConsentProvider';

const btn = 'inline-flex min-h-11 items-center justify-center rounded-full px-5 text-sm font-bold transition';
// "Accept all" and "Essential only" share one style so neither choice is nudged.
const primary = cx(btn, 'bg-ink text-white hover:bg-ink-2');
const secondary = cx(btn, 'border-[1.5px] border-ink bg-surface text-ink hover:bg-canvas-raised');

/** First-visit banner plus the preferences dialog (also opened from the footer). No lime: it must not compete with the page's signal. */
export function CookieBanner() {
  const t = useTranslations('consent');
  const { ready, record, acceptAll, essentialOnly, settingsOpen, openSettings } = useConsent();
  const titleId = useId();

  return (
    <>
      {ready && !record && !settingsOpen && (
        <section
          aria-labelledby={titleId}
          className="fixed inset-x-2 bottom-safe z-40 mx-auto max-h-[calc(100dvh-24px)] max-w-[760px] overflow-y-auto rounded-[24px] bg-surface p-5 shadow-pop sm:inset-x-4 sm:bottom-4 sm:p-6"
        >
          <h2 id={titleId} className="flex items-center gap-2 text-base font-extrabold">
            <Icon name="shield" size={18} />
            {t('title')}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-graphite">
            {t('body')}{' '}
            <Link href="/privacy" className="font-bold underline underline-offset-2">
              {t('privacy')}
            </Link>
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            <button type="button" onClick={openSettings} className={cx(secondary, 'sm:me-auto')}>
              {t('customize')}
            </button>
            <button type="button" onClick={essentialOnly} className={primary}>
              {t('essentialOnly')}
            </button>
            <button type="button" onClick={acceptAll} className={primary}>
              {t('acceptAll')}
            </button>
          </div>
        </section>
      )}
      <ConsentDialog />
    </>
  );
}

function ConsentDialog() {
  const t = useTranslations('consent');
  const tc = useTranslations('common');
  const { record, settingsOpen, closeSettings, save, acceptAll } = useConsent();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [choices, setChoices] = useState<ConsentChoices>({ analytics: false, marketing: false });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (settingsOpen && !d.open) {
      setChoices({ analytics: record?.analytics ?? false, marketing: record?.marketing ?? false });
      d.showModal();
    } else if (!settingsOpen && d.open) d.close();
  }, [settingsOpen, record]);

  const row = (key: 'essential' | (typeof OPTIONAL_CATEGORIES)[number]) => {
    const essential = key === 'essential';
    const on = essential || choices[key as keyof ConsentChoices];
    const id = `${titleId}-${key}`;
    return (
      <li key={key} className="flex items-start gap-4 rounded-[18px] bg-canvas-raised p-4">
        <div className="flex-1">
          <label htmlFor={id} className="text-sm font-extrabold">
            {t(`categories.${key}.name`)}
          </label>
          <p id={`${id}-desc`} className="mt-1 text-[13px] leading-relaxed text-stone">
            {t(`categories.${key}.desc`)}
          </p>
        </div>
        {essential ? (
          <span className="shrink-0 rounded-full bg-surface px-3 py-1 text-xs font-bold">{t('alwaysOn')}</span>
        ) : (
          <button
            id={id}
            type="button"
            role="switch"
            aria-checked={on}
            aria-describedby={`${id}-desc`}
            onClick={() => setChoices((c) => ({ ...c, [key]: !c[key as keyof ConsentChoices] }))}
            className={cx('relative h-7 w-12 shrink-0 rounded-full transition', on ? 'bg-ink' : 'bg-line')}
          >
            <span className={cx('absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-[inset-inline-start]', on ? 'start-6' : 'start-1')} />
          </button>
        )}
      </li>
    );
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={closeSettings}
      onCancel={closeSettings}
      className="m-auto w-[min(560px,calc(100vw-24px))] rounded-[28px] bg-surface p-0 text-ink shadow-pop backdrop:bg-ink/40"
    >
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-xl font-extrabold tracking-[-0.02em]">
            {t('dialogTitle')}
          </h2>
          <button type="button" onClick={closeSettings} aria-label={tc('close')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-canvas">
            <Icon name="x" size={18} />
          </button>
        </div>
        <p className="text-sm leading-relaxed text-graphite">{t('dialogBody')}</p>
        <ul className="flex flex-col gap-2">{(['essential', ...OPTIONAL_CATEGORIES] as const).map(row)}</ul>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={() => save(choices)} className={secondary}>
            {t('save')}
          </button>
          <button type="button" onClick={acceptAll} className={primary}>
            {t('acceptAll')}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Footer link that reopens the preferences dialog. */
export function CookieSettingsButton({ className }: { className?: string }) {
  const t = useTranslations('consent');
  const { openSettings } = useConsent();
  return (
    <button type="button" onClick={openSettings} className={className}>
      {t('settings')}
    </button>
  );
}

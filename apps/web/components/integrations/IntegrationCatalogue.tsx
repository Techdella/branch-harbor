'use client';

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, cx } from '@/components/ui';
import { CATEGORY_PASTEL, INTEGRATIONS, INTEGRATION_CATEGORIES, INTEGRATION_STATUSES, type Integration, type IntegrationCategory, type IntegrationStatus } from '@/content/integrations';
import { StatusPill } from '@/components/site/Blocks';
import { SideDrawer } from '@/components/site/SideDrawer';

export function IntegrationCatalogue() {
  const t = useTranslations('integrations');
  const tc = useTranslations('common');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<IntegrationCategory | 'all'>('all');
  const [status, setStatus] = useState<IntegrationStatus | 'all'>('all');
  const [open, setOpen] = useState<Integration | null>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  const searchId = useId();
  const catId = useId();

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return INTEGRATIONS.filter(
      (i) =>
        (cat === 'all' || i.category === cat) &&
        (status === 'all' || i.status === status) &&
        (!needle || `${i.name} ${t(`categories.${i.category}`)} ${t(`items.${i.id}.desc`)}`.toLowerCase().includes(needle)),
    );
  }, [q, cat, status, t]);

  const close = useCallback(() => {
    setOpen(null);
    requestAnimationFrame(() => lastTrigger.current?.focus());
  }, []);

  const clear = () => {
    setQ('');
    setCat('all');
    setStatus('all');
  };

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={searchId} className="text-[13px] font-bold">
              {t('searchLabel')}
            </label>
            <div className="relative">
              <Icon name="search" size={18} className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-stone" />
              <input
                id={searchId}
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('searchPlaceholder')}
                className="h-12 w-full rounded-full border border-line bg-surface ps-11 pe-4 text-[15px] font-medium focus:border-ink"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={catId} className="text-[13px] font-bold">
              {t('categoryLabel')}
            </label>
            <select id={catId} value={cat} onChange={(e) => setCat(e.target.value as IntegrationCategory | 'all')} className="h-12 rounded-full border border-line bg-surface px-4 text-[15px] font-medium">
              <option value="all">{t('all')}</option>
              {INTEGRATION_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`categories.${c}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset>
          <legend className="mb-2 text-[13px] font-bold">{t('statusLabel')}</legend>
          <div className="flex flex-wrap gap-2">
            {(['all', ...INTEGRATION_STATUSES] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={status === s}
                onClick={() => setStatus(s)}
                className={cx('h-10 rounded-full border-[1.5px] px-4 text-[13px] font-bold transition', status === s ? 'border-ink bg-ink text-white' : 'border-line-soft bg-surface hover:border-ink')}
              >
                {s === 'all' ? t('all') : tc(`status.${s}`)}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <p role="status" className="text-sm font-bold text-stone">
          {t('results', { count: list.length })}
        </p>
        {(q || cat !== 'all' || status !== 'all') && (
          <button type="button" onClick={clear} className="text-sm font-bold underline underline-offset-4">
            {t('clear')}
          </button>
        )}
      </div>

      {list.length === 0 ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-[24px] border border-dashed border-line px-6 py-14 text-center">
          <Icon name="search" size={28} />
          <p className="font-bold">{t('empty')}</p>
          <button type="button" onClick={clear} className="h-11 rounded-full bg-ink px-5 text-sm font-bold text-white">
            {t('clear')}
          </button>
        </div>
      ) : (
        <ul className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={(e) => {
                  lastTrigger.current = e.currentTarget;
                  setOpen(i);
                }}
                aria-label={t('inspect', { name: i.name })}
                className="flex h-full w-full flex-col gap-3 rounded-[22px] border border-line-soft bg-surface p-4 text-start transition hover:border-ink"
              >
                <span className="flex w-full items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] text-sm font-extrabold" style={{ background: CATEGORY_PASTEL[i.category] }} aria-hidden="true">
                    {i.mono}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15px] font-bold">{i.name}</span>
                    <span className="text-xs text-stone">{t(`categories.${i.category}`)}</span>
                  </span>
                </span>
                <span className="line-clamp-2 text-[13px] leading-snug text-graphite">{t(`items.${i.id}.desc`)}</span>
                <span className="mt-auto flex w-full items-center justify-between gap-2">
                  <StatusPill status={i.status} label={tc(`status.${i.status}`)} />
                  <Icon name="arrow-up-right" size={16} className="rtl:-scale-x-100" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <SideDrawer open={!!open} onClose={close} title={open?.name ?? ''} kicker={open ? t(`categories.${open.category}`) : undefined} closeLabel={t('close')}>
        {open && (
          <div className="flex flex-col gap-5">
            <StatusPill status={open.status} label={tc(`status.${open.status}`)} className="w-fit" />
            <p className="text-[15px] leading-relaxed">{t(`items.${open.id}.desc`)}</p>
            <dl className="flex flex-col gap-4">
              <div className="rounded-[16px] bg-canvas p-4">
                <dt className="text-xs font-extrabold tracking-[0.06em] text-stone uppercase">{t('direction')}</dt>
                <dd className="mt-1 text-sm font-bold">{t(`directions.${open.direction}`)}</dd>
              </div>
              <div className="rounded-[16px] bg-canvas p-4">
                <dt className="text-xs font-extrabold tracking-[0.06em] text-stone uppercase">{t('sourceOfTruth')}</dt>
                <dd className="mt-1 text-sm">{t(`items.${open.id}.truth`)}</dd>
              </div>
              <div className="rounded-[16px] bg-canvas p-4">
                <dt className="text-xs font-extrabold tracking-[0.06em] text-stone uppercase">{t('limits')}</dt>
                <dd className="mt-1 text-sm">{t(`items.${open.id}.limit`)}</dd>
              </div>
            </dl>
            <p className="text-xs leading-relaxed text-stone">{t(`statusHelp.${open.status}`)}</p>
          </div>
        )}
      </SideDrawer>
    </>
  );
}

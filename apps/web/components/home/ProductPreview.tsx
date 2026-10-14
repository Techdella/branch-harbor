'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import { Icon, cx } from '@/components/ui';
import { PREVIEW_LOCATIONS, type PreviewLocation } from '@/content/industries';
import { IMG } from '@/content/images';
import { SampleBadge } from '@/components/site/Blocks';

/** Headquarters overview with a selected-location drawer. Clearly labelled sample data. */
export function ProductPreview() {
  const t = useTranslations('home.preview');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [selected, setSelected] = useState<string | null>(PREVIEW_LOCATIONS[0]!.id);
  const loc = PREVIEW_LOCATIONS.find((l) => l.id === selected) ?? null;
  const region = (code: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  const num = (n: number) => new Intl.NumberFormat(locale).format(n);
  const pct = (n: number) => new Intl.NumberFormat(locale, { style: 'percent' }).format(n / 100);

  const syncText = (l: PreviewLocation) =>
    l.sync.state === 'connected' ? t('connected', { minutes: l.sync.minutes }) : l.sync.state === 'degraded' ? t('degraded', { hours: l.sync.hours }) : t('bookingNotConnected');
  const ok = (l: PreviewLocation) => l.sync.state === 'connected';

  return (
    <section aria-labelledby="preview-title" className="grid gap-3 lg:grid-cols-3">
      <h2 id="preview-title" className="sr-only">
        {t('heading')}
      </h2>
      <figure className="relative min-h-[320px] overflow-hidden rounded-[28px] bg-lilac md:min-h-[460px] md:rounded-2xl">
        <Image src={IMG.yogaStudio} alt={t('imageAlt')} fill sizes="(min-width: 1024px) 33vw, 100vw" className="object-cover" priority />
        <figcaption className="absolute inset-x-3.5 bottom-3.5 flex items-center justify-between gap-2 rounded-[18px] bg-white/90 px-4 py-3 backdrop-blur">
          <span>
            <span className="block text-[15px] font-bold">{t('imageCaption')}</span>
            <span className="block text-xs text-graphite">{t('imageSub')}</span>
          </span>
          <SampleBadge>{tc('sampleData')}</SampleBadge>
        </figcaption>
      </figure>

      <div className="min-w-0 rounded-[28px] bg-sage p-2.5 sm:p-4 md:rounded-2xl lg:col-span-2">
        <div className="flex h-full flex-col overflow-hidden rounded-[20px] bg-surface">
          <div className="flex flex-wrap items-center gap-2.5 border-b border-line-soft px-4 py-3.5 sm:px-5">
            <Icon name="grid" size={18} />
            <span className="text-[15px] font-bold">{t('overview')}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-stone">
              <Icon name="layers" size={13} />
              {t('scope', { count: PREVIEW_LOCATIONS.length })}
            </span>
            <SampleBadge className="ms-auto">{tc('sampleData')}</SampleBadge>
          </div>
          <div className="grid flex-1 grid-cols-1 md:grid-cols-2">
            <div className="min-w-0 p-2.5">
              <p className="sr-only">{t('selectHint')}</p>
              <ul aria-label={t('locations')} className="flex flex-col gap-0.5">
                {PREVIEW_LOCATIONS.map((l) => {
                  const on = l.id === selected;
                  return (
                    <li key={l.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => setSelected(on ? null : l.id)}
                        className={cx('flex w-full items-center gap-2.5 rounded-[14px] px-3 py-2.5 text-start transition', on ? 'bg-canvas' : 'hover:bg-canvas-raised')}
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]" style={{ background: l.pastel }}>
                          <Icon name="pin" size={15} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px] font-bold">{l.name}</span>
                          <span className={cx('flex items-center gap-1 text-[11px] font-medium', ok(l) ? 'text-stone' : 'text-warning')}>
                            <Icon name={ok(l) ? 'check-circle' : 'alert'} size={11} stroke={2.2} />
                            <span className="truncate">{syncText(l)}</span>
                          </span>
                        </span>
                        <span className="tabular text-sm font-bold" aria-label={`${t('enquiries')}: ${l.enquiries}`}>
                          {num(l.enquiries)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div aria-live="polite" className="border-t border-line-soft bg-[#FAFAF7] md:border-t-0 md:border-s">
              {loc ? (
                <div role="region" aria-label={t('drawerLabel')} className="flex flex-col gap-2.5 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs text-stone">{region(loc.country)}</div>
                      <div className="text-[17px] font-extrabold tracking-[-0.01em]">{loc.name}</div>
                    </div>
                    <button type="button" onClick={() => setSelected(null)} aria-label={t('closeDrawer')} className="rounded-full p-1.5 hover:bg-canvas">
                      <Icon name="x" size={16} />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-[16px] bg-lime-soft p-3">
                      <div className="flex items-center gap-1 text-[11px] font-semibold">
                        <Icon name="mail" size={12} />
                        {t('enquiries')}
                      </div>
                      <div className="tabular text-[28px] font-extrabold">{num(loc.enquiries)}</div>
                    </div>
                    <div className="rounded-[16px] bg-lilac p-3">
                      <div className="flex items-center gap-1 text-[11px] font-semibold">
                        <Icon name="calendar" size={12} />
                        {t('classesToday')}
                      </div>
                      <div className="tabular text-[28px] font-extrabold">{num(loc.classesToday)}</div>
                    </div>
                  </div>
                  <div className="rounded-[16px] border border-line-soft bg-surface p-3">
                    <div className="text-[11px] font-semibold text-stone">{t('occupancy')}</div>
                    <div className="tabular text-[22px] font-extrabold">
                      {typeof loc.occupancy === 'number' ? (
                        pct(loc.occupancy)
                      ) : (
                        <span className="text-base text-mute">{loc.occupancy === null ? t('unavailable') : t('notConnected')}</span>
                      )}
                    </div>
                  </div>
                  <div className={cx('flex items-center gap-1.5 text-xs font-semibold', ok(loc) ? 'text-success' : 'text-warning')}>
                    <Icon name={ok(loc) ? 'check-circle' : 'alert'} size={13} stroke={2.2} />
                    {syncText(loc)}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-stone">
                    <Icon name="clock" size={13} />
                    {t('localTime', { tz: loc.timeZone })}
                  </div>
                  <p className="text-[11px] leading-normal text-stone">{t('sourceNote')}</p>
                </div>
              ) : (
                <p className="p-6 text-sm text-stone">{t('selectHint')}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

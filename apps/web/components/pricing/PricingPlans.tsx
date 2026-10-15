'use client';

import { useId, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { IconName } from '@bh/icons';
import { Icon, cx } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { PLAN_KEYS, countryName, currencyName, formatPrice, perLocationPrice, type PlanKey, type PriceCurrency } from '@/content/pricing';
import { signUpUrl } from '@/lib/links';

const STYLE: Record<PlanKey, { icon: IconName; card: string; iconBg: string; tag: string; line: string; btn: string }> = {
  solo: { icon: 'store', card: 'bg-butter text-ink', iconBg: 'bg-surface', tag: 'bg-surface', line: 'border-black/10', btn: 'bg-ink text-white hover:bg-ink-2' },
  connector: { icon: 'wordpress', card: 'bg-surface text-ink border border-line-soft', iconBg: 'bg-butter', tag: 'bg-canvas', line: 'border-line-soft', btn: 'border-[1.5px] border-ink bg-surface text-ink hover:bg-canvas-raised' },
  hosted: { icon: 'globe', card: 'bg-ink text-white', iconBg: 'bg-lime text-ink', tag: 'bg-lime text-ink', line: 'border-ink-2', btn: 'bg-lime text-ink hover:brightness-95' },
  network: { icon: 'building', card: 'bg-lilac text-ink', iconBg: 'bg-surface', tag: 'bg-surface', line: 'border-black/10', btn: 'bg-ink text-white hover:bg-ink-2' },
};

/**
 * Plans in the visitor's local currency. The currency is chosen on the server from the visitor's location
 * (lib/geo.ts) — there is no currency picker: checkout charges the billing country's currency (docs/PRICING.md).
 */
export function PricingPlans({ currency, country }: { currency: PriceCurrency; country: string | null }) {
  const t = useTranslations('pricing');
  const locale = useLocale();
  const [annual, setAnnual] = useState(false);
  const [count, setCount] = useState(3);
  const countId = useId();

  const fmt = (n: number) => formatPrice(n, currency, locale);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-[24px] bg-canvas p-4 md:flex-row md:flex-wrap md:items-end md:justify-between md:p-5">
        <p className="flex max-w-xl items-start gap-2.5 self-center text-sm leading-relaxed text-graphite" data-testid="geo-note" data-currency={currency} data-country={country ?? ''}>
          <Icon name="globe" size={18} className="mt-0.5 shrink-0" />
          <span>
            {country
              ? t('geoNote', { currency: currencyName(currency, locale), country: countryName(country, locale) })
              : t('geoNoteUnknown', { currency: currencyName(currency, locale) })}
          </span>
        </p>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-[13px] font-bold">{t('billingLabel')}</legend>
          <div className="inline-flex flex-wrap gap-1 rounded-full bg-surface p-1">
            {[false, true].map((a) => (
              <label key={String(a)} className={cx('inline-flex h-9 cursor-pointer items-center rounded-full px-4 text-[13px] font-bold transition has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-focus', annual === a ? 'bg-ink text-white' : 'text-graphite')}>
                <input type="radio" name="billing" className="sr-only" checked={annual === a} onChange={() => setAnnual(a)} />
                {a ? t('annual') : t('monthly')}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={countId} className="text-[13px] font-bold">
            {t('locationsLabel')}
          </label>
          <div className="inline-flex items-center gap-1 rounded-full bg-surface p-1">
            <button type="button" onClick={() => setCount((c) => Math.max(1, c - 1))} aria-label={t('decrease')} className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-canvas">
              <Icon name="minus" size={16} />
            </button>
            <input
              id={countId}
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={count}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setCount(Number.isFinite(n) ? Math.min(500, Math.max(1, n)) : 1);
              }}
              className="tabular h-9 w-16 rounded-full bg-canvas text-center text-sm font-bold"
            />
            <button type="button" onClick={() => setCount((c) => Math.min(500, c + 1))} aria-label={t('increase')} className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-canvas">
              <Icon name="plus" size={16} />
            </button>
          </div>
        </div>
      </div>

      <ul className="grid gap-[var(--edge)] md:grid-cols-2 xl:grid-cols-4">
        {PLAN_KEYS.map((k) => {
          const s = STYLE[k];
          const price = perLocationPrice(currency, k, annual);
          const features = t.raw(`plans.${k}.features`) as string[];
          return (
            <li key={k} className={cx('flex flex-col gap-5 rounded-[28px] p-6 md:p-8', s.card)}>
              <div className="flex items-center justify-between gap-2">
                <span className={cx('flex h-11 w-11 items-center justify-center rounded-[14px]', s.iconBg)}>
                  <Icon name={s.icon} size={22} />
                </span>
                <span className={cx('rounded-full px-3 py-1 text-xs font-bold', s.tag)}>{t(`plans.${k}.tag`)}</span>
              </div>
              <div>
                <h3 className="text-2xl font-extrabold tracking-[-0.02em]">{t(`plans.${k}.name`)}</h3>
                <p className={cx('text-sm', k === 'hosted' ? 'text-[#C9C9C3]' : 'text-stone')}>{t(`plans.${k}.for`)}</p>
              </div>
              <div aria-live="polite">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className={cx('tabular leading-none font-extrabold tracking-[-0.04em]', priceSize(fmt(price)))}>{fmt(price)}</span>
                  <span className={cx('text-sm font-semibold', k === 'hosted' ? 'text-[#C9C9C3]' : 'text-stone')}>{k === 'solo' ? t('perMonthOneLocation') : t('perLocation')}</span>
                </p>
                <p className={cx('tabular mt-2 text-xs font-semibold', k === 'hosted' ? 'text-[#C9C9C3]' : 'text-stone')}>
                  {k === 'solo' ? t(annual ? 'soloAnnual' : 'soloTotal') : t(annual ? 'totalAnnual' : 'total', { amount: fmt(price * count), count })}
                </p>
              </div>
              <ul className={cx('flex flex-col gap-2.5 border-t pt-5', s.line)}>
                {features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm">
                    <Icon name="check" size={16} stroke={2.4} className="mt-0.5 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              {k !== 'network' ? (
                // Self-service sign-up for every industry; Network starts with a quote.
                <a href={signUpUrl({ plan: k, model: k === 'solo' ? 'independent' : 'network' })} className={cx('mt-auto inline-flex h-12 items-center justify-center rounded-full text-sm font-bold transition', s.btn)}>
                  {t(`plans.${k}.cta`)}
                </a>
              ) : (
                <Link href={`/demo?plan=${k}`} className={cx('mt-auto inline-flex h-12 items-center justify-center rounded-full text-sm font-bold transition', s.btn)}>
                  {t(`plans.${k}.cta`)}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Long amounts (₦41,500, IDR 579,000) step down so they never overflow a narrow card. */
function priceSize(formatted: string): string {
  const n = formatted.replace(/[⁦-⁩\s]/g, '').length;
  return n <= 6 ? 'text-[44px]' : n <= 8 ? 'text-[38px]' : n <= 10 ? 'text-[32px]' : 'text-[28px]';
}

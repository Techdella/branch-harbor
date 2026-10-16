'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { TRIAL_DAYS, isPriceListKey, type PriceListKey, type PricedCurrency } from '@bh/shared';
import { formatPrice, listPrice } from '@/content/pricing';

/**
 * "Try it for 14 days for {local price}" on the static home page: a small client island that reads the visitor's
 * display price list from the cached `/api/geo-price` route handler, so the page itself stays static. Until the answer
 * arrives (or if it fails) the line keeps its height and shows nothing, so the hero never jumps.
 */
export function TrialLine() {
  const t = useTranslations('pricing');
  const locale = useLocale();
  const [geo, setGeo] = useState<{ priceList: PriceListKey; currency: PricedCurrency } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/geo-price')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { priceList?: string; currency?: PricedCurrency } | null) => {
        if (alive && d?.priceList && isPriceListKey(d.priceList) && d.currency) setGeo({ priceList: d.priceList, currency: d.currency });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return (
    <p className="min-h-6 text-base font-bold" data-testid="home-trial-line" data-currency={geo?.currency} aria-live="polite">
      {geo ? t('trialLine', { days: TRIAL_DAYS, price: formatPrice(listPrice(geo.priceList, 'trial'), geo.currency, locale) }) : ' '}
    </p>
  );
}

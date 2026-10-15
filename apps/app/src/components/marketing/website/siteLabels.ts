'use client';

import { useTranslations } from 'next-intl';
import type { SiteContext, SiteLabels } from '@bh/ui/site';
import type { BuilderData } from '../data';

/** Built-in renderer strings for the builder preview (the public sites use their own catalogue). */
export function useSiteLabels(): SiteLabels {
  const t = useTranslations('mkt.site');
  return {
    hours: t('hours'), contact: t('contact'), closed: t('closed'), directions: t('directions'), call: t('call'), email: t('email'), map: t('map'),
    livePreview: t('livePreview'), order: t('order'), viewAll: t('viewAll'), formUnavailable: t('formUnavailable'), highlighted: t('highlighted'),
    empty: { class_schedule: t('livePreview'), programmes: t('livePreview'), services: t('livePreview'), product_grid: t('livePreview'), menu: t('livePreview'), listings: t('livePreview'), rooms: t('livePreview') },
  };
}

export function previewContext(b: Pick<BuilderData, 'brandName' | 'location'>, locale: string): SiteContext {
  const l = b.location;
  if (!l) return { brandName: b.brandName, locale, location: null };
  const weekly = Array.isArray((l.hours as { weekly?: unknown } | null)?.weekly) ? ((l.hours as { weekly: Array<{ day: number; opens: string; closes: string }> }).weekly) : null;
  const summary = typeof (l.hours as { summary?: unknown } | null)?.summary === 'string' ? ((l.hours as { summary: string }).summary) : null;
  return {
    brandName: b.brandName, locale,
    location: {
      name: l.name, addressLines: [l.address.line1, l.address.line2, [l.address.postalCode, l.address.city].filter(Boolean).join(' ')].filter((x): x is string => !!x && !!x.trim()),
      phone: l.phone, email: l.email, geo: l.geo, hours: { summary, weekly }, directionsUrl: '#',
    },
  };
}

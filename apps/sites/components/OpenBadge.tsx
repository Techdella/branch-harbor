import { getTranslations, getLocale } from 'next-intl/server';
import { clock } from '@/lib/format';
import type { LocationSummary } from '@/lib/types';

/** Open-now status in the location's own timezone. Text + dot, never colour alone. */
export async function OpenBadge({ loc }: { loc: Pick<LocationSummary, 'status' | 'openNow'> }) {
  const t = await getTranslations('finder');
  const locale = await getLocale();
  if (loc.status === 'opening_soon') return <Pill tone="warn">{t('openingSoon')}</Pill>;
  if (!loc.openNow) return null;
  return loc.openNow.open
    ? <Pill tone="ok">{loc.openNow.closesAt ? t('closesAt', { time: clock(loc.openNow.closesAt, locale) }) : t('openNow')}</Pill>
    : <Pill tone="muted">{t('closedNow')}</Pill>;
}

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: React.ReactNode }) {
  const cls = tone === 'ok' ? 'bg-success-bg text-success' : tone === 'warn' ? 'bg-warning-bg text-warning' : 'bg-canvas text-graphite';
  const dot = tone === 'ok' ? 'bg-success' : tone === 'warn' ? 'bg-warning' : 'bg-stone';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${cls}`}>
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
      {children}
    </span>
  );
}

import { getTranslations } from 'next-intl/server';
import { DEMO_MODE } from '@/lib/demo';

/** Demo site only: a slim ribbon so nobody mistakes the demo for a real business account. */
export async function DemoRibbon() {
  if (!DEMO_MODE) return null;
  const t = await getTranslations('demo');
  return (
    <div role="note" data-testid="demo-ribbon" className="relative z-[70] flex items-center justify-center gap-2 bg-ink px-4 py-1.5 text-center text-xs font-bold text-white">
      <span className="rounded-full bg-lime px-2 py-0.5 text-[11px] text-ink">{t('ribbon')}</span>
      <span className="font-medium">{t('ribbonNote')}</span>
    </div>
  );
}

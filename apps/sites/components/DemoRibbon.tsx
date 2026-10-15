import { getTranslations } from 'next-intl/server';

/** Demo site only (NEXT_PUBLIC_DEMO_MODE=true): customer sites of demo businesses say so plainly. */
export async function DemoRibbon() {
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== 'true') return null;
  const t = await getTranslations('common');
  return (
    <div role="note" data-testid="demo-ribbon" className="flex flex-wrap items-center justify-center gap-2 bg-ink px-4 py-1.5 text-center text-xs font-bold text-white">
      <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-ink">{t('demoRibbon')}</span>
      <span className="font-medium">{t('demoRibbonNote')}</span>
    </div>
  );
}

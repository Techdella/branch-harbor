import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { IconName } from '@bh/icons';
import { PageHero, Panel, PastelIcon } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { PASTEL } from '@/content/images';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };
export const generateMetadata = async ({ params }: Props) => buildMetadata((await params).locale, 'docs');

const ICONS: { icon: IconName; bg: string }[] = [
  { icon: 'zap', bg: PASTEL.lime },
  { icon: 'users', bg: PASTEL.lilac },
  { icon: 'globe', bg: PASTEL.aqua },
  { icon: 'wordpress', bg: PASTEL.butter },
  { icon: 'plug', bg: PASTEL.sage },
  { icon: 'card', bg: PASTEL.blush },
  { icon: 'marina', bg: PASTEL.lilac },
  { icon: 'code', bg: PASTEL.canvas },
];

export default async function DocsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('docs');
  const sections = t.raw('sections') as { t: string; d: string }[];
  return (
    <>
      <PageHero kicker={t('kicker')} kickerIcon="book" title={t('headline')} intro={t('intro')} />
      <Panel labelledBy="docs-index">
        <h2 id="docs-index" className="sr-only">
          {t('headline')}
        </h2>
        <ol className="grid gap-3 sm:grid-cols-2">
          {sections.map((s, i) => (
            <li key={s.t} className="flex gap-4 rounded-[24px] bg-canvas-raised p-6">
              <PastelIcon name={ICONS[i]?.icon ?? 'book'} bg={ICONS[i]?.bg ?? PASTEL.canvas} />
              <div className="flex flex-col gap-1.5">
                <h3 className="flex flex-wrap items-center gap-2 text-lg font-extrabold tracking-[-0.02em]">
                  {s.t}
                  <span className="rounded-full bg-surface px-2.5 py-0.5 text-[11px] font-bold text-stone">{t('status')}</span>
                </h3>
                <p className="text-[15px] leading-relaxed text-stone">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </Panel>
      <Panel className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-extrabold">{t('helpTitle')}</h2>
          <p className="text-[15px] text-stone">{t('helpBody')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/support">{(await getTranslations('nav'))('support')}</LinkButton>
          <LinkButton href="/resources" variant="secondary">
            {(await getTranslations('nav'))('resources')}
          </LinkButton>
        </div>
      </Panel>
    </>
  );
}

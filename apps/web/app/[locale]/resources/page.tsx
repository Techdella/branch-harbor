import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Icon } from '@/components/ui';
import { PageHero, Panel } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { GuideList } from '@/components/resources/GuideList';
import { Link } from '@/i18n/navigation';
import { PASTEL } from '@/content/images';
import { getArticles } from '@/lib/articles';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };
export const generateMetadata = async ({ params }: Props) => buildMetadata((await params).locale, 'resources');

export default async function ResourcesPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('resources');
  const ta = await getTranslations('articles');
  const hubs = [
    { kind: 'blog' as const, icon: 'edit' as const, bg: PASTEL.lilac, count: getArticles('blog').length },
    { kind: 'guides' as const, icon: 'book' as const, bg: PASTEL.butter, count: getArticles('guides').length },
  ];
  return (
    <>
      <PageHero kicker={t('kicker')} kickerIcon="book" title={t('headline')} intro={t('intro')} />
      <section aria-label={`${ta('blog.kicker')} · ${ta('guides.kicker')}`} className="grid gap-[var(--edge)] md:grid-cols-2">
        {hubs.map((h) => (
          <Link key={h.kind} href={`/${h.kind}`} className="group flex flex-col gap-4 rounded-[28px] p-7 transition hover:brightness-[0.98] md:rounded-2xl md:p-10" style={{ background: h.bg }}>
            <span className="flex h-12 w-12 items-center justify-center rounded-[16px] bg-surface">
              <Icon name={h.icon} size={24} />
            </span>
            <span className="text-[28px] leading-tight font-extrabold tracking-[-0.03em]">{ta(`${h.kind}.kicker`)}</span>
            <span className="max-w-lg text-[15px] leading-relaxed text-graphite">{ta(`${h.kind}.intro`)}</span>
            <span className="mt-auto inline-flex items-center gap-2 text-sm font-bold">
              {ta('results', { count: h.count })}
              <Icon name="arrow-right" size={16} className="transition group-hover:translate-x-0.5 rtl:-scale-x-100" />
            </span>
          </Link>
        ))}
      </section>
      <Panel labelledBy="guides-title">
        <h2 id="guides-title" className="mb-6 text-[28px] leading-tight font-extrabold tracking-[-0.03em]">
          {t('outlinesTitle')}
        </h2>
        <GuideList />
      </Panel>
      <Panel tone="lilac" className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
        <p className="text-xl font-extrabold tracking-[-0.02em]">{t('docsCta')}</p>
        <LinkButton href="/docs" iconRight="arrow-right">
          {t('docsLink')}
        </LinkButton>
      </Panel>
    </>
  );
}

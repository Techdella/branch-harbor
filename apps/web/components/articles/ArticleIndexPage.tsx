import { getLocale, getTranslations } from 'next-intl/server';
import { Icon } from '@/components/ui';
import { PageHero, Panel } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { Link } from '@/i18n/navigation';
import { getArticles, toMeta, type ArticleKind } from '@/lib/articles';
import { SITE_URL, localizedPath } from '@/lib/seo';
import { ArticleIndex } from './ArticleIndex';

/** /blog and /guides index: hero, filters and cards, plus a CollectionPage + BreadcrumbList for search engines. */
export async function ArticleIndexPage({ kind }: { kind: ArticleKind }) {
  const t = await getTranslations('articles');
  const tc = await getTranslations('common');
  const locale = await getLocale();
  const articles = getArticles(kind).map(toMeta);
  const other: ArticleKind = kind === 'blog' ? 'guides' : 'blog';
  const url = SITE_URL + localizedPath(locale, `/${kind}`);

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: t(`${kind}.metaTitle`),
      description: t(`${kind}.intro`),
      url,
      inLanguage: locale,
      hasPart: articles.map((a) => ({ '@type': kind === 'blog' ? 'BlogPosting' : 'Article', headline: a.title, url: SITE_URL + localizedPath('en', `/${kind}/${a.slug}`), datePublished: a.date })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: tc('home'), item: SITE_URL + localizedPath(locale, '/') },
        { '@type': 'ListItem', position: 2, name: t(`${kind}.metaTitle`), item: url },
      ],
    },
  ];

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <PageHero kicker={t(`${kind}.kicker`)} kickerIcon={kind === 'blog' ? 'edit' : 'book'} title={t(`${kind}.headline`)} intro={t(`${kind}.intro`)}>
        <p className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-bold">
          <Link href={`/${other}`} className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline">
            {t(`${other}.browse`)}
            <Icon name="arrow-right" size={16} className="rtl:-scale-x-100" />
          </Link>
          {kind === 'blog' && (
            <a href="/blog/rss.xml" className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline">
              <Icon name="share" size={16} />
              {t('rss')}
            </a>
          )}
        </p>
        {locale !== 'en' && locale !== 'en-GB' && <p className="text-sm text-stone">{t('englishOnlyIndex')}</p>}
      </PageHero>
      <Panel labelledBy="articles-title">
        <h2 id="articles-title" className="sr-only">
          {t(`${kind}.kicker`)}
        </h2>
        <ArticleIndex articles={articles} />
      </Panel>
      <Panel tone="lilac" className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
        <p className="max-w-2xl text-xl font-extrabold tracking-[-0.02em]">{t('ctaTitle')}</p>
        <LinkButton href="/demo" iconRight="arrow-right">
          {tc('requestDemo')}
        </LinkButton>
      </Panel>
    </>
  );
}

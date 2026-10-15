import Image from 'next/image';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { IconName } from '@bh/icons';
import { Icon } from '@/components/ui';
import { Panel } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { Link } from '@/i18n/navigation';
import { INDUSTRIES } from '@/content/industries';
import { getArticle, relatedArticles, type ArticleKind } from '@/lib/articles';
import { SITE_URL, localizedPath } from '@/lib/seo';
import { DEMO_URL, signUpUrl } from '@/lib/links';
import { ArticleCard, formatArticleDate } from './ArticleCard';
import { Markdown } from './Markdown';

/** Article layout: hero, body with table of contents and share links, related reading, JSON-LD. */
export async function ArticlePage({ kind, slug }: { kind: ArticleKind; slug: string }) {
  const a = getArticle(kind, slug);
  if (!a) notFound();
  const t = await getTranslations('articles');
  const tc = await getTranslations('common');
  const tm = await getTranslations('industryMeta');
  const locale = await getLocale();
  const related = relatedArticles(a);
  const english = locale === 'en' || locale === 'en-GB';
  // Articles are English: the canonical URL is the English page.
  const canonical = SITE_URL + localizedPath('en', `/${kind}/${slug}`);
  const pastel = a.industry === 'all' ? '#E9DDF8' : INDUSTRIES[a.industry].pastel;
  const section = t(`${kind}.metaTitle`);

  const shareText = encodeURIComponent(a.title);
  const shareUrl = encodeURIComponent(canonical);
  const share: { label: string; href: string; icon: IconName }[] = [
    { label: t('shareX'), href: `https://x.com/intent/post?text=${shareText}&url=${shareUrl}`, icon: 'share' },
    { label: t('shareLinkedIn'), href: `https://www.linkedin.com/sharing/share-offsite/?url=${shareUrl}`, icon: 'briefcase' },
    { label: t('shareFacebook'), href: `https://www.facebook.com/sharer/sharer.php?u=${shareUrl}`, icon: 'users' },
    { label: t('shareEmail'), href: `mailto:?subject=${shareText}&body=${shareUrl}`, icon: 'mail' },
  ];

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': kind === 'blog' ? 'BlogPosting' : 'Article',
      headline: a.title,
      description: a.description,
      image: [a.hero, `${SITE_URL}/api/og/article/${kind}/${slug}`],
      datePublished: a.date,
      dateModified: a.updated ?? a.date,
      inLanguage: 'en',
      keywords: a.tags.join(', '),
      articleSection: section,
      wordCount: a.body.split(/\s+/).filter(Boolean).length,
      author: { '@type': 'Organization', name: a.author, url: SITE_URL },
      publisher: { '@type': 'Organization', name: 'BranchHarbor', url: SITE_URL },
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: tc('home'), item: SITE_URL + localizedPath(locale, '/') },
        { '@type': 'ListItem', position: 2, name: section, item: SITE_URL + localizedPath(locale, `/${kind}`) },
        { '@type': 'ListItem', position: 3, name: a.title, item: canonical },
      ],
    },
  ];

  const toc = a.headings.filter((h) => h.level === 2);

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <Panel labelledBy="article-title" className="flex flex-col gap-8">
        <div className="flex max-w-[880px] flex-col items-start gap-5">
          <nav aria-label={tc('breadcrumb')} className="text-[13px] font-semibold text-stone">
            <ol className="flex flex-wrap items-center gap-1.5">
              <li>
                <Link href="/" className="hover:text-ink hover:underline">
                  {tc('home')}
                </Link>
              </li>
              <li aria-hidden="true">
                <Icon name="chevron-right" size={14} className="rtl:-scale-x-100" />
              </li>
              <li>
                <Link href={`/${kind}`} className="hover:text-ink hover:underline">
                  {section}
                </Link>
              </li>
              <li aria-hidden="true">
                <Icon name="chevron-right" size={14} className="rtl:-scale-x-100" />
              </li>
              <li aria-current="page" className="line-clamp-1 font-bold text-ink" lang="en">
                {a.title}
              </li>
            </ol>
          </nav>
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <span className="rounded-full px-3 py-1.5" style={{ background: pastel }}>
              {a.industry === 'all' ? t('allIndustries') : tm(`${a.industry}.name`)}
            </span>
            {a.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-canvas px-3 py-1.5">
                {t(`tags.${tag}`)}
              </span>
            ))}
          </div>
          <h1 id="article-title" lang="en" className="text-[36px] leading-[1.05] font-extrabold tracking-[-0.045em] md:text-[54px]">
            {a.title}
          </h1>
          <p lang="en" className="text-lg leading-relaxed text-stone md:text-xl">
            {a.description}
          </p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold text-stone">
            <span>{t('by', { author: a.author })}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={a.date}>{t('published', { date: formatArticleDate(a.date, locale) })}</time>
            {a.updated && (
              <>
                <span aria-hidden="true">·</span>
                <time dateTime={a.updated}>{t('updated', { date: formatArticleDate(a.updated, locale) })}</time>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1">
              <Icon name="clock" size={14} />
              {t('minutes', { count: a.readingTime })}
            </span>
          </p>
          {!english && (
            <p className="flex items-start gap-2 rounded-[16px] bg-canvas px-4 py-3 text-sm text-graphite">
              <Icon name="globe" size={16} className="mt-0.5 shrink-0" />
              {t('englishOnly')}
            </p>
          )}
        </div>
        <div className="relative aspect-[16/9] overflow-hidden rounded-[24px] md:aspect-[21/8]" style={{ background: pastel }}>
          <Image src={a.hero} alt={a.heroAlt} fill priority sizes="(min-width: 1440px) 1440px, 100vw" className="object-cover" />
        </div>
      </Panel>

      <Panel className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-16 min-[120rem]:grid-cols-[minmax(0,1fr)_320px]">
        <aside className="lg:order-2">
          <div className="flex flex-col gap-6 lg:sticky lg:top-[calc(var(--header-h)+2*var(--edge)+16px)]">
            {toc.length > 1 && (
              <details className="group rounded-[20px] bg-canvas p-4 lg:p-5" open>
                <summary className="flex items-center justify-between gap-2 text-sm font-extrabold">
                  {t('toc')}
                  <Icon name="chevron-down" size={16} className="transition-transform duration-200 group-open:rotate-180" />
                </summary>
                <ol className="mt-3 flex flex-col gap-1 border-s-2 border-line" lang="en">
                  {toc.map((h) => (
                    <li key={h.id}>
                      <a href={`#${h.id}`} className="-ms-0.5 block border-s-2 border-transparent py-1 ps-3 text-[14px] leading-snug text-graphite transition hover:border-ink hover:text-ink">
                        {h.text}
                      </a>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            <div className="flex flex-col gap-2">
              <p className="text-sm font-extrabold">{t('share')}</p>
              <ul className="flex flex-wrap gap-2 lg:flex-col">
                {share.map((s) => (
                  <li key={s.label}>
                    <a href={s.href} rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-3.5 text-[13px] font-bold transition hover:border-ink">
                      <Icon name={s.icon} size={16} />
                      {s.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </aside>
        <article lang="en" className="max-w-[760px] lg:order-1">
          <Markdown source={a.body} />
        </article>
      </Panel>

      {related.length > 0 && (
        <Panel labelledBy="related-title">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <h2 id="related-title" className="text-[30px] leading-[1.08] font-extrabold tracking-[-0.035em] md:text-[36px]">
              {t('related')}
            </h2>
            <Link href={`/${kind}`} className="inline-flex items-center gap-1.5 text-sm font-bold underline-offset-4 hover:underline">
              {t(kind === 'blog' ? 'backToBlog' : 'backToGuides')}
              <Icon name="arrow-right" size={16} className="rtl:-scale-x-100" />
            </Link>
          </div>
          <ul className="grid gap-[var(--edge)] md:grid-cols-3">
            {related.map((r) => (
              <li key={`${r.kind}/${r.slug}`}>
                <ArticleCard a={r} />
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel tone="ink" labelledBy="article-cta" className="flex flex-col items-center gap-5 text-center md:py-16">
        <h2 id="article-cta" className="max-w-2xl text-[30px] leading-[1.08] font-extrabold tracking-[-0.035em] md:text-[40px]">
          {t('ctaTitle')}
        </h2>
        <div className="flex flex-wrap justify-center gap-2.5">
          <LinkButton href={DEMO_URL} external size="lg" variant="light" iconRight="arrow-up-right">
            {tc('tryDemo')}
          </LinkButton>
          <LinkButton href={signUpUrl(a.industry === 'all' ? {} : { industry: a.industry })} external size="lg" variant="onDark">
            {tc('startPlan')}
          </LinkButton>
        </div>
      </Panel>
    </>
  );
}

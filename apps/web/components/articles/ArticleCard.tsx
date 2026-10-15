import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import { Icon, cx } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { INDUSTRIES } from '@/content/industries';
import type { ArticleMeta } from '@/lib/articles';

export function formatArticleDate(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

/** Card for article lists (index pages, related reading). Works in server and client components. */
export function ArticleCard({ a, featured = false, headingLevel = 'h3' }: { a: ArticleMeta; featured?: boolean; headingLevel?: 'h2' | 'h3' }) {
  const t = useTranslations('articles');
  const tm = useTranslations('industryMeta');
  const locale = useLocale();
  const H = headingLevel;
  const pastel = a.industry === 'all' ? '#F3F2EE' : INDUSTRIES[a.industry].pastel;
  return (
    <article className={cx('group relative flex h-full flex-col overflow-hidden rounded-[24px] border border-line-soft bg-surface transition duration-200 ease-bh hover:-translate-y-0.5 hover:shadow-pop has-[a:focus-visible]:outline-3 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-focus', featured && 'md:flex-row')}>
      <div className={cx('relative aspect-[16/9] shrink-0 overflow-hidden', featured && 'md:aspect-auto md:w-1/2')} style={{ background: pastel }}>
        <Image src={a.hero} alt="" fill sizes={featured ? '(min-width: 768px) 50vw, 100vw' : '(min-width: 1800px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw'} className="object-cover transition duration-500 group-hover:scale-[1.03]" />
      </div>
      <div className={cx('flex flex-1 flex-col gap-3 p-5 md:p-6', featured && 'md:justify-center md:p-10')}>
        <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
          <span className="rounded-full px-2.5 py-1" style={{ background: pastel }}>
            {a.industry === 'all' ? t('allIndustries') : tm(`${a.industry}.name`)}
          </span>
          {a.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="rounded-full bg-canvas px-2.5 py-1">
              {t(`tags.${tag}`)}
            </span>
          ))}
        </div>
        <H className={cx('font-extrabold tracking-[-0.025em] text-ink', featured ? 'text-[28px] leading-tight md:text-[36px]' : 'text-xl leading-snug')}>
          <Link href={`/${a.kind}/${a.slug}`} className="after:absolute after:inset-0 after:rounded-[24px] focus-visible:outline-none" lang="en">
            {a.title}
          </Link>
        </H>
        <p className={cx('leading-relaxed text-stone', featured ? 'text-base' : 'text-[15px]')} lang="en">
          {a.description}
        </p>
        <p className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-[13px] font-semibold text-stone">
          <time dateTime={a.date}>{formatArticleDate(a.date, locale)}</time>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <Icon name="clock" size={14} />
            {t('minutes', { count: a.readingTime })}
          </span>
        </p>
      </div>
    </article>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, cx } from '@/components/ui';
import { INDUSTRY_KEYS, type IndustryKey } from '@/content/industries';
import type { ArticleMeta, ArticleTag } from '@/lib/articles';
import { ArticleCard } from './ArticleCard';

const chip = (on: boolean) =>
  cx(
    'inline-flex min-h-10 items-center gap-1.5 rounded-full border px-4 text-[13px] font-bold transition duration-150 ease-bh',
    on ? 'border-ink bg-ink text-white' : 'border-line bg-surface text-ink hover:border-ink',
  );

/** Article list with industry and topic filters (client-side; every article is in the page for crawlers). */
export function ArticleIndex({ articles }: { articles: ArticleMeta[] }) {
  const t = useTranslations('articles');
  const tm = useTranslations('industryMeta');
  const [industry, setIndustry] = useState<IndustryKey | 'all'>('all');
  const [tag, setTag] = useState<ArticleTag | 'all'>('all');

  // Only offer filters that match at least one article.
  const industries = INDUSTRY_KEYS.filter((k) => articles.some((a) => a.industry === k));
  const tags = useMemo(() => [...new Set(articles.flatMap((a) => a.tags))].sort((a, b) => t(`tags.${a}`).localeCompare(t(`tags.${b}`))), [articles, t]);

  const list = articles.filter((a) => (industry === 'all' || a.industry === industry || a.industry === 'all') && (tag === 'all' || a.tags.includes(tag)));
  const filtered = industry !== 'all' || tag !== 'all';
  const [first, ...rest] = list;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 rounded-[24px] bg-canvas p-4 md:p-5">
        <div role="group" aria-label={t('industryLabel')} className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <span className="w-24 shrink-0 text-[13px] font-bold text-stone">{t('industryLabel')}</span>
          <div className="flex flex-wrap gap-2">
            {(['all', ...industries] as const).map((k) => (
              <button key={k} type="button" aria-pressed={industry === k} onClick={() => setIndustry(k)} className={chip(industry === k)}>
                {k === 'all' ? t('allIndustries') : tm(`${k}.name`)}
              </button>
            ))}
          </div>
        </div>
        <div role="group" aria-label={t('tagLabel')} className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <span className="w-24 shrink-0 text-[13px] font-bold text-stone">{t('tagLabel')}</span>
          <div className="flex flex-wrap gap-2">
            {(['all', ...tags] as const).map((k) => (
              <button key={k} type="button" aria-pressed={tag === k} onClick={() => setTag(k)} className={chip(tag === k)}>
                {k === 'all' ? t('all') : t(`tags.${k}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3 text-[13px] font-bold">
          <p aria-live="polite">{t('results', { count: list.length })}</p>
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setIndustry('all');
                setTag('all');
              }}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 transition hover:bg-surface"
            >
              <Icon name="x" size={14} />
              {t('clear')}
            </button>
          )}
        </div>
      </div>

      {list.length === 0 ? (
        <p className="rounded-[24px] border-[1.5px] border-dashed border-line p-8 text-center text-stone">{t('empty')}</p>
      ) : (
        <ul className="grid gap-[var(--edge)] sm:grid-cols-2 lg:grid-cols-3 min-[1800px]:grid-cols-4">
          {first && (
            <li className={cx(!filtered && 'sm:col-span-2 lg:col-span-3 min-[1800px]:col-span-4')}>
              <ArticleCard a={first} featured={!filtered} headingLevel="h2" />
            </li>
          )}
          {rest.map((a) => (
            <li key={`${a.kind}/${a.slug}`}>
              <ArticleCard a={a} headingLevel="h2" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { IconName } from '@bh/icons';
import { Icon, cx } from '@/components/ui';
import { PASTEL } from '@/content/images';

type Cat = 'start' | 'websites' | 'wordpress' | 'networks' | 'payments';
const CATS: Cat[] = ['start', 'websites', 'wordpress', 'networks', 'payments'];
const CAT_STYLE: Record<Cat, { icon: IconName; bg: string }> = {
  start: { icon: 'zap', bg: PASTEL.lime },
  websites: { icon: 'globe', bg: PASTEL.aqua },
  wordpress: { icon: 'wordpress', bg: PASTEL.butter },
  networks: { icon: 'building', bg: PASTEL.lilac },
  payments: { icon: 'card', bg: PASTEL.blush },
};

export function GuideList() {
  const t = useTranslations('resources');
  const items = t.raw('items') as { cat: Cat; title: string; sum: string; mins: number }[];
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Cat | 'all'>('all');
  const id = useId();
  const needle = q.trim().toLowerCase();
  const list = items.filter((i) => (cat === 'all' || i.cat === cat) && (!needle || `${i.title} ${i.sum}`.toLowerCase().includes(needle)));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-[13px] font-bold">
          {t('searchLabel')}
        </label>
        <div className="relative max-w-xl">
          <Icon name="search" size={18} className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-stone" />
          <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchPlaceholder')} className="h-12 w-full rounded-full border border-line bg-surface ps-11 pe-4 text-[15px] font-medium focus:border-ink" />
        </div>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('kicker')}>
        {(['all', ...CATS] as const).map((c) => (
          <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(c)} className={cx('h-10 rounded-full border-[1.5px] px-4 text-[13px] font-bold', cat === c ? 'border-ink bg-ink text-white' : 'border-line-soft bg-surface hover:border-ink')}>
            {c === 'all' ? t('all') : t(`categories.${c}`)}
          </button>
        ))}
      </div>
      <p role="status" className="sr-only">
        {list.length}
      </p>
      {list.length === 0 ? (
        <p className="rounded-[20px] border border-dashed border-line p-8 text-center font-bold">{t('empty')}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {list.map((g) => (
            <li key={g.title} className="flex flex-col gap-3 rounded-[24px] border border-line-soft p-5">
              <div className="flex items-center justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-[13px]" style={{ background: CAT_STYLE[g.cat].bg }}>
                  <Icon name={CAT_STYLE[g.cat].icon} size={19} />
                </span>
                <span className="rounded-full bg-canvas px-2.5 py-1 text-[11px] font-bold">{t('outline')}</span>
              </div>
              <span className="text-xs font-bold text-stone">{t(`categories.${g.cat}`)}</span>
              <h3 className="text-lg leading-snug font-extrabold tracking-[-0.02em]">{g.title}</h3>
              <p className="text-sm leading-relaxed text-stone">{g.sum}</p>
              <span className="mt-auto flex items-center gap-1.5 text-xs font-semibold text-stone">
                <Icon name="clock" size={13} />
                {t('minutes', { count: g.mins })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

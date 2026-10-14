'use client';

import { useLocale } from 'next-intl';
import { Icon, cx } from '@bh/ui';
import type { TimelineEvent } from '@/lib/types';
import { fmtTime } from '@/lib/format';

const toneBg = { success: 'bg-lime-soft', info: 'bg-aqua', warning: 'bg-butter', danger: 'bg-blush', neutral: 'bg-canvas', signal: 'bg-lime' } as const;

export function Timeline({ events, tz }: { events: TimelineEvent[]; tz: string }) {
  const locale = useLocale();
  return (
    <ol className="flex flex-col">
      {events.map((e, i) => (
        <li key={i} className="flex gap-2.5 py-1.5 text-[13px]">
          <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full', toneBg[e.tone])}>
            <Icon name={e.icon} size={12} />
          </span>
          <span className="tabular w-16 shrink-0 pt-0.5 text-xs text-stone">{fmtTime(e.at, tz, locale)}</span>
          <span className="flex-1 pt-0.5">{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Badge, OriginTag } from '@bh/ui';
import type { Cell } from '@/lib/types';
import { moneyWithCode } from '@/lib/format';

export function CellView({ c }: { c: Cell | undefined }) {
  const locale = useLocale();
  const t = useTranslations('table');
  if (!c) return null;
  switch (c.t) {
    case 'text':
      return (
        <span className="block">
          <span className={c.strong ? 'font-bold' : undefined}>{c.v}</span>
          {c.sub && <span className="block text-xs font-medium text-stone">{c.sub}</span>}
        </span>
      );
    case 'badge':
      return <Badge tone={c.tone} icon={c.icon}>{c.v}</Badge>;
    case 'money':
      return (
        <span className="tabular block">
          {moneyWithCode(c.v, locale)}
          {c.sub && <span className="block text-xs text-stone">{c.sub}</span>}
        </span>
      );
    case 'origin':
      return <OriginTag origin={c.v} />;
    case 'unavailable':
      return (
        <span className="block text-mute">
          {t('unavailable')}
          {c.reason && <span className="block text-xs text-stone">{c.reason}</span>}
        </span>
      );
  }
}

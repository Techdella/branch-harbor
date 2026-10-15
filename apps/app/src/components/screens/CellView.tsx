'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Badge, OriginTag } from '@bh/ui';
import type { Cell } from '@/lib/types';
import { moneyWithCode } from '@/lib/format';
import { useTxt } from '../ui/useDataText';

export function CellView({ c }: { c: Cell | undefined }) {
  const locale = useLocale();
  const t = useTranslations('table');
  const tt = useTxt();
  if (!c) return null;
  switch (c.t) {
    case 'text':
      return (
        <span className="block">
          <span className={c.strong ? 'font-bold' : undefined}>{tt(c.v, c.vMsg)}</span>
          {c.sub && <span className="block text-xs font-medium text-stone">{tt(c.sub, c.subMsg)}</span>}
        </span>
      );
    case 'badge':
      return <Badge tone={c.tone} icon={c.icon}>{tt(c.v, c.vMsg)}</Badge>;
    case 'money':
      return (
        <span className="tabular block">
          {moneyWithCode(c.v, locale)}
          {c.sub && <span className="block text-xs text-stone">{tt(c.sub, c.subMsg)}</span>}
        </span>
      );
    case 'origin':
      return <OriginTag origin={c.v} />;
    case 'unavailable':
      return (
        <span className="block text-mute">
          {t('unavailable')}
          {c.reason && <span className="block text-xs text-stone">{tt(c.reason, c.reasonMsg)}</span>}
        </span>
      );
  }
}

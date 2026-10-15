'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon, cx } from '@bh/ui';
import type { Metric } from '@/lib/types';
import { fmtNumber, moneyWithCode } from '@/lib/format';
import { useDataText } from '../ui/useDataText';

/** Metric card: value, time range, data source and definition. Missing data is never shown as zero. */
export function MetricCard({ m }: { m: Metric }) {
  const t = useTranslations('overview');
  const locale = useLocale();
  const dt = useDataText();
  const label = dt(m.labelKey, undefined, m.label);
  const [showDef, setShowDef] = useState(false);
  const v = m.value;
  let body: React.ReactNode;
  if (m.state === 'not_connected') body = <span className="text-xl text-graphite">{t('notConnected')}</span>;
  else if (m.state === 'unavailable' || !v) body = <span className="text-xl text-graphite">{t('unavailable')}</span>;
  else if (v.kind === 'money')
    body = (
      <span className={cx('flex flex-col', v.values.length > 1 ? 'gap-0.5 text-lg' : 'text-[28px]')}>
        {v.values.map((x) => (
          <span key={x.currency}>{moneyWithCode(x, locale)}</span>
        ))}
      </span>
    );
  else if (v.kind === 'percent') body = fmtNumber(v.value, locale, { style: 'percent', maximumFractionDigits: 0 });
  else if (v.kind === 'ratio') body = t('ratio', { value: v.value, of: v.of });
  else body = fmtNumber(v.value, locale);

  return (
    <div className="flex flex-col gap-2 rounded-lg p-5" style={{ background: m.pastel }}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex h-[38px] w-[38px] items-center justify-center rounded-sm bg-surface">
          <Icon name={m.icon} size={18} />
        </span>
        <span className="text-[11px] font-semibold text-graphite">{dt(m.rangeKey, undefined, m.range)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <h3 className="text-[13px] font-semibold">{label}</h3>
        <button type="button" onClick={() => setShowDef((s) => !s)} aria-expanded={showDef} aria-label={t('definitionOf', { label })} className="rounded-full p-0.5 text-graphite hover:bg-surface/60">
          <Icon name="help" size={13} />
        </button>
      </div>
      {showDef && <p className="rounded-sm bg-surface/70 px-2.5 py-1.5 text-xs leading-snug">{dt(m.definitionKey, undefined, m.definition)}</p>}
      <div className="tabular text-[30px] font-extrabold leading-tight tracking-[-0.02em]">{body}</div>
      {(m.note || m.noteKey) && <div className="text-[11px] font-semibold text-graphite">{dt(m.noteKey, m.noteParams, m.note ?? '')}</div>}
      <div className="mt-auto flex items-center gap-1 text-[11px] text-graphite">
        <Icon name="info" size={11} />
        {t('source', { source: dt(m.sourceKey, m.sourceParams, m.source) })}
      </div>
    </div>
  );
}

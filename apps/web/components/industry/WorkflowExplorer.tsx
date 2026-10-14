'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { IconName } from '@bh/icons';
import { Icon, cx } from '@/components/ui';
import { PASTEL, type PastelKey } from '@/content/images';

export interface WorkflowStepView {
  label: string;
  title: string;
  desc: string;
  screen: string;
  scope: string;
  icon: IconName;
  rows: { a: string; b: string; tag: string; icon: IconName; tone: PastelKey }[];
}

/** Interactive sample workflow: accessible tabs (arrow keys move between steps). */
export function WorkflowExplorer({ steps, pastel }: { steps: WorkflowStepView[]; pastel: string }) {
  const t = useTranslations('industryPage');
  const [i, setI] = useState(0);
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const step = steps[i]!;

  const go = (n: number) => {
    const next = Math.max(0, Math.min(steps.length - 1, n));
    setI(next);
    tabRefs.current[next]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const rtl = document.dir === 'rtl';
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) go(i + 1);
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(steps.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div>
      <div role="tablist" aria-label={t('workflowSteps')} className="flex flex-wrap gap-2">
        {steps.map((s, n) => {
          const on = n === i;
          return (
            <button
              key={s.label}
              ref={(el) => {
                tabRefs.current[n] = el;
              }}
              role="tab"
              id={`${baseId}-tab-${n}`}
              aria-selected={on}
              aria-controls={`${baseId}-panel`}
              tabIndex={on ? 0 : -1}
              onClick={() => setI(n)}
              onKeyDown={onKey}
              className={cx('inline-flex h-11 items-center gap-2 rounded-full ps-1.5 pe-4 text-sm font-bold transition', on ? 'bg-ink text-white' : 'border border-line-soft bg-surface hover:border-ink')}
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-extrabold text-ink" style={{ background: on ? PASTEL.signal : pastel }}>
                {n + 1}
              </span>
              {s.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${i}`} className="mt-6 grid gap-3 lg:grid-cols-[1fr_1.3fr]">
        <div className="flex min-w-0 flex-col items-start gap-4 rounded-[24px] p-6 md:p-8" style={{ background: pastel }}>
          <span className="flex h-12 w-12 items-center justify-center rounded-[16px] bg-surface">
            <Icon name={step.icon} size={24} />
          </span>
          <p className="text-xs font-bold text-graphite">{t('stepOf', { current: i + 1, total: steps.length })}</p>
          <h3 className="text-[26px] leading-tight font-extrabold tracking-[-0.03em]">{step.title}</h3>
          <p className="text-[15px] leading-relaxed text-graphite">{step.desc}</p>
          <div className="mt-auto flex gap-2 pt-2">
            <button type="button" onClick={() => setI(i - 1)} disabled={i === 0} aria-label={t('previous')} className="flex h-11 w-11 items-center justify-center rounded-full bg-surface disabled:opacity-40">
              <Icon name="arrow-left" size={18} className="rtl:-scale-x-100" />
            </button>
            <button type="button" onClick={() => setI(i + 1)} disabled={i === steps.length - 1} aria-label={t('next')} className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-white disabled:opacity-40">
              <Icon name="arrow-right" size={18} className="rtl:-scale-x-100" />
            </button>
          </div>
        </div>
        <div className="min-w-0 rounded-[24px] bg-canvas p-2.5 sm:p-4">
          <div className="overflow-hidden rounded-[18px] bg-surface">
            <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
              <Icon name={step.icon} size={16} />
              <span className="text-sm font-bold">{step.screen}</span>
              <span className="ms-auto inline-flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-stone">
                <Icon name="pin" size={12} />
                {step.scope}
              </span>
            </div>
            <ul className="flex flex-col p-2">
              {step.rows.map((r) => (
                <li key={r.a} className="flex items-center gap-3 rounded-[14px] px-3 py-3 odd:bg-canvas-raised">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-canvas">
                    <Icon name={r.icon} size={16} />
                  </span>
                  {/* Long compounds (e.g. German) must wrap rather than widen the grid at 360px. */}
                  <span className="flex min-w-0 flex-1 flex-col hyphens-auto [overflow-wrap:anywhere]">
                    <span className="text-sm font-bold">{r.a}</span>
                    <span className="text-xs text-stone">{r.b}</span>
                  </span>
                  <span className="shrink-0 rounded-full px-2.5 py-1 text-xs font-bold" style={{ background: PASTEL[r.tone] }}>
                    {r.tag}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

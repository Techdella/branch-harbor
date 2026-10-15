'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Icon, cx } from '@bh/ui';
import type { AiAnswer } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { Banner } from '../ui/States';
import { useApp } from './AppContext';
import { useScopeLabel } from './ScopePicker';

type ActionState = 'idle' | 'preview' | 'running' | 'done' | 'discarded';

function ProposedAction({ answer }: { answer: AiAnswer }) {
  const t = useTranslations('ai');
  const app = useApp();
  const scopeLabel = useScopeLabel();
  const [state, setState] = useState<ActionState>('idle');
  const a = answer.action!;
  const allowed = app.can(a.requires);
  return (
    <div className="flex flex-col gap-2.5 rounded-md border-[1.5px] border-ink bg-surface p-3.5">
      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.06em] text-stone">
        <Icon name="workflow" size={13} />
        {t('proposedAction')}
      </div>
      <div className="text-sm font-bold">{a.title}</div>
      <div className="text-xs text-stone">{t('activeScope', { scope: scopeLabel })}</div>
      {(state === 'preview' || state === 'running' || state === 'done') && (
        <div className="flex flex-col gap-2 rounded-sm bg-canvas p-3 text-xs">
          <div>
            <div className="font-bold">{t('affected', { count: a.affected.length })}</div>
            <ul className="mt-1 list-disc pl-4">
              {a.affected.map((x) => (
                <li key={x}>
                  {x}
                  {state === 'done' && <span className="ml-1 font-bold text-success">· {t('resultDraftSaved')}</span>}
                </li>
              ))}
            </ul>
          </div>
          {a.excluded.length > 0 && (
            <div>
              <div className="font-bold">{t('excluded')}</div>
              <ul className="mt-1 list-disc pl-4">
                {a.excluded.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {state === 'done' && (
        <Banner tone="success" live="polite">
          {t('doneNothingSent')}
        </Banner>
      )}
      {state === 'discarded' && <p className="text-xs text-stone">{t('discarded')}</p>}
      {!allowed && state !== 'discarded' && (
        <Banner tone="neutral" icon="lock">
          {t('needsPermission', { permission: a.requires })}
        </Banner>
      )}
      {(state === 'idle' || state === 'preview') && (
        <div className="flex flex-wrap gap-2">
          {state === 'idle' ? (
            <Button size="sm" variant="secondary" icon="eye" onClick={() => setState('preview')}>
              {t('preview')}
            </Button>
          ) : (
            <Button
              size="sm"
              icon="check"
              disabled={!allowed}
              onClick={() => {
                setState('running');
                setTimeout(() => setState('done'), 900);
              }}
            >
              {a.kind === 'draft' ? t('approveDraft') : t('approveSend')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setState('discarded')}>
            {t('discard')}
          </Button>
        </div>
      )}
      {state === 'running' && (
        <p role="status" className="text-xs font-semibold">
          {t('running')}
        </p>
      )}
    </div>
  );
}

export function AiPanel({ onClose, fullScreen }: { onClose: () => void; fullScreen?: boolean }) {
  const t = useTranslations('ai');
  const app = useApp();
  const scopeLabel = useScopeLabel();
  const [q, setQ] = useState('');
  const [thread, setThread] = useState<AiAnswer[]>([]);
  const [asking, setAsking] = useState<string | null>(null);
  const sugg = useApi((api) => api.ai.suggestions(app.ctx), [app.industry, app.role, app.scopeId]);
  const ask = useMutation((api, question: string) => api.ai.ask(app.ctx, question));
  const endRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setThread([]);
  }, [app.industry, app.role]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [thread, asking]);
  useEffect(() => {
    if (!fullScreen) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullScreen, onClose]);

  const submit = async (question: string) => {
    if (!question.trim()) return;
    setAsking(question);
    setQ('');
    const r = await ask.run(question);
    setAsking(null);
    if (r) setThread((th) => [...th, r]);
  };

  return (
    <aside aria-label={t('title')} role={fullScreen ? 'dialog' : undefined} aria-modal={fullScreen || undefined} className={cx('flex flex-col overflow-hidden bg-surface', fullScreen ? 'h-full' : 'max-h-viewport-inset rounded-xl')}>
      <div className="flex flex-col gap-2.5 bg-[linear-gradient(135deg,#F1E7FB,#FDEDE4)] p-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2.5 whitespace-nowrap text-base font-bold">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[linear-gradient(135deg,#7B4FD6,#E8835A)] text-white">
              <Icon name="sparkles" size={15} />
            </span>
            {t('title')}
          </span>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t('close')} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface">
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-xs">
          <Icon name="layers" size={12} />
          <span>{t('scope')}</span>
          <strong className="truncate">{scopeLabel}</strong>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-graphite">
          <span className="inline-flex items-center gap-1 rounded-full bg-surface/70 px-2 py-0.5">
            <Icon name="edit" size={11} />
            {t('draftsOnly')}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-surface/70 px-2 py-0.5">
            <Icon name="activity" size={11} />
            {t('usage', { used: 12 + thread.length, limit: 200 })}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-surface/70 px-2 py-0.5">
            <Icon name={ask.error?.code === 'ai_unavailable' ? 'alert' : 'check-circle'} size={11} />
            {ask.error?.code === 'ai_unavailable' ? t('statusDown') : t('statusOk')}
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-4 text-sm leading-relaxed" aria-live="polite">
        <p className="text-stone">{t('intro')}</p>
        {sugg.status === 'ready' &&
          thread.length === 0 &&
          // Independent businesses: the AI scope is the business itself — drop multi-location prompts.
          sugg.data.filter((s) => app.org.model !== 'independent' || !/locations|stores|multi-location/i.test(s)).map((s) => (
            <button key={s} type="button" onClick={() => submit(s)} disabled={!!asking} className="flex items-center gap-2 rounded-md border border-line-soft bg-surface px-3.5 py-3 text-left text-[13px] font-semibold hover:border-ink">
              <Icon name="sparkles" size={13} />
              {s}
            </button>
          ))}
        {thread.map((a) => (
          <div key={a.id} className="flex flex-col gap-2">
            <div className="max-w-[88%] self-end rounded-[20px_20px_6px_20px] bg-ink px-3.5 py-2.5 text-[13px] text-white">{a.question}</div>
            <div className="rounded-[18px] bg-canvas-raised p-3.5 text-[13px]">
              <p>{a.answer}</p>
              {a.assumptions && (
                <p className="mt-2 text-xs text-stone">
                  <strong>{t('assumptions')}</strong> {a.assumptions}
                </p>
              )}
              <div className="mt-2.5 flex flex-col gap-1">
                <div className="text-[11px] font-bold uppercase tracking-[0.05em] text-stone">{t('sources')}</div>
                {a.sources.map((s) => (
                  <div key={s.label} className="flex items-center gap-1.5 text-xs">
                    <Icon name="file" size={12} />
                    <span className="font-semibold">{s.label}</span>
                    <span className="text-stone">· {s.freshness}</span>
                  </div>
                ))}
              </div>
            </div>
            {a.action && <ProposedAction answer={a} />}
          </div>
        ))}
        {asking && (
          <>
            <div className="max-w-[88%] self-end rounded-[20px_20px_6px_20px] bg-ink px-3.5 py-2.5 text-[13px] text-white">{asking}</div>
            <div role="status" className="flex items-center gap-2 text-xs text-stone">
              <span className="bh-skeleton h-2 w-16 rounded-full" />
              {t('thinking')}
            </div>
          </>
        )}
        {ask.error && (
          <Banner tone={ask.error.code === 'ai_unavailable' ? 'warning' : 'danger'} live="assertive">
            {ask.error.message}
          </Banner>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(q);
        }}
        className="flex items-center gap-2 border-t border-line-soft p-3"
      >
        <label className="flex-1">
          <span className="sr-only">{t('askLabel')}</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('askPlaceholder')} className="h-11 w-full rounded-full bg-canvas px-4 text-sm outline-none focus-visible:outline-3 focus-visible:outline-focus" />
        </label>
        <button type="submit" disabled={!q.trim() || !!asking} aria-label={t('send')} className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-white disabled:opacity-40">
          <Icon name="send" size={16} />
        </button>
      </form>
    </aside>
  );
}

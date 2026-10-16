'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon, cx, MarinaMark } from '@bh/ui';
import { ASSISTANT_NAME } from '@bh/shared';
import { marina, suggestionsFor, type ConversationSummary, type Turn } from '@/lib/marina';
import { useErrorText } from '@/lib/useErrorText';
import { useApp } from '../shell/AppContext';
import { ActionCard } from './ActionCard';
import { Citations, MarinaChart, MarinaTable, Notices, RichText } from './Blocks';
import { useMarina } from './MarinaProvider';

export { MarinaMark } from '@bh/ui';

function AssistantTurn({ turn }: { turn: Turn }) {
  const t = useTranslations('marina');
  const errText = useErrorText();
  const app = useApp();
  return (
    <div className="flex gap-2.5" data-testid="marina-answer">
      <MarinaMark size={26} thinking={turn.pending && !turn.text} />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 rounded-[18px] bg-canvas-raised p-3.5 text-[13px] leading-relaxed">
        {turn.tools.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {turn.tools.map((x) => (
              <span key={x.name} className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold', x.status === 'denied' ? 'bg-[#FCE3E1] text-[#8A1F17]' : 'bg-surface text-stone')}>
                <Icon name={x.status === 'running' ? 'refresh' : x.status === 'done' ? 'check' : 'lock'} size={10} />
                {t.has(`tool.${x.name}`) ? t(`tool.${x.name}`) : x.name.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        )}
        {turn.text ? <RichText text={turn.text} /> : turn.pending ? (
          <p role="status" className="flex items-center gap-2 text-xs text-stone"><span className="bh-skeleton h-2 w-16 rounded-full" />{t('thinking', { name: ASSISTANT_NAME })}</p>
        ) : null}
        {turn.blocks.map((b, i) => (b.type === 'table' ? <MarinaTable key={i} block={b} /> : <MarinaChart key={i} block={b} />))}
        {turn.actions.map((a) => <ActionCard key={a.id} action={a} approver={app.hasModule('ai.assistant')} />)}
        {turn.navigate && (
          <Link href={turn.navigate.path} className="inline-flex w-fit items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-xs font-bold hover:bg-line-soft">
            <Icon name="arrow-right" size={12} />{t('opened', { screen: turn.navigate.label })}
          </Link>
        )}
        <Citations citations={turn.citations} />
        <Notices notices={turn.notices} />
        {turn.error && <p role="alert" className="text-xs font-semibold text-danger">{errText(turn.error)}</p>}
      </div>
    </div>
  );
}

function History({ onPick }: { onPick: () => void }) {
  const t = useTranslations('marina');
  const m = useMarina();
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  useEffect(() => {
    marina.conversations().then(setItems).catch(() => setItems([]));
  }, []);
  if (!items) return <p className="p-4 text-sm text-stone">{t('loading')}</p>;
  if (!items.length) return <p className="p-4 text-sm text-stone">{t('history.empty')}</p>;
  return (
    <ul className="flex flex-col gap-1 p-3" aria-label={t('history.title')}>
      {items.map((c) => (
        <li key={c.id} className="group flex items-center gap-2 rounded-md hover:bg-canvas">
          <button type="button" className="flex min-w-0 flex-1 flex-col px-3 py-2 text-left" onClick={async () => { await m.load(c.id); onPick(); }}>
            <span className="truncate text-[13px] font-semibold">{c.title || t('history.untitled')}</span>
            <span className="text-[11px] text-stone">{new Date(c.updatedAt).toLocaleString()}</span>
          </button>
          <button type="button" aria-label={t('history.archive')} className="mr-2 hidden h-8 w-8 items-center justify-center rounded-full hover:bg-surface group-hover:flex" onClick={async () => { await marina.archive(c.id); setItems((xs) => xs?.filter((x) => x.id !== c.id) ?? null); }}>
            <Icon name="x" size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The persistent side panel: streaming answers, tables and charts, action cards, sources and history. */
export function MarinaPanel({ onClose, fullScreen }: { onClose: () => void; fullScreen?: boolean }) {
  const t = useTranslations('marina');
  const app = useApp();
  const m = useMarina();
  const pathname = usePathname();
  const [q, setQ] = useState('');
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const suggestions = suggestionsFor(pathname, app.hasModule);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [m.turns]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullScreen, onClose]);

  const submit = (text: string) => {
    if (!text.trim()) return;
    setView('chat');
    m.ask(text);
    setQ('');
  };
  const usage = m.info?.usage;
  return (
    <aside aria-label={t('panel', { name: ASSISTANT_NAME })} role={fullScreen ? 'dialog' : undefined} aria-modal={fullScreen || undefined} data-testid="marina-panel" className={cx('flex flex-col overflow-hidden bg-surface', fullScreen ? 'h-full' : 'h-full rounded-xl')}>
      <div className="flex flex-col gap-2 bg-[linear-gradient(135deg,#E6EEFC,#EEE7FB_55%,#E2F4F0)] p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2.5 text-base font-bold">
            <MarinaMark />
            <span className="truncate">{ASSISTANT_NAME}</span>
            {m.info?.mode === 'sandbox' && <span className="rounded-full bg-surface/80 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em] text-stone" title={t('sandboxHint')}>{t('sandbox')}</span>}
          </span>
          <span className="flex items-center gap-1">
            <button type="button" onClick={() => { m.reset(); setView('chat'); }} aria-label={t('newChat')} title={t('newChat')} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 hover:bg-surface"><Icon name="plus" size={15} /></button>
            <button type="button" onClick={() => setView((v) => (v === 'chat' ? 'history' : 'chat'))} aria-pressed={view === 'history'} aria-label={t('history.title')} title={t('history.title')} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 hover:bg-surface"><Icon name="clock" size={15} /></button>
            <Link href="/marina" aria-label={t('openHub')} title={t('openHub')} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 hover:bg-surface"><Icon name="arrow-up-right" size={15} /></Link>
            <button ref={closeRef} type="button" onClick={onClose} aria-label={t('close')} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface"><Icon name="x" size={15} /></button>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-graphite">
          <span className="inline-flex items-center gap-1 rounded-full bg-surface/70 px-2 py-0.5"><Icon name="lock" size={11} />{t('asYou')}</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-surface/70 px-2 py-0.5"><Icon name="check-circle" size={11} />{t('confirmFirst')}</span>
          {usage && (
            <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5', usage.state === 'ok' ? 'bg-surface/70' : 'bg-[#FFF1C9] text-[#6B4A00]')}>
              <Icon name="activity" size={11} />{t('credits', { used: Math.round(usage.credits), limit: usage.allowance })}
            </span>
          )}
        </div>
      </div>

      {view === 'history' ? (
        <div className="flex-1 overflow-y-auto"><History onPick={() => setView('chat')} /></div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4 text-sm" aria-live="polite">
          {m.turns.length === 0 && (
            <>
              <p className="text-stone">{t('intro', { name: ASSISTANT_NAME })}</p>
              <div className="flex flex-col gap-2" data-testid="marina-suggestions">
                {suggestions.map((k) => (
                  <button key={k} type="button" onClick={() => submit(t(`suggest.${k}`))} className="flex items-center gap-2 rounded-md border border-line-soft bg-surface px-3.5 py-2.5 text-left text-[13px] font-semibold hover:border-ink">
                    <Icon name="marina" size={13} />
                    {t(`suggest.${k}`)}
                  </button>
                ))}
              </div>
            </>
          )}
          {m.turns.map((turn) => (turn.role === 'user'
            ? <div key={turn.id} className="max-w-[88%] self-end whitespace-pre-line rounded-[20px_20px_6px_20px] bg-ink px-3.5 py-2.5 text-[13px] text-white">{turn.text}</div>
            : <AssistantTurn key={turn.id} turn={turn} />))}
          <div ref={endRef} />
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); submit(q); }} className="flex flex-col gap-1.5 border-t border-line-soft p-3">
        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="sr-only">{t('askLabel', { name: ASSISTANT_NAME })}</span>
            <textarea
              ref={inputRef}
              value={q}
              rows={1}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(q); } }}
              placeholder={t('askPlaceholder', { name: ASSISTANT_NAME })}
              className="max-h-40 min-h-11 w-full resize-none rounded-[22px] bg-canvas px-4 py-3 text-sm outline-none focus-visible:outline-3 focus-visible:outline-focus"
              data-testid="marina-input"
            />
          </label>
          {m.streaming ? (
            <button type="button" onClick={m.stop} aria-label={t('stop')} className="flex h-11 w-11 items-center justify-center rounded-full bg-canvas"><Icon name="x" size={16} /></button>
          ) : (
            <button type="submit" disabled={!q.trim()} aria-label={t('send')} className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-white disabled:opacity-40"><Icon name="send" size={16} /></button>
          )}
        </div>
        <p className="px-2 text-[10px] text-stone">{t('disclaimer', { name: ASSISTANT_NAME })}</p>
      </form>
    </aside>
  );
}

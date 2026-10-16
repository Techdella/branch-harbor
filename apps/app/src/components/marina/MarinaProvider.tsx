'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import type { MarinaStreamEvent } from '@bh/shared';
import { currentScreen, marina, streamChat, type AssistantInfo, type Turn } from '@/lib/marina';
import { ApiError } from '@/lib/errors';
import { useApp } from '../shell/AppContext';

interface MarinaCtx {
  turns: Turn[];
  conversationId: string | null;
  streaming: boolean;
  info: AssistantInfo | null;
  available: boolean;
  ask: (question: string) => void;
  stop: () => void;
  reset: () => void;
  load: (conversationId: string) => Promise<void>;
  refreshInfo: () => void;
}

const Ctx = createContext<MarinaCtx | null>(null);

let seq = 0;
const nextId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Conversation state shared by the side panel, the command bar and the home card. */
export function MarinaProvider({ children }: { children: ReactNode }) {
  const app = useApp();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [info, setInfo] = useState<AssistantInfo | null>(null);
  const abort = useRef<AbortController | null>(null);
  const convRef = useRef<string | null>(null);
  convRef.current = conversationId;
  const available = app.hasModule('ai.assistant');

  const refreshInfo = useCallback(() => {
    if (!available) return;
    marina.info().then(setInfo).catch(() => setInfo(null));
  }, [available]);
  useEffect(() => {
    refreshInfo();
    setTurns([]);
    setConversationId(null);
  }, [app.org.id, refreshInfo]);

  const patchLast = (fn: (t: Turn) => Turn) => setTurns((ts) => (ts.length ? [...ts.slice(0, -1), fn(ts[ts.length - 1]!)] : ts));

  const ask = useCallback((question: string) => {
    const q = question.trim();
    if (!q || streaming) return;
    app.setAiOpen(true);
    const assistant: Turn = { id: nextId(), role: 'assistant', text: '', blocks: [], citations: [], actions: [], tools: [], notices: [], pending: true };
    setTurns((ts) => [...ts, { id: nextId(), role: 'user', text: q, blocks: [], citations: [], actions: [], tools: [], notices: [] }, assistant]);
    setStreaming(true);
    const ac = new AbortController();
    abort.current = ac;
    const onEvent = (e: MarinaStreamEvent) => {
      switch (e.type) {
        case 'start': setConversationId(e.conversationId); break;
        case 'text': patchLast((t) => ({ ...t, text: t.text + e.delta })); break;
        case 'tool': patchLast((t) => ({ ...t, tools: [...t.tools.filter((x) => x.name !== e.name), { name: e.name, status: e.status }] })); break;
        case 'block': patchLast((t) => ({ ...t, blocks: [...t.blocks, e.block] })); break;
        case 'action': patchLast((t) => ({ ...t, actions: [...t.actions, e.action] })); break;
        case 'citations': patchLast((t) => ({ ...t, citations: [...t.citations, ...e.citations] })); break;
        case 'navigate':
          patchLast((t) => ({ ...t, navigate: { path: e.path, label: e.label } }));
          router.push(e.path);
          break;
        case 'notice': patchLast((t) => ({ ...t, notices: [...t.notices.filter((n) => n.code !== e.code), { code: e.code, message: e.message }] })); break;
        case 'done': patchLast((t) => ({ ...t, pending: false, text: e.text || t.text })); break;
        case 'error': patchLast((t) => ({ ...t, pending: false, error: { code: e.code, message: e.message } })); break;
      }
    };
    streamChat({ message: q, conversationId: convRef.current, screen: currentScreen(pathname), locale, signal: ac.signal }, onEvent)
      .catch((err: unknown) => patchLast((t) => ({ ...t, pending: false, error: err instanceof ApiError ? { code: err.code, message: err.message } : { code: 'unknown_error', message: String(err) } })))
      .finally(() => {
        setStreaming(false);
        patchLast((t) => ({ ...t, pending: false }));
        refreshInfo();
      });
  }, [app, locale, pathname, refreshInfo, router, streaming]);

  const stop = useCallback(() => abort.current?.abort(), []);
  const reset = useCallback(() => {
    abort.current?.abort();
    setTurns([]);
    setConversationId(null);
  }, []);
  const load = useCallback(async (id: string) => {
    abort.current?.abort();
    setTurns(await marina.conversation(id));
    setConversationId(id);
  }, []);

  const value = useMemo(() => ({ turns, conversationId, streaming, info, available, ask, stop, reset, load, refreshInfo }), [turns, conversationId, streaming, info, available, ask, stop, reset, load, refreshInfo]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMarina(): MarinaCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useMarina outside MarinaProvider');
  return c;
}

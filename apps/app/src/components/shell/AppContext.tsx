'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { can, type Permission } from '@bh/shared';
import type { IndustryKey, RequestContext, ScopeOptionT, Session, ViewRole } from '@/lib/types';
import { APP_INDUSTRIES, VIEW_ROLES } from '@/lib/types';
import { scopeOptions, sessionFor } from '@/lib/mock/orgs';
import { apiMode, getApi, onApiMode } from '@/lib/api';

interface AppState {
  industry: IndustryKey;
  role: ViewRole;
  scopeId: string;
  aiOpen: boolean;
  navCollapsed: boolean;
}

interface AppCtx extends AppState {
  ready: boolean;
  ctx: RequestContext;
  session: Session;
  scopes: ScopeOptionT[];
  scope: ScopeOptionT;
  apiMode: 'live' | 'mock' | 'fallback';
  can: (p: Permission) => boolean;
  setIndustry: (i: IndustryKey) => void;
  setRole: (r: ViewRole) => void;
  setScopeId: (id: string) => void;
  setAiOpen: (open: boolean) => void;
  toggleNav: () => void;
}

const KEY = 'bh_app_state';
const DEFAULTS: AppState = { industry: 'studios', role: 'hq', scopeId: 'all', aiOpen: false, navCollapsed: false };

const Ctx = createContext<AppCtx | null>(null);

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<AppState>;
    return {
      industry: APP_INDUSTRIES.includes(v.industry as IndustryKey) ? (v.industry as IndustryKey) : DEFAULTS.industry,
      role: VIEW_ROLES.includes(v.role as ViewRole) ? (v.role as ViewRole) : DEFAULTS.role,
      scopeId: typeof v.scopeId === 'string' ? v.scopeId : 'all',
      aiOpen: !!v.aiOpen,
      navCollapsed: !!v.navCollapsed,
    };
  } catch {
    return DEFAULTS;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(DEFAULTS);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState(apiMode());

  useEffect(() => {
    setState(load());
    setReady(true);
    getApi().then(() => setMode(apiMode()));
    const off = onApiMode(setMode);
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, ready]);

  // Session and scopes are derived from the persona. With a live API these come from /v1/auth/session and /v1/scopes.
  const session = useMemo(() => sessionFor(state.industry, state.role), [state.industry, state.role]);
  const scopes = useMemo(() => scopeOptions(state.industry, state.role), [state.industry, state.role]);
  const scope = scopes.find((s) => s.id === state.scopeId) ?? scopes[0]!;

  const setIndustry = useCallback((industry: IndustryKey) => setState((s) => ({ ...s, industry, scopeId: 'all' })), []);
  const setRole = useCallback((role: ViewRole) => setState((s) => ({ ...s, role, scopeId: 'all' })), []);
  const setScopeId = useCallback((scopeId: string) => setState((s) => ({ ...s, scopeId })), []);
  const setAiOpen = useCallback((aiOpen: boolean) => setState((s) => ({ ...s, aiOpen })), []);
  const toggleNav = useCallback(() => setState((s) => ({ ...s, navCollapsed: !s.navCollapsed })), []);

  const value = useMemo<AppCtx>(
    () => ({
      ...state,
      scopeId: scope.id,
      ready,
      ctx: { industry: state.industry, role: state.role, scopeId: scope.id },
      session,
      scopes,
      scope,
      apiMode: mode,
      can: (p) => can(session.assignments, p),
      setIndustry,
      setRole,
      setScopeId,
      setAiOpen,
      toggleNav,
    }),
    [state, ready, session, scopes, scope, mode, setIndustry, setRole, setScopeId, setAiOpen, toggleNav],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}

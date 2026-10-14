'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { can, type Permission } from '@bh/shared';
import type { IndustryKey, Location, Organization, RequestContext, ScopeOptionT, Session, ViewRole } from '@/lib/types';
import { APP_INDUSTRIES, VIEW_ROLES } from '@/lib/types';
import { FIXTURES, scopeOptions, sessionFor } from '@/lib/mock/orgs';
import { INDEPENDENT, independentSession } from '@/lib/mock/independent';
import { apiMode, enterFallback, onApiMode } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import {
  availableRoles,
  effectiveRole,
  industriesAvailable,
  loadWorkspace,
  onWorkspace,
  refreshWorkspace,
  scopeOptionsOf,
  sessionOf,
  setActiveRole,
  workspace,
  type Workspace,
} from '@/lib/http/workspace';

interface AppState {
  industry: IndustryKey;
  role: ViewRole;
  scopeId: string;
  aiOpen: boolean;
  navCollapsed: boolean;
  /** Live mode: the selected organisation. */
  orgId: string | null;
  /** Sample mode only: show the network demo or the independent-business demo ("Viewing as" switcher). */
  business: 'network' | 'independent';
}

interface AppCtx extends Omit<AppState, 'orgId' | 'business'> {
  ready: boolean;
  ctx: RequestContext;
  session: Session;
  scopes: ScopeOptionT[];
  scope: ScopeOptionT;
  apiMode: 'live' | 'mock' | 'fallback';
  /** True when data comes from the API (not mock or offline fallback). */
  live: boolean;
  org: Organization;
  /** Location directory for the selected organisation (live) or the sample industry (mock). */
  locations: Location[];
  /** Industries the switcher offers: all five in sample mode; the user's organisations' industries when live. */
  industries: IndustryKey[];
  /** "Viewing as" options: all personas in sample mode; only the roles the user holds when live. */
  roles: ViewRole[];
  can: (p: Permission) => boolean;
  setIndustry: (i: IndustryKey) => void;
  setRole: (r: ViewRole) => void;
  /** Sample mode: switch between the network demo and the independent-business demo. */
  sampleBusiness: 'network' | 'independent';
  setSampleBusiness: (b: 'network' | 'independent') => void;
  setScopeId: (id: string) => void;
  setAiOpen: (open: boolean) => void;
  toggleNav: () => void;
  reloadWorkspace: () => Promise<void>;
}

const KEY = 'bh_app_state';
const DEFAULTS: AppState = { industry: 'studios', role: 'hq', scopeId: 'all', aiOpen: false, navCollapsed: false, orgId: null, business: 'network' };

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
      orgId: typeof v.orgId === 'string' ? v.orgId : null,
      business: v.business === 'independent' ? 'independent' : 'network',
    };
  } catch {
    return DEFAULTS;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [state, setState] = useState<AppState>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState(apiMode());
  const [ws, setWs] = useState<Workspace | null>(workspace());

  useEffect(() => {
    const initial = load();
    setState(initial);
    const off = onApiMode(setMode);
    const offWs = onWorkspace(setWs);
    if (apiMode() !== 'live') {
      setLoaded(true);
    } else {
      (async () => {
        try {
          const w = workspace() ?? (await loadWorkspace(initial.orgId));
          if (!w.org) {
            // Signed in but no organisation yet: finish onboarding first.
            router.replace('/onboarding');
            return;
          }
          setState((s) => ({ ...s, orgId: w.org!.id, industry: w.orgView!.industry }));
          setLoaded(true);
        } catch (e) {
          if (e instanceof ApiError && e.isNetwork) {
            enterFallback();
            setLoaded(true);
          } else if (e instanceof ApiError && e.isUnauthenticated) {
            router.replace(`/sign-in?next=${encodeURIComponent(path)}`);
          } else {
            // Unexpected error: show the app so screens can surface their own error states.
            setLoaded(true);
          }
        }
      })();
    }
    return () => {
      off();
      offWs();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, loaded]);

  const live = mode === 'live' && !!ws?.org;

  // Session, scopes and the directory come from /v1/auth/me + the org directory when live; from fixtures otherwise.
  const derived = useMemo(() => {
    if (live && ws) {
      const role = effectiveRole(state.role, ws);
      setActiveRole(role); // synchronously, so child screens' first requests use the right persona
      const scopes = scopeOptionsOf(role, ws);
      return {
        industry: ws.orgView!.industry,
        role,
        session: sessionOf(role, ws),
        // Independent businesses have no scope selector: the business itself is the only scope.
        scopes: ws.orgView!.model === 'independent' ? [{ ...scopes[0]!, label: ws.orgView!.name }] : scopes,
        org: ws.orgView!,
        locations: ws.locations,
        industries: industriesAvailable(ws),
        roles: availableRoles(ws),
      };
    }
    if (state.business === 'independent') {
      // Sample independent business: one location, the owner's view, the business as the only scope.
      const f = INDEPENDENT[state.industry];
      return {
        industry: state.industry,
        role: 'hq' as ViewRole,
        session: independentSession(state.industry),
        scopes: [{ id: `loc:${f.location.id}`, kind: 'location' as const, label: f.org.name, locationIds: [f.location.id] }],
        org: f.org,
        locations: [f.location] as Location[],
        industries: [...APP_INDUSTRIES],
        roles: ['hq'] as ViewRole[],
      };
    }
    return {
      industry: state.industry,
      role: state.role,
      session: sessionFor(state.industry, state.role),
      scopes: scopeOptions(state.industry, state.role),
      org: FIXTURES[state.industry].org,
      locations: FIXTURES[state.industry].locations as Location[],
      industries: [...APP_INDUSTRIES],
      roles: [...VIEW_ROLES],
    };
  }, [live, ws, state.industry, state.role, state.business]);
  const scope = derived.scopes.find((s) => s.id === state.scopeId) ?? derived.scopes[0] ?? { id: 'all', kind: 'all' as const, label: 'All authorised locations', locationIds: [] };

  const setIndustry = useCallback(
    (industry: IndustryKey) => {
      const w = workspace();
      if (apiMode() === 'live' && w) {
        const target = w.orgs.find((o) => o.industry === industry);
        if (!target || target.id === w.org?.id) return;
        void loadWorkspace(target.id).then(() => setState((s) => ({ ...s, industry, orgId: target.id, scopeId: 'all' })));
        return;
      }
      setState((s) => ({ ...s, industry, scopeId: 'all' }));
    },
    [],
  );
  const setRole = useCallback((role: ViewRole) => setState((s) => ({ ...s, role, scopeId: 'all' })), []);
  const setSampleBusiness = useCallback((business: 'network' | 'independent') => setState((s) => ({ ...s, business, role: business === 'independent' ? 'hq' : s.role, scopeId: 'all' })), []);
  const setScopeId = useCallback((scopeId: string) => setState((s) => ({ ...s, scopeId })), []);
  const setAiOpen = useCallback((aiOpen: boolean) => setState((s) => ({ ...s, aiOpen })), []);
  const toggleNav = useCallback(() => setState((s) => ({ ...s, navCollapsed: !s.navCollapsed })), []);
  const reloadWorkspace = useCallback(async () => {
    if (apiMode() === 'live') await refreshWorkspace();
  }, []);

  const value = useMemo<AppCtx>(
    () => ({
      industry: derived.industry,
      role: derived.role,
      aiOpen: state.aiOpen,
      navCollapsed: state.navCollapsed,
      scopeId: scope.id,
      ready: loaded,
      ctx: { industry: derived.industry, role: derived.role, scopeId: scope.id, business: derived.org.model === 'independent' ? 'independent' : 'network' },
      session: derived.session,
      scopes: derived.scopes,
      scope,
      apiMode: mode,
      live,
      org: derived.org,
      locations: derived.locations,
      industries: derived.industries,
      roles: derived.roles,
      can: (p) => can(derived.session.assignments, p),
      setIndustry,
      setRole,
      sampleBusiness: live ? 'network' : state.business,
      setSampleBusiness,
      setScopeId,
      setAiOpen,
      toggleNav,
      reloadWorkspace,
    }),
    [derived, state.aiOpen, state.navCollapsed, state.business, scope, loaded, mode, live, setIndustry, setRole, setSampleBusiness, setScopeId, setAiOpen, toggleNav, reloadWorkspace],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}

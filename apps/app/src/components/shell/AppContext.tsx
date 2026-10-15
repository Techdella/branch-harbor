'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Permission, WorkspaceKey } from '@bh/shared';
import type { IndustryKey, Location, Organization, RequestContext, ScopeOptionT, Session, ViewRole } from '@/lib/types';
import { ApiError } from '@/lib/errors';
import { permissionsOf, visibleWorkspaces, workspaceOfRoute } from '@/lib/access';
import {
  asIndustryKey,
  effectiveRole,
  loadWorkspace,
  onWorkspace,
  orgAccess,
  refreshWorkspace,
  scopeOptionsOf,
  sessionOf,
  setActiveRole,
  workspace,
  type Workspace,
} from '@/lib/http/workspace';

/** A business account the signed-in person belongs to (one industry each). */
export interface Account {
  id: string;
  name: string;
  industry: IndustryKey;
  model: 'independent' | 'network';
}

interface AppState {
  /** The selected business account. */
  orgId: string | null;
  /** The selected workspace (null = the person's landing workspace). */
  workspace: WorkspaceKey | null;
  scopeId: string;
  aiOpen: boolean;
  navCollapsed: boolean;
}

type LoadState = 'loading' | 'ready' | 'offline' | 'error';

interface AppCtx {
  /** True once the workspace (user, account, access, directory) is loaded from the API. */
  ready: boolean;
  /** Why the app isn't ready: still loading, the API is unreachable, or another error. */
  loadState: LoadState;
  retry: () => void;
  industry: IndustryKey;
  /** Broad persona from the widest assignment (read-only). */
  role: ViewRole;
  scopeId: string;
  aiOpen: boolean;
  navCollapsed: boolean;
  ctx: RequestContext;
  session: Session;
  scopes: ScopeOptionT[];
  scope: ScopeOptionT;
  /** Always true: the app only works against the API. Kept for screens that branch on it. */
  live: true;
  org: Organization;
  locations: Location[];
  /** Business accounts under this login (account switcher; hidden when there is one). */
  accounts: Account[];
  switchAccount: (orgId: string) => void;
  /** Capabilities (`<module>:<action>`) held anywhere in the selected account. */
  capabilities: ReadonlySet<string>;
  /** Workspaces with at least one screen for this person, in order; the switcher is hidden when there is one. */
  workspaces: WorkspaceKey[];
  /** The workspace whose home and navigation are shown. */
  workspace: WorkspaceKey | null;
  primaryWorkspace: WorkspaceKey | null;
  setWorkspace: (w: WorkspaceKey) => void;
  hasModule: (module: string) => boolean;
  can: (p: Permission) => boolean;
  setScopeId: (id: string) => void;
  setAiOpen: (open: boolean) => void;
  toggleNav: () => void;
  reloadWorkspace: () => Promise<void>;
}

const KEY = 'bh_app_state';
const DEFAULTS: AppState = { orgId: null, workspace: null, scopeId: 'all', aiOpen: false, navCollapsed: false };

const Ctx = createContext<AppCtx | null>(null);

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<AppState>;
    return {
      orgId: typeof v.orgId === 'string' ? v.orgId : null,
      workspace: typeof v.workspace === 'string' ? (v.workspace as WorkspaceKey) : null,
      scopeId: typeof v.scopeId === 'string' ? v.scopeId : 'all',
      aiOpen: !!v.aiOpen,
      navCollapsed: !!v.navCollapsed,
    };
  } catch {
    return DEFAULTS;
  }
}

const EMPTY_ORG: Organization = { id: '', name: '', brand: '', industry: 'studios', sample: false, defaultCurrency: 'USD', defaultTimeZone: 'UTC', defaultLocale: 'en', dataRegion: 'us', regions: [], ownerGroups: [], model: 'network' };
const EMPTY_SESSION: Session = { user: { id: '', name: '', email: '', initials: '' }, role: 'staff', assignments: [], locationIds: [] };
const ALL_SCOPE: ScopeOptionT = { id: 'all', kind: 'all', label: 'All authorised locations', locationIds: [] };

export function AppProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [state, setState] = useState<AppState>(DEFAULTS);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [ws, setWs] = useState<Workspace | null>(workspace());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const initial = load();
    setState(initial);
    const offWs = onWorkspace(setWs);
    (async () => {
      setLoadState('loading');
      try {
        const cached = workspace();
        const w = cached?.org ? cached : await loadWorkspace(initial.orgId);
        if (!w.org) {
          // Signed in but no business account yet: set one up first (a fresh account starts empty).
          router.replace('/onboarding');
          return;
        }
        setState((s) => ({ ...s, orgId: w.org!.id }));
        setLoadState('ready');
      } catch (e) {
        if (e instanceof ApiError && e.isUnauthenticated) router.replace(`/sign-in?next=${encodeURIComponent(path)}`);
        else setLoadState(e instanceof ApiError && e.isNetwork ? 'offline' : 'error');
      }
    })();
    return () => {
      offWs();
    };
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (loadState !== 'ready') return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, loadState]);

  const derived = useMemo(() => {
    if (!ws?.org || !ws.orgView) return null;
    const industry = asIndustryKey(ws.org.industry);
    const role = effectiveRole(undefined, ws);
    setActiveRole(role); // synchronously, so child screens' first requests use the right scope
    const scopes = scopeOptionsOf(role, ws);
    const access = orgAccess(ws);
    const capabilities = new Set<string>(access.capabilities);
    const workspaces = visibleWorkspaces(capabilities, industry);
    return {
      industry,
      role,
      session: sessionOf(role, ws),
      // Independent businesses have no scope selector: the business itself is the only scope.
      scopes: ws.orgView.model === 'independent' ? [{ ...scopes[0]!, label: ws.orgView.name }] : scopes,
      org: ws.orgView,
      locations: ws.locations,
      capabilities,
      permissions: permissionsOf(capabilities),
      workspaces,
      primaryWorkspace: access.primaryWorkspace && workspaces.includes(access.primaryWorkspace) ? access.primaryWorkspace : (workspaces[0] ?? null),
      accounts: ws.orgs.map((o) => ({ id: o.id, name: o.name, industry: asIndustryKey(o.industry), model: o.model === 'independent' ? ('independent' as const) : ('network' as const) })),
    };
  }, [ws]);

  const activeWorkspace = derived ? (state.workspace && derived.workspaces.includes(state.workspace) ? state.workspace : derived.primaryWorkspace) : null;

  // Following a link into another workspace (search, notifications) switches the navigation to it.
  useEffect(() => {
    if (!derived) return;
    const w = workspaceOfRoute(path, derived.industry);
    if (w && w !== activeWorkspace && derived.workspaces.includes(w)) setState((s) => ({ ...s, workspace: w }));
  }, [path, derived]); // eslint-disable-line react-hooks/exhaustive-deps

  const scopes = derived?.scopes ?? [ALL_SCOPE];
  const scope = scopes.find((s) => s.id === state.scopeId) ?? scopes[0] ?? ALL_SCOPE;

  const switchAccount = useCallback(
    (orgId: string) => {
      if (orgId === workspace()?.org?.id) return;
      setLoadState('loading');
      void loadWorkspace(orgId)
        .then(() => {
          setState((s) => ({ ...s, orgId, workspace: null, scopeId: 'all' }));
          setLoadState('ready');
          router.push('/overview');
        })
        .catch((e) => setLoadState(e instanceof ApiError && e.isNetwork ? 'offline' : 'error'));
    },
    [router],
  );
  const setWorkspace = useCallback(
    (w: WorkspaceKey) => {
      setState((s) => ({ ...s, workspace: w }));
      router.push('/overview');
    },
    [router],
  );
  const setScopeId = useCallback((scopeId: string) => setState((s) => ({ ...s, scopeId })), []);
  const setAiOpen = useCallback((aiOpen: boolean) => setState((s) => ({ ...s, aiOpen })), []);
  const toggleNav = useCallback(() => setState((s) => ({ ...s, navCollapsed: !s.navCollapsed })), []);
  const reloadWorkspace = useCallback(async () => {
    await refreshWorkspace();
  }, []);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  const value = useMemo<AppCtx>(() => {
    const industry = derived?.industry ?? 'studios';
    const role = derived?.role ?? 'staff';
    const org = derived?.org ?? EMPTY_ORG;
    return {
      ready: loadState === 'ready' && !!derived,
      loadState,
      retry,
      industry,
      role,
      scopeId: scope.id,
      aiOpen: state.aiOpen,
      navCollapsed: state.navCollapsed,
      ctx: { industry, role, scopeId: scope.id, business: org.model === 'independent' ? 'independent' : 'network' },
      session: derived?.session ?? EMPTY_SESSION,
      scopes,
      scope,
      live: true,
      org,
      locations: derived?.locations ?? [],
      accounts: derived?.accounts ?? [],
      switchAccount,
      capabilities: derived?.capabilities ?? new Set<string>(),
      workspaces: derived?.workspaces ?? [],
      workspace: activeWorkspace,
      primaryWorkspace: derived?.primaryWorkspace ?? null,
      setWorkspace,
      hasModule: (m) => !!derived?.capabilities.has(`${m}:view`),
      can: (p) => !!derived?.permissions.has(p),
      setScopeId,
      setAiOpen,
      toggleNav,
      reloadWorkspace,
    };
  }, [derived, loadState, retry, scope, scopes, state.aiOpen, state.navCollapsed, activeWorkspace, switchAccount, setWorkspace, setScopeId, setAiOpen, toggleNav, reloadWorkspace]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}

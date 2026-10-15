'use client';

/**
 * Access model client: role templates, custom roles and "What can this person see?" (per-assignment role +
 * overrides). Every change is checked and audited by the API; nobody can grant what they don't hold.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccessSummary, ScopeKind, WorkspaceKey } from '@bh/shared';
import { ApiError } from '../errors';
import { useLocalizeErrorRef } from '../useErrorText';
import { http } from './client';
import { orgId } from './workspace';

export interface RoleTemplateVM {
  key: string;
  name: string;
  /** The business's own name for the role (renamed), if any. */
  label: string | null;
  team: string;
  support: boolean;
  sensitive: string[];
  description: string;
  primaryWorkspace: WorkspaceKey;
  defaultScope: ScopeKind;
  networkOnly: boolean;
  capabilities: string[];
  workspaces: WorkspaceKey[];
}
export interface CustomRoleVM {
  id: string;
  name: string;
  description: string | null;
  baseRole: string | null;
  primaryWorkspace: WorkspaceKey | null;
  capabilities: string[];
  assignedCount: number;
}
export interface RolesVM {
  industry: string;
  templates: RoleTemplateVM[];
  custom: CustomRoleVM[];
  teams: string[];
  scopeKinds: ScopeKind[];
}
export interface AssignmentAccessVM {
  id: string;
  role: string;
  roleName: string;
  customRoleId: string | null;
  scope: { kind: ScopeKind; id: string; name: string | null };
  /** Location names the scope reaches ('all' for the whole business). */
  locations: 'all' | string[];
  grants: string[];
  revokes: string[];
  capabilities: string[];
  editable: boolean;
}
export interface MemberAccessVM {
  user: { id: string; name: string; email: string };
  industry: string;
  jobTitle: string | null;
  deniedClasses: string[];
  assignments: AssignmentAccessVM[];
  summary: AccessSummary;
}
export interface MyAccessVM extends AccessSummary {
  industry: string;
  jobTitle: string | null;
  roleLabels: Record<string, string>;
  assignments: { id: string; role: string; customRoleId: string | null; scope: { kind: ScopeKind; id: string }; capabilities: string[] }[];
}
export interface RoleInput {
  name: string;
  description?: string;
  baseRole?: string;
  primaryWorkspace?: WorkspaceKey;
  capabilities: string[];
}

export interface PreviewVM {
  capabilities: string[];
  locations: { all: boolean; names: string[] };
  workspaces: { key: WorkspaceKey; modules: string[] }[];
  settings: string[];
  actions: Record<string, string[]>;
  hidden: string[];
  sensitive: string[];
}
export interface CoverageVM {
  items: { key: string; capability: string; suggestedRole: string; covered: boolean; holders: { id: string; name: string }[] }[];
  uncovered: string[];
}
export interface TeamShapeVM {
  shape: string | null;
  shapes: { key: string; templates: string[]; combined: string[] }[];
  combined: { key: string; name: string; description: string; from: string[]; roleId: string | null; roleName: string | null }[];
}
export interface ScopesVM {
  brands: { id: string; name: string; isDefault: boolean }[];
  territories: { id: string; name: string; kind: string; country: string | null; brandId: string | null; locationIds: string[] }[];
  regions: { id: string; name: string }[];
  portfolios: { id: string; name: string; description: string | null; locationIds: string[] }[];
  ownerGroups: { id: string; name: string }[];
  locations: { id: string; name: string; regionId: string | null; ownerGroupId: string | null; territoryId: string | null }[];
}
export interface PreviewInput {
  role: string;
  customRoleId?: string | null;
  scopeKind: ScopeKind;
  scopeId?: string;
  capabilities?: string[];
  deniedClasses?: string[];
}

const o = (p: string) => `/orgs/${orgId()}${p}`;

export const accessApi = {
  roles: () => http.get<RolesVM>(o('/roles')),
  createRole: (body: RoleInput) => http.post<CustomRoleVM>(o('/roles'), body),
  updateRole: (id: string, body: Partial<RoleInput>) => http.patch<CustomRoleVM>(o(`/roles/${id}`), body),
  deleteRole: (id: string) => http.del<{ deleted: true }>(o(`/roles/${id}`)),
  me: () => http.get<MyAccessVM>(o('/access/me')),
  member: (userId: string) => http.get<MemberAccessVM>(o(`/members/${userId}/access`)),
  setAssignment: (id: string, body: { role: string; customRoleId: string | null; grants: string[]; revokes: string[] }) =>
    http.put<{ capabilities: string[]; changes: { added: string[]; removed: string[] } }>(o(`/role-assignments/${id}/access`), body),
  addAssignment: (body: { userId: string; role: string; customRoleId?: string; scope: { kind: ScopeKind; id: string }; grants: string[]; revokes: string[] }) =>
    http.post<{ id: string }>(o('/role-assignments'), body),
  removeAssignment: (id: string) => http.del<{ revoked: true }>(o(`/role-assignments/${id}`)),
  preview: (body: PreviewInput) => http.post<PreviewVM>(o('/access/preview'), { grants: [], revokes: [], ...body }),
  setProfile: (userId: string, body: { jobTitle?: string | null; deniedClasses?: string[] }) => http.put<{ jobTitle: string | null; deniedClasses: string[] }>(o(`/members/${userId}/profile`), body),
  renameRole: (role: string, name: string | null) => http.put<{ role: string; label: string | null }>(o(`/access/role-labels/${role}`), { name }),
  coverage: () => http.get<CoverageVM>(o('/access/coverage')),
  assignArea: (area: string, userId: string) => http.post<CoverageVM>(o(`/access/coverage/${area}/assign`), { userId }),
  teamShape: () => http.get<TeamShapeVM>(o('/access/team-shape')),
  setTeamShape: (shape: string, names?: Record<string, string>, descriptions?: Record<string, string>) => http.put<TeamShapeVM>(o('/access/team-shape'), { shape, names, descriptions }),
  scopes: () => http.get<ScopesVM>(o('/access/scopes')),
  createPortfolio: (body: { name: string; description?: string | null; locationIds: string[] }) => http.post<{ id: string }>(o('/access/portfolios'), body),
  updatePortfolio: (id: string, body: { name?: string; locationIds?: string[] }) => http.patch<{ id: string }>(o(`/access/portfolios/${id}`), body),
  createTerritory: (body: { name: string; kind: string; country?: string | null; locationIds: string[] }) => http.post<{ id: string }>(o('/access/territories'), body),
  updateTerritory: (id: string, body: { name?: string; locationIds?: string[] }) => http.patch<{ id: string }>(o(`/access/territories/${id}`), body),
};

type Res<T> = { status: 'loading'; data?: T; error?: undefined } | { status: 'ready'; data: T; error?: undefined } | { status: 'error'; data?: T; error: ApiError };
const toErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.'));

/** Loads access data (loading / ready / error, reload). */
export function useAccess<T>(fn: () => Promise<T>, deps: unknown[], enabled = true) {
  const [res, setRes] = useState<Res<T>>({ status: 'loading' });
  const localize = useLocalizeErrorRef();
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    fnRef.current().then(
      (data) => id === seq.current && setRes({ status: 'ready', data }),
      (e) => id === seq.current && setRes({ status: 'error', error: localize.current(toErr(e)) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    if (enabled) load();
  }, [load, enabled]);
  return { ...res, reload: useCallback(() => load(true), [load]) };
}

/** Runs an access mutation, tracking pending + a localized error. */
export function useAccessAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const localize = useLocalizeErrorRef();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fnRef.current(...args);
    } catch (e) {
      setError(localize.current(toErr(e)));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { run, pending, error, clearError: () => setError(null) };
}

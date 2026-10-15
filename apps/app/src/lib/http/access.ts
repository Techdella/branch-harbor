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
}
export interface AssignmentAccessVM {
  id: string;
  role: string;
  roleName: string;
  customRoleId: string | null;
  scope: { kind: ScopeKind; id: string; name: string | null };
  grants: string[];
  revokes: string[];
  capabilities: string[];
  editable: boolean;
}
export interface MemberAccessVM {
  user: { id: string; name: string; email: string };
  industry: string;
  assignments: AssignmentAccessVM[];
  summary: AccessSummary;
}
export interface MyAccessVM extends AccessSummary {
  industry: string;
  assignments: { id: string; role: string; customRoleId: string | null; scope: { kind: ScopeKind; id: string }; capabilities: string[] }[];
}
export interface RoleInput {
  name: string;
  description?: string;
  baseRole?: string;
  primaryWorkspace?: WorkspaceKey;
  capabilities: string[];
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

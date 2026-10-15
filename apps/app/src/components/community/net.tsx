'use client';

/**
 * Shared plumbing for the network workspaces (Community, Training, Help desk).
 * Each screen asks the API what the signed-in person may do (`/community/me`), so nothing depends on the
 * dashboard's role switcher.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, cx } from '@bh/ui';
import { API_URL, getAccessToken, http } from '@/lib/http/client';
import { ApiError } from '@/lib/errors';
import { useLocalizeError } from '@/lib/useErrorText';
import { useApp } from '../shell/AppContext';

export interface Audience { everyone?: boolean; regionIds?: string[]; ownerGroupIds?: string[]; locationIds?: string[]; roles?: string[]; hqOnly?: boolean; userIds?: string[] }
export interface Directory { regions: { id: string; name: string }[]; ownerGroups: { id: string; name: string }[]; locations: { id: string; name: string; regionId: string | null; ownerGroupId: string | null }[] }
export interface AccountManager { id: string; userId: string; name: string; email: string; title: string | null; bookingUrl: string | null; bio: string | null; phone: string | null }
export interface NetMe {
  userId: string; hq: boolean; roles: string[]; permissions: string[]; orgPermissions: string[];
  scope: { regionIds: string[]; ownerGroupIds: string[]; locationIds: string[] };
  accountManagers: AccountManager[];
  counters: { unreadNotifications: number; requiredReadsPending: number; openTickets: number };
  directory: Directory | null;
}

/** The organisation the dashboard is showing. */
export function useOrgId(): string | null {
  const app = useApp();
  return app.org.id || null;
}

function toApiError(e: unknown) {
  return e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.');
}

/** GET a path under /orgs/:orgId (null path = don't load). */
export function useNet<T>(path: string | null, deps: unknown[] = []) {
  const orgId = useOrgId();
  const localize = useLocalizeError();
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(async (keep = false) => {
    if (!orgId || !path) { setLoading(false); return; }
    const id = ++seq.current;
    if (!keep) setData(undefined);
    setLoading(true);
    try {
      const d = await http.get<T>(`/orgs/${orgId}${path}`);
      if (id === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (id === seq.current) setError(localize(toApiError(e)));
    } finally {
      if (id === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, path, ...deps]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: () => load(true), setData };
}

/** Mutations under /orgs/:orgId with pending + localized error. */
export function useNetAction() {
  const orgId = useOrgId();
  const localize = useLocalizeError();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async <R,>(method: 'post' | 'patch' | 'put' | 'del', path: string, body?: unknown): Promise<R | undefined> => {
    if (!orgId) return undefined;
    setPending(true);
    setError(null);
    try {
      const url = `/orgs/${orgId}${path}`;
      return method === 'del' ? await http.del<R>(url) : await http[method]<R>(url, body ?? {});
    } catch (e) {
      setError(localize(toApiError(e)));
      return undefined;
    } finally {
      setPending(false);
    }
  }, [orgId, localize]);
  return { run, pending, error, clear: () => setError(null) };
}

export function useNetMe() {
  return useNet<NetMe>('/community/me');
}
export const canDo = (me: NetMe | undefined, p: string, orgWide = false) => !!me && (orgWide ? me.orgPermissions : me.permissions).includes(p);

/**
 * Real-time-ish updates: polls `/community/updates` with If-None-Match every 30 s and calls `onChange` when the
 * server says something changed (304 otherwise, so polling is cheap).
 */
export function useNetUpdates(onChange: () => void, everyMs = 30_000) {
  const orgId = useOrgId();
  const etag = useRef<string | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!orgId) return;
    let stop = false;
    const tick = async () => {
      try {
        const token = getAccessToken();
        const res = await fetch(`${API_URL}/v1/orgs/${orgId}/community/updates`, { headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(etag.current ? { 'If-None-Match': etag.current } : {}) }, credentials: 'include' });
        if (res.status === 200) {
          const first = etag.current === null;
          etag.current = res.headers.get('etag');
          if (!first) cb.current();
        }
      } catch { /* offline: try again next tick */ }
    };
    void tick();
    const id = setInterval(() => { if (!stop && document.visibilityState === 'visible') void tick(); }, everyMs);
    return () => { stop = true; clearInterval(id); };
  }, [orgId, everyMs]);
}

export function ErrorNote({ error }: { error: ApiError | null | undefined }) {
  if (!error) return null;
  return <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-[13px] font-semibold text-danger">{error.message}</p>;
}

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('flex flex-col gap-3 rounded-xl bg-surface p-4 md:p-5', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-bold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Pill({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={cx('inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] px-3.5 text-[13px] font-semibold', active ? 'border-ink bg-ink text-white' : 'border-line-soft bg-surface hover:border-ink')}>
      {children}
      {count ? <span className={cx('rounded-full px-1.5 text-[11px] font-extrabold', active ? 'bg-white text-ink' : 'bg-lime text-ink')}>{count}</span> : null}
    </button>
  );
}

export function PersonBadge({ badge }: { badge: string }) {
  const t = useTranslations('net.badge');
  const tone = badge === 'hq' ? 'info' : badge === 'account_manager' ? 'success' : badge === 'franchisee' ? 'warning' : 'neutral';
  return <Badge tone={tone as 'info'}>{t(badge as 'hq')}</Badge>;
}

const ROLE_KEYS = ['franchise_owner', 'multi_unit_operator', 'master_franchisee', 'area_developer', 'location_manager', 'staff', 'field_consultant', 'trainer', 'hq_admin', 'content_social', 'finance_lead'] as const;

/** Who should see / get this: the whole network, or some regions, owner groups, locations and roles. */
export function AudiencePicker({ value, onChange, directory, allowEveryone = true }: { value: Audience; onChange: (a: Audience) => void; directory: Directory | null; allowEveryone?: boolean }) {
  const t = useTranslations('net.audience');
  const tr = useTranslations('net.roles');
  const everyone = !value.regionIds?.length && !value.ownerGroupIds?.length && !value.locationIds?.length && !value.roles?.length && !value.hqOnly;
  const toggle = (k: 'regionIds' | 'ownerGroupIds' | 'locationIds' | 'roles', id: string) => {
    const cur = new Set(value[k] ?? []);
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    onChange({ ...value, [k]: [...cur] });
  };
  const group = (label: string, k: 'regionIds' | 'ownerGroupIds' | 'locationIds' | 'roles', items: { id: string; name: string }[]) => items.length ? (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-bold text-stone">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {items.map((i) => <Pill key={i.id} active={(value[k] ?? []).includes(i.id)} onClick={() => toggle(k, i.id)}>{i.name}</Pill>)}
      </div>
    </fieldset>
  ) : null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border-[1.5px] border-line-soft p-3.5" role="group" aria-label={t('label')}>
      <p className="text-[13px] font-bold">{everyone && allowEveryone ? t('everyone') : t('selected')}</p>
      {group(t('regions'), 'regionIds', directory?.regions ?? [])}
      {group(t('ownerGroups'), 'ownerGroupIds', directory?.ownerGroups ?? [])}
      {group(t('locations'), 'locationIds', directory?.locations ?? [])}
      {group(t('roles'), 'roles', ROLE_KEYS.map((r) => ({ id: r, name: tr(r) })))}
      {!everyone && <Button size="sm" variant="ghost" icon="x" onClick={() => onChange({})}>{t('clear')}</Button>}
    </div>
  );
}

/** Plain-language audience summary ("Everyone", "North America · Franchise owners"). */
export function useAudienceText(directory: Directory | null | undefined) {
  const t = useTranslations('net.audience');
  const tr = useTranslations('net.roles');
  return (a: Audience) => {
    if (a.hqOnly) return t('hqOnly');
    const parts = [
      ...(a.regionIds ?? []).map((id) => directory?.regions.find((r) => r.id === id)?.name ?? t('oneRegion')),
      ...(a.ownerGroupIds ?? []).map((id) => directory?.ownerGroups.find((r) => r.id === id)?.name ?? t('oneOwnerGroup')),
      ...(a.locationIds ?? []).map((id) => directory?.locations.find((r) => r.id === id)?.name ?? t('oneLocation')),
      ...(a.roles ?? []).map((r) => (tr.has(r as never) ? tr(r as never) : r)),
    ];
    if (a.userIds?.length) parts.push(t('people', { count: a.userIds.length }));
    return parts.length ? parts.join(' · ') : t('everyone');
  };
}
